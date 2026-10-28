/** Desktop transport DTOs contain no protected credential or local source grant. */
import { z } from 'zod'
import { deviceEnrollmentInputSchema, teamCommandIdSchema, teamFeedbackInputSchema, teamIdSchema, teamMaterialKindSchema, teamVisibilitySchema, type TeamDevice, type TeamEventPage, type TeamFeedback, type TeamMaterialVersion, type TeamPage, type TeamPerson, type TeamProject, type TeamPublishedDocument } from './team-platform'

export const desktopConnectionIdSchema = z.string().uuid()
export const desktopPairingInputSchema = deviceEnrollmentInputSchema.extend({ origin: z.string().min(1).max(2048) }).strict()
export const desktopPublicationBaseSchema = z.object({ connectionId: desktopConnectionIdSchema, commandId: teamCommandIdSchema, materialId: teamIdSchema, title: z.string().trim().min(1).max(300), visibility: teamVisibilitySchema, expectedVersion: z.number().int().positive().nullable() }).strict()
export const desktopAuthoredPublicationSchema = desktopPublicationBaseSchema.extend({ kind: teamMaterialKindSchema, text: z.string().min(1).max(1024 * 1024), sourceVersion: z.string().min(1).max(512) }).strict()
export const desktopFeedbackInputSchema = teamFeedbackInputSchema.extend({ connectionId: desktopConnectionIdSchema }).strict()
export const desktopDocumentInputSchema = z.object({ connectionId: desktopConnectionIdSchema, materialId: teamIdSchema, version: z.number().int().positive(), allowOffline: z.boolean().default(false) }).strict()
export const desktopListInputSchema = z.object({ connectionId: desktopConnectionIdSchema, cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict()
export const desktopVersionsInputSchema = desktopListInputSchema.extend({ materialId: teamIdSchema }).strict()
export const desktopFeedbackListSchema = desktopVersionsInputSchema.extend({ version: z.number().int().positive() }).strict()
export const desktopOutboxStateSchema = z.enum(['queued', 'dispatching', 'acknowledgement-unknown', 'committed', 'conflict', 'access-revoked', 'cancelled-before-dispatch'])
export type DesktopTeamConnection = {
  connectionId: string; origin: string; pairingId: string; deviceId: string; deviceName: string;
  state: 'pending' | 'active' | 'revoked' | 'expired' | 'disconnected'; projectId: string | null; ownerId: string | null;
  userCode: string | null; verificationUri: string | null; expiresAt: number; pollAfterMs: number; nextPollAt: number;
  accessLocked: boolean; network: 'unknown' | 'reachable' | 'offline'; lastCheckedAt: number | null; lastErrorCode: string | null;
  /** This is an observed server snapshot, never a live-socket or execution claim. */
  remoteDevice: TeamDevice | null
}
export type DesktopTeamPairing = { connection: DesktopTeamConnection; browser: 'opened' | 'unavailable' }
export type DesktopOutboxState = z.infer<typeof desktopOutboxStateSchema>
export type DesktopTeamOutbox = {
  commandId: string; connectionId: string; kind: 'publication' | 'feedback'; state: DesktopOutboxState;
  materialId: string; version: number | null; title: string | null; createdAt: number; updatedAt: number;
  payloadDigest: string; lastErrorCode: string | null; attempts: number;
  /** Access loss does not resolve a previously dispatched remote outcome. */
  outcomeUnknown: boolean;
  reconciliation: 'not-checked' | 'missing-at-read-point' | 'committed'; reconciledAt: number | null;
  receipt: TeamMaterialVersion | TeamFeedback | null
}
export type DesktopTeamDocument = { document: TeamPublishedDocument; freshness: 'remote' | 'cached-offline'; fetchedAt: number; authorization: 'current-server' | 'last-observed' }
export type DesktopTeamOutboxPage = TeamPage<DesktopTeamOutbox>
export type DesktopTeamSnapshot = { items: TeamMaterialVersion[]; fetchedAt: number; stale: boolean; authorization: 'last-observed'; resetRequired: boolean; eventsHasMore: boolean }
export type DesktopTeamEventSync = { page: TeamEventPage; snapshotRequired: boolean }
export type DesktopTeamConnectionContext = { person: TeamPerson; project: TeamProject }
export type DesktopAuthoredPublicationInput = z.infer<typeof desktopAuthoredPublicationSchema>
export type DesktopMaterialPublicationInput = z.infer<typeof desktopPublicationBaseSchema>
export type DesktopFeedbackInput = z.infer<typeof desktopFeedbackInputSchema>
export type DesktopPairingInput = z.infer<typeof desktopPairingInputSchema>
/** Native service transport only. Do not project these identity-bearing methods into preload. */
export interface DesktopTeamProgressTransport {
  hifoxTaskProgress(connectionId: string, taskId: string, expectedInstanceId?: string): Promise<import('./team-task-progress').TeamTaskProgressDto>
  hifoxTaskProgressCommand(connectionId: string, taskId: string, command: import('./team-task-progress').TeamTaskProgressCommand, expectedInstanceId: string): Promise<import('./team-task-progress').TeamTaskProgressCommandReply>
  hifoxTaskProgressReceipt(connectionId: string, taskId: string, commandId: string): Promise<import('./team-task-progress').TeamTaskProgressReceipt | null>
}
export interface DesktopTeamApi {
  connections(): Promise<DesktopTeamConnection[]>
  connectionContext(connectionId: string): Promise<DesktopTeamConnectionContext>
  beginPairing(input: DesktopPairingInput): Promise<DesktopTeamPairing>
  openPairing(connectionId: string): Promise<void>
  pollPairing(connectionId: string): Promise<DesktopTeamConnection>
  disconnect(connectionId: string): Promise<DesktopTeamConnection>
  heartbeat(connectionId: string): Promise<DesktopTeamConnection>
  queueAuthoredPublication(input: DesktopAuthoredPublicationInput): Promise<DesktopTeamOutbox>
  queueFeedback(input: DesktopFeedbackInput): Promise<DesktopTeamOutbox>
  outbox(connectionId: string, options?: { cursor?: string; limit?: number }): Promise<DesktopTeamOutboxPage>
  cancelQueued(commandId: string): Promise<DesktopTeamOutbox>
  dispatch(commandId: string, options?: { retryUnknown?: boolean }): Promise<DesktopTeamOutbox>
  reconcile(commandId: string): Promise<DesktopTeamOutbox>
  readDocument(input: z.input<typeof desktopDocumentInputSchema>): Promise<DesktopTeamDocument>
  listMaterials(input: z.input<typeof desktopListInputSchema>): Promise<TeamPage<TeamMaterialVersion>>
  listVersions(input: z.input<typeof desktopVersionsInputSchema>): Promise<TeamPage<TeamMaterialVersion>>
  listFeedback(input: z.input<typeof desktopFeedbackListSchema>): Promise<TeamPage<TeamFeedback>>
  syncEvents(connectionId: string): Promise<DesktopTeamEventSync>
  refreshSharedSnapshot(connectionId: string): Promise<DesktopTeamSnapshot>
  cachedSnapshot(connectionId: string): Promise<DesktopTeamSnapshot | null>
}
