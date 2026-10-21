import { IpcErrorCode, ipcFail } from '../../../shared/ipc-errors'
import type { GitWorkspaceFailure, GitWorkspaceMutationResult, GitWorkspaceReview, GitWorkspaceSnapshot } from '../../../shared/git-workspace'

export type GitWorkspaceOperationOptions = {
  review?: (preview: GitWorkspaceReview) => Promise<boolean>
  guard?: () => boolean
  stillCurrent?: () => boolean
}
export interface RepositoryState {
  snapshot: GitWorkspaceSnapshot
  gitDirectory: string
  indexPath: string
  indexBytes: Buffer | null
  indexEntries: string
  statusRaw: string
  headRef: string | null
  objectZero: string
}
export interface GitWorkspaceProcedureContext {
  enqueue<T>(root: string, operation: () => Promise<T>): Promise<T>
  checked(root: string, revision: string, options: GitWorkspaceOperationOptions): Promise<RepositoryState>
  success(root: string, message: string, committed?: string): Promise<GitWorkspaceMutationResult>
}
export class GitWorkspaceError extends Error {
  retainIndexLock = false
  constructor(public code: IpcErrorCode, message: string, public extra: Partial<GitWorkspaceFailure> = {}) { super(message); this.name = 'GitWorkspaceError' }
}
export function workspaceFailure(error: unknown, root?: string): GitWorkspaceFailure {
  if (error instanceof GitWorkspaceError) return { ...ipcFail(error.code, error.message), ...(root ? { root } : {}), ...error.extra }
  return { ...ipcFail(IpcErrorCode.Io, 'Git 操作未完成，请刷新状态后核验'), ...(root ? { root } : {}) }
}
