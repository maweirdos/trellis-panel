import { z } from 'zod'
import { desktopOutboxStateSchema, type DesktopTeamConnection, type DesktopTeamOutbox } from '../../../shared/team-desktop'
import { desktopTeamAccountIdSchema, desktopTeamAccountSchema, desktopTeamCreateInvitationSchema, type DesktopTeamAccount } from '../../../shared/team-desktop-account'
import { teamInvitationSchema, teamInvitationTokenSchema } from '../../../shared/team-invitations'
import { teamDeviceSchema, teamFeedbackInputSchema, publicationInputSchema, type TeamFeedback, type TeamMaterialVersion, type TeamPublishedDocument } from '../../../shared/team-platform'

import { teamTransportFailureSchema } from '../../../shared/native-task-failure'
export { teamTransportFailureSchema } from '../../../shared/native-task-failure'
export type TeamTransportFailure = z.infer<typeof teamTransportFailureSchema>
export type NativePreparationPhase = 'authorization' | 'fixed-input' | 'project' | 'workflow-installation' | 'binding-publication'
export class DesktopTeamError extends Error {
  transport?: TeamTransportFailure
  preparationPhase?: NativePreparationPhase
  constructor(readonly code: string, message: string, readonly outcomeUnknown = false) { super(message); this.name = 'DesktopTeamError' }
}
export const MAX_RPC_BYTES = 3 * 1024 * 1024
export const MAX_PENDING_BYTES = 24 * 1024 * 1024
export const MAX_PENDING_COUNT = 64
export const MAX_OUTBOX_BYTES = 128 * 1024 * 1024
export const MAX_CACHE_BYTES = 64 * 1024 * 1024
export const accountSessionEnvelopeSchema = z.object({
  version: z.literal(1),
  accountId: desktopTeamAccountIdSchema,
  origin: z.string().url().max(2048),
  userId: z.string().uuid(),
  cookie: z.string().regex(/^tp_team_session=ts_[A-Za-z0-9_-]{43}$/),
  csrfToken: z.string().min(20).max(200)
}).strict()
export const accountRecordSchema = desktopTeamAccountSchema.extend({
  encryptedSession: z.string().min(1).max(32768).nullable()
}).strict().superRefine((value, context) => {
  if (value.state === 'active' && value.encryptedSession === null) context.addIssue({ code: 'custom', message: 'Active account needs its protected session' })
  if (value.state === 'signed-out' && value.encryptedSession !== null) context.addIssue({ code: 'custom', message: 'Signed-out account cannot retain a session' })
})
export type AccountSessionEnvelope = z.infer<typeof accountSessionEnvelopeSchema>
export type AccountRecord = z.infer<typeof accountRecordSchema>
export const invitationIntentEnvelopeSchema = z.object({
  version: z.literal(1),
  commandId: z.string().uuid(),
  accountId: desktopTeamAccountIdSchema,
  origin: z.string().url().max(2048),
  input: desktopTeamCreateInvitationSchema,
  token: teamInvitationTokenSchema
}).strict()
export const invitationIntentRecordSchema = z.object({
  commandId: z.string().uuid(),
  accountId: desktopTeamAccountIdSchema,
  origin: z.string().url().max(2048),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  encryptedIntent: z.string().min(1).max(65536),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
  receipt: teamInvitationSchema.nullable()
}).strict()
export type InvitationIntentEnvelope = z.infer<typeof invitationIntentEnvelopeSchema>
export type InvitationIntentRecord = z.infer<typeof invitationIntentRecordSchema>
export const organizationIntentRecordSchema = z.object({
  intentKey: z.string().regex(/^[a-f0-9]{64}$/),
  accountId: desktopTeamAccountIdSchema,
  origin: z.string().url().max(2048),
  commandId: z.string().uuid(),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe()
}).strict()
export type OrganizationIntentRecord = z.infer<typeof organizationIntentRecordSchema>
export const connectionRecordSchema = z.object({
  connectionId: z.string().uuid(), accountId: desktopTeamAccountIdSchema.nullable().default(null), approvalCommandId: z.string().uuid().nullable().default(null), origin: z.string().url().max(2048), pairingId: z.string().uuid(), deviceId: z.string().uuid(), deviceName: z.string().min(1).max(150),
  state: z.enum(['pending', 'active', 'revoked', 'expired', 'disconnected']), projectId: z.string().uuid().nullable(), ownerId: z.string().uuid().nullable(),
  userCode: z.string().regex(/^[A-Z2-9]{10}$/), verificationUri: z.string().url().max(4096), expiresAt: z.number().int().nonnegative().safe(), pollAfterMs: z.number().int().min(1).max(300000), nextPollAt: z.number().int().nonnegative().safe(),
  encryptedToken: z.string().min(1).max(32768), capabilityClaims: z.array(z.string().max(200)).max(50), sequence: z.number().int().min(-1).safe(),
  accessGeneration: z.number().int().nonnegative().safe().default(0),
  accessLocked: z.boolean(), network: z.enum(['unknown', 'reachable', 'offline']), lastCheckedAt: z.number().int().nonnegative().safe().nullable(), lastErrorCode: z.string().max(200).nullable(), remoteDevice: teamDeviceSchema.nullable()
}).strict().superRefine((value, context) => { if (value.state === 'active' && (!value.projectId || !value.ownerId)) context.addIssue({ code: 'custom', message: 'Active connection needs its approved person/project' }) })
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>
export const bindingSchema = z.object({ origin: z.string().url(), pairingId: z.string().uuid(), deviceId: z.string().uuid(), projectId: z.string().uuid(), ownerId: z.string().uuid() }).strict()
export type OutboxBinding = z.infer<typeof bindingSchema>
export type OutboxRecord = DesktopTeamOutbox & { binding: OutboxBinding; payload: z.infer<typeof publicationInputSchema> | z.infer<typeof teamFeedbackInputSchema> }
export const outboxInputSchema = z.object({ connectionId: z.string().uuid(), kind: z.enum(['publication', 'feedback']), binding: bindingSchema, payload: z.union([publicationInputSchema, teamFeedbackInputSchema]) }).strict()
export const outcomeSchema = z.object({ state: desktopOutboxStateSchema, errorCode: z.string().max(200).nullable(), receipt: z.unknown().optional() }).strict()
export type WorkerOperation = { op: string; input?: unknown }
export type WorkerRequest = WorkerOperation & { requestId: number }
export type WorkerResponse = { requestId: number; ok: true; value: unknown } | { requestId: number; ok: false; code: string; error: string }
export type TrustedTeamMaterial = {
  repositoryId: string; workspaceId: string; taskRef: string | null;
  relativePath: string; version: string; text: string; bodyDigest: string;
  kind: z.infer<typeof publicationInputSchema>['kind']
}
export type CachedDocument = { document: TeamPublishedDocument; fetchedAt: number }
export function publicConnection(value: ConnectionRecord): DesktopTeamConnection {
  const { encryptedToken: _token, sequence: _sequence, capabilityClaims: _claims, approvalCommandId: _approvalCommandId, accessGeneration: _accessGeneration, ...safe } = value
  return { ...safe, userCode: value.state === 'pending' ? value.userCode : null, verificationUri: value.state === 'pending' ? value.verificationUri : null }
}
export function publicAccount(value: AccountRecord): DesktopTeamAccount {
  const { encryptedSession: _encryptedSession, ...safe } = value
  return safe
}
export function publicOutbox(value: OutboxRecord): DesktopTeamOutbox { const { binding: _binding, payload: _payload, ...safe } = value; return safe }
export type QueueReceipt = TeamMaterialVersion | TeamFeedback
