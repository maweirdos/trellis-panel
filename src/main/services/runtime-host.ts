/** Local execution is an explicit host capability. Synchronous metadata readers are projections only. */
import { randomUUID } from 'node:crypto'
export interface LegacyRuntimeRelease { runtimeDrained: true; releaseId: string; admission: 'closed'; sessions: 0; workflows: 0; at: number }
let drainingLegacy = false
export function assertRuntimeExecutionHost(): void {
  if (!drainingLegacy && !process.argv.includes('--trellis-role=daemon')) throw Object.assign(new Error('原生执行由后台守护进程拥有；桌面不能启动第二个控制器'), { code: 'E_UNAVAILABLE' })
}
/** Actual cleanup only; never enables new admission or impersonates a dead process. */
export async function drainLegacyRuntime(): Promise<LegacyRuntimeRelease> {
  const acp = await import('./acp')
  const workflow = await import('./workflow-desktop')
  workflow.setWorkflowAdmissionClosed(true)
  acp.closeAcpAdmission()
  drainingLegacy = true
  try {
    await workflow.shutdownWorkflowApplications()
    await Promise.allSettled(acp.listOwnedAcpSessionFacts().filter(session => session.turnActive || session.accepting || session.pendingPermission)
      .map(session => acp.cancelAcpSession(session.projectRoot, session.sessionId)))
    await acp.shutdownAcp()
    if (acp.listOwnedAcpSessionFacts().length || await workflow.hasWorkflowApplications()) throw new Error('原有执行器仍持有任务，不能切换后台所有权')
    return { runtimeDrained: true, releaseId: randomUUID(), admission: 'closed', sessions: 0, workflows: 0, at: Date.now() }
  } finally { drainingLegacy = false }
}
