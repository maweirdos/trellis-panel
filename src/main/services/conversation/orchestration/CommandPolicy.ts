import type { OrchestrationV2Run } from '../../../../shared/conversation/contracts'

export function isActiveRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === 'preparing' ||
    run.status === 'starting' ||
    run.status === 'running' ||
    run.status === 'waiting'
  )
}
