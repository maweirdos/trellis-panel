import { z } from 'zod'
import { integrationJobSchema, integrationSourceSchema, integrationWorkInputSchema } from '../integration-work'
import { nativeStateRequests, nativeStateResults, NATIVE_STATE_MUTATIONS } from '../native-state'
import { runtimeRequests, runtimeResults, RUNTIME_MUTATING_METHODS } from '../daemon-runtime'
import { providerWireContracts, PROVIDER_MUTATING_METHODS } from '../daemon-domains'
import { integrationNativeRequests, integrationNativeResults, integrationNativeMutations } from '../integration-native'
import { providerCancellationRequests, providerCancellationResults } from '../provider-cancellation'

export const DAEMON_PROTOCOL_VERSION = 1 as const
export const DAEMON_LIMITS = {
  frameBytes: 256 * 1024, pendingCalls: 16, pendingBytes: 1024 * 1024,
  controlPendingCalls: 4, controlPendingBytes: 256 * 1024, authenticationBytes: 128 * 1024,
  connections: 16, requestMs: 15_000, handshakeMs: 8_000,
  eventPage: 100, retainedEvents: 1000, jobs: 500, commands: 2000,
  jobsPerWorkspace: 8, providerConcurrency: 2, storeBytes: 8 * 1024 * 1024
} as const
export const daemonErrorCodeSchema = z.enum(['E_INVALID_ARG', 'E_DENIED', 'E_CONFLICT', 'E_UNAVAILABLE', 'E_VERSION', 'E_BUSY', 'E_IO', 'E_UNKNOWN', 'E_RESET_REQUIRED'])
export const daemonFailureSchema = z.object({ ok: z.literal(false), code: daemonErrorCodeSchema, error: z.string().max(400), outcome: z.enum(['not-admitted', 'unknown']), commandId: z.string().uuid().optional() }).strict()
export type DaemonFailure = z.infer<typeof daemonFailureSchema>
export type DaemonResult<T> = { ok: true; data: T } | DaemonFailure
export const daemonIdentitySchema = z.object({
  profileId: z.string().length(64), userId: z.string().min(1).max(256),
  mode: z.enum(['development', 'production']), appVersion: z.string().min(1).max(64),
  installationId: z.string().length(64)
}).strict()
export const processOwnerSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string().min(1).max(128), userId: z.string().min(1).max(256), executable: z.string().min(1).max(4096) }).strict()
export const workspaceGrantSchema = z.object({
  workspaceId: z.string().min(1).max(128), root: z.string().min(1).max(4096),
  grantId: z.string().uuid(), revision: z.number().int().positive().safe()
}).strict()
export const daemonPreferencesSchema = z.object({ revision: z.number().int().positive().safe(), keepRunning: z.boolean(), startup: z.enum(['client', 'login', 'manual']) }).strict()
export const eventCursorSchema = z.object({ epoch: z.string().uuid(), sequence: z.number().int().nonnegative().safe() }).strict()
/** Authenticated connection hint only. Replay/snapshots retain all actual data. */
export const daemonNotificationSchema = z.object({ type: z.literal('invalidation'), epoch: z.string().uuid(), workspaceId: z.string().min(1).max(128), source: z.enum(['runtime', 'integration']) }).strict()
export type DaemonNotification = z.infer<typeof daemonNotificationSchema>
export const daemonEventSchema = z.object({
  cursor: eventCursorSchema, workspaceId: z.string().max(128).nullable(),
  kind: z.enum(['job.changed', 'preferences.changed', 'workspace.changed', 'settings.changed', 'daemon.stopping']),
  entityId: z.string().max(128), revision: z.number().int().nonnegative().safe(), at: z.number().int().nonnegative().safe()
}).strict()
export const daemonStatusSchema = z.object({
  protocol: z.literal(DAEMON_PROTOCOL_VERSION), epoch: z.string().uuid(), identity: daemonIdentitySchema,
  owner: processOwnerSchema, state: z.enum(['running', 'stopping']),
  runtimeAuthority: z.enum(['legacy', 'daemon']), settingsAuthority: z.enum(['legacy', 'prepared', 'daemon']),
  preferences: daemonPreferencesSchema, eventCursor: eventCursorSchema,
  activeJobs: z.number().int().nonnegative(), unknownJobs: z.number().int().nonnegative(),
  capabilities: z.array(z.enum(['foundation', 'integration-jobs', 'runtime-control', 'native-protection', 'push-events'])).max(5),
  startupRegistration: z.enum(['confirmed', 'unknown', 'unavailable']).optional(), startupCommandId: z.string().uuid().optional()
}).strict()
const empty = z.object({}).strict()
/** Explicit native allowlist. Runtime/provider families are installed by their owning children. */
export const daemonPayloads = {
  ...nativeStateRequests,
  ...runtimeRequests,
  ...providerWireContracts,
  ...integrationNativeRequests,
  ...providerCancellationRequests,
  'daemon.status': empty,
  'daemon.preferences.get': empty,
  'daemon.preferences.set': z.object({ revision: z.number().int().positive().safe(), keepRunning: z.boolean(), startup: z.enum(['client', 'login', 'manual']) }).strict(),
  'daemon.startup.reconcile': z.object({ originalCommandId: z.string().uuid() }).strict(),
  'daemon.stop': z.object({ expectedOwner: processOwnerSchema, idleOnly: z.literal(true).optional() }).strict(),
  'daemon.logs': z.object({ after: z.number().int().nonnegative().safe().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  'workspace.grant': z.object({ workspaceId: z.string().min(1).max(128), root: z.string().min(1).max(4096), expectedRevision: z.number().int().nonnegative().safe() }).strict(),
  'workspace.revoke': z.object({}).strict(),
  'workspace.get': z.object({ workspaceId: z.string().min(1).max(128) }).strict(),
  'events.snapshot': empty,
  'events.subscribe': empty,
  'events.unsubscribe': empty,
  'events.replay': z.object({ after: eventCursorSchema, limit: z.number().int().min(1).max(DAEMON_LIMITS.eventPage).default(50) }).strict(),
  'jobs.enqueue': z.object({ source: integrationSourceSchema, input: integrationWorkInputSchema }).strict(),
  'jobs.get': z.object({ id: z.string().uuid() }).strict(),
  'jobs.list': z.object({ after: z.string().uuid().nullable().default(null), limit: z.number().int().min(1).max(50).default(30) }).strict(),
  'jobs.cancel': z.object({ id: z.string().uuid(), revision: z.number().int().positive().safe() }).strict(),
  'commands.get': z.object({ commandId: z.string().uuid() }).strict()
} as const
export const daemonMethodSchema = z.enum(Object.keys(daemonPayloads) as [keyof typeof daemonPayloads, ...(keyof typeof daemonPayloads)[]])
export type DaemonMethod = keyof typeof daemonPayloads
/** Separate admission budget; these methods retain their normal identity,
 * grant, command-ID and payload checks. They do not bypass authorization. */
export const DAEMON_CONTROL_METHODS: readonly DaemonMethod[] = [
  'runtime.privateCancel', 'runtime.privateEnd', 'runtime.privateRespond',
  'runtime.workcopyCleanup',
  'daemon.status', 'daemon.stop', 'workspace.get', 'provider.read.cancel', 'jobs.cancel',
  'runtime.cancel', 'runtime.end', 'runtime.handoffCancel', 'runtime.permission',
  'runtime.workflow.stop', 'runtime.workflow.cancelRevision',
  'jira.workspace.cancelRead', 'jira.workspace.cancel',
  'gitlab.workspace.cancelJob', 'dingtalk.workspace.cancelExecution'
]
export type DaemonPayload<M extends DaemonMethod> = z.input<(typeof daemonPayloads)[M]>
export const MUTATING_DAEMON_METHODS: readonly DaemonMethod[] = [...NATIVE_STATE_MUTATIONS, ...RUNTIME_MUTATING_METHODS, ...PROVIDER_MUTATING_METHODS, ...integrationNativeMutations, 'daemon.preferences.set', 'daemon.startup.reconcile', 'daemon.stop', 'workspace.grant', 'workspace.revoke', 'jobs.enqueue', 'jobs.cancel']
export const daemonRequestSchema = z.object({
  type: z.literal('request'), version: z.literal(DAEMON_PROTOCOL_VERSION), requestId: z.string().uuid(),
  commandId: z.string().uuid().optional(), expectedEpoch: z.string().uuid(),
  workspace: workspaceGrantSchema.optional(), method: daemonMethodSchema, payload: z.unknown()
}).strict()
export type DaemonRequest = z.infer<typeof daemonRequestSchema>
export const daemonResponseSchema = z.object({ type: z.literal('response'), requestId: z.string().uuid(), epoch: z.string().uuid(), result: z.union([z.object({ ok: z.literal(true), data: z.unknown() }).strict(), daemonFailureSchema]) }).strict()
export const challengeSchema = z.object({ type: z.literal('challenge'), version: z.literal(1), epoch: z.string().uuid(), nonce: z.string().length(64), identity: daemonIdentitySchema, owner: processOwnerSchema }).strict()
export const authenticateSchema = z.object({ type: z.literal('authenticate'), identity: daemonIdentitySchema, client: processOwnerSchema, proof: z.string().length(64), nativeGuiProof: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export const authenticatedSchema = z.object({ type: z.literal('authenticated'), epoch: z.string().uuid(), proof: z.string().length(64) }).strict()
export const eventPageSchema = z.object({ events: z.array(daemonEventSchema).max(DAEMON_LIMITS.eventPage), cursor: eventCursorSchema, hasMore: z.boolean(), resetRequired: z.boolean() }).strict()
export const snapshotSchema = z.object({ status: daemonStatusSchema, workspace: workspaceGrantSchema.nullable(), jobs: z.array(integrationJobSchema).max(DAEMON_LIMITS.jobsPerWorkspace), cursor: eventCursorSchema }).strict()
export const commandReceiptSchema = z.object({ commandId: z.string().uuid(), method: daemonMethodSchema, state: z.enum(['committed', 'unknown']), jobId: z.string().uuid().nullable(), committedAt: z.number().int().nonnegative().safe() }).strict()
export const daemonResults = {
  ...nativeStateResults,
  ...runtimeResults,
  ...providerWireContracts,
  ...integrationNativeResults,
  ...providerCancellationResults,
  'daemon.status': daemonStatusSchema, 'daemon.preferences.get': daemonPreferencesSchema,
  'daemon.preferences.set': daemonPreferencesSchema, 'daemon.stop': z.object({ state: z.literal('stopping') }).strict(),
  'daemon.startup.reconcile': daemonPreferencesSchema,
  'daemon.logs': z.object({ entries: z.array(z.object({ sequence: z.number(), at: z.number(), code: z.string().max(80) }).strict()).max(100), next: z.number(), resetRequired: z.boolean() }).strict(),
  'workspace.grant': workspaceGrantSchema, 'workspace.revoke': z.null(),
  'workspace.get': workspaceGrantSchema.nullable(),
  'events.snapshot': snapshotSchema, 'events.replay': eventPageSchema,
  'events.subscribe': z.object({ subscribed: z.literal(true) }).strict(), 'events.unsubscribe': z.null(),
  'jobs.enqueue': integrationJobSchema, 'jobs.get': integrationJobSchema.nullable(),
  'jobs.list': z.object({ items: z.array(integrationJobSchema).max(50), next: z.string().uuid().nullable() }).strict(),
  'jobs.cancel': integrationJobSchema, 'commands.get': commandReceiptSchema.nullable()
} as const
export type DaemonData<M extends DaemonMethod> = z.infer<(typeof daemonResults)[M]>
export type DaemonIdentity = z.infer<typeof daemonIdentitySchema>
export type ProcessOwner = z.infer<typeof processOwnerSchema>
export type WorkspaceGrant = z.infer<typeof workspaceGrantSchema>
export type DaemonStatus = z.infer<typeof daemonStatusSchema>
export type DaemonPreferences = z.infer<typeof daemonPreferencesSchema>
export type DaemonEvent = z.infer<typeof daemonEventSchema>
export type EventCursor = z.infer<typeof eventCursorSchema>
