import { z } from 'zod'
import { teamCommandIdSchema, teamIdSchema, teamPageInputSchema } from './team-platform'

const counter = z.number().int().nonnegative().safe()
const line = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Use a single-line description')
export const teamCodeResourceScopeIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.-]+$/)
/** Remote references only. Credentials, query secrets and local paths are never accepted. */
export const teamCodeRepositoryUrlSchema = z.string().min(1).max(2048).refine((value) => {
  if (/[\s\\\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'ssh:'].includes(url.protocol) && Boolean(url.hostname)
      && !url.password && (!url.username || (url.protocol === 'ssh:' && url.username === 'git'))
      && !url.search && !url.hash && url.pathname.length > 1
      && !/%(?:00|0a|0d|5c)/i.test(url.pathname)
  } catch { return false }
}, 'Use an HTTP(S) or SSH repository URL without credentials, query or fragment')
export const teamCodeResourceSourceSchema = z.object({
  provider: z.enum(['git', 'github', 'gitlab', 'azure-devops', 'other']),
  repositoryId: z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]*$/).refine((value) => !value.split('/').some((part) => part === '.' || part === '..')),
  repositoryUrl: teamCodeRepositoryUrlSchema
}).strict()
const details = { name: line(120), purpose: line(1000), moduleDescription: line(2000) }
export const teamCodeResourceSchema = z.object({
  resourceId: teamIdSchema, projectId: teamIdSchema, ...details, source: teamCodeResourceSourceSchema,
  disabled: z.boolean(), revision: counter.min(1), createdAt: counter, updatedAt: counter
}).strict()
export const teamSpaceResourceLinkSchema = z.object({
  spaceId: teamCodeResourceScopeIdSchema, revision: counter,
  resourceIds: z.array(teamIdSchema).max(64), defaultResourceId: teamIdSchema.nullable()
}).strict()
export const teamTaskResourceSelectionSchema = z.object({
  taskId: teamCodeResourceScopeIdSchema, taskCreatedAt: z.string().min(1).max(64), spaceId: teamCodeResourceScopeIdSchema,
  resourceId: teamIdSchema.nullable(), revision: counter.min(1), selectedBy: teamIdSchema, updatedAt: counter
}).strict()
const identity = { instanceId: teamIdSchema, epoch: teamIdSchema, authorizationRevision: counter, projectId: teamIdSchema, serverTime: counter }
export const teamCodeResourceListInputSchema = teamPageInputSchema.extend({ spaceId: teamCodeResourceScopeIdSchema.optional() }).strict()
export const teamCodeResourceListSchema = z.object({
  items: z.array(teamCodeResourceSchema).max(100), nextCursor: z.string().nullable(), hasMore: z.boolean(),
  ...identity, canManage: z.boolean(), spaceResources: teamSpaceResourceLinkSchema.nullable()
}).strict()
export const teamTaskCodeResourceDtoSchema = z.object({
  ...identity, taskId: teamCodeResourceScopeIdSchema, taskCreatedAt: z.string(), taskUpdatedAt: z.string(), spaceId: teamCodeResourceScopeIdSchema,
  revision: counter, canSelect: z.boolean(), spaceRevision: counter,
  selection: teamTaskResourceSelectionSchema.nullable(), resource: teamCodeResourceSchema.nullable(),
  defaultResource: teamCodeResourceSchema.nullable(), availability: z.enum(['unconfigured', 'available', 'disabled', 'unlinked'])
}).strict()
const envelope = { commandId: teamCommandIdSchema, expectedEpoch: teamIdSchema, expectedRevision: counter }
export const teamCodeResourceCommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('create'), expectedRevision: z.literal(0), resourceId: teamIdSchema, ...details, source: teamCodeResourceSourceSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('update'), resourceId: teamIdSchema, ...details, disabled: z.boolean() }).strict(),
  z.object({ ...envelope, kind: z.literal('setSpaceResources'), spaceId: teamCodeResourceScopeIdSchema,
    resourceIds: z.array(teamIdSchema).max(64).refine((ids) => new Set(ids).size === ids.length, 'Duplicate resource'), defaultResourceId: teamIdSchema.nullable()
  }).strict().refine((value) => value.defaultResourceId === null || value.resourceIds.includes(value.defaultResourceId), 'Default resource must be linked'),
  z.object({ ...envelope, kind: z.literal('selectTaskResource'), taskId: teamCodeResourceScopeIdSchema, resourceId: teamIdSchema.nullable(),
    expectedTaskCreatedAt: z.string().min(1).max(64), expectedSpaceId: teamCodeResourceScopeIdSchema,
    expectedTaskUpdatedAt: z.string().min(1).max(64), expectedSpaceRevision: counter, expectedResourceRevision: counter.min(1).nullable()
  }).strict().refine((value) => (value.resourceId === null) === (value.expectedResourceRevision === null), 'Resource revision must match the selected resource')
])
/** Historical acknowledgement, not current resource authorization or an execution grant. */
export const teamCodeResourceReceiptSchema = z.object({
  projectId: teamIdSchema, epoch: teamIdSchema, kind: z.enum(['create', 'update', 'setSpaceResources', 'selectTaskResource']),
  targetId: teamCodeResourceScopeIdSchema, taskCreatedAt: z.string().nullable(), spaceId: teamCodeResourceScopeIdSchema.nullable(),
  deviceId: teamIdSchema.nullable(), revision: counter.min(1), committedAt: counter
}).strict()
export const teamCodeResourceCommandReplySchema = z.object({
  status: z.enum(['committed', 'duplicate']), commandId: teamCommandIdSchema, result: teamCodeResourceReceiptSchema
}).strict()
export type TeamCodeResource = z.infer<typeof teamCodeResourceSchema>
export type TeamCodeResourceCommand = z.infer<typeof teamCodeResourceCommandSchema>
export type TeamCodeResourceCommandReply = z.infer<typeof teamCodeResourceCommandReplySchema>
export type TeamCodeResourceReceipt = z.infer<typeof teamCodeResourceReceiptSchema>
export type TeamCodeResourceList = z.infer<typeof teamCodeResourceListSchema>
export type TeamSpaceResourceLink = z.infer<typeof teamSpaceResourceLinkSchema>
export type TeamTaskResourceSelection = z.infer<typeof teamTaskResourceSelectionSchema>
export type TeamTaskCodeResourceDto = z.infer<typeof teamTaskCodeResourceDtoSchema>
