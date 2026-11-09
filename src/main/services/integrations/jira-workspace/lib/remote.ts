import { z } from 'zod'
import type { JiraConfig } from '../../../../../shared/types'
import { JIRA_LIMITS, jiraIssueSchema, jiraMetadataSchema, jiraNumericIdSchema, type JiraIssueRecord, type JiraData } from '../../../../../shared/jira-integration'
import { jiraV2Assignable, jiraV2Comments, jiraV2Fields, jiraV2Issue, jiraV2Myself, jiraV2Permissions, jiraV2Priorities, jiraV2Projects, jiraV2ProjectStatuses, jiraV2SearchPage, jiraV2ServerInfo, type JiraFetchOptions } from '../../../jira'
import { jiraOptions } from '../../providers/jira-auth'
import { jiraConfig } from '../../legacy'
import { recordOf, rowsOf, textOf } from '../../transport'
import type { ResolvedConnection } from '../../types'
import { JiraWorkspaceError } from '../types'

const pageSchema = z.object({ startAt: z.number().int().nonnegative(), total: z.number().int().nonnegative().optional(), issues: z.array(z.unknown()).max(50) })
function date(value: unknown): number | null { const ms = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) && ms >= 0 ? ms : null }
function bounded(value: unknown, max: number, warnings: string[], label: string): string {
  const text = textOf(value)
  if (text.length > max) warnings.push(`${label} exceeds the supported limit; a bounded source sample was retained.`)
  return text.slice(0, max)
}
export function normalizeIssue(raw: unknown, instanceId: string, baseUrl: string): JiraIssueRecord {
  const issue = recordOf(raw); const fields = recordOf(issue.fields); const warnings: string[] = []
  const comment = recordOf(fields.comment); const rawComments = rowsOf(comment.comments ?? [])
  const histories = recordOf(issue.changelog)
  const custom: Record<string, unknown> = {}
  const customFields = Object.entries(fields).filter(([key]) => /^customfield_\d+$/.test(key))
  if (customFields.length > 50) warnings.push('More than 50 custom fields exist; retained references are explicitly partial.')
  if (Array.isArray(fields.attachment) && fields.attachment.length > 100) warnings.push('Attachment references exceed 100; use the source issue for full coverage.')
  for (const [key, value] of customFields.slice(0, 50)) {
    const text = JSON.stringify(value)
    if (text && text.length <= 4000) custom[key] = value
    else warnings.push(`${key} was too large to retain; use the source issue.`)
  }
  const comments = rawComments.slice(0, 100).map((item) => ({ id: textOf(item.id), body: bounded(item.body, 16000, warnings, 'Comment'), author: textOf(recordOf(item.author).name), updatedAt: date(item.updated) }))
  const description = fields.description === null || fields.description === undefined ? null : typeof fields.description === 'string' ? bounded(fields.description, JIRA_LIMITS.recordBytes, warnings, 'Description') : null
  if (fields.description !== null && fields.description !== undefined && typeof fields.description !== 'string') warnings.push('Description is not Server 8.1 text; preserved through the source link only.')
  const history = Array.isArray(histories.histories) ? histories.histories.slice(0, 100) : []
  const historyComplete = typeof histories.total === 'number' && histories.total === history.length && Number(histories.startAt ?? 0) === 0
  return jiraIssueSchema.parse({
    instanceId, issueId: textOf(issue.id), key: textOf(issue.key), projectId: textOf(recordOf(fields.project).id),
    url: `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(textOf(issue.key))}`, updatedAt: date(fields.updated),
    fields: { title: textOf(fields.summary), description, priority: textOf(recordOf(fields.priority).id), status: textOf(recordOf(fields.status).id), assignee: textOf(recordOf(fields.assignee).name), labels: rowsOrStrings(fields.labels), type: textOf(recordOf(fields.issuetype).id), comments },
    references: { parentId: fields.parent ? textOf(recordOf(fields.parent).id) : null, attachments: rowsOf(fields.attachment ?? []).slice(0, 100).map((item) => ({ id: textOf(item.id), name: textOf(item.filename).slice(0, 512) })), custom },
    coverage: { commentsComplete: typeof comment.total === 'number' && comment.total === comments.length && Number(comment.startAt ?? 0) === 0, historyComplete, history, warnings: warnings.slice(0, 30) }
  })
}
function rowsOrStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new JiraWorkspaceError('E_UPSTREAM', 'Jira labels are malformed or unavailable.')
  return value.map(String).sort()
}
export class JiraRemote {
  readonly cfg: JiraConfig
  readonly options: JiraFetchOptions
  constructor(readonly connection: ResolvedConnection, signal?: AbortSignal) {
    if (connection.public.providerId !== 'jira' || !connection.public.enabled || !(connection.public.config.authMethod === 'oauth2' ? connection.secrets.oauthTokens : connection.public.config.authMethod === 'token' ? connection.secrets.token : connection.secrets.password)) throw new JiraWorkspaceError('E_DENIED', 'An enabled Jira connection with protected credentials is required.')
    this.cfg = jiraConfig(connection)
    let base: URL
    try { base = new URL(this.cfg.baseUrl) } catch { throw new JiraWorkspaceError('E_INVALID_ARG', 'Configured Jira instance URL is invalid.') }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new JiraWorkspaceError('E_DENIED', 'Jira instance URL must not contain embedded credentials or request parameters.')
    this.options = jiraOptions(connection, signal)
  }
  async issue(issueId: string, includeHistory = false): Promise<JiraIssueRecord> {
    jiraNumericIdSchema.parse(issueId)
    const issue = normalizeIssue(await jiraV2Issue(this.cfg, issueId, includeHistory, this.options), this.connection.instanceId, this.cfg.baseUrl)
    if (issue.issueId !== issueId) throw new JiraWorkspaceError('E_CONFLICT', 'Jira numeric issue identity changed across the read.')
    if (!issue.coverage.commentsComplete) {
      const comments: JiraIssueRecord['fields']['comments'] = []
      let startAt = 0; let complete = false
      for (let page = 0; page < 2; page++) {
        const raw = recordOf(await jiraV2Comments(this.cfg, issueId, startAt, this.options))
        const items = rowsOf(raw.comments)
        if (raw.startAt !== startAt || items.length > 50) throw new JiraWorkspaceError('E_UPSTREAM', 'Jira comment pagination is inconsistent.')
        for (const item of items) comments.push({ id: textOf(item.id), body: bounded(item.body, 16000, issue.coverage.warnings, 'Comment'), author: textOf(recordOf(item.author).name), updatedAt: date(item.updated) })
        startAt += items.length
        if (typeof raw.total === 'number' && startAt >= raw.total) { complete = true; break }
        if (!items.length) break
      }
      issue.fields.comments = comments; issue.coverage.commentsComplete = complete
    }
    if (includeHistory && !issue.coverage.historyComplete) issue.coverage.warnings.push('Server 8.1 changelog expansion is partial; no complete-history claim is made.')
    issue.coverage.warnings = issue.coverage.warnings.slice(0, 30)
    return jiraIssueSchema.parse(issue)
  }
  async search(jql: string, maxItems: number): Promise<{ items: JiraIssueRecord[]; total: number | null; complete: boolean }> {
    const items: JiraIssueRecord[] = []; const seen = new Set<string>(); let startAt = 0; let total: number | null = null; let stable = true
    while (items.length < maxItems) {
      const page = pageSchema.parse(await jiraV2SearchPage(this.cfg, { jql, startAt, maxResults: Math.min(JIRA_LIMITS.pageSize, maxItems - items.length) }, this.options))
      if (page.startAt !== startAt) throw new JiraWorkspaceError('E_UPSTREAM', 'Jira did not return the requested page offset.')
      if (total !== null && total !== page.total) stable = false
      total = page.total ?? null
      for (const raw of page.issues) {
        const issue = normalizeIssue(raw, this.connection.instanceId, this.cfg.baseUrl)
        if (seen.has(issue.issueId)) { stable = false; continue }
        seen.add(issue.issueId); items.push(issue)
      }
      startAt += page.issues.length
      if (!page.issues.length || total !== null && startAt >= total) break
    }
    return { items, total, complete: stable && total !== null && items.length === total }
  }
  async page(jql: string, afterId: string | null): Promise<{ items: JiraIssueRecord[]; total: number | null; complete: boolean }> {
    const filter = jql.replace(/\s+ORDER\s+BY\s+id\s+ASC\s*$/i, '')
    if (/\bORDER\s+BY\b/i.test(filter)) throw new JiraWorkspaceError('E_INVALID_ARG', 'Retained import query has unsupported ordering.')
    const page = pageSchema.parse(await jiraV2SearchPage(this.cfg, { jql: `${filter}${afterId ? ` AND id > ${afterId}` : ''} ORDER BY id ASC`, startAt: 0, maxResults: JIRA_LIMITS.pageSize }, this.options))
    const items = page.issues.map((item) => normalizeIssue(item, this.connection.instanceId, this.cfg.baseUrl))
    if (page.startAt !== 0 || items.some((item, index) => afterId && Number(item.issueId) <= Number(afterId) || index > 0 && Number(item.issueId) <= Number(items[index - 1].issueId))) throw new JiraWorkspaceError('E_UPSTREAM', 'Jira did not return a monotonic numeric-ID page.')
    return { items, total: page.total ?? null, complete: typeof page.total === 'number' && items.length === page.total }
  }
  async permissions(projectId: string, issueId?: string): Promise<Record<string, boolean>> {
    const raw = recordOf(await jiraV2Permissions(this.cfg, { projectId, issueId }, this.options)); const permissions = recordOf(raw.permissions)
    if (!Object.keys(permissions).length) throw new JiraWorkspaceError('E_UPSTREAM', 'Jira permissions were not returned.')
    return Object.fromEntries(Object.entries(permissions).map(([key, value]) => {
      const permission = recordOf(value)
      if (typeof permission.havePermission !== 'boolean') throw new JiraWorkspaceError('E_UPSTREAM', 'Jira permission result is malformed.')
      return [key, permission.havePermission]
    }))
  }
  async discover(projectId: string, query: string): Promise<JiraData<'discover'>> {
    const myself = recordOf(await jiraV2Myself(this.cfg, this.options))
    if (myself.active !== true || !textOf(myself.name)) throw new JiraWorkspaceError('E_DENIED', 'Jira did not return an active authenticated account.')
    const projects = rowsOf(await jiraV2Projects(this.cfg, this.options))
    if (!projects.some((project) => textOf(project.id) === projectId)) throw new JiraWorkspaceError('E_DENIED', 'The configured Jira project is not visible to this account.')
    const fields = rowsOf(await jiraV2Fields(this.cfg, this.options))
    const statuses = rowsOf(await jiraV2ProjectStatuses(this.cfg, projectId, this.options))
    const members = rowsOf(await jiraV2Assignable(this.cfg, projectId, query, this.options))
    const permissions = await this.permissions(projectId)
    const priorities = rowsOf(await jiraV2Priorities(this.cfg, this.options)).map((priority) => ({ id: textOf(priority.id), name: textOf(priority.name) }))
    const server = recordOf(await jiraV2ServerInfo(this.cfg, this.options))
    const allStatuses = new Map<string, { id: string; name: string }>()
    for (const type of statuses) for (const status of rowsOf(type.statuses)) allStatuses.set(textOf(status.id), { id: textOf(status.id), name: textOf(status.name) })
    return jiraMetadataSchema.parse({ instanceId: this.connection.instanceId, authenticatedUser: { id: textOf(myself.key) || textOf(myself.name), name: textOf(myself.name), displayName: textOf(myself.displayName) }, version: textOf(server.version), deployment: textOf(server.deploymentType), projects: projects.map((project) => ({ id: textOf(project.id), key: textOf(project.key), name: textOf(project.name) })), fields: fields.map((field) => ({ id: textOf(field.id), name: textOf(field.name), custom: field.custom === true })), statuses: [...allStatuses.values()], issueTypes: statuses.map((type) => ({ id: textOf(type.id), name: textOf(type.name) })), priorities, members: members.map((member) => ({ id: textOf(member.key) || textOf(member.name), name: textOf(member.name), displayName: textOf(member.displayName) })), membersHasMore: members.length === 50, permissions, warnings: ['Project permission is not proof that every issue/screen is editable.', 'Scheduled polling is available; webhook readiness requires a separately verified reachable receiver.'] })
  }
}
