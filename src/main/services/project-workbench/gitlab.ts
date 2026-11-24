import { z } from 'zod'
import { codeRepositoryIdentity } from '../../../shared/code-repository-identity'
import type { ProjectWorkbenchAction, ProjectWorkbenchResult } from '../../../shared/conversation/project-workbench'
import type { GitWorkspaceSnapshot } from '../../../shared/git-workspace'
import { DaemonError } from '../../daemon/errors'
import { readGit } from '../git-readonly-reader'
import { getGitlabAccessToken } from '../gitlab'
import { getSettings } from '../store'
import { WorkbenchError } from './errors'

const webUrl = z.string().url().max(8192)
const projectSchema = z.object({ id: z.number().int().positive().safe(), path_with_namespace: z.string(), web_url: webUrl })
const mrSchema = z.object({ iid: z.number().int().positive().safe(), title: z.string(), state: z.string(), web_url: webUrl,
  source_branch: z.string(), target_branch: z.string(), source_project_id: z.number(), target_project_id: z.number() })
const accountSchema = z.object({ id: z.number().int().positive().safe(), username: z.string() })
const branchSchema = z.object({ name: z.string(), commit: z.object({ id: z.string() }) })
type GitlabAction = Extract<ProjectWorkbenchAction, { kind: 'gitlab.status' | 'gitlab.pr.create' | 'gitlab.issue.open' }>

interface GitlabScope {
  root: string
  status(): Promise<GitWorkspaceSnapshot>
  revalidate(): Promise<void>
  current(): void
  confirm(title: string, message: string, detail: string, button: string): Promise<boolean>
  openExternal(url: string): Promise<void>
}

function site(value: string): URL {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    return url
  } catch { throw new DaemonError('E_UNAVAILABLE', 'GitLab 账号地址无效，请核对本机集成配置。') }
}

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('no response body')
  const decoder = new TextDecoder()
  let length = 0
  let text = ''
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.length
      if (length > 256 * 1024) throw new Error('response too large')
      text += decoder.decode(result.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
}

export async function workbenchGitlab(action: GitlabAction, scope: GitlabScope): Promise<ProjectWorkbenchResult> {
  const config = getSettings().gitlab
  if (!config.enabled || !config.baseUrl || !config.project || !config.user) {
    throw new DaemonError('E_UNAVAILABLE', '本机尚未配置此仓库的 GitLab 账号。')
  }
  const base = site(config.baseUrl)
  const namespace = config.project.trim().replace(/^\/+|\/+$/g, '')
  const declared = `${base.href.replace(/\/+$/, '')}/${namespace}`
  const repo = codeRepositoryIdentity(declared)
  if (!repo || !/^[\w.-]+(?:\/[\w.-]+)+$/.test(namespace) || namespace.split('/').some(value => value === '.' || value === '..')) {
    throw new DaemonError('E_UNAVAILABLE', '本机 GitLab 未绑定有效项目。')
  }
  const account = JSON.stringify(config)
  const current = (): void => {
    scope.current()
    if (JSON.stringify(getSettings().gitlab) !== account) throw new DaemonError('E_CONFLICT', '原 GitLab 仓库或账号配置已变化。')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,249}$/.test(action.remote)) throw new DaemonError('E_INVALID_ARG', '远端名称无效。')
  const checkRemote = async (): Promise<GitWorkspaceSnapshot> => {
    await scope.revalidate()
    current()
    const state = await scope.status()
    if (!state.remotes.some(remote => remote.name === action.remote)) throw new WorkbenchError('E_NOT_FOUND', '所选远端已不存在。')
    const options = action.kind === 'gitlab.pr.create' ? ['--push', '--all'] : ['--all']
    const actual = await readGit(scope.root, ['remote', 'get-url', ...options, action.remote])
    const urls = actual.out.trimEnd().split(/\r?\n/)
    if (actual.code !== 0 || urls.length !== 1 || codeRepositoryIdentity(urls[0]) !== repo) {
      throw new DaemonError('E_DENIED', '此远端与本机已授权 GitLab 仓库不一致。')
    }
    if (action.kind === 'gitlab.pr.create' && (state.revision !== action.revision || state.branch !== action.sourceBranch || !state.head)) {
      throw new DaemonError('E_CONFLICT', '当前分支、HEAD 或仓库状态已变化。')
    }
    current()
    return state
  }
  const initial = await checkRemote()
  const token = await getGitlabAccessToken(config)
  current()
  if (!token) throw new DaemonError('E_UNAVAILABLE', 'GitLab 账号离线或认证已过期。')
  const call = async <T>(path: string, schema: z.ZodType<T>, payload?: unknown): Promise<T> => {
    current()
    try {
      const response = await fetch(`${base.href.replace(/\/+$/, '')}/api/v4${path}`, {
        method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        const uncertain = Boolean(payload && response.status >= 500)
        const code = response.status === 401 || response.status === 403 ? 'E_DENIED' : response.status === 404 ? 'E_NOT_FOUND' : uncertain ? 'E_UNKNOWN' : 'E_UPSTREAM'
        throw new WorkbenchError(code, `GitLab 请求返回 HTTP ${response.status}。`, uncertain ? 'unknown' : undefined)
      }
      const data = schema.parse(await readResponse(response))
      current()
      return data
    } catch (error) {
      if ((error instanceof DaemonError || error instanceof WorkbenchError) && (!payload || error.code !== 'E_CONFLICT')) throw error
      throw new DaemonError(payload ? 'E_UNKNOWN' : 'E_UNAVAILABLE', payload ? 'GitLab 创建结果待核对，请先查看原分支合并请求。' : 'GitLab 请求无法验证。', payload ? 'unknown' : undefined)
    }
  }
  const person = await call('/user', accountSchema)
  if (person.username.toLowerCase() !== config.user.trim().toLowerCase()) throw new DaemonError('E_DENIED', 'GitLab 返回的账号与配置账号不同。')
  const project = await call(`/projects/${encodeURIComponent(namespace)}`, projectSchema)
  if (project.path_with_namespace !== namespace || codeRepositoryIdentity(project.web_url) !== repo || site(project.web_url).origin !== base.origin) {
    throw new DaemonError('E_DENIED', 'GitLab 返回的仓库身份与授权不符。')
  }
  const projectPath = `/projects/${project.id}`
  const checkedUrl = (url: string, category: 'issues' | 'merge_requests', iid: number): string => {
    const target = site(url)
    const expected = new URL(`${project.web_url.replace(/\/+$/, '')}/-/${category}/${iid}`)
    if (target.href !== expected.href) throw new DaemonError('E_CONFLICT', 'GitLab 返回了不同仓库的资源地址。')
    return target.href
  }
  if (action.kind === 'gitlab.status') {
    const list = initial.branch ? await call(`${projectPath}/merge_requests?${new URLSearchParams({ source_branch: initial.branch, state: 'opened', per_page: '20' })}`, z.array(mrSchema).max(20)) : []
    const row = list.find(mr => mr.source_project_id === project.id && mr.target_project_id === project.id && mr.source_branch === initial.branch)
    await checkRemote()
    return { ok: true, kind: action.kind, status: { ok: true, mr: row ? {
      iid: row.iid, title: row.title, state: row.state, webUrl: checkedUrl(row.web_url, 'merge_requests', row.iid),
      sourceBranch: row.source_branch, targetBranch: row.target_branch,
    } : null, pipeline: null } }
  }
  if (action.kind === 'gitlab.issue.open') {
    const issue = await call(`${projectPath}/issues/${action.iid}`, z.object({ iid: z.literal(action.iid), project_id: z.literal(project.id), web_url: webUrl }))
    await checkRemote()
    current()
    await scope.openExternal(checkedUrl(issue.web_url, 'issues', issue.iid))
    return { ok: true, kind: action.kind }
  }
  if (action.sourceBranch === action.targetBranch) throw new DaemonError('E_INVALID_ARG', '请选择与源分支不同的合并目标。')
  const checkBranches = async (): Promise<void> => {
    const [source, target] = await Promise.all([action.sourceBranch, action.targetBranch].map(branch =>
      call(`${projectPath}/repository/branches/${encodeURIComponent(branch)}`, branchSchema)))
    if (source.name !== action.sourceBranch || source.commit.id !== initial.head || target.name !== action.targetBranch) {
      throw new DaemonError('E_CONFLICT', '远端源分支与已确认的本地 HEAD 不同，或目标分支已变更。')
    }
  }
  await checkBranches()
  if (!await scope.confirm('确认创建合并请求', action.title, `${project.web_url}\n${person.username}\n${action.sourceBranch} → ${action.targetBranch}\n${initial.head}`, '创建合并请求')) {
    throw new DaemonError('E_DENIED', '已取消创建合并请求。')
  }
  await checkBranches()
  await checkRemote()
  const mr = await call(`${projectPath}/merge_requests`, mrSchema, {
    source_branch: action.sourceBranch, target_branch: action.targetBranch, title: action.title, description: action.description ?? '',
  })
  try {
    if (mr.source_project_id !== project.id || mr.target_project_id !== project.id ||
        mr.source_branch !== action.sourceBranch || mr.target_branch !== action.targetBranch) throw new Error('MR target mismatch')
    return { ok: true, kind: action.kind, url: checkedUrl(mr.web_url, 'merge_requests', mr.iid) }
  } catch { throw new DaemonError('E_UNKNOWN', 'GitLab 已返回创建回执，但目标未核实，请在原仓库核对。', 'unknown') }
}
