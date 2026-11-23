import { createHash, randomUUID } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { openConversationDatabase } from '../../services/conversation/persistence/database'
import { ThreadMessageIntake } from '../../services/conversation/orchestration/ThreadMessageIntake'
import { ConversationEventSink } from '../../services/conversation/orchestration/EventSink'
import {
  conversationDriverRegistry, ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError,
  type ConversationDriverModel, type ConversationDriverRegistration, type ConversationDriverRegistry, type ConversationDriverSession,
} from '../../services/conversation/providers/registry'
import { DaemonError } from '../errors'
import type { ConversationAuthority, ConversationCommandState, ConversationEventPage, ConversationHostEvent, ConversationRunEvidence } from '../../../shared/conversation/desktop'
import { ModelSelection, OrchestrationV2DomainEventJson, type OrchestrationV2DomainEvent } from '../../../shared/conversation/contracts'

export interface ConversationRuntimePorts {
  directory: string
  driverRegistry?: ConversationDriverRegistry
  assertOwner(): void
}

interface MessageRow { message_id: string; streaming: number; payload_json: string }
interface RunRow { run_id: string; thread_id: string; ordinal: number; provider_instance_id: string; status: string; payload_json: string }
interface OutboxRow { effect_id: string; command_id: string; thread_id: string; payload_json: string; status: string; last_error: string | null; lease_expires_at: string | null }

const failureMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection)

/**
 * The new conversation kernel. It owns its storage and never reads legacy ACP history.
 * A turn is executed only by draining its outbox item, so a crash between intake and
 * dispatch leaves exactly one retryable intent instead of a second message.
 */
export class ConversationRuntime {
  private readonly database
  private readonly driverRegistry: ConversationDriverRegistry
  private readonly eventSink: ConversationEventSink
  private readonly intake: ThreadMessageIntake
  /** Spawned processes by project root; a thread never runs inside another project's process. */
  private readonly processes = new Map<string, { root: string; driver: ConversationDriverSession }>()
  /** Drivers whose handshake completed, by project root. */
  private readonly ready = new Map<string, { projectId: string; driver: ConversationDriverSession }>()
  private readonly driverOpenings = new Map<string, { root: string; projectId: string; opening: Promise<ConversationDriverSession> }>()
  private readonly draining = new Set<string>()
  private readonly dispatches = new Map<string, { root: string; work: Promise<void> }>()
  private closing = false
  constructor(private readonly ports: ConversationRuntimePorts) {
    this.database = openConversationDatabase(ports.directory)
    this.driverRegistry = ports.driverRegistry ?? conversationDriverRegistry
    this.eventSink = new ConversationEventSink(this.database)
    this.intake = new ThreadMessageIntake(this.database, this.eventSink)
  }

  private async ensureDriver(cwd: string, projectId: string, registration: ConversationDriverRegistration, assertCurrent: () => void): Promise<ConversationDriverSession> {
    this.ports.assertOwner()
    if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission is closed while the kernel shuts down.')
    const key = JSON.stringify([registration.instanceId, process.platform === 'win32' ? cwd.toLowerCase() : cwd])
    const ready = this.ready.get(key)
    if (ready?.projectId === projectId && ready.driver.isAvailable()) return ready.driver
    this.ready.delete(key)
    // One promise per root covers cleanup, spawn and handshake, so concurrent callers never race.
    const existing = this.driverOpenings.get(key)
    if (existing) {
      if (existing.projectId !== projectId) throw new DaemonError('E_CONFLICT', '原目录代次的引擎还在收尾，请重新打开模型目录。')
      return existing.opening
    }
    const opening = Promise.resolve().then(() => this.runOpenDriver(key, cwd, projectId, registration, assertCurrent))
    this.driverOpenings.set(key, { root: cwd, projectId, opening })
    return opening
  }

  private async runOpenDriver(key: string, cwd: string, projectId: string, registration: ConversationDriverRegistration, assertCurrent: () => void): Promise<ConversationDriverSession> {
    try {
      // Only a confirmed exit releases ownership; an unconfirmed close refuses the retry.
      const owned = this.processes.get(key)
      if (owned) {
        await Effect.runPromise(owned.driver.close())
        if (this.processes.get(key) === owned) this.processes.delete(key)
        this.ready.delete(key)
      }
      // Shutdown may have begun while the cleanup waited; never spawn into a closing kernel.
      if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission closed while the engine was starting.')
      const driver = await Effect.runPromise(registration.open({
        instanceId: registration.instanceId,
        directory: this.ports.directory,
        cwd,
        assertCanSpawn: () => {
          this.ports.assertOwner()
          if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission closed while the engine was starting.')
          assertCurrent()
        },
        onSpawn: spawned => { this.processes.set(key, { root: cwd, driver: spawned }) },
      }))
      if (this.closing) {
        // Keep ownership until the exit is confirmed; a failed close must stay owned.
        await Effect.runPromise(driver.close())
        if (this.processes.get(key)?.driver === driver) this.processes.delete(key)
        throw new DaemonError('E_UNAVAILABLE', 'Conversation admission closed while the engine was starting.')
      }
      this.ready.set(key, { projectId, driver })
      return driver
    } catch (error) {
      // Keep ownership if the handshake failed but the process may still be alive.
      const spawned = this.processes.get(key)
      if (spawned && !this.ready.has(key)) {
        try { await Effect.runPromise(spawned.driver.close()); if (this.processes.get(key) === spawned) this.processes.delete(key) } catch { /* retained for shutdown */ }
      }
      throw error
    } finally {
      this.driverOpenings.delete(key)
    }
  }

  async listModels(cwd: string, projectId: string, instanceId: string, assertCurrent: () => void): Promise<readonly ConversationDriverModel[]> {
    const driver = await this.ensureDriver(cwd, projectId, this.driverRegistry.require(instanceId), assertCurrent)
    assertCurrent()
    return Effect.runPromise(driver.listModels())
  }

  createThread(input: ConversationAuthority & {
    readonly title?: string
    readonly text: string
    readonly model: string
    readonly instanceId: string
    readonly commandId: string
    readonly messageId?: string
    readonly assertCurrent: () => void
  }): ConversationCommandState {
    this.ports.assertOwner()
    if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission is closed.')
    input.assertCurrent()
    if (input.binding.kind !== 'personal') throw new DaemonError('E_DENIED', '任务会话须通过受控任务入口。')
    const registration = this.driverRegistry.require(input.instanceId)
    const accepted = this.intake.launchThread({
      projectId: input.projectId, ownerId: input.ownerId, spaceId: input.spaceId, title: input.title ?? '',
      text: input.text, driverKind: registration.driverKind, modelSelection: decodeModelSelection({ instanceId: registration.instanceId, model: input.model }),
      commandId: input.commandId, messageId: input.messageId,
    })
    if ('conflict' in accepted) throw new DaemonError('E_CONFLICT', accepted.conflict)
    if (!accepted.committed) return this.commandState(accepted.receipt)
    const { commandId } = accepted.receipt
    const work = Promise.resolve()
      .then(() => this.drainOne(commandId, input.cwd, input.projectId, input.assertCurrent))
      .catch(() => process.emitWarning(`Unable to settle conversation command ${commandId}.`, { code: 'CRUX_CONVERSATION_SETTLEMENT' }))
      .finally(() => this.dispatches.delete(commandId))
    this.dispatches.set(commandId, { root: input.cwd, work })
    return { ...accepted.receipt, dispatch: 'accepted' }
  }

  private async drainOne(commandId: string, cwd: string, projectId: string, assertCurrent: () => void): Promise<void> {
    this.ports.assertOwner()
    const row = this.database.prepare('SELECT effect_id, command_id, thread_id, payload_json, status, last_error, lease_expires_at FROM conversation_v2_effect_outbox WHERE command_id = ?').get(commandId) as OutboxRow | undefined
    if (!row || row.status !== 'pending' || this.closing || this.draining.has(row.thread_id)) return
    const runId = (JSON.parse(row.payload_json) as { runId: string }).runId
    let dispatched = false
    let nativeTurnId = ''
    this.draining.add(row.thread_id)
    try {
      assertCurrent()
      const claimed = this.database.prepare("UPDATE conversation_v2_effect_outbox SET status = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE effect_id = ? AND status = 'pending'").run(`crux-${process.pid}`, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), row.effect_id)
      if (claimed.changes === 0) return
      const run = this.database.prepare('SELECT run_id, thread_id, ordinal, provider_instance_id, status, payload_json FROM conversation_v2_projection_runs WHERE run_id = ?').get(runId) as RunRow | undefined
      if (!run) throw new Error('The accepted run is missing.')
      const selection = (JSON.parse(run.payload_json) as { modelSelection: { instanceId: string; model: string } }).modelSelection
      const driver = await this.ensureDriver(cwd, projectId, this.driverRegistry.require(selection.instanceId), assertCurrent)
      assertCurrent()
      const nativeThreadId = await Effect.runPromise(driver.startThread(selection.model, cwd)).catch(error => { throw new DaemonError('E_UNAVAILABLE', failureMessage(error)) })
      assertCurrent()
      const startedAt = new Date().toISOString()
      const runningPayload = { ...JSON.parse(run.payload_json), status: 'running', providerThreadId: nativeThreadId, startedAt }
      const runningEvent = decodeEvent({ type: 'run.updated', id: randomUUID(), threadId: run.thread_id, runId, occurredAt: startedAt, payload: runningPayload })
      this.eventSink.commit({ events: [runningEvent] }, () => {
        this.database.prepare('UPDATE conversation_v2_projection_runs SET provider_thread_id = ?, status = ?, payload_json = ? WHERE run_id = ?')
          .run(nativeThreadId, 'running', JSON.stringify(runningPayload), runId)
      })
      const userMessage = this.database.prepare("SELECT payload_json FROM conversation_v2_projection_messages WHERE run_id = ? AND role = 'user' ORDER BY created_at LIMIT 1").get(runId) as { payload_json: string } | undefined
      const prompt = userMessage ? (JSON.parse(userMessage.payload_json) as { text: string }).text : ''
      let terminalStatus = 'completed'
      let terminalError: string | undefined
      dispatched = true
      const turnResult = await Effect.runPromise(driver.startTurn(nativeThreadId, cwd, prompt, selection.model, event => {
        if (event.type === 'turn-receipt') {
          nativeTurnId = event.turnId
          this.recordTurnEvidence(run.thread_id, runId, { nativeTurnId })
        }
        if (event.type === 'turn-accepted') {
          nativeTurnId = event.turnId
          this.recordTurnEvidence(run.thread_id, runId, {
            nativeTurnId, engineAcceptedAt: new Date().toISOString(),
            ...(event.nativeStartedAt ? { nativeStartedAt: event.nativeStartedAt } : {}),
          })
        }
        if ((event.type === 'text-delta' || event.type === 'text-final') && event.itemId && event.text) {
          this.writeAssistantText(run.thread_id, runId, event.itemId, event.text, event.type === 'text-final')
        }
        if (event.type === 'turn-completed') {
          terminalStatus = event.status ?? 'completed'
          terminalError = event.error
        }
      })).then(turnId => ({ outcome: 'completed' as const, turnId })).catch(error => {
        if (error instanceof ConversationTurnOutcomeUnknownError) return { outcome: 'unknown' as const, turnId: error.turnId }
        if (error instanceof ConversationTurnRejectedError) dispatched = false
        throw new DaemonError('E_UNAVAILABLE', failureMessage(error))
      })
      nativeTurnId = turnResult.turnId || nativeTurnId
      const settled = new Date().toISOString()
      if (turnResult.outcome === 'unknown') {
        // The engine accepted the turn but never reported its end: this is unknown, not failed.
        // Keep the original turn and command so the result can be queried by identity, never re-sent.
        this.settleUnknown(row, runId, nativeTurnId, settled, nativeTurnId
          ? '引擎已返回回合编号，结束状态待按原回合核对。'
          : '已进入引擎派发窗口，送达结果待按原命令核对。')
        return
      }
      const failed = terminalStatus !== 'completed'
      const detail = failed ? (terminalError || `引擎回合结束为 ${terminalStatus}`) : undefined
      // Run, message streaming and outbox settle in one transaction so no reader sees a split outcome.
      this.settleOutcome(row, run.thread_id, runId, failed ? 'failed' : terminalStatus, detail, failed ? 'failed' : 'succeeded', settled)
    } catch (error) {
      if (dispatched) {
        this.settleUnknown(row, runId, nativeTurnId, new Date().toISOString(), '引擎派发或本地结算结果待核对。')
        return
      }
      const detail = failureMessage(error)
      this.settleOutcome(row, row.thread_id, runId, 'failed', detail, 'failed', new Date().toISOString())
    } finally { this.draining.delete(row.thread_id) }
  }

  private runEvidenceEvent(threadId: string, runId: string, evidence: ConversationRunEvidence, occurredAt: string): ConversationHostEvent {
    return { id: randomUUID(), threadId, runId, occurredAt, type: 'crux.run-evidence', payload: evidence }
  }

  private recordTurnEvidence(threadId: string, runId: string, evidence: ConversationRunEvidence): void {
    this.ports.assertOwner()
    const event = this.runEvidenceEvent(threadId, runId, evidence, new Date().toISOString())
    this.eventSink.commit({ hostEvents: [event] }, () => this.applyTurnEvidence(runId, evidence))
  }

  private applyTurnEvidence(runId: string, evidence: ConversationRunEvidence): void {
    this.database.prepare('UPDATE conversation_v2_projection_runs SET payload_json = json_patch(payload_json, ?) WHERE run_id = ?').run(JSON.stringify(evidence), runId)
  }

  /** A dispatch failure leaves the run visibly failed with the actual cause; it never looks running. */
  /**
   * Settles the run, its assistant message and the outbox row in one transaction. Normal and
   * exceptional paths share this, so a reader never observes run/outbox disagreement.
   */
  private settleOutcome(row: OutboxRow, threadId: string, runId: string, status: string, detail: string | undefined, outboxStatus: 'succeeded' | 'failed', settled: string): void {
    this.ports.assertOwner()
    const run = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ?').get(runId) as { payload_json: string } | undefined
    const outputs = this.database.prepare("SELECT payload_json FROM conversation_v2_projection_messages WHERE run_id = ? AND role = 'assistant'").all(runId) as { payload_json: string }[]
    const events: OrchestrationV2DomainEvent[] = []
    if (run) events.push(decodeEvent({
      type: 'run.updated', id: randomUUID(), threadId, runId, occurredAt: settled,
      payload: { ...JSON.parse(run.payload_json), status, completedAt: settled },
    }))
    for (const output of outputs) events.push(decodeEvent({
      type: 'message.updated', id: randomUUID(), threadId, runId, occurredAt: settled,
      payload: { ...JSON.parse(output.payload_json), streaming: false, updatedAt: settled },
    }))
    const hostEvents = detail ? [this.runEvidenceEvent(threadId, runId, { failure: detail }, settled)] : []
    this.eventSink.commit({ events, hostEvents }, () => {
      this.settleRun(threadId, runId, status, detail, settled)
      this.database.prepare(`UPDATE conversation_v2_effect_outbox SET status = ?, last_error = ?, attempt_count = attempt_count + 1, completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE effect_id = ?`)
        .run(outboxStatus, detail ?? null, settled, settled, row.effect_id)
    })
  }

  /** An unknown outcome stays running-but-unconfirmed; the outbox keeps its lease for reconciliation. */
  private settleUnknown(row: OutboxRow, runId: string, nativeTurnId: string, settled: string, detail: string): void {
    this.ports.assertOwner()
    const evidence: ConversationRunEvidence = { outcomeUnknown: true, outcomeUnknownAt: settled, failure: detail, ...(nativeTurnId ? { nativeTurnId } : {}) }
    const event = this.runEvidenceEvent(row.thread_id, runId, evidence, settled)
    this.eventSink.commit({ hostEvents: [event] }, () => {
      this.applyTurnEvidence(runId, evidence)
      this.database.prepare('UPDATE conversation_v2_effect_outbox SET status = ?, last_error = ?, lease_expires_at = ?, updated_at = ? WHERE effect_id = ?')
        .run('running', detail, new Date(Date.now() + 10 * 60_000).toISOString(), settled, row.effect_id)
    })
  }

  /** One settlement for run, message streaming and thread activity; readers never see a split state. */
  private settleRun(threadId: string, runId: string, status: string, failure: string | undefined, settled: string): void {
    this.ports.assertOwner()
    const row = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ?').get(runId) as { payload_json: string } | undefined
    if (row) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>
      this.database.prepare('UPDATE conversation_v2_projection_runs SET status = ?, completed_at = ?, payload_json = ? WHERE run_id = ?')
        .run(status, settled, JSON.stringify({ ...payload, status, completedAt: settled, ...(failure ? { failure } : {}) }), runId)
    }
    this.database.prepare(`UPDATE conversation_v2_projection_messages SET streaming = 0, updated_at = ?,
      payload_json = json_patch(payload_json, ?) WHERE run_id = ? AND role = 'assistant'`)
      .run(settled, JSON.stringify({ streaming: false, updatedAt: settled }), runId)
    this.database.prepare('UPDATE conversation_v2_projection_threads SET updated_at = ? WHERE thread_id = ?').run(settled, threadId)
  }



  private writeAssistantText(threadId: string, runId: string, itemId: string, text: string, final: boolean): void {
    this.ports.assertOwner()
    const messageId = `msg_${createHash('sha256').update(JSON.stringify([runId, itemId])).digest('hex')}`
    const existing = this.database.prepare('SELECT message_id, payload_json, streaming FROM conversation_v2_projection_messages WHERE message_id = ?')
      .get(messageId) as MessageRow | undefined
    const now = new Date().toISOString()
    if (!existing) {
      const projection = {
        createdBy: 'agent', creationSource: 'server', id: messageId, threadId, runId, nodeId: null, role: 'assistant',
        text, attachments: [], streaming: !final, createdAt: now, updatedAt: now,
      }
      const event = decodeEvent({ id: randomUUID(), threadId, runId, occurredAt: now, type: 'message.updated', payload: projection })
      const first = this.database.prepare("SELECT 1 FROM conversation_v2_projection_messages WHERE run_id = ? AND role = 'assistant' LIMIT 1").get(runId) === undefined
      const evidence = { firstOutputAt: now }
      this.eventSink.commit({ events: [event], hostEvents: first ? [this.runEvidenceEvent(threadId, runId, evidence, now)] : [] }, () => {
        this.database.prepare(`
          INSERT INTO conversation_v2_projection_messages (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
          VALUES (?, ?, ?, NULL, 'assistant', ?, ?, ?, ?)
        `).run(messageId, threadId, runId, final ? 0 : 1, now, now, JSON.stringify(projection))
        if (first) this.applyTurnEvidence(runId, evidence)
      })
      return
    }
    if (existing.streaming === 0) return
    const payload = JSON.parse(existing.payload_json) as { text: string }
    const projection = { ...payload, text: final ? text : payload.text + text, streaming: !final, updatedAt: now }
    const base = { id: randomUUID(), threadId, runId, occurredAt: now }
    this.eventSink.commit(final
      ? { events: [decodeEvent({ ...base, type: 'message.updated', payload: projection })] }
      : { hostEvents: [{ ...base, type: 'crux.message-delta', payload: { messageId, text } }] },
    () => {
      this.database.prepare('UPDATE conversation_v2_projection_messages SET payload_json = ?, updated_at = ?, streaming = ? WHERE message_id = ?')
        .run(JSON.stringify(projection), now, final ? 0 : 1, existing.message_id)
    })
  }



  listThreads(ownerId: string, spaceId: string, projectId: string): unknown {
    this.ports.assertOwner()
    return this.intake.listThreads(ownerId, spaceId, projectId)
  }

  readThread(threadId: string, ownerId: string, spaceId: string, projectId: string): unknown {
    this.ports.assertOwner()
    const projection = this.hasThread(threadId, ownerId, spaceId, projectId) && this.intake.readThread(threadId)
    if (!projection) return null
    const interrupted = !this.draining.has(threadId)
    return {
      ...projection,
      asOfSequence: this.eventSink.latestSequence(threadId),
      runs: projection.runs.map(run => run.status === 'running' && interrupted ? { ...run, outcomeUnknown: true } : run),
    }
  }

  private hasThread(threadId: string, ownerId: string, spaceId: string, projectId: string): boolean {
    return this.database.prepare('SELECT 1 FROM conversation_v2_projection_threads WHERE thread_id = ? AND owner_id = ? AND space_id = ? AND project_id = ? AND deleted_at IS NULL')
      .get(threadId, ownerId, spaceId, projectId) !== undefined
  }

  readEvents(input: { threadId: string; afterSequence: number; limit?: number }, authority: ConversationAuthority): ConversationEventPage | null {
    this.ports.assertOwner()
    if (!this.hasThread(input.threadId, authority.ownerId, authority.spaceId, authority.projectId)) return null
    return this.eventSink.readEventPage(input.threadId, input.afterSequence, input.limit ?? 50)
  }

  private commandState(receipt: Omit<ConversationCommandState, 'dispatch'>): ConversationCommandState {
    const row = this.database.prepare('SELECT status, last_error FROM conversation_v2_effect_outbox WHERE command_id = ?').get(receipt.commandId) as Pick<OutboxRow, 'status' | 'last_error'> | undefined
    const active = this.dispatches.has(receipt.commandId)
    const dispatch = row?.status === 'succeeded' ? 'completed' : row?.status === 'failed' ? 'failed'
      : row?.status === 'pending' ? active ? 'accepted' : 'paused'
      : active ? 'running' : 'pending-reconciliation'
    return { ...receipt, dispatch, ...(row?.last_error ? { detail: row.last_error } : {}) }
  }

  readCommand(commandId: string, ownerId: string, spaceId: string, projectId: string): ConversationCommandState | null {
    this.ports.assertOwner()
    const receipt = this.intake.readCommand(commandId, ownerId, spaceId, projectId)
    return receipt ? this.commandState(receipt) : null
  }

  activityCount(): number {
    return this.dispatches.size + this.driverOpenings.size
  }

  ownsWorkspace(within: (path: string) => boolean): boolean {
    return [...this.dispatches.values()].some(dispatch => within(dispatch.root))
      || [...this.driverOpenings.values()].some(entry => within(entry.root))
      || [...this.processes.values()].some(owned => within(owned.root))
  }

  /**
   * Closes every owned app-server. An unconfirmed exit is reported upward and the driver stays
   * recorded, so the owner never claims a clean shutdown while a process may still be alive.
   */
  async shutdown(): Promise<void> {
    this.closing = true
    // Signal every owned process first, including one still inside its handshake, so a silent
    // app-server cannot hold quit open. Only a confirmed exit releases ownership.
    const closes = await Promise.allSettled([...this.processes.entries()].map(async ([key, owned]) => {
      await Effect.runPromise(owned.driver.close())
      if (this.processes.get(key) === owned) {
        this.processes.delete(key)
        this.ready.delete(key)
      }
    }))
    // A handshake whose process refuses to exit must not hold shutdown open; bound the wait.
    const unwound = await Promise.race([
      Promise.allSettled([...this.driverOpenings.values()].map(entry => entry.opening)).then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ])
    if (unwound === 'timeout') throw new Error('A conversation engine handshake did not unwind within the shutdown deadline; its ownership is retained.')
    const unconfirmed = closes.filter(result => result.status === 'rejected')
    await Promise.allSettled([...this.dispatches.values()].map(dispatch => dispatch.work))
    if (unconfirmed.length > 0) throw new Error(`${unconfirmed.length} conversation engine process(es) did not confirm exit; their ownership is retained.`)
  }
}
