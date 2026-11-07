import { z } from 'zod'
import { teamCommandIdSchema, teamDigestSchema, teamIdSchema } from './team-platform'
import { teamTaskRefSchema } from './team-task-execution'

const jiraInstanceId = z.string().trim().min(1).max(256)
const jiraIssueId = z.string().regex(/^[1-9]\d{0,14}$/).refine(value => Number.isSafeInteger(Number(value)), 'Jira issue ID exceeds the safe integer range')
const jiraIssueKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/).max(64)
const revision = z.number().int().nonnegative().safe()

export const jiraBusinessIssueSchema = z.object({
  instanceId: jiraInstanceId,
  issueId: jiraIssueId,
  issueKey: jiraIssueKey.nullable(),
  remoteProjectId: jiraIssueId
}).strict()
export type JiraBusinessIssue = z.infer<typeof jiraBusinessIssueSchema>

export const jiraBusinessTaskMappingSchema = z.object({
  mappingId: teamIdSchema,
  projectId: teamIdSchema,
  issue: jiraBusinessIssueSchema,
  task: teamTaskRefSchema,
  revision: revision.min(1),
  createdAt: revision,
  updatedAt: revision
}).strict()
export type JiraBusinessTaskMapping = z.infer<typeof jiraBusinessTaskMappingSchema>

export const jiraBusinessMappingCommandSchema = z.object({
  contractVersion: z.literal(1),
  commandId: teamCommandIdSchema,
  projectId: teamIdSchema,
  issue: jiraBusinessIssueSchema,
  task: teamTaskRefSchema,
  expectedRevision: revision,
  expectedEpoch: teamIdSchema
}).strict()
export type JiraBusinessMappingCommand = z.infer<typeof jiraBusinessMappingCommandSchema>

export const jiraBusinessEventKindSchema = z.enum(['intake', 'status-sync'])
export type JiraBusinessEventKind = z.infer<typeof jiraBusinessEventKindSchema>

/**
 * A recorded platform event is not proof that a protected Jira worker reached
 * the provider. The provider outcome stays pending until that worker reports
 * evidence through its own durable command receipt.
 */
export const jiraBusinessEffectSchema = z.object({
  contractVersion: z.literal(1),
  effectId: teamIdSchema,
  eventKind: jiraBusinessEventKindSchema,
  projectId: teamIdSchema,
  issue: jiraBusinessIssueSchema,
  task: teamTaskRefSchema,
  providerJobId: teamCommandIdSchema,
  providerCommandId: teamCommandIdSchema,
  payloadDigest: teamDigestSchema,
  state: z.literal('recorded'),
  providerOutcome: z.literal('unconfirmed'),
  recordedAt: revision
}).strict()
export type JiraBusinessEffect = z.infer<typeof jiraBusinessEffectSchema>

export const jiraBusinessEventCommandSchema = z.object({
  contractVersion: z.literal(1),
  commandId: teamCommandIdSchema,
  effectId: teamIdSchema,
  eventKind: jiraBusinessEventKindSchema,
  projectId: teamIdSchema,
  issue: jiraBusinessIssueSchema,
  task: teamTaskRefSchema,
  expectedMappingRevision: revision.min(1),
  expectedEpoch: teamIdSchema,
  providerJobId: teamCommandIdSchema,
  providerCommandId: teamCommandIdSchema,
  payloadDigest: teamDigestSchema
}).strict()
export type JiraBusinessEventCommand = z.infer<typeof jiraBusinessEventCommandSchema>

export const jiraBusinessMappingQuerySchema = z.object({
  projectId: teamIdSchema,
  instanceId: jiraInstanceId,
  issueId: jiraIssueId
}).strict()
export type JiraBusinessMappingQuery = z.infer<typeof jiraBusinessMappingQuerySchema>

export const jiraBusinessEffectQuerySchema = z.object({
  projectId: teamIdSchema,
  effectId: teamIdSchema
}).strict()
export type JiraBusinessEffectQuery = z.infer<typeof jiraBusinessEffectQuerySchema>

