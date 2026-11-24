import { z } from 'zod'
import { applicationIdSchema, applicationRunIdSchema, type ApplicationLogsResult, type ApplicationResult, type ApplicationSummary } from '../app-runtime'
import type { GitWorkspaceFailure, GitWorkspaceMutationResult, GitWorkspaceSnapshot } from '../git-workspace'
import type { IpcFail } from '../ipc-errors'
import type { GitLabTaskStatus, GitReadonlyFileDiff } from '../types'
import { conversationTaskLocatorSchema } from './task-scope'

const text = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/u)
const id = z.string().min(1).max(200).regex(/^[\w.-]+$/)
const gitName = text.max(250)
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const run = { appId: applicationIdSchema, runId: applicationRunIdSchema }
export const projectWorkbenchActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inspect') }),
  z.strictObject({ kind: z.literal('files'), directory: text.optional() }),
  z.strictObject({ kind: z.literal('file'), path: text }),
  z.strictObject({ kind: z.literal('diff'), path: text, mode: z.enum(['staged', 'unstaged', 'untracked', 'branch']), baseBranch: gitName.optional() }),
  z.strictObject({ kind: z.literal('branch.diff'), baseBranch: gitName }),
  z.strictObject({ kind: z.literal('open.directory') }),
  z.strictObject({ kind: z.literal('open.ide'), ideId: z.literal('vscode') }),
  z.strictObject({ kind: z.literal('terminal.open') }),
  z.strictObject({ kind: z.literal('script.start'), appId: applicationIdSchema, revision: text.max(100) }),
  z.strictObject({ kind: z.literal('script.logs'), ...run, after: z.number().int().nonnegative().safe().optional() }),
  z.strictObject({ kind: z.literal('script.stop'), ...run }),
  z.strictObject({ kind: z.literal('git.stage'), revision, paths: z.array(text).min(1).max(5000) }),
  z.strictObject({ kind: z.literal('git.unstage'), revision, paths: z.array(text).min(1).max(5000) }),
  z.strictObject({ kind: z.literal('git.commit'), revision, message: z.string().trim().min(1).max(65_536) }),
  z.strictObject({ kind: z.literal('git.branch.create'), revision, name: gitName, switchAfter: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('git.branch.switch'), revision, name: gitName }),
  z.strictObject({ kind: z.literal('git.push'), revision, remote: gitName, branch: gitName, remoteBranch: gitName, setUpstream: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('gitlab.status'), remote: gitName }),
  z.strictObject({ kind: z.literal('gitlab.pr.create'), revision, remote: gitName, sourceBranch: gitName, targetBranch: gitName,
    title: z.string().trim().min(1).max(500), description: z.string().max(16_000).optional() }),
  z.strictObject({ kind: z.literal('gitlab.issue.open'), remote: gitName, iid: z.number().int().positive().safe() }),
  z.strictObject({ kind: z.literal('checkpoint.restore'), runId: id, checkpointId: id, revision }),
])
export const projectWorkbenchInputSchema = z.strictObject({
  cwd: text.max(8192),
  task: conversationTaskLocatorSchema.optional(),
  threadId: id,
  action: projectWorkbenchActionSchema,
})
export type ProjectWorkbenchInput = z.infer<typeof projectWorkbenchInputSchema>
export type ProjectWorkbenchAction = ProjectWorkbenchInput['action']

export interface ProjectWorkbenchFileStat {
  path: string
  previousPath: string | null
  additions: number
  deletions: number
  binary: boolean
}
export interface ProjectWorkbenchStats {
  files: readonly ProjectWorkbenchFileStat[]
  additions: number
  deletions: number
}
export type ProjectWorkbenchAvailability = { available: true } | { available: false; reason: string }
export type ProjectWorkbenchGit = { available: true; snapshot: GitWorkspaceSnapshot; stats: ProjectWorkbenchStats | IpcFail } |
  { available: false; reason: string; code: IpcFail['code'] }
export type ProjectWorkbenchScript = Pick<ApplicationSummary, 'processState' | 'canStart' | 'canStop'> & {
  appId: string
  name: string
  revision: string
  runId: string | null
}
export interface ProjectWorkbenchProject {
  cwd: string
  threadId: string
  machine: string
  git: ProjectWorkbenchGit
  gitWrite: ProjectWorkbenchAvailability
  scripts: { available: true; items: readonly ProjectWorkbenchScript[] } | { available: false; reason: string }
  ides: readonly { id: 'vscode'; label: string }[]
  terminal: ProjectWorkbenchAvailability
  restore: ProjectWorkbenchAvailability
}
export interface ProjectWorkbenchFileEntry { name: string; path: string; kind: 'file' | 'directory' }
export type ProjectWorkbenchSuccess =
  | { ok: true; kind: 'inspect'; project: ProjectWorkbenchProject }
  | { ok: true; kind: 'files'; entries: readonly ProjectWorkbenchFileEntry[]; truncated: boolean }
  | { ok: true; kind: 'file'; path: string; text: string; modifiedAt: number; revision: string }
  | ({ ok: true; kind: 'diff' } & GitReadonlyFileDiff)
  | { ok: true; kind: 'branch.diff'; baseBranch: string; stats: ProjectWorkbenchStats }
  | { ok: true; kind: 'open.directory' | 'open.ide' | 'terminal.open' | 'checkpoint.restore' }
  | ({ kind: 'script.start' | 'script.stop' } & Extract<ApplicationResult, { ok: true }>)
  | ({ kind: 'script.logs' } & Extract<ApplicationLogsResult, { ok: true }>)
  | ({ kind: 'git.stage' | 'git.unstage' | 'git.commit' | 'git.branch.create' | 'git.branch.switch' | 'git.push' } & Extract<GitWorkspaceMutationResult, { ok: true }>)
  | { ok: true; kind: 'gitlab.status'; status: GitLabTaskStatus }
  | { ok: true; kind: 'gitlab.pr.create'; url: string }
  | { ok: true; kind: 'gitlab.issue.open' }

export type ProjectWorkbenchResult = ProjectWorkbenchSuccess | (GitWorkspaceFailure & { outcome?: 'not-admitted' | 'unknown' })
export type ProjectWorkbenchApi = (input: ProjectWorkbenchInput) => Promise<ProjectWorkbenchResult>
