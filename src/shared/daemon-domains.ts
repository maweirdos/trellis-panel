import { runtimeWireSchema } from './daemon-runtime'
import { GITLAB_DAEMON } from './gitlab-integration'
import { JIRA_DAEMON, JIRA_MUTATING_METHODS } from './jira-integration'
import { DINGTALK_DAEMON } from './dingtalk-integration'
import { FEISHU_DAEMON } from './feishu-integration'
import type { z } from 'zod'

/** Project parser signatures per key so generic routing keeps the schema output
 * correlation without the full Zod schema's polymorphic `this` surface. */
export type ProviderSchemaParser<T> = {
  parse(value: unknown): T
  safeParse(value: unknown): z.ZodSafeParseResult<T>
}
export type ProviderSchemaParsers<S> = { readonly [M in keyof S]: ProviderSchemaParser<z.output<S[M]>> }

/** A static allowlist projected onto the bounded native bulk envelope. Business
 * requests/results are validated inside the leased owner after unpacking. */
function wires<T extends Record<string, string>>(methods: T): { [M in T[keyof T]]: typeof runtimeWireSchema } {
  return Object.fromEntries(Object.values(methods).map(method => [method, runtimeWireSchema])) as { [M in T[keyof T]]: typeof runtimeWireSchema }
}
export const providerWireContracts = { ...wires(JIRA_DAEMON), ...wires(GITLAB_DAEMON), ...wires(DINGTALK_DAEMON), ...wires(FEISHU_DAEMON) }
export type ProviderDaemonMethod = keyof typeof providerWireContracts
const gitlabWrites = ['authorizeWrites', 'linkAccount', 'unlinkAccount', 'savePlan', 'setPlanState', 'startImport', 'catchUp', 'cancelJob', 'reconcileJob', 'resolveConflict', 'recoverHook', 'createIssue', 'addComment'] as const
const dingReads = new Set(['snapshot', 'deliveries', 'inbox', 'queryExecution'])
export const PROVIDER_MUTATING_METHODS: readonly ProviderDaemonMethod[] = [
  ...JIRA_MUTATING_METHODS.map(method => JIRA_DAEMON[method]),
  ...gitlabWrites.map(method => GITLAB_DAEMON[method]),
  ...Object.entries(DINGTALK_DAEMON).filter(([method]) => !dingReads.has(method)).map(([, method]) => method),
  FEISHU_DAEMON.connectOrganization, FEISHU_DAEMON.configure, FEISHU_DAEMON.retry,
  FEISHU_DAEMON.disconnect, FEISHU_DAEMON.unlinkAccount, FEISHU_DAEMON.reconcile
]
