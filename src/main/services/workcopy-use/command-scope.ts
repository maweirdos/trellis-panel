import { AsyncLocalStorage } from 'node:async_hooks'
import type { WorkcopyLease } from '../../../shared/workcopy-use'

type CommandScope = { root: string; lease: WorkcopyLease; sequence: number }
const scope = new AsyncLocalStorage<CommandScope>()
export function withWorkcopyCommandScope<T>(root: string, lease: WorkcopyLease, action: () => Promise<T>): Promise<T> {
  return scope.run({ root, lease, sequence: 0 }, action)
}
export function nextWorkcopyCommand(): { root: string; lease: WorkcopyLease; operationId: string } | undefined {
  const current = scope.getStore()
  if (!current) return undefined
  return { root: current.root, lease: current.lease, operationId: `git-${current.lease.token}-${++current.sequence}` }
}
