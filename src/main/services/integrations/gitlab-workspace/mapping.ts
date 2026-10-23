import { createHash } from 'node:crypto'
import type { GitlabConflict, GitlabField, GitlabFields, GitlabIssue, GitlabMapping } from '../../../../shared/gitlab-integration'
import type { GitlabBaseline } from './types'
import type { GitlabLocalTask } from './tasks'
import { IntegrationError } from '../types'

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function comparable(field: GitlabField, value: unknown): unknown { return field === 'labels' || field === 'assignees' ? Array.isArray(value) ? [...value].sort() : value : value }
export function equal(field: GitlabField, a: unknown, b: unknown): boolean { return JSON.stringify(comparable(field, a)) === JSON.stringify(comparable(field, b)) }
/** Explicit per-field strategies translate local members without guessing team identity. */
export function remoteLocal(task: GitlabLocalTask, mapping: GitlabMapping): GitlabFields {
  return { ...task.fields, assignees: mapping.fields.includes('assignees') ? task.fields.assignees.map((local) => { const member = mapping.members.find((m) => m.local === local); if (!member) throw new IntegrationError('本地负责人未映射到 GitLab 成员', 'conflict'); return member.remote }) : [] }
}
export function mappedChanges(bindingId: string, issue: GitlabIssue, task: GitlabLocalTask, mapping: GitlabMapping, base: GitlabBaseline | undefined, direction: 'inbound' | 'bidirectional', resolutions: GitlabConflict[]) {
  const local = mapping.fields.includes('assignees') ? remoteLocal(task, mapping) : task.fields
  const inbound: Partial<GitlabFields> = {}, outbound: Partial<GitlabFields> = {}, conflicts: GitlabConflict[] = []
  for (const field of mapping.fields) {
    const remoteValue = issue.fields[field], localValue = local[field], baseValue = base?.fields[field]
    if (equal(field, remoteValue, localValue)) continue
    const previous = resolutions.find((c) => c.issue.id === issue.id && c.field === field && c.state === 'resolved' && equal(field, c.local, localValue) && equal(field, c.remote, remoteValue))
    const unresolved = resolutions.find((c) => c.issue.id === issue.id && c.field === field && c.state === 'open')
    if (unresolved && !previous) {
      conflicts.push(equal(field, unresolved.local, localValue) && equal(field, unresolved.remote, remoteValue) ? unresolved : { ...unresolved, id: digest([bindingId, issue.id, field, unresolved.base, localValue, remoteValue]), local: localValue, remote: remoteValue, createdAt: new Date().toISOString() })
      continue
    }
    if (previous?.resolution === 'remote' || base && equal(field, localValue, baseValue)) { Object.assign(inbound, { [field]: remoteValue }); continue }
    if (direction === 'bidirectional' && (previous?.resolution === 'local' || base && equal(field, remoteValue, baseValue))) { Object.assign(outbound, { [field]: localValue }); continue }
    // First attachment of an existing task also requires review of differing fields.
    conflicts.push({ id: digest([bindingId, issue.id, field, baseValue, localValue, remoteValue]), bindingId, issue: { instanceId: issue.instanceId, projectId: issue.projectId, id: issue.id, iid: issue.iid }, taskRef: task.taskRef, field, base: baseValue ?? null, local: localValue, remote: remoteValue, state: 'open', resolution: null, createdAt: new Date().toISOString() })
  }
  return { inbound, outbound, conflicts }
}
