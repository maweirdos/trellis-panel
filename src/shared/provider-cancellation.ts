import { z } from 'zod'
import { GITLAB_DAEMON } from './gitlab-integration'
import { DINGTALK_DAEMON } from './dingtalk-integration'

/** Transient reads and browser consent only. Durable job admission/cancellation,
 * messages, configuration writes and issue writes never enter this allowlist. */
export const PROVIDER_READ_METHODS = [
  GITLAB_DAEMON.snapshot, GITLAB_DAEMON.projects, GITLAB_DAEMON.members,
  GITLAB_DAEMON.inspect, GITLAB_DAEMON.previewImport, GITLAB_DAEMON.jobs,
  GITLAB_DAEMON.issueDetail, GITLAB_DAEMON.localTasks, GITLAB_DAEMON.authorizeWrites,
  DINGTALK_DAEMON.snapshot, DINGTALK_DAEMON.deliveries, DINGTALK_DAEMON.inbox,
  DINGTALK_DAEMON.queryExecution, DINGTALK_DAEMON.authorizeAccount
] as const
export const providerReadMethodSchema = z.enum(PROVIDER_READ_METHODS)
export type ProviderReadMethod = z.infer<typeof providerReadMethodSchema>
export const PROVIDER_READ_LIMITS = { entries: 128, perNamespace: 16, tombstoneMs: 10 * 60_000, readMs: 120_000, authorizationMs: 300_000, controlMs: 15_000 } as const
export function isProviderReadMethod(method: string): method is ProviderReadMethod {
  return PROVIDER_READ_METHODS.some(value => value === method)
}
export function providerReadTimeout(method: ProviderReadMethod): number {
  return method === GITLAB_DAEMON.authorizeWrites || method === DINGTALK_DAEMON.authorizeAccount ? PROVIDER_READ_LIMITS.authorizationMs : PROVIDER_READ_LIMITS.readMs
}
/** Generated only in the native facade. Neither UUID is a renderer request ID. */
export const providerReadControlSchema = z.object({ namespaceId: z.string().uuid(), requestId: z.string().uuid() }).strict()
export type ProviderReadControl = z.infer<typeof providerReadControlSchema>
/** Packed inside the existing RuntimeWire; ProviderDomain unwraps before applying
 * feature request schemas and computing the business command's retained digest. */
export const providerReadEnvelopeSchema = z.object({ providerRead: providerReadControlSchema, input: z.unknown() }).strict()
export const providerReadCancelSchema = providerReadControlSchema.extend({ method: providerReadMethodSchema }).strict()
export type ProviderReadCancel = z.infer<typeof providerReadCancelSchema>
export const providerReadCancelResultSchema = z.object({ state: z.enum(['cancel-requested', 'finished']), active: z.boolean() }).strict()
export type ProviderReadCancelResult = z.infer<typeof providerReadCancelResultSchema>
/** Native authenticated control-plane contracts, intentionally not preload APIs. */
export const providerCancellationRequests = { 'provider.read.cancel': providerReadCancelSchema } as const
export const providerCancellationResults = { 'provider.read.cancel': providerReadCancelResultSchema } as const
