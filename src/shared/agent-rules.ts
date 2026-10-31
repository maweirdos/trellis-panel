import { z } from 'zod'
import { governanceVersionSchema } from './team-governance'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const MAX_AGENT_RULE_SOURCES = 24
/** Native task ownership only; never an ordinary new-session renderer argument. */
export const teamTaskRulesContextSchema = z.object({
  taskId: z.string().min(1).max(200), spaceId: z.string().min(1).max(200),
  inputVersion: hash, workcopyTaskKey: hash.optional()
}).strict()
export type TeamTaskRulesContext = z.infer<typeof teamTaskRulesContextSchema>
export const teamRuleSelectionSchema = z.object({
  path: z.string().min(1).max(2048), version: governanceVersionSchema,
  status: z.enum(['included', 'partial', 'index-only', 'omitted']),
  reason: z.enum(['source-limit', 'byte-limit', 'context-budget']).optional()
}).strict()
export const teamTaskRulesManifestSchema = teamTaskRulesContextSchema.extend({
  taskDir: z.string().min(1).max(200), taskCreatedAt: z.string().min(1).max(100),
  operationId: z.string().min(1).max(256), localTaskId: z.string().min(1).max(256),
  bundle: z.object({ id: z.string().uuid(), revision: z.number().int().positive().safe(), digest: hash }).strict().optional(),
  selected: z.array(teamRuleSelectionSchema).max(65)
}).strict()
export type TeamTaskRulesManifest = z.infer<typeof teamTaskRulesManifestSchema>
export const agentRuleEntrySchema = z.object({
  path: z.string().min(1).max(2048), source: z.enum(['project', 'team']),
  version: hash.nullable(), declaredVersion: z.string().max(256).optional(),
  includedDigest: hash.nullable(), includedBytes: z.number().int().nonnegative(),
  includedChars: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(), status: z.enum(['included', 'index-only'])
}).strict()
export const agentRulesManifestSchema = z.object({
  version: z.literal(1), projectRootKey: hash,
  entries: z.array(agentRuleEntrySchema).max(MAX_AGENT_RULE_SOURCES), digest: hash,
  teamTask: teamTaskRulesManifestSchema.optional()
}).strict()
export type AgentRuleEntry = z.infer<typeof agentRuleEntrySchema>
export type AgentRulesManifest = z.infer<typeof agentRulesManifestSchema>
