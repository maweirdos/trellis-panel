import type { JiraFields, JiraMapping, JiraField } from '../../../../../shared/jira-integration'
import { JiraWorkspaceError } from '../types'
import { digest } from '../repository'

function mapped(map: Record<string, string>, value: string, field: string): string {
  if (value === '' && field === 'assignee') return ''
  if (!Object.hasOwn(map, value)) throw new JiraWorkspaceError('E_CONFLICT', `No explicit ${field} mapping exists for ${value.slice(0, 100)}.`)
  return map[value]
}
export function inboundFields(remote: JiraFields, mapping: JiraMapping): Partial<JiraFields> {
  const result: Partial<JiraFields> = {}
  for (const field of mapping.fields) {
    if (field === 'priority') result.priority = mapped(mapping.priorities, remote.priority, field)
    else if (field === 'status') result.status = mapped(mapping.statuses, remote.status, field)
    else if (field === 'assignee') result.assignee = mapped(mapping.members, remote.assignee, field)
    else if (field === 'type') result.type = mapped(mapping.types, remote.type, field)
    else if (field === 'title') result.title = remote.title
    else if (field === 'description') result.description = remote.description
    else if (field === 'labels') result.labels = remote.labels
    else result.comments = remote.comments
  }
  return result
}
export function outboundFields(local: JiraFields, mapping: JiraMapping): Partial<JiraFields> {
  const reverse = (map: Record<string, string>): Record<string, string> => {
    const entries = Object.entries(map)
    if (new Set(entries.map(([, value]) => value)).size !== entries.length) throw new JiraWorkspaceError('E_CONFLICT', 'Outbound mapping has ambiguous reverse values. Use distinct values for bidirectional fields.')
    return Object.fromEntries(entries.map(([key, value]) => [value, key]))
  }
  return inboundFields(local, { ...mapping, priorities: mapping.fields.includes('priority') ? reverse(mapping.priorities) as JiraMapping['priorities'] : {}, statuses: mapping.fields.includes('status') ? reverse(mapping.statuses) : {}, members: mapping.fields.includes('assignee') ? reverse(mapping.members) : {}, types: mapping.fields.includes('type') ? reverse(mapping.types) : {} })
}
export function equal(a: unknown, b: unknown): boolean { return digest(a) === digest(b) }
/** Comparison uses each side's own base; mapping changes require an explicit new baseline. */
export function fieldDecision(field: JiraField, local: JiraFields, remote: JiraFields, base: { local: JiraFields; remote: JiraFields } | null): 'unchanged' | 'inbound' | 'outbound' | 'conflict' {
  if (!base) return 'inbound'
  const localChanged = !equal(local[field], base.local[field]); const remoteChanged = !equal(remote[field], base.remote[field])
  return localChanged && remoteChanged ? 'conflict' : localChanged ? 'outbound' : remoteChanged ? 'inbound' : 'unchanged'
}
