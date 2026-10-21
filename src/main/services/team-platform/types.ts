import { z } from 'zod'
import { desktopOutboxStateSchema, type DesktopTeamConnection, type DesktopTeamOutbox } from '../../../shared/team-desktop'
import { teamDeviceSchema, teamFeedbackInputSchema, publicationInputSchema, type TeamFeedback, type TeamMaterialVersion, type TeamPublishedDocument } from '../../../shared/team-platform'

export class DesktopTeamError extends Error {
  constructor(readonly code: string, message: string, readonly outcomeUnknown = false) { super(message); this.name = 'DesktopTeamError' }
}
export const MAX_RPC_BYTES = 3 * 1024 * 1024
export const MAX_PENDING_BYTES = 24 * 1024 * 1024
export const MAX_PENDING_COUNT = 64
export const MAX_OUTBOX_BYTES = 128 * 1024 * 1024
export const MAX_CACHE_BYTES = 64 * 1024 * 1024
export const connectionRecordSchema = z.object({
  connectionId: z.string().uuid(), origin: z.string().url().max(2048), pairingId: z.string().uuid(), deviceId: z.string().uuid(), deviceName: z.string().min(1).max(150),
  state: z.enum(['pending', 'active', 'revoked', 'expired', 'disconnected']), projectId: z.string().uuid().nullable(), ownerId: z.string().uuid().nullable(),
  userCode: z.string().regex(/^[A-Z2-9]{10}$/), verificationUri: z.string().url().max(4096), expiresAt: z.number().int().nonnegative().safe(), pollAfterMs: z.number().int().min(1).max(300000), nextPollAt: z.number().int().nonnegative().safe(),
  encryptedToken: z.string().min(1).max(32768), capabilityClaims: z.array(z.string().max(200)).max(50), sequence: z.number().int().min(-1).safe(),
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
  const { encryptedToken: _token, sequence: _sequence, capabilityClaims: _claims, ...safe } = value
  return { ...safe, userCode: value.state === 'pending' ? value.userCode : null, verificationUri: value.state === 'pending' ? value.verificationUri : null }
}
export function publicOutbox(value: OutboxRecord): DesktopTeamOutbox { const { binding: _binding, payload: _payload, ...safe } = value; return safe }
export type QueueReceipt = TeamMaterialVersion | TeamFeedback
