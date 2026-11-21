import { z } from 'zod'
import { TEAM_MAX_REQUEST_BYTES, TEAM_MAX_RESPONSE_BYTES, teamApiReplySchema, teamCommandReplySchema, teamIdSchema, type TeamCommandReply, type TeamSession } from './contracts'

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0, readonly uncertain = false) { super(message) }
}
export const authEvents = new EventTarget()
const sessionSignalKey = 'trellis-team-session-signal-v1'
const sessionSignalOwner = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
/** Broadcast only a change signal, never account details or credentials. */
export function publishSessionChange(): void {
  try { const channel = new BroadcastChannel(sessionSignalKey); channel.postMessage(sessionSignalOwner); channel.close() } catch { /* Storage is a separate best-effort signal. */ }
  try { localStorage.setItem(sessionSignalKey, `${sessionSignalOwner}:${Date.now()}`); localStorage.removeItem(sessionSignalKey) } catch { /* The request-side session proof remains authoritative. */ }
}
export function listenForSessionChanges(onChange: () => void): () => void {
  let channel: BroadcastChannel | null = null
  try { channel = new BroadcastChannel(sessionSignalKey); channel.onmessage = (event) => { if (typeof event.data === 'string' && event.data !== sessionSignalOwner) onChange() } } catch { /* Storage is a separate best-effort signal. */ }
  const storage = (event: StorageEvent): void => { if (event.key === sessionSignalKey && event.newValue && !event.newValue.startsWith(`${sessionSignalOwner}:`)) onChange() }
  globalThis.addEventListener?.('storage', storage as EventListener)
  return () => { channel?.close(); globalThis.removeEventListener?.('storage', storage as EventListener) }
}
type RequestOptions = { body?: unknown; signal?: AbortSignal; notifyDenied?: boolean; isCurrent?: () => boolean; csrfToken?: string }
export async function request<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
  if (!/^\/(api|auth)\//.test(path) || path.includes('\\') || path.includes('#')) throw new ApiError('INVALID_PATH', '请求地址不属于团队接口')
  const scoped = path.startsWith('/api/') && !path.startsWith('/api/auth/options') && !/^\/api\/session(?:\?|$)/.test(path)
  const originalSession = scoped ? currentSession : null
  const originalGeneration = sessionGeneration
  if (scoped && (!originalSession || originalSession.authentication !== 'browser' || !originalSession.csrfToken)) throw new ApiError('UNAUTHENTICATED', '请先核对当前登录账号')
  const stillOwned = (): boolean => options.isCurrent?.() !== false && (!scoped || Boolean(originalSession && originalGeneration === sessionGeneration && isClientSession(originalSession)))
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000)
  const abort = (): void => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const encoded = options.body === undefined ? undefined : JSON.stringify(options.body)
  if (encoded && new TextEncoder().encode(encoded).byteLength > TEAM_MAX_REQUEST_BYTES) { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); throw new ApiError('CAPACITY_EXCEEDED', '正文及请求信息超过传输限额') }
  let dispatched = false
  try {
    dispatched = true
    const response = await fetch(path, { method: encoded === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrfToken ?? currentSession?.csrfToken ?? '' }), ...(originalSession?.csrfToken ? { 'X-Trellis-Session-Proof': originalSession.csrfToken } : {}) }, body: encoded })
    if (!stillOwned()) { await response.body?.cancel().catch(() => {}); throw new ApiError('OWNER_CHANGED', '来源已改变，原操作结果仍需由原账号核对', 0, encoded !== undefined) }
    if (scoped && response.ok && response.headers.get('X-Trellis-Session-Verified') !== '1') { await response.body?.cancel().catch(() => {}); throw new ApiError('SESSION_PROOF_UNAVAILABLE', '团队服务尚未支持账号隔离核对，请升级服务后重试', response.status, encoded !== undefined) }
    const length = Number(response.headers.get('Content-Length'))
    if (Number.isFinite(length) && length > TEAM_MAX_RESPONSE_BYTES) { await response.body?.cancel().catch(() => {}); throw new ApiError('INVALID_RESPONSE', '团队响应超过读取限额', response.status, encoded !== undefined) }
    if (!response.body) throw new ApiError('INVALID_RESPONSE', '团队响应没有正文', response.status, encoded !== undefined)
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > TEAM_MAX_RESPONSE_BYTES) throw new ApiError('INVALID_RESPONSE', '团队响应超过读取限额', response.status, encoded !== undefined); parts.push(part.value) } }
    catch (error) { await reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
    if (!stillOwned()) throw new ApiError('OWNER_CHANGED', '来源已改变，原操作结果仍需由原账号核对', 0, encoded !== undefined)
    const joined = new Uint8Array(size); let offset = 0; for (const part of parts) { joined.set(part, offset); offset += part.length }
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) } catch { throw new ApiError('INVALID_RESPONSE', '无法核对团队响应，请查询原操作结果', response.status, encoded !== undefined) }
    const parsed = teamApiReplySchema(schema).safeParse(raw)
    if (!parsed.success) throw new ApiError('INVALID_RESPONSE', '团队响应与当前接口版本不符', response.status, encoded !== undefined)
    if (!parsed.data.ok) {
      if (path === '/api/organizations' && response.status === 404 && parsed.data.code === 'NOT_FOUND') {
        throw new ApiError('ORGANIZATION_SETUP_UNAVAILABLE', '当前团队服务版本较旧。请重启更新后的团队服务，再创建组织。', 404)
      }
      if (parsed.data.code === 'SESSION_CHANGED') authEvents.dispatchEvent(new Event('external-session-changed'))
      if (options.notifyDenied !== false && !options.signal?.aborted && options.isCurrent?.() !== false && [401, 403].includes(response.status)) authEvents.dispatchEvent(new CustomEvent('denied', { detail: response.status }))
      throw new ApiError(parsed.data.code, parsed.data.error, response.status, encoded !== undefined && response.status >= 500)
    }
    if (!response.ok) throw new ApiError('INVALID_RESPONSE', '团队返回的状态与内容不一致', response.status, encoded !== undefined)
    return parsed.data.value
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('NETWORK_UNAVAILABLE', controller.signal.aborted ? '读取超时或已取消；写入结果需核对' : '暂时无法连接团队服务', 0, dispatched && encoded !== undefined)
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
}
let currentSession: TeamSession | null = null
let sessionGeneration = 0
export function setClientSession(session: TeamSession | null): void {
  const signature = (value: TeamSession | null): string => JSON.stringify(value ? [value.person.userId, value.csrfToken, value.authentication, value.deviceId] : null)
  const changed = signature(currentSession) !== signature(session)
  currentSession = session
  if (changed) { sessionGeneration++; authEvents.dispatchEvent(new Event('session-changed')) }
}
/** Check the live transport owner without exposing its credentials. */
export function isClientSession(session: TeamSession): boolean { return currentSession?.authentication === 'browser' && currentSession.person.userId === session.person.userId && currentSession.csrfToken === session.csrfToken }
export function requireBrowserCrypto(): void {
  if (typeof globalThis.crypto?.randomUUID !== 'function' || typeof globalThis.crypto?.subtle?.digest !== 'function') throw new ApiError('SECURE_CONTEXT_REQUIRED', '浏览器写入需要 HTTPS，或在服务电脑使用 localhost 地址；请调整团队服务入口。')
}
export async function digest(text: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
export async function verifyDocument(text: string, expected: string, byteLength: number): Promise<void> {
  if (new TextEncoder().encode(text).byteLength !== byteLength || await digest(text) !== expected) throw new ApiError('BODY_MISMATCH', '固定版本的正文与摘要不一致，已停止展示')
}

const workspaceReferenceSchema = z.object({ origin: z.url().max(2048), instanceId: teamIdSchema, epoch: teamIdSchema, operation: z.string().min(1).max(100), expectedRevision: z.number().int().nonnegative() }).strict()
const journalEntrySchema = z.object({ commandId: teamIdSchema, accountId: teamIdSchema, projectId: teamIdSchema.nullable(), path: z.string().max(300), digest: z.string().regex(/^[0-9a-f]{64}$/), createdAt: z.number().int(), state: z.enum(['pending', 'unknown']), workspace: workspaceReferenceSchema.optional() }).strict()
const journalSchema = z.array(journalEntrySchema).max(50)
export type PendingCommand = z.infer<typeof journalSchema>[number]
export type WorkspaceCommandReference = z.infer<typeof workspaceReferenceSchema>
const STORAGE = 'trellis-team-command-refs-v1'
export const commandEvents = new EventTarget()
function readJournal(): PendingCommand[] {
  const raw = sessionStorage.getItem(STORAGE)
  if (!raw) return []
  try { return journalSchema.parse(JSON.parse(raw)) } catch { throw new ApiError('JOURNAL_INVALID', '本页保留的操作引用无法核对，请保留浏览器数据并联系管理员') }
}
function writeJournal(records: PendingCommand[]): void {
  try { sessionStorage.setItem(STORAGE, JSON.stringify(records)) } catch { throw new ApiError('JOURNAL_UNAVAILABLE', '浏览器无法保留操作引用，暂不能提交写入') }
  commandEvents.dispatchEvent(new Event('change'))
}
export function pendingCommands(accountId: string): PendingCommand[] { return readJournal().filter((entry) => entry.accountId === accountId) }
const remembered = new Map<string, { path: string; body: Record<string, unknown>; schema: z.ZodType; accountId: string }>()
const active = new Set<string>()
const uncertainCommands = new Set<string>()
export type PreparedCommand<T> = { entry: PendingCommand; body: Record<string, unknown>; schema: z.ZodType<T> }
const resourceSessions = new WeakMap<object, { session: TeamSession; generation: number }>()
function isResourceCommand(entry: PendingCommand): boolean { return entry.path.endsWith('/code-resources/commands') }
function isMaterialCommand(entry: PendingCommand): boolean { return /^\/api\/projects\/[^/]+\/crux\/tasks\/[^/]+\/materials\/commands$/.test(entry.path) }
function isContentCommand(entry: PendingCommand): boolean { return /^\/api\/teams\/[^/]+\/content\/(?:config|probe)$/.test(entry.path) || /^\/api\/projects\/[^/]+\/crux\/tasks\/[^/]+\/content\/jobs(?:\/[^/]+\/cancel)?$/.test(entry.path) }
function isDomainCommand(entry: PendingCommand): boolean {
  return isResourceCommand(entry) || isMaterialCommand(entry) || isContentCommand(entry) ||
    /^\/api\/projects\/[^/]+\/crux\/spaces\/[^/]+\/governance\/commands$/.test(entry.path) ||
    /^\/api\/projects\/[^/]+\/crux\/tasks\/[^/]+\/inputs\/commands$/.test(entry.path)
}
export async function prepareCommand<T>(path: string, body: Record<string, unknown>, schema: z.ZodType<T>, projectId: string | null, workspace?: WorkspaceCommandReference, originalCommandId?: string): Promise<PreparedCommand<T>> {
  requireBrowserCrypto()
  if (!currentSession || currentSession.authentication !== 'browser') throw new ApiError('UNAUTHENTICATED', '请先登录')
  const accountId = currentSession.person.userId
  const session = currentSession
  const generation = sessionGeneration
  // Only references/digests persist in browser session storage; never bodies or credentials.
  const commandId = originalCommandId === undefined ? crypto.randomUUID() : z.string().uuid().parse(originalCommandId), pinned = structuredClone({ ...body, commandId })
  const entry: PendingCommand = { commandId, accountId, projectId, path, digest: await digest(JSON.stringify(pinned)), createdAt: Date.now(), state: 'pending', ...(workspace ? { workspace: workspaceReferenceSchema.parse(workspace) } : {}) }
  if (isDomainCommand(entry) && (!isClientSession(session) || generation !== sessionGeneration)) throw new ApiError('OWNER_CHANGED', '原操作的登录会话已改变，未发送')
  const entries = readJournal()
  if (entries.some((item) => item.commandId === commandId)) throw new ApiError('PENDING_COMMAND', '原操作已保留，请核对或重试原操作')
  if (entries.length >= 50) throw new ApiError('CAPACITY_EXCEEDED', '待核对操作已达上限，请先核对保留的结果')
  writeJournal([...entries, entry]); remembered.set(commandId, { path, body: pinned, schema, accountId })
  const prepared = { entry, body: pinned, schema }
  if (isDomainCommand(entry)) resourceSessions.set(prepared, { session, generation })
  return prepared
}
type CommandOptions = { notifyDenied?: boolean; signal?: AbortSignal; isCurrent?: () => boolean; retainRejected?: (error: ApiError) => boolean; validateResult?: (value: unknown) => void }
export async function sendCommand<T>(prepared: PreparedCommand<T>, options: CommandOptions = {}): Promise<TeamCommandReply<T>> {
  requireBrowserCrypto()
  const { entry, body, schema } = prepared
  const resourceSession = resourceSessions.get(prepared)
  const ownsResourceSession = (): boolean => !isDomainCommand(entry) || Boolean(resourceSession && isClientSession(resourceSession.session) && resourceSession.generation === sessionGeneration)
  if (!ownsResourceSession()) throw new ApiError('PAYLOAD_UNAVAILABLE', '原操作正文属于先前登录会话，不能重试；请核对原操作回执')
  if (isDomainCommand(entry) && !options.validateResult) throw new ApiError('RESOURCE_RECOVERY_REQUIRED', '请在原工作区的对应功能中核对或重试此操作')
  if (active.has(entry.commandId)) throw new ApiError('IN_FLIGHT', '此操作正在核对')
  if (options.isCurrent?.() === false || currentSession?.person.userId !== entry.accountId || await digest(JSON.stringify(body)) !== entry.digest) throw new ApiError('OWNER_CHANGED', '操作的账号或内容已改变')
  // The digest awaited above; recheck the actual account immediately before fetch.
  if (options.isCurrent?.() === false || currentSession?.person.userId !== entry.accountId || options.signal?.aborted || !ownsResourceSession()) throw new ApiError('OWNER_CHANGED', '操作账号或来源在内容核对期间已改变，未发送')
  if (active.has(entry.commandId)) throw new ApiError('IN_FLIGHT', '此操作正在核对')
  const previouslyUnknown = uncertainCommands.has(entry.commandId) || entry.state === 'unknown' || readJournal().some((item) => item.commandId === entry.commandId && item.state === 'unknown')
  active.add(entry.commandId)
  try {
    const reply = await request(entry.path, teamCommandReplySchema(schema), { body, notifyDenied: options.notifyDenied, signal: options.signal, isCurrent: () => currentSession?.person.userId === entry.accountId && options.isCurrent?.() !== false && ownsResourceSession() })
    if (reply.commandId !== entry.commandId) throw new ApiError('INVALID_RESPONSE', '操作回执身份不匹配', 0, true)
    options.validateResult?.(reply.result)
    try { writeJournal(readJournal().filter((item) => item.commandId !== entry.commandId)) }
    catch { throw new ApiError('LOCAL_RECEIPT_UNAVAILABLE', '服务端已有回执，但浏览器未能保存核对结果；请保留原操作并再次核对', 0, true) }
    remembered.delete(entry.commandId); uncertainCommands.delete(entry.commandId)
    return reply
  } catch (error) {
    if (error instanceof ApiError && !error.uncertain && !previouslyUnknown) {
      try { if (!options.retainRejected?.(error)) { writeJournal(readJournal().filter((item) => item.commandId !== entry.commandId)); remembered.delete(entry.commandId); uncertainCommands.delete(entry.commandId) } }
      catch { throw new ApiError('LOCAL_RECEIPT_UNAVAILABLE', '浏览器未能保存操作核对结果；保留原标识，不创建重复操作', 0, true) }
    } else {
      // A rejected retry says nothing about the earlier unacknowledged write.
      // Keep that uncertainty even if relabelling browser storage fails.
      uncertainCommands.add(entry.commandId)
      // The original pending reference was persisted before dispatch. Failure to
      // label it unknown must not replace the original uncertain transport result.
      try { writeJournal(readJournal().map((item) => item.commandId === entry.commandId ? { ...item, state: 'unknown' } : item)) } catch { /* Keep the original persisted reference and exact in-memory payload. */ }
      if (error instanceof ApiError && !error.uncertain) throw new ApiError(error.code, error.message + '；原操作结果仍未确认，请保留原标识核对', error.status, true)
    }
    throw error
  } finally { active.delete(entry.commandId) }
}
export async function reconcileCommand(entry: PendingCommand, options: Omit<CommandOptions, 'retainRejected'> & { validateResult?: (value: unknown) => void } = {}): Promise<'committed' | 'absent'> {
  // Material receipts require the task-scoped route's current document/source
  // ACL. A generic result validator cannot replace that server-side check.
  if (isMaterialCommand(entry) || isContentCommand(entry)) throw new ApiError('RESOURCE_RECOVERY_REQUIRED', '请在原功能中核对此操作')
  if (isDomainCommand(entry) && !options.validateResult) throw new ApiError('RESOURCE_RECOVERY_REQUIRED', '请在原工作区的对应功能中核对此操作')
  if (options.isCurrent?.() === false || currentSession?.person.userId !== entry.accountId) throw new ApiError('OWNER_CHANGED', '请使用原操作账号核对')
  const schema = z.object({ commandId: teamIdSchema, kind: z.string(), status: z.literal('committed'), recordedAt: z.number().int(), result: z.unknown() }).strict()
  try {
    const reply = await request(`/api/commands/${entry.commandId}`, schema, { notifyDenied: options.notifyDenied, signal: options.signal, isCurrent: () => currentSession?.person.userId === entry.accountId && options.isCurrent?.() !== false })
    if (reply.commandId !== entry.commandId) throw new ApiError('INVALID_RESPONSE', '核对回执身份不匹配')
    options.validateResult?.(reply.result)
    writeJournal(readJournal().filter((item) => item.commandId !== entry.commandId)); remembered.delete(entry.commandId); uncertainCommands.delete(entry.commandId)
    return 'committed'
  } catch (error) { if (error instanceof ApiError && error.status === 404) return 'absent'; throw error }
}
/** Explicitly archive references, preserving uncertainty and a bounded metadata-only history. */
export function archiveCommand(entry: PendingCommand, outcomeUnknown: boolean): void {
  if (currentSession?.person.userId !== entry.accountId) throw new ApiError('OWNER_CHANGED', '请使用原操作账号归档引用')
  const historyKey = 'trellis-team-command-history-v1'
  const historySchema = z.array(journalEntrySchema.extend({ archivedAt: z.number().int(), outcomeUnknown: z.boolean() }).strict()).max(100)
  try {
    const raw = sessionStorage.getItem(historyKey), history = raw ? historySchema.parse(JSON.parse(raw)) : []
    sessionStorage.setItem(historyKey, JSON.stringify([...history.filter((item) => item.commandId !== entry.commandId).slice(-99), { ...entry, archivedAt: Date.now(), outcomeUnknown }]))
  } catch { throw new ApiError('JOURNAL_UNAVAILABLE', '浏览器无法保存原操作归档，原引用仍保留') }
  writeJournal(readJournal().filter((item) => item.commandId !== entry.commandId))
  remembered.delete(entry.commandId); uncertainCommands.delete(entry.commandId)
}
export async function retryCommand(entry: PendingCommand): Promise<void> {
  if (isDomainCommand(entry)) throw new ApiError('RESOURCE_RECOVERY_REQUIRED', '请在原工作区的对应功能中核对或重试此操作')
  const saved = remembered.get(entry.commandId)
  if (!saved || saved.accountId !== currentSession?.person.userId) throw new ApiError('PAYLOAD_UNAVAILABLE', '页面重载后只保留操作引用，不能重构或猜测原请求；请继续核对服务端结果')
  await sendCommand({ entry, body: saved.body, schema: saved.schema })
}
export function canRetry(entry: PendingCommand): boolean { return !isDomainCommand(entry) && remembered.get(entry.commandId)?.accountId === currentSession?.person.userId }

/** Used only after a domain-specific, identity-checked receipt has been read. */
export function settleCommandReference(entry: PendingCommand): void {
  if (currentSession?.person.userId !== entry.accountId) throw new ApiError('OWNER_CHANGED', '请使用原操作账号核对')
  const records = readJournal()
  if (records.some((item) => item.commandId === entry.commandId && item.digest !== entry.digest)) throw new ApiError('COMMAND_CONFLICT', '原操作摘要不匹配')
  writeJournal(records.filter((item) => item.commandId !== entry.commandId))
  remembered.delete(entry.commandId); uncertainCommands.delete(entry.commandId)
}

/** Content replies use domain wrappers; preserve their unknown outcome in the existing metadata journal. */
export function retainContentCommandUncertainty(entry: PendingCommand): void {
  if (!isContentCommand(entry) || currentSession?.person.userId !== entry.accountId) throw new ApiError('OWNER_CHANGED', '请使用原操作账号核对')
  uncertainCommands.add(entry.commandId)
  writeJournal(readJournal().map(item => item.commandId === entry.commandId ? { ...item, state: 'unknown' } : item))
}
