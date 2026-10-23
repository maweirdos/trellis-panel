import { runtimeWireSchema } from './daemon-runtime'
import { GITLAB_DAEMON } from './gitlab-integration'
import { JIRA_DAEMON, JIRA_MUTATING_METHODS } from './jira-integration'
import { DINGTALK_DAEMON } from './dingtalk-integration'

/** A static allowlist projected onto the bounded native bulk envelope. Business
 * requests/results are validated inside the leased owner after unpacking. */
function wires<T extends Record<string, string>>(methods: T): { [M in T[keyof T]]: typeof runtimeWireSchema } {
  return Object.fromEntries(Object.values(methods).map(method => [method, runtimeWireSchema])) as { [M in T[keyof T]]: typeof runtimeWireSchema }
}
export const providerWireContracts = { ...wires(JIRA_DAEMON), ...wires(GITLAB_DAEMON), ...wires(DINGTALK_DAEMON) }
export type ProviderDaemonMethod = keyof typeof providerWireContracts
const gitlabWrites = ['authorizeWrites', 'linkAccount', 'unlinkAccount', 'savePlan', 'setPlanState', 'startImport', 'catchUp', 'cancelJob', 'reconcileJob', 'resolveConflict', 'recoverHook', 'createIssue', 'addComment'] as const
const dingReads = new Set(['snapshot', 'deliveries', 'inbox', 'queryExecution'])
export const PROVIDER_MUTATING_METHODS: readonly ProviderDaemonMethod[] = [
  ...JIRA_MUTATING_METHODS.map(method => JIRA_DAEMON[method]),
  ...gitlabWrites.map(method => GITLAB_DAEMON[method]),
  ...Object.entries(DINGTALK_DAEMON).filter(([method]) => !dingReads.has(method)).map(([, method]) => method)
]
