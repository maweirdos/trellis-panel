/** Main-facade observation only; this bridge never owns a native session or permission. */
import type { TimelineEvent } from '../../../shared/types'
import type { WorkflowAcpObserver, WorkflowAcpState } from './types'
import { isAbsolute, resolve } from 'path'

const observers = new Set<WorkflowAcpObserver>()
const MAX_OBSERVERS = 32
export type WorkflowObserverFailure = { message: string }

export function observeWorkflowAcp(observer: WorkflowAcpObserver): () => void {
  if (!observer.scope || !isAbsolute(observer.scope.projectRoot)) throw new Error('Managed ACP observer requires a captured absolute project root')
  if (observers.size >= MAX_OBSERVERS) throw new Error('Managed ACP observer limit reached')
  const captured: WorkflowAcpObserver = { scope: { ...observer.scope, projectRoot: resolve(observer.scope.projectRoot) }, event: observer.event, state: observer.state }
  observers.add(captured)
  return () => { observers.delete(captured) }
}

const rootKey = (root: string): string => process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
function matches(observer: WorkflowAcpObserver, value: { projectRoot?: string; sessionId?: string; connectionGeneration?: string }): boolean {
  return typeof value.projectRoot === 'string' && rootKey(value.projectRoot) === rootKey(observer.scope.projectRoot)
    && (!observer.scope.sessionId || value.sessionId === observer.scope.sessionId)
    && (!observer.scope.connectionGeneration || value.connectionGeneration === observer.scope.connectionGeneration)
}
function deliver<T extends { projectRoot?: string; sessionId?: string; connectionGeneration?: string }>(value: T, select: (observer: WorkflowAcpObserver) => ((value: T) => void) | undefined): WorkflowObserverFailure[] {
  if (!observers.size) return []
  const failures: WorkflowObserverFailure[] = []
  // Observers cannot mutate the facade's event/history object. Callback errors
  // are returned to the host rather than disrupting native transport handling.
  let copy: T
  try { copy = structuredClone(value) }
  catch { return [{ message: 'Managed ACP update could not be safely cloned' }] }
  for (const observer of observers) {
    try {
      if (!matches(observer, copy)) continue
      const listener = select(observer)
      if (listener) listener(structuredClone(copy))
    }
    catch { failures.push({ message: 'Managed ACP observer rejected a scoped update' }) }
  }
  return failures
}

/** Call only after the same redacted event has entered the existing history path. */
export function publishWorkflowAcpEvent(event: TimelineEvent): WorkflowObserverFailure[] {
  return deliver(event, (observer) => observer.event)
}

/** Includes original connection/turn identity and actual history acknowledgement. */
export function publishWorkflowAcpState(event: WorkflowAcpState): WorkflowObserverFailure[] {
  return deliver(event, (observer) => observer.state)
}
