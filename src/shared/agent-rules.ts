import { z } from 'zod'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const MAX_AGENT_RULE_SOURCES = 24
export const agentRuleEntrySchema = z.object({
  path: z.string().min(1).max(2048), source: z.enum(['project', 'team']),
  version: hash.nullable(), declaredVersion: z.string().max(256).optional(),
  includedDigest: hash.nullable(), includedBytes: z.number().int().nonnegative(),
  includedChars: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(), status: z.enum(['included', 'index-only'])
}).strict()
export const agentRulesManifestSchema = z.object({
  version: z.literal(1), projectRootKey: hash,
  entries: z.array(agentRuleEntrySchema).max(MAX_AGENT_RULE_SOURCES), digest: hash
}).strict()
export type AgentRuleEntry = z.infer<typeof agentRuleEntrySchema>
export type AgentRulesManifest = z.infer<typeof agentRulesManifestSchema>
