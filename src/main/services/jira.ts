import { safeStorage } from 'electron'
import type { JiraConfig, JiraIssue, JiraTransition } from '../../shared/types'
import { JIRA_CATEGORY_STATUS } from '../../shared/labels-shared'

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
  } catch (e: any) {
    return { ok: false, error: '网络请求失败: ' + (e?.message ?? String(e)) }
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
    const msg =
      data && typeof data === 'object' && 'errorMessages' in data
        ? ((data as any).errorMessages?.join('; ') ?? '请求失败')
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
  const u = res.data as any
  return { ok: true, displayName: u?.displayName ?? u?.name ?? '未知用户' }
}

interface RawIssueFields {
  key?: string
  summary?: string
  status?: { name?: string; statusCategory?: { key?: string } }
  priority?: { name?: string }
  issuetype?: { name?: string }
  updated?: string
  assignee?: { name?: string; displayName?: string }
}

export async function jiraSearch(
  cfg: JiraConfig,
  jql: string
): Promise<{ ok: boolean; error?: string; issues?: JiraIssue[]; total?: number }> {
  const q = jql.trim() || 'assignee = currentUser() ORDER BY updated DESC'
  const url =
    '/rest/api/2/search?maxResults=50' +
    '&fields=key,summary,status,priority,issuetype,updated,assignee' +
    '&jql=' +
    encodeURIComponent(q)
  const res = await jiraFetch(cfg, url)
  if (!res.ok) return { ok: false, error: res.error }
  const d = res.data as any
  const issues: JiraIssue[] = (d?.issues ?? []).map((raw: { key: string; fields: RawIssueFields }) => {
    const f = raw.fields ?? {}
    return {
      key: raw.key,
      summary: f.summary ?? '(无标题)',
      status: f.status?.name ?? '未知',
      statusCategory: f.status?.statusCategory?.key ?? 'new',
      priority: f.priority?.name ?? '一般',
      issueType: f.issuetype?.name ?? '任务',
      updated: f.updated ?? '',
      url: `${cfg.baseUrl.replace(/\/+$/, '')}/browse/${raw.key}`,
      assignee: f.assignee?.displayName ?? f.assignee?.name ?? '未分配'
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
  const d = res.data as any
  const transitions: JiraTransition[] = (d?.transitions ?? []).map((t: { id: string; name: string }) => ({
    id: String(t.id),
    name: t.name
  }))
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
