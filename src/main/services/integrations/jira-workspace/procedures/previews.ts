import { randomUUID } from 'node:crypto'
import { parse } from 'csv-parse/sync'
import type { WorkspaceGrant } from '../../../../../shared/daemon'
import type { IntegrationSource } from '../../../../../shared/integration-work'
import { JIRA_LIMITS, jiraIssueSchema, type JiraIssueRecord, type JiraMapping, type JiraPreview, type JiraRequest } from '../../../../../shared/jira-integration'
import { JiraWorkspaceRepository, digest } from '../repository'
import { JiraWorkspaceError, type JiraWorkspaceAuthority } from '../types'
import { JiraRemote } from '../lib/remote'
import { inboundFields } from '../lib/mapping'

export class JiraPreviews {
  constructor(private readonly repository: JiraWorkspaceRepository, private readonly authority: JiraWorkspaceAuthority) {}
  private retain(grant: WorkspaceGrant, source: IntegrationSource, items: JiraIssueRecord[], input: { format: 'api' | 'csv'; query: string; mapping: JiraMapping; includeHistory: boolean; total: number | null; complete: boolean; warnings: string[]; upperIssueId: string | null }): JiraPreview {
    this.authority.assertGrant(grant)
    if (items.some((issue) => issue.instanceId !== source.instanceId || issue.projectId !== source.remoteProjectId) || new Set(items.map((issue) => issue.issueId)).size !== items.length) throw new JiraWorkspaceError('E_CONFLICT', 'Preview contains foreign-project or duplicate numeric issue identities.')
    for (const issue of items) inboundFields(issue.fields, input.mapping)
    const now = Date.now()
    const preview = { id: randomUUID(), workspaceId: grant.workspaceId, source, format: input.format, scope: input.format === 'api' ? 'full-query' as const : 'csv-records' as const, upperIssueId: input.upperIssueId, createdAt: now, expiresAt: now + JIRA_LIMITS.previewMs, mapping: input.mapping, includeHistory: input.includeHistory, query: input.query, total: input.total, count: items.length, complete: input.complete, warnings: input.warnings.slice(0, 50), sample: items.slice(0, 3) }
    const value = { ...preview, digest: digest({ preview, workspace: grant, items }) }
    this.repository.retainPreview({ preview: value, workspace: grant, items })
    return value
  }
  async api(grant: WorkspaceGrant, input: JiraRequest<'previewApi'>, signal?: AbortSignal): Promise<JiraPreview> {
    const connection = await this.authority.resolve(grant, input.source)
    const remote = new JiraRemote(connection, signal)
    // Parenthesized JQL keeps the selected project mandatory even with OR clauses.
    const filter = input.jql.trim() || 'id > 0'
    if (/\bORDER\s+BY\b/i.test(filter)) throw new JiraWorkspaceError('E_INVALID_ARG', 'Preview JQL is a filter; ordering is supplied by the importer.')
    const base = `project = ${input.source.remoteProjectId} AND (${filter})`
    const highest = await remote.search(`${base} ORDER BY id DESC`, 1)
    const upperIssueId = highest.items[0]?.issueId ?? null
    const jql = `${base}${upperIssueId ? ` AND id <= ${upperIssueId}` : ' AND id < 0'} ORDER BY id ASC`
    const page = await remote.search(jql, input.maxItems)
    const items: JiraIssueRecord[] = []
    for (const item of page.items) { items.push(await remote.issue(item.issueId, input.includeHistory)); this.authority.assertGrant(grant) }
    await this.authority.resolve(grant, input.source)
    signal?.throwIfAborted()
    const warnings = items.flatMap((issue) => issue.coverage.warnings)
    if (!page.complete) warnings.unshift('Preview is a bounded sample. The job pages the entire selected query up to the retained numeric-ID high-water mark. Source edits/deletions may change coverage and will be reported.')
    return this.retain(grant, input.source, items, { format: 'api', query: jql, mapping: input.mapping, includeHistory: input.includeHistory, total: page.total, complete: page.complete, warnings, upperIssueId })
  }
  async csv(grant: WorkspaceGrant, input: JiraRequest<'previewCsv'>, signal?: AbortSignal): Promise<JiraPreview> {
    const connection = await this.authority.resolve(grant, input.source)
    signal?.throwIfAborted()
    for (const field of ['priority', 'status', 'assignee', 'labels', 'type'] as const) if (input.mapping.fields.includes(field) && !input.columns[field]) throw new JiraWorkspaceError('E_INVALID_ARG', `Mapped CSV field ${field} needs an explicit source column.`)
    if (Buffer.byteLength(input.csv, 'utf8') > JIRA_LIMITS.csvBytes) throw new JiraWorkspaceError('E_INVALID_ARG', 'CSV exceeds the native byte limit.')
    let rows: unknown
    try { rows = parse(input.csv, { bom: true, columns: false, cast: false, skip_empty_lines: true, skip_records_with_error: false, relax_column_count: false, max_record_size: JIRA_LIMITS.recordBytes }) }
    catch { throw new JiraWorkspaceError('E_INVALID_ARG', 'CSV is malformed or contains an oversized record. No rows were skipped or imported.') }
    if (!Array.isArray(rows) || rows.length < 2 || rows.length > JIRA_LIMITS.previewItems + 1 || rows.some((row) => !Array.isArray(row) || row.some((cell) => typeof cell !== 'string'))) throw new JiraWorkspaceError('E_INVALID_ARG', 'CSV must contain a header and 1–500 text records.')
    const table = rows as string[][]; const headers = table[0]
    if (headers.length > 100 || headers.some((header) => !header || header.length > 200) || new Set(headers).size !== headers.length) throw new JiraWorkspaceError('E_INVALID_ARG', 'CSV headers must be nonempty, unique and bounded.')
    for (const column of Object.values(input.columns)) if (column && !headers.includes(column)) throw new JiraWorkspaceError('E_INVALID_ARG', `CSV column ${column.slice(0, 100)} is missing.`)
    const items = table.slice(1).map((row, index) => {
      if (row.length !== headers.length) throw new JiraWorkspaceError('E_INVALID_ARG', `CSV row ${index + 2} has an inconsistent column count.`)
      const cell = (field: keyof typeof input.columns): string => input.columns[field] ? row[headers.indexOf(input.columns[field])] : ''
      const updated = cell('updated') ? Date.parse(cell('updated')) : null
      if (updated !== null && (!Number.isFinite(updated) || updated < 0)) throw new JiraWorkspaceError('E_INVALID_ARG', `CSV row ${index + 2} contains an invalid timestamp.`)
      return jiraIssueSchema.parse({ instanceId: input.source.instanceId, issueId: cell('issueId'), key: cell('key'), projectId: input.source.remoteProjectId, url: `${connection.public.config.baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(cell('key'))}`, updatedAt: updated, fields: { title: cell('title'), description: input.columns.description ? cell('description') : null, priority: cell('priority'), status: cell('status'), assignee: cell('assignee'), labels: cell('labels') ? cell('labels').split(';').map((label) => label.trim()).filter(Boolean).sort() : [], type: cell('type'), comments: [] }, references: { parentId: null, attachments: [], custom: {} }, coverage: { commentsComplete: false, historyComplete: false, history: [], warnings: ['CSV identity and content are user-supplied; they are not a verified remote issue snapshot.'] } })
    })
    if (input.mapping.fields.includes('comments')) throw new JiraWorkspaceError('E_INVALID_ARG', 'CSV does not carry verified comment history; remove the comments mapping.')
    return this.retain(grant, input.source, items, { format: 'csv', query: 'CSV file (explicit source instance/project)', mapping: input.mapping, includeHistory: false, total: items.length, complete: true, warnings: ['CSV uses numeric Issue ID + selected instance identity. Labels are separated with semicolons. No remote writes or history import are implied.'], upperIssueId: null })
  }
}
