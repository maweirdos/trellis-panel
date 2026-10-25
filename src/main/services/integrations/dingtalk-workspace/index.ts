import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { dingAppSchema, dingInboxSchema, dingDeliverySchema, dingPreviewSchema, type DingAssistant } from '../../../../shared/dingtalk-integration'
import { IntegrationError } from '../types'
import type { DingTalkActions, DingTalkPorts } from './ports'
import { DingTalkRest, DingTalkRemoteError } from './rest'
import { createDingTalkInbox } from './inbox'
import { digest, type DingState } from './repository'
export { DingTalkRepository } from './repository'
export { createStableDingTalkStreamFactory } from './stream'
export type { DingTalkActions, DingTalkPorts, DingTalkExecutionPort, DingTalkPersonalPort, DingTalkWorkspacePort, DingTalkProtectionPort } from './ports'
export type { DingTalkStreamFactory, DingTalkStreamNetwork, StableDingTalkClient } from './stream'

/** Native composition: construct once inside the leased daemon, then start its
 * worker there. IPC receives actions forwarded to that owner, never this store. */
export function createDingTalkWorkspace(ports: DingTalkPorts) {
  const repository = ports.repository
  const remote = new DingTalkRest(ports.fetch, captured => { const current = repository.read().apps.find(app => app.id === captured.id && app.revision === captured.revision); if (!current?.secret || current.state === 'revoked') throw new IntegrationError('原应用凭据已变更或撤销', 'denied') })
  const inbox = createDingTalkInbox(ports, remote)
  const streams = new Map<string, { key: string; close(): Promise<void> }>()
  let closed = false, started = false, recovered = false, timer: ReturnType<typeof setInterval> | undefined, synchronizing: Promise<void> | undefined
  const idleProbes = new Set<symbol>()
  const notify = (): void => ports.changed?.()
  function appBy(state: DingState, id: string, revision?: number) {
    const app = state.apps.find(item => item.id === id)
    if (!app || revision !== undefined && app.revision !== revision) throw new IntegrationError('钉钉应用已变更，请刷新后重试', 'conflict')
    return app
  }
  function activeApp(state: DingState, id: string, revision: number) {
    const app = appBy(state, id, revision)
    if (app.state !== 'credentials-verified' || !app.secret) throw new IntegrationError('钉钉应用尚未验证或已撤销', 'denied')
    return app
  }
  function recoverOriginal(): void {
    if (recovered) return
    const state = repository.read()
    if (state.inbox.some(item => item.state === 'processing' || item.reply === 'dispatching')
      || state.deliveries.some(item => item.state === 'prepared' || item.state === 'dispatching')) inbox.recover()
    recovered = true
  }
  function owner(input: { expectedRoot: string | null }) {
    const context = ports.workspace.current(input.expectedRoot)
    // Reconcile prior-process evidence before ANY new effect can be admitted,
    // independently of whether the lazy timer/SDK has ever been activated.
    recoverOriginal()
    return context
  }
  function assistantBy(input: { expectedRoot: string | null; assistantId: string; revision?: number }) {
    const context = owner(input), assistant = repository.read().assistants.find(item => item.id === input.assistantId)
    if (!context.workspace || !assistant || assistant.workspace.workspaceId !== context.workspace.workspaceId || assistant.workspace.root !== context.workspace.root || input.revision !== undefined && assistant.revision !== input.revision) throw new IntegrationError('钉钉助手不属于当前已授权工作区或版本已变更', 'conflict')
    return assistant
  }
  function ownedReceipt(input: { expectedRoot: string | null; receiptId: string }) {
    const context = owner(input), item = inbox.row(input.receiptId)
    if (!context.workspace || context.workspace.workspaceId !== item.workspace.workspaceId || context.workspace.root !== item.workspace.root) throw new IntegrationError('消息不属于当前工作区', 'denied')
    return item
  }
  async function syncStreams(): Promise<void> {
    if (idleProbes.size) return
    if (synchronizing) return synchronizing
    synchronizing = (async () => {
      const state = repository.read()
      const desired = new Map<string, { app: DingState['apps'][number]; assistants: DingAssistant[]; key: string }>()
      if (!closed && started && ports.stream) for (const app of state.apps) {
        const assistants = state.assistants.filter(item => item.appId === app.id && item.enabled && item.appRevision === app.revision)
        if (!assistants.length || app.state !== 'credentials-verified') continue
        const key = digest([app.id, app.revision, assistants.map(item => [item.id, item.revision]), ports.networkKey?.() ?? 'native-network'])
        desired.set(app.id, { app, assistants, key })
      }
      for (const [id, stream] of streams) if (desired.get(id)?.key !== stream.key) { streams.delete(id); await stream.close() }
      for (const [id, entry] of desired) {
        if (streams.has(id) || closed || !ports.stream) continue
        for (const assistant of entry.assistants) ports.workspace.assertWorkspace(assistant.workspace)
        const sentinel = { key: entry.key, close: async () => {} }
        streams.set(id, sentinel)
        const health = (state: DingAssistant['state'], detail: string): void => {
          if (closed || streams.get(id)?.key !== entry.key) return
          repository.change(next => { for (const assistant of next.assistants) if (entry.assistants.some(original => original.id === assistant.id && original.revision === assistant.revision)) { assistant.state = state; assistant.detail = detail; if (state === 'registered') assistant.lastConnectedAt = Date.now() } }); notify()
        }
        try {
          const stream = await ports.stream.create({ app: entry.app, onMessage: frame => streams.get(id)?.key === entry.key && !closed && !idleProbes.size && inbox.receive(id, entry.app.revision, frame), health })
          if (closed || streams.get(id) !== sentinel) await stream.close()
          else streams.set(id, { key: entry.key, close: stream.close })
        } catch { streams.delete(id); repository.change(next => { for (const assistant of next.assistants) if (assistant.appId === id && assistant.appRevision === entry.app.revision) { assistant.state = 'blocked'; assistant.detail = 'Stream SDK 或代理适配不可用，请检查依赖与网络设置' } }); notify() }
      }
    })().finally(() => { synchronizing = undefined })
    return synchronizing
  }
  function invalidateDependents(state: DingState, appId: string, detail: string): void {
    for (const assistant of state.assistants) if (assistant.appId === appId) { assistant.enabled = false; assistant.revision++; assistant.state = 'blocked'; assistant.detail = detail }
    for (const account of state.accounts) if (account.appId === appId) { account.state = 'revoked'; account.revision++ }
    for (const notification of state.notifications) if (notification.appId === appId) { notification.enabled = false; notification.revision++; notification.state = 'disabled'; notification.detail = detail }
  }
  function page<T extends { id: string }>(items: T[], after: string | null, limit: number) {
    const index = after === null ? 0 : items.findIndex(item => item.id === after) + 1
    if (after && index === 0) throw new IntegrationError('历史游标已失效，请从第一页重新读取', 'conflict')
    const rows = items.slice(index, index + limit)
    return { items: rows, next: index + limit < items.length ? rows.at(-1)?.id ?? null : null }
  }
  const actions: DingTalkActions = {
    async snapshot(input) {
      const context = owner(input), state = repository.read()
      return { version: 1, nativeSubject: context.nativeSubject, workspace: context.workspace,
        apps: state.apps.map(app => dingAppSchema.strip().parse(app)), accounts: state.accounts.filter(account => account.nativeSubject === context.nativeSubject),
        assistants: state.assistants.filter(item => context.workspace && item.workspace.workspaceId === context.workspace.workspaceId && item.workspace.root === context.workspace.root), notifications: state.notifications,
        personal: ports.personal?.setup() ?? { available: false, serviceBinding: null, linkPreview: 'unavailable', detail: '个人 OAuth 与链接预览需要单独配置可信回调服务；本机 Stream 和 Agent 不需要团队账号' },
        executionAvailable: Boolean(ports.execution), streamAvailable: Boolean(ports.stream && ports.stream.version === '2.1.5') }
    },
    async saveApp(input) {
      owner(input)
      const app = repository.change(state => {
        const original = input.id ? appBy(state, input.id, input.revision) : null
        if (!original && input.revision !== 0) throw new IntegrationError('新应用版本必须为 0', 'conflict')
        if (!original && state.apps.length >= 50) throw new IntegrationError('应用数量已达上限', 'invalid')
        if (state.apps.some(app => app.id !== original?.id && app.appKey === input.appKey)) throw new IntegrationError('此 AppKey 已有独立应用记录，请编辑原记录以保留消息身份', 'conflict')
        const secret = input.secret.op === 'replace' ? input.secret.value : input.secret.op === 'clear' ? '' : original?.secret ?? ''
        if (input.secret.op === 'keep' && original && original.appKey !== input.appKey) throw new IntegrationError('更换 AppKey 时必须同时替换 AppSecret', 'invalid')
        const app = { id: original?.id ?? randomUUID(), revision: (original?.revision ?? 0) + 1, name: input.name, appKey: input.appKey, corpId: input.corpId, robotCode: input.robotCode, hasSecret: Boolean(secret), secret, state: 'unverified' as const, observedCorpId: null, checkedAt: null, detail: '已保存受保护凭据；尚未验证。机器人发布与权限需在钉钉开发平台配置' }
        if (original) { invalidateDependents(state, original.id, '应用配置已变更，需要重新验证和启用助手'); Object.assign(original, app) } else state.apps.push(app)
        return dingAppSchema.strip().parse(app)
      })
      remote.invalidate(app.id); await syncStreams(); notify(); return app
    },
    async verifyApp(input, signal) {
      owner(input); const app = appBy(repository.read(), input.appId, input.revision)
      if (!app.secret || app.state === 'revoked') throw new IntegrationError('应用凭据已清除，请先替换 AppSecret', 'denied')
      try {
        await remote.token(app, signal); owner(input)
        const updated = repository.change(state => { const current = appBy(state, app.id, app.revision); current.state = 'credentials-verified'; current.checkedAt = Date.now(); current.detail = '钉钉已接受此应用凭据；组织身份、机器人安装和发送权限分别验证'; return dingAppSchema.strip().parse(current) })
        await syncStreams(); notify(); return updated
      } catch (error) {
        repository.change(state => { const current = appBy(state, app.id, app.revision); current.state = 'degraded'; current.detail = error instanceof DingTalkRemoteError ? error.message : '凭据验证未完成，请检查网络、代理和应用权限'; current.checkedAt = Date.now() }); notify(); throw error
      }
    },
    async revokeApp(input) {
      owner(input)
      const result = repository.change(state => { const app = appBy(state, input.appId, input.revision); app.secret = ''; app.hasSecret = false; app.revision++; app.state = 'revoked'; app.checkedAt = null; app.detail = '本机凭据和接入已撤销。钉钉平台的 AppSecret 必须由管理员另行重置或停用'; invalidateDependents(state, app.id, '应用已撤销，停止新消息接入'); return dingAppSchema.strip().parse(app) })
      remote.invalidate(result.id); await syncStreams(); notify(); return result
    },
    async authorizeAccount(input, signal = AbortSignal.timeout(300000)) {
      const context = owner(input), app = activeApp(repository.read(), input.appId, input.revision)
      if (!ports.personal?.setup().available || !ports.openBrowser) throw new IntegrationError('个人 OAuth 回调服务尚未配置', 'denied')
      const prior = repository.read().authorizations.find(item => item.requestId === input.requestId && item.nativeSubject === context.nativeSubject)
      if (prior) throw new IntegrationError('此授权请求已有记录，请核实原请求或完成后重新开始', 'conflict')
      // Record browser-login intent before asking the optional server. A dropped
      // begin reply is not silently recreated under a different authorization.
      const intentId = randomUUID()
      repository.change(state => { state.authorizations = state.authorizations.filter(item => item.expiresAt > Date.now() || item.state === 'unknown'); if (state.authorizations.length >= 100) throw new IntegrationError('授权请求记录已满', 'io'); state.authorizations.push({ id: intentId, appId: app.id, appRevision: app.revision, nativeSubject: context.nativeSubject, expiresAt: Date.now() + 300000, state: 'unknown', requestId: input.requestId }) })
      const begin = await ports.personal.begin({ nativeSubject: context.nativeSubject, appId: app.id, appRevision: app.revision, appKey: app.appKey, corpId: app.corpId, requestId: input.requestId }, signal)
      const url = new URL(begin.browserUrl)
      if (url.origin !== 'https://login.dingtalk.com' || url.pathname !== '/oauth2/auth' || url.username || url.password || url.searchParams.get('client_id') !== app.appKey || begin.expiresAt > Date.now() + 300000 || begin.expiresAt <= Date.now()) throw new IntegrationError('个人授权服务返回了无效的钉钉授权地址', 'denied')
      owner(input); activeApp(repository.read(), app.id, app.revision)
      repository.change(state => { const intent = state.authorizations.find(item => item.id === intentId)!; intent.id = z.string().uuid().parse(begin.authorizationId); intent.expiresAt = begin.expiresAt; intent.state = 'pending' })
      await ports.openBrowser(url.href); notify(); return { authorizationId: begin.authorizationId, expiresAt: begin.expiresAt }
    },
    async claimAccount(input, signal = AbortSignal.timeout(15000)) {
      const context = owner(input), state = repository.read(), app = activeApp(state, input.appId, input.revision)
      const intent = state.authorizations.find(item => item.id === input.authorizationId && item.appId === app.id && item.appRevision === app.revision && item.nativeSubject === context.nativeSubject && item.expiresAt > Date.now() && item.state === 'pending')
      if (!intent || !ports.personal) throw new IntegrationError('授权请求已过期或不属于当前身份', 'denied')
      const identity = await ports.personal.claim({ nativeSubject: context.nativeSubject, appId: app.id, appRevision: app.revision, authorizationId: intent.id }, signal)
      owner(input)
      if (identity.corpId !== app.corpId || identity.serviceBinding !== ports.personal.setup().serviceBinding) throw new IntegrationError('授权身份的组织或可信服务不匹配', 'denied')
      const account = repository.change(next => {
        activeApp(next, app.id, app.revision)
        const original = next.accounts.find(item => item.appId === app.id && item.nativeSubject === context.nativeSubject)
        const account = { id: original?.id ?? randomUUID(), revision: (original?.revision ?? 0) + 1, appId: app.id, appRevision: app.revision, nativeSubject: context.nativeSubject, unionId: identity.unionId, staffId: identity.staffId, corpId: identity.corpId, displayName: identity.displayName, state: 'linked' as const, linkedAt: Date.now(), serviceBinding: identity.serviceBinding }
        if (original) Object.assign(original, account); else next.accounts.push(account)
        const authorization = next.authorizations.find(item => item.id === intent.id && item.state === 'pending'); if (!authorization) throw new IntegrationError('授权已消费', 'conflict'); authorization.state = 'claimed'
        return account
      }); notify(); return account
    },
    async unlinkAccount(input, signal = AbortSignal.timeout(15000)) {
      const context = owner(input), account = repository.read().accounts.find(item => item.id === input.accountId && item.revision === input.revision && item.nativeSubject === context.nativeSubject)
      if (!account) throw new IntegrationError('个人账号已变更', 'conflict')
      // Local revocation is effective before remote cleanup. A failed cleanup
      // cannot restore notification access or a prior personal identity.
      repository.change(state => { const current = state.accounts.find(item => item.id === account.id)!; current.state = 'revoked'; current.revision++ }); notify()
      if (ports.personal) await ports.personal.unlink(account, signal)
      return null
    },
    async saveAssistant(input) {
      const context = owner(input)
      if (!context.workspace) throw new IntegrationError('请先授权当前本机工作区', 'denied')
      const workspace = context.workspace
      ports.workspace.assertWorkspace(workspace)
      if (input.policy.execution !== 'tasks-only') {
        if (!ports.execution) throw new IntegrationError('原生执行端口尚未就绪，请先使用仅任务模式', 'denied')
        await ports.execution.validate(workspace, input.policy.runtimeId, input.policy.profileId)
      }
      ports.workspace.assertWorkspace(workspace); owner(input)
      const result = repository.change(state => {
        const app = activeApp(state, input.appId, input.appRevision)
        const original = input.id ? state.assistants.find(item => item.id === input.id && item.revision === input.revision && item.workspace.workspaceId === workspace.workspaceId && item.workspace.root === workspace.root) : null
        if (input.id && !original || !input.id && input.revision !== 0) throw new IntegrationError('助手版本或工作区已变更', 'conflict')
        const assistant: DingAssistant = { id: original?.id ?? randomUUID(), revision: (original?.revision ?? 0) + 1, name: input.name, appId: app.id, appRevision: app.revision, workspace, policy: input.policy, enabled: false, state: 'stopped', detail: '配置已保存，等待明确启用。请在钉钉开发平台发布 Stream 机器人并添加到允许的会话', lastConnectedAt: null, lastMessageAt: null }
        if (original) Object.assign(original, assistant); else state.assistants.push(assistant)
        return assistant
      }); await syncStreams(); notify(); return result
    },
    async setAssistant(input) {
      const original = assistantBy(input)
      if (input.enabled) {
        if (!ports.stream) throw new IntegrationError('钉钉 Stream SDK 未就绪', 'denied')
        ports.workspace.assertWorkspace(original.workspace)
        activeApp(repository.read(), original.appId, original.appRevision)
      }
      const result = repository.change(state => { const assistant = state.assistants.find(item => item.id === original.id && item.revision === original.revision); if (!assistant) throw new IntegrationError('助手已变更', 'conflict'); assistant.enabled = input.enabled; assistant.revision++; assistant.state = input.enabled ? 'connecting' : 'stopped'; assistant.detail = input.enabled ? '等待后台建立 Stream 连接' : '已停止新消息接入，既有任务和执行回执保留'; return assistant })
      await syncStreams(); notify(); return result
    },
    async retryAssistant(input) {
      const original = assistantBy(input)
      if (!original.enabled) throw new IntegrationError('请先启用此助手', 'denied')
      const stream = streams.get(original.appId); streams.delete(original.appId); await stream?.close()
      await syncStreams(); notify(); return repository.read().assistants.find(item => item.id === original.id)!
    },
    async setNotifications(input) {
      const context = owner(input), state = repository.read(), app = activeApp(state, input.appId, input.revision)
      if (input.enabled && !state.accounts.some(item => item.appId === app.id && item.appRevision === app.revision && item.nativeSubject === context.nativeSubject && item.state === 'linked')) throw new IntegrationError('请先通过钉钉 OAuth 绑定个人身份', 'denied')
      const result = repository.change(next => { activeApp(next, app.id, app.revision); const original = next.notifications.find(item => item.appId === app.id); if ((original?.revision ?? 0) !== input.expectedRevision) throw new IntegrationError('通知配置已变更', 'conflict'); const notification = { appId: app.id, revision: (original?.revision ?? 0) + 1, enabled: input.enabled, state: input.enabled ? 'configured' as const : 'disabled' as const, detail: input.enabled ? '已配置；只有实际发送回执能证明机器人发送权限与结果' : '个人通知已停用' }; if (original) Object.assign(original, notification); else next.notifications.push(notification); return notification }); notify(); return result
    },
    async previewNotification(input) {
      const context = owner(input), state = repository.read(), app = activeApp(state, input.appId, input.revision)
      const account = state.accounts.find(item => item.id === input.accountId && item.appId === app.id && item.appRevision === app.revision && item.nativeSubject === context.nativeSubject && item.state === 'linked')
      if (!account || !state.notifications.some(item => item.appId === app.id && item.enabled)) throw new IntegrationError('个人身份或通知尚未启用', 'denied')
      const preview = { id: randomUUID(), appId: app.id, appRevision: app.revision, accountId: account.id, accountRevision: account.revision, title: input.title, body: input.body, digest: digest([app.id, app.revision, account.id, account.revision, input.title, input.body, account.staffId]), expiresAt: Date.now() + 300000 }
      repository.change(next => { next.previews = next.previews.filter(item => item.expiresAt > Date.now()); if (next.previews.length >= 100) throw new IntegrationError('通知预览数量已达上限', 'io'); next.previews.push({ ...preview, nativeSubject: context.nativeSubject }) }); return preview
    },
    async sendNotification(input, signal) {
      const context = owner(input), state = repository.read()
      const previous = state.deliveries.find(item => item.commandId === input.commandId)
      if (previous) { if (previous.nativeSubject !== context.nativeSubject || previous.previewId !== input.preview.id || previous.digest !== input.preview.digest) throw new IntegrationError('原发送命令的身份或内容不匹配', 'conflict'); return dingDeliverySchema.strip().parse(previous) }
      if (state.deliveries.some(item => item.previewId === input.preview.id)) throw new IntegrationError('此预览已有发送意图，请读取原回执；不能换一个命令重复发送', 'conflict')
      const preview = state.previews.find(item => item.id === input.preview.id && item.nativeSubject === context.nativeSubject)
      if (!preview || preview.expiresAt <= Date.now() || JSON.stringify(dingPreviewSchema.strip().parse(preview)) !== JSON.stringify(input.preview)) throw new IntegrationError('通知预览已失效或内容变更，请重新审阅', 'conflict')
      const app = activeApp(state, preview.appId, preview.appRevision)
      const account = state.accounts.find(item => item.id === preview.accountId && item.revision === preview.accountRevision && item.appRevision === app.revision && item.nativeSubject === context.nativeSubject && item.state === 'linked')
      if (!account || !state.notifications.some(item => item.appId === app.id && item.enabled)) throw new IntegrationError('原收件身份或通知权限已变更', 'denied')
      const id = randomUUID()
      repository.change(next => { if (next.deliveries.length >= 10000) throw new IntegrationError('发送回执已满，不能遗忘未知结果后重发', 'io'); next.deliveries.push({ id, appId: app.id, accountId: account.id, commandId: input.commandId, digest: preview.digest, state: 'prepared', processQueryKey: null, createdAt: Date.now(), detail: '发送意图已持久化', previewId: preview.id, nativeSubject: context.nativeSubject }) })
      const settle = (state: 'dispatching' | 'accepted' | 'failed' | 'unknown', detail: string, processQueryKey: string | null = null) => repository.change(next => { const item = next.deliveries.find(item => item.id === id)!; item.state = state; item.detail = detail; item.processQueryKey = processQueryKey; return dingDeliverySchema.strip().parse(item) })
      settle('dispatching', '已开始提交原通知，等待钉钉回执')
      try { activeApp(repository.read(), app.id, app.revision); const result = await remote.sendPrivate(app, account.staffId, preview.title, preview.body, signal); const receipt = settle('accepted', '钉钉已接受发送请求；尚无终端送达证据', result.processQueryKey); notify(); return receipt }
      catch (error) { const receipt = settle(error instanceof DingTalkRemoteError && error.definite ? 'failed' : 'unknown', error instanceof DingTalkRemoteError ? error.message : '通知结果未确认；不会自动重发'); notify(); return receipt }
    },
    async deliveries(input) { const context = owner(input); return page(repository.read().deliveries.filter(item => item.appId === input.appId && item.nativeSubject === context.nativeSubject).reverse().map(item => dingDeliverySchema.strip().parse(item)), input.after, input.limit) },
    async reconcileDelivery(input) {
      const context = owner(input), receipt = repository.read().deliveries.find(item => item.id === input.deliveryId && item.nativeSubject === context.nativeSubject)
      if (!receipt) throw new IntegrationError('发送回执不存在', 'conflict')
      // No undocumented vendor query or optimistic resend. processQueryKey is
      // retained for a separately verified delivery callback/query adapter.
      return dingDeliverySchema.strip().parse(receipt)
    },
    async inbox(input) { const assistant = assistantBy(input); return page(repository.read().inbox.filter(item => item.assistantId === assistant.id).reverse().map(item => dingInboxSchema.strip().parse(item)), input.after, input.limit) },
    async execute(input) { const item = ownedReceipt(input); if (item.assistantRevision !== input.assistantRevision) throw new IntegrationError('原消息助手版本不匹配', 'conflict'); return inbox.execute(item.id) },
    async queryExecution(input) { return inbox.observeExecution(ownedReceipt(input).id, false) },
    async cancelExecution(input) { return inbox.observeExecution(ownedReceipt(input).id, true) }
  }
  return { actions, work: inbox.work, remote, hasActiveWork: () => inbox.hasActiveWork() || Boolean(synchronizing),
    probeIdle() {
      const probe = Symbol('idle-shutdown'); idleProbes.add(probe)
      return { busy: () => !idleProbes.has(probe) || inbox.hasActiveWork() || Boolean(synchronizing), release: () => { idleProbes.delete(probe) } }
    },
    /** This worker belongs to the daemon, never to page subscriptions. */
    async start() {
      if (started || closed) return
      // Failed recovery cannot mark an idle worker as started forever.
      recoverOriginal(); started = true
      try { await syncStreams() } catch (error) { started = false; throw error }
      if (!closed) timer = setInterval(() => { if (idleProbes.size) return; try { inbox.tick(); void syncStreams().catch(() => {}) } catch { /* State corruption/owner loss closes admission on the next explicit operation. */ } }, 1500)
    },
    async closeAdmission() { closed = true; inbox.closeAdmission(); if (timer) clearInterval(timer); await synchronizing; for (const stream of streams.values()) await stream.close(); streams.clear() },
    async shutdown() { closed = true; if (timer) clearInterval(timer); await synchronizing; for (const stream of streams.values()) await stream.close(); streams.clear(); await inbox.close() },
    /** Native-only delivery evidence hook. Call only after a verified vendor
     * callback or actual documented query; an IPC caller cannot invoke it. */
    recordDeliveryEvidence(input: { appId: string; processQueryKey: string; outcome: 'delivered' | 'failed'; evidence: string }) {
      if (!input.evidence || input.evidence.length > 256) throw new IntegrationError('缺少已验证的送达证据', 'invalid')
      repository.change(state => { const item = state.deliveries.find(item => item.appId === input.appId && item.processQueryKey === input.processQueryKey); if (!item) throw new IntegrationError('原发送身份不存在', 'conflict'); if (item.state === 'delivered' && input.outcome !== 'delivered') throw new IntegrationError('送达证据冲突', 'conflict'); item.state = input.outcome; item.detail = `已验证的钉钉结果：${input.evidence}` }); notify()
    }
  }
}
