import type { JiraFetchOptions } from '../../jira'
import { integrationFetch } from '../transport'
import type { ResolvedConnection } from '../types'
import { jiraAuthorizationHeader } from './jira-authorization'

/** Keep the captured connection revision, but resolve its protected grant per HTTP request. */
export function jiraOptions(connection: ResolvedConnection, signal?: AbortSignal): JiraFetchOptions {
  return { transport: integrationFetch, signal, authorization: () => jiraAuthorizationHeader(connection, signal) }
}
