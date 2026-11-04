import { canonicalWorkflowJson, runRefSchema, type RunRef } from '../../../shared/workflow'
import type { WorkflowApplicationSnapshot } from '../../../shared/workflow-application'
import type { WorkspaceLease, WorkflowControlService } from '../workflow-control'
import type { WorkcopyUseFact } from '../../../shared/workcopy-use'

/** All inputs are observations from the native owner, never renderer claims. */
export function requireReleasedPredecessor(input: { projection: WorkflowApplicationSnapshot; workspaceOwner: WorkspaceLease | null; uses: WorkcopyUseFact[]; nativeSessionIds: string[]; expectedRun?: RunRef; noDispatchEvidence?: string }): RunRef {
  const { projection, workspaceOwner } = input, snapshot = projection.snapshot
  if (!snapshot || !snapshot.manifest || !projection.origin || projection.recoveryRequired || !['verified', 'failed', 'stopped', 'cancelled'].includes(snapshot.run.state)) throw new Error('原工作流没有可核验的终态；请检查原运行')
  const run = runRefSchema.parse(snapshot.run.run)
  if (input.expectedRun && canonicalWorkflowJson(run) !== canonicalWorkflowJson(input.expectedRun)) throw new Error('原工作流已变更；请重新核对后继准备')
  if (!workspaceOwner || workspaceOwner.state !== 'released' || workspaceOwner.recoveryRequired) throw new Error('原工作流控制占用尚未确认释放')
  if (input.uses.length) throw new Error('原工作副本仍有占用或清理待核对')
  const originalSessions = new Set([projection.origin.sessionId, ...projection.nodes.flatMap(node => node.sessionId ? [node.sessionId] : []), ...projection.stageSessions.map(session => session.sessionId)])
  if (input.nativeSessionIds.some(id => originalSessions.has(id))) throw new Error('原生会话仍由后台持有；请先确认结束和清理')
  if (!projection.nodes.some(node => node.sessionId && node.run) && !input.noDispatchEvidence) throw new Error('原阶段原生会话身份没有可核验记录')
  return run
}

/** Read only durable controller records; a stop event by itself is not proof of non-dispatch. */
export async function readStoppedBeforeDispatchEvidence(control: Pick<WorkflowControlService, 'events' | 'getOperation' | 'getCommand' | 'steps'>, projection: WorkflowApplicationSnapshot, owner: WorkspaceLease | null, taskDir: string): Promise<string> {
  const snapshot = projection.snapshot
  const fail = (): never => { throw new Error('无法证明原运行在首次原生派发前已停止') }
  if (!snapshot || snapshot.run.state !== 'stopped' || snapshot.run.run.revision !== 1 || snapshot.run.predecessor !== null || !snapshot.manifest || !owner || owner.state !== 'released' || owner.recoveryRequired || canonicalWorkflowJson(owner.scope) !== canonicalWorkflowJson(projection.scope)) return fail()
  const scope = projection.scope, run = snapshot.run.run
  if (canonicalWorkflowJson(snapshot.run.scope) !== canonicalWorkflowJson(scope) || canonicalWorkflowJson(snapshot.manifest.scope) !== canonicalWorkflowJson(scope) || canonicalWorkflowJson(snapshot.manifest.run) !== canonicalWorkflowJson(run)) return fail()
  if (projection.stageSessions.length || projection.nodes.some(node => node.sessionId || node.turnId || node.historySeq !== null || node.historyCommitted || node.outputRefs.length)) return fail()
  const steps = await control.steps(scope, run)
  if (steps.length !== 1 || steps[0].state !== 'cancelled' || steps[0].step.attempt !== 1 || steps[0].sessionId !== null || steps[0].turnId !== null || steps[0].historySeq !== null || steps[0].historyCommitted || steps[0].outputRefs.length || canonicalWorkflowJson(steps[0].scope) !== canonicalWorkflowJson(scope) || steps[0].step.runId !== run.runId || steps[0].step.revision !== run.revision || canonicalWorkflowJson(steps[0].owner) !== canonicalWorkflowJson(owner.owner)) return fail()
  let cursor: Awaited<ReturnType<typeof control.events>>['cursor'] | null = null
  const events: Awaited<ReturnType<typeof control.events>>['items'] = []
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const page = await control.events({ scope, cursor, limit: 200 })
    if (page.resetRequired) return fail()
    events.push(...page.items.filter(({ event }) => event.attribution.kind === 'assigned' && canonicalWorkflowJson(event.attribution.scope) === canonicalWorkflowJson(scope) && canonicalWorkflowJson(event.attribution.run) === canonicalWorkflowJson(run)))
    cursor = page.cursor
    if (!page.hasMore) break
    if (pageIndex === 49) return fail()
  }
  if (events.some(({ event }) => event.attribution.kind !== 'assigned' || event.attribution.sessionId !== null || event.attribution.turnId !== null || event.attribution.historySeq !== null)) return fail()
  const stopped = events.filter(({ event }) => event.source === 'platform' && event.type === 'workflow.stopped-before-dispatch')
  if (stopped.length !== 1) return fail()
  const stoppedPayload = stopped[0].event.payload
  if (!stoppedPayload || typeof stoppedPayload !== 'object' || Array.isArray(stoppedPayload) || typeof stoppedPayload.operationId !== 'string') return fail()
  const executeId = stoppedPayload.operationId
  const requested = events.filter(({ event }) => event.source === 'platform' && event.type === 'workflow.stop-requested' && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && event.payload.operationId === executeId)
  if (requested.length !== 1) return fail()
  const stopEvents = events.filter(({ event }) => event.source === 'platform' && event.type === 'workflow.operation-confirmed' && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && typeof event.payload.operationId === 'string' && event.payload.operationId.startsWith('stop:'))
  if (stopEvents.length !== 1 || requested[0].cursor.sequence >= stopEvents[0].cursor.sequence || stopEvents[0].cursor.sequence >= stopped[0].cursor.sequence) return fail()
  const stopPayload = stopEvents[0].event.payload as { operationId: string }, stopId = stopPayload.operationId
  const [execution, stop] = await Promise.all([control.getOperation(scope, executeId), control.getOperation(scope, stopId)])
  if (!execution || !stop) return fail()
  const e = execution.operation, s = stop.operation
  const same = (value: typeof e): boolean => canonicalWorkflowJson(value.scope) === canonicalWorkflowJson(scope) && canonicalWorkflowJson(value.run) === canonicalWorkflowJson(run) && value.ownerId === owner.owner.ownerId && value.fencingToken === owner.owner.fencingToken
  if (!same(e) || !same(s) || e.purpose !== 'execute-step' || e.state !== 'failed' || e.operationId !== `execute:${e.commandId}:1` || execution.attempts !== 1 || canonicalWorkflowJson(e.result) !== canonicalWorkflowJson({ status: 'cancelled-before-native-dispatch' }) || canonicalWorkflowJson(execution.evidenceRefs) !== canonicalWorkflowJson(['main-controller-never-called-driver']) || s.purpose !== 'stop-run' || s.state !== 'confirmed' || s.operationId !== `stop:${s.commandId}` || stop.attempts !== 1 || canonicalWorkflowJson(s.result) !== canonicalWorkflowJson({ status: 'stopped', evidenceRefs: ['main-controller-never-called-driver'] }) || canonicalWorkflowJson(stop.evidenceRefs) !== canonicalWorkflowJson(['main-controller-never-called-driver'])) return fail()
  const [startCommand, stopCommand] = await Promise.all([control.getCommand(scope, e.commandId), control.getCommand(scope, s.commandId)])
  const validCommand = (record: typeof startCommand, kind: 'start' | 'request-stop'): boolean => Boolean(record && record.status === 'committed' && record.command.kind === kind && record.command.runId === run.runId && record.command.expectedRevision === run.revision && canonicalWorkflowJson(record.command.scope) === canonicalWorkflowJson(scope))
  if (!startCommand || !stopCommand || !validCommand(startCommand, 'start') || !validCommand(stopCommand, 'request-stop')) return fail()
  const startPayload = startCommand.command.payload, commandPayload = stopCommand.command.payload
  if (!startPayload || typeof startPayload !== 'object' || Array.isArray(startPayload) || startPayload.taskDir !== taskDir || !commandPayload || typeof commandPayload !== 'object' || Array.isArray(commandPayload) || commandPayload.taskDir !== taskDir || commandPayload.action !== 'request-stop' || canonicalWorkflowJson(commandPayload.target) !== canonicalWorkflowJson(run)) return fail()
  return canonicalWorkflowJson({ run, scope, owner, steps, events, execution, stop, startCommand, stopCommand })
}
