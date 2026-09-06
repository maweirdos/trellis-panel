import { safeStorage } from 'electron'
import type { GitLabConfig, GitLabMrInfo, GitLabPipelineInfo, GitLabTaskStatus } from '../../shared/types'

/* ---------------- password protection (same scheme as Jira) ---------------- */

export function resolveGitlabPassword(cfg: GitLabConfig): string {
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

export function protectGitlabPassword(plain: string): { password: string; passwordEncrypted: boolean } {
  try {
    if (plain && safeStorage.isEncryptionAvailable()) {
      return { password: safeStorage.encryptString(plain).toString('base64'), passwordEncrypted: true }
    }
  } catch {
    // fall back to plaintext
  }
  return { password: plain, passwordEncrypted: false }
}

/* ---------------- OAuth token cache (per base+user) ---------------- */

interface TokenEntry {
  accessToken: string
  expiresAt: number
  refreshToken: string
}

const tokenCache = new Map<string, TokenEntry>()

function cacheKey(cfg: GitLabConfig): string {
  return `${cfg.baseUrl.replace(/\/+$/, '')}|${cfg.user}`
}

function normalizeBase(cfg: GitLabConfig): string {
  return cfg.baseUrl.replace(/\/+$/, '')
}

async function requestToken(cfg: GitLabConfig, grant: 'password' | 'refresh_token', extra: string): Promise<TokenEntry | null> {
  try {
    const res = await fetch(`${normalizeBase(cfg)}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: grant,
        ...extraObj(extra)
      })
    })
    if (!res.ok) return null
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; created_at?: number }
    if (!data.access_token) return null
    // prefer server created_at; fall back to local clock
    const issued = (data.created_at ? data.created_at * 1000 : Date.now())
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? '',
      // refresh 60s before real expiry
      expiresAt: issued + Math.max(60, (data.expires_in ?? 7200) * 1000) - 60_000
    }
  } catch {
    return null
  }
}

function extraObj(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of query.split('&')) {
    const i = pair.indexOf('=')
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return out
}

async function getToken(cfg: GitLabConfig): Promise<string | null> {
  const key = cacheKey(cfg)
  const hit = tokenCache.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit.accessToken
  if (hit?.refreshToken) {
    const refreshed = await requestToken(cfg, 'refresh_token', `refresh_token=${encodeURIComponent(hit.refreshToken)}`)
    if (refreshed) {
      tokenCache.set(key, refreshed)
      return refreshed.accessToken
    }
  }
  const fresh = await requestToken(
    cfg,
    'password',
    `username=${encodeURIComponent(cfg.user)}&password=${encodeURIComponent(resolveGitlabPassword(cfg))}`
  )
  if (fresh) tokenCache.set(key, fresh)
  return fresh?.accessToken ?? null
}

export function clearGitlabTokenCache(): void {
  tokenCache.clear()
}

/* ---------------- API helpers ---------------- */

async function glGet<T>(cfg: GitLabConfig, path: string): Promise<{ ok: boolean; status?: number; data?: T; error?: string }> {
  const token = await getToken(cfg)
  if (!token) return { ok: false, error: 'GitLab 登录失败：检查账号密码 / OAuth 密码模式是否开启' }
  try {
    const res = await fetch(`${normalizeBase(cfg)}/api/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (res.status === 401) {
      tokenCache.delete(cacheKey(cfg))
      return { ok: false, status: 401, error: 'GitLab 认证过期' }
    }
    if (!res.ok) return { ok: false, status: res.status, error: `GitLab API ${res.status}` }
    return { ok: true, data: (await res.json()) as T }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'GitLab 请求失败' }
  }
}

async function glPost<T>(cfg: GitLabConfig, path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status?: number; data?: T; error?: string }> {
  const token = await getToken(cfg)
  if (!token) return { ok: false, error: 'GitLab 登录失败' }
  try {
    const res = await fetch(`${normalizeBase(cfg)}/api/v4${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      let msg = `GitLab API ${res.status}`
      try {
        const err = (await res.json()) as { message?: string | Record<string, string[]> }
        if (err?.message) msg = typeof err.message === 'string' ? err.message : Object.values(err.message).flat().join('；')
      } catch {
        // keep default message
      }
      return { ok: false, status: res.status, error: msg }
    }
    return { ok: true, data: (await res.json()) as T }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'GitLab 请求失败' }
  }
}

interface GlProject {
  id: number
  default_branch: string | null
  web_url: string
}

async function getProject(cfg: GitLabConfig): Promise<GlProject | null> {
  const path = encodeURIComponent(cfg.project.trim().replace(/^\/+|\/+$/g, ''))
  if (!path) return null
  const res = await glGet<GlProject>(cfg, `/projects/${path}`)
  return res.data ?? null
}

/* ---------------- public API ---------------- */

export async function gitlabTest(cfg: GitLabConfig): Promise<{ ok: boolean; error?: string; displayName?: string }> {
  if (!cfg.baseUrl || !cfg.user) return { ok: false, error: '请填写 GitLab 地址和账号' }
  interface GlUser { name?: string; username?: string }
  const token = await getToken(cfg)
  if (!token) return { ok: false, error: '登录失败：检查账号密码' }
  try {
    const res = await fetch(`${normalizeBase(cfg)}/api/v4/user`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return { ok: false, error: `认证失败（HTTP ${res.status}）` }
    const user = (await res.json()) as GlUser
    const proj = await getProject(cfg)
    return {
      ok: true,
      displayName: `${user.name ?? user.username ?? cfg.user}${proj ? ` · 项目 ${cfg.project}` : '（未找到项目，请检查项目路径）'}`
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '连接失败' }
  }
}

interface GlMr {
  iid: number
  title: string
  state: string
  web_url: string
  source_branch: string
  target_branch: string
}

interface GlPipeline {
  id: number
  status: string
  ref: string
  web_url: string
}

/** 30s in-memory cache keyed by branch — kanban cards poll this per render. */
const statusCache = new Map<string, { at: number; value: GitLabTaskStatus }>()

export async function gitlabTaskStatus(cfg: GitLabConfig, dirName: string, branch: string | null, baseBranch: string | null): Promise<GitLabTaskStatus> {
  if (!cfg.enabled || !cfg.baseUrl || !cfg.project) {
    return { ok: false, error: 'GitLab 未启用', mr: null, pipeline: null }
  }
  if (!branch) return { ok: true, mr: null, pipeline: null }
  const cacheKey = `${cfg.project}|${branch}`
  const hit = statusCache.get(cacheKey)
  if (hit && Date.now() - hit.at < 30_000) return hit.value

  const proj = await getProject(cfg)
  if (!proj) {
    const value: GitLabTaskStatus = { ok: false, error: '未找到 GitLab 项目（检查项目路径设置）', mr: null, pipeline: null }
    statusCache.set(cacheKey, { at: Date.now(), value })
    return value
  }
  const encId = String(proj.id)
  const [mrRes, pipeRes] = await Promise.all([
    glGet<GlMr[]>(cfg, `/projects/${encId}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened&per_page=1`),
    glGet<GlPipeline[]>(cfg, `/projects/${encId}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`)
  ])
  const m = mrRes.data?.[0]
  const p = pipeRes.data?.[0]
  const mr: GitLabMrInfo | null = m
    ? { iid: m.iid, title: m.title, state: m.state, webUrl: m.web_url, sourceBranch: m.source_branch, targetBranch: m.target_branch }
    : null
  const pipeline: GitLabPipelineInfo | null = p ? { id: p.id, status: p.status, ref: p.ref, webUrl: p.web_url } : null
  const value: GitLabTaskStatus = { ok: true, mr, pipeline }
  statusCache.set(cacheKey, { at: Date.now(), value })
  return value
}

export async function gitlabCreateMr(
  cfg: GitLabConfig,
  input: { branch: string; baseBranch: string | null; title: string; description: string }
): Promise<{ ok: boolean; error?: string; url?: string }> {
  const proj = await getProject(cfg)
  if (!proj) return { ok: false, error: '未找到 GitLab 项目（检查项目路径设置）' }
  const target = input.baseBranch || proj.default_branch || 'main'
  const res = await glPost<GlMr>(cfg, `/projects/${proj.id}/merge_requests`, {
    source_branch: input.branch,
    target_branch: target,
    title: input.title,
    description: input.description
  })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, url: res.data?.web_url }
}

export function clearGitlabStatusCache(): void {
  statusCache.clear()
}
