import { z } from 'zod'
import { workspaceGrantSchema, type WorkspaceGrant } from '../../../../shared/daemon'
import { integrationAccountSchema, integrationSourceSchema } from '../../../../shared/integration-work'
import { jiraConflictSchema, jiraDiagnosticSchema, jiraFieldsSchema, jiraIssueSchema, jiraItemReceiptSchema, jiraPlanSchema, jiraPreviewSchema } from '../../../../shared/jira-integration'
import type { IntegrationSource } from '../../../../shared/integration-work'
import type { ResolvedConnection } from '../types'
import { teamTaskRefSchema } from '../../../../shared/team-task-execution'
import { resolve } from 'node:path'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const localSnapshotSchema = z.object({
  taskRef: z.string().max(256), dir: z.string().max(512), operationId: z.string().max(128).nullable(),
  hash, treeHash: hash, fields: jiraFieldsSchema, sourceIssueId: z.string().nullable(), sourceInstanceId: z.string().nullable()
}).strict()
export const baselineSchema = z.object({
  planId: z.string().max(128), instanceId: z.string().max(128), issueId: z.string().max(128), key: z.string().max(64), taskRef: z.string().max(256),
  local: jiraFieldsSchema, remote: jiraFieldsSchema, remoteUpdatedAt: z.number().nullable(), revision: z.number().int().positive()
}).strict()
export const executionReceiptSchema = z.object({
  receipt: jiraItemReceiptSchema, workspace: workspaceGrantSchema, source: integrationSourceSchema,
  before: localSnapshotSchema.nullable(), after: localSnapshotSchema.nullable(),
  expectedLocal: jiraFieldsSchema.partial().nullable(),
  expectedRemote: jiraFieldsSchema.partial().nullable(), issue: jiraIssueSchema.nullable(),
  platformTask: teamTaskRefSchema.nullable().optional(),
  /** Exact artifact tree recorded only when this invocation proved creation. */
  ownedTree: hash.nullable(), rollbackCommandId: z.string().uuid().nullable(), quarantine: z.string().max(512).nullable()
}).strict()
export const previewMaterialSchema = z.object({ preview: jiraPreviewSchema, workspace: workspaceGrantSchema, items: z.array(jiraIssueSchema).max(500) }).strict()
export const repositoryStateSchema = z.object({
  version: z.literal(1),
  sources: z.array(z.object({ workspace: workspaceGrantSchema, source: integrationSourceSchema, name: z.string().max(256) }).strict()).max(100),
  accounts: z.array(z.object({ workspace: workspaceGrantSchema, account: integrationAccountSchema, instanceId: z.string().max(128), connectionRevision: z.number().int().positive(), personalConnectionId: z.string().max(128), personalConnectionRevision: z.number().int().positive(), username: z.string().max(200) }).strict()).max(100),
  plans: z.array(z.object({ workspace: workspaceGrantSchema, value: jiraPlanSchema }).strict()).max(100),
  previews: z.array(jiraPreviewSchema).max(100),
  baselines: z.array(baselineSchema).max(5000), receipts: z.array(executionReceiptSchema).max(5000),
  conflicts: z.array(z.object({ workspaceId: z.string().max(128), value: jiraConflictSchema }).strict()).max(1000),
  diagnostics: z.array(z.object({ workspaceId: z.string().max(128), value: jiraDiagnosticSchema }).strict()).max(1000)
}).strict().superRefine((state, context) => {
  for (const values of [state.plans.map((item) => item.value.plan.id), state.receipts.map((item) => item.receipt.id), state.previews.map((item) => item.id), state.baselines.map((item) => `${item.planId}:${item.issueId}:${item.taskRef}`)]) {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'Duplicate Jira repository identity' })
  }
})
export type JiraRepositoryState = z.infer<typeof repositoryStateSchema>
export type JiraBaseline = z.infer<typeof baselineSchema>
export type JiraExecutionReceipt = z.infer<typeof executionReceiptSchema>
export type JiraLocalSnapshot = z.infer<typeof localSnapshotSchema>
export type JiraPreviewMaterial = z.infer<typeof previewMaterialSchema>
/** Implemented by the daemon settings/credential owner. Never GUI-global current root. */
export interface JiraWorkspaceAuthority {
  /** Resolve an existing authorized native root; renderer input cannot create a workspace grant. */
  context(expectedRoot: string): Promise<WorkspaceGrant>
  capture(input: { expectedRoot: string; workspaceId?: string }): Promise<WorkspaceGrant>
  assertGrant(grant: WorkspaceGrant): void
  resolve(grant: WorkspaceGrant, source: IntegrationSource): Promise<ResolvedConnection>
  /** Read from the protected credential owner; no plaintext fallback or renderer secret roundtrip. */
  resolvePersonalConnection(grant: WorkspaceGrant, input: { connectionId: string; connectionRevision: number }): Promise<ResolvedConnection>
  resolveBindingConnection(grant: WorkspaceGrant, input: { connectionId: string; connectionRevision: number; bindingId: string; bindingRevision: number }): Promise<ResolvedConnection>
}
/** Host mounts only an authenticated reachable receiver; the provider never opens a public listener. */
export interface JiraCallbackPort {
  inspect(grant: WorkspaceGrant, input: { receiverId: string; source: IntegrationSource }): Promise<{ ready: boolean; detail: string; lastVerifiedAt: number | null }>
  recover(grant: WorkspaceGrant, input: { receiverId: string; source: IntegrationSource; commandId: string }): Promise<{ ready: boolean; detail: string }>
  /** Verify vendor authentication, exact source and durable replay identity before admitting catch-up. */
  verify(input: { receiverId: string; headers: Readonly<Record<string, string>>; body: Uint8Array }): Promise<{ source: IntegrationSource; eventId: string; commandId: string; issueId: string; verifiedAt: number }>
}
export class JiraWorkspaceError extends Error {
  constructor(readonly code: 'E_INVALID_ARG' | 'E_CONFLICT' | 'E_DENIED' | 'E_UNAVAILABLE' | 'E_IO' | 'E_UNKNOWN' | 'E_BUSY' | 'E_UPSTREAM', message: string) { super(message) }
}
export function sameGrant(a: WorkspaceGrant, b: WorkspaceGrant): boolean { return a.workspaceId === b.workspaceId && a.root === b.root && a.grantId === b.grantId && a.revision === b.revision }
export function sameRoot(a: string, b: string): boolean { const key = (root: string): string => process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root); return key(a) === key(b) }
