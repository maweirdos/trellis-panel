import type { JiraFields } from '../../../../../shared/jira-integration'
import { jiraV2AddComment, jiraV2Create, jiraV2CreateMeta, jiraV2EditMeta, jiraV2Transitions, jiraV2Update, jiraTransitionVerified, type JiraV2WriteFields } from '../../../jira'
import { recordOf, rowsOf, textOf } from '../../transport'
import { JiraWorkspaceError } from '../types'
import { JiraRemote } from './remote'

const fieldNames = { title: 'summary', description: 'description', priority: 'priority', assignee: 'assignee', labels: 'labels', type: 'issuetype' } as const
/** Only mapped supported fields are translated; status/comments have separate guarded operations. */
function fieldsFor(input: Partial<JiraFields>, metadata: Record<string, unknown>): JiraV2WriteFields {
  const result: JiraV2WriteFields = {}
  for (const [field, remoteName] of Object.entries(fieldNames)) {
    if (!(field in input)) continue
    const meta = recordOf(metadata[remoteName])
    if (!Object.keys(meta).length || Array.isArray(meta.operations) && !meta.operations.includes('set')) throw new JiraWorkspaceError('E_DENIED', `The Jira issue screen does not permit mapped field ${remoteName}.`)
    const value = input[field as keyof JiraFields]
    if (remoteName === 'summary' && typeof value === 'string') result.summary = value
    if (remoteName === 'description' && (typeof value === 'string' || value === null)) result.description = value
    if (remoteName === 'labels' && Array.isArray(value)) result.labels = value as string[]
    if (remoteName === 'assignee' && typeof value === 'string') result.assignee = value ? { name: value } : null
    if ((remoteName === 'priority' || remoteName === 'issuetype') && typeof value === 'string') {
      const allowed = rowsOf(meta.allowedValues)
      if (!allowed.some((item) => textOf(item.id) === value)) throw new JiraWorkspaceError('E_DENIED', `Mapped ${remoteName} is not available for this issue screen.`)
      result[remoteName] = { id: value }
    }
  }
  return result
}
export async function prepareUpdate(remote: JiraRemote, projectId: string, issueId: string, desired: Partial<JiraFields>): Promise<JiraV2WriteFields> {
  const permissions = await remote.permissions(projectId, issueId)
  if (!permissions.EDIT_ISSUES || 'assignee' in desired && !permissions.ASSIGN_ISSUES) throw new JiraWorkspaceError('E_DENIED', 'This issue does not grant the requested edit/assignment permission.')
  const metadata = recordOf(await jiraV2EditMeta(remote.cfg, issueId, remote.options))
  return fieldsFor(desired, recordOf(metadata.fields))
}
export async function applyUpdate(remote: JiraRemote, issueId: string, fields: JiraV2WriteFields): Promise<void> { await jiraV2Update(remote.cfg, issueId, fields, remote.options) }
export async function prepareCreate(remote: JiraRemote, projectId: string, desired: Partial<JiraFields>): Promise<JiraV2WriteFields & { summary: string; issuetype: { id: string } }> {
  if (!(await remote.permissions(projectId)).CREATE_ISSUES) throw new JiraWorkspaceError('E_DENIED', 'Jira project does not grant issue creation.')
  if (!desired.title || !desired.type) throw new JiraWorkspaceError('E_INVALID_ARG', 'Outbound creation requires explicitly mapped title and issue type.')
  const raw = recordOf(await jiraV2CreateMeta(remote.cfg, projectId, remote.options))
  const project = rowsOf(raw.projects).find((item) => textOf(item.id) === projectId)
  const type = rowsOf(recordOf(project).issuetypes).find((item) => textOf(item.id) === desired.type)
  if (!type) throw new JiraWorkspaceError('E_DENIED', 'Mapped Jira issue type is not available for creation.')
  const metadata = recordOf(type.fields)
  // issuetype allowedValues is not supplied by every create screen; selected type is already verified.
  const creationFields = { ...desired }; delete creationFields.type
  const result = fieldsFor(creationFields, Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'issuetype')))
  result.issuetype = { id: desired.type }
  for (const [name, value] of Object.entries(metadata)) if (recordOf(value).required === true && !['project', 'issuetype', 'summary'].includes(name) && !(name in result) && recordOf(value).hasDefaultValue !== true) throw new JiraWorkspaceError('E_DENIED', `Required Jira create field ${name.slice(0, 100)} has no supported mapping.`)
  if (!result.summary) throw new JiraWorkspaceError('E_INVALID_ARG', 'A mapped title is required.')
  return { ...result, summary: result.summary, issuetype: result.issuetype }
}
export async function applyCreate(remote: JiraRemote, projectId: string, fields: JiraV2WriteFields & { summary: string; issuetype: { id: string } }): Promise<string> {
  const raw = recordOf(await jiraV2Create(remote.cfg, projectId, fields, remote.options))
  if (!/^[1-9]\d{0,14}$/.test(textOf(raw.id))) throw new JiraWorkspaceError('E_UNKNOWN', 'Jira create response did not confirm a numeric issue ID. Do not retry creation.')
  return textOf(raw.id)
}
export async function prepareTransition(remote: JiraRemote, projectId: string, issueId: string, transitionId: string, targetId: string): Promise<string> {
  if (!(await remote.permissions(projectId, issueId)).TRANSITION_ISSUES) throw new JiraWorkspaceError('E_DENIED', 'This issue does not grant transition permission.')
  const raw = recordOf(await jiraV2Transitions(remote.cfg, issueId, remote.options))
  const transition = rowsOf(raw.transitions).find((item) => textOf(item.id) === transitionId && textOf(recordOf(item.to).id) === targetId)
  if (!transition || Object.values(recordOf(transition.fields)).some((field) => recordOf(field).required === true && recordOf(field).hasDefaultValue !== true)) throw new JiraWorkspaceError('E_DENIED', 'The mapped transition is unavailable or needs unsupported required input.')
  return textOf(recordOf(transition.to).name)
}
export async function applyTransition(remote: JiraRemote, issueId: string, transitionId: string, targetName: string): Promise<void> {
  const result = await jiraTransitionVerified(remote.cfg, issueId, transitionId, { ...remote.options, expectedToStatus: targetName })
  if (!result.ok || result.statusMismatch || !['re-read', 'already_applied'].includes(result.verified ?? '')) throw new JiraWorkspaceError('E_UNKNOWN', 'Jira transition has not been confirmed. Reconcile the original issue before another write.')
}
export async function applyComment(remote: JiraRemote, issueId: string, body: string, receiptId: string): Promise<string> {
  const result = recordOf(await jiraV2AddComment(remote.cfg, issueId, `${body}\n\n[trellis-jira-receipt:${receiptId}]`, remote.options))
  const id = textOf(result.id)
  if (!id) throw new JiraWorkspaceError('E_UNKNOWN', 'Jira did not confirm the comment identity.')
  return id
}
