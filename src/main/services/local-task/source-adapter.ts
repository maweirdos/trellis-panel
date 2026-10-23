import { jiraSourceMatch } from '../../../shared/jira-source'
import { issueIdentifierOf, type TaskMetaOnDisk } from './operations'
import {
  META_JIRA_INSTANCE_ID, META_JIRA_ISSUE_ID, META_JIRA_ISSUE_KEY,
  META_SOURCE_PROVIDER, META_SOURCE_INSTANCE_ID, META_SOURCE_ID, META_SOURCE_KEY, META_SOURCE_URL,
  type LocalTaskImportInput
} from './types'

/** Source Strategy: all providers reuse the same creation/receipt/recovery pipeline. */
export interface LocalTaskSourceAdapter {
  readonly label: string
  readonly kind: 'jira' | 'gitlab' | 'dingtalk'
  identifier(input: LocalTaskImportInput): string
  remoteId(input: LocalTaskImportInput): string | number
  linkKey(input: LocalTaskImportInput): string
  compatible(meta: TaskMetaOnDisk): boolean
  stableMatch(meta: TaskMetaOnDisk, input: LocalTaskImportInput): boolean
  differentId(meta: TaskMetaOnDisk, input: LocalTaskImportInput): boolean
  match(meta: TaskMetaOnDisk, input: LocalTaskImportInput): ReturnType<typeof jiraSourceMatch>
  metadata(input: LocalTaskImportInput): Array<[string, string]>
}

const jiraAdapter: LocalTaskSourceAdapter = {
  label: 'Jira', kind: 'jira',
  identifier: (input) => issueIdentifierOf(input.issueId ?? null, input.issueKey),
  remoteId: (input) => input.issueId ?? input.issueKey,
  linkKey: (input) => `${input.instanceId}#${input.issueId ?? input.issueKey}`,
  compatible: (meta) => meta.sourceProvider === null || meta.sourceProvider === 'jira',
  // Keep unknown namespaces as candidates so key moves cannot bypass ambiguity checks.
  stableMatch: (meta, input) => input.issueId != null && meta.jiraIssueId === String(input.issueId) &&
    jiraSourceMatch(meta.jiraInstanceId, meta.jiraUrl, input.instanceId, input.url) !== 'other',
  differentId: (meta, input) => input.issueId != null && meta.jiraIssueId !== null && meta.jiraIssueId !== String(input.issueId),
  match: (meta, input) => meta.sourceProvider !== null && meta.sourceProvider !== 'jira'
    ? 'other' : jiraSourceMatch(meta.jiraInstanceId, meta.jiraUrl, input.instanceId, input.url),
  metadata(input) {
    const values: Array<[string, string]> = [[META_JIRA_INSTANCE_ID, input.instanceId], [META_JIRA_ISSUE_KEY, input.issueKey]]
    if (input.issueId != null) values.push([META_JIRA_ISSUE_ID, String(input.issueId)])
    return values
  }
}

function externalAdapter(provider: 'gitlab' | 'dingtalk', label: string): LocalTaskSourceAdapter {
  const id = (input: LocalTaskImportInput): string => {
    if (input.externalSource?.provider !== provider) throw new Error('External source does not match its registered task adapter')
    return input.externalSource.id
  }
  return {
    label, kind: provider,
    identifier: (input) => `source:${provider}:${id(input)}`,
    remoteId: id,
    // New provider links have no historical delimiter format to preserve.
    linkKey: (input) => externalSourceLinkKey(provider, input.instanceId, id(input)),
    compatible: (meta) => meta.sourceProvider === provider,
    stableMatch: (meta, input) => meta.sourceProvider === provider && meta.sourceId === id(input) &&
      (!meta.sourceInstanceId || meta.sourceInstanceId === input.instanceId),
    differentId: (meta, input) => meta.sourceProvider === provider && meta.sourceId !== null && meta.sourceId !== id(input),
    match(meta, input) {
      if (meta.sourceProvider !== provider) return 'other'
      if (!meta.sourceInstanceId || !meta.sourceId) return 'ambiguous'
      return meta.sourceInstanceId === input.instanceId && meta.sourceId === id(input) ? 'same' : 'other'
    },
    metadata: (input) => [
      [META_SOURCE_PROVIDER, provider], [META_SOURCE_INSTANCE_ID, input.instanceId],
      [META_SOURCE_ID, id(input)], [META_SOURCE_KEY, input.issueKey],
      ...(input.url ? [[META_SOURCE_URL, input.url] as [string, string]] : [])
    ]
  }
}
const sourceAdapters = {
  jira: jiraAdapter,
  gitlab: externalAdapter('gitlab', 'GitLab'),
  dingtalk: externalAdapter('dingtalk', '钉钉')
} satisfies Record<string, LocalTaskSourceAdapter>

export function taskSourceAdapter(input: LocalTaskImportInput): LocalTaskSourceAdapter {
  return sourceAdapters[input.externalSource?.provider ?? 'jira']
}

/** Canonical association identity shared by import and explicit remote-create repair. */
export function externalSourceLinkKey(provider: 'gitlab' | 'dingtalk', instanceId: string, id: string): string {
  return JSON.stringify([provider, instanceId, id])
}
