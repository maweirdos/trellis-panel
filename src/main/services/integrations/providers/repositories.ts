import { Gitlab } from '@gitbeaker/rest'
import { createRequesterFn, defaultOptionsHandler, type FormattedResponse, type ResponseBodyTypes } from '@gitbeaker/requester-utils'
import { externalObjectSchema, type ExternalObject, type PageResult, type RemoteRepository } from '../../../../shared/integrations'
import type { RepositoryPort, ResolvedConnection } from '../types'
import { IntegrationError } from '../types'
import { integrationFetch, readRemoteJson, recordOf, remoteUrl, rowsOf, textOf } from '../transport'
import { getGitlabAccessToken } from '../../gitlab'
import { getSettings } from '../../store'
import { gitlabOAuthAccessToken } from './gitlab-authorization'

const SIZE = 30
function pageOf<T>(items: T[], page: number): PageResult<T> { return { items, page, hasMore: items.length === SIZE } }
function repositoryOf(raw: Record<string, unknown>, nameKey: string, urlKey: string): RemoteRepository {
  const result = { id: textOf(raw.id), name: textOf(raw.name), fullName: textOf(raw[nameKey]), url: remoteUrl(raw[urlKey]) }
  if (!result.id || !result.fullName || !result.url) throw new IntegrationError('远端仓库缺少身份或来源链接', 'upstream')
  return result
}
function pullOf(c: ResolvedConnection, repo: string, raw: Record<string, unknown>, gitlab = false): ExternalObject {
  const result = externalObjectSchema.safeParse({ providerId: c.public.providerId, instanceId: c.instanceId, repository: repo, kind: 'pull_request', id: textOf(raw.id), number: Number(gitlab ? raw.iid : raw.number), title: textOf(raw.title), state: textOf(raw.state), url: remoteUrl(gitlab ? raw.web_url : raw.html_url), sourceBranch: textOf(gitlab ? raw.source_branch : recordOf(raw.head).ref), targetBranch: textOf(gitlab ? raw.target_branch : recordOf(raw.base).ref) })
  if (!result.success) throw new IntegrationError('远端 PR / MR 缺少必要字段或返回了不兼容格式', 'upstream')
  return result.data
}
async function github(c: ResolvedConnection) {
  const { Octokit } = await import('@octokit/rest')
  return new Octokit({ auth: c.secrets.token, baseUrl: c.public.config.baseUrl || 'https://api.github.com', request: { fetch: integrationFetch } })
}
export const githubPort: RepositoryPort = {
  async inspect(c) { const client = await github(c); const r = await client.users.getAuthenticated(); return r.data.login },
  async repositories(c, page, query) {
    const client = await github(c)
    if (query.trim()) {
      const user = await client.users.getAuthenticated()
      const r = await client.search.repos({ q: `${query.trim()} user:${user.data.login}`, per_page: SIZE, page })
      return { ...pageOf(rowsOf(r.data.items).map((v) => repositoryOf(v, 'full_name', 'html_url')), page), hasMore: page * SIZE < r.data.total_count }
    }
    const r = await client.repos.listForAuthenticatedUser({ per_page: SIZE, page, sort: 'updated' })
    return pageOf(rowsOf(r.data).map((v) => repositoryOf(v, 'full_name', 'html_url')), page)
  },
  async pullRequests(c, repo, page) {
    const parts = repo.split('/')
    if (parts.length !== 2 || !parts.every(Boolean)) throw new IntegrationError('GitHub 仓库格式应为 owner/repository')
    const client = await github(c)
    const r = await client.pulls.list({ owner: parts[0], repo: parts[1], state: 'all', per_page: SIZE, page, sort: 'updated' })
    return pageOf(rowsOf(r.data).map((v) => pullOf(c, repo, v)), page)
  }
}
async function gitlab(c: ResolvedConnection) {
  const oauth = c.public.legacy || c.public.config.authMethod === 'oauth2'
  const token = c.public.legacy ? await getGitlabAccessToken(getSettings().gitlab) : oauth ? await gitlabOAuthAccessToken(c) : c.secrets.token
  if (!token) throw new IntegrationError('GitLab 认证失败，请检查连接配置', 'upstream')
  const request = async <T extends ResponseBodyTypes>(endpoint: string, options: Record<string, unknown> = {}): Promise<FormattedResponse<T>> => {
    if (options.method && options.method !== 'GET') throw new IntegrationError('仓库连接器只支持读取', 'denied')
    const prefix = textOf(options.prefixUrl).replace(/\/+$/, '')
    const query = textOf(options.searchParams)
    const url = `${prefix}/${endpoint.replace(/^\/+/, '')}${query ? `?${query}` : ''}`
    const r = await readRemoteJson(url, { headers: options.headers as Record<string, string> | undefined, signal: options.signal as AbortSignal | undefined })
    return { body: r.body as T, headers: Object.fromEntries(r.response.headers.entries()), status: r.response.status }
  }
  const requesterFn = createRequesterFn((resource, options) => defaultOptionsHandler(resource, {
    method: options.method,
    signal: options.signal,
    searchParams: typeof options.searchParams === 'string' ? Object.fromEntries(new URLSearchParams(options.searchParams)) : recordOf(options.searchParams)
  }), request)
  return new Gitlab({ host: c.public.config.baseUrl, ...(oauth ? { oauthToken: token } : { token }), requesterFn, queryTimeout: 15000 })
}
export const gitlabPort: RepositoryPort = {
  async inspect(c) { const client = await gitlab(c); const r = await client.Users.showCurrentUser(); return textOf(r.username) },
  async repositories(c, page, query) {
    const client = await gitlab(c)
    const r = await client.Projects.all({ membership: true, search: query || undefined, page, perPage: SIZE, maxPages: 1 })
    return pageOf(rowsOf(r).map((v) => repositoryOf(v, 'path_with_namespace', 'web_url')), page)
  },
  async pullRequests(c, repo, page) {
    const client = await gitlab(c)
    const r = await client.MergeRequests.all({ projectId: repo, page, perPage: SIZE, maxPages: 1, state: 'all', orderBy: 'updated_at' })
    return pageOf(rowsOf(r).map((v) => pullOf(c, repo, v, true)), page)
  }
}
function giteeUrl(path: string, c: ResolvedConnection, page?: number): string {
  const url = new URL(`https://gitee.com/api/v5${path}`)
  // Gitee v5 documents access_token as a query parameter; never log this URL.
  url.searchParams.set('access_token', c.secrets.token || '')
  if (page) { url.searchParams.set('page', String(page)); url.searchParams.set('per_page', String(SIZE)) }
  return url.href
}
export const giteePort: RepositoryPort = {
  async inspect(c) { const r = await readRemoteJson(giteeUrl('/user', c)); return textOf(recordOf(r.body).login) },
  async repositories(c, page, query) {
    const r = await readRemoteJson(giteeUrl('/user/repos', c, page))
    const rows = rowsOf(r.body)
    return { items: rows.map((v) => repositoryOf(v, 'full_name', 'html_url')).filter((v) => !query || v.fullName.toLowerCase().includes(query.toLowerCase())), page, hasMore: rows.length === SIZE }
  },
  async pullRequests(c, repo, page) {
    const parts = repo.split('/')
    if (parts.length !== 2 || !parts.every(Boolean)) throw new IntegrationError('Gitee 仓库格式应为 owner/repository')
    const path = parts.map(encodeURIComponent).join('/')
    const url = new URL(giteeUrl(`/repos/${path}/pulls`, c, page)); url.searchParams.set('state', 'all')
    const r = await readRemoteJson(url.href)
    return pageOf(rowsOf(r.body).map((v) => pullOf(c, repo, v)), page)
  }
}
