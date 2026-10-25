#!/usr/bin/env node
/**
 * ZCode ACP 桥接适配器入口：对 acpx 呈现为标准 ACP v1 agent（stdio/NDJSON，jsonrpc:"2.0"），
 * 对内 spawn `node <zcode.cjs> app-server --stdio --cwd <workspace>` 并翻译协议。
 *
 * 状态机：initialized → sessionActive(idle|prompting) → closed；单进程单 app-server，
 * 多会话由 acpx 起多个适配器进程（与 managed 适配器语义一致）。
 *
 * 启动参数（由宿主 setup.ts launchArgv 提供；缺省走本机检测）：
 *   --zcode-bin <path>            ZCode CLI（zcode.cjs）路径
 *   --isolated <dir>              显式隔离模式（测试/诊断用）：ZCODE_DATA_BASE_DIR=dir 并重定向
 *                                 HOME 系变量，不写用户 ~/.zcode。缺省真实用户态：模型目录与
 *                                 登录态复用本机 ~/.zcode（2026-10-22 用户决策，覆盖原隔离默认）
 *   --enable-automation-tools     放行自动化计划工具（缺省禁用 Cron*）
 *
 * 取证硬化：app-server 意外退出 / spawn 失败 / 适配器未捕获异常 / shutdown(reason) 时，
 * 把现场覆盖写入 zcode-adapter-last-error.log（退出码/信号、stderr 环形缓冲、最近收发帧）；
 * 隔离模式落在 <隔离目录>，默认模式落在系统临时目录。适配器成功启动后清除旧尸检。
 * 宿主（src/main/services/acp.ts）在会话启动失败且该日志存在时读取尾部附加给用户。
 *
 * 协议方法与事件映射以 research/protocol-mapping.md（Phase 0 实测定稿）为准。
 * 语法说明：translate.ts 依赖 Node 内置类型剥离（>=22.18 默认开启），低版本给可读错误。
 */
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ZcodeBackend, clearLastErrorLog, writeLastErrorLog } from './zcode-backend.mjs'
import { createAccountContext } from './account-context.mjs'
import { createConnectionTimings } from './connection-timings.mjs'

const ADAPTER_VERSION = '0.1.0'
const AGENT_INFO = { name: 'zcode-acp', version: ADAPTER_VERSION }

/** session/prompt 的应答由 turn 事件异步写回；handler 以此标记告知 dispatch 不立即回包。 */
const ASYNC_REPLY = Symbol('async-reply')

class AcpFault extends Error {
  constructor(code, message, connectionTimingReason) {
    super(message)
    this.code = code
    this.connectionTimingReason = connectionTimingReason
  }
}

/* ---------- 启动参数与 zcode CLI 检测 ---------- */

function parseArgs(argv) {
  const options = { zcodeBin: undefined, isolatedDir: undefined, enableAutomationTools: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--zcode-bin') options.zcodeBin = argv[index + 1]
    else if (arg === '--isolated') options.isolatedDir = argv[index + 1]
    else if (arg === '--enable-automation-tools') options.enableAutomationTools = true
    else if (arg === '--serve') { /* 兼容诊断习惯旗标；适配器默认即 serve */ }
  }
  return options
}

function regularFile(path) {
  try { return typeof path === 'string' && statSync(path).isFile() } catch { return false }
}

function findOnPath(command) {
  if (isAbsolute(command)) return regularFile(command) ? command : undefined
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory.replace(/^"|"$/g, ''), `${command}${suffix}`)
      if (regularFile(candidate)) return candidate
    }
  }
  return undefined
}

/** 标准安装位置表（复刻 HiFox 发现顺序）；显式 env（TRELLIS_ZCODE_BIN / ZCODE_BIN）优先。 */
export function resolveZcodeBin() {
  const explicit = process.env.TRELLIS_ZCODE_BIN ?? process.env.ZCODE_BIN
  if (regularFile(explicit)) return explicit
  const onPath = findOnPath('zcode')
  if (onPath) return onPath
  const candidates = []
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'))
  if (process.platform === 'darwin') candidates.push('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs')
  return candidates.find((candidate) => regularFile(candidate))
}

/* ---------- ACP 帧写出 ---------- */

function writeAcp(frame) {
  try {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
    return true
  } catch {
    return false
  }
}

function acpError(id, code, message, data) {
  writeAcp({ id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

function acpResult(id, result) {
  writeAcp({ id, result: result ?? {} })
}

async function loadTranslate() {
  try {
    return await import('./translate.ts')
  } catch (error) {
    console.error(`[zcode-acp] 翻译层加载失败（需要 Node >= 22.18 内置类型剥离）：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

async function serve(options) {
  const translate = await loadTranslate()
  options.zcodeBin ??= resolveZcodeBin()
  if (!regularFile(options.zcodeBin)) {
    console.error('[zcode-acp] 未找到 ZCode CLI（--zcode-bin / TRELLIS_ZCODE_BIN / ZCODE_BIN / PATH / 标准安装位置均未命中）')
    process.exit(1)
  }
  const debug = (text) => { if (process.env.TRELLIS_ZCODE_ACP_DEBUG) console.error(`[zcode-acp] ${text}`) }

  let initialized = false
  let backend = undefined
  let backendStarting = undefined
  let accountContext = undefined
  let accountStatus = undefined
  let session = undefined // { acpSessionId, modes, modelOption, modelDefaults, baseSeq }
  let pendingPrompt = undefined // { id, settled }
  let permissionSeq = 0
  let shuttingDown = false
  let activeConnection
  /** ZCode requestId → { acpId?, rpcReply?, settled }；permission.requested 事件与
   *  interaction/requestPermission 双向请求按 requestId 去重合并（deny 默认）。 */
  const pendingPermissions = new Map()

  /* ----- 生命周期 ----- */

  // 取证落盘：app-server 意外死亡 / 未捕获异常 / shutdown(reason) 写入 zcode-adapter-last-error.log
  // （覆盖写）：隔离模式=隔离目录，默认模式=系统临时目录（原 dataDir 随默认隔离取消而不存在）。
  // 同一事故只写一次：崩溃现场先落盘后，shutdown 不再覆盖，避免丢帧信息。
  let forensicsLogged = false
  const forensicsDir = options.isolatedDir ?? (isAbsolute(process.env.TRELLIS_ZCODE_DIAGNOSTICS_DIR ?? '') ? process.env.TRELLIS_ZCODE_DIAGNOSTICS_DIR : tmpdir())
  const timingsDir = options.isolatedDir ?? (isAbsolute(process.env.TRELLIS_ZCODE_DIAGNOSTICS_DIR ?? '') ? process.env.TRELLIS_ZCODE_DIAGNOSTICS_DIR : undefined)
  const lastErrorPathHint = () => join(forensicsDir, 'zcode-adapter-last-error.log')
  const logForensics = (reason, extraLines = []) => {
    forensicsLogged = true
    if (!writeLastErrorLog(forensicsDir, [
      `时间: ${new Date().toISOString()}`,
      `原因: ${reason}`,
      ...extraLines
    ])) console.error(`[zcode-acp] 取证日志写入失败：${lastErrorPathHint()}`)
  }

  const shutdown = (exitCode, reason, timingReason = 'request_failed') => {
    if (shuttingDown) return
    shuttingDown = true
    activeConnection?.finish(exitCode === 0 ? 'cancelled' : 'failed', exitCode === 0 ? 'cancelled' : timingReason)
    accountContext?.dispose()
    if (exitCode !== 0 && reason && !forensicsLogged) logForensics(reason)
    const kill = backend ? backend.killTree() : Promise.resolve()
    kill.then(() => process.exit(exitCode), error => {
      console.error(`[zcode-acp] ${error.message}`)
      process.exit(1)
    })
  }
  process.stdin.on('close', () => shutdown(0, 'stdin 关闭（宿主正常关闭）'))
  process.on('SIGINT', () => shutdown(0, '收到 SIGINT'))
  process.on('SIGTERM', () => shutdown(0, '收到 SIGTERM'))

  const handleFatal = (label) => (error) => {
    console.error(`[zcode-acp] 适配器${label}：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    if (!forensicsLogged) {
      logForensics(`适配器${label}`, [
        `堆栈: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        ...(backend?.forensicSections() ?? [])
      ])
    }
    shutdown(1)
  }
  process.on('uncaughtException', handleFatal('未捕获异常'))
  process.on('unhandledRejection', handleFatal('未处理的 Promise 拒绝'))

  const handleBackendExit = (info) => {
    const tail = backend ? backend.stderrTail() : ''
    console.error(`[zcode-acp] ZCode app-server 退出（code=${info.code ?? 'unknown'}${info.unexpected ? '，非预期' : ''}）：${tail}`)
    if (info.unexpected) {
      // 崩溃现场已由 onForensics 落盘；向上抛可读错误，不静默重试（design R5）。
      settlePrompt({ error: true, code: -32000, message: 'ZCode app-server 意外退出，请重建会话' })
      shutdown(1, undefined, 'backend_exited')
    }
  }

  const ensureBackend = (workspacePath, timings) => {
    if (backend?.child && backend.startupState.ready) {
      for (const stage of ['backend-process', 'storage-ready', 'account-sync']) timings.skip(stage, 'backend_reused')
    }
    if (backendStarting) return backendStarting
    if (backend && backend.child) return Promise.resolve(backend)
    if (backend && !backend.child) {
      backend = undefined
      backendStarting = undefined
    }
    if (!backendStarting) {
      const created = new ZcodeBackend({
        nodePath: process.execPath,
        zcodeBin: options.zcodeBin,
        workspacePath,
        isolatedDir: options.isolatedDir,
        enableAutomationTools: options.enableAutomationTools,
        connectionTimings: timings,
        onEvent: (event) => handleZcodeEvent(event),
        onNotice: (method, params) => handleNotice(method, params),
        onServerRequest: (method, params, reply, replyError) => handleServerRequest(method, params, reply, replyError),
        onForensics: (reason) => { if (!forensicsLogged) logForensics(reason, backend?.forensicSections() ?? []) },
        onExit: (info) => handleBackendExit(info)
      })
      backend = created
      backendStarting = created.waitReady().then(async () => {
        if (shuttingDown) throw new AcpFault(-32000, 'ZCode connection cancelled', 'cancelled')
        // app-server is a desktop worker: its subscription models require the
        // current account host port, independently of its primary provider file.
        // Explicit isolation never consumes the real user's account material.
        if (!options.isolatedDir && created.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
          timings.start('account-sync')
          const context = createAccountContext({ dataBaseDir: created.providerSource.dataBaseDir,
            builtinPath: created.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, env: created.env })
          accountContext = context
          try {
            accountStatus = await context.sync(created)
            timings.end('account-sync', accountStatus.status === 'verified' ? 'completed' : 'failed', accountStatus.reason)
          }
          catch (error) {
            timings.end('account-sync', 'failed', error?.code ?? 'account_sync_failed')
            context.dispose()
            if (accountContext === context) accountContext = undefined
            accountStatus = { status: 'unavailable', reason: 'account_sync_failed' }
          }
        } else timings.skip('account-sync', options.isolatedDir ? 'isolated' : 'no_builtin_config')
        if (shuttingDown) throw new AcpFault(-32000, 'ZCode connection cancelled', 'cancelled')
        return created
      })
      backendStarting.catch(async () => {
        accountContext?.dispose()
        accountContext = undefined
        await created.killTree()
        if (backend === created) { backend = undefined; backendStarting = undefined }
      })
    }
    return backendStarting
  }

  /* ----- prompt 应答（turn 事件异步写回） ----- */

  const settlePrompt = (response) => {
    const prompt = pendingPrompt
    if (!prompt || prompt.settled) return
    if (!prompt.accepted) { prompt.terminal ??= response; return }
    prompt.settled = true
    pendingPrompt = undefined
    for (const entry of pendingPermissions.values()) if (!entry.settled) settlePermission(entry, { decision: 'deny', reason: 'ACP turn ended' })
    if ('error' in response) acpError(prompt.id, response.code, response.message)
    else acpResult(prompt.id, { stopReason: response.stopReason })
  }

  /* ----- 权限（deny 默认） ----- */

  const sendAcpPermissionRequest = (entry, request) => {
    if (entry.acpId !== undefined || !session) return
    permissionSeq += 1
    entry.acpId = `perm-${permissionSeq}`
    writeAcp({
      id: entry.acpId,
      method: 'session/request_permission',
      params: { sessionId: session.acpSessionId, toolCall: request.toolCall, options: request.options }
    })
  }

  const settlePermission = (entry, response) => {
    if (entry.settled) return
    entry.settled = true
    entry.response = response
    clearTimeout(entry.timer)
    for (const reply of entry.rpcReplies) reply(response)
    entry.rpcReplies = []
    // Retain settled IDs for event-before-RPC ordering; bound the tombstones.
    if (pendingPermissions.size > 1024) for (const [id, value] of pendingPermissions) {
      if (value.settled && value !== entry) { pendingPermissions.delete(id); break }
    }
  }

  const registerPermission = (params) => {
    const record = translate.asRecord(params)
    if (!session || record.sessionId && record.sessionId !== session.acpSessionId) return
    if (!pendingPrompt || record.turnId && pendingPrompt.turnId && record.turnId !== pendingPrompt.turnId) return
    const request = translate.permissionRequestFromZcode(params)
    if (!request) return
    let entry = pendingPermissions.get(request.requestId)
    if (!entry) {
      entry = { requestId: request.requestId, acpId: undefined, rpcReplies: [], settled: false, request }
      pendingPermissions.set(request.requestId, entry)
      entry.timer = setTimeout(() => settlePermission(entry, { decision: 'deny', reason: 'ACP permission timed out' }), 120_000)
      entry.timer.unref()
    }
    if (!entry.settled) sendAcpPermissionRequest(entry, request)
    return entry
  }

  const resolveAcpPermissionResponse = (message) => {
    const entry = [...pendingPermissions.values()].find((candidate) => candidate.acpId === message.id)
    if (!entry) return
    const outcome = message.error !== undefined && message.error !== null
      ? undefined
      : translate.asRecord(translate.asRecord(message.result).outcome)
    if (outcome?.outcome === 'selected') {
      const response = entry.request.responses[outcome.optionId]
      if (!response) return // An invalid ID cannot consume the legitimate resolver.
      settlePermission(entry, response)
    } else settlePermission(entry, { decision: 'deny', reason: 'ACP permission cancelled' })
  }

  /* ----- 服务端→客户端请求（必答，否则服务端 15s -32022） ----- */

  const handleServerRequest = (method, params, reply, replyError) => {
    if (accountContext?.handleRequest(method, params, reply, replyError)) return true
    if (method === 'interaction/requestPermission') {
      const requestId = translate.stringField(translate.asRecord(params), 'requestId')
      if (!requestId) {
        replyError(-32602, 'interaction/requestPermission 缺少 requestId')
        return
      }
      const record = translate.asRecord(params)
      if (!session || record.sessionId !== session.acpSessionId || record.turnId && pendingPrompt?.turnId && record.turnId !== pendingPrompt.turnId) {
        reply({ decision: 'deny', reason: 'ACP permission owner mismatch' }); return
      }
      const entry = pendingPermissions.get(requestId) ?? registerPermission(params)
      if (!entry) { reply({ decision: 'deny', reason: 'ACP turn inactive' }); return }
      if (entry.settled) reply(entry.response)
      else entry.rpcReplies.push(reply)
      return
    }
    debug(`服务端未知请求 ${method}，回 -32601（连接保持）`)
  }

  /* ----- session/event 翻译 ----- */

  const deliverZcodeEvent = (event) => {
    if (!session) return
    const payload = translate.asRecord(event.payload)
    if (event.type === 'turn.started') {
      if (pendingPrompt && payload.inputId === pendingPrompt.inputId) pendingPrompt.turnId = event.turnId
      return
    }
    if (event.type !== 'session.updated') {
      if (!pendingPrompt) return
      if (pendingPrompt.terminal) return
      if (payload.inputId && payload.inputId !== pendingPrompt.inputId) return
      if (event.turnId && event.turnId !== pendingPrompt.turnId) return
    }
    switch (translate.classifyZcodeEvent(event)) {
      case 'turn-end': {
        const stopReason = translate.turnStopReason(event)
        settlePrompt(stopReason ? { stopReason } : { error: true, code: -32000, message: translate.turnFailureMessage(event) })
        return
      }
      case 'turn-failed':
        settlePrompt({ error: true, code: -32000, message: translate.turnFailureMessage(event) })
        return
      case 'permission':
        registerPermission({ ...payload, sessionId: event.sessionId, turnId: event.turnId })
        return
      case 'updates':
        if (event.type === 'permission.resolved' && pendingPrompt.toolStates.get(payload.toolCallId) !== 'open') return
        if (event.type === 'model.streaming' && payload.kind === 'tool_input_delta' && payload.toolCallId && typeof payload.delta === 'string') {
          const input = `${session.toolInputs.get(payload.toolCallId) ?? ''}${payload.delta}`
          session.toolInputs.set(payload.toolCallId, input)
          writeAcp({ method: 'session/update', params: { sessionId: session.acpSessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: payload.toolCallId, rawInput: input } } })
        }
        for (const update of translate.zcodeEventToAcpUpdates(event)) {
          if (update.sessionUpdate === 'tool_call' && !pendingPrompt?.toolStates.has(update.toolCallId)) pendingPrompt?.toolStates.set(update.toolCallId, 'open')
          if (update.status === 'completed' || update.status === 'failed') pendingPrompt?.toolStates.set(update.toolCallId, 'settled')
          if (session) writeAcp({ method: 'session/update', params: { sessionId: session.acpSessionId, update } })
        }
        return
      default:
        return
    }
  }

  const drainEvents = () => {
    if (!session) return
    while (session.queuedEvents.has(session.baseSeq + 1)) {
      const seq = session.baseSeq + 1
      const event = session.queuedEvents.get(seq)
      session.queuedEvents.delete(seq)
      session.baseSeq = seq
      deliverZcodeEvent(event)
    }
  }

  const handleZcodeEvent = (event) => {
    if (!session || event.sessionId !== session.acpSessionId) return
    const seq = translate.numberField(translate.asRecord(event), 'seq')
    debug(`event ${event.type ?? '(missing)'} seq=${seq ?? '?'} cursor=${session.baseSeq}`)
    if (!Number.isSafeInteger(seq) || seq <= session.baseSeq) return
    session.queuedEvents.set(seq, event)
    if (session.queuedEvents.size > 2048) { shutdown(1, 'ZCode event buffer overflow'); return }
    if (session.subscribing) return
    drainEvents()
    if (session.queuedEvents.size && !session.reconciling) {
      const owned = session
      owned.reconciling = backend.request('session/events', { sessionId: owned.acpSessionId, afterSeq: owned.baseSeq }).then(result => {
        if (session !== owned) return
        for (const replay of result.events ?? []) {
          if (replay.sessionId === owned.acpSessionId && Number.isSafeInteger(replay.seq) && replay.seq > owned.baseSeq) owned.queuedEvents.set(replay.seq, replay)
        }
        drainEvents()
        if (owned.queuedEvents.size) throw new Error(`ZCode event sequence gap after ${owned.baseSeq}`)
      }).catch(error => {
        settlePrompt({ error: true, code: -32000, message: error.message })
        shutdown(1, error.message)
      }).finally(() => { owned.reconciling = undefined })
    }
  }

  /* ----- 会话创建 / 恢复 ----- */

  const nativeMcpServers = (input) => {
    if (input === undefined) return []
    if (!Array.isArray(input)) throw new AcpFault(-32602, 'mcpServers must be an array')
    return input.map(raw => {
      const value = translate.asRecord(raw)
      const name = translate.stringField(value, 'name')
      const entries = (input) => {
        if (!Array.isArray(input) || input.some(entry => !translate.stringField(translate.asRecord(entry), 'name') || typeof translate.asRecord(entry).value !== 'string')) throw new AcpFault(-32602, 'Invalid MCP environment/header entry')
        return input.map(entry => ({ name: entry.name, value: entry.value }))
      }
      if (!name) throw new AcpFault(-32602, 'MCP server requires a name')
      if (value.type === 'http' || value.type === 'sse') {
        if (!translate.stringField(value, 'url')) throw new AcpFault(-32602, 'MCP server requires a URL')
        return { name, type: value.type, url: value.url, headers: entries(value.headers ?? []) }
      }
      if (!translate.stringField(value, 'command') || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string')) throw new AcpFault(-32602, 'Invalid stdio MCP server')
      return { name, command: value.command, args: value.args, env: entries(value.env ?? []) }
    })
  }

  const applySnapshot = (snapshot, { fullCatalog = false, publish = false } = {}) => {
    if (session) {
      const record = translate.asRecord(snapshot)
      const nativeId = translate.stringField(translate.asRecord(record.session), 'sessionId')
      if (nativeId && nativeId !== session.acpSessionId) throw new AcpFault(-32000, 'ZCode snapshot changed native session identity')
      const revision = translate.numberField(translate.asRecord(record.runtime), 'stateRevision')
      if (revision !== undefined && revision < (session.stateRevision ?? -1)) return
      if (revision !== undefined) session.stateRevision = revision
      const prior = session.snapshot ?? {}
      const settings = translate.asRecord(record.settings)
      const priorSettings = translate.asRecord(prior.settings)
      const model = translate.asRecord(settings.model)
      const priorModel = translate.asRecord(priorSettings.model)
      session.snapshot = { ...prior, ...record, session: { ...translate.asRecord(prior.session), ...translate.asRecord(record.session) }, settings: {
        ...priorSettings, ...settings, model: { ...priorModel, ...model,
          ...('model' in settings ? { current: model.current ?? translate.asRecord(record.session).model } : {}),
          available: fullCatalog ? model.available : priorModel.available ?? model.available }
      } }
      if ('model' in settings) session.snapshot.session.model = model.current ?? translate.asRecord(record.session).model
      const modes = translate.modesFromSnapshot(session.snapshot)
      const modelOption = translate.modelConfigOptionFromSnapshot(session.snapshot)
      const changedMode = session.modes?.currentModeId !== modes.currentModeId
      const changedModel = JSON.stringify(session.modelOption) !== JSON.stringify(modelOption)
      session.modes = modes
      session.modelOption = modelOption
      session.modelDefaults = translate.reasoningDefaultsFromSnapshot(session.snapshot)
      if (publish && changedMode) writeAcp({ method: 'session/update', params: { sessionId: session.acpSessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: modes.currentModeId } } })
      if (publish && changedModel) writeAcp({ method: 'session/update', params: { sessionId: session.acpSessionId, update: { sessionUpdate: 'config_option_update', configOptions: modelOption ? [modelOption] : [] } } })
    }
  }

  const handleNotice = (method, params) => {
    debug(`notice ${method}`)
    if (method !== 'state.updated' || !session || params.scope !== 'session' || params.sessionId !== session.acpSessionId) return
    const patch = translate.asRecord(params.patch)
    // 0.16.9 configuration patches are settings, not an entire snapshot.
    if (!patch.model && !patch.mode && !patch.thoughtLevel) return
    applySnapshot({ settings: patch, runtime: { stateRevision: params.revision } }, { publish: true })
  }

  const sessionResponse = () => ({
    modes: session?.modes,
    configOptions: session?.modelOption ? [{ ...session.modelOption,
      ...(accountStatus?.status === 'unavailable' ? { description: `BigModel 账户暂未就绪（${accountStatus.reason}）；模型清单以当前原生服务返回为准。` } : {}) }] : undefined
  })

  const emitSubscribedEvents = (subscribed, { establishBaseline = false } = {}) => {
    if (shuttingDown) throw new AcpFault(-32000, 'ZCode connection cancelled', 'cancelled')
    if (!session || typeof subscribed !== 'object' || subscribed === null || Array.isArray(subscribed)) {
      throw new AcpFault(-32000, 'ZCode subscription returned an invalid acknowledgement', 'invalid_subscription')
    }
    // Native sequence namespaces depend on deliveryKind. Resume must obtain its
    // watermark from this subscription, not a snapshot in the default namespace.
    if (subscribed.sessionId !== session.acpSessionId) throw new AcpFault(-32000, 'ZCode subscription changed native session identity', 'invalid_subscription')
    if (!Number.isSafeInteger(subscribed.eventSeq) || subscribed.eventSeq < 0) throw new AcpFault(-32000, 'ZCode subscription lacks a valid event watermark', 'invalid_subscription')
    if (establishBaseline) {
      session.baseSeq = subscribed.eventSeq
      for (const seq of session.queuedEvents.keys()) if (seq <= session.baseSeq) session.queuedEvents.delete(seq)
    }
    if (subscribed.snapshot) applySnapshot(subscribed.snapshot)
    for (const event of Array.isArray(subscribed.events) ? subscribed.events : []) handleZcodeEvent(event)
    session.subscribing = false
    drainEvents()
    if (session.queuedEvents.size) handleZcodeEvent([...session.queuedEvents.values()][0])
  }

  const newSessionState = (sessionId, baseSeq) => ({ acpSessionId: sessionId, baseSeq, queuedEvents: new Map(), toolInputs: new Map(), subscribing: true })

  const subscribeSession = (sessionId, afterSeq, includeSnapshot = true) => {
    if (!backend) throw new AcpFault(-32000, 'ZCode app-server 未运行')
    // create uses afterSeq=0 to close its event window; resume establishes the
    // desktop subscription's own watermark without replaying historical turns.
    return backend.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot,
      ...(afterSeq === undefined ? {} : { afterSeq }) })
  }

  const createSession = async (workspacePath, mcpServers, timings) => {
    if (session) throw new AcpFault(-32010, 'This adapter already owns a native session')
    const active = await ensureBackend(workspacePath, timings)
    active.providerSource.assertCurrent()
    timings.start('session-create-or-resume')
    const snapshot = await active.requestSlow('session/create', {
      workspace: { workspacePath, workspaceKey: translate.workspaceKeyFromPath(workspacePath) },
      persistence: 'immediate', mcpServers
    })
    if (shuttingDown) throw new AcpFault(-32000, 'ZCode connection cancelled', 'cancelled')
    const sessionId = translate.stringField(translate.asRecord(translate.asRecord(snapshot).session), 'sessionId')
    if (!sessionId) throw new AcpFault(-32000, 'ZCode session/create 未返回 sessionId', 'invalid_session')
    accountContext?.bindSession(sessionId, { workspacePath, workspaceKey: translate.workspaceKeyFromPath(workspacePath) })
    session = newSessionState(sessionId, 0)
    applySnapshot(snapshot, { fullCatalog: true })
    timings.end('session-create-or-resume')
    // create already supplied the full catalog/snapshot. A second native
    // snapshot repeats plugin/command discovery; retain the actual subscription
    // acknowledgement and replay window, including changes queued meanwhile.
    await timings.measure('subscribe', async () => emitSubscribedEvents(await subscribeSession(sessionId, 0, false)))
    forensicsLogged = false
    clearLastErrorLog(forensicsDir)
    return sessionId
  }

  const resumeSession = async (sessionId, workspacePath, mcpServers, timings) => {
    if (pendingPrompt || session && session.acpSessionId !== sessionId) throw new AcpFault(-32010, 'Cannot replace an owned or active native session')
    const active = await ensureBackend(workspacePath ?? process.cwd(), timings)
    active.providerSource.assertCurrent()
    const params = { sessionId, mcpServers }
    if (workspacePath) params.workspace = { workspacePath, workspaceKey: translate.workspaceKeyFromPath(workspacePath) }
    timings.start('session-create-or-resume')
    const snapshot = await active.requestSlow('session/resume', params)
    if (shuttingDown) throw new AcpFault(-32000, 'ZCode connection cancelled', 'cancelled')
    if (snapshot?.session?.sessionId !== sessionId) throw new AcpFault(-32000, 'ZCode resume changed the native session identity', 'invalid_session')
    const root = workspacePath ?? process.cwd()
    accountContext?.bindSession(sessionId, { workspacePath: root, workspaceKey: translate.workspaceKeyFromPath(root) })
    session = newSessionState(sessionId, 0)
    applySnapshot(snapshot, { fullCatalog: true })
    timings.end('session-create-or-resume')
    await timings.measure('subscribe', async () => emitSubscribedEvents(await subscribeSession(sessionId), { establishBaseline: true }))
  }

  const requireSession = (rawSessionId) => {
    if (!session || session.acpSessionId !== rawSessionId) {
      throw new AcpFault(-32602, `未知会话：${typeof rawSessionId === 'string' ? rawSessionId : '(缺失)'}`)
    }
    if (!backend || !backend.child) throw new AcpFault(-32000, 'ZCode app-server 未运行')
    if (shuttingDown || activeConnection || session.subscribing) throw new AcpFault(-32000, 'ZCode session subscription is not ready')
  }

  const setZcodeModel = async (encodedModelId) => {
    if (!backend || !session) throw new AcpFault(-32602, '会话未就绪')
    backend.providerSource.assertCurrent()
    const model = translate.decodeModelId(encodedModelId)
    if (!model) throw new AcpFault(-32602, `无法解析模型标识：${encodedModelId}（期望 providerId/modelId）`)
    // 实测：部分模型（如 K3）setModel 必须带 options.reasoningLevel，取目录 defaultLevel 兜底。
    const defaultLevel = session.modelDefaults?.[encodedModelId]
    const params = { sessionId: session.acpSessionId, model: defaultLevel ? { ...model, options: { reasoningLevel: defaultLevel } } : model,
      persistAsWorkspaceLastUsed: false }
    const snapshot = await backend.request('session/setModel', params)
    applySnapshot(snapshot, { publish: true })
    if (session.modelOption?.currentValue !== encodedModelId) throw new AcpFault(-32000, 'ZCode did not acknowledge the requested model')
  }

  /* ----- ACP 方法分派 ----- */

  const handlers = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
      agentInfo: AGENT_INFO,
      authMethods: []
    }),
    session_new: async (params, _requestId, timings) => {
      const workspacePath = translate.stringField(translate.asRecord(params), 'cwd')
      if (!workspacePath) throw new AcpFault(-32602, 'session/new 缺少 cwd')
      if (!isAbsolute(workspacePath)) throw new AcpFault(-32602, `cwd 必须为绝对路径：${workspacePath}`)
      const sessionId = await createSession(workspacePath, nativeMcpServers(translate.asRecord(params).mcpServers), timings)
      return { sessionId, ...sessionResponse() }
    },
    session_load: async (params, _requestId, timings) => {
      const record = translate.asRecord(params)
      const sessionId = translate.stringField(record, 'sessionId')
      if (!sessionId) throw new AcpFault(-32602, 'session/load 缺少 sessionId')
      const workspacePath = translate.stringField(record, 'cwd')
      if (workspacePath && !isAbsolute(workspacePath)) throw new AcpFault(-32602, 'session/load cwd must be absolute')
      await resumeSession(sessionId, workspacePath, nativeMcpServers(record.mcpServers), timings)
      return sessionResponse()
    },
    session_prompt: async (params, acpRequestId) => {
      const record = translate.asRecord(params)
      requireSession(translate.stringField(record, 'sessionId'))
      backend.providerSource.assertCurrent()
      if (pendingPrompt) throw new AcpFault(-32010, '已有 prompt 运行中，请先取消')
      let content
      try { content = translate.promptToZcodeContent(record.prompt) }
      catch (error) { throw new AcpFault(-32602, error instanceof Error ? error.message : 'Invalid ACP prompt content') }
      if (!content) throw new AcpFault(-32602, '仅支持文本输入（image=false）')
      // Native input IDs survive adapter restarts. A process-local counter would
      // collide with an earlier turn after loading the same native session.
      const prompt = { id: acpRequestId, inputId: `acp-${randomUUID()}`, settled: false, accepted: false, toolStates: new Map() }
      pendingPrompt = prompt
      session.toolInputs.clear()
      try {
        const accepted = await backend.request('session/send', { sessionId: session.acpSessionId, content, inputId: prompt.inputId })
        if (accepted?.accepted !== true || accepted.sessionId !== session.acpSessionId) throw new AcpFault(-32000, 'ZCode session/send returned invalid acknowledgement')
        prompt.accepted = true
        if (prompt.terminal) settlePrompt(prompt.terminal)
      } catch (error) {
        if (pendingPrompt === prompt) pendingPrompt = undefined
        throw error
      }
      return ASYNC_REPLY // 应答由 turn.completed / turn.failed 事件写回
    },
    session_set_mode: async (params) => {
      const record = translate.asRecord(params)
      requireSession(translate.stringField(record, 'sessionId'))
      const modeId = translate.stringField(record, 'modeId')
      if (!modeId) throw new AcpFault(-32602, 'session/set_mode 缺少 modeId')
      const snapshot = await backend.request('session/setMode', { sessionId: session.acpSessionId, mode: modeId })
      applySnapshot(snapshot, { publish: true })
      return {}
    },
    session_set_model: async (params) => {
      const record = translate.asRecord(params)
      requireSession(translate.stringField(record, 'sessionId'))
      const modelId = translate.stringField(record, 'modelId')
      if (!modelId) throw new AcpFault(-32602, 'session/set_model 缺少 modelId')
      await setZcodeModel(modelId)
      return {}
    },
    session_set_config_option: async (params) => {
      const record = translate.asRecord(params)
      requireSession(translate.stringField(record, 'sessionId'))
      const configId = translate.stringField(record, 'configId')
      const value = translate.stringField(record, 'value')
      if (configId !== translate.MODEL_CONFIG_ID || !value) throw new AcpFault(-32602, `不支持的配置项：${configId ?? '(缺失)'}`)
      await setZcodeModel(value)
      return { configOptions: session?.modelOption ? [session.modelOption] : [] }
    }
  }

  const dispatch = async (message) => {
    const method = typeof message.method === 'string' ? message.method : ''
    if (!initialized && method !== 'initialize') {
      if (message.id !== undefined && message.id !== null) acpError(message.id, -32000, '适配器尚未 initialize')
      return
    }
    const name = method.replace(/^session\//, 'session_').replace(/-/g, '_')
    const handler = handlers[name]
    if (!handler) {
      if (message.id !== undefined && message.id !== null) acpError(message.id, -32601, `Method not found: ${method}`)
      return
    }
    let result
    let timings
    try {
      if (method === 'session/new' || method === 'session/load') {
        if (activeConnection) throw new AcpFault(-32010, 'ZCode connection is already in progress')
        timings = createConnectionTimings(method === 'session/new' ? 'new' : 'load', !!(backend?.child && backend.startupState.ready), timingsDir)
        activeConnection = timings
      }
      result = await handler(message.params ?? {}, message.id, timings)
      if (timings) result = { ...result, _meta: { trellisZcode: { connectionTimings: timings.finish('completed') } } }
      if (method === 'initialize') initialized = true
    } catch (error) {
      const connectionTimings = timings?.finish('failed', error?.connectionTimingReason ?? 'request_failed')
      if (message.id === undefined || message.id === null) {
        console.error(`[zcode-acp] ${method} 处理失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const data = connectionTimings ? { ...translate.asRecord(error?.data), _meta: { trellisZcode: { connectionTimings } } } : error?.data
      if (error instanceof AcpFault) acpError(message.id, error.code, error.message, data)
      else {
        const code = typeof (error ?? {}).code === 'number' ? error.code : -32000
        acpError(message.id, code, error instanceof Error ? error.message : String(error), data)
      }
      return
    } finally {
      if (timings && activeConnection === timings) activeConnection = undefined
    }
    if (result === ASYNC_REPLY || message.id === undefined || message.id === null) return
    acpResult(message.id, result)
  }

  /* ----- stdin 读取与分派 ----- */

  const reader = createInterface({ input: process.stdin })
  reader.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try { message = JSON.parse(trimmed) } catch { acpError(null, -32700, 'JSON 解析失败'); return }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      acpError(null, -32600, '信封不合法')
      return
    }
    if (typeof message.method === 'string') {
      if (message.method === 'session/cancel' && (message.id === undefined || message.id === null)) {
        // ACP cancel 是通知：透传 session/stop；进行中 turn 将收到 turn.completed(cancelled) 收尾。
        if (session && message.params?.sessionId === session.acpSessionId && backend?.child) {
          for (const entry of pendingPermissions.values()) if (!entry.settled) settlePermission(entry, { decision: 'deny', reason: 'ACP permission cancelled' })
          backend.request('session/stop', { sessionId: session.acpSessionId }).catch(error => {
            settlePrompt({ error: true, code: -32000, message: error.message })
          })
        }
        return
      }
      void dispatch(message)
      return
    }
    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      resolveAcpPermissionResponse(message)
    }
  })
  process.stdout.on('error', () => shutdown(0, 'stdout 写出错误'))
}

serve(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(`[zcode-acp] 适配器致命错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
