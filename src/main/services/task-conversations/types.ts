import type { ExternalConversation, TaskConversationSource, TaskConversationSourceStatus } from '../../../shared/task-conversations'

export type NativeReadResult = { items: ExternalConversation[]; sources: TaskConversationSourceStatus[]; truncated: boolean }
export type NativeIdentity = Pick<ExternalConversation, 'source' | 'sessionId'>
export type NativeReader = (root: string, requested?: NativeIdentity[]) => Promise<NativeReadResult>
export type LaunchTarget =
  | { kind: 'protocol'; source: 'codex' | 'zcode'; url: string; cwd: string }
  | { kind: 'packaged-protocol'; source: 'codex'; url: string; cwd: string; packageFamilyName: string }
  | { kind: 'terminal'; source: 'claude-code'; executable: string; args: string[]; cwd: string }
export type LaunchCapability = { available: boolean; detail?: string; executable?: string; packageFamilyName?: string }
export type LaunchPorts = {
  capability(source: TaskConversationSource): Promise<LaunchCapability>
  /** Dispatch must begin synchronously when called, after the service owner guard. */
  launch(target: LaunchTarget): Promise<void>
}
export type TaskConversationsOptions = {
  readNative?: NativeReader
  launch?: LaunchPorts
  /** Main-owned paths only. Never accept these from IPC. */
  nativeRoots?: Partial<Record<TaskConversationSource, string>>
  now?: () => number
}
export class TaskConversationError extends Error {
  constructor(public readonly code: 'E_INVALID_ARG' | 'E_NOT_FOUND' | 'E_CONFLICT' | 'E_UNAVAILABLE', message: string) {
    super(message)
    this.name = 'TaskConversationError'
  }
}
