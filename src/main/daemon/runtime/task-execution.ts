import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { nativeTaskExecutionRequestSchema, nativeTaskExecutionResultSchema, nativeTaskStartSchema,
  nativeTaskOutputSyncSchema, type NativeTaskExecutionRequest, type NativeTaskExecutionResult, type NativeTaskStart } from '../../../shared/native-task-execution'
import { processOwnerSchema, workspaceGrantSchema } from '../../../shared/daemon/identity'
import { workcopyLeaseSchema, type WorkcopyLease } from '../../../shared/workcopy-use'
import { teamExecutionCommandSchema, teamExecutionReceiptSchema, teamTaskIdentity, type TeamExecutionCommand } from '../../../shared/team-task-execution'
import { executionArtifactKindSchema, executionCodeSourceSchema, type ExecutionArtifactRef, type ExecutionCodeSource, type ExecutionDeliveryManifest } from '../../../shared/team-execution-artifacts'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { executionContextManifestSchema, platformReferenceDeliveryReceiptSchema } from '../../../shared/team-execution-input'
import { replayConversationTextEvents } from '../../../shared/acp-text-blocks'
import type { NativeTaskBinding } from '../../../shared/native-task-preparation'
import type { TimelineEvent } from '../../../shared/types'
import type { IpcFail } from '../../../shared/ipc-errors'
import { DaemonError } from '../errors'
import { readBounded, writeAtomic, writeExclusiveAtomic } from '../files'
import { processIdentity, sameOwner } from '../native'
import { NativeTaskPreparation, type NativeTaskPreparationAuthority } from './task-preparation'
import { confirmDatabaseDelivery } from './database-delivery'
import * as acp from '../../services/acp'
import { BUILTINS } from '../../services/acp/setup'
import { PI_VERSION } from '../../services/pi/protocol'
import { observeWorkflowAcp } from '../../services/workflow-runtime/acp-events'
import { prepareExecutionAgentRules } from '../../services/agent-rules'
import { preparePlatformExecutionInput, transitionPlatformDelivery } from '../../services/platform-reference-delivery'
import { captureSelectedFile, verifyHandoffSource } from '../../services/crux/task-outputs/handoff-source'
import { readTaskSessionIntent } from '../../services/workcopy-use/task-session-intent'
import { hasAcpJobOwner, isAcpJobOwnerCleaned } from '../../services/workcopy-use/acp-jobs'
import { DesktopTeamError } from '../../services/team-platform/types'
import { nativeTaskFailureSchema } from '../../../shared/native-task-failure'
import { nativeTaskFailure } from '../../services/native-task-failure'
import type { WorkcopyUseRegistry } from '../../services/workcopy-use/registry'
import { resolveWorkcopy, assertWorkcopyObservation } from '../../services/workcopy-use/identity'
import type { WorkspaceAdmission } from '../../services/workflow-admission'
import type { TaskExecutionTransport } from '../../services/team-platform/task-execution-transport'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const MAX_RECORD_BYTES = 4 * 1024 * 1024
const STOP_RECORD_HEADROOM_BYTES = 4 * 1024
const reportSchema = nativeTaskExecutionRequestSchema.options[1]
const candidateSchema = z.object({ outputId: z.string(), bodyDigest: z.string().length(64), byteLength: z.number().int().nonnegative(),
  artifactKind: executionArtifactKindSchema, capturedAt: z.number().int().nonnegative() }).strict()
const mutationSchema = z.object({ key: z.string(), command: teamExecutionCommandSchema, receipt: teamExecutionReceiptSchema.nullable() }).strict()
const recordSchema = z.object({ version: z.literal(1), request: nativeTaskStartSchema, root: z.string(),
  executionKey: z.string().length(64),
  grant: workspaceGrantSchema, nativeOwner: processOwnerSchema, result: nativeTaskExecutionResultSchema,
  admitted: z.boolean(), nativeEntered: z.boolean(), stopRequested: z.boolean(), stopCommandId: z.string().uuid().nullable(),
  commandIds: z.array(z.string().uuid()).max(128), lease: workcopyLeaseSchema.nullable(),
  nativeIntents: z.array(z.object({ commandId: z.string().uuid(), request: nativeTaskExecutionRequestSchema }).strict()).max(128),
  context: executionContextManifestSchema.nullable(),
  registration: z.object({ outputIds: z.array(z.string()).min(1).max(16), remainingWork: z.string().max(8192) }).strict().optional(),
  outputSync: nativeTaskOutputSyncSchema.optional(), finishRequested: z.boolean().optional(),
  codeObservation: z.object({ verification: z.literal('device-reported'), observedAt: z.number().int().nonnegative(),
    availability: z.literal('available'), sourceDigest: z.string().length(64) }).strict().nullable().optional(),
  failure: nativeTaskFailureSchema.optional(),
  baselines: z.array(z.object({ outputId: z.string(), digest: z.string().length(64).nullable() }).strict()).max(16),
  candidates: z.array(candidateSchema).max(16), mutations: z.array(mutationSchema).max(64), report: reportSchema.nullable()
}).strict()
type Record = z.infer<typeof recordSchema>
type Report = z.infer<typeof reportSchema>
type Candidate = z.infer<typeof candidateSchema>
type Live = { admission?: WorkspaceAdmission; launch?: acp.PlatformAcpLaunch; start?: Promise<void>; capture?: Promise<void>; stop?: Promise<void>; unobserve?: () => void;
  startBoundary?: 'native-session' | 'prompt'; phase?: string }
export interface NativeTaskExecutionPorts {
  directory: string
  workcopies: WorkcopyUseRegistry
  preparation: Pick<NativeTaskPreparation, 'retained' | 'authorizeAuthority' | 'execute' | 'withExecution' | 'executionRules' | 'withReceipts' | 'withCapturedOutputs'
    | 'taskStartHook' | 'assertTaskStartHook' | 'recordTaskStartFailure'>
  assertOwner(): void
  assertCurrent(grant: Record['grant']): void
}

/** A facade over existing native controllers, not an engine, scheduler or task-state owner. */
export class NativeTaskExecutions {
  private readonly directory: string
  private readonly records = new Map<string, Record>()
  private readonly live = new Map<string, Live>()
  private readonly exitedOrigins = new Set<string>()
  private readonly syncing = new Map<string, Promise<void>>()
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  constructor(private readonly ports: NativeTaskExecutionPorts) {
    this.directory = join(realpathSync.native(ports.directory), 'native-task-executions')
    if (!existsSync(this.directory)) return
    this.storage()
    const entries = readdirSync(this.directory)
    if (entries.length > 2000) throw new DaemonError('E_BUSY', 'Retained native execution storage exceeds its limit')
    for (const id of entries) {
      z.string().uuid().parse(id)
      const record = recordSchema.parse(JSON.parse(readBounded(this.path(id), MAX_RECORD_BYTES)))
      if (record.request.dispatchId !== id) throw new DaemonError('E_DENIED', 'Retained native execution identity changed')
      if (!record.result.cleanupConfirmed) record.result.state = 'unknown'
      record.result.permissions = []
      this.records.set(id, record)
    }
  }
  private storage(): void {
    if (existsSync(this.directory) && (lstatSync(this.directory).isSymbolicLink() || realpathSync.native(this.directory) !== this.directory)) throw new DaemonError('E_DENIED', 'Native execution storage cannot be redirected')
  }
  private path(id: string): string {
    z.string().uuid().parse(id); this.storage()
    const directory = join(this.directory, id)
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || realpathSync.native(directory) !== directory)) throw new DaemonError('E_DENIED', 'Original native execution directory was redirected')
    const file = join(directory, 'record.json')
    if (existsSync(file)) {
      const entry = lstatSync(file)
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new DaemonError('E_DENIED', 'Original native execution metadata must be a single regular file')
    }
    return file
  }
  private outputPath(record: Record, outputId: string, create = false): string {
    this.path(record.request.dispatchId)
    const directory = join(this.directory, record.request.dispatchId, 'outputs')
    if (create && !existsSync(directory)) mkdirSync(directory)
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(directory) !== directory) throw new DaemonError('E_DENIED', 'Original native output directory cannot be redirected')
    const file = join(directory, hash(outputId) + '.txt')
    if (existsSync(file)) {
      const entry = lstatSync(file)
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new DaemonError('E_DENIED', 'Original native output must be a single regular file')
    }
    return file
  }
  private save(record: Record): void {
    this.ports.assertOwner()
    const parsed = recordSchema.parse(record), text = JSON.stringify(parsed)
    // Preserve bytes for the dedicated Stop ID/state and bounded pending-command
    // projection. Budget derived fields before a response hydrates them in memory.
    const projectedBytes = Buffer.byteLength(JSON.stringify({ ...parsed, result: { ...parsed.result, ...this.projection(parsed) } }))
    const limit = MAX_RECORD_BYTES - (record.stopCommandId ? 0 : STOP_RECORD_HEADROOM_BYTES)
    if (Math.max(Buffer.byteLength(text), projectedBytes) > limit) throw new DaemonError('E_BUSY', 'Native execution metadata exceeds its bound or reserved Stop headroom')
    writeAtomic(this.path(record.request.dispatchId), text)
  }
  private record(id: string): Record {
    const record = this.records.get(id)
    if (!record) throw new DaemonError('E_UNAVAILABLE', 'Original native dispatch is unavailable')
    return record
  }
  retainedGrant(id: string): Record['grant'] { this.ports.assertOwner(); return structuredClone(this.record(id).grant) }
  private binding(record: Record): NativeTaskBinding { return this.ports.preparation.retained(record.request.preparationId) }
  private assertOwned(record: Record): void {
    this.ports.assertOwner(); this.ports.assertCurrent(record.grant)
    if (!record.admitted || record.stopRequested || record.result.cleanupConfirmed || !record.lease) throw new DaemonError('E_CONFLICT', 'Original native execution no longer admits new writes')
    const live = this.live.get(record.request.dispatchId)
    if (!live?.admission?.isCurrent()) throw new DaemonError('E_UNKNOWN', 'Original native execution requires reconciliation', 'unknown')
    const actual = this.ports.workcopies.assertHeld(record.root, record.lease.token, record.lease.owner)
    assertWorkcopyObservation(actual, record.lease.identity)
  }
  private async assertUse(record: Record): Promise<void> {
    this.assertOwned(record)
    await this.ports.preparation.withExecution(this.binding(record), () => this.assertOwned(record), async () => {})
    this.assertOwned(record)
  }
  private async assertActor(record: Record, actor: Record['nativeOwner'], assertProduct: () => void): Promise<void> {
    const original = structuredClone(record.nativeOwner), current = structuredClone(actor)
    this.ports.assertOwner(); assertProduct()
    if (sameOwner(original, current)) return
    const executableKey = (value: string): string => {
      const path = realpathSync.native(value)
      return process.platform === 'win32' ? path.toLowerCase() : path
    }
    if ((!record.admitted && !this.canRetry(record)) || current.userId !== original.userId) throw new DaemonError('E_DENIED', 'Original native dispatch cannot be recovered by this process')
    const executable = executableKey(original.executable)
    if (executableKey(current.executable) !== executable) throw new DaemonError('E_DENIED', 'Original native dispatch belongs to another application')
    const key = taskInputCanonical(original)
    if (!this.exitedOrigins.has(key)) {
      // A failed/unknown native query cannot establish exit. PID reuse is safe
      // only when the actual queried PID has a different process birth.
      const actual = await processIdentity(original.pid)
      this.ports.assertOwner(); assertProduct()
      if (!sameOwner(record.nativeOwner, original) || executableKey(original.executable) !== executable || executableKey(current.executable) !== executable) throw new DaemonError('E_CONFLICT', 'Original native recovery identity changed')
      if (actual && (actual.pid !== original.pid || actual.startedAt === original.startedAt)) throw new DaemonError('E_DENIED', 'Original native GUI is still live or its exit could not be verified')
      // Only this irreversible exit fact is cached; it grants no task, input,
      // device, configuration or workspace authority and changes no provenance.
      this.exitedOrigins.add(key)
    }
    this.ports.assertOwner(); assertProduct()
  }
  async assertAuthority(root: string, request: NativeTaskExecutionRequest, authority: NativeTaskPreparationAuthority): Promise<void> {
    this.ports.assertOwner(); authority.assertProduct()
    if (request.operation === 'start') {
      if (root !== authority.grant.root) throw new DaemonError('E_DENIED', 'Product start requires its original workspace grant')
      await this.ports.preparation.authorizeAuthority(root, { operation: 'inspect', preparationId: request.preparationId }, authority)
    } else {
      const original = this.record(request.dispatchId)
      if (root !== '@profile' && root !== original.root) throw new DaemonError('E_DENIED', 'Original native dispatch belongs to another directory')
      if (!original.admitted && !sameOwner(original.nativeOwner, authority.actor) && !['reconcile', 'stop'].includes(request.operation))
        throw new DaemonError('E_DENIED', 'A new GUI may only inspect the original stopped no-entry dispatch')
      await this.assertActor(original, authority.actor, authority.assertProduct.bind(authority))
    }
  }
  async assertReceipt(root: string, commandId: string, assertProduct: () => void, actor: Record['nativeOwner']): Promise<void> {
    const record = [...this.records.values()].find(record => (record.commandIds.includes(commandId) || record.stopCommandId === commandId) && (root === '@profile' || record.root === root))
    if (!record) throw new DaemonError('E_DENIED', 'Original product command has no retained native identity')
    await this.assertActor(record, actor, assertProduct)
  }
  async execute(root: string, raw: NativeTaskExecutionRequest, authority: NativeTaskPreparationAuthority, commandId?: string): Promise<NativeTaskExecutionResult> {
    const request = nativeTaskExecutionRequestSchema.parse(raw)
    await this.assertAuthority(root, request, authority)
    if (request.operation === 'start') {
      if (request.dispatchId !== commandId) throw new DaemonError('E_CONFLICT', 'Native dispatch ID must equal its original start command UUID')
      await this.start(root, request, authority)
    } else {
      const record = this.record(request.dispatchId)
      if (request.operation !== 'reconcile' && request.operation !== 'stop' && commandId) {
        if (record.stopCommandId === commandId) throw new DaemonError('E_CONFLICT', 'Original stop command cannot become another native intent')
        const original = record.nativeIntents.find(item => item.commandId === commandId)
        if (original && taskInputCanonical(original.request) !== taskInputCanonical(request)) throw new DaemonError('E_CONFLICT', 'Original native command intent changed')
        if (!original) {
          if (record.commandIds.length >= 128 || record.nativeIntents.length >= 128) throw new DaemonError('E_BUSY', 'Original native command retention is full; retained intents are preserved')
          const intent = { commandId, request: structuredClone(request) }
          this.save({ ...record, commandIds: [...record.commandIds, commandId], nativeIntents: [...record.nativeIntents, intent] })
          record.commandIds.push(commandId); record.nativeIntents.push(intent)
        }
      }
      if (request.operation === 'stop') {
        if (!commandId) throw new DaemonError('E_INVALID_ARG', 'Original native Stop requires its stable command UUID')
        const original = record.nativeIntents.find(item => item.commandId === commandId)
        if (original && taskInputCanonical(original.request) !== taskInputCanonical(request)) throw new DaemonError('E_CONFLICT', 'Original native command intent changed')
        if (!record.stopCommandId) { this.save({ ...record, stopCommandId: commandId }); record.stopCommandId = commandId }
        await this.stop(record)
      } else if (request.operation === 'reconcile') await this.reconcile(record, request.retryOutputs === true)
      else if (request.operation === 'permission') {
        await this.assertUse(record)
        const launch = this.live.get(record.request.dispatchId)?.launch
        if (!launch) throw new DaemonError('E_UNKNOWN', 'Original native configuration owner is unavailable', 'unknown')
        launch.assertCurrent()
        const native = acp.platformAcpSession(record.root, record.result.native.sessionId, record.request.dispatchId)
        const pending = native?.pendingPermissions?.find(item => item.requestId === request.requestId
          && item.connectionGeneration === record.result.native.connectionGeneration && item.turnId === record.result.native.turnId)
        if (!pending || pending.options.filter(option => option.optionId === request.optionId).length !== 1) throw new DaemonError('E_CONFLICT', 'Original scoped native permission is no longer pending')
        const result = acp.respondAcpPermission(record.root, request.requestId, request.optionId, record.request.dispatchId)
        if (!result.ok) throw new DaemonError('E_CONFLICT', 'Original native permission was not accepted')
      } else if (request.operation === 'finish') {
        record.finishRequested = true; this.save(record)
        if (!record.report) {
          const files = record.candidates.filter(item => item.artifactKind === 'selected-file' && record.request.outputs.some(output => output.outputId === item.outputId && output.source.kind === 'file')).map(item => item.outputId)
          const code = request.code ?? (files.length ? { kind: 'selected-files' as const, outputIds: files } : undefined)
          if (code) await this.report(record, { operation: 'report', dispatchId: record.request.dispatchId,
            outputIds: record.registration?.outputIds ?? record.candidates.map(item => item.outputId), remainingWork: record.registration?.remainingWork ?? '', code, finalize: false })
        } else if (request.code && taskInputCanonical(request.code) !== taskInputCanonical(record.report.code)) throw new DaemonError('E_CONFLICT', 'Original fixed code selection cannot change')
        await this.synchronize(record)
        if (!record.mutations.some(item => item.key === 'finalize' && item.receipt)) throw new DaemonError('E_CONFLICT', record.outputSync?.error ?? 'Confirmed outputs and actual code are required before handoff')
      } else await this.report(record, request)
    }
    return this.result(this.record(request.dispatchId))
  }
  private result(record: Record): NativeTaskExecutionResult {
    const native = acp.platformAcpSession(record.root, record.result.native.sessionId, record.request.dispatchId)
    if (native) {
      if (native.connectionGeneration !== record.result.native.connectionGeneration) throw new DaemonError('E_CONFLICT', 'Original native connection generation changed')
      record.result.native.backendSessionId = native.backendSessionId ?? null
      record.result.native.agentSessionId = native.agentSessionId ?? null
      record.result.native.modelId = native.currentModelId ?? null
      record.result.permissions = (native.pendingPermissions ?? []).filter(item => item.turnId === record.result.native.turnId && item.connectionGeneration === record.result.native.connectionGeneration)
        .map(item => ({ requestId: item.requestId, tool: item.toolCall?.title ?? null, expiresAt: item.expiresAt ?? null, options: item.options,
          ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
          ...(item.connectionGeneration === undefined ? {} : { connectionGeneration: item.connectionGeneration }),
          ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
          ...(item.reviewContext === undefined ? {} : { reviewContext: structuredClone(item.reviewContext) }) }))
    }
    Object.assign(record.result, this.projection(record))
    if (record.outputSync) record.result.outputSync = record.outputSync
    if (record.finishRequested !== undefined) record.result.finalized = record.mutations.some(item => item.key === 'finalize' && Boolean(item.receipt))
    // Never persist this capability: a new runtime rechecks old private evidence.
    return nativeTaskExecutionResultSchema.parse({ ...record.result, ...(record.failure ? { failure: record.failure } : {}),
      canRetry: !record.result.native.promptWritten && this.canRetry(record),
      canRestart: Boolean(record.result.native.outcome) && this.canRetry(record, 'finished') })
  }
  private canRetry(record: Record, mode: 'unsent' | 'finished' = 'unsent'): boolean {
    try {
      this.ports.assertOwner()
      const stored = recordSchema.parse(JSON.parse(readBounded(this.path(record.request.dispatchId), MAX_RECORD_BYTES)))
      if (taskInputCanonical(stored.request) !== taskInputCanonical(record.request)
        || taskInputCanonical(stored.nativeOwner) !== taskInputCanonical(record.nativeOwner)
        || stored.result.native.sessionId !== record.result.native.sessionId
        || stored.result.native.connectionGeneration !== record.result.native.connectionGeneration
        || stored.result.native.backendSessionId !== record.result.native.backendSessionId
        || stored.root !== record.root || taskInputCanonical(stored.grant) !== taskInputCanonical(record.grant)) return false
      for (const value of [record, stored]) {
        const { native } = value.result
        // Session creation can fail before the prompt path updates its prepared
        // delivery. The cleaned native intent below must still prove no send.
        const deliveryState = value.result.referenceDelivery?.state
        const created = value.admitted && value.nativeEntered && (mode === 'finished'
          ? deliveryState === 'written' : deliveryState === 'not-sent' || deliveryState === 'prepared')
        if (value.result.state !== 'stopped' || !value.result.cleanupConfirmed || !value.stopRequested || !value.stopCommandId
          || value.candidates.length || value.mutations.length
          || value.registration || value.report || value.finishRequested || value.outputSync || value.result.outputs.length
          || value.result.pendingCommands.length || value.result.permissions.length
          || value.result.manifest || value.result.checkpoint || value.nativeIntents.some(item => !['start', 'stop'].includes(item.request.operation))) return false
        if (mode === 'finished' ? !created || !native.turnId || !native.promptWritten || !native.outcome
          : Boolean(native.turnId || native.promptWritten || native.outcome)) return false
        if (!created && (value.admitted || value.nativeEntered || value.lease || value.context || value.result.context
          || value.result.referenceDelivery || native.backendSessionId || native.agentSessionId || native.promptDigest)) return false
        if (created) {
          const receipt = value.result.referenceDelivery
          if (!receipt || !value.context || !native.backendSessionId || !native.connectionGeneration) return false
          if (mode === 'finished' ? !receipt.native || receipt.native.sessionId !== native.sessionId
            || receipt.native.connectionGeneration !== native.connectionGeneration || receipt.native.turnId !== native.turnId
            : Boolean(receipt.native)) return false
          // Both recovery paths retain their original delivery evidence and
          // bind it to this dispatch's exact task/node/input.
          const binding = this.binding(value)
          if (teamTaskIdentity(receipt.scope.task) !== teamTaskIdentity(binding.request.task)
            || receipt.scope.epoch !== binding.input.epoch
            || taskInputCanonical({ executionId: receipt.scope.executionId, generation: receipt.scope.generation,
              nodeId: receipt.scope.nodeId, attempt: receipt.scope.attempt, inputDigest: receipt.scope.inputDigest }) !== taskInputCanonical(value.result.scope)) return false
        }
      }
      const binding = this.binding(record), native = record.result.native
      const workcopy = resolveWorkcopy(record.root)
      assertWorkcopyObservation(workcopy, binding.workcopy)
      const expected = binding.request.expected
      // A reopened GUI can legitimately start an already verified preparation.
      // Its durable native admission records that handoff; creator provenance
      // remains unchanged in both records.
      const executableKey = (executable: string): string => {
        const physical = realpathSync.native(executable)
        return process.platform === 'win32' ? physical.toLowerCase() : physical
      }
      const preparationOwner = sameOwner(binding.nativeOwner, record.nativeOwner)
        || record.admitted && record.nativeEntered && binding.nativeOwner.userId === record.nativeOwner.userId
          && executableKey(binding.nativeOwner.executable) === executableKey(record.nativeOwner.executable)
      if (binding.root !== record.root || !preparationOwner
        || taskInputCanonical(binding.grant) !== taskInputCanonical(record.grant)
        || binding.request.origin !== 'product' || binding.execution.ownership !== 'product-managed'
        || native.sessionId !== `product-${record.request.dispatchId}` || record.result.dispatchId !== record.request.dispatchId
        || record.result.preparationId !== binding.preparationId || binding.preparationId !== record.request.preparationId
        || record.executionKey !== hash(taskInputCanonical([teamTaskIdentity(binding.request.task), binding.request.pin.epoch,
          expected.executionId, expected.generation, expected.nodeId, expected.attempt]))
        || taskInputCanonical(record.result.scope) !== taskInputCanonical({ executionId: expected.executionId, generation: expected.generation,
          nodeId: expected.nodeId, attempt: expected.attempt, inputDigest: expected.inputDigest })) return false
      const intent = readTaskSessionIntent(this.ports.directory, record.root, native.sessionId,
        { engine: record.request.engine.agentId === 'pi' ? 'pi' : 'acp' })
      if (!intent || intent.phase !== 'cleaned'
        || intent.prompt !== (mode === 'finished' ? 'sent' : 'not-sent') || intent.generation !== native.connectionGeneration || intent.identityId !== workcopy.id
        || intent.host.userId !== record.nativeOwner.userId) return false
      const session = acp.platformAcpSession(record.root, native.sessionId, record.request.dispatchId)
      if (record.admitted && record.nativeEntered) {
        // A failed ensureSession never publishes completeTaskSessionIntent.
        // Its retained native session and canonical Job cleanup still identify
        // the exact entered process; no created-session receipt is invented.
        const failedCreation = mode === 'unsent' && record.failure?.phase === 'native-session'
          && record.result.referenceDelivery?.state === 'prepared' && !intent.session
        if (intent.settledOutcome !== 'cleaned' || intent.nativeBoundary !== 'entered'
          || !session || session.connectionGeneration !== native.connectionGeneration
          || session.backendSessionId !== native.backendSessionId || session.pendingPermissions?.length
          || resolveWorkcopy(session.cwd ?? session.projectRoot).id !== workcopy.id
          || (failedCreation ? !['closed', 'disconnected'].includes(session.status)
            : !intent.session || session.status !== 'closed'
              || intent.session.sessionId !== native.sessionId || intent.session.connectionGeneration !== native.connectionGeneration
              || intent.session.backendSessionId !== native.backendSessionId
              || resolveWorkcopy(intent.session.cwd).id !== workcopy.id)
          || (mode === 'finished' ? session.turnId && session.turnId !== native.turnId : session.turnId)) return false
      } else if (intent.settledOutcome !== 'not-created' || intent.nativeBoundary !== 'not-entered' || intent.session || session) return false
      const jobOwner = { kind: 'agent' as const, id: native.sessionId, generation: intent.generation,
        taskKey: `session:${native.sessionId}`, label: 'Product task execution' }
      if (acp.listOwnedAcpSessionFacts().some(session => resolveWorkcopy(session.cwd ?? session.projectRoot).id === workcopy.id)
        || this.ports.workcopies.facts(workcopy).length
        || (record.nativeEntered ? !isAcpJobOwnerCleaned(this.ports.directory, jobOwner)
          : hasAcpJobOwner(this.ports.directory, jobOwner))) return false
      return ![...this.records.values()].some(other => other !== record && resolveWorkcopy(other.root).id === workcopy.id
        && (!other.result.cleanupConfirmed || other.mutations.some(item => !item.receipt)))
    } catch { return false }
  }
  private projection(record: Record): Pick<NativeTaskExecutionResult, 'outputs' | 'pendingCommands' | 'context'> {
    return { outputs: record.candidates.map(({ outputId, bodyDigest, byteLength }) => ({ outputId, bodyDigest, byteLength })),
      pendingCommands: record.mutations.filter(item => !item.receipt).map(item => item.command.commandId), context: record.context }
  }
  private promptFailure(record: Record, failure: IpcFail): DaemonError {
    const code = failure.code === 'E_UPSTREAM' || failure.code === 'E_UNAUTHORIZED' || failure.code === 'E_TIMEOUT'
      || failure.code === 'E_NO_PROJECT' || failure.code === 'E_NOT_FOUND' ? 'E_UNKNOWN' : failure.code
    const admitted = record.result.native.turnId !== null
    const delivery = record.result.referenceDelivery
    const description = delivery?.state === 'written' ? 'was written; subsequent recording failed'
      : delivery?.state === 'not-sent' ? 'did not enter native send' : admitted ? 'write was not confirmed' : 'was not admitted'
    return Object.assign(new DaemonError(code, (`Original product prompt ${description} (${failure.code}): ${failure.error}`).slice(0, 400),
      delivery?.state === 'not-sent' ? 'not-admitted' : admitted ? 'unknown' : 'not-admitted'),
    { taskFailure: failure.taskFailure ?? nativeTaskFailure(failure, 'prompt') })
  }
  private async start(root: string, request: NativeTaskStart, authority: NativeTaskPreparationAuthority): Promise<void> {
    // Close the authorization/acceptance gap after the awaited preparation
    // checks. No accepted background work depends on this GUI connection.
    this.ports.assertOwner(); this.ports.assertCurrent(authority.grant); authority.assertProduct()
    if (this.records.has(request.dispatchId)) throw new DaemonError('E_UNKNOWN', 'Original launch cannot be repeated; reconcile it', 'unknown')
    if (this.records.size >= 2000) throw new DaemonError('E_BUSY', 'Native execution retention is full')
    const binding = this.ports.preparation.retained(request.preparationId), expected = binding.request.expected
    const executionKey = hash(taskInputCanonical([teamTaskIdentity(binding.request.task), binding.request.pin.epoch, expected.executionId, expected.generation, expected.nodeId, expected.attempt]))
    // Synchronous reservation precedes all configuration/source waits and spans
    // independent workcopies. A second UUID cannot duplicate one server attempt.
    if ([...this.records.values()].some(record => record.executionKey === executionKey && (!record.result.cleanupConfirmed || record.mutations.some(item => !item.receipt)))) throw new DaemonError('E_BUSY', 'Original server execution/node/attempt already has active or uncertain native work or shared writes')
    const record: Record = { version: 1, request: structuredClone(request), root, executionKey, grant: structuredClone(authority.grant), nativeOwner: structuredClone(authority.actor),
      result: { dispatchId: request.dispatchId, preparationId: request.preparationId, boundary: 'node-attempt', scope: { executionId: expected.executionId, generation: expected.generation,
        nodeId: expected.nodeId, attempt: expected.attempt, inputDigest: expected.inputDigest }, state: 'starting', native: { sessionId: `product-${request.dispatchId}`,
        connectionGeneration: null, backendSessionId: null, agentSessionId: null, agentId: request.engine.agentId, configurationDigest: null, adapterVersion: null, modelId: null,
        turnId: null, promptDigest: null, promptWritten: false, outcome: null }, outputs: [], manifest: null, checkpoint: null, context: null, cleanupConfirmed: false, pendingCommands: [], permissions: [] },
      admitted: false, nativeEntered: false, stopRequested: false, stopCommandId: null, commandIds: [request.dispatchId], nativeIntents: [{ commandId: request.dispatchId, request: structuredClone(request) }], lease: null, context: null,
      baselines: [], candidates: [], mutations: [], report: null }
    // Full original intent and UUID precede configuration discovery and native effects.
    this.records.set(request.dispatchId, record); this.save(record)
    const live: Live = {}; this.live.set(request.dispatchId, live)
    const accepted: NativeTaskPreparationAuthority = {
      actor: structuredClone(record.nativeOwner), grant: structuredClone(record.grant),
      assertProduct: () => {
        this.ports.assertOwner(); this.ports.assertCurrent(record.grant)
        if (this.closed || this.records.get(request.dispatchId) !== record || record.stopRequested || record.result.cleanupConfirmed)
          throw new DaemonError('E_CONFLICT', 'Original accepted task no longer admits preparation')
      }
    }
    live.start = this.launch(record, accepted, live).catch(error => {
      try {
        record.failure = nativeTaskFailure(error, error instanceof DesktopTeamError && error.preparationPhase ? error.preparationPhase : live.phase ?? 'configuration')
        this.ports.preparation.recordTaskStartFailure(binding, { dispatchId: request.dispatchId, sessionId: record.result.native.sessionId,
          connectionGeneration: record.result.native.connectionGeneration }, error, live.startBoundary ?? 'native-session')
      } finally { record.result.state = record.stopRequested ? 'stop-requested' : 'unknown'; this.save(record) }
      throw error
    })
    // The durable dispatch is the acknowledgement. Native preparation and send
    // remain owned by this record; Stop/shutdown join the same promise.
    void live.start.catch(() => { /* Failure is retained above; no prompt replay. */ })
  }
  private async launch(record: Record, authority: NativeTaskPreparationAuthority, live: Live): Promise<void> {
    const request = record.request
    live.phase = 'configuration'
    const plan = await acp.preparePlatformAcpLaunch(record.root, request.engine)
    if (request.expectedConfigurationDigest && request.expectedConfigurationDigest !== plan.digest) throw new DaemonError('E_CONFLICT', 'Prepared product engine configuration changed before native admission')
    if (record.stopRequested) throw new DaemonError('E_CONFLICT', 'Original native start was stopped before admission')
    live.launch = plan; record.result.native.configurationDigest = plan.digest
    live.phase = 'reservation'
    record.result.native.connectionGeneration = await acp.reservePlatformAcpSession(record.root, record.result.native.sessionId, request.engine.agentId)
    this.save(record)
    const hookIdentity = () => ({ dispatchId: request.dispatchId, sessionId: record.result.native.sessionId,
      connectionGeneration: record.result.native.connectionGeneration })
    live.phase = 'preparation-verification'
    await this.ports.preparation.execute(record.root, { operation: 'verify', preparationId: request.preparationId }, { ...authority,
      assertOperation: () => { if (record.stopRequested) throw new DaemonError('E_CONFLICT', 'Original native start was stopped before admission') }
    }, (binding, admission, releasePreparation) => {
      plan.assertCurrent()
      live.phase = 'handoff'
      if (record.stopRequested || binding.request.origin !== 'product' || binding.execution.ownership !== 'product-managed') throw new DaemonError('E_CONFLICT', 'Original product launch is no longer admitted')
      const version = request.engine.agentId === 'pi' ? PI_VERSION : BUILTINS[request.engine.agentId].version
      record.result.native.adapterVersion = version
      if (binding.execution.executor.engine !== request.engine.agentId || binding.execution.executor.adapterVersion !== version) throw new DaemonError('E_CONFLICT', 'Actual engine/adapter does not match the fixed server executor')
      const node = binding.input.definition.nodes.find(node => node.id === binding.execution.nodeId)
      if (!node || node.kind !== 'agent') throw new DaemonError('E_UNAVAILABLE', 'Product start requires the declared current Agent node')
      const role = binding.input.definition.roles.find(role => role.id === node.roleId)
      const required = [...node.requiredCapabilities, ...role?.requiredCapabilities ?? []]
      if (required.some(capability => capability !== (request.engine.agentId === 'pi' ? 'sdkContext' : 'embeddedContext'))) throw new DaemonError('E_UNAVAILABLE', 'Required native capability has no verified adapter evidence')
      for (const output of request.outputs) {
        const declared = node.outputs.find(item => item.id === output.outputId)
        if (!declared || !executionArtifactKindSchema.safeParse(declared.kind).success || output.source.kind === 'assistant' && ['source-patch', 'selected-file'].includes(declared.kind)) throw new DaemonError('E_UNAVAILABLE', 'Selected output requires a supported declared native artifact kind')
      }
      if (request.sharing && (teamTaskIdentity(request.sharing.task) !== teamTaskIdentity(binding.request.task)
        || new Set(request.sharing.outputIds).size !== request.sharing.outputIds.length
        || request.sharing.outputIds.some(id => !request.outputs.some(output => output.outputId === id)))) throw new DaemonError('E_DENIED', 'Output sharing differs from the original declared task selection')
      const database = request.databaseDelivery
      if (database) {
        const implementation = node.outputs.find(output => output.id === database.implementationOutputId)
        const report = node.outputs.find(output => output.id === database.reportOutputId)
        if (implementation?.kind !== 'implement' || report?.kind !== 'check-report'
          || database.implementationOutputId === database.reportOutputId
          || request.outputs.some(output => [database.implementationOutputId, database.reportOutputId].includes(output.outputId))) throw new DaemonError('E_INVALID_ARG', 'Database delivery requires separate declared document/check-report outputs')
      }
      if (node.outputs.some(output => output.required && !request.outputs.some(selected => selected.outputId === output.id)
        && ![database?.implementationOutputId, database?.reportOutputId].includes(output.id))) throw new DaemonError('E_INVALID_ARG', 'Select every required declared output before starting')
      releasePreparation()
      const generation = record.result.native.connectionGeneration
      if (!generation) throw new DaemonError('E_CONFLICT', 'Original native generation is unavailable')
      record.lease = this.ports.workcopies.acquire(record.root, { kind: 'writer', expected: { id: binding.workcopy.id, revision: binding.workcopy.revision },
        owner: { kind: 'agent', id: record.result.native.sessionId, generation, taskKey: `session:${record.result.native.sessionId}`, label: 'Product task execution' } })
      record.admitted = true; live.admission = admission
      record.result.scope = { executionId: binding.execution.executionId, generation: binding.execution.generation,
        nodeId: binding.execution.nodeId, attempt: binding.execution.attempt, inputDigest: binding.input.digest }
      this.save(record)
      admission.retainNative(() => !record.result.cleanupConfirmed)
    })
    const binding = this.binding(record)
    live.phase = 'context'
    const text = request.instruction + '\n\nSelected outputs to synchronize after execution (file paths are engineering-relative; assistant means the final reply). These selections do not replace the task requirements or forbid other files explicitly required by the task:\n'
      + JSON.stringify(request.outputs)
      + '\nFor an assistant-source output, the shared artifact contains your final reply text. Include the complete requested deliverable there: a report must include its actual commands, environment, and expected/actual results, not only a completion summary or links to local files. Progress messages are not the deliverable.'
    const platformInput = request.engine.agentId === 'pi' ? undefined : await preparePlatformExecutionInput({
      scope: { task: binding.input.task, epoch: binding.input.epoch, executionId: binding.execution.executionId,
        generation: binding.execution.generation, nodeId: binding.execution.nodeId, attempt: binding.execution.attempt, inputDigest: binding.input.digest },
      instruction: text,
      target: { sessionId: record.result.native.sessionId, connectionGeneration: z.string().parse(record.result.native.connectionGeneration),
        dispatchId: request.dispatchId, preparationId: request.preparationId },
      referenceSelectionIds: binding.input.resources.filter(item => item.selection.nodeId === binding.execution.nodeId
        && item.selection.source.kind === 'confirmed-document' && item.selection.required && item.selection.delivery === 'full').map(item => item.selection.id),
      readCurrent: () => this.ports.preparation.executionRules(binding, () => this.assertOwned(record))
    })
    const prepared = platformInput ? undefined : await this.ports.preparation.withExecution(binding, () => this.assertOwned(record), async (_transport, source) => prepareExecutionAgentRules({ executionSource: source, nodeId: binding.execution.nodeId }))
    record.context = platformInput?.control.manifest ?? prepared?.manifest ?? null
    if (platformInput) record.result.referenceDelivery = { ...platformInput.aggregate, state: 'prepared' }
    this.save(record)
    live.unobserve = observeWorkflowAcp({ scope: { projectRoot: record.root, sessionId: record.result.native.sessionId, connectionGeneration: record.result.native.connectionGeneration ?? undefined },
      event: event => this.event(record, event, live) })
    await this.ports.preparation.taskStartHook(binding, () => this.assertOwned(record), hookIdentity(), 'native-session')
    live.phase = 'native-session'
    record.nativeEntered = true; this.save(record)
    let creatingNative = true
    const created = await acp.newPlatformAcpSession(record.root, plan, { metadata: { dispatchId: request.dispatchId, preparationId: request.preparationId,
      taskIdentity: teamTaskIdentity(binding.request.task), configurationDigest: plan.digest }, lease: this.lease(record),
      assertActive: () => {
        this.assertOwned(record); plan.assertCurrent()
        if (creatingNative) this.ports.preparation.assertTaskStartHook(binding, () => this.assertOwned(record), hookIdentity(), 'native-session')
      }, assertCurrent: async () => {
        await this.assertUse(record)
        if (creatingNative) await this.ports.preparation.taskStartHook(binding, () => this.assertOwned(record), hookIdentity(), 'native-session')
      } }).finally(() => { creatingNative = false })
    if (!created.ok) throw new DaemonError('E_UNKNOWN', 'Original product native creation did not confirm readiness; inspect its retained owner', 'unknown')
    live.startBoundary = 'prompt'
    live.phase = 'prompt'
    record.result.native.backendSessionId = created.session.backendSessionId ?? null; record.result.native.agentSessionId = created.session.agentSessionId ?? null
    record.result.native.modelId = created.session.currentModelId ?? null
    this.save(record)
    this.assertOwned(record); await prepared?.assertCurrent()
    for (const selected of request.outputs) {
      let digest: string | null = null
      if (selected.source.kind === 'file') {
        try { digest = (await captureSelectedFile({ root: record.root, relativePath: selected.source.relativePath, assertOwned: () => this.assertOwned(record) })).bodyDigest }
        catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
      }
      record.baselines.push({ outputId: selected.outputId, digest })
    }
    this.save(record)
    record.result.native.promptDigest = hash(text); this.save(record)
    await this.ports.preparation.taskStartHook(binding, () => this.assertOwned(record), hookIdentity(), 'prompt')
    let sendingPrompt = true
    const prompt = await acp.promptAcpSession(record.root, record.result.native.sessionId, text,
      { expectedConnectionGeneration: record.result.native.connectionGeneration ?? undefined }, () => !record.stopRequested, 0,
      { materials: { text: '', files: [], sources: [], changed: [] }, ...(platformInput ? { platformInput,
          onPlatformDelivery: receipt => {
            const original = record.result.referenceDelivery
            if (!original || original.digest !== receipt.digest || receipt.native && (receipt.native.sessionId !== record.result.native.sessionId
              || receipt.native.turnId !== record.result.native.turnId || receipt.native.connectionGeneration !== record.result.native.connectionGeneration)) throw new Error('Original aggregate delivery identity changed')
            if (original.state === 'written' && receipt.state !== 'written') throw new Error('Observed native write cannot regress')
            // Keep observed write in memory even if the following disk write fails.
            record.result.referenceDelivery = receipt
            if (receipt.state === 'written') record.result.native.promptWritten = true
            this.save(record)
          } } : { executionContext: prepared }),
        assertActive: () => {
          this.assertOwned(record); plan.assertCurrent()
          if (sendingPrompt && !record.result.native.promptWritten) this.ports.preparation.assertTaskStartHook(binding, () => this.assertOwned(record), hookIdentity(), 'prompt')
        },
        onAdmitted: identity => { record.result.native.turnId = identity.turnId; record.result.state = 'running'; this.save(record) },
        onPromptWritten: identity => { if (identity.turnId !== record.result.native.turnId || identity.connectionGeneration !== record.result.native.connectionGeneration) throw new Error('Original prompt write identity changed'); record.result.native.promptWritten = true; this.save(record) } })
      .finally(() => { sendingPrompt = false })
    if (!prompt.ok) {
      const receipt = record.result.referenceDelivery
      if (receipt && ['prepared', 'admitted'].includes(receipt.state)) {
        record.result.referenceDelivery = transitionPlatformDelivery(receipt, { kind: 'not-entered' }); this.save(record)
      }
      throw this.promptFailure(record, prompt)
    }
    if (!record.result.native.promptWritten) throw new DaemonError('E_UNKNOWN', 'Original product prompt write was not confirmed; it will not be replayed', 'unknown')
  }
  private lease(record: Record): WorkcopyLease { if (!record.lease) throw new DaemonError('E_DENIED', 'Original native writer lease is unavailable'); return record.lease }
  private event(record: Record, event: TimelineEvent, live: Live): void {
    if (event.turnId !== record.result.native.turnId || event.connectionGeneration !== record.result.native.connectionGeneration || event.kind !== 'turn-done') return
    const result = z.object({ status: z.enum(['completed', 'failed', 'cancelled']), stopReason: z.string().optional() }).passthrough().safeParse(event.payload?.result)
    if (!result.success) { record.result.state = 'unknown'; this.save(record); return }
    record.result.native.outcome = result.data.status
    this.save(record)
    if (record.stopRequested || !record.result.native.promptWritten || result.data.status !== 'completed' || result.data.stopReason !== 'end_turn' || event.payload?.hostPolicyOutcome) {
      if (!record.stopRequested) record.result.state = 'failed'
      this.save(record); return
    }
    live.capture = this.capture(record).catch(error => {
      if (!record.stopRequested) { record.result.state = 'failed'; record.failure = nativeTaskFailure(error, 'output-capture') }
      this.save(record)
    })
    // Canonical cleanup joins local capture only. Network progress is independent.
    void live.capture.then(() => { if (record.candidates.length && record.request.sharing) return this.stop(record) }).catch(() => { /* Original cleanup remains available. */ })
  }
  private async capture(record: Record): Promise<void> {
    await this.assertUse(record)
    await acp.flushAcpHistory()
    const page = await acp.getAcpHistoryEvents(record.root, record.result.native.sessionId, { limit: 500 })
    if (!page.ok || page.startsMidTurn || page.historyPersistence.state !== 'saved') throw new DaemonError('E_UNKNOWN', 'Original native turn history was not completely saved', 'unknown')
    const events = replayConversationTextEvents(page.events).filter(event => event.turnId === record.result.native.turnId
      && event.connectionGeneration === record.result.native.connectionGeneration && event.kind === 'message' && event.payload?.role !== 'user' && ['acp', 'pi'].includes(event.source))
    const final = events.filter(event => event.payload?.meta && typeof event.payload.meta === 'object' && 'phase' in event.payload.meta && event.payload.meta.phase === 'final_answer')
    const lastMessageId = events.at(-1)?.payload?.messageId
    const reply = final.length ? final : typeof lastMessageId === 'string' && lastMessageId
      ? events.filter(event => event.payload?.messageId === lastMessageId) : events
    const assistant = reply.map(event => event.text).join('')
    const binding = this.binding(record)
    const candidates: Candidate[] = []
    for (const selected of record.request.outputs) {
      this.assertOwned(record)
      const captured = selected.source.kind === 'file'
        ? await captureSelectedFile({ root: record.root, relativePath: selected.source.relativePath, assertOwned: () => this.assertOwned(record) })
        : { text: assistant, bodyDigest: hash(assistant), byteLength: Buffer.byteLength(assistant, 'utf8') }
      const unchanged = selected.source.kind === 'file'
        && captured.bodyDigest === record.baselines.find(item => item.outputId === selected.outputId)?.digest
      const retainedCode = selected.source.kind === 'file' && binding.predecessor?.source.ready
        && binding.predecessor.source.application === 'applied'
        && Object.values(binding.request.targetPaths ?? {}).includes(selected.source.relativePath)
      // A report-only return can retain its verified predecessor code. Capture
      // the actual current bytes under this run; never reuse an old artifact as
      // a newly produced report or waive the predecessor application check.
      if (!captured.text.trim() || captured.byteLength > 1024 * 1024 || unchanged && !retainedCode) throw new DaemonError('E_CONFLICT', 'Selected output has no fresh successful native-turn bytes')
      const declared = binding.outputs.find(item => item.nodeId === binding.execution.nodeId && item.output.id === selected.outputId)
      const artifactKind = executionArtifactKindSchema.parse(declared?.output.kind)
      writeExclusiveAtomic(this.outputPath(record, selected.outputId, true), captured.text)
      candidates.push({ outputId: selected.outputId, bodyDigest: captured.bodyDigest, byteLength: captured.byteLength, artifactKind, capturedAt: Date.now() })
    }
    await this.assertUse(record)
    const facts = acp.listOwnedAcpSessionFacts().find(item => item.sessionId === record.result.native.sessionId)
    if (!facts || facts.backgroundWork || facts.unfinishedTools || facts.cleanupRequired || facts.turnActive || facts.settling) throw new DaemonError('E_UNKNOWN', 'Original native tools or turn settlement remain unfinished', 'unknown')
    record.candidates = candidates; record.result.state = 'idle'
    if (record.request.sharing) {
      record.registration = { outputIds: [...record.request.sharing.outputIds], remainingWork: '' }
      record.outputSync = { state: 'pending', attempts: 0, nextAttemptAt: Date.now(), error: null }
    }
    this.save(record)
    this.wake()
  }
  private async stop(record: Record): Promise<void> {
    if (!record.stopCommandId) {
      const stopCommandId = randomUUID()
      this.save({ ...record, stopCommandId }); record.stopCommandId = stopCommandId
    }
    if (record.result.cleanupConfirmed) return
    record.stopRequested = true; record.result.state = 'stop-requested'; this.save(record)
    const live = this.live.get(record.request.dispatchId)
    if (live?.stop) return live.stop
    const cleanup = (async () => {
      // Creation can return after Stop; join its exact alias, then canonical End.
      await live?.start?.catch(() => {})
      await live?.capture?.catch(() => {})
      if (record.result.cleanupConfirmed) return
      const native = acp.platformAcpSession(record.root, record.result.native.sessionId, record.request.dispatchId)
      const intent = readTaskSessionIntent(this.ports.directory, record.root, record.result.native.sessionId)
      if (native || record.nativeEntered || intent) {
        await acp.stopPlatformAcpSession(record.root, record.result.native.sessionId, record.request.dispatchId, record.request.engine.agentId === 'pi' ? 'pi' : 'acp')
      }
      if (acp.listOwnedAcpSessionFacts().some(item => item.sessionId === record.result.native.sessionId)) throw new DaemonError('E_UNKNOWN', 'Original native owner still retains work', 'unknown')
      if (record.lease) {
        const released = this.ports.workcopies.release({ token: record.lease.token, owner: record.lease.owner, outcome: 'cleanup-confirmed' })
        if (!released.released) throw new DaemonError('E_UNKNOWN', 'Original native lease cleanup was not confirmed', 'unknown')
        record.lease = null
      }
      record.result.cleanupConfirmed = true; record.result.state = 'stopped'; record.result.permissions = []
      this.save(record); live?.admission?.release(); live?.unobserve?.()
    })()
    if (live) live.stop = cleanup
    try { await cleanup }
    catch (error) { if (live) live.stop = undefined; record.result.state = 'unknown'; this.save(record); throw error }
  }
  private async reconcile(record: Record, retryOutputs = false): Promise<void> {
    const original = record.result.referenceDelivery
    if (original?.state === 'unknown' && original.native) {
      // A saved original promptStarted receipt may recover a failed T06 write.
      // Missing/partial history never proves non-send and never starts a turn.
      const page = await acp.getAcpHistoryEvents(record.root, record.result.native.sessionId, { limit: 500 })
      if (page.ok && page.historyPersistence.state === 'saved') {
        for (const event of page.events) {
          if (event.kind !== 'message' || event.payload?.role !== 'user' || event.sessionId !== original.native.sessionId
            || event.turnId !== original.native.turnId || event.connectionGeneration !== original.native.connectionGeneration) continue
          const parsed = platformReferenceDeliveryReceiptSchema.safeParse(event.payload.platformReferenceDelivery)
          if (!parsed.success || parsed.data.state !== 'written') continue
          const { state: _state, native: _native, ...expected } = original
          const { state: _written, native, ...actual } = parsed.data
          if (taskInputCanonical(expected) !== taskInputCanonical(actual) || taskInputCanonical(native) !== taskInputCanonical(original.native)) continue
          record.result.referenceDelivery = parsed.data; record.result.native.promptWritten = true
          break
        }
      }
    }
    const live = this.live.get(record.request.dispatchId)
    if (!live && !record.result.cleanupConfirmed) {
      // Read original intent only. No load/create, POST or guessed process exit.
      const intent = readTaskSessionIntent(this.ports.directory, record.root, record.result.native.sessionId)
      if (!record.admitted && !record.nativeEntered && (!intent || intent.nativeBoundary === 'not-entered')) {
        record.result.state = 'unknown'
      }
    }
    this.save(record)
    if (record.registration || record.report) {
      if (retryOutputs && record.outputSync) {
        record.outputSync.nextAttemptAt = Date.now()
        record.outputSync.attempts = 0
        this.save(record)
      }
      // Reconciliation never joins network writes; controls remain bounded.
      this.wake()
    }
  }
  private async mutate(record: Record, key: string, transport: TaskExecutionTransport, create: () => TeamExecutionCommand): Promise<z.infer<typeof teamExecutionReceiptSchema>> {
    let mutation = record.mutations.find(item => item.key === key)
    if (mutation) {
      if (mutation.receipt) return mutation.receipt
      const receipt = await transport.reconcile(mutation.command)
      if (receipt) { mutation.receipt = receipt; this.save(record); return receipt }
      // A successful original-receipt lookup established absence. The transport
      // rechecks current writer/share authority before the identical POST.
      const result = await transport.command(mutation.command)
      mutation.receipt = result.result; this.save(record); return result.result
    }
    mutation = { key, command: teamExecutionCommandSchema.parse(create()), receipt: null }
    this.save({ ...record, mutations: [...record.mutations, mutation] })
    record.mutations.push(mutation)
    const result = await transport.command(mutation.command)
    mutation.receipt = result.result; this.save(record)
    return result.result
  }
  private async report(record: Record, request: Report): Promise<void> {
    const live = this.live.get(record.request.dispatchId)
    await live?.capture
    if (record.result.native.outcome !== 'completed' || !record.result.native.promptWritten || !record.candidates.length) throw new DaemonError('E_CONFLICT', 'Only retained fresh outputs of the original completed native turn may be selected')
    if (new Set(request.outputIds).size !== request.outputIds.length || request.outputIds.some(id => !record.candidates.some(item => item.outputId === id))) throw new DaemonError('E_INVALID_ARG', 'Selected output does not belong to the original native turn')
    const registration = { outputIds: request.outputIds, remainingWork: request.remainingWork }
    if (record.registration && taskInputCanonical(record.registration) !== taskInputCanonical(registration)) throw new DaemonError('E_CONFLICT', 'Original output registration intent cannot change')
    const withoutFinish = (value: Report): unknown => ({ ...value, finalize: false })
    if (record.report && taskInputCanonical(withoutFinish(record.report)) !== taskInputCanonical(withoutFinish(request))) throw new DaemonError('E_CONFLICT', 'Original delivery intent cannot change')
    if (!record.registration) { record.registration = registration; this.save(record) }
    await this.synchronize(record)
    const databaseArtifactsConfirmed = record.request.databaseDelivery && request.outputIds.every(id => record.mutations.some(item =>
      item.key === `artifact:${id}` && item.command.kind === 'save-artifact' && item.receipt?.version && item.receipt.disposition === 'confirmed'))
    if (!record.result.manifest && !databaseArtifactsConfirmed) throw new DaemonError('E_UNKNOWN', 'Original outputs are not yet confirmed; code selection has not been fixed', 'unknown')
    if (!record.report) {
      const source = this.codeSource(record, request), binding = this.binding(record)
      if (source.kind === 'none' && this.requiredCode(record)) throw new DaemonError('E_CONFLICT', 'Actual code is required; no-code cannot satisfy this task')
      if (source.kind === 'selected-files') {
        if (new Set(request.code.kind === 'selected-files' ? request.code.outputIds : []).size !== source.files.length
          || request.code.kind !== 'selected-files' || request.code.outputIds.some(id => !record.candidates.some(candidate => candidate.outputId === id
            && candidate.artifactKind === 'selected-file' && record.request.outputs.some(output => output.outputId === id && output.source.kind === 'file')))) throw new DaemonError('E_CONFLICT', 'Code must identify the original captured engineering files')
        // captureSelectedFile already verified these exact source bytes under the
        // native writer. This is historical source evidence, not receiver application.
        record.codeObservation = { verification: 'device-reported', observedAt: Math.max(...record.candidates.map(item => item.capturedAt)), availability: 'available', sourceDigest: hash(taskInputCanonical(source)) }
      } else if (source.kind !== 'none') {
        const guard = (): void => { this.ports.assertOwner(); this.ports.assertCurrent(record.grant) }
        const observed = await this.ports.preparation.withExecution(binding, guard, async (transport, _input, resource) => {
          if (source.repositoryId !== resource.resource?.source.repositoryId) throw new DaemonError('E_CONFLICT', 'Selected code belongs to another repository')
          return verifyHandoffSource({ root: record.root, source, role: 'source', requiredCode: this.requiredCode(record),
            expectedWorkcopy: binding.workcopy, assertOwned: guard, readArtifact: async ref => {
              const value = await transport.artifact(ref); return { text: value.text, bodyDigest: value.artifact.bodyDigest }
            } })
        })
        if (!observed.ready) throw new DaemonError('E_CONFLICT', 'Selected actual code is not ready')
        record.codeObservation = { verification: 'device-reported', observedAt: observed.observedAt, availability: 'available', sourceDigest: observed.sourceDigest }
      } else record.codeObservation = null
      // Validate code before freezing it; an invalid guess must not poison recovery.
      record.report = { ...structuredClone(request), finalize: false }
      this.save(record)
    }
    if (request.finalize) { record.finishRequested = true; this.save(record) }
    await this.synchronize(record)
    if (record.outputSync?.state !== 'confirmed') throw new DaemonError('E_UNKNOWN', record.outputSync?.error ?? 'Original registration remains pending', 'unknown')
  }
  private requiredCode(record: Record): boolean {
    const binding = this.binding(record)
    return Boolean(binding.resourceRevision) || binding.outputs.some(item => item.nodeId === binding.execution.nodeId && item.output.required && ['source-patch', 'selected-file'].includes(item.output.kind))
  }
  private codeSource(record: Record, request: Report): ExecutionCodeSource {
    const ref = (id: string): ExecutionArtifactRef => {
      const mutation = record.mutations.find(item => item.key === `artifact:${id}`)
      if (mutation?.command.kind !== 'save-artifact' || !mutation.receipt?.version || mutation.receipt.disposition !== 'confirmed') throw new DaemonError('E_CONFLICT', 'Code must use a selected confirmed artifact')
      return { kind: 'confirmed-artifact', executionId: this.binding(record).execution.executionId, artifactId: mutation.command.artifactId, versionId: mutation.receipt.version.versionId, bodyDigest: mutation.command.expectedDigest }
    }
    const code = request.code
    return code.kind === 'selected-files' ? { kind: 'selected-files', files: code.outputIds.map(ref) }
      : code.kind === 'git-patch' ? { kind: 'git-patch', repositoryId: code.repositoryId, base: code.base, patch: ref(code.outputId) } : executionCodeSourceSchema.parse(code)
  }
  private async register(record: Record): Promise<void> {
    const request = record.report
    const registration = record.registration ?? request
    if (!registration || !record.candidates.length || record.result.native.outcome !== 'completed' || !record.result.native.promptWritten) return
    const binding = this.binding(record), expected = binding.request.expected, pin = binding.request.pin
    const commandEnvelope = () => ({ contractVersion: 2 as const, commandId: randomUUID(), task: binding.request.task, expectedEpoch: pin.epoch,
      expectedActorId: pin.actorId, expectedDeviceId: pin.deviceId, expectedGeneration: expected.generation,
      expectedExecutionId: expected.executionId })
    const envelope = () => ({ ...commandEnvelope(), expectedNodeId: expected.nodeId, expectedAttempt: expected.attempt })
    await this.ports.preparation.withCapturedOutputs(binding, async transport => {
      const retainedDelivery = record.mutations.find(item => item.key === 'delivery')
      const retainedCheckpoint = record.mutations.find(item => item.key === 'checkpoint')
      if (retainedDelivery?.command.kind === 'seal-delivery' && retainedDelivery.receipt?.version && retainedCheckpoint?.command.kind === 'checkpoint') {
        // The original checkpoint already fixes verified code and database
        // evidence. Receipt recovery must not repeat native reads after cleanup.
        const checkpoint = await this.mutate(record, 'checkpoint', transport, () => retainedCheckpoint.command)
        if (!checkpoint.version) throw new DaemonError('E_UNKNOWN', 'Original checkpoint receipt has no fixed version', 'unknown')
        record.result.manifest = retainedDelivery.receipt.version
        record.result.checkpoint = checkpoint.version
        this.save(record); return
      }
      const entries: ExecutionDeliveryManifest['entries'] = []
      for (const id of registration.outputIds) {
        const candidate = record.candidates.find(item => item.outputId === id)
        if (!candidate) throw new DaemonError('E_CONFLICT', 'Selected native output is unavailable')
        const text = readBounded(this.outputPath(record, id), 1024 * 1024)
        if (hash(text) !== candidate.bodyDigest || Buffer.byteLength(text, 'utf8') !== candidate.byteLength) throw new DaemonError('E_CONFLICT', 'Retained native output bytes changed')
        const receipt = await this.mutate(record, `artifact:${id}`, transport, () => ({ ...envelope(), kind: 'save-artifact', artifactId: randomUUID(), previousVersionId: null,
          artifactKind: candidate.artifactKind, title: id, text, expectedDigest: candidate.bodyDigest, disposition: 'confirmed' }))
        const mutation = record.mutations.find(item => item.key === `artifact:${id}`)?.command
        if (!receipt.version || receipt.disposition !== 'confirmed' || mutation?.kind !== 'save-artifact') throw new DaemonError('E_CONFLICT', 'Native output was not confirmed by the service')
        entries.push({ outputId: id, ref: { kind: 'confirmed-artifact', executionId: expected.executionId, artifactId: mutation.artifactId, versionId: receipt.version.versionId, bodyDigest: candidate.bodyDigest } })
      }
      const source = request ? this.codeSource(record, request) : null
      const database = record.request.databaseDelivery
      if (database) {
        if (!source) {
          record.outputSync = { state: 'needs-code', attempts: record.outputSync?.attempts ?? 0, nextAttemptAt: null, error: '请补齐实际代码来源后交给测试。' }
          this.save(record); return
        }
        if (source.kind !== 'selected-files' && source.kind !== 'none') throw new DaemonError('E_UNAVAILABLE', 'Database delivery v1 requires selected SQL artifacts')
        const files = source.kind === 'none' ? [] : source.files.map(selected => {
          const entry = entries.find(item => item.ref.kind === 'confirmed-artifact' && item.ref.versionId === selected.versionId)
          const output = record.request.outputs.find(item => item.outputId === entry?.outputId)
          if (output?.source.kind !== 'file') throw new DaemonError('E_CONFLICT', 'Database SQL needs its original engineering-relative selection')
          return { path: output.source.relativePath, ref: selected }
        })
        const material = binding.resources.find(item => item.resource.selection.id === database.implementationSelectionId)
        if (!material || material.resource.selection.source.kind !== 'confirmed-document') throw new DaemonError('E_CONFLICT', 'Original implementation document selection is unavailable')
        const capture = await confirmDatabaseDelivery({ directory: join(realpathSync.native(this.ports.directory), 'native-task-preparations'),
          binding, transport, request: { operation: 'database-delivery', preparationId: binding.preparationId, commandId: database.commandId,
            artifactId: database.artifactId, rule: database.rule, implementationSelectionId: database.implementationSelectionId, ticket: database.ticket, files },
          assertPrepared: () => this.assertOwned(record) })
        entries.push({ outputId: database.implementationOutputId, ref: { kind: 'confirmed-document', documentId: material.resource.selection.source.documentId,
          versionId: material.resource.selection.source.versionId, bodyDigest: material.resource.bodyDigest } }, { outputId: database.reportOutputId, ref: capture.ref })
      }
      const sealed = await this.mutate(record, 'delivery', transport, () => ({ ...envelope(), kind: 'seal-delivery', previous: binding.execution.deliveries?.at(-1) ? this.version(binding.execution.deliveries.at(-1)) : null, entries }))
      if (!sealed.version) throw new DaemonError('E_UNKNOWN', 'Original delivery receipt has no fixed version', 'unknown')
      record.result.manifest = sealed.version; this.save(record)
      if (!source || !request) {
        record.outputSync = { state: 'needs-code', attempts: record.outputSync?.attempts ?? 0, nextAttemptAt: null, error: '请补齐实际代码来源后交给测试。' }
        this.save(record); return
      }
      if (source.kind === 'none' && this.requiredCode(record)) throw new DaemonError('E_CONFLICT', 'Required actual code is missing')
      // A retained checkpoint command already fixes its verified source and
      // observation. Recover its original receipt without renewing native use.
      // Legacy reports without that command still require fresh source evidence.
      if (record.codeObservation === undefined && !record.mutations.some(item => item.key === 'checkpoint')) {
        const targets: { [versionId: string]: string } = Object.create(null)
        for (const entry of entries) { const output = record.request.outputs.find(item => item.outputId === entry.outputId); if (entry.ref.kind === 'confirmed-artifact' && output?.source.kind === 'file') targets[entry.ref.versionId] = output.source.relativePath }
        const guard = (): void => { this.ports.assertOwner(); this.ports.assertCurrent(record.grant) }
        const observed = await this.ports.preparation.withExecution(binding, guard, async () => verifyHandoffSource({ root: record.root, source, role: 'source', requiredCode: this.requiredCode(record), expectedWorkcopy: binding.workcopy, targetPaths: targets,
          assertOwned: guard, readArtifact: async ref => { const value = await transport.artifact(ref); return { text: value.text, bodyDigest: value.artifact.bodyDigest } } }))
        if (!observed.ready) throw new DaemonError('E_CONFLICT', 'Original actual code is not ready')
        record.codeObservation = source.kind === 'none' ? null : { verification: 'device-reported', observedAt: observed.observedAt, availability: 'available', sourceDigest: observed.sourceDigest }
        this.save(record)
      }
      const checkpoint = await this.mutate(record, 'checkpoint', transport, () => ({ ...envelope(), kind: 'checkpoint', previous: binding.execution.checkpoints?.at(-1) ? this.version(binding.execution.checkpoints.at(-1)) : null,
        manifest: sealed.version ?? { versionId: '', digest: '' }, remainingWork: request.remainingWork, source,
        observation: record.codeObservation ?? null }))
      if (!checkpoint.version) throw new DaemonError('E_UNKNOWN', 'Original checkpoint receipt has no fixed version', 'unknown')
      record.result.checkpoint = checkpoint.version; this.save(record)
    })
    if (record.finishRequested || request?.finalize) {
      if (binding.input.definition.nodes.length !== 1 || binding.input.definition.nodes[0].kind !== 'agent') throw new DaemonError('E_UNAVAILABLE', 'Current-node dispatch cannot finalize unexecuted workflow nodes or gates')
      await this.stop(record)
      await this.ports.preparation.withCapturedOutputs(binding, async transport => {
        const delivery = record.mutations.find(item => item.key === 'delivery')?.command
        if (delivery?.kind !== 'seal-delivery' || !record.result.manifest || !record.result.checkpoint) throw new DaemonError('E_CONFLICT', 'Fixed delivery is unavailable')
        await this.mutate(record, 'finalize', transport, () => ({ ...commandEnvelope(), kind: 'finalize', finalization: { outcome: 'completed', evidenceRef: record.request.dispatchId,
          outputs: delivery.entries.map(item => item.ref), manifest: record.result.manifest ?? undefined, checkpoint: record.result.checkpoint ?? undefined } }))
      })
    }
  }
  private synchronize(record: Record): Promise<void> {
    const existing = this.syncing.get(record.request.dispatchId)
    if (existing) return existing
    const work = this.register(record).then(() => {
      if (record.result.checkpoint) record.outputSync = { state: 'confirmed', attempts: 0, nextAttemptAt: null, error: null }
      this.save(record)
    }).catch(error => {
      const attempts = (record.outputSync?.attempts ?? 0) + 1
      const code: unknown = error && typeof error === 'object' && 'code' in error ? error.code : null
      const denied = ['E_DENIED', 'FORBIDDEN', 'UNAUTHORIZED', 'DEVICE_REVOKED', 'ACCOUNT_DISABLED', 'AUTHENTICATION_REQUIRED', 'CREDENTIAL_UNAVAILABLE', 'BINDING_CHANGED', 'EXECUTION_FORBIDDEN'].includes(String(code))
      const terminal = denied || ['E_CONFLICT', 'E_INVALID_ARG', 'E_UNAVAILABLE', 'EXECUTION_GENERATION_CONFLICT', 'EXECUTION_PRODUCER_CONFLICT', 'EXECUTION_INPUT_CONFLICT'].includes(String(code))
      record.outputSync = { state: denied ? 'denied' : record.mutations.some(item => !item.receipt) ? 'unknown' : 'failed',
        attempts, nextAttemptAt: !terminal && attempts < 6 ? Date.now() + Math.min(60_000, 1000 * 2 ** attempts) : null,
        error: (error instanceof Error ? error.message : 'Original output registration remains unknown').slice(0, 500) }
      this.save(record)
    }).finally(() => { this.syncing.delete(record.request.dispatchId); this.wake() })
    this.syncing.set(record.request.dispatchId, work)
    return work
  }
  /** Existing Daemon lifecycle calls this on startup; no native prompt is replayed. */
  startBackground(): void { this.wake() }
  private wake(): void {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.pump().catch(() => { /* Retained intents survive storage/owner failure. */ }).finally(() => {
        if ([...this.records.values()].some(record => record.outputSync?.nextAttemptAt !== null && record.outputSync?.nextAttemptAt !== undefined)) this.wake()
      })
    }, 1000)
    this.timer.unref()
  }
  /** Bounded per-owner recovery, also usable by controlled native acceptance ports. */
  async pump(): Promise<void> {
    if (this.closed) return
    this.ports.assertOwner()
    const pending = [...this.records.values()].filter(record => (record.registration || record.report)
      && (!record.outputSync || record.outputSync.nextAttemptAt !== null && record.outputSync.nextAttemptAt <= Date.now()))
    await Promise.allSettled(pending.slice(0, 4).map(record => this.synchronize(record)))
  }
  private version(value: { versionId: string; digest: string } | undefined): { versionId: string; digest: string } | null { return value ? { versionId: value.versionId, digest: value.digest } : null }
  busy(): boolean { return this.syncing.size > 0 || [...this.records.values()].some(record => !record.result.cleanupConfirmed || record.outputSync?.nextAttemptAt != null) }
  ownsWorkspace(root: string): boolean {
    let identity: ReturnType<typeof resolveWorkcopy> | undefined
    try { identity = resolveWorkcopy(root) } catch { /* Keep original lexical ownership if the directory is gone. */ }
    return [...this.records.values()].some(record => !record.result.cleanupConfirmed && (record.root === root || identity && record.lease?.identity.id === identity.id))
  }
  async shutdown(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const record of this.records.values()) if (!record.result.cleanupConfirmed) await this.stop(record)
  }
}
