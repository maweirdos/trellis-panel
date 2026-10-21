import type { IpcFail } from './ipc-errors'

export const GIT_HISTORY_PAGE_SIZE = 100
export const GIT_HISTORY_LIMIT = 1000

export interface GitHistoryCommit {
  hash: string
  parents: string[]
  author: string
  /** Unix milliseconds. */
  timestamp: number
  subject: string
}

export interface GitHistoryRef {
  name: string
  fullName: string
  hash: string
  kind: 'branch' | 'remote' | 'tag'
}

export interface GitCommitFile {
  path: string
  oldPath: string | null
  status: string
}

export interface GitHistoryRequest {
  expectedRoot: string
  offset?: number
  revision?: string
}

export interface GitCommitRequest {
  expectedRoot: string
  hash: string
}

export interface GitCommitDiffRequest extends GitCommitRequest {
  path: string
}

export type GitHistoryResult = IpcFail | {
  ok: true
  root: string
  revision: string
  head: string | null
  commits: GitHistoryCommit[]
  refs: GitHistoryRef[]
  nextOffset: number
  hasMore: boolean
  limited: boolean
}

export type GitCommitResult = IpcFail | {
  ok: true
  root: string
  commit: GitHistoryCommit
  files: GitCommitFile[]
  comparison: string
  parent: string | null
  filesTruncated?: boolean
}

export type GitCommitDiffResult = IpcFail | {
  ok: true
  root: string
  path: string
  diff: string
  added: number
  removed: number
  binary: boolean
  truncated: boolean
  comparison: string
}
