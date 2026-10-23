import { AsyncLocalStorage } from 'node:async_hooks'
import type { KnowledgeOwner } from './types'
import type { CreateTaskInput, CreateTaskResult } from '../../state'
import type { IpcFail } from '../../../shared/ipc-errors'
import { createTaskRecordAt } from '../task-record'
import { scanProject } from '../scan'
import { IntegrationError } from '../integrations/types'

export interface KnowledgeWorkspaceHost { root(): string | null; generation(): number; createTask(input: CreateTaskInput): CreateTaskResult | IpcFail }
const owned = new AsyncLocalStorage<KnowledgeOwner>()
let gui: KnowledgeWorkspaceHost | undefined
/** GUI-only composition. The daemon never imports or switches GUI state. */
export function installKnowledgeWorkspaceHost(host: KnowledgeWorkspaceHost): void {
  if (gui) throw new Error('Knowledge workspace host is already installed')
  gui = host
}
/** Called only with the existing native connection's admitted owner, never model tool arguments. */
export function withKnowledgeOwner<T>(owner: KnowledgeOwner, action: () => T): T { return owned.run(owner, action) }
export function knowledgeWorkspaceRoot(): string | null { return owned.getStore()?.root ?? gui?.root() ?? null }
export function knowledgeWorkspaceGeneration(): number { return owned.getStore()?.projectGeneration ?? gui?.generation() ?? 0 }
export function createKnowledgePlanningTask(input: CreateTaskInput): CreateTaskResult | IpcFail {
  const owner = owned.getStore()
  if (owner) {
    if (owner.isCurrent?.() === false) throw new IntegrationError('The admitted native turn is no longer current', 'conflict')
    return createTaskRecordAt(owner.root, input, { snapshot: scanProject(owner.root) })
  }
  if (!gui) throw new IntegrationError('Knowledge task creation has no authorized workspace host', 'denied')
  return gui.createTask(input)
}
