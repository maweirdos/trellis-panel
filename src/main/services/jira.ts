import { safeStorage } from 'electron'
import type { JiraConfig, JiraIssue, JiraTransition } from '../../shared/types'
import { JIRA_CATEGORY_STATUS } from '../../shared/labels-shared'
import { errorMessage } from '../../shared/errors'

/** Decrypt the stored password when it was encrypted with safeStorage. */
export function resolvePassword(cfg: JiraConfig): string {
  if (cfg.passwordEncrypted && cfg.password) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(cfg.password, 'base64'))
      }
    } catch {
      // fall through to plaintext
    }
  }
  return cfg.password
}

/** Encrypt a plaintext password for storage (no-op fallback when unavailable). */
export function protectPassword(plain: string): { password: string; passwordEncrypted: boolean } {
  try {
    if (plain && safeStorage.isEncryptionAvailable()) {
      return { password: safeStorage.encryptString(plain).toString('base64'), passwordEncrypted: true }
    }
  } catch {
    // fall back to plaintext
  }
  return { password: plain, passwordEncrypted: false }
}

function authHeader(cfg: JiraConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.user}:${resolvePassword(cfg)}`).toString('base64')
}

/** Map a Jira issue to a trellis status: explicit map first, then statusCategory. */
export function mapJiraStatus(statusMap: Record<string, string>, statusName: string, statusCategory: string): string {
  const direct = statusMap[statusName]
  if (direct) return direct
  return JIRA_CATEGORY_STATUS[statusCategory] ?? 'planning'
}

async function jiraFetch(
  cfg: JiraConfig,
  apiPath: string,
  init?: RequestInit
): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetch(base + apiPath, {
      ...init,
      headers: {
        Authorization: authHeader(cfg),
        'Content-Type': 'application/json',
        ...(init?.headers ?? {})
      },
      signal: AbortSignal.timeout(15000)
    })
  } catch (e) {
    return { ok: false, error: '网络请求失败: ' + (errorMessage(e) ?? String(e)) }
  }
  if (res.status === 401) return { ok: false, status: 401, error: '认证失败：用户名或密码错误' }
  let data: unknown = null
  const text = await res.text()
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const errs =
      data && typeof data === 'object' && 'errorMessages' in data
        ? (data as { errorMessages?: unknown }).errorMessages
        : undefined
    // 与旧实现语义对齐：无 errorMessages 时保留 HTTP 状态码；空数组也走兜底（旧实现会得到空文案）
    const msg =
      Array.isArray(errs) && errs.length > 0
        ? errs.map((m) => String(m)).join('; ')
        : `请求失败 (HTTP ${res.status})`
    return { ok: false, status: res.status, error: msg }
  }
  return { ok: true, status: res.status, data }
}

export async function jiraTest(
  cfg: JiraConfig
): Promise<{ ok: boolean; error?: string; displayName?: string }> {
  const res = await jiraFetch(cfg, '/rest/api/2/myself')
  if (!res.ok) return { ok: false, error: res.error }
  const u = res.data && typeof res.data === 'object' ? (res.data as { displayName?: unknown; name?: unknown }) : null
  const displayName = typeof u?.displayName === 'string' ? u.displayName : undefined
  const name = typeof u?.name === 'string' ? u.name : undefined
  return { ok: true, displayName: displayName ?? name ?? '未知用户' }
}

interface RawIssueFields {
  key?: string
  summary?: string
  status?: { name?: string; statusCategory?: { key?: string } }
  priority?: { name?: string }
  issuetype?: { name?: string }
  updated?: string
  assignee?: { name?: string; displayName?: string }
  fixVersions?: Array<{ name?: string }>
}

export async function jiraSearch(
  cfg: JiraConfig,
  jql: string
): Promise<{ ok: boolean; error?: string; issues?: JiraIssue[]; total?: number }> {
  const q = jql.trim() || 'assignee = currentUser() ORDER BY updated DESC'
  const url =
    '/rest/api/2/search?maxResults=50' +
    '&fields=key,summary,status,priority,issuetype,updated,assignee,fixVersions' +
    '&jql=' +
    encodeURIComponent(q)
  const res = await jiraFetch(cfg, url)
  if (!res.ok) return { ok: false, error: res.error }
  const d = res.data && typeof res.data === 'object' ? (res.data as { issues?: unknown; total?: number }) : null
  const issuesField = d?.issues
  const issues: JiraIssue[] = (Array.isArray(issuesField) ? issuesField : []).map((raw) => {
    const item = raw as { key?: unknown; fields?: RawIssueFields }
    const key = typeof item.key === 'string' ? item.key : ''
    const f: RawIssueFields = item.fields ?? {}
    return {
      key,
      summary: f.summary ?? '(无标题)',
      status: f.status?.name ?? '未知',
      statusCategory: f.status?.statusCategory?.key ?? 'new',
      priority: f.priority?.name ?? '一般',
      issueType: f.issuetype?.name ?? '任务',
      updated: f.updated ?? '',
      url: `${cfg.baseUrl.replace(/\/+$/, '')}/browse/${key}`,
      assignee: f.assignee?.displayName ?? f.assignee?.name ?? '未分配',
      fixVersions: (f.fixVersions ?? []).map((v) => v?.name ?? '').filter(Boolean)
    }
  })
  return { ok: true, issues, total: d?.total ?? issues.length }
}

export async function jiraTransitions(
  cfg: JiraConfig,
  key: string
): Promise<{ ok: boolean; error?: string; transitions?: JiraTransition[] }> {
  const res = await jiraFetch(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`)
  if (!res.ok) return { ok: false, error: res.error }
  const d = res.data && typeof res.data === 'object' ? (res.data as { transitions?: unknown }) : null
  const transitionsField = d?.transitions
  const transitions: JiraTransition[] = (Array.isArray(transitionsField) ? transitionsField : []).map((t) => {
    const raw = t as { id?: unknown; name?: unknown }
    return {
      id: String(raw.id),
      name: typeof raw.name === 'string' ? raw.name : ''
    }
  })
  return { ok: true, transitions }
}

export async function jiraTransition(
  cfg: JiraConfig,
  key: string,
  transitionId: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await jiraFetch(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: transitionId } })
  })
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export async function jiraComment(
  cfg: JiraConfig,
  key: string,
  body: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await jiraFetch(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body })
  })
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}
