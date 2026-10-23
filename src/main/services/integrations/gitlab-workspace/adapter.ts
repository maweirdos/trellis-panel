import { Gitlab } from '@gitbeaker/rest'
import { createRequesterFn, type FormattedResponse, type ResponseBodyTypes } from '@gitbeaker/requester-utils'
import { GITLAB_PAGE_SIZE, gitlabIssueSchema, gitlabNoteSchema, gitlabProjectSchema, gitlabUserSchema, type GitlabField, type GitlabFields, type GitlabIssue, type GitlabPermission, type GitlabProject, type GitlabUser } from '../../../../shared/gitlab-integration'
import { IntegrationError, type ResolvedConnection } from '../types'
import { integrationFetch, recordOf, rowsOf, textOf } from '../transport'

export interface GitlabCredentialPort {
  /** Owner supplies refresh-serialized token access; no secrets cross IPC. */
  accessToken(connection: ResolvedConnection): Promise<{ token: string; oauth: boolean }>
  assertCurrent(connection: ResolvedConnection): Promise<void>
}
export class GitlabRemoteError extends IntegrationError {
  constructor(readonly status: number, write = false) { super(`GitLab HTTP ${status}`, status === 401 || status === 403 ? 'denied' : write && status >= 500 ? 'uncertain' : 'upstream') }
}
function valid<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value) } catch { throw new IntegrationError('GitLab 返回不兼容的数据；未将其视为成功或空列表', 'upstream') }
}
/** Strings retain opaque bigint identities; JSON numbers must already be exact. */
export function gitlabNumericId(value: unknown): string {
  const str = textOf(value)
  if (!/^[1-9]\d{0,19}$/.test(str) || typeof value === 'number' && !Number.isSafeInteger(value)) throw new IntegrationError('GitLab 数字身份无效或已超出精确整数范围', 'upstream')
  return str
}
const integer = gitlabNumericId
function sdkInteger(value: string): number { const id = integer(value), number = Number(id); if (!Number.isSafeInteger(number)) throw new IntegrationError('GitLab SDK 此操作不支持超出精确范围的数字身份', 'invalid'); return number }
function date(value: unknown): string { const timestamp = Date.parse(textOf(value)); if (!Number.isFinite(timestamp)) throw new IntegrationError('GitLab 时间格式无效', 'upstream'); return new Date(timestamp).toISOString() }
function pageOf(value: unknown, page: number) {
  const expanded = recordOf(value), pagination = recordOf(expanded.paginationInfo), rows = rowsOf(expanded.data)
  if (rows.length > GITLAB_PAGE_SIZE || pagination.current !== page || pagination.perPage !== GITLAB_PAGE_SIZE || new Set(rows.map((row) => integer(row.id))).size !== rows.length) throw new IntegrationError('GitLab 分页身份或容量不符合请求；未将部分读取视为完成', 'upstream')
  const next = pagination.next
  if (next !== null && (typeof next !== 'number' || !Number.isSafeInteger(next) || next !== page + 1)) throw new IntegrationError('GitLab 分页游标无效', 'upstream')
  const total = pagination.total
  return { rows, hasMore: next !== null || rows.length === GITLAB_PAGE_SIZE || typeof total === 'number' && Number.isSafeInteger(total) && total > (page - 1) * GITLAB_PAGE_SIZE + rows.length }
}
export function userOf(raw: unknown): GitlabUser { const u = recordOf(raw); return valid(gitlabUserSchema, { id: integer(u.id), username: textOf(u.username), name: textOf(u.name), state: textOf(u.state) }) }
export function projectOf(raw: unknown): GitlabProject {
  const p = recordOf(raw), permissions = recordOf(p.permissions)
  const levels = [recordOf(permissions.project_access).access_level, recordOf(permissions.group_access).access_level].filter((level): level is number => typeof level === 'number' && Number.isSafeInteger(level) && level >= 0)
  return valid(gitlabProjectSchema, { id: integer(p.id), path: textOf(p.path_with_namespace), name: textOf(p.name), url: textOf(p.web_url), issuesEnabled: p.issues_enabled, accessLevel: levels.length ? Math.max(...levels) : null })
}
export function issueOf(c: ResolvedConnection, projectId: string, raw: unknown): GitlabIssue {
  const issue = recordOf(raw)
  if (integer(issue.project_id) !== projectId) throw new IntegrationError('GitLab Issue 项目身份不匹配', 'conflict')
  const sourceUrl = new URL(textOf(issue.web_url)), base = new URL(c.public.config.baseUrl)
  if (sourceUrl.origin !== base.origin || !sourceUrl.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`) || !sourceUrl.pathname.endsWith(`/issues/${String(issue.iid)}`) || issue.source_branch !== undefined || issue.target_branch !== undefined) throw new IntegrationError('GitLab Issue 来源实例或 Issue 类型不匹配', 'conflict')
  return valid(gitlabIssueSchema, { kind: 'issue', instanceId: c.instanceId, projectId, id: integer(issue.id), iid: issue.iid, url: issue.web_url, updatedAt: date(issue.updated_at), fields: { title: issue.title, description: issue.description ?? '', state: issue.state, labels: issue.labels, assignees: rowsOf(issue.assignees).map((u) => integer(u.id)).sort() }, references: { issueType: textOf(issue.issue_type) || 'issue', milestoneId: issue.milestone ? integer(recordOf(issue.milestone).id) : null, weight: typeof issue.weight === 'number' ? issue.weight : null, dueDate: typeof issue.due_date === 'string' ? issue.due_date : null, parent: issue.epic ? integer(recordOf(issue.epic).id) : null } })
}

/** Separate requester. Repository/MR transport remains GET-only. SDK retries are bypassed. */
export class GitlabIssueAdapter {
  constructor(private readonly credentials: GitlabCredentialPort) {}
  private async client(c: ResolvedConnection, signal?: AbortSignal, writePermission?: GitlabPermission) {
    await this.credentials.assertCurrent(c)
    const credential = await this.credentials.accessToken(c)
    await this.credentials.assertCurrent(c)
    const base = new URL(`${c.public.config.baseUrl.replace(/\/+$/, '')}/api/v4/`)
    const request = async <T extends ResponseBodyTypes>(endpoint: string, options: Record<string, unknown> = {}): Promise<FormattedResponse<T>> => {
      const method = textOf(options.method).toUpperCase() || 'GET'
      const write = method !== 'GET'
      if (!['GET', 'POST', 'PUT'].includes(method) || write && writePermission?.write !== 'granted') throw new IntegrationError('此操作需要明确升级并验证 GitLab api 权限', 'denied')
      const prefix = textOf(options.prefixUrl).replace(/\/+$/, '')
      const target = new URL(`${prefix}/${endpoint.replace(/^\/+/, '')}`)
      if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw new IntegrationError('GitLab 请求越过已配置实例边界', 'denied')
      // A capability requester cannot be used to mutate arbitrary SDK resources.
      if (write && !/^projects\/\d+\/(issues(?:\/\d+(?:\/notes)?)?|hooks(?:\/\d+)?)$/.test(target.pathname.slice(base.pathname.length))) throw new IntegrationError('GitLab 写操作不在 Issues/Notes/Hooks 白名单中', 'denied')
      const query = textOf(options.searchParams); if (query) target.search = query
      await this.credentials.assertCurrent(c)
      if (signal?.aborted) throw new IntegrationError('读取已取消', 'denied')
      let response: Response
      try { response = await integrationFetch(target, { method, headers: options.headers as Record<string, string> | undefined, ...(write ? { body: options.body as string | undefined } : {}), signal }) }
      catch (error) { if (error instanceof IntegrationError && !write) throw error; throw new IntegrationError(write ? 'GitLab 写入结果未知，请对账原作业' : 'GitLab 请求中断，请重试读取', write ? 'uncertain' : 'upstream') }
      if (!response.ok) throw new GitlabRemoteError(response.status, write)
      let body: unknown
      try { body = await response.json() } catch { throw new IntegrationError(write ? '写入响应不可读，需对账' : 'GitLab 返回无效 JSON', write ? 'uncertain' : 'upstream') }
      try { await this.credentials.assertCurrent(c) }
      catch (error) { if (!write) throw error; throw new IntegrationError('GitLab 已返回写入响应，但原连接已变更；请对账原作业', 'uncertain') }
      return { body: body as T, headers: Object.fromEntries(response.headers.entries()), status: response.status }
    }
    // createRequesterFn has already applied defaultOptionsHandler, including JSON body
    // and snake_case conversion. Formatting it twice would JSON-encode a string.
    const requesterFn = createRequesterFn(async (_resource, options) => ({ ...options, signal }), request)
    return new Gitlab({ host: c.public.config.baseUrl, ...(credential.oauth ? { oauthToken: credential.token } : { token: credential.token }), requesterFn, queryTimeout: 15000 })
  }
  async user(c: ResolvedConnection, signal?: AbortSignal): Promise<GitlabUser> { return userOf(await (await this.client(c, signal)).Users.showCurrentUser()) }
  async projects(c: ResolvedConnection, page: number, query: string, signal?: AbortSignal) { const result = pageOf(await (await this.client(c, signal)).Projects.all({ membership: true, search: query || undefined, page, perPage: GITLAB_PAGE_SIZE, maxPages: 1, showExpanded: true }), page); return { items: result.rows.map(projectOf), hasMore: result.hasMore } }
  async project(c: ResolvedConnection, projectId: string, signal?: AbortSignal) { const project = projectOf(await (await this.client(c, signal)).Projects.show(projectId)); if (project.id !== projectId) throw new IntegrationError('GitLab 返回的项目不是所选数字身份', 'conflict'); return project }
  async members(c: ResolvedConnection, projectId: string, page: number, signal?: AbortSignal) { const result = pageOf(await (await this.client(c, signal)).ProjectMembers.all(projectId, { includeInherited: true, page, perPage: GITLAB_PAGE_SIZE, maxPages: 1, showExpanded: true }), page); return { items: result.rows.map(userOf), hasMore: result.hasMore } }
  async member(c: ResolvedConnection, projectId: string, memberId: string, signal?: AbortSignal) { const user = userOf(await (await this.client(c, signal)).ProjectMembers.show(projectId, sdkInteger(memberId), { includeInherited: true })); if (user.id !== memberId || user.state !== 'active') throw new IntegrationError('映射的 GitLab 成员不可用', 'denied'); return user }
  async issues(c: ResolvedConnection, projectId: string, page: number, since?: string, until?: string, state = 'all', signal?: AbortSignal) {
    const result = pageOf(await (await this.client(c, signal)).Issues.all({ projectId, scope: 'all', state, updatedAfter: since, updatedBefore: until, orderBy: 'updated_at', sort: 'asc', page, perPage: GITLAB_PAGE_SIZE, maxPages: 1, showExpanded: true }), page)
    return { items: result.rows.map((r) => issueOf(c, projectId, r)), hasMore: result.hasMore }
  }
  async issue(c: ResolvedConnection, projectId: string, iid: number, signal?: AbortSignal) { const issue = issueOf(c, projectId, await (await this.client(c, signal)).Issues.show(iid, { projectId })); if (issue.iid !== iid) throw new IntegrationError('GitLab 返回的 Issue IID 不符合所选身份', 'conflict'); return issue }
  async notes(c: ResolvedConnection, projectId: string, iid: number, page: number, signal?: AbortSignal, issueId?: string) {
    const result = pageOf(await (await this.client(c, signal)).IssueNotes.all(projectId, iid, { page, perPage: GITLAB_PAGE_SIZE, maxPages: 1, orderBy: 'created_at', sort: 'asc', showExpanded: true }), page), rows = result.rows
    if (rows.some((note) => integer(note.project_id) !== projectId || note.noteable_type !== 'Issue' || integer(note.noteable_iid) !== String(iid) || issueId !== undefined && integer(note.noteable_id) !== issueId)) throw new IntegrationError('GitLab 评论不是所选 Issue 的记录', 'conflict')
    return { items: rows.map((note) => valid(gitlabNoteSchema, { id: integer(note.id), body: note.body, authorId: integer(recordOf(note.author).id), createdAt: date(note.created_at), updatedAt: date(note.updated_at), system: note.system })), hasMore: result.hasMore }
  }
  async inspect(c: ResolvedConnection, projectId?: string, signal?: AbortSignal): Promise<GitlabPermission> {
    const user = await this.user(c, signal)
    const credential = await this.credentials.accessToken(c)
    let scopes: string[] = [], scopeEvidence = '令牌范围未知；不会执行远端写入'
    try {
      const endpoint = credential.oauth ? `${c.public.config.baseUrl}/oauth/token/info` : `${c.public.config.baseUrl}/api/v4/personal_access_tokens/self`
      const response = await integrationFetch(endpoint, { headers: credential.oauth ? { Authorization: `Bearer ${credential.token}` } : { 'PRIVATE-TOKEN': credential.token }, signal })
      if (response.ok) { const body = recordOf(await response.json()); const raw = body.scopes ?? body.scope; if (Array.isArray(raw) && raw.every((s) => typeof s === 'string')) scopes = raw; else if (typeof raw === 'string') scopes = raw.split(' '); scopeEvidence = scopes.length ? '已读取当前令牌范围' : scopeEvidence }
    } catch { /* Reads still work if a legacy instance does not expose introspection. */ }
    const project = projectId ? await this.project(c, projectId, signal) : null
    await this.credentials.assertCurrent(c)
    const api = scopes.includes('api')
    return { read: 'verified', write: api ? 'granted' : scopes.length ? 'denied' : 'unknown', hooks: api && project && project.accessLevel !== null ? project.accessLevel >= 40 ? 'granted' : 'denied' : 'unknown', scopes, user, checkedAt: new Date().toISOString(), evidence: `${scopeEvidence}；${project?.accessLevel !== undefined && project.accessLevel !== null ? `项目角色级别 ${project.accessLevel}` : '项目角色尚未验证'}。具体 Issue 写权限仍由 GitLab 校验。` }
  }
  async edit(c: ResolvedConnection, issue: GitlabIssue, patch: Partial<GitlabFields>, permission: GitlabPermission, signal?: AbortSignal) {
    const client = await this.client(c, signal, permission)
    const body = await client.Issues.edit(issue.projectId, issue.iid, { ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.labels ? { labels: patch.labels.join(',') } : {}), ...(patch.assignees ? { assigneeIds: patch.assignees.map(sdkInteger) } : {}), ...(patch.state ? { stateEvent: patch.state === 'closed' ? 'close' : 'reopen' } : {}) })
    return issueOf(c, issue.projectId, body)
  }
  async create(c: ResolvedConnection, projectId: string, fields: GitlabFields, mapped: readonly GitlabField[], permission: GitlabPermission, signal?: AbortSignal) { return issueOf(c, projectId, await (await this.client(c, signal, permission)).Issues.create(projectId, fields.title, { ...(mapped.includes('description') ? { description: fields.description } : {}), ...(mapped.includes('labels') ? { labels: fields.labels.join(',') } : {}), ...(mapped.includes('assignees') ? { assigneeIds: fields.assignees.map(sdkInteger) } : {}) })) }
  async comment(c: ResolvedConnection, issue: GitlabIssue, body: string, permission: GitlabPermission, signal?: AbortSignal) {
    const note = recordOf(await (await this.client(c, signal, permission)).IssueNotes.create(issue.projectId, issue.iid, body))
    if (integer(note.project_id) !== issue.projectId || note.noteable_type !== 'Issue' || integer(note.noteable_id) !== issue.id || integer(note.noteable_iid) !== String(issue.iid) || note.body !== body) throw new IntegrationError('评论响应未证明原 Issue 上的写入', 'uncertain')
    return { id: integer(note.id) }
  }
  async hooks(c: ResolvedConnection, projectId: string, page: number, signal?: AbortSignal) { const result = pageOf(await (await this.client(c, signal)).ProjectHooks.all(projectId, { page, perPage: GITLAB_PAGE_SIZE, maxPages: 1, showExpanded: true }), page); return { items: result.rows, hasMore: result.hasMore } }
  async registerHook(c: ResolvedConnection, projectId: string, hook: { url: string; token: string; id?: string }, permission: GitlabPermission, signal?: AbortSignal) {
    if (permission.hooks !== 'granted') throw new IntegrationError('Webhook 注册要求 api 范围及 Maintainer 项目权限', 'denied')
    const client = await this.client(c, signal, permission)
    const options = { token: hook.token, issuesEvents: true, noteEvents: true, pushEvents: false, mergeRequestsEvents: false, enableSslVerification: true }
    const response = recordOf(hook.id ? await client.ProjectHooks.edit(projectId, sdkInteger(hook.id), hook.url, options) : await client.ProjectHooks.add(projectId, hook.url, options))
    const id = integer(response.id)
    if (integer(response.project_id) !== projectId || response.url !== hook.url || hook.id && id !== hook.id || response.issues_events !== true || response.note_events !== true || response.enable_ssl_verification !== true) throw new IntegrationError('Webhook 响应未证明所选项目的配置已生效', 'uncertain')
    return { id }
  }
}
