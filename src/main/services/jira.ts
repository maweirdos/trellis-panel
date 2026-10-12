import { safeStorage } from 'electron'
import type {
  JiraConfig,
  JiraDistributionResult,
  JiraFixVersionRef,
  JiraIssue,
  JiraIssueDetail,
  JiraPagedSearchMeta,
  JiraPagedSearchResult,
  JiraTransition,
  JiraVersionDistribution,
  JiraVersionTypeCount
} from '../../shared/types'
import { JIRA_CATEGORY_STATUS } from '../../shared/labels-shared'
import { errorMessage } from '../../shared/errors'
import { jiraInstanceIdFor } from './jira-instance'

export { jiraInstanceIdFor }

/** 查询传输层（默认全局 fetch；冒烟/fixture 注入用，不碰网络）。 */
export type JiraTransport = (url: string, init?: RequestInit) => Promise<Response>

/** jiraFetch 可选项：传输注入 + 外部取消信号 + 超时预算。 */
export interface JiraFetchOptions {
  transport?: JiraTransport
  signal?: AbortSignal
  timeoutMs?: number
}

/** Jira 返回的时间（ISO 8601，可能带 +0800 无冒号偏移）→ Unix 毫秒；非法/缺失返回 null（显式校验，不猜）。 */
export function parseJiraIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

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
  init?: RequestInit,
  opts?: JiraFetchOptions
): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string; timedOut?: boolean; aborted?: boolean }> {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const url = base + apiPath
  const timeoutMs = opts?.timeoutMs ?? 15000
  // 外部信号 + 超时合并：任一触发即中断；超时/取消分别归类（不确定结果处理依赖该区分）
  let signal: AbortSignal
  try {
    signal = opts?.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  } catch {
    signal = AbortSignal.timeout(timeoutMs)
  }
  let res: Response
  const doFetch = opts?.transport ?? fetch
  try {
    res = await doFetch(url, {
      ...init,
      headers: {
        Authorization: authHeader(cfg),
        'Content-Type': 'application/json',
        ...(init?.headers ?? {})
      },
      signal
    })
  } catch (e) {
    const abortedByCaller = opts?.signal?.aborted === true
    const timedOut = !abortedByCaller && (e instanceof Error ? e.name === 'TimeoutError' || e.name === 'AbortError' : false)
    return {
      ok: false,
      aborted: abortedByCaller,
      timedOut,
      error: '网络请求失败: ' + (errorMessage(e) ?? String(e))
    }
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

/* ---------------- G4：分页查询与基线（design §7.1） ---------------- */

interface RawIssueDetailFields {
  key?: string
  summary?: string
  status?: { name?: string; statusCategory?: { key?: string } }
  priority?: { name?: string }
  issuetype?: { id?: unknown; name?: string }
  updated?: string
  assignee?: { name?: string; displayName?: string }
  fixVersions?: Array<{ id?: unknown; name?: string }>
  description?: unknown
}

const DETAIL_FIELDS = 'key,summary,status,priority,issuetype,updated,assignee,fixVersions,description'

/** issue 详情映射：issueId（数字稳定 ID）/issueTypeId/fixVersionId/description/updatedAtMs。 */
function mapIssueDetail(raw: unknown, baseUrl: string): JiraIssueDetail | null {
  const item = raw as { id?: unknown; key?: unknown; fields?: RawIssueDetailFields }
  const key = typeof item.key === 'string' ? item.key : ''
  if (key === '') return null
  const f: RawIssueDetailFields = item.fields ?? {}
  const idNum = typeof item.id === 'string' ? Number(item.id) : typeof item.id === 'number' ? item.id : NaN
  const issueId = Number.isSafeInteger(idNum) && idNum > 0 ? idNum : null
  const updatedRaw = f.updated ?? ''
  const description = typeof f.description === 'string' ? f.description : null
  return {
    key,
    summary: f.summary ?? '(无标题)',
    status: f.status?.name ?? '未知',
    statusCategory: f.status?.statusCategory?.key ?? 'new',
    priority: f.priority?.name ?? '一般',
    issueType: f.issuetype?.name ?? '任务',
    updated: updatedRaw,
    url: `${baseUrl.replace(/\/+$/, '')}/browse/${key}`,
    assignee: f.assignee?.displayName ?? f.assignee?.name ?? '未分配',
    fixVersions: (f.fixVersions ?? []).map((v) => v?.name ?? '').filter(Boolean),
    issueId,
    issueTypeId: String(f.issuetype?.id ?? ''),
    issueTypeName: f.issuetype?.name ?? '任务',
    fixVersionDetails: (f.fixVersions ?? [])
      .map((v) => ({ id: String(v?.id ?? ''), name: v?.name ?? '' }))
      .filter((v) => v.id !== '' || v.name !== ''),
    description,
    updatedAtMs: parseJiraIsoMs(updatedRaw)
  }
}

/** 分页查询可选项（design §7.1：逐页收集、issue 去重、可取消、重试有上限、最大页数标样本）。 */
export interface JiraSearchPagedOptions {
  jql: string
  /** 用户配置的最大页数预算；达到仍未取全 → 标样本。默认 20。 */
  maxPages?: number
  /** 单页条数（Jira 上限通常 100，保守默认 50）。 */
  pageSize?: number
  /** 单页失败重试上限（额外尝试次数）。默认 2。 */
  retryLimit?: number
  retryDelayMs?: number
  signal?: AbortSignal
  /** 传输层注入（fixture/冒烟用，不碰网络）。 */
  transport?: JiraTransport
  timeoutMs?: number
}

/** 去重键：优先数字稳定 issueId，缺失回退 key（不把 key 与 id 混用）。 */
function dedupeKeyOf(issue: JiraIssueDetail): string {
  return issue.issueId !== null ? `id:${issue.issueId}` : `key:${issue.key.toUpperCase()}`
}

function emptyMeta(jql: string, startedAtMs: number): JiraPagedSearchMeta {
  return {
    jql,
    paginationKind: 'unknown',
    pagesFetched: 0,
    serverTotal: null,
    retrievedCount: 0,
    duplicateCount: 0,
    sample: false,
    incompleteReason: null,
    cancelled: false,
    changedDuringCollection: null,
    startedAtMs,
    endedAtMs: startedAtMs
  }
}

function isRetryablePageFailure(res: { status?: number; timedOut?: boolean }): boolean {
  if (res.timedOut === true) return true
  if (res.status === undefined) return true // 网络层失败（无 HTTP 状态）
  return res.status >= 500 || res.status === 429
}

/**
 * 分页 Jira 搜索（design §7.1）。协议按实际返回信号适配：
 * - 响应带 nextPageToken（Cloud 增强搜索）→ token 翻页；
 * - 否则 startAt/total（Server/DC 与旧 Cloud）→ total 未知/为负时以空页为终点；
 * 两种信号不假设一致，公司版本未验证前均可工作（保守：单页 ≤50）。
 * 页失败重试有上限；中途页耗尽重试 → 保留已收集部分并标样本（未创建≠失败的同族口径：
 * 拿到多少报多少，不伪装完整）。首页即失败 → ok:false。
 */
export async function jiraSearchPaged(cfg: JiraConfig, options: JiraSearchPagedOptions): Promise<JiraPagedSearchResult> {
  const startedAtMs = Date.now()
  const jql = options.jql.trim() || 'assignee = currentUser() ORDER BY updated DESC'
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? 20))
  const pageSize = Math.max(1, Math.min(100, Math.floor(options.pageSize ?? 50)))
  const retryLimit = Math.max(0, Math.floor(options.retryLimit ?? 2))
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 400)
  const meta = emptyMeta(jql, startedAtMs)

  const byKey = new Map<string, JiraIssueDetail>()
  let startAt = 0
  let nextPageToken: string | null = null
  let paginationKind: 'startAt_total' | 'nextPageToken' | 'unknown' = 'unknown'
  let firstTotal: number | null = null
  let serverTotal: number | null = null
  let changedDuringCollection: boolean | null = null
  let pagesFetched = 0
  let duplicateCount = 0
  let incompleteReason: JiraPagedSearchMeta['incompleteReason'] = null
  let cancelled = false
  let lastError: string | null = null

  const fetchPage = async (): Promise<{ ok: boolean; status?: number; timedOut?: boolean; error?: string; data?: unknown }> => {
    let attempt = 0
    // 单页重试有上限：仅对可重试失败（5xx/429/超时/网络）重试，4xx 立即失败
    for (;;) {
      const body: Record<string, unknown> = { jql, maxResults: pageSize, fields: DETAIL_FIELDS.split(',') }
      if (nextPageToken !== null) body.nextPageToken = nextPageToken
      else body.startAt = startAt
      const res = await jiraFetch(cfg, '/rest/api/2/search', { method: 'POST', body: JSON.stringify(body) }, options)
      if (res.ok || !isRetryablePageFailure(res)) return res
      if (attempt >= retryLimit) return res
      attempt += 1
      await new Promise((r) => setTimeout(r, retryDelayMs))
      if (options.signal?.aborted) return res
    }
  }

  for (;;) {
    if (options.signal?.aborted) {
      cancelled = true
      incompleteReason = 'cancelled'
      break
    }
    if (pagesFetched >= maxPages) {
      // 达用户配置最大页数且未自然收尾 → 标样本（design §7.1）
      incompleteReason = 'max_pages'
      break
    }
    const res = await fetchPage()
    if (options.signal?.aborted) {
      cancelled = true
      incompleteReason = 'cancelled'
      break
    }
    if (!res.ok) {
      lastError = res.error ?? '未知错误'
      if (byKey.size === 0 && pagesFetched === 0) {
        meta.endedAtMs = Date.now()
        meta.pagesFetched = pagesFetched
        return { ok: false, error: lastError, issues: [], meta }
      }
      // 中途页失败且重试耗尽：保留已收集部分，如实标样本
      incompleteReason = 'page_failed'
      break
    }
    const d = res.data && typeof res.data === 'object' ? (res.data as {
      issues?: unknown
      total?: unknown
      nextPageToken?: unknown
    }) : null
    const rawIssues = Array.isArray(d?.issues) ? (d?.issues as unknown[]) : []
    pagesFetched += 1

    for (const raw of rawIssues) {
      const detail = mapIssueDetail(raw, cfg.baseUrl)
      if (detail === null) continue
      const k = dedupeKeyOf(detail)
      if (byKey.has(k)) {
        duplicateCount += 1
        continue
      }
      byKey.set(k, detail)
    }

    if (d?.total !== undefined && Number.isFinite(Number(d?.total))) {
      const total = Number(d?.total)
      serverTotal = total
      if (firstTotal === null) firstTotal = total
      else if (total !== firstTotal) changedDuringCollection = true
      // total 已知且非负时才参与终点判定（部分旧版返回 -1 表示未知）
      if (total < 0) serverTotal = null
    }

    if (typeof d?.nextPageToken === 'string' && d.nextPageToken.length > 0) {
      paginationKind = 'nextPageToken'
      nextPageToken = d.nextPageToken
      // token 协议无 total 口径，快照一致性不可验证 → 显式 null（不假装一致）
      continue
    }
    if (paginationKind === 'unknown') paginationKind = 'startAt_total'
    nextPageToken = null
    if (rawIssues.length === 0) break
    startAt += rawIssues.length
    if (serverTotal !== null && startAt >= serverTotal) break
  }

  const issues = [...byKey.values()]
  meta.paginationKind = paginationKind
  meta.pagesFetched = pagesFetched
  meta.serverTotal = serverTotal
  meta.retrievedCount = issues.length
  meta.duplicateCount = duplicateCount
  meta.incompleteReason = incompleteReason
  meta.cancelled = cancelled
  meta.sample = incompleteReason !== null && incompleteReason !== 'cancelled'
  meta.changedDuringCollection = paginationKind === 'startAt_total' ? (changedDuringCollection ?? false) : null
  meta.endedAtMs = Date.now()
  return { ok: true, issues, meta }
}

/** 基线分布查询选项。 */
export interface JiraDistributionOptions extends JiraSearchPagedOptions {
  /** 目标版本（id 稳定、name 供报告）。 */
  versions: JiraFixVersionRef[]
  /** 附加过滤（如 assignee 限制）；与 fixVersion 条件 AND 组合。 */
  baseJql?: string
}

/**
 * 两个指定 fixVersion 的类型分布（FR5/design §7.1）：每版本独立查询各自计数；
 * 跨版本汇总另按 issueId/key 去重。单版本失败不拖垮其他版本（per-version ok/error）。
 */
export async function jiraFixVersionTypeDistribution(
  cfg: JiraConfig,
  options: JiraDistributionOptions
): Promise<JiraDistributionResult> {
  const startedAtMs = Date.now()
  const { versions, baseJql, ...paged } = options
  const versionsOut: JiraVersionDistribution[] = []
  const unique = new Map<string, JiraIssueDetail>()
  for (const version of versions) {
    const conds = [`fixVersion = ${JSON.stringify(version.id !== '' ? version.id : version.name)}`]
    const extra = baseJql?.trim()
    if (extra) conds.push(`(${extra})`)
    const res = await jiraSearchPaged(cfg, { ...paged, jql: conds.join(' AND ') + ' ORDER BY updated DESC' })
    if (!res.ok) {
      versionsOut.push({ versionId: version.id, versionName: version.name, ok: false, error: res.error, meta: res.meta, issueCount: 0, byType: [] })
      continue
    }
    const byType = new Map<string, JiraVersionTypeCount>()
    for (const issue of res.issues) {
      const k = dedupeKeyOf(issue)
      if (!unique.has(k)) unique.set(k, issue)
      const tKey = issue.issueTypeId || issue.issueTypeName
      const entry = byType.get(tKey) ?? { issueTypeId: issue.issueTypeId, issueTypeName: issue.issueTypeName, count: 0 }
      entry.count += 1
      byType.set(tKey, entry)
    }
    versionsOut.push({
      versionId: version.id,
      versionName: version.name,
      ok: true,
      meta: res.meta,
      issueCount: res.issues.length,
      byType: [...byType.values()].sort((a, b) => b.count - a.count)
    })
  }
  const crossByType = new Map<string, JiraVersionTypeCount>()
  for (const issue of unique.values()) {
    const tKey = issue.issueTypeId || issue.issueTypeName
    const entry = crossByType.get(tKey) ?? { issueTypeId: issue.issueTypeId, issueTypeName: issue.issueTypeName, count: 0 }
    entry.count += 1
    crossByType.set(tKey, entry)
  }
  return {
    versions: versionsOut,
    crossVersionUniqueCount: unique.size,
    crossVersionByType: [...crossByType.values()].sort((a, b) => b.count - a.count),
    startedAtMs,
    endedAtMs: Date.now()
  }
}

/** 读取单 issue 当前状态（transition 核实用）。 */
export async function jiraGetIssueStatus(
  cfg: JiraConfig,
  key: string,
  opts?: JiraFetchOptions
): Promise<{ ok: boolean; error?: string; status?: string; statusCategory?: string }> {
  const res = await jiraFetch(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=status`, undefined, opts)
  if (!res.ok) return { ok: false, error: res.error }
  const f =
    res.data && typeof res.data === 'object'
      ? ((res.data as { fields?: { status?: { name?: unknown; statusCategory?: { key?: unknown } } } }).fields ?? {})
      : {}
  const status = typeof f.status?.name === 'string' ? f.status.name : undefined
  if (status === undefined) return { ok: false, error: '响应缺少 status 字段' }
  return { ok: true, status, statusCategory: typeof f.status?.statusCategory?.key === 'string' ? f.status.statusCategory.key : undefined }
}

export async function jiraTransitions(
  cfg: JiraConfig,
  key: string,
  opts?: JiraFetchOptions
): Promise<{ ok: boolean; error?: string; transitions?: JiraTransition[] }> {
  const res = await jiraFetch(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, undefined, opts)
  if (!res.ok) return { ok: false, error: res.error }
  const d = res.data && typeof res.data === 'object' ? (res.data as { transitions?: unknown }) : null
  const transitionsField = d?.transitions
  const transitions: JiraTransition[] = (Array.isArray(transitionsField) ? transitionsField : []).map((t) => {
    const raw = t as { id?: unknown; name?: unknown; to?: { name?: unknown } }
    return {
      id: String(raw.id),
      name: typeof raw.name === 'string' ? raw.name : '',
      toStatusName: typeof raw.to?.name === 'string' ? raw.to.name : undefined
    }
  })
  return { ok: true, transitions }
}

export async function jiraTransition(
  cfg: JiraConfig,
  key: string,
  transitionId: string,
  opts?: JiraFetchOptions
): Promise<{ ok: boolean; error?: string; status?: number; timedOut?: boolean }> {
  const res = await jiraFetch(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: transitionId } })
  }, opts)
  return res.ok ? { ok: true } : { ok: false, error: res.error, status: res.status, timedOut: res.timedOut }
}

/**
 * G4（design §7.3）：transition 显式执行 + 重读核实。
 * - 成功依据服务响应，并重新读取 issue 状态核实（不凭 200 即宣称完成）。
 * - timeout/网络不确定：先查询当前状态再决定——已到目标状态 → already_applied（不重试）；
 *   否则报 uncertain（当前状态如实带回），绝不自动重复 transition/comment。
 * - 401/403 → permission；400/404 → invalid_transition（transition 失效），分别提示。
 */
export interface JiraTransitionApplyResult {
  ok: boolean
  /** 're-read' 已重读核实；'service_only' 服务响应 ok 但核实读取失败；'already_applied' 查询发现已在目标状态 */
  verified: 're-read' | 'service_only' | 'already_applied' | null
  /** 核实/查询读到的当前状态名 */
  status?: string
  /** 期望目标状态与核实结果不符（服务响应 ok 但状态未达）——如实暴露，不静默当成功 */
  statusMismatch?: boolean
  code?: 'permission' | 'invalid_transition' | 'offline' | 'uncertain' | 'error'
  error?: string
}

export async function jiraTransitionVerified(
  cfg: JiraConfig,
  key: string,
  transitionId: string,
  opts?: { transport?: JiraTransport; signal?: AbortSignal; timeoutMs?: number; expectedToStatus?: string }
): Promise<JiraTransitionApplyResult> {
  const fetchOpts: JiraFetchOptions = { transport: opts?.transport, signal: opts?.signal, timeoutMs: opts?.timeoutMs }
  const res = await jiraTransition(cfg, key, transitionId, fetchOpts)
  if (res.ok) {
    // 成功也要重读核实（design §7.3：成功以服务响应并重新读取核实）
    const read = await jiraGetIssueStatus(cfg, key, fetchOpts)
    if (!read.ok) {
      return { ok: true, verified: 'service_only', code: undefined, error: `已执行，但核实读取失败：${read.error ?? ''}` }
    }
    const mismatch = opts?.expectedToStatus !== undefined && read.status !== opts.expectedToStatus
    return { ok: true, verified: 're-read', status: read.status, statusMismatch: mismatch }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, verified: null, code: 'permission', error: res.error }
  }
  if (res.status === 400 || res.status === 404) {
    return { ok: false, verified: null, code: 'invalid_transition', error: res.error }
  }
  // timeout / 网络不确定 → 先查询再决定（不盲目重试）
  const uncertain = res.timedOut === true || res.status === undefined
  if (!uncertain) return { ok: false, verified: null, code: 'error', error: res.error }
  // 无 HTTP 状态的网络层失败更可能是离线（timeout 则可能只是慢）
  const offlineLikely = res.status === undefined && res.timedOut !== true
  const read = await jiraGetIssueStatus(cfg, key, fetchOpts)
  if (!read.ok) {
    return {
      ok: false,
      verified: null,
      code: offlineLikely ? 'offline' : 'uncertain',
      error: `执行结果未知且查询失败：${res.error ?? ''} / ${read.error ?? ''}`
    }
  }
  if (opts?.expectedToStatus !== undefined && read.status === opts.expectedToStatus) {
    return { ok: true, verified: 'already_applied', status: read.status }
  }
  return {
    ok: false,
    verified: null,
    code: 'uncertain',
    status: read.status,
    error: `执行结果未知（远端当前状态：${read.status}）。请先核实当前状态再决定是否重试，不要盲目重复执行`
  }
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
