import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import type { GitReadonlyFileDiff } from './types'

export const GIT_WORKSPACE_LIMITS = { paths: 5000, outputBytes: 4 * 1024 * 1024, diffBytes: 128 * 1024, messageBytes: 64 * 1024, localTimeoutMs: 30000, pushTimeoutMs: 60000 } as const
const text = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), '参数包含无效字符')
export const gitWorkspaceStatusSchema = z.object({ expectedRoot: text }).strict()
export const gitWorkspaceDiffSchema = z.object({ expectedRoot: text, path: text, staged: z.boolean() }).strict()
const mutationFields = { expectedRoot: text, revision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }
export const gitWorkspacePathsSchema = z.object({ ...mutationFields, paths: z.array(text).min(1).max(GIT_WORKSPACE_LIMITS.paths) }).strict()
export const gitWorkspaceCommitSchema = z.object({ ...mutationFields, message: z.string().trim().min(1).max(GIT_WORKSPACE_LIMITS.messageBytes) }).strict()
export const gitWorkspaceCreateBranchSchema = z.object({ ...mutationFields, name: z.string().trim().min(1).max(250), switchAfter: z.boolean().default(false) }).strict()
export const gitWorkspaceSwitchBranchSchema = z.object({ ...mutationFields, name: z.string().trim().min(1).max(250) }).strict()
export const gitWorkspacePushSchema = z.object({ ...mutationFields, remote: z.string().min(1).max(250), branch: z.string().min(1).max(250), remoteBranch: z.string().min(1).max(250), setUpstream: z.boolean().default(false) }).strict()

export type GitWorkspaceStatusInput = z.infer<typeof gitWorkspaceStatusSchema>
export type GitWorkspaceDiffInput = z.infer<typeof gitWorkspaceDiffSchema>
export type GitWorkspacePathsInput = z.infer<typeof gitWorkspacePathsSchema>
export type GitWorkspaceCommitInput = z.infer<typeof gitWorkspaceCommitSchema>
export type GitWorkspaceCreateBranchInput = z.input<typeof gitWorkspaceCreateBranchSchema>
export type GitWorkspaceSwitchBranchInput = z.infer<typeof gitWorkspaceSwitchBranchSchema>
export type GitWorkspacePushInput = z.input<typeof gitWorkspacePushSchema>

export interface GitWorkspaceChange { path: string; origPath?: string; x: string; y: string }
export interface GitWorkspaceBranch { name: string; current: boolean; upstream: string | null; worktree: string | null }
export interface GitWorkspaceRemote { name: string; fetchUrl: string; pushUrl: string }
export interface GitWorkspaceSnapshot {
  root: string
  repoRoot: string
  revision: string
  head: string | null
  branch: string | null
  unborn: boolean
  detached: boolean
  clean: boolean
  staged: GitWorkspaceChange[]
  unstaged: GitWorkspaceChange[]
  untracked: string[]
  branches: GitWorkspaceBranch[]
  remotes: GitWorkspaceRemote[]
  conflicts: boolean
  operation: string | null
  observedAt: number
}
export type GitWorkspaceFailure = IpcFail & { root?: string; uncertain?: boolean; mutationCompleted?: boolean; committed?: string }
export type GitWorkspaceStatusResult = { ok: true; root: string; snapshot: GitWorkspaceSnapshot } | GitWorkspaceFailure
export type GitWorkspaceMutationResult = { ok: true; root: string; snapshot: GitWorkspaceSnapshot; message: string; committed?: string } | GitWorkspaceFailure
export type GitWorkspaceDiffResult = ({ ok: true; root: string } & GitReadonlyFileDiff) | GitWorkspaceFailure

export interface GitWorkspaceReview {
  kind: 'commit' | 'push'
  root: string
  revision: string
  branch: string | null
  paths: string[]
  message?: string
  remote?: string
  remoteBranch?: string
  remoteUrl?: string
}
export interface GitWorkspaceApi {
  status(input: GitWorkspaceStatusInput): Promise<GitWorkspaceStatusResult>
  diff(input: GitWorkspaceDiffInput): Promise<GitWorkspaceDiffResult>
  stage(input: GitWorkspacePathsInput): Promise<GitWorkspaceMutationResult>
  unstage(input: GitWorkspacePathsInput): Promise<GitWorkspaceMutationResult>
  commit(input: GitWorkspaceCommitInput): Promise<GitWorkspaceMutationResult>
  createBranch(input: GitWorkspaceCreateBranchInput): Promise<GitWorkspaceMutationResult>
  switchBranch(input: GitWorkspaceSwitchBranchInput): Promise<GitWorkspaceMutationResult>
  push(input: GitWorkspacePushInput): Promise<GitWorkspaceMutationResult>
}
