/**
 * 测试连接：以 Runtime 的真实 launch argv 拉起 ACP server，发送一次 NDJSON
 * `initialize`（protocolVersion 1），在超时内收集 agentInfo/协议版本/能力/登录方式后
 * 确认原进程容器完整清理后返回。只发 initialize，不发 session/new / prompt；
 * 探测不安装引擎，程序启动本身仍可能产生副作用。
 */
import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { tmpdir } from 'os'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { AcpProcessLaunch } from 'acpx/runtime'
import type { AcpAgentConfig, AcpAgentStatus, AcpConnectionProbeResult } from '../../../shared/types'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { batchShell, isSupportedRuntimeSnapshot, LEGACY_CUSTOM_RUNTIME_ERROR, listAcpAgents, runtimeDefinitions, runtimeLaunchSnapshot } from './setup'
import { errorMessage, objectValue } from './types'
import { rememberRuntimeVerification, type RuntimeConnectionProbeResult } from './runtime-verification'
import { PI_VERSION } from '../pi/protocol'
import { acpSpawnEnv } from '../../../shared/acp-launch-options'
import { createAcpJobOwner } from '../workcopy-use/acp-jobs'
import { workcopyUseDirectory } from '../workcopy-use'
import { assertRuntimeExecutionHost } from '../runtime-host'

const HANDSHAKE_TIMEOUT_MS = 10_000
/** 树终止后的兜底等待；taskkill /T 失败时保证探测调用仍然返回。 */
const EXIT_GRACE_MS = 5_000
const STDERR_TAIL_CHARS = 600
const pendingProbes = new Map<string, Promise<ConnectionTestResult>>()
type ConnectionTestResult = { ok: true; probe: AcpConnectionProbeResult; agents: AcpAgentStatus[] } | IpcFail

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** ACP wire 的 protocolVersion 允许数字；宽容接收数字字符串，其余视为未提供。 */
function numericVersion(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/** 精选能力白名单 → 中文标签；未知/缺失能力如实忽略，不做名称推断。 */
function capabilityLabels(capabilities: unknown): string[] {
  const source = objectValue(capabilities)
  const prompt = objectValue(source.promptCapabilities)
  const mcp = objectValue(source.mcpCapabilities)
  const labels: string[] = []
  if (source.loadSession === true) labels.push('会话恢复')
  if (prompt.image === true) labels.push('图片输入')
  if (prompt.embeddedContext === true) labels.push('内嵌上下文')
  if (prompt.audio === true) labels.push('音频输入')
  if (mcp.http === true || mcp.sse === true) labels.push('MCP')
  return labels
}

function authMethodIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => stringField(objectValue(entry).id)).filter((id): id is string => typeof id === 'string')
}

/** 批处理 wrap 的直接子进程是 cmd.exe，必须 /T 才能带走真实 agent 进程树。 */
function terminate(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()).unref() } catch { child.kill() }
  } else {
    try { child.kill() } catch { /* 已退出 */ }
  }
}

function waitForExit(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, graceMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

/** Explicit initialize-only verification. SDK entry validation remains separate from ACP/authentication. */
export async function testAcpRuntimeConnection(id: string): Promise<ConnectionTestResult> {
  const config = runtimeDefinitions().find((item) => item.id === id)
  if (config && !isSupportedRuntimeSnapshot(config)) return ipcFail(IpcErrorCode.Unavailable, LEGACY_CUSTOM_RUNTIME_ERROR)
  if (!config?.enabled) return ipcFail(IpcErrorCode.InvalidArg, 'Runtime 未启用或不可用')
  if (config.launchKind === 'sdk' && config.id !== 'pi') return ipcFail(IpcErrorCode.InvalidArg, '此 SDK 不支持连接测试')
  const launch = await runtimeLaunchSnapshot(config)
  const pending = pendingProbes.get(launch.identity)
  if (pending) return pending
  const task = (async (): Promise<ConnectionTestResult> => {
    let probe: RuntimeConnectionProbeResult
    if (!launch.argv) probe = { ok: false, error: launch.error ?? '无法解析启动命令' }
    else if (config.launchKind === 'sdk') probe = { ok: true, agentInfo: { name: 'Pi SDK', version: PI_VERSION }, capabilitiesSummary: ['原生 SDK', '会话恢复', 'MCP', 'Skills', '上下文压缩'] }
    else probe = await probeAcpConnection(config, launch.argv, launch.env)
    const current = runtimeDefinitions().find(item => item.id === id)
    if (!current || (await runtimeLaunchSnapshot(current)).identity !== launch.identity) {
      return { ...await listAcpAgents(true), probe: { ok: false, error: '启动配置或程序已变化，请针对当前引擎重新测试连接' } }
    }
    rememberRuntimeVerification(id, launch.identity, probe)
    return { ...await listAcpAgents(), probe }
  })()
  pendingProbes.set(launch.identity, task)
  try { return await task } finally { if (pendingProbes.get(launch.identity) === task) pendingProbes.delete(launch.identity) }
}

async function probeAcpConnection(config: AcpAgentConfig, resolvedArgv?: string[], resolvedEnv?: Record<string, string>): Promise<RuntimeConnectionProbeResult> {
  assertRuntimeExecutionHost()
  let argv: string[]
  let env = resolvedEnv
  try {
    const launch = resolvedArgv && resolvedEnv ? { argv: resolvedArgv, env: resolvedEnv } : await runtimeLaunchSnapshot(config)
    if (!launch.argv) return { ok: false, error: 'error' in launch ? launch.error : '无法解析启动命令' }
    argv = resolvedArgv ?? launch.argv
    env ??= launch.env
  } catch (error) { return { ok: false, error: errorMessage(error) } }
  const head = argv[0]
  if (!head) return { ok: false, error: '启动命令为空，请先完成检测或配置 CLI 路径' }
  const { target, argv: spawnArgv, batch } = batchShell(head, argv.slice(1))
  const cwd = realpathSync.native(tmpdir()), id = `probe-${randomUUID()}`
  const nativeJobs = process.platform === 'win32' ? await createAcpJobOwner(workcopyUseDirectory(), cwd,
    { kind: 'agent', id, generation: randomUUID(), label: `${config.name} · 连接核对`.slice(0, 200) }, true) : undefined
  const launch: AcpProcessLaunch = { launchId: randomUUID(), purpose: 'agent', scope: { kind: 'runtime-probe', agent: config.id }, command: target, args: spawnArgv, cwd }
  try { return await new Promise<RuntimeConnectionProbeResult>((resolve) => {
    let settled = false
    let stderrTail = ''
    let timer: NodeJS.Timeout | undefined
    let reader: ReturnType<typeof createInterface> | undefined
    const options = {
      cwd,
      env: acpSpawnEnv(process.env, env ?? {}, process.platform),
      windowsHide: true,
      windowsVerbatimArguments: batch,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe']
    }
    const child = nativeJobs ? nativeJobs.spawn(launch, options) : spawn(target, spawnArgv, options)
    const settle = (result: RuntimeConnectionProbeResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reader?.close()
      if (nativeJobs) {
        void nativeJobs.cleanupAll().then(() => resolve(result), () => resolve({ ok: false, error: '原连接探测的完整 Job 清理尚未确认；原 Job 见证已保留，请重试原清理。' }))
        return
      }
      terminate(child)
      // 等待进程真正退出再返回；宽限期满仍未退出则升级 SIGKILL 兜底（杀不死 cmd 包裹层时至少不留活进程）。
      void waitForExit(child, EXIT_GRACE_MS).finally(() => {
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        resolve(result)
      })
    }
    const fail = (error: string): void => settle({ ok: false, error })
    timer = setTimeout(() => fail(`连接超时：${HANDSHAKE_TIMEOUT_MS / 1000} 秒内未收到 initialize 响应`), HANDSHAKE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', (error) => fail(`启动失败：${errorMessage(error)}`))
    child.on('exit', (code) => fail(`进程在握手完成前退出（code=${code ?? 'unknown'}）${stderrTail ? `：${stderrTail}` : ''}`))
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_CHARS) })
    child.stdin?.on('error', () => { /* 写入失败由 exit/error 分支如实报告 */ })
    const stdout = child.stdout
    if (!stdout) { fail('无法读取 ACP server 输出流'); return }
    const initialize = (): void => { if (settled) return; try { child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`) } catch { /* The owner observes write/exit failure. */ } }
    if (nativeJobs) {
      child.once('spawn', () => {
        if (!child.pid) { fail('原连接探测未能启动'); return }
        void nativeJobs.spawned({ ...launch, pid: child.pid, startedAt: new Date().toISOString() }).then(initialize, error => fail(errorMessage(error)))
      })
    } else initialize()
    reader = createInterface({ input: stdout })
    reader.on('line', (line) => {
      const trimmed = line.trim()
      if (settled || !trimmed) return
      let parsed: unknown
      try { parsed = JSON.parse(trimmed) } catch { return } // 启动横幅等非 JSON 行忽略
      const message = objectValue(parsed)
      if (message.id !== 1 && message.id !== '1') return // 早于 initialize 响应的通知/日志忽略
      if (message.jsonrpc !== '2.0') { fail('无效的 initialize 响应：缺少 JSON-RPC 2.0 标记'); return }
      if (message.error !== undefined && message.error !== null) {
        const detail = objectValue(message.error)
        settle({ ok: false, errorCode: typeof detail.code === 'number' ? detail.code : undefined,
          error: `initialize 被拒绝：${stringField(detail.message) ?? '未知错误'}` })
        return
      }
      const result = objectValue(message.result)
      const protocolVersion = numericVersion(result.protocolVersion)
      if (protocolVersion !== 1) {
        settle({ ok: false, protocolVersion, error: protocolVersion === undefined ? '无效的 initialize 响应：缺少有效协议版本' : `协议不兼容：引擎返回 v${protocolVersion}，客户端支持 v1` })
        return
      }
      const info = objectValue(result.agentInfo)
      settle({
        ok: true,
        agentInfo: { name: stringField(info.name), version: stringField(info.version) },
        protocolVersion,
        authMethodIds: authMethodIds(result.authMethods),
        capabilitiesSummary: capabilityLabels(result.agentCapabilities)
      })
    })
  }) } catch (error) {
    try { await nativeJobs?.cleanupAll() }
    catch { return { ok: false, error: '原连接探测的完整 Job 清理尚未确认；原 Job 见证已保留，请重试原清理。' } }
    return { ok: false, error: `启动失败：${errorMessage(error)}` }
  }
}
