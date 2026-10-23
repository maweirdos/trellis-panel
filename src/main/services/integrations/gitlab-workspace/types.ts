import { z } from 'zod'
import { integrationAccountSchema } from '../../../../shared/integration-work'
import { gitlabBindingSchema, gitlabConflictSchema, gitlabFieldsSchema, gitlabIssueSchema, gitlabNoteSchema, gitlabPermissionSchema, gitlabPreviewSchema } from '../../../../shared/gitlab-integration'

const date = z.string().datetime({ offset: true })
export const baselineSchema = z.object({ bindingId: z.string(), issue: gitlabIssueSchema, taskRef: z.string(), localRevision: z.string(), fields: gitlabFieldsSchema, noteCursor: z.number().int().positive(), notesAfter: date.nullable(), notesComplete: z.boolean() }).strict()
/** Effect records extend a common daemon job, never schedule or replace that job. */
export const effectSchema = z.object({ id: z.string(), jobId: z.string().uuid(), bindingId: z.string(), kind: z.enum(['edit', 'create', 'note', 'hook']), state: z.enum(['prepared', 'confirmed', 'rejected', 'unknown']), issue: gitlabIssueSchema.nullable(), patch: gitlabFieldsSchema.partial().nullable(), taskRef: z.string().nullable(), expectedLocalRevision: z.string().nullable(), remoteId: z.string().nullable(), body: z.string().max(10000).nullable(), at: date }).strict()
export const gitlabStateSchema = z.object({
  version: z.literal(1), bindings: z.array(gitlabBindingSchema).max(100),
  accounts: z.array(z.object({ account: integrationAccountSchema, instanceId: z.string(), ownerId: z.string(), verifiedRevision: z.number().int().positive() }).strict()).max(100),
  permissions: z.array(z.object({ connectionId: z.string(), revision: z.number(), instanceId: z.string(), projectId: z.string().nullable(), permission: gitlabPermissionSchema }).strict()).max(100),
  previews: z.array(gitlabPreviewSchema).max(20), baselines: z.array(baselineSchema).max(3000),
  conflicts: z.array(gitlabConflictSchema).max(1000), effects: z.array(effectSchema).max(3000),
  hookEvents: z.array(z.object({ id: z.string(), bodyDigest: z.string().length(64), bindingId: z.string(), commandId: z.string().uuid(), at: date }).strict()).max(2000),
  notes: z.array(z.object({ bindingId: z.string(), issueId: z.string(), note: gitlabNoteSchema }).strict()).max(5000),
  failures: z.array(z.object({ jobId: z.string().uuid(), issueId: z.string(), detail: z.string().max(400), at: date }).strict()).max(3000),
  intents: z.array(z.object({ commandId: z.string().uuid(), digest: z.string().length(64), bindingId: z.string(), bindingRevision: z.number().int().positive(), kind: z.enum(['create', 'note']), taskRef: z.string(), localRevision: z.string(), fields: gitlabFieldsSchema.nullable(), issue: gitlabIssueSchema.nullable(), body: z.string().max(10000).nullable() }).strict()).max(500)
}).strict()
export type GitlabState = z.infer<typeof gitlabStateSchema>
export type GitlabBaseline = z.infer<typeof baselineSchema>
export type GitlabEffect = z.infer<typeof effectSchema>
