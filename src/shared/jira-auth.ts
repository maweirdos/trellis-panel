import { z } from 'zod'

/** Device-authenticated creation metadata; contains no Jira or team credentials. */
export const jiraOAuthRelayCreateSchema = z.object({
  connectionId: z.string().uuid(), revision: z.number().int().positive(),
  baseUrl: z.string().url().max(2048), clientId: z.string().min(1).max(4096), redirectUri: z.string().url().max(2048)
}).strict()
export type JiraOAuthRelayCreate = z.infer<typeof jiraOAuthRelayCreateSchema>

/** Short-lived native handoff only. This claim is never a renderer input or stored connection secret. */
export const jiraOAuthRelaySchema = z.object({
  relayId: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/), state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  claimSecret: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/), redirectUri: z.string().url().max(2048), expiresAt: z.number().int().positive()
}).strict()
export type JiraOAuthRelay = z.infer<typeof jiraOAuthRelaySchema>
export const jiraOAuthRelayPollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('complete'), code: z.string().min(1).max(8192) }).strict(),
  z.object({ status: z.literal('denied') }).strict()
])
