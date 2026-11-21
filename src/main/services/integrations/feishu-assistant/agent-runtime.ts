import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { acpProcessEnv, acpSpawnEnv, resolveAcpLaunchOptions } from '../../../../shared/acp-launch-options'
import { nativeResource, powershellPath } from '../../../daemon/native'
import { resolveAcpRuntimeLaunch } from '../../acp/setup'
import { getSettings } from '../../store'

export class ClaudeFeishuError extends Error {
  constructor(readonly kind: 'unavailable' | 'unknown', message: string) {
    super(message)
  }
}

const workerResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string().trim().min(1).max(48_000) }).strict(),
  z.object({ ok: z.literal(false), kind: z.enum(['unavailable', 'unknown']), message: z.string().min(1).max(300) }).strict()
])

function fileIdentity(file: string): string {
  const canonical = realpathSync.native(file)
  const stat = statSync(canonical, { bigint: true })
  if (!stat.isFile()) throw new Error('invalid file')
  return JSON.stringify([canonical, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)])
}

function claudeBinary(adapterEntry: string, env: Record<string, string>): { executable: string; sdk: string } {
  const fromAdapter = createRequire(adapterEntry)
  const sdk = fromAdapter.resolve('@anthropic-ai/claude-agent-sdk')
  const override = env.CLAUDE_CODE_EXECUTABLE
  if (override) {
    if (!isAbsolute(override) || process.platform === 'win32' && !/\.exe$/i.test(override)) throw new Error('invalid override')
    return { executable: realpathSync.native(override), sdk }
  }
  const fromSdk = createRequire(sdk)
  const extension = process.platform === 'win32' ? '.exe' : ''
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  const linuxMusl = process.platform === 'linux' && !report?.header?.glibcVersionRuntime
  const packages = process.platform === 'linux'
    ? linuxMusl
      ? [`linux-${process.arch}-musl`, `linux-${process.arch}`]
      : [`linux-${process.arch}`, `linux-${process.arch}-musl`]
    : [`${process.platform}-${process.arch}`]
  for (const suffix of packages) {
    try { return { executable: fromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/claude${extension}`), sdk } }
    catch { /* Try the same platform fallback as the installed Claude adapter. */ }
  }
  throw new Error('missing Claude binary')
}

function invokeWorker(node: string, body: string, env: Record<string, string>, signal: AbortSignal): Promise<string> {
  const windows = process.platform === 'win32'
  const worker = nativeResource('feishu-claude-worker.cjs')
  const encode = (value: string): string => Buffer.from(value).toString('base64')
  const executable = windows ? powershellPath() : node
  const args = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      nativeResource('windows-pi-engine.ps1'), '-ExecutableBase64', encode(node), '-EntryBase64', encode(worker)]
    : [worker]
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const child = spawn(executable, args, {
      cwd: tmpdir(), env, windowsHide: true, detached: !windows, stdio: ['pipe', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let size = 0, finished = false
    let failure: Error | undefined
    const settle = (error?: Error): void => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const abort = (): void => {
      try {
        if (!windows && child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill()
      } catch { /* The exact owned process may have exited already. */ }
    }
    child.once('error', () => settle(new Error('Claude worker unavailable')))
    child.once('close', code => settle(failure ?? (code === 0 && !signal.aborted ? undefined : new Error('Claude worker did not complete'))))
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 512 * 1024) { failure = new Error('Claude worker output exceeded limit'); abort(); return }
      chunks.push(chunk)
    })
    child.stdout.once('error', () => { failure = new Error('Claude worker output failed'); abort() })
    child.stderr.resume()
    child.stderr.once('error', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdin?.once('error', abort)
    child.stdin?.end(body)
  })
}

function claudeDefaults(): ReturnType<typeof resolveAcpLaunchOptions> {
  try { return resolveAcpLaunchOptions(getSettings().acp?.runtimeDefaults?.claude, undefined, process.platform) }
  catch { throw new ClaudeFeishuError('unavailable', 'Claude 运行时配置无效，请在 Crux 检查执行引擎设置。') }
}

async function claudeLaunch(): ReturnType<typeof resolveAcpRuntimeLaunch> {
  try { return await resolveAcpRuntimeLaunch('claude') }
  catch { throw new ClaudeFeishuError('unavailable', '所选 Claude 执行引擎不可用，请在 Crux 检查其安装和配置。') }
}

/** Use the CLI packaged with the selected managed Claude Runtime, never Pi or a PATH fallback. */
export async function claudeFeishuReply(system: string, user: string, signal?: AbortSignal): Promise<string> {
  const unavailable = '所选 Claude 执行引擎不可用，请在 Crux 检查其安装和配置。'
  const timeout = AbortSignal.timeout(65_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  combined.throwIfAborted()
  const defaults = claudeDefaults()
  if (defaults.args?.length) {
    throw new ClaudeFeishuError('unavailable', 'Claude 的额外启动参数无法用于飞书无工具模式，请在 Crux 检查执行引擎设置。')
  }
  const selected = await claudeLaunch()
  combined.throwIfAborted()
  if (!('argv' in selected) || selected.config.id !== 'claude' || selected.config.launchKind !== 'managed' ||
      selected.argv.length !== 2) throw new ClaudeFeishuError('unavailable', unavailable)
  const env = acpSpawnEnv(process.env, acpProcessEnv(defaults, process.platform), process.platform)
  if (env.NODE_OPTIONS) {
    throw new ClaudeFeishuError('unavailable', 'Claude 的 Node 启动参数无法用于飞书无工具模式，请在 Crux 检查执行引擎设置。')
  }
  let paths: { executable: string; sdk: string }, executableIdentity: string, sdkIdentity: string
  try {
    paths = claudeBinary(selected.argv[1], env)
    executableIdentity = fileIdentity(paths.executable)
    sdkIdentity = fileIdentity(paths.sdk)
  } catch { throw new ClaudeFeishuError('unavailable', unavailable) }
  const original = JSON.stringify({ config: selected.config, argv: selected.argv, defaults })
  const before = await claudeLaunch()
  combined.throwIfAborted()
  if (!('argv' in before) || JSON.stringify({ config: before.config, argv: before.argv,
    defaults: claudeDefaults() }) !== original) {
    throw new ClaudeFeishuError('unavailable', 'Claude 运行时配置已变化，请重新发送请求。')
  }
  const body = JSON.stringify({ version: 1, ...paths, system, user, model: defaults.modelId })
  if (Buffer.byteLength(body) > 512 * 1024) throw new ClaudeFeishuError('unavailable', '飞书消息超过 Claude 文字接入的长度限制。')
  let raw: string
  try {
    raw = await invokeWorker(selected.argv[0], body, {
      ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1'
    }, combined)
  } catch {
    signal?.throwIfAborted()
    throw new ClaudeFeishuError('unknown', 'Claude 没有返回可确认的答复，请在 Crux 检查运行时和模型状态。')
  }
  const parsed = workerResult.safeParse((() => { try { return JSON.parse(raw) as unknown } catch { return null } })())
  if (!parsed.success) throw new ClaudeFeishuError('unknown', 'Claude 返回的答复无法核验，请在 Crux 检查运行时状态。')
  if (!parsed.data.ok) throw new ClaudeFeishuError(parsed.data.kind, parsed.data.message)
  try {
    const after = await claudeLaunch()
    combined.throwIfAborted()
    if (!('argv' in after) || JSON.stringify({ config: after.config, argv: after.argv,
      defaults: claudeDefaults() }) !== original ||
      fileIdentity(paths.executable) !== executableIdentity || fileIdentity(paths.sdk) !== sdkIdentity) throw new Error('changed')
  } catch { throw new ClaudeFeishuError('unknown', 'Claude 运行时配置在处理期间已变化，请在 Crux 核对后重试。') }
  return parsed.data.text
}
