import { z } from 'zod'
import { IpcErrorCode } from './ipc-errors'

const root = z.string().max(8192)
const count = z.number().int().nonnegative()
const observedAt = z.number().int().nonnegative()

/** Counts describe the discovered repository, including when root is a subdirectory. */
export const conversationGitStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['branch', 'detached', 'unborn']), root,
    repositoryRoot: z.string().min(1).max(8192),
    branch: z.string().min(1).max(1024).nullable(),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
    staged: count, unstaged: count, untracked: count, conflicts: z.boolean(), observedAt
  }).strict(),
  z.object({ state: z.literal('not-git'), root, observedAt }).strict(),
  z.object({ state: z.literal('error'), root, code: z.enum(IpcErrorCode), error: z.string().min(1).max(1000), observedAt }).strict()
])

export type ConversationGitStatus = z.infer<typeof conversationGitStatusSchema>
