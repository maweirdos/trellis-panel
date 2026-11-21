import { createHash, randomUUID } from 'node:crypto'
import type { WorkspaceGrant } from '../../shared/daemon'
import type { FeishuActions, FeishuAttempt, FeishuConnection, FeishuInput, FeishuOutput } from '../../shared/feishu-integration'
import { DaemonError } from './errors'
import { FeishuStateOwner, type FeishuState, type StoredFeishuConnection } from './feishu-state'
import type { FeishuMessage, createFeishuVendor } from '../services/integrations/feishu-workspace/vendor'
import { IntegrationError } from '../services/integrations/types'
import { feishuMemberCodeSchema } from '../../shared/feishu-member'

type Vendor = ReturnType<typeof createFeishuVendor>
type FeishuMessageIdentity = { tenantKey: string; appId: string; senderOpenId: string }
export interface FeishuMessageWork {
  workspace: WorkspaceGrant | null
  spaceId: string
  agentId: string | null
  scopeKey: string
  providerId?: string
  modelId?: string
  runtimeId?: 'pi'
  identity: FeishuMessageIdentity & { bindingId: string }
  source: { chatId: string; messageId: string; threadId?: string }
  text: string
  context: { at: number; text: string; messageId: string; senderOpenId?: string }[]
  commandId: string
  assertCurrent(): void
}
type FeishuAdmission = Pick<FeishuMessageWork, 'workspace' | 'spaceId' | 'scopeKey' | 'assertCurrent'> & {
  identity: FeishuMessageIdentity
}

interface FeishuOptions {
  directory: string
  assertOwner(): void
  capture(root: string): WorkspaceGrant
  assertGrant(grant: WorkspaceGrant): void
  vendor: Vendor
  runtimes?(): Promise<NonNullable<FeishuOutput<'snapshot'>['runtimes']>>
  validateTarget(input: FeishuInput<'beginRegistration'>, grant: WorkspaceGrant | null): Promise<string>
  authorize(input: FeishuAdmission, signal: AbortSignal): Promise<string | null>
  linkMember(input: FeishuAdmission & { code: string }, signal: AbortSignal): Promise<boolean>
  recover(input: Pick<FeishuMessageWork, 'workspace' | 'spaceId' | 'scopeKey' | 'identity' | 'commandId' | 'assertCurrent'>, signal: AbortSignal): Promise<{ text: string; outcome: 'completed' | 'clarify' | 'denied' | 'unknown' }>
  run(input: FeishuMessageWork, signal: AbortSignal): Promise<{ text: string; outcome: 'completed' | 'clarify' | 'denied' | 'unknown' }>
}

type Attempt = {
  target: string; root: string | null; grant: WorkspaceGrant | null; scopeKey?: string
  view: FeishuAttempt; controller: AbortController; until: number; unpersistedUnknown?: boolean
  registrationInput?: FeishuInput<'beginRegistration'>
}
type Worker = {
  state: 'connecting' | 'connected' | 'failed'
  detail: string
  revision: number
  after: number
  close?: () => void
}
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 16
const MAX_RECEIPTS = 4000
const MAX_IN_FLIGHT = 8
const registrationUnknown = '请在飞书开放平台核对原应用。确认没有重复应用后，可以重新授权。'

function bindingCode(text: string): string | undefined {
  const match = /^绑定\s+(\S+)$/u.exec(text.trim())
  return match && feishuMemberCodeSchema.safeParse(match[1]).success ? match[1] : undefined
}

function includesBindingCode(text: string): boolean {
  return /(?:^|\s)绑定\s+[A-Za-z0-9_-]{21}[AQgw](?![A-Za-z0-9_-])/u.test(text)
}

function digest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function stableId(key: string, operation: string): string {
  const hash = digest([key, operation])
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function isPending(attempt: Attempt): boolean {
  return attempt.view.status === 'starting' || attempt.view.status === 'pending'
}

function sameGrant(left: WorkspaceGrant | null, right: WorkspaceGrant | null): boolean {
  if (!left || !right) return left === right
  return left.workspaceId === right.workspaceId && left.root === right.root &&
    left.grantId === right.grantId && left.revision === right.revision
}

function sameWorkspace(left: WorkspaceGrant | null, right: WorkspaceGrant | null): boolean {
  if (!left || !right) return left === right
  return left.workspaceId === right.workspaceId && left.root === right.root
}

function requiresRegistrationReview(marker: FeishuState['pendingRegistrations'][string]): boolean {
  return marker.phase === 'committing' || marker.phase === 'unknown'
}

export function installFeishu(options: FeishuOptions) {
  const { vendor } = options
  const store = new FeishuStateOwner(options.directory, options.assertOwner)
  const attempts = new Map<string, Attempt>()
  const workers = new Map<string, Worker>()
  const active = new Map<string, { root: string | null; controller: AbortController; promise: Promise<void> }>()
  let closed = false
  let probing = false
  let savingOrg = false

  function org(state = store.read()): StoredFeishuConnection | undefined {
    return state.connections.find(row => row.view.kind === 'organization')
  }

  function assertOpen(): void {
    options.assertOwner()
    if (closed || probing) throw new DaemonError('E_BUSY', '飞书后台正在停止接入，请稍后再试。')
  }

  const credentials = (row: StoredFeishuConnection) => ({ appId: row.view.appId, appSecret: row.secret })

  function visible(row: StoredFeishuConnection, grant: WorkspaceGrant | null, scopeKey?: string): boolean {
    if (row.view.kind === 'organization') return true
    return Boolean(scopeKey && row.view.scopeKey === scopeKey && (!row.grant || row.grant.workspaceId === grant?.workspaceId))
  }

  function grantOf(input: { expectedRoot: string | null }): WorkspaceGrant | null {
    return input.expectedRoot === null ? null : options.capture(input.expectedRoot)
  }

  function stopWorker(id: string): void {
    const worker = workers.get(id)
    if (!worker) return
    workers.delete(id)
    worker.close?.()
  }

  function projection(row: StoredFeishuConnection): FeishuConnection {
    if (!row.view.enabled) return { ...row.view, state: 'stopped', detail: '已停用' }
    if (row.grant) {
      try { options.assertGrant(row.grant) }
      catch { return { ...row.view, state: 'blocked', detail: '原工作区授权已变更，请重新绑定。' } }
    }
    const worker = workers.get(row.view.id)
    return worker ? { ...row.view, state: worker.state, detail: worker.detail } : row.view
  }

  function observed(row: StoredFeishuConnection, state: FeishuState): FeishuConnection {
    let latest: FeishuConnection['lastOperation']
    const pending: NonNullable<FeishuConnection['pendingOperations']> = []
    for (const [key, receipt] of Object.entries(state.receipts)) {
      if (receipt.connectionId !== row.view.id) continue
      const projected = {
        at: receipt.at, commandId: receipt.commandId, sourceMessageId: receipt.sourceMessageId,
        phase: receipt.phase === 'accepted' && !active.has(key) ? 'unknown' as const : receipt.phase,
        reply: receipt.reply === 'dispatching' && !active.has(key) ? 'unknown' as const : receipt.reply
      }
      if (!latest || receipt.at >= latest.at) latest = projected
      if (receipt.bindingId && projected.phase === 'unknown') pending.push(projected)
    }
    return { ...projection(row), ...(latest ? { lastOperation: latest } : {}),
      pendingOperations: pending.sort((left, right) => right.at - left.at).slice(0, 20) }
  }

  function selected(input: FeishuInput<'retry'>): StoredFeishuConnection {
    const grant = grantOf(input)
    const row = store.read().connections.find(item => item.view.id === input.id && visible(item, grant, input.selectedScopeKey))
    if (!row || row.view.revision !== input.revision) throw new DaemonError('E_CONFLICT', '飞书连接已变更，请刷新。')
    return row
  }

  function assertOriginal(row: StoredFeishuConnection): WorkspaceGrant | null {
    options.assertOwner()
    if (closed) throw new DaemonError('E_BUSY', '飞书后台已经停止接入。')
    if (row.view.kind === 'organization' || !row.view.scopeKey || !store.read().connections.some(item => item.view.id === row.view.id && item.view.revision === row.view.revision && item.view.enabled)) {
      throw new DaemonError('E_DENIED', '原飞书连接已停用或变更。')
    }
    if (row.grant) options.assertGrant(row.grant)
    return row.grant
  }

  function setReceipt(key: string, change: Partial<FeishuState['receipts'][string]>): void {
    store.update(state => {
      const record = state.receipts[key]
      if (!record) throw new DaemonError('E_CONFLICT', '飞书事件失去原回执。')
      state.receipts[key] = { ...record, ...change }
    })
  }

  async function runMessage(row: StoredFeishuConnection, message: FeishuMessage, key: string, signal: AbortSignal): Promise<void> {
    const { spaceId, scopeKey, agentId, providerId, modelId } = row.view
    if (!spaceId || !scopeKey) throw new DaemonError('E_DENIED', '飞书连接缺少原空间身份。')
    const assertCurrent = () => { signal.throwIfAborted(); assertOriginal(row) }
    try {
      assertCurrent()
      const identity = { tenantKey: message.tenantKey, appId: row.view.appId, senderOpenId: message.senderOpenId }
      const admission = { workspace: assertOriginal(row), scopeKey, spaceId, identity, assertCurrent }
      const code = bindingCode(message.text)
      if (code) {
        if (message.isGroup) { setReceipt(key, { phase: 'failed' }); return }
        const linked = await options.linkMember({ ...admission, code }, signal)
        setReceipt(key, { phase: linked ? 'completed' : 'failed' })
        await reply(linked ? '飞书账号已绑定。现在可以使用这个助手。' : '绑定未确认。请在 Crux 核对当前空间的飞书账号状态。')
        return
      }
      if (includesBindingCode(message.text)) { setReceipt(key, { phase: 'failed' }); return }
      const bindingId = await options.authorize(admission, signal)
      if (!bindingId) {
        setReceipt(key, { phase: 'failed' })
        return
      }
      assertCurrent()
      setReceipt(key, { bindingId })
      const history = await vendor.history(credentials(row), message, signal).catch(() => [])
      assertCurrent()
      let remaining = Math.max(0, 16000 - message.text.length)
      const seen = new Set([message.messageId])
      const context = history.filter(item => item.at <= message.at &&
        (message.threadId || item.messageId === message.parentId || message.at - item.at <= 30 * 60 * 1000))
        .sort((left, right) => right.at - left.at).flatMap(item => {
          if (!remaining || seen.has(item.messageId) || seen.size >= 30 || !item.text.trim() || includesBindingCode(item.text)) return []
          seen.add(item.messageId)
          const text = item.text.slice(0, remaining)
          remaining -= text.length
          return [{ ...item, text }]
        }).reverse()
      const result = await options.run({
        workspace: assertOriginal(row), scopeKey, spaceId, agentId, providerId: providerId ?? undefined, modelId: modelId ?? undefined,
        identity: { ...identity, bindingId }, runtimeId: row.view.runtimeId,
        source: { chatId: message.chatId, messageId: message.messageId, threadId: message.threadId },
        text: message.text.slice(0, 16000), context, commandId: stableId(key, 'effect'), assertCurrent
      }, signal)
      setReceipt(key, { phase: result.outcome === 'unknown' ? 'unknown' : result.outcome === 'denied' ? 'failed' : 'completed' })
      assertCurrent()
      if (result.text.trim() && await options.authorize(admission, signal) === bindingId) await reply(result.text)
    } catch {
      const receipt = store.read().receipts[key]
      if (receipt?.phase === 'accepted') setReceipt(key, { phase: 'unknown' })
      if (receipt?.reply === 'dispatching') setReceipt(key, { reply: 'unknown' })
    }

    async function reply(text: string): Promise<void> {
      assertCurrent()
      setReceipt(key, { reply: 'dispatching' })
      try {
        await vendor.reply(credentials(row), message.messageId, text.slice(0, 4000), stableId(key, 'reply'), signal)
        setReceipt(key, { reply: 'sent' })
      } catch (error) {
        setReceipt(key, { reply: error instanceof IntegrationError && error.kind !== 'uncertain' ? 'failed' : 'unknown' })
      }
    }
  }

  async function receive(row: StoredFeishuConnection, message: FeishuMessage): Promise<void> {
    if (closed || probing || row.view.kind === 'organization') return
    if (message.isGroup) {
      if (!row.botOpenId || !row.view.allowedChatIds.includes(message.chatId) || !message.mentionedOpenIds.includes(row.botOpenId) || includesBindingCode(message.text)) return
    } else if (row.view.kind !== 'agent' && !bindingCode(message.text)) return
    const grant = assertOriginal(row)
    const now = Date.now()
    if (!Number.isFinite(message.at) || message.at < now - LIFETIME_MS || message.at > now + 5 * 60 * 1000) return
    const key = digest([message.tenantKey, row.view.appId, message.messageId])
    if (store.read().receipts[key]) return
    if (active.size >= MAX_IN_FLIGHT) throw new DaemonError('E_BUSY', '飞书任务助手已达到并发上限。')
    store.update(state => {
      for (const [oldKey, receipt] of Object.entries(state.receipts)) if (receipt.at < now - LIFETIME_MS && !active.has(oldKey)) delete state.receipts[oldKey]
      if (Object.keys(state.receipts).length >= MAX_RECEIPTS) throw new DaemonError('E_BUSY', '飞书事件回执达到上限。')
      state.receipts[key] = { at: now, connectionId: row.view.id, commandId: stableId(key, 'effect'), sourceMessageId: message.messageId,
        tenantKey: message.tenantKey, chatId: message.chatId, senderOpenId: message.senderOpenId, phase: 'accepted', reply: 'none' }
    })
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    const promise = Promise.resolve().then(() => runMessage(row, message, key, signal)).catch(() => undefined).finally(() => active.delete(key))
    active.set(key, { root: grant?.root ?? null, controller, promise })
  }

  async function poll(): Promise<void> {
    if (closed || probing) return
    const now = Date.now()
    for (const [id, attempt] of attempts) {
      if (isPending(attempt) && now >= attempt.until) expire(attempt)
      if (!isPending(attempt) && !attempt.unpersistedUnknown && now > attempt.until + 15 * 60 * 1000) attempts.delete(id)
    }
    const state = store.read()
    const eligible = state.connections.filter(row => {
      if (!row.view.enabled) return false
      try { if (row.grant) options.assertGrant(row.grant); return true } catch { return false }
    })
    for (const [id, worker] of workers) {
      const row = eligible.find(candidate => candidate.view.id === id)
      if (!row || row.view.revision !== worker.revision || (worker.state === 'failed' && now >= worker.after)) stopWorker(id)
    }
    await Promise.allSettled(eligible.filter(row => !workers.has(row.view.id)).map(async row => {
      const id = row.view.id
      const worker: Worker = { state: 'connecting', detail: '正在连接飞书。', revision: row.view.revision, after: now + 30_000 }
      workers.set(id, worker)
      try {
        let verified = row
        if (!row.botOpenId) {
          const bot = await vendor.verify(credentials(row), AbortSignal.timeout(20_000))
          if (closed || workers.get(id) !== worker) return
          assertOriginal(row)
          verified = { ...row, botOpenId: bot.botOpenId }
          store.update(state => { state.connections = state.connections.map(item => item.view.id === id ? verified : item) })
        }
        const watch = await vendor.listen(credentials(verified), {
          onMessage: message => receive(verified, message),
          onState: (state, detail) => {
            if (workers.get(id) !== worker) return
            worker.state = state
            worker.detail = detail.slice(0, 400)
            worker.after = Date.now() + 30_000
          }
        })
        if (closed || workers.get(id) !== worker) watch.close()
        else worker.close = () => watch.close()
      } catch {
        worker.state = 'failed'
        worker.detail = row.botOpenId ? '无法建立飞书长连接，请核对应用能力、事件订阅和网络。'
          : '还无法验证机器人，请核对飞书应用的发布、管理员审批和机器人能力。'
      }
    }))
  }

  function publicAttempt(input: { expectedRoot: string | null; attemptId: string; selectedScopeKey?: string }, account: boolean): Attempt {
    const attempt = attempts.get(input.attemptId)
    const grant = grantOf(input)
    if (!attempt || !sameGrant(attempt.grant, grant) || (attempt.target === 'account') !== account || (!account && input.selectedScopeKey !== attempt.scopeKey)) {
      throw new DaemonError('E_CONFLICT', '请回到原团队空间核对飞书授权。')
    }
    if (attempt.grant) options.assertGrant(attempt.grant)
    if (isPending(attempt) && Date.now() >= attempt.until) expire(attempt)
    return attempt
  }

  function forgetRegistration(target: string, id: string): void {
    if (store.read().pendingRegistrations[target]?.id === id) store.update(state => {
      if (state.pendingRegistrations[target]?.id === id) delete state.pendingRegistrations[target]
    })
  }

  function markRegistration(attempt: Attempt, phase: 'committing' | 'unknown'): void {
    store.update(state => {
      const marker = state.pendingRegistrations[attempt.target]
      if (!marker || marker.id !== attempt.view.id) throw new DaemonError('E_CONFLICT', '原飞书注册记录已改变。')
      marker.phase = phase
    })
  }

  function clearInactiveRegistrations(target: string, scopeKey: string | undefined, grant: WorkspaceGrant | null): void {
    function belongsToSelection(key: string, marker: FeishuState['pendingRegistrations'][string]): boolean {
      return (key === target || (marker.scopeKey !== undefined && marker.scopeKey === scopeKey)) &&
        (marker.grant === undefined || sameWorkspace(marker.grant, grant))
    }
    const inactive = Object.entries(store.read().pendingRegistrations).filter(([key, marker]) => {
      const attempt = attempts.get(marker.id)
      return !requiresRegistrationReview(marker) && belongsToSelection(key, marker) &&
        (!attempt || (!isPending(attempt) && attempt.view.status !== 'unknown'))
    })
    if (!inactive.length) return
    store.update(state => {
      for (const [key, marker] of inactive) {
        const current = state.pendingRegistrations[key]
        const attempt = attempts.get(marker.id)
        if (current?.id === marker.id && !requiresRegistrationReview(current) && belongsToSelection(key, current) &&
            (!attempt || (!isPending(attempt) && attempt.view.status !== 'unknown'))) {
          delete state.pendingRegistrations[key]
        }
      }
    })
  }

  function finishWaiting(attempt: Attempt, status: 'expired' | 'cancelled'): void {
    attempt.controller.abort()
    try {
      const marker = attempt.target === 'account' ? undefined : store.read().pendingRegistrations[attempt.target]
      if (marker?.id === attempt.view.id && requiresRegistrationReview(marker)) {
        attempt.view = { ...attempt.view, status: 'unknown', url: null, detail: registrationUnknown }
      } else {
        if (marker?.id === attempt.view.id) forgetRegistration(attempt.target, attempt.view.id)
        attempt.view = {
          ...attempt.view, status, url: null,
          detail: status === 'expired' ? '授权已过期，请重新开始。' : '已停止在 Crux 等待授权。'
        }
      }
    } catch (error) {
      attempt.unpersistedUnknown = true
      attempt.view = { ...attempt.view, status: 'unknown', url: null, detail: registrationUnknown }
      throw error
    }
  }

  function expire(attempt: Attempt): void {
    if (isPending(attempt)) finishWaiting(attempt, 'expired')
  }

  function cancel(attempt: Attempt): FeishuAttempt {
    if (isPending(attempt)) finishWaiting(attempt, 'cancelled')
    return attempt.view
  }

  function startAttempt(target: string, grant: WorkspaceGrant | null, scopeKey: string | undefined,
    registrationInput: FeishuInput<'beginRegistration'> | undefined,
    run: (attempt: Attempt, onQr: (url: string, expiresAt: number) => void) => Promise<void>): FeishuAttempt {
    const retained = [...attempts.values()].find(attempt => attempt.target === target && isPending(attempt))
    if (retained) {
      if (retained.scopeKey !== scopeKey || !sameWorkspace(retained.grant, grant)) throw new DaemonError('E_CONFLICT', '原飞书授权仍在另一个工作区等待。')
      if (!sameGrant(retained.grant, grant)) {
        if (!registrationInput) throw new DaemonError('E_CONFLICT', '原飞书授权仍在另一个工作区等待。')
        cancel(retained)
        if (retained.view.status === 'unknown') {
          retained.grant = grant
          retained.registrationInput = { ...registrationInput }
          return retained.view
        }
      } else {
        if (retained.grant) options.assertGrant(retained.grant)
        if (Date.now() >= retained.until) expire(retained)
        if (isPending(retained)) return retained.view
      }
    }
    const unresolved = [...attempts.values()].find(attempt => attempt.target === target && attempt.view.status === 'unknown')
    if (unresolved) {
      if (!sameWorkspace(unresolved.grant, grant) || unresolved.scopeKey !== scopeKey) throw new DaemonError('E_CONFLICT', '原飞书授权属于另一个工作区。')
      if (!sameGrant(unresolved.grant, grant)) {
        if (!registrationInput) throw new DaemonError('E_CONFLICT', '原飞书授权属于另一个工作区。')
        unresolved.controller.abort()
        unresolved.grant = grant
        unresolved.registrationInput = { ...registrationInput }
        unresolved.view = { ...unresolved.view, url: null }
      } else if (unresolved.grant) options.assertGrant(unresolved.grant)
      return unresolved.view
    }
    let unconfirmed = target === 'account' ? undefined : store.read().pendingRegistrations[target]
    if (unconfirmed && ((unconfirmed.scopeKey !== undefined && unconfirmed.scopeKey !== scopeKey) ||
        (unconfirmed.grant === undefined && requiresRegistrationReview(unconfirmed)) ||
        (unconfirmed.grant !== undefined && !sameWorkspace(unconfirmed.grant, grant)))) {
      throw new DaemonError('E_CONFLICT', '原飞书授权属于另一个工作区。')
    }
    if (target !== 'account') {
      clearInactiveRegistrations(target, scopeKey, grant)
      unconfirmed = store.read().pendingRegistrations[target]
    }
    if (attempts.size >= MAX_ATTEMPTS) {
      for (const [id, attempt] of attempts) if (!isPending(attempt) && !attempt.unpersistedUnknown) attempts.delete(id)
    }
    if (attempts.size >= MAX_ATTEMPTS) throw new DaemonError('E_BUSY', '同时等待的飞书授权过多。')
    const id = unconfirmed?.id ?? randomUUID()
    const attempt: Attempt = {
      target, root: grant?.root ?? null, grant, scopeKey, until: Date.now() + 10 * 60 * 1000,
      view: { id, status: 'starting', url: null, expiresAt: null, detail: '正在请求飞书授权。' },
      controller: new AbortController(), ...(registrationInput ? { registrationInput: { ...registrationInput } } : {})
    }
    attempts.set(id, attempt)
    if (unconfirmed) {
      attempt.view = { ...attempt.view, status: 'unknown', expiresAt: unconfirmed.expiresAt, detail: registrationUnknown }
      return attempt.view
    }
    void Promise.resolve().then(() => run(attempt, (raw, expiresAt) => {
      if (!isPending(attempt) || attempt.controller.signal.aborted) return
      const url = new URL(raw)
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !['open.feishu.cn', 'accounts.feishu.cn'].includes(url.hostname) || raw.length > 4096) {
        throw new DaemonError('E_DENIED', '飞书返回的授权地址不受信任。')
      }
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new DaemonError('E_INVALID_ARG', '飞书授权时间无效。')
      attempt.until = Math.min(attempt.until, expiresAt)
      if (target !== 'account') store.update(state => {
        const marker = state.pendingRegistrations[target]
        if (marker && marker.id !== id) throw new DaemonError('E_CONFLICT', '原飞书注册记录已改变。')
        if (marker && requiresRegistrationReview(marker)) throw new DaemonError('E_CONFLICT', '原飞书注册结果尚未确认。')
        if (!marker && Object.keys(state.pendingRegistrations).length >= 50) throw new DaemonError('E_BUSY', '待核实的授权已达到上限。')
        state.pendingRegistrations[target] = { id, expiresAt: attempt.until, phase: 'pending', grant, scopeKey }
      })
      attempt.view = { ...attempt.view, status: 'pending', expiresAt: attempt.until, url: url.href, detail: '等待在飞书完成授权。' }
    })).then(() => {
      if (isPending(attempt)) attempt.view = { ...attempt.view, status: 'connected', url: null, detail: '授权已确认。' }
    }).catch((error: unknown) => {
      if (!isPending(attempt)) return
      if (target !== 'account' && store.read().pendingRegistrations[target]?.id === id) {
        const marker = store.read().pendingRegistrations[target]
        if (requiresRegistrationReview(marker) || !(error instanceof IntegrationError && error.kind === 'denied' && !attempt.controller.signal.aborted)) {
          try { if (marker.phase !== 'unknown') markRegistration(attempt, 'unknown') }
          catch { attempt.unpersistedUnknown = true }
          attempt.view = { ...attempt.view, status: 'unknown', url: null, detail: registrationUnknown }
          return
        }
        forgetRegistration(target, id)
      }
      const status = Date.now() >= attempt.until ? 'expired' : 'failed'
      const detail = error instanceof IntegrationError ? error.message : '飞书未确认授权或凭证保存失败，请核对应用后重试。'
      attempt.view = { ...attempt.view, status, url: null, detail: status === 'expired' ? '飞书授权已过期。' : detail.slice(0, 400) }
    })
    return attempt.view
  }

  const actions: FeishuActions = {
    async snapshot(input) {
      const grant = grantOf(input), state = store.read(), organization = org(state)
      return {
        organization: organization ? projection(organization) : null,
        runtimes: await options.runtimes?.() ?? [],
        account: state.account ? { state: 'linked', displayName: state.account.displayName } : null,
        accountAvailable: Boolean(organization?.view.enabled && vendor.authorizeAccount),
        connections: state.connections.filter(row => row.view.kind !== 'organization' && visible(row, grant, input.selectedScopeKey)).map(row => observed(row, state))
      }
    },
    async connectOrganization(input) {
      grantOf(input)
      assertOpen()
      if (savingOrg) throw new DaemonError('E_BUSY', '正在验证组织应用。')
      savingOrg = true
      try {
        const previous = org(), verified = await vendor.verify({ appId: input.appId, appSecret: input.appSecret })
        assertOpen()
        const view: FeishuConnection = {
          id: previous?.view.id ?? randomUUID(), revision: (previous?.view.revision ?? 0) + 1,
          kind: 'organization', name: verified.name, appId: input.appId, spaceId: null, agentId: null, scopeKey: null,
          allowedChatIds: [], enabled: true, state: 'verified', detail: '凭证已验证，等待连接。', providerId: null, modelId: null
        }
        store.update(state => {
          if (org(state)?.view.revision !== previous?.view.revision) throw new DaemonError('E_CONFLICT', '组织应用已变更。')
          if (state.connections.some(row => row.view.kind !== 'organization' && row.view.appId === view.appId)) throw new DaemonError('E_CONFLICT', '该应用已用于飞书助手。')
          state.connections = state.connections.filter(row => row.view.kind !== 'organization')
          state.connections.push({ view, secret: input.appSecret, botOpenId: verified.botOpenId, grant: null })
          if (previous?.view.appId !== view.appId || previous.secret !== input.appSecret) state.account = null
        })
        stopWorker(view.id)
        void poll().catch(() => undefined)
        return view
      } finally { savingOrg = false }
    },
    async beginRegistration(input) {
      const grant = grantOf(input)
      assertOpen()
      if (!grant && !input.scopeKey) throw new DaemonError('E_DENIED', '请选择任务助手对应的团队空间。')
      if ((input.kind === 'agent') !== Boolean(input.agentId)) throw new DaemonError('E_INVALID_ARG', '请选择适用的飞书助手目标。')
      const scopeKey = await options.validateTarget(input, grant)
      assertOpen()
      if (grant) options.assertGrant(grant)
      const sameTarget = (row: StoredFeishuConnection) =>
        row.view.kind === input.kind && row.view.scopeKey === scopeKey && row.view.spaceId === input.spaceId && row.view.agentId === input.agentId
      if (store.read().connections.some(sameTarget)) throw new DaemonError('E_CONFLICT', '该目标已有飞书连接。')
      const target = digest([input.kind, scopeKey, input.spaceId, input.agentId])
      return startAttempt(target, grant, scopeKey, input, async (attempt, onQr) => {
        const registered = await vendor.register({ name: input.name, kind: input.kind, signal: attempt.controller.signal, onQr })
        attempt.controller.signal.throwIfAborted()
        if (!isPending(attempt)) throw new DaemonError('E_CONFLICT', '原飞书注册已改变。')
        markRegistration(attempt, 'committing')
        attempt.view = { ...attempt.view, status: 'starting', url: null, detail: '正在核对飞书授权和原团队空间。' }
        if (await options.validateTarget(input, grant) !== scopeKey) throw new DaemonError('E_DENIED', '原团队空间授权已改变。')
        attempt.controller.signal.throwIfAborted()
        if (!isPending(attempt) || Date.now() >= attempt.until) throw new DaemonError('E_CONFLICT', '原飞书注册已改变。')
        assertOpen()
        if (grant) options.assertGrant(grant)
        if (store.read().connections.some(row => row.view.appId === registered.appId)) {
          forgetRegistration(target, attempt.view.id)
          attempt.view = { ...attempt.view, status: 'failed', url: null, detail: '该飞书应用已绑定其他 Crux 连接，请在飞书中选择其他应用。' }
          return
        }
        store.update(state => {
          if (state.pendingRegistrations[target]?.id !== attempt.view.id) throw new DaemonError('E_CONFLICT', '原飞书注册记录已改变。')
          if (state.connections.some(row => sameTarget(row) || row.view.appId === registered.appId)) throw new DaemonError('E_CONFLICT', '该目标或应用已绑定。')
          state.connections.push({
            view: { id: randomUUID(), revision: 1, kind: input.kind, name: input.name, appId: registered.appId,
              spaceId: input.spaceId, agentId: input.agentId, scopeKey, allowedChatIds: [], enabled: true, state: 'connecting',
              detail: '飞书已返回应用，正在核对机器人状态。',
              providerId: input.kind === 'assistant' ? input.providerId ?? null : null,
              modelId: input.kind === 'assistant' ? input.modelId ?? null : null,
              ...(input.kind === 'assistant' && input.runtimeId ? { runtimeId: input.runtimeId } : {}) },
            secret: registered.appSecret, botOpenId: null, grant
          })
          delete state.pendingRegistrations[target]
        })
        void poll().catch(() => undefined)
      })
    },
    async registrationStatus(input) { return publicAttempt(input, false).view },
    async cancelRegistration(input) {
      const attempt = publicAttempt(input, false)
      if (input.discardUnconfirmed && attempt.view.status === 'unknown') {
        assertOpen()
        const registrationInput = attempt.registrationInput
        const originalGrant = attempt.grant
        if (!registrationInput || !attempt.scopeKey) throw new DaemonError('E_CONFLICT', '原飞书授权目标不可用。')
        const scopeKey = await options.validateTarget(registrationInput, originalGrant)
        assertOpen()
        if (scopeKey !== attempt.scopeKey || publicAttempt(input, false) !== attempt ||
            !sameGrant(attempt.grant, originalGrant) || attempt.view.status !== 'unknown') {
          throw new DaemonError('E_CONFLICT', '原飞书授权目标已改变。')
        }
        attempt.controller.abort()
        forgetRegistration(attempt.target, input.attemptId)
        attempt.unpersistedUnknown = false
        attempt.view = { ...attempt.view, status: 'cancelled', detail: '已关闭原授权记录，可以重新授权。' }
      }
      return cancel(attempt)
    },
    async configure(input) {
      assertOpen()
      const row = selected(input)
      if (row.view.kind === 'organization') throw new DaemonError('E_INVALID_ARG', '组织应用不接受群助手配置。')
      const { providerId, modelId } = input
      const view = { ...row.view, revision: row.view.revision + 1, allowedChatIds: [...new Set(input.allowedChatIds)], enabled: input.enabled,
        providerId: row.view.kind === 'assistant' ? providerId ?? row.view.providerId : row.view.providerId,
        modelId: row.view.kind === 'assistant' ? modelId ?? row.view.modelId : row.view.modelId }
      const next = { ...row, view }
      store.update(state => { state.connections = state.connections.map(item => item.view.id === view.id ? next : item) })
      stopWorker(view.id)
      return projection(next)
    },
    async retry(input) {
      assertOpen()
      const row = selected(input)
      if (row.view.kind === 'organization') {
        if (savingOrg) throw new DaemonError('E_BUSY', '正在验证组织应用。')
        savingOrg = true
        try {
          const verified = await vendor.verify(credentials(row), AbortSignal.timeout(20_000))
          assertOpen()
          selected(input)
          const view = { ...row.view, revision: row.view.revision + 1, name: verified.name }
          const next = { ...row, view, botOpenId: verified.botOpenId }
          store.update(state => { state.connections = state.connections.map(item => item.view.id === view.id ? next : item) })
          stopWorker(view.id)
          void poll().catch(() => undefined)
          return projection(next)
        } finally { savingOrg = false }
      }
      stopWorker(row.view.id)
      void poll().catch(() => undefined)
      return projection(row)
    },
    async disconnect(input) {
      assertOpen()
      const row = selected(input)
      store.update(state => {
        state.connections = state.connections.filter(item => item.view.id !== row.view.id)
        if (state.account?.appId === row.view.appId) state.account = null
      })
      stopWorker(row.view.id)
      return null
    },
    async chats(input) {
      const row = selected(input)
      if (row.view.kind === 'organization' || !row.view.scopeKey) throw new DaemonError('E_DENIED', '所选连接没有群助手。')
      if (row.grant) options.assertGrant(row.grant)
      try {
        const chats = await vendor.listChats(credentials(row), AbortSignal.timeout(15000))
        selected(input)
        if (row.grant) options.assertGrant(row.grant)
        return chats.slice(0, 100).map(chat => ({ ...chat, name: chat.name.slice(0, 256) }))
      } catch (error) {
        if (error instanceof DaemonError) throw error
        throw new DaemonError('E_UNAVAILABLE', '无法读取机器人所在的群，请核对飞书应用权限，也可以手动填写群聊 ID。')
      }
    },
    async reconcile(input) {
      const row = selected(input)
      const match = Object.entries(store.read().receipts).find(([, receipt]) => receipt.connectionId === row.view.id && receipt.commandId === input.originalCommandId)
      if (!match || !row.view.scopeKey || !row.view.spaceId || row.view.kind !== 'assistant') throw new DaemonError('E_DENIED', '原任务回执不可用。')
      const [key, receipt] = match
      if (active.has(key)) throw new DaemonError('E_BUSY', '原飞书消息仍在处理。')
      if (!receipt.bindingId || !receipt.senderOpenId || !row.view.allowedChatIds.includes(receipt.chatId)) throw new DaemonError('E_DENIED', '原群或原身份已不在授权范围内。')
      const signal = AbortSignal.timeout(15000)
      const assertCurrent = () => { signal.throwIfAborted(); assertOriginal(row) }
      const result = await options.recover({
        workspace: assertOriginal(row), scopeKey: row.view.scopeKey, spaceId: row.view.spaceId, commandId: receipt.commandId,
        identity: { tenantKey: receipt.tenantKey, appId: row.view.appId, senderOpenId: receipt.senderOpenId, bindingId: receipt.bindingId },
        assertCurrent
      }, signal)
      assertCurrent()
      const confirmed = result.outcome === 'completed'
      if (confirmed) setReceipt(key, { phase: 'completed' })
      return { confirmed, detail: result.text.slice(0, 1000) }
    },
    async beginAccount(input) {
      const grant = grantOf(input), organization = org()
      assertOpen()
      const authorize = vendor.authorizeAccount
      if (!organization?.view.enabled || !authorize) throw new DaemonError('E_UNAVAILABLE', '个人飞书账号授权尚未配置。')
      return startAttempt('account', grant, undefined, undefined, async (attempt, onQr) => {
        const account = await authorize(credentials(organization), { signal: attempt.controller.signal, onQr })
        attempt.controller.signal.throwIfAborted()
        assertOpen()
        if (!isPending(attempt) || Date.now() >= attempt.until) throw new DaemonError('E_CONFLICT', '原授权已失效。')
        store.update(state => {
          if (org(state)?.view.revision !== organization.view.revision || org(state)?.view.id !== organization.view.id) throw new DaemonError('E_CONFLICT', '组织应用已改变。')
          state.account = { appId: organization.view.appId, ...account }
        })
      })
    },
    async accountStatus(input) { return publicAttempt(input, true).view },
    async cancelAccount(input) { return cancel(publicAttempt(input, true)) },
    async unlinkAccount(input) {
      grantOf(input)
      assertOpen()
      for (const attempt of attempts.values()) if (attempt.target === 'account') cancel(attempt)
      store.update(state => { state.account = null })
      return null
    }
  }

  return {
    actions, poll,
    hasActiveWork: (root?: string) => Boolean(
      (!root && savingOrg) ||
      [...active.values()].some(work => !root || root === work.root) ||
      [...attempts.values()].some(attempt => (!root || root === attempt.root) && isPending(attempt))
    ),
    probeIdle() {
      probing = true
      return { release() { probing = false } }
    },
    async shutdown() {
      closed = true
      for (const attempt of attempts.values()) cancel(attempt)
      for (const id of workers.keys()) stopWorker(id)
      for (const item of active.values()) item.controller.abort()
      await Promise.allSettled([...active.values()].map(item => item.promise))
    }
  }
}
