/** Clean-room managed stage adapter. No native process/model loop or scheduler is created here. */
import { createHash, randomUUID } from 'crypto'
import { z } from 'zod'
import { isAbsolute } from 'path'
import {
  canonicalWorkflowJson, driverDispatchSchema, driverOperationRefSchema, contextReceiptSchema,
  type DriverDispatch, type DriverOperationRef, type DriverAcknowledgement, type DriverStopResult,
  type DriverReconciliation, type WorkflowDriverPort, type ExecutionEvent, type WorkflowJson,
  type VersionedAssetRef, type ExecutorBinding, type MaterialVersion, type WorkflowWriteAcknowledgement
} from '../../../shared/workflow'
import type { TimelineEvent } from '../../../shared/types'
import type { WorkflowControlService } from '../workflow-control/service'
import { WorkflowMaterialStore } from './materials'
import { WORKFLOW_REFERENCE_PREFIX, type PreparedWorkflowContext } from './context'
import { WorkflowRuntimeError, type WorkflowAcpPort, type WorkflowAcpTurnIdentity, type StoredWorkflowMaterial } from './types'
import { bindNativeTrellisTask, type NativeTaskBindingInput } from './native-task'

type ControlPort = Pick<WorkflowControlService, 'getOperation' | 'claimOperation' | 'settleOperation' | 'reconcileOperation' | 'append' | 'recordStep' | 'renewWorkspace'>
export type WorkflowStagePlan = {
  projectRoot: string; taskDir: string; context: PreparedWorkflowContext;
  executor: { agentId: string; profileId?: string; verified: ExecutorBinding };
  output: {
    contract: VersionedAssetRef; files: Array<{ relativePath: string; kind: MaterialVersion['kind']; required: boolean }>;
    maxRepairTurns: number; validateText?: (text: string) => { ok: boolean; reason?: string };
    validateMaterial?: (material: StoredWorkflowMaterial) => { ok: boolean; reason?: string }
  };
  nativeTask?: Pick<NativeTaskBindingInput, 'platform' | 'pythonExecutable' | 'allowBinding'>;
  assertCurrent: () => void
  /** Recheck async source authorization immediately before each native prompt. */
  authorizeCurrent?: () => Promise<void>
}
export type StageResult = {
  operationId: string; status: 'passed' | 'failed' | 'cancelled' | 'outcome-unknown';
  sessionId: string | null; turnId: string | null; outputs: Array<{ ref: string; material: MaterialVersion }>;
  historySeq: number | null; historyCommitted: boolean; reason: string | null
}
export type WorkflowStageDriverOptions = {
  acp: WorkflowAcpPort; control: ControlPort; materials: WorkflowMaterialStore;
  resolve: (request: DriverDispatch) => Promise<WorkflowStagePlan>;
  startupTimeoutMs?: number; turnTimeoutMs?: number; maxOutputChars?: number
}
type LiveStage = {
  request: DriverDispatch; signature: string; acknowledgement: DriverAcknowledgement;
  sessionId: string | null; projectRoot: string | null; generation: string | null; turnId: string | null;
  admitted: boolean; written: boolean; stopRequested: boolean; stopConfirmed: boolean; creationInFlight: boolean; terminal?: TimelineEvent;
  finalizing: boolean;
  shutdown?: Promise<{ stopped: boolean; cancellationAcknowledged: boolean }>;
  message: string; messageId: string | null; outputs: StageResult['outputs'];
  queue: Promise<void>; reportError: Error | null; historySeq: number | null;
  historyCommitted: boolean; queuedEvents: number; settled: boolean;
  promise?: Promise<StageResult>; unsubscribe?: () => void
}
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const plain = (value: unknown): WorkflowJson => JSON.parse(JSON.stringify(value)) as WorkflowJson
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One accepted control outbox identity authorizes at most one initial native dispatch. */
export class AcpxWorkflowDriver implements WorkflowDriverPort {
  private readonly stages = new Map<string, LiveStage>()
  private readonly sessions = new Map<string, { root: string; sessionId: string; generation: string; lastUsed: number }>()
  private readonly epoch = randomUUID()
  private sequence = 0
  constructor(private readonly options: WorkflowStageDriverOptions) {}

  async dispatch(raw: DriverDispatch): Promise<DriverAcknowledgement> {
    const request = driverDispatchSchema.parse(raw)
    const signature = canonicalWorkflowJson(request)
    const existing = this.stages.get(request.operationId)
    if (existing) {
      if (existing.signature !== signature) return { operationId: request.operationId, status: 'rejected', sessionId: null, turnId: null, evidenceRefs: ['dispatch-payload-conflict'] }
      return { ...existing.acknowledgement }
    }
    if (this.stages.size >= 128) {
      const retired = [...this.stages].find(([, candidate]) => candidate.settled)
      if (retired) this.stages.delete(retired[0])
      else return { operationId: request.operationId, status: 'rejected', sessionId: null, turnId: null, evidenceRefs: ['managed-stage-capacity'] }
    }
    const stage: LiveStage = { request, signature, acknowledgement: { operationId: request.operationId, status: 'outcome-unknown', sessionId: null, turnId: null, evidenceRefs: [] }, sessionId: null, projectRoot: null, generation: null, turnId: null,
      admitted: false, written: false, stopRequested: false, stopConfirmed: false, creationInFlight: false, finalizing: false, message: '', messageId: null, outputs: [], queue: Promise.resolve(), reportError: null, historySeq: null, historyCommitted: false, queuedEvents: 0, settled: false }
    this.stages.set(request.operationId, stage)
    // The completion is separate from the dispatch acknowledgement. Persisted
    // intent is claimed before any native session creation or prompt write.
    const dispatchReady = this.execute(stage)
    stage.promise = dispatchReady
    void dispatchReady.catch(() => {})
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 35_000)
    while (stage.acknowledgement.evidenceRefs.length === 0 && Date.now() < deadline) await delay(10)
    return { ...stage.acknowledgement }
  }

  async result(operationId: string): Promise<StageResult | null> { return this.stages.get(operationId)?.promise ?? null }

  async requestStop(raw: DriverOperationRef): Promise<DriverStopResult> {
    const request = driverOperationRefSchema.parse(raw)
    const stage = this.stages.get(request.operationId)
    if (!stage || !this.sameOwner(stage, request)) return { operationId: request.operationId, status: 'rejected', evidenceRefs: ['operation-owner-run-or-active-stage-mismatch'] }
    if (stage.finalizing) return { operationId: request.operationId, status: 'rejected', evidenceRefs: ['already-settling'] }
    if (stage.settled) return { operationId: request.operationId, status: 'rejected', evidenceRefs: ['operation-owner-run-or-active-stage-mismatch'] }
    stage.stopRequested = true
    if (!stage.sessionId) {
      if (stage.creationInFlight) return { operationId: request.operationId, status: 'unconfirmed', evidenceRefs: ['native-session-admission-in-flight'] }
      stage.stopConfirmed = true
      return { operationId: request.operationId, status: 'stopped', evidenceRefs: ['stop-before-native-session'] }
    }
    if (!stage.projectRoot) return { operationId: request.operationId, status: 'unconfirmed', evidenceRefs: ['native-session-root-unavailable'] }
    const { stopped, cancellationAcknowledged } = await this.stopNative(stage)
    await this.report(stage, 'workflow.driver-stop', { stopped, cancellationAcknowledged })
    return { operationId: request.operationId, status: stopped ? 'stopped' : 'unconfirmed', evidenceRefs: [stopped ? 'facade-canonical-shutdown' : 'facade-shutdown-unconfirmed'] }
  }

  async reconcile(raw: DriverOperationRef): Promise<DriverReconciliation> {
    const request = driverOperationRefSchema.parse(raw)
    const stage = this.stages.get(request.operationId)
    if (stage && !this.sameOwner(stage, request)) return { operationId: request.operationId, status: 'conflict', evidenceRefs: ['operation-owner-or-run-mismatch'] }
    const operation = await this.options.control.getOperation(request.scope, request.operationId)
    if (!operation || operation.operation.run.runId !== request.run.runId || operation.operation.run.revision !== request.run.revision) return { operationId: request.operationId, status: 'conflict', evidenceRefs: ['operation-scope-or-run-mismatch'] }
    if (operation.operation.state === 'confirmed' || operation.operation.state === 'failed') return { operationId: request.operationId, status: 'confirmed', evidenceRefs: operation.evidenceRefs }
    // Native IDs/receipts remain in durable control events. Absence of a live
    // stage cannot authorize replay or a new native session after app restart.
    return { operationId: request.operationId, status: 'unresolved', evidenceRefs: operation.evidenceRefs.length ? operation.evidenceRefs : ['native-outcome-not-yet-reconciled'] }
  }

  private sameOwner(stage: LiveStage, request: DriverOperationRef): boolean {
    return canonicalWorkflowJson(stage.request.manifest.scope) === canonicalWorkflowJson(request.scope) && canonicalWorkflowJson(stage.request.manifest.run) === canonicalWorkflowJson(request.run)
      && stage.request.owner.ownerId === request.owner.ownerId && stage.request.owner.fencingToken === request.owner.fencingToken
  }

  private stopNative(stage: LiveStage): Promise<{ stopped: boolean; cancellationAcknowledged: boolean }> {
    if (stage.shutdown) return stage.shutdown
    const { projectRoot: root, sessionId, generation } = stage
    // Do not cache a missing identity: a late in-flight create still needs its
    // real native session shut down before cancellation can be confirmed.
    if (!root || !sessionId || !generation) return Promise.resolve({ stopped: false, cancellationAcknowledged: false })
    stage.shutdown = Promise.resolve().then(async () => {
      const result = await this.options.acp.stop(root, sessionId, generation).catch(() => ({ stopped: false, cancellationAcknowledged: false }))
      stage.stopConfirmed = result.stopped
      return result
    })
    return stage.shutdown
  }

  private async execute(stage: LiveStage): Promise<StageResult> {
    let plan: WorkflowStagePlan | undefined
    let claimed = false
    let leaseTimer: ReturnType<typeof setInterval> | undefined
    try {
      const request = stage.request
      plan = await this.options.resolve(request)
      this.validatePlan(request, plan)
      stage.projectRoot = plan.projectRoot
      plan.assertCurrent()
      const persisted = await this.options.control.getOperation(request.manifest.scope, request.operationId)
      if (!persisted || persisted.operation.run.runId !== request.manifest.run.runId || persisted.operation.run.revision !== request.manifest.run.revision) throw new WorkflowRuntimeError('INVALID_INPUT', 'Durable dispatch intent does not match this run')
      if (persisted.operation.purpose && persisted.operation.purpose !== 'execute-step') throw new WorkflowRuntimeError('INVALID_INPUT', 'Stop/reconcile outbox intent cannot start a new native agent step')
      if (persisted.operation.state !== 'pending') throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'A prior dispatch exists and must be reconciled before any new native action')
      await this.options.control.claimOperation({ scope: request.manifest.scope, owner: request.owner, operationId: request.operationId })
      claimed = true
      let renewing = false
      leaseTimer = setInterval(() => {
        if (renewing) return
        renewing = true
        void this.options.control.renewWorkspace(request.manifest.scope, request.owner, 30_000).catch((error: unknown) => {
          stage.reportError = error instanceof Error ? error : new Error('Workspace lease acknowledgement unavailable')
          stage.stopRequested = true
        }).finally(() => { renewing = false })
      }, 10_000)
      leaseTimer.unref()
      await this.report(stage, 'workflow.driver-dispatching', { executorBindingId: request.executorBindingId, inputFingerprint: request.manifest.inputFingerprint, nativeChildren: 'unobserved' })
      await this.receipts(stage, plan.context, 'prepared')
      await this.receipts(stage, plan.context, 'assembled')
      await this.report(stage, 'workflow.additional-inputs', { state: plan.context.additionalInputs, knowledge: 'native-scoped-tools', nativeInstructions: 'engine-owned', automaticResultReuse: false })
      if (stage.stopRequested) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Stage stop was requested before native session preparation')
      const key = canonicalWorkflowJson({ scope: request.manifest.scope, executor: request.node.executor })
      const reuse = this.sessions.get(key)
      let session = reuse ? await this.options.acp.get(plan.projectRoot, reuse.sessionId) : null
      if (!session?.ok || session.session.status !== 'ready' || session.session.cleanupRequired || session.session.connectionGeneration !== reuse?.generation) {
        await this.retireIdleSession()
        if (stage.stopRequested) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Stage was stopped before native session admission')
        stage.creationInFlight = true
        let created: Awaited<ReturnType<WorkflowAcpPort['create']>>
        try { created = await this.options.acp.create(plan.projectRoot, { agentId: plan.executor.agentId, profileId: plan.executor.profileId, taskDir: plan.taskDir }) }
        finally { stage.creationInFlight = false }
        if (!created.ok) throw new WorkflowRuntimeError('EXECUTOR_UNAVAILABLE', created.error)
        stage.sessionId = created.sessionId
        stage.generation = created.connectionGeneration
        session = await this.readySession(plan, stage)
        if (!session.ok) throw new WorkflowRuntimeError('EXECUTOR_UNAVAILABLE', session.error)
        this.sessions.set(key, { root: plan.projectRoot, sessionId: created.sessionId, generation: created.connectionGeneration, lastUsed: Date.now() })
      } else if (reuse) {
        stage.sessionId = reuse.sessionId
        stage.generation = reuse.generation
        reuse.lastUsed = Date.now()
      }
      if (!stage.sessionId || !stage.generation || !session.ok || session.session.connectionGeneration !== stage.generation) throw new WorkflowRuntimeError('EXECUTOR_UNAVAILABLE', 'No verified ready ACP session identity')
      if (session.session.taskDir !== plan.taskDir || session.session.agentId !== plan.executor.agentId) throw new WorkflowRuntimeError('SCOPE_CHANGED', 'Native session does not match the task and selected engine')
      const native = session.session
      await this.report(stage, 'workflow.native-provenance', {
        executorBindingId: request.executorBindingId, engineVersion: plan.executor.verified.engineVersion,
        adapterVersion: plan.executor.verified.adapterVersion,
        runtimeConfigurationDigest: native.runtimeSnapshot ? hash(canonicalWorkflowJson(plain(native.runtimeSnapshot))) : null,
        profileConfigurationDigest: native.profileSnapshot ? hash(canonicalWorkflowJson(plain(native.profileSnapshot))) : null,
        capabilitySnapshotDigest: native.capabilities ? hash(canonicalWorkflowJson(plain(native.capabilities))) : null,
        protocolVersion: native.capabilities?.protocolVersion ?? null,
        currentModelId: native.currentModelId ?? null, currentModeId: native.currentModeId ?? null,
        nativeSessionIdentityObserved: typeof native.agentSessionId === 'string',
        engineExecutableVersion: 'unobserved'
      })
      if (plan.nativeTask) {
        const binding = await bindNativeTrellisTask({ projectRoot: plan.projectRoot, taskDir: plan.taskDir, nativeSessionId: session.session.agentSessionId, ...plan.nativeTask })
        await this.report(stage, 'workflow.native-task-context', plain(binding))
        if (binding.status === 'conflict') throw new WorkflowRuntimeError('SCOPE_CHANGED', binding.reason)
      }
      const root = plan.projectRoot
      stage.unsubscribe = this.options.acp.observe({ scope: { projectRoot: root, sessionId: stage.sessionId, connectionGeneration: stage.generation }, event: (event) => this.observeEvent(stage, event) })
      for (let repairIndex = 0; repairIndex <= plan.output.maxRepairTurns; repairIndex++) {
        plan.assertCurrent()
        if (stage.stopRequested) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Stage was stopped before its next prompt; no automatic replay')
        stage.terminal = undefined; stage.message = ''; stage.messageId = null; stage.turnId = null; stage.admitted = false; stage.written = false
        const instruction = repairIndex === 0 ? plan.context.instruction : `${plan.context.instruction}\n\nThe preceding output did not meet the declared output contract. Repair only the missing/invalid result; inspect existing files before repeating any side effect. Attempt ${repairIndex}/${plan.output.maxRepairTurns}.`
        if (Buffer.byteLength(instruction + WORKFLOW_REFERENCE_PREFIX + plan.context.materials.text) > plan.context.manifest.budgetBytes) return await this.finish(stage, 'failed', 'Repair instruction does not fit the admitted context budget; no extra prompt was sent')
        await this.report(stage, 'workflow.prompt-intent', { repairIndex, materialRefs: plan.context.packetRefs })
        await plan.authorizeCurrent?.()
        plan.assertCurrent()
        const identity = (value: WorkflowAcpTurnIdentity): boolean => {
          if (value.sessionId !== stage.sessionId || value.connectionGeneration !== stage.generation) { stage.reportError = new Error('Facade returned a foreign prompt identity'); stage.stopRequested = true; return false }
          stage.turnId = value.turnId; stage.admitted = true
          return true
        }
        const sent = await this.options.acp.prompt(root, stage.sessionId, instruction, { expectedConnectionGeneration: stage.generation }, {
          materials: plan.context.materials, assertActive: () => {
            plan?.assertCurrent()
            if (stage.stopRequested) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Stage stopped before native transport admission')
          }, onAdmitted: identity,
          onPromptWritten: (value) => { if (!identity(value)) return; stage.written = true; this.enqueue(stage, () => this.receipts(stage, plan?.context, 'emitted-to-host')) }
        })
        if (!sent.ok) throw new WorkflowRuntimeError(stage.written ? 'OUTCOME_UNKNOWN' : 'EXECUTOR_UNAVAILABLE', sent.error)
        if (stage.turnId !== null && stage.turnId !== sent.turnId) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Prompt return differs from admitted native turn')
        stage.turnId = sent.turnId
        if (!stage.written) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Native prompt returned without its prompt-written callback; delivery must be reconciled')
        stage.acknowledgement = { operationId: request.operationId, status: 'accepted', sessionId: stage.sessionId, turnId: stage.turnId, evidenceRefs: ['facade-prompt-written'] }
        await this.awaitTerminal(stage, plan)
        await stage.queue
        if (stage.reportError) throw stage.reportError
        const terminal = this.terminalEvent(stage)
        const result = terminal?.payload?.result
        const nativeStatus = result && typeof result === 'object' && 'status' in result ? String(result.status) : 'unknown'
        const policy = terminal?.payload?.hostPolicyOutcome
        const hostStopped = policy && typeof policy === 'object' && 'authority' in policy && policy.authority === 'host-policy'
          && 'status' in policy && policy.status === 'cancelled' && 'cause' in policy && policy.cause === 'retry-beyond-turn-budget'
          && 'turnId' in policy && policy.turnId === stage.turnId && 'connectionGeneration' in policy && policy.connectionGeneration === stage.generation
        const status = hostStopped && nativeStatus !== 'failed' ? 'cancelled' : nativeStatus
        if (status !== 'completed') {
          if (status === 'cancelled') {
            const state = await this.settledSession(stage, plan)
            if (!state.directoryLeaseReason && !state.cleanupRequired) return await this.finish(stage, 'cancelled', hostStopped
              ? `Host policy stopped waiting; native result remains ${nativeStatus}; partial file changes may remain`
              : 'Native cancellation settled; partial file changes may remain')
          }
          return await this.finish(stage, 'outcome-unknown', `Native turn result: ${status}; existing side effects must be inspected`)
        }
        const settled = await this.settledSession(stage, plan)
        if (settled.directoryLeaseReason || settled.cleanupRequired || settled.pendingPermissions?.length) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Native turn ended but background work, tool completion or cleanup is not confirmed')
        const output = await this.captureOutputs(stage, plan)
        const structured = plan.output.validateText?.(stage.message) ?? { ok: true }
        if (output.ok && structured.ok) {
          await this.recordHistory(stage, root)
          await this.report(stage, 'workflow.output-verified', { outputs: stage.outputs, repairIndex, historyCommitted: stage.historyCommitted, historySeq: stage.historySeq })
          return await this.finish(stage, 'passed', null)
        }
        await this.report(stage, 'workflow.output-invalid', { repairIndex, observedOutputs: stage.outputs, reason: output.reason ?? structured.reason ?? 'Output contract rejected the result', ...(output.outputPath ? { outputPath: output.outputPath } : {}) })
        if (output.reason === 'MATERIAL_UNAVAILABLE') return await this.finish(stage, 'failed', 'Required output version is unavailable; native side effects may already exist; no further repair prompt was sent')
        if (repairIndex === plan.output.maxRepairTurns) return await this.finish(stage, 'failed', 'Bounded output repair was exhausted; native side effects may already exist')
      }
      return await this.finish(stage, 'failed', 'Output repair exhausted')
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Managed stage failed'
      const uncertain = claimed || error instanceof WorkflowRuntimeError && error.code === 'OUTCOME_UNKNOWN'
      stage.acknowledgement = { operationId: stage.request.operationId, status: uncertain ? 'outcome-unknown' : 'rejected', sessionId: stage.sessionId, turnId: stage.turnId, evidenceRefs: [uncertain ? 'dispatch-outcome-requires-reconciliation' : 'dispatch-not-admitted'] }
      if (stage.sessionId && stage.stopRequested && !stage.stopConfirmed && !stage.finalizing) await this.stopNative(stage)
      if (claimed) {
        if (stage.finalizing) return { operationId: stage.request.operationId, status: 'outcome-unknown', sessionId: stage.sessionId, turnId: stage.turnId, outputs: stage.outputs, historySeq: stage.historySeq, historyCommitted: stage.historyCommitted, reason: `${reason}; durable result acknowledgement unavailable` }
        try { return await this.finish(stage, stage.stopConfirmed ? 'cancelled' : 'outcome-unknown', stage.stopConfirmed ? `${reason}; canonical stop confirmed, partial changes may remain` : reason) }
        catch { return { operationId: stage.request.operationId, status: 'outcome-unknown', sessionId: stage.sessionId, turnId: stage.turnId, outputs: stage.outputs, historySeq: stage.historySeq, historyCommitted: stage.historyCommitted, reason: `${reason}; durable result acknowledgement unavailable` } }
      }
      return { operationId: stage.request.operationId, status: uncertain ? 'outcome-unknown' : 'failed', sessionId: stage.sessionId, turnId: stage.turnId, outputs: [], historySeq: null, historyCommitted: false, reason }
    } finally { if (leaseTimer) clearInterval(leaseTimer); stage.unsubscribe?.(); stage.settled = true }
  }

  private validatePlan(request: DriverDispatch, plan: WorkflowStagePlan): void {
    if (!isAbsolute(plan.projectRoot)) throw new WorkflowRuntimeError('INVALID_INPUT', 'Stage execution requires a trusted absolute project root')
    if (request.node.step.kind !== 'agent') throw new WorkflowRuntimeError('EXECUTOR_UNAVAILABLE', 'This ACP driver executes agent nodes; tool/gate adapters are separate capabilities')
    if (canonicalWorkflowJson(plan.context.manifest) !== canonicalWorkflowJson(request.manifest.context) || canonicalWorkflowJson(plan.executor.verified) !== canonicalWorkflowJson(request.node.executor)) throw new WorkflowRuntimeError('MATERIAL_CHANGED', 'Stage plan differs from the admitted material or executor snapshot')
    if (canonicalWorkflowJson(plan.output.contract) !== canonicalWorkflowJson(request.manifest.context.outputContract)) throw new WorkflowRuntimeError('MATERIAL_CHANGED', 'Output validator contract is not the version pinned by the run')
    if (hash(plan.context.instruction + WORKFLOW_REFERENCE_PREFIX + plan.context.materials.text) !== plan.context.promptDigest) throw new WorkflowRuntimeError('MATERIAL_CHANGED', 'Prepared native prompt bytes changed after context assembly')
    z.number().int().min(0).max(3).parse(plan.output.maxRepairTurns)
    if (plan.output.files.length > 16) throw new WorkflowRuntimeError('INVALID_INPUT', 'Too many output paths in one stage')
    for (const output of plan.output.files) {
      const principal = output.kind === 'trellis-prd' ? 'prd.md' : output.kind === 'design' ? 'design.md' : null
      if (principal && output.relativePath.replace(/\\/g, '/') !== `.trellis/tasks/${plan.taskDir}/${principal}`) throw new WorkflowRuntimeError('SCOPE_CHANGED', 'Principal PRD/design output is not under the selected Trellis task')
    }
  }
  private async readySession(plan: WorkflowStagePlan, stage: LiveStage): Promise<Awaited<ReturnType<WorkflowAcpPort['get']>>> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 35_000)
    while (Date.now() < deadline && stage.sessionId) {
      plan.assertCurrent()
      if (stage.stopRequested) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Stop requested while preparing the native session')
      const result = await this.options.acp.get(plan.projectRoot, stage.sessionId)
      if (result.ok && result.session.connectionGeneration !== stage.generation) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Native connection changed while preparing the stage')
      if (result.ok && result.session.status === 'ready') return result
      if (result.ok && ['error', 'closed', 'legacy', 'disconnected'].includes(result.session.status)) throw new WorkflowRuntimeError('EXECUTOR_UNAVAILABLE', result.session.error ?? 'Native session did not become ready')
      await delay(100)
    }
    throw new WorkflowRuntimeError('EXECUTOR_UNAVAILABLE', 'Native session readiness was not acknowledged in time')
  }
  private async settledSession(stage: LiveStage, plan: WorkflowStagePlan): Promise<import('../../../shared/types').AcpSessionMeta> {
    const deadline = Date.now() + 5_000
    while (stage.sessionId && Date.now() < deadline) {
      plan.assertCurrent()
      const current = await this.options.acp.get(plan.projectRoot, stage.sessionId)
      if (!current.ok || current.session.connectionGeneration !== stage.generation || current.session.turnId !== stage.turnId) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Native session identity changed before stage settlement')
      if (current.session.status === 'ready') return current.session
      if (['closed', 'error', 'disconnected'].includes(current.session.status)) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', current.session.error ?? 'Native connection did not settle normally')
      await delay(50)
    }
    throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Canonical native turn settlement was not acknowledged')
  }
  private observeEvent(stage: LiveStage, event: TimelineEvent): void {
    if (event.sessionId !== stage.sessionId || event.connectionGeneration !== stage.generation || event.turnId !== stage.turnId) return
    if (event.kind === 'message' && event.payload?.role !== 'user') {
      const messageId = typeof event.payload?.messageId === 'string' ? event.payload.messageId : null
      if (messageId && messageId !== stage.messageId) stage.message = ''
      stage.messageId = messageId
      const limit = this.options.maxOutputChars ?? 200_000
      if (stage.message.length + (event.text?.length ?? 0) > limit) stage.reportError = new Error('Structured result exceeds the stage output bound')
      else stage.message += event.text ?? ''
    }
    if (event.kind === 'turn-done') stage.terminal = event
    if (event.kind !== 'message' && event.kind !== 'thought') this.enqueue(stage, () => this.report(stage, 'workflow.native-event', {
      originalEventId: event.id, kind: event.kind, nativeStatus: typeof event.payload?.status === 'string' ? event.payload.status : null,
      toolCallId: typeof event.payload?.toolCallId === 'string' ? event.payload.toolCallId : null, historySeq: null, historyCommitted: false
    }).then(() => {}))
  }
  private terminalEvent(stage: LiveStage): TimelineEvent | undefined { return stage.terminal }
  private enqueue(stage: LiveStage, work: () => Promise<void>): void {
    if (stage.queuedEvents >= 256) { stage.reportError = new Error('Managed event journal queue reached its bound'); stage.stopRequested = true; return }
    stage.queuedEvents++
    stage.queue = stage.queue.then(work).catch((error: unknown) => { stage.reportError = error instanceof Error ? error : new Error('Workflow journal acknowledgement unavailable'); stage.stopRequested = true }).finally(() => { stage.queuedEvents-- })
  }
  private async awaitTerminal(stage: LiveStage, plan: WorkflowStagePlan): Promise<void> {
    const deadline = Date.now() + (this.options.turnTimeoutMs ?? 30 * 60_000)
    while (!stage.terminal && Date.now() < deadline) {
      plan.assertCurrent()
      if (stage.stopRequested || stage.reportError) throw stage.reportError ?? new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Stage stop was requested')
      const state = stage.sessionId ? await this.options.acp.get(plan.projectRoot, stage.sessionId) : null
      if (state?.ok && state.session.connectionGeneration !== stage.generation) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Native connection changed during this stage')
      if (state?.ok && ['closed', 'error', 'disconnected'].includes(state.session.status)) throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', state.session.error ?? 'Native connection ended without a matching terminal event')
      await delay(100)
    }
    if (!stage.terminal) { stage.stopRequested = true; throw new WorkflowRuntimeError('OUTCOME_UNKNOWN', 'Stage deadline elapsed; canonical stop/reconciliation is required') }
  }
  private async captureOutputs(stage: LiveStage, plan: WorkflowStagePlan): Promise<{ ok: boolean; reason?: string; outputPath?: string }> {
    const outputs: StageResult['outputs'] = []
    stage.outputs = outputs
    for (const output of plan.output.files) {
      let stored: StoredWorkflowMaterial
      try {
        stored = await this.options.materials.captureFile({ projectRoot: plan.projectRoot, owner: stage.request.manifest.scope, relativePath: output.relativePath, kind: output.kind })
      } catch (error) {
        // Infrastructure/authorization failures do not establish malformed model
        // output and must never ask the engine to repeat possible side effects.
        if (!(error instanceof WorkflowRuntimeError) || error.code !== 'MATERIAL_UNAVAILABLE') throw error
        if (output.required) return { ok: false, reason: error.code, outputPath: output.relativePath }
        continue
      }
      outputs.push({ ref: stored.ref, material: stored.material })
      if (output.required && !stored.text.trim()) return { ok: false, reason: 'Required output file is empty', outputPath: output.relativePath }
      const checked = plan.output.validateMaterial?.(stored)
      if (checked && !checked.ok) return { ok: false, reason: checked.reason ?? 'Pinned output bytes did not meet the declared material contract', outputPath: output.relativePath }
    }
    return { ok: true }
  }
  private async recordHistory(stage: LiveStage, root: string): Promise<void> {
    try {
      await this.options.acp.flushHistory()
      if (!stage.sessionId || !stage.terminal) return
      const page = await this.options.acp.historyEvents(root, stage.sessionId, { limit: 500 })
      if (!page.ok || page.historyPersistence.state !== 'saved') return
      const match = page.events.find((event) => event.id === stage.terminal?.id && event.turnId === stage.turnId && event.connectionGeneration === stage.generation)
      if (typeof match?.historySeq === 'number') { stage.historySeq = match.historySeq; stage.historyCommitted = true }
    } catch { stage.historyCommitted = false }
  }
  private async receipts(stage: LiveStage, context: PreparedWorkflowContext | undefined, kind: 'prepared' | 'assembled' | 'emitted-to-host'): Promise<void> {
    if (!context) return
    for (const entry of context.entries) {
      if (kind === 'emitted-to-host' && !context.packetRefs.includes(entry.ref)) continue
      const receipt = contextReceiptSchema.parse({ eventId: randomUUID(), scope: stage.request.manifest.scope, step: stage.request.step,
        receiver: stage.sessionId ?? stage.request.executorBindingId, stage: kind, material: entry.material.material,
        includedDigest: entry.material.includedDigest, evidenceRef: entry.ref })
      await this.report(stage, `workflow.context-${kind}`, plain(receipt))
    }
  }
  private async report(stage: LiveStage, type: string, payload: WorkflowJson): Promise<WorkflowWriteAcknowledgement> {
    const event: ExecutionEvent = { contractVersion: 1, eventId: randomUUID(), source: type.startsWith('workflow.native') ? 'engine' : 'platform', type,
      attribution: { kind: 'assigned', scope: stage.request.manifest.scope, run: stage.request.manifest.run, step: stage.request.step, sessionId: stage.sessionId, turnId: stage.turnId, historySeq: null },
      occurredAt: Date.now(), receivedAt: Date.now(), epoch: this.epoch, sequence: ++this.sequence, payload }
    const result = await this.options.control.append({ event, payloadDigest: hash(canonicalWorkflowJson(event)) })
    if (!['committed', 'duplicate'].includes(result.status) || !result.cursor) throw new WorkflowRuntimeError('STORE_UNAVAILABLE', 'Workflow event was not acknowledged by durable control')
    return result
  }
  private async finish(stage: LiveStage, status: StageResult['status'], reason: string | null): Promise<StageResult> {
    await stage.queue
    if (stage.stopRequested) {
      if (stage.sessionId && !stage.stopConfirmed) await this.stopNative(stage)
      status = stage.stopConfirmed ? 'cancelled' : 'outcome-unknown'
      reason = stage.stopConfirmed ? 'Canonical stop confirmed before finalization; captured outputs and partial changes may remain' : 'Stop before finalization could not be confirmed; native side effects require reconciliation'
    }
    // No await between the final stop decision and this boundary. Requests
    // arriving from here onward reject rather than contradict the frozen result.
    stage.finalizing = true
    const result: StageResult = { operationId: stage.request.operationId, status, sessionId: stage.sessionId, turnId: stage.turnId, outputs: stage.outputs, historySeq: stage.historySeq, historyCommitted: stage.historyCommitted, reason }
    await this.report(stage, 'workflow.driver-result', plain(result))
    await this.options.control.recordStep({ scope: stage.request.manifest.scope, step: stage.request.step, owner: stage.request.owner,
      state: status === 'passed' ? 'verified' : status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'outcome-unknown', inputFingerprint: stage.request.manifest.inputFingerprint,
      materialRefs: stage.request.manifest.context.materials.map((entry) => entry.material), outputRefs: stage.outputs.map((output) => output.material), sessionId: stage.sessionId, turnId: stage.turnId,
      historySeq: stage.historySeq, historyCommitted: stage.historyCommitted, updatedAt: Date.now() })
    await this.options.control.settleOperation({ scope: stage.request.manifest.scope, owner: stage.request.owner, operationId: stage.request.operationId,
      state: status === 'passed' || status === 'cancelled' ? 'confirmed' : status === 'failed' ? 'failed' : 'outcome-unknown', result: plain(result), evidenceRefs: [stage.terminal?.id ?? 'driver-outcome-record'] })
    if (!stage.acknowledgement.evidenceRefs.length) stage.acknowledgement = { operationId: stage.request.operationId, status: status === 'passed' ? 'accepted' : 'outcome-unknown', sessionId: stage.sessionId, turnId: stage.turnId, evidenceRefs: ['durable-stage-result'] }
    return result
  }
  private async retireIdleSession(): Promise<void> {
    if (this.sessions.size < 2) return
    const candidates = [...this.sessions].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [key, candidate] of candidates) {
      if ([...this.stages.values()].some((stage) => !stage.settled && stage.sessionId === candidate.sessionId)) continue
      const session = await this.options.acp.get(candidate.root, candidate.sessionId)
      if (!session.ok || session.session.status === 'closed' || session.session.connectionGeneration !== candidate.generation) { this.sessions.delete(key); return }
      if (session.session.status !== 'ready' || session.session.directoryLeaseReason || session.session.pendingPermissions?.length) continue
      const ended = await this.options.acp.stop(candidate.root, candidate.sessionId, candidate.generation)
      if (ended.stopped) { this.sessions.delete(key); return }
    }
  }
}
