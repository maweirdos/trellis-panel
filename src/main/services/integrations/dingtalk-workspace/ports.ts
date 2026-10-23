import type { WorkspaceGrant } from '../../../../shared/daemon'
import type { DingAccount, DingAssistant, DingExecution, DingInput, DingMethod, DingOutput } from '../../../../shared/dingtalk-integration'
import type { DingTalkRepository } from './repository'
import type { DingTalkStreamFactory } from './stream'

/** Supplied by the single leased native host, never by IPC or provider messages. */
export interface DingTalkWorkspacePort {
  current(expectedRoot: string | null): { nativeSubject: string; workspace: WorkspaceGrant | null }
  assertWorkspace(workspace: WorkspaceGrant): void
}
export interface DingTalkProtectionPort { protect(text: string): string; reveal(ciphertext: string): string }
export interface DingTalkExecutionPort {
  /** Must reuse native runtime admission and exact per-turn approvals. A pending
   * response must not create a replacement command/session on a later query. */
  admit(input: { commandId: string; workspace: WorkspaceGrant; runtimeId: string; profileId: string; taskDir: string; text: string; deadline: number; permissionPolicy: 'original-native-approvals'; source: { provider: 'dingtalk'; messageId: string; senderStaffId: string } }): Promise<DingExecution>
  query(input: { commandId: string; workspace: WorkspaceGrant; sessionId?: string | null; turnId?: string | null; connectionGeneration?: string | null; deadline?: number }): Promise<DingExecution>
  cancel(input: { commandId: string; workspace: WorkspaceGrant; sessionId: string | null; turnId: string | null; connectionGeneration?: string | null }): Promise<DingExecution>
  /** Verify that the saved profile/runtime is actually selectable in this scope. */
  validate(workspace: WorkspaceGrant, runtimeId: string, profileId: string): Promise<void>
}
export interface DingTalkPersonalPort {
  setup(): { available: boolean; serviceBinding: string | null; linkPreview: 'unavailable' | 'needs-setup' | 'ready'; detail: string }
  begin(input: { nativeSubject: string; appId: string; appRevision: number; appKey: string; corpId: string; requestId: string }, signal: AbortSignal): Promise<{ authorizationId: string; expiresAt: number; browserUrl: string }>
  /** The service, not a browser-entered staff ID, supplies vendor-verified identity. */
  claim(input: { nativeSubject: string; appId: string; appRevision: number; authorizationId: string }, signal: AbortSignal): Promise<{ unionId: string; staffId: string; corpId: string; displayName: string; serviceBinding: string }>
  unlink(account: DingAccount, signal: AbortSignal): Promise<void>
}
export interface DingTalkPorts {
  repository: DingTalkRepository
  workspace: DingTalkWorkspacePort
  stream?: DingTalkStreamFactory
  execution?: DingTalkExecutionPort
  personal?: DingTalkPersonalPort
  openBrowser?(url: string): Promise<void>
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  changed?(): void
  networkKey?(): string
}
export type DingTalkActions = { [M in Exclude<DingMethod, 'cancelRead'>]: (input: DingInput<M>, signal?: AbortSignal) => Promise<DingOutput<M>> }
export interface DingTalkStreamOwner {
  sync(assistants: readonly DingAssistant[]): Promise<void>
  stopApp(appId: string): Promise<void>
  close(): Promise<void>
}
