/**
 * R7 测试连接：对原生 ACP CLI 以真实 launch argv 拉起 ACP server，发送一次 NDJSON
 * `initialize`（protocolVersion 1），在超时内收集 agentInfo/协议版本/能力/登录方式后
 * 立即树终止进程。**只发 initialize，绝不发 session/new / prompt**——本模块对用户
 * 数据零副作用（契约：Start 和检测永不安装，探测不建会话）。
 */
import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { tmpdir } from 'os'
import type { AcpAgentConfig, AcpConnectionProbeResult } from '../../../shared/types'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { batchShell, launchArgv, runtimeDefinitions } from './setup'
import { errorMessage, objectValue } from './types'

const HANDSHAKE_TIMEOUT_MS = 10_000
/** 树终止后的兜底等待；taskkill /T 失败时保证探测调用仍然返回。 */
const EXIT_GRACE_MS = 5_000
const STDERR_TAIL_CHARS = 600

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

/** 仅限原生直连 Runtime：以 launchArgv 实测握手，返回结构化结果（探测失败也是 ok:true + probe.ok:false）。 */
export async function testAcpRuntimeConnection(id: string): Promise<{ ok: true; probe: AcpConnectionProbeResult } | IpcFail> {
  const config = runtimeDefinitions().find((item) => item.id === id)
  if (!config || config.launchKind !== 'native') return ipcFail(IpcErrorCode.InvalidArg, '仅原生直连 Runtime 支持测试连接')
  return { ok: true, probe: await probeAcpConnection(config) }
}

export async function probeAcpConnection(config: AcpAgentConfig): Promise<AcpConnectionProbeResult> {
  let argv: string[]
  try { argv = await launchArgv(config) } catch (error) { return { ok: false, error: errorMessage(error) } }
  const head = argv[0]
  if (!head) return { ok: false, error: '启动命令为空，请先完成检测或配置 CLI 路径' }
  const { target, argv: spawnArgv, batch } = batchShell(head, argv.slice(1))
  return await new Promise<AcpConnectionProbeResult>((resolve) => {
    let settled = false
    let stderrTail = ''
    let timer: NodeJS.Timeout | undefined
    const child = spawn(target, spawnArgv, {
      cwd: tmpdir(),
      windowsHide: true,
      windowsVerbatimArguments: batch,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const settle = (result: AcpConnectionProbeResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
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
    try { child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`) } catch { /* 由 exit/error 分支报告 */ }
    const reader = createInterface({ input: stdout })
    reader.on('line', (line) => {
      const trimmed = line.trim()
      if (settled || !trimmed) return
      let parsed: unknown
      try { parsed = JSON.parse(trimmed) } catch { return } // 启动横幅等非 JSON 行忽略
      const message = objectValue(parsed)
      if (message.id !== 1 && message.id !== '1') return // 早于 initialize 响应的通知/日志忽略
      if (message.error !== undefined && message.error !== null) {
        const detail = objectValue(message.error)
        settle({ ok: false, error: `initialize 被拒绝：${stringField(detail.message) ?? '未知错误'}` })
        return
      }
      const result = objectValue(message.result)
      const info = objectValue(result.agentInfo)
      settle({
        ok: true,
        agentInfo: { name: stringField(info.name), version: stringField(info.version) },
        protocolVersion: numericVersion(result.protocolVersion),
        authMethodIds: authMethodIds(result.authMethods),
        capabilitiesSummary: capabilityLabels(result.agentCapabilities)
      })
    })
  })
}
