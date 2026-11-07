/**
 * ZCode app-server 客户端（协议事实以 research/protocol-mapping.md 为准）：
 * - NDJSON 帧、无 `jsonrpc` 字段（带该键会被服务端 -32600 拒绝）
 * - 请求/响应（30s 超时）、通知、服务端→客户端双向请求（必须应答，否则服务端 15s -32022）
 * - 启动收集 `startup/storageState` 直至 phase=ready（10s 超时拒绝连接）
 * - 环境默认真实用户态（模型/登录可见，复用本机 ~/.zcode）：仅剔除 ZCODE_BASE_URL、注入 ZCODE_BIN；
 *   显式传入隔离目录时才注入 ZCODE_DATA_BASE_DIR 并重定向 HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP
 * - 显式指定 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE（存在时），消除 app-server 内置 provider
 *   配置候选回退对 cwd/运行环境的依赖（Electron 内曾启动即 exit=1）
 * - stderr 环形缓冲 200 行随诊断暴露；退出走 taskkill /T /F（win32）+ kill 兜底
 * - 取证硬化：app-server 意外死亡时把现场（退出码/信号、stderr 全文、最近收发帧）覆盖写入
 *   <forensicsDir>/zcode-adapter-last-error.log（隔离模式=隔离目录，默认=系统临时目录），
 *   供宿主在会话启动失败时附加给用户
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { resolveProviderEnvironment } from './provider-config.mjs'
import { managedZcodeLaunch } from './managed-startup.mjs'

const READY_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const SLOW_REQUEST_TIMEOUT_MS = 60_000
const STDERR_RING_LINES = 200
const EXIT_GRACE_MS = 5_000
const AUTOMATION_TOOLS_DEFAULT = 'CronCreate CronList CronUpdate CronDelete'
const LAST_ERROR_LOG_FILE = 'zcode-adapter-last-error.log'
const FORENSIC_FRAME_LINES = 3 // 现场快照保留的最近收发帧条数
const FORENSIC_FRAME_CHARS = 800 // 单帧快照截断上限
const FORENSIC_FRAME_RING = 8 // 内存中保留的收发帧环形深度（快照取其尾部）

export function redactDiagnostic(text) {
  return String(text).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|key-)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/((?:api[ _-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .slice(0, 16_384)
}

/** Only JS entries go through Node; Windows shims must go through cmd. */
export function zcodeLaunch(nodePath, zcodeBin, args, platform = process.platform) {
  if (/\.(?:cjs|mjs|js)$/i.test(zcodeBin)) return { command: nodePath, args: [zcodeBin, ...args] }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(zcodeBin)) {
    const all = [zcodeBin, ...args]
    if (all.some(value => /[%!"\r\n]/.test(value))) throw new Error('ZCode batch path contains unsupported shell characters; select its JavaScript entry instead')
    return { command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/c', `"${all.map(value => `"${value}"`).join(' ')}"`], windowsVerbatimArguments: true }
  }
  if (platform === 'win32' && extname(zcodeBin).toLowerCase() !== '.exe') throw new Error('请选择 ZCode JavaScript entry、.exe 或 Windows .cmd/.bat')
  return { command: zcodeBin, args }
}

/** 尸检日志固定路径；forensicsDir 为空时不落盘（隔离模式=隔离目录，默认模式=系统临时目录，由入口决定）。 */
export function lastErrorLogPath(forensicsDir) {
  return forensicsDir ? join(forensicsDir, LAST_ERROR_LOG_FILE) : undefined
}

/** 覆盖写现场快照；取证落盘失败不改变退出/错误语义。 */
export function writeLastErrorLog(forensicsDir, lines) {
  const path = lastErrorLogPath(forensicsDir)
  if (!path) return false
  try {
    mkdirSync(forensicsDir, { recursive: true })
    writeFileSync(path, redactDiagnostic(['=== ZCode ACP 适配器现场快照 ===', ...lines, ''].join('\n')), { encoding: 'utf8', mode: 0o600 })
    return true
  } catch { return false }
}

/** 适配器成功启动后清除上次现场，避免旧尸检误导诊断（下轮失败会重新覆盖写）。 */
export function clearLastErrorLog(forensicsDir) {
  const path = lastErrorLogPath(forensicsDir)
  if (!path) return
  try { unlinkSync(path) } catch { /* 不存在或不可删均无害 */ }
}

/** 默认禁用自动化计划工具（复刻 Crux 安全默认）；enableAutomationTools=true 才放行。 */
export function appServerArgs(workspacePath, enableAutomationTools) {
  return ['app-server', '--stdio', '--cwd', workspacePath, ...(enableAutomationTools ? [] : ['--disallowed-tools', AUTOMATION_TOOLS_DEFAULT])]
}

/**
 * 解析 CLI 内置 provider 配置文件（Crux resolve.ts 同序两候选）：
 * <zcodeBin 目录>/provider/zcode-builtin.json → <zcodeBin 目录>/../config/provider/zcode-builtin.json。
 * 纯同步 fs 检查；两候选均缺失返回 undefined（不设 env，维持服务端自身回退行为）。
 */
export function builtinProviderConfigFile(zcodeBin) {
  if (!zcodeBin) return undefined
  const binDir = dirname(zcodeBin)
  for (const candidate of [join(binDir, 'provider', 'zcode-builtin.json'), join(binDir, '..', 'config', 'provider', 'zcode-builtin.json')]) {
    try { if (statSync(candidate).isFile()) return candidate } catch { /* 缺省试下一候选 */ }
  }
  return undefined
}

/**
 * app-server 环境。默认真实用户态：仅剔除 ZCODE_BASE_URL、注入 ZCODE_BIN 与内置 provider
 * 配置文件，模型目录与登录态复用本机 ~/.zcode（2026-10-22 用户决策）。isolatedDir 显式传入
 * （--isolated 旗标，测试/诊断用）才做全套隔离：ZCODE_DATA_BASE_DIR + 系统路径重定向。
 */
export function appServerEnv(zcodeBin, isolatedDir) {
  const env = { ...process.env }
  // Electron's Node-only and module injection state must not leak into a selected external CLI.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ZCODE_BASE_URL // Crux 源码注明：会被 app-server 读作服务 origin，污染端点
  env.ZCODE_BIN = zcodeBin
  // 服务端候选回退曾受运行环境影响（Electron 内启动即 exit=1「无法为 CLI ZCode Built-in Provider
  // Config」）；存在即显式指定，消除对 cwd/候选回退的依赖。指向安装目录自带文件，与用户态共存无冲突。
  const builtinConfig = builtinProviderConfigFile(zcodeBin)
  if (builtinConfig && !env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinConfig
  // 仅 ZCODE_DATA_BASE_DIR 不足以隔离 CLI 状态（~/.zcode/cli 走 HOME 系变量）：
  // 隔离模式下重定向四项系统路径，保证该模式下不写用户 ~/.zcode（protocol-mapping.md §8 实测）。
  if (isolatedDir) {
    delete env.TRELLIS_ZCODE_STARTUP_CACHE_DIR
    // HOME 重定向目标必须真实存在，否则 app-server 启动即失败。
    mkdirSync(isolatedDir, { recursive: true })
    const home = isolatedDir.replace(/[\\/]+$/, '')
    env.ZCODE_DATA_BASE_DIR = isolatedDir
    env.USERPROFILE = home
    env.HOME = home
    env.APPDATA = join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(home, 'AppData', 'Local')
    env.TEMP = join(home, 'AppData', 'Local', 'Temp')
    env.TMP = env.TEMP
    for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.TEMP]) mkdirSync(directory, { recursive: true })
  }
  return env
}

export class ZcodeBackend {
  /**
   * @param options {nodePath, zcodeBin, workspacePath, isolatedDir, enableAutomationTools,
   *   onEvent(params), onNotice(method, params), onServerRequest(method, params, reply),
   *   onForensics(reason), onExit(info)}
   *   isolatedDir：显式 --isolated 隔离目录（缺省真实用户态）；取证目录由入口另行决定。
   */
  constructor(options) {
    this.options = options
    this.child = undefined
    this.shuttingDown = false
    this.nextId = 1
    this.pending = new Map()
    this.stderrLines = []
    this.sentFrames = []
    this.receivedFrames = []
    this.startupState = { ready: false, diagnostic: '' }
    this.ready = undefined
  }

  /** 启动进程并等待真实 storageState ready；超时拒绝连接。 */
  start() {
    if (this.ready) return this.ready
    const timings = this.options.connectionTimings
    timings?.start('backend-process')
    let child
    try {
      const args = appServerArgs(this.options.workspacePath, this.options.enableAutomationTools === true)
      const env = appServerEnv(this.options.zcodeBin, this.options.isolatedDir)
        if (this.options.startupCacheDir) env.TRELLIS_ZCODE_STARTUP_CACHE_DIR = this.options.startupCacheDir
        const launch = managedZcodeLaunch(this.options.nodePath, this.options.zcodeBin, args, env.TRELLIS_ZCODE_STARTUP_CACHE_DIR)
          ?? zcodeLaunch(this.options.nodePath, this.options.zcodeBin, args)
      const providerSource = resolveProviderEnvironment(env, { isolatedDir: this.options.isolatedDir })
      this.env = env
      this.providerSource = providerSource
      this.options.onNotice?.('adapter/providerConfig', { source: providerSource.source })
      providerSource.verify()
      child = spawn(launch.command, launch.args, {
        cwd: this.options.workspacePath,
        env,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.child = child
    } catch (error) {
      timings?.end('backend-process', 'failed', 'preparation_failed')
      throw error
    }
    this.ready = new Promise((resolve, reject) => {
      let settled = false
      child.once('spawn', () => {
        timings?.end('backend-process')
        timings?.start('storage-ready')
      })
      this.readyResolve = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        timings?.end('storage-ready')
        resolve(this.startupState)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        timings?.end('storage-ready', 'failed', 'storage_timeout')
        this.startupState.diagnostic = `等待 startup/storageState ready 超时（${READY_TIMEOUT_MS / 1000}s）`
        this.options.onForensics?.(this.startupState.diagnostic)
        reject(new Error(this.startupState.diagnostic))
      }, READY_TIMEOUT_MS)
      child.once('error', (error) => {
        this.child = undefined
        if (settled) return
        settled = true
        clearTimeout(timer)
        timings?.end('backend-process', 'failed', 'spawn_failed')
        timings?.end('storage-ready', 'failed', 'backend_exited')
        // spawn 失败（如 node/CLI 路径不可执行）不伴随 exit 事件，须单独落盘现场。
        this.options.onForensics?.(`ZCode app-server 启动失败（spawn）：${error.message}`)
        reject(new Error(`ZCode app-server 启动失败：${error.message}`))
      })
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        timings?.end('storage-ready', 'failed', 'backend_exited')
        reject(new Error(`ZCode app-server 在就绪前退出（code=${code ?? 'unknown'}）：${this.stderrTail()}`))
      })
      child.stdout?.setEncoding('utf8')
      createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.length === 0) continue
          this.stderrLines.push(redactDiagnostic(line).slice(0, 2048))
          if (this.stderrLines.length > STDERR_RING_LINES) this.stderrLines.shift()
        }
      })
      child.once('exit', (code, signal) => {
        this.child = undefined
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer)
          entry.reject(new Error(`ZCode app-server 已退出（code=${code ?? 'unknown'}）`))
        }
        this.pending.clear()
        if (!this.shuttingDown) {
          // 非预期死亡：先落盘现场再回调 onExit（其会触发 shutdown/exit，须保证快照先写完）。
          this.options.onForensics?.(`ZCode app-server 意外退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）`)
        }
        this.options.onExit?.({ code, signal, unexpected: !this.shuttingDown })
      })
    })
    return this.ready
  }

  handleLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try { message = JSON.parse(trimmed) } catch { return } // 非 JSON 行（横幅等）忽略
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return
    this.rememberFrame(this.receivedFrames, message)
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        // 服务端→客户端双向请求：必答，否则 15s 超时 -32022 连带父操作失败。
        const reply = (result) => this.write({ id: message.id, result })
        const replyError = (code, text) => this.write({ id: message.id, error: { code, message: text } })
        if (message.method === 'session/requestRuntimePreferences') {
          // protocol-mapping §1.1 实测最小应答
          reply({ nativeSearchEnhancementsEnabled: false })
          return
        }
        // interaction/requestPermission 由适配器异步应答；其余未知服务端请求回 -32601 但不让连接崩溃。
        const handled = this.options.onServerRequest?.(message.method, message.params ?? {}, reply, replyError)
        if (handled !== true && message.method !== 'interaction/requestPermission') replyError(-32601, `Method not found: ${message.method}`)
        return
      }
      if (message.method === 'startup/storageState') {
        const params = message.params ?? {}
        if (params.phase === 'ready') {
          this.startupState.ready = true
          if (this.ready) this.readyResolve?.(this.startupState)
        }
        this.options.onNotice?.(message.method, params)
        return
      }
      if (message.method === 'session/event') {
        this.options.onEvent?.(message.params ?? {})
        return
      }
      this.options.onNotice?.(message.method, message.params ?? {})
      return
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined && message.error !== null) {
        const error = typeof message.error === 'object' && message.error !== null ? message.error : {}
        const failure = new Error(redactDiagnostic(`ZCode ${entry.method} 失败（code=${error.code ?? 'unknown'}）：${error.message ?? '未知错误'}`))
        failure.code = typeof error.code === 'number' ? error.code : undefined
        if (error.data !== undefined) {
          try { failure.data = JSON.parse(redactDiagnostic(JSON.stringify(error.data))) } catch { failure.data = { detail: 'Native error details unavailable' } }
        }
        entry.reject(failure)
      } else entry.resolve(message.result)
    }
  }

  /** 等待启动就绪；供 ensureBackend 在 create 前调用。 */
  async waitReady() {
    await this.start()
    return this.startupState
  }

  request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!this.child) return Promise.reject(new Error('ZCode app-server 未运行'))
    const id = this.nextId++
    const timeout = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ZCode ${method} 超时（${timeout / 1000}s）`))
      }, timeout)
      this.pending.set(id, { method, resolve, reject, timer })
      if (!this.write({ id, method, params: params ?? {} })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('ZCode app-server stdin 不可写'))
      }
    })
  }

  /** create/resume 等重操作放宽到 60s。 */
  requestSlow(method, params) {
    return this.request(method, params, SLOW_REQUEST_TIMEOUT_MS)
  }

  write(frame) {
    const child = this.child
    if (!child || child.stdin === undefined || child.stdin.destroyed || !child.stdin.writable) return false
    try {
      // 防御：ZCode 信封禁带 jsonrpc 键（unrecognized_keys → -32600）。
      const outgoing = { ...frame }
      delete outgoing.jsonrpc
      const text = JSON.stringify(outgoing)
      this.rememberFrame(this.sentFrames, outgoing)
      child.stdin.write(`${text}\n`)
      return true
    } catch {
      return false
    }
  }

  /** 记录最近收发帧（环形，超长截断）；仅供取证快照使用，不影响协议处理。 */
  rememberFrame(ring, frame) {
    // Payloads may contain prompts, credentials, tool bytes or account state.
    const text = JSON.stringify({ id: frame.id, method: frame.method,
      ...(frame.error ? { errorCode: frame.error.code } : {}),
      ...(frame.params ? { paramKeys: Object.keys(frame.params), type: frame.params.type, seq: frame.params.seq } : {}) })
    ring.push(text.length > FORENSIC_FRAME_CHARS ? `${text.slice(0, FORENSIC_FRAME_CHARS)}…(truncated)` : text)
    if (ring.length > FORENSIC_FRAME_RING) ring.shift()
  }

  /** 取证快照正文：stderr 环形缓冲全文 + 最近收发帧各最多 3 条。 */
  forensicSections() {
    const frames = [
      ...this.sentFrames.slice(-FORENSIC_FRAME_LINES).map((frame) => `→ ${frame}`),
      ...this.receivedFrames.slice(-FORENSIC_FRAME_LINES).map((frame) => `← ${frame}`)
    ]
    return [
      `--- stderr 环形缓冲（${this.stderrLines.length} 行）---`,
      ...(this.stderrLines.length > 0 ? this.stderrLines : ['（无 stderr 输出）']),
      `--- 最近收发帧（→ 发往 app-server / ← app-server 返回，各最多 ${FORENSIC_FRAME_LINES} 条，超长截断）---`,
      ...(frames.length > 0 ? frames : ['（无已收发帧）'])
    ]
  }

  stderrTail() {
    return this.stderrLines.slice(-20).join(' | ').slice(-600)
  }

  stderrAll() {
    return this.stderrLines.join('\n')
  }

  /** 树终止：win32 taskkill /T /F + kill 兜底（参考既有 connection-probe 进程卫生）。 */
  killTree() {
    this.shuttingDown = true
    const child = this.child
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let deadline
      const finish = () => {
        clearTimeout(grace)
        clearTimeout(deadline)
        resolve()
      }
      const grace = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        deadline = setTimeout(() => reject(new Error('ZCode owned process cleanup could not be confirmed')), EXIT_GRACE_MS)
      }, EXIT_GRACE_MS)
      child.once('exit', finish)
      if (process.platform === 'win32') {
        const pid = child.pid
        if (pid) {
          try {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
              .on('error', () => { try { child.kill() } catch { /* 已退出 */ } })
              .unref()
          } catch { try { child.kill() } catch { /* 已退出 */ } }
        } else { try { child.kill() } catch { /* 已退出 */ } }
      } else {
        try { child.kill() } catch { /* 已退出 */ }
      }
    })
  }
}
