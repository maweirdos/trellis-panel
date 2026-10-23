import type { ExternalConversation, TaskConversationSource, TaskConversationSourceStatus } from '../../../shared/task-conversations'

/** Main-only evidence; never spread these fields into renderer responses. */
export type NativeTaskEvidence = NativeIdentity & { taskDir: string; trellisId: string | null; occurredAt: number }
export type NativeRuntimeAlias = NativeIdentity & { conversationId: string }
export type NativeHistoryFile = {
  conversation: ExternalConversation; sourceRoot: string; file: string; providerId?: string
}
export type NativeReadResult = {
  items: ExternalConversation[]; sources: TaskConversationSourceStatus[]; truncated: boolean
  indexing?: boolean; evidence?: NativeTaskEvidence[]; runtimeAliases?: NativeRuntimeAlias[]
  historyProgress?: { bytesRead: number; totalBytes: number; scannedBytes: number; files: number; completedFiles: number }
  /** Verified adapter-owned paths for explicit read-only inspection; never included in IPC. */
  historyFiles?: NativeHistoryFile[]
}
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
  clipboard?: { writeText(text: string): void }
}
export class TaskConversationError extends Error {
  constructor(public readonly code: 'E_INVALID_ARG' | 'E_NOT_FOUND' | 'E_CONFLICT' | 'E_UNAVAILABLE', message: string) {
    super(message)
    this.name = 'TaskConversationError'
  }
}
