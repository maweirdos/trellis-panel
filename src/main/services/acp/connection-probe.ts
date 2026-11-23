/**
 * 测试连接：以 Runtime 的真实 launch argv 拉起 ACP server，发送一次 NDJSON
 * `initialize`（protocolVersion 2），在超时内收集 agentInfo/协议版本/能力/登录方式后
 * 确认原进程容器完整清理后返回。只发 initialize，不发 session/new / prompt；
 * 探测不安装引擎，程序启动本身仍可能产生副作用。
 */
import { spawn, type ChildProcess } from 'child_process'
import { tmpdir } from 'os'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { AcpProcessLaunch } from './v2'
import type { AcpAgentConfig, AcpAgentStatus, AcpConnectionProbeResult } from '../../../shared/types'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { batchShell, isSupportedRuntimeSnapshot, LEGACY_CUSTOM_RUNTIME_ERROR, listAcpAgents, runtimeDefinitions, runtimeLaunchSnapshot } from './setup'
import { errorMessage, objectValue } from './types'
import { rememberRuntimeVerification, type RuntimeConnectionProbeResult } from './runtime-verification'
import { AcpV2Client } from './v2/client'
import { AcpProtocolError } from './v2/errors'
import { hasAcpCapability } from './v2/normalize'
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

/** 精选能力白名单 → 中文标签；未知/缺失能力如实忽略，不做名称推断。 */
function capabilityLabels(capabilities: Awaited<ReturnType<AcpV2Client['initialize']>>['capabilities']): string[] {
  const session = capabilities.session
  const prompt = session?.prompt
  const mcp = session?.mcp
  const labels: string[] = []
  if (hasAcpCapability(session)) labels.push('会话基线')
  if (hasAcpCapability(prompt?.image)) labels.push('图片输入')
  if (hasAcpCapability(prompt?.embeddedContext)) labels.push('内嵌上下文')
  if (hasAcpCapability(prompt?.audio)) labels.push('音频输入')
  if ([mcp?.http, mcp?.stdio, mcp?.acp].some(hasAcpCapability)) labels.push('MCP')
  return labels
}

function authMethodIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => stringField(objectValue(entry).methodId)).filter((id): id is string => typeof id === 'string')
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

function waitForExit(child: ChildProcess, graceMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const exited = (): void => { clearTimeout(timer); resolve(true) }
    const timer = setTimeout(() => { child.off('exit', exited); resolve(false) }, graceMs)
    child.once('exit', exited)
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
    else if (config.launchKind === 'sdk') probe = { ok: false, error: 'Pi 使用原生 SDK 而非 ACP v2；不能凭 SDK 安装状态标记 ACP provider 可用' }
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
  let child: ChildProcess | undefined
  let client: AcpV2Client | undefined
  let result: RuntimeConnectionProbeResult
  try {
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
    let stderrTail = ''
    const options = {
      cwd,
      env: acpSpawnEnv(process.env, env ?? {}, process.platform),
      windowsHide: true,
      windowsVerbatimArguments: batch,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe']
    }
    child = nativeJobs ? nativeJobs.spawn(launch, options) : spawn(target, spawnArgv, options)
    const started = child
    await new Promise<void>((resolve, reject) => {
      started.once('error', reject)
      started.once('spawn', resolve)
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_CHARS) })
    if (!child.pid || !child.stdout || !child.stdin) throw new Error('无法连接 ACP server 输入输出流')
    child.stdin.on('error', () => { /* The client observes stream failure. */ })
    await nativeJobs?.spawned({ ...launch, pid: child.pid, startedAt: new Date().toISOString() })
    client = await AcpV2Client.connect({ input: child.stdout, output: child.stdin }, {}, {
      initializeMs: Math.max(1, deadline - Date.now()),
    })
    const { response, capabilities } = await client.initialize({ name: 'trellis-panel', version: '0.1.0' }, {})
    result = {
      ok: true,
      agentInfo: { name: stringField(response.info.name), version: stringField(response.info.version) },
      protocolVersion: response.protocolVersion,
      authMethodIds: authMethodIds(response.authMethods),
      capabilitiesSummary: capabilityLabels(capabilities),
    }
  } catch (error) {
    result = error instanceof AcpProtocolError ? {
      ok: false,
      errorCode: error.details.code,
      ...(error.type === 'E_INCOMPATIBLE' ? { protocolVersion: error.details.returnedVersion ?? undefined } : {}),
      error: errorMessage(error),
    } : { ok: false, error: `启动失败：${errorMessage(error)}` }
  }
  try {
    if (nativeJobs) await nativeJobs.cleanupAll()
    else if (child?.pid !== undefined) {
      terminate(child)
      if (!(await waitForExit(child, EXIT_GRACE_MS))) {
        child.kill('SIGKILL')
        if (!(await waitForExit(child, EXIT_GRACE_MS))) return { ok: false, error: '原连接探测的进程清理尚未确认。' }
      }
    }
  } catch {
    return { ok: false, error: '原连接探测的进程清理尚未确认。' }
  } finally {
    child?.stdin?.destroy()
    child?.stdout?.destroy()
    await client?.close().catch(() => undefined)
  }
  return result
}
