/** Explicit, pinned adapter provisioning. Discovery and Start never install. */
import { app, dialog } from 'electron'
import { execFile } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { delimiter, dirname, isAbsolute, join } from 'path'
import type { AcpAgentConfig, AcpAgentStatus, Settings } from '../../../shared/types'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { getSettings, setSettings } from '../store'
import { acpDataPath, writeJson } from './metadata'
import { errorMessage, objectValue } from './types'

export const NATIVE_TOOLS_DIAGNOSTIC = '工具由适配器原生能力提供；ACP 客户端文件和终端回调未启用，实际工具以该适配器报告和运行结果为准。'

const BUILTINS = {
  codex: { name: 'Codex', packageName: '@agentclientprotocol/codex-acp', version: '2.2.2', bin: 'codex-acp' },
  claude: { name: 'Claude Code', packageName: '@agentclientprotocol/claude-agent-acp', version: '0.91.0', bin: 'claude-agent-acp' }
} as const

/**
 * 随应用打包的桥接适配器（launchKind 'bundled'，如 ZCode→ACP 翻译层）：entry 随 resources 复制，
 * 无安装步骤；内部 CLI（zcode）由本模块检测并以 `--zcode-bin` 显式传给适配器。
 */
const BUNDLED = {
  zcode: { name: 'ZCode', commandName: 'zcode' }
} as const
type BuiltinId = keyof typeof BUILTINS
type NativeId = keyof typeof NATIVES
type BundledId = keyof typeof BUNDLED

/**
 * 原生 ACP CLI 直连预设：CLI 自身提供 ACP server 模式（启动参数证据见任务 research/native-acp-launch.md）。
 * 检测是只读探测；唯一的安装/升级写路径是 setupAcpRuntime 的 npm -g 安装（安装即升级，不 pin 版本）。
 */
const NATIVES = {
  opencode: { name: 'OpenCode', commandName: 'opencode', launchArgs: ['acp'], npmPackage: 'opencode-ai', installHint: 'npm install -g opencode-ai', missingHint: '未找到 opencode；可通过「安装执行引擎」（npm install -g opencode-ai）或官方安装脚本安装' },
  dsh: { name: 'DeepSeek DSH', commandName: 'dsh', launchArgs: ['--profile', 'acp'], npmPackage: '@deepseek-ai/dsh', installHint: 'npm install -g @deepseek-ai/dsh', missingHint: '未找到 dsh；可通过「安装执行引擎」（npm install -g @deepseek-ai/dsh）安装（需要 Node >=22.19）' }
} as const
const setups = new Map<string, Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail>>()
let lastProbe: Promise<AcpAgentStatus[]> | undefined

/** Node ≥18 拒绝直接 spawn Windows 批处理 shim（EINVAL）：与 acpx 同款经 cmd.exe /d /s /c 包装。
 * 持久 stdio（connection-probe）与 execFile（run()）共用同一条包装策略。 */
export function batchShell(executable: string, args: string[]): { target: string; argv: string[]; batch: boolean } {
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
  const target = batch ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe') : executable
  const argv = batch ? ['/d', '/s', '/c', `"${executable} ${args.join(' ')}"`] : args
  return { target, argv, batch }
}

function run(executable: string, args: string[], timeout = 5000): Promise<string> {
  const { target, argv, batch } = batchShell(executable, args)
  return new Promise((resolve, reject) => execFile(target, argv, { windowsHide: true, windowsVerbatimArguments: batch, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())))
}

function regularFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

export function findExecutable(command: string): string | undefined {
  if (isAbsolute(command)) return regularFile(command) ? command : undefined
  if (!command || /[\\/]/.test(command)) return undefined
  // Windows npm shims ship an extensionless POSIX sh script next to the runnable
  // .cmd/.exe; CreateProcess cannot execute the sh script, so extensions win.
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory.replace(/^"|"$/g, ''), `${command}${suffix}`)
      if (regularFile(candidate)) return candidate
    }
  }
  return undefined
}

async function externalNode(): Promise<{ path: string; version: string }> {
  const explicit = getSettings().acp?.nodePath
  const path = explicit || findExecutable(process.platform === 'win32' ? 'node.exe' : 'node')
  if (!path || !isAbsolute(path) || !regularFile(path)) throw new Error('未找到外部 Node.js，请选择 Node >=22.13 的可执行文件')
  if (path.toLowerCase() === process.execPath.toLowerCase() && process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) throw new Error('请选择独立 Node.js，不能使用 Electron 可执行文件')
  const version = await run(path, ['--version'])
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match || Number(match[1]) < 22 || Number(match[1]) === 22 && Number(match[2]) < 13) throw new Error(`Node ${version} 不兼容，需要 >=22.13`)
  return { path, version }
}

async function assertZcodeNode(nodePath: string): Promise<void> {
  try {
    await run(nodePath, ['--input-type=module', '-e', 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); db.close()'])
  } catch { throw new Error('ZCode 需要支持 node:sqlite 的外部 Node.js；请选择包含 SQLite 的 Node >=22.13') }
}

/** 选定 Node 旁的 npm-cli.js：Windows 布局与 POSIX 全局布局两种（managed 安装与 native 一键安装共用）。 */
function npmCliFor(nodePath: string): string | undefined {
  return [join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(regularFile)
}

function installedEntry(id: BuiltinId): string | undefined {
  const spec = BUILTINS[id]
  const directory = acpDataPath('runtimes', id, spec.version)
  const packageDir = join(directory, 'node_modules', ...spec.packageName.split('/'))
  try {
    const manifest = objectValue(JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')))
    if (manifest.version !== spec.version || manifest.name !== spec.packageName) return undefined
    const bin = typeof manifest.bin === 'string' ? manifest.bin : objectValue(manifest.bin)[spec.bin]
    if (typeof bin !== 'string') return undefined
    const entry = join(packageDir, bin)
    return regularFile(entry) ? entry : undefined
  } catch { return undefined }
}

export function runtimeDefinitions(): AcpAgentConfig[] {
  const overrides = getSettings().acp?.agents ?? []
  const items: AcpAgentConfig[] = [
    ...Object.entries(BUILTINS).map(([id, spec]) => ({ id, name: spec.name, command: `${spec.packageName}@${spec.version}`, enabled: true, launchKind: 'managed' as const })),
    ...Object.entries(NATIVES).map(([id, spec]) => ({ id, name: spec.name, command: [spec.commandName, ...spec.launchArgs].join(' '), enabled: true, launchKind: 'native' as const })),
    ...Object.entries(BUNDLED).map(([id, spec]) => ({ id, name: spec.name, command: 'bundled ACP bridge（随应用提供）', enabled: true, launchKind: 'bundled' as const }))
  ]
  for (const config of overrides) {
    const index = items.findIndex((item) => item.id === config.id)
    // Preserve explicit user launch commands, including existing preset overrides.
    const custom = { ...config, launchKind: 'custom' as const }
    if (index >= 0) items[index] = custom
    else items.push(custom)
  }
  if (!app.isPackaged && !items.some((item) => item.id === 'mock')) items.push({
    id: 'mock', name: '诊断 Mock（开发专用）', command: 'diagnostic fixture', enabled: true,
    executable: getSettings().acp?.nodePath || findExecutable(process.platform === 'win32' ? 'node.exe' : 'node'),
    args: [join(app.getAppPath(), 'scripts', 'smoke', 'acp-mock-agent.mjs'), '--serve']
  })
  return items
}

function isManaged(config: AcpAgentConfig): config is AcpAgentConfig & { id: BuiltinId } {
  if (!Object.hasOwn(BUILTINS, config.id) || config.launchKind === 'custom') return false
  const spec = BUILTINS[config.id as BuiltinId]
  // Older schema-2 snapshots have no provenance. Only the exact generated
  // definition qualifies; never reinterpret an arbitrary custom command.
  return config.command === `${spec.packageName}@${spec.version}` && !config.executable && !config.args?.length
}

function isNative(config: AcpAgentConfig): config is AcpAgentConfig & { id: NativeId } {
  // Persisted overrides are always normalized to launchKind 'custom' in
  // runtimeDefinitions, so only the generated native definition reaches here.
  return config.launchKind === 'native' && Object.hasOwn(NATIVES, config.id)
}

function isBundled(config: AcpAgentConfig): config is AcpAgentConfig & { id: BundledId } {
  return config.launchKind === 'bundled' && Object.hasOwn(BUNDLED, config.id)
}

/** 宽松读取 CLI --version 输出中的首个版本号形态 token，避免把横幅文案当版本展示。 */
function versionToken(output: string): string | undefined {
  const line = output.split(/\r?\n/).find((entry) => entry.trim().length > 0)
  const token = line?.trim().split(/\s+/).at(-1)
  return token && /^\d[\w.\-+]*$/.test(token) ? token : undefined
}

/** R8 检测优先级：nativePaths 手动指定（须为存在的文件）> PATH 自动检测；无效手动路径回退自动检测。 */
function nativeExecutable(id: NativeId): { path: string; manual: boolean } | undefined {
  const manual = getSettings().acp?.nativePaths?.[id]
  if (manual && isAbsolute(manual) && regularFile(manual)) return { path: manual, manual: true }
  const auto = findExecutable(NATIVES[id].commandName)
  return auto ? { path: auto, manual: false } : undefined
}

/** bundled 适配器 entry 解析（dev/prod 收敛一处）：dev 直读源码，打包读 electron-builder extraResources 复制产物。 */
export function resolveAdapterEntry(): string | undefined {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'adapters', 'zcode-acp')
    : join(app.getAppPath(), 'adapters', 'zcode-acp')
  const entry = join(base, 'src', 'index.mjs')
  return regularFile(entry) ? entry : undefined
}

/** bundled 条目的内部 CLI 检测：nativePaths 手动指定 > 环境变量 ZCODE_BIN > PATH > 标准安装位置表（复刻 HiFox 发现顺序）。 */
function zcodeExecutable(): { path: string; manual: boolean } | undefined {
  const manual = getSettings().acp?.nativePaths?.zcode
  if (manual && isAbsolute(manual) && regularFile(manual)) return { path: manual, manual: true }
  // 环境变量与适配器同款语义（TRELLIS_ZCODE_BIN / ZCODE_BIN）：值指向 zcode.cjs/js 或可执行文件。
  const envBin = process.env.TRELLIS_ZCODE_BIN ?? process.env.ZCODE_BIN
  if (envBin && regularFile(envBin)) return { path: envBin, manual: true }
  const onPath = findExecutable(BUNDLED.zcode.commandName)
  if (onPath) return { path: onPath, manual: false }
  const standardPaths = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? [join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')]
    : process.platform === 'darwin' ? ['/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'] : []
  const standard = standardPaths.find(regularFile)
  return standard ? { path: standard, manual: false } : undefined
}

function bundledAutomationAllowed(): boolean {
  return getSettings().acp?.zcode?.enableAutomationTools === true
}

async function probe(): Promise<AcpAgentStatus[]> {
  let node: { path: string; version: string } | undefined
  let nodeError = ''
  try { node = await externalNode() } catch (error) { nodeError = errorMessage(error) }
  return Promise.all(runtimeDefinitions().map(async (config): Promise<AcpAgentStatus> => {
    const base = { ...config, runtimeId: config.id, checkedAt: Date.now(), nodePath: node?.path }
    if (isManaged(config)) {
      const entry = installedEntry(config.id)
      return { ...base, available: !!node && !!entry, health: !node ? 'executable_missing' : !entry ? 'adapter_missing' : 'not_checked',
        adapterVersion: BUILTINS[config.id].version, setupRequired: !entry,
        diagnostics: [nodeError || `Node ${node?.version}；固定 acpx 0.19.5 / compat 1`, entry ? '适配器已安装；认证和 ACP 就绪状态将在启动时验证' : '请显式安装此 Runtime；启动不会自动下载', NATIVE_TOOLS_DIAGNOSTIC] }
    }
    if (isNative(config)) {
      const spec = NATIVES[config.id]
      const manual = getSettings().acp?.nativePaths?.[config.id]
      const detected = nativeExecutable(config.id)
      if (!detected) return { ...base, available: false, health: 'executable_missing', setupRequired: false,
        diagnostics: [...(manual ? [`手动指定的路径不可用（${manual}），且 PATH 自动检测未命中`] : []), spec.missingHint, NATIVE_TOOLS_DIAGNOSTIC] }
      let version: string | undefined
      try { version = versionToken(await run(detected.path, ['--version'])) } catch { /* 版本读取失败不改变可用性，连接时按原样暴露 */ }
      let latestVersion: string | undefined
      if (node) {
        try {
          const npmCli = npmCliFor(node.path)
          // 注册表查询仅用于"是否有新版本"的诚实呈现；不可达时不阻塞检测、不猜最新版。
          if (npmCli) latestVersion = versionToken(await run(node.path, [npmCli, 'view', spec.npmPackage, 'version'], 8000))
        } catch { /* latestVersion 留空即"未知"，UI 不显示升级提示 */ }
      }
      return { ...base, available: true, health: 'not_checked', setupRequired: false, adapterVersion: version, latestVersion,
        diagnostics: [`${detected.manual ? '手动指定' : '自动检测'}：检测到 ${spec.name}：${detected.path}；协议与登录状态将在连接时验证`,
          ...(manual && !detected.manual ? ['手动指定路径无效，已回退 PATH 自动检测'] : []), NATIVE_TOOLS_DIAGNOSTIC] }
    }
    if (isBundled(config)) {
      const entry = resolveAdapterEntry()
      const manual = getSettings().acp?.nativePaths?.zcode
      const detected = zcodeExecutable()
      let sqliteError = ''
      if (node) try { await assertZcodeNode(node.path) } catch (error) { sqliteError = errorMessage(error) }
      let version: string | undefined
      if (detected && node) {
        // zcode.cjs 需要 node 加载；PATH 命中的 shim 走既有批处理包装。版本失败不改变可用性。
        try {
          const cjs = /\.(?:cjs|mjs|js)$/i.test(detected.path)
          version = versionToken(await run(cjs ? node.path : detected.path, cjs ? [detected.path, '--version'] : ['--version']))
        } catch { /* 版本留空即"未知" */ }
      }
      const entryLine = entry ? `内置适配器就绪：${entry}` : '内置适配器文件缺失，请重新安装应用'
      const cliLine = detected
        ? `${detected.manual ? '手动指定' : '自动检测'}：ZCode CLI：${detected.path}${version ? `（v${version}）` : ''}；协议与登录状态将在连接时验证`
        : manual
          ? `手动指定的 zcode 路径不可用（${manual}），且环境变量、PATH 与标准安装位置均未检测到 ZCode CLI`
          : '未检测到 ZCode CLI；请安装 ZCode（zcode 命令或标准安装位置），设置环境变量 ZCODE_BIN，或通过「配置路径」手动指定'
      const safeLine = bundledAutomationAllowed()
        ? '自动化计划工具（Cron*）已按设置放行'
        : '安全默认：自动化计划工具（Cron*）已禁用'
      return { ...base, available: !!entry && !!detected && !!node && !sqliteError,
        health: !entry ? 'adapter_missing' : !node || !detected || sqliteError ? 'executable_missing' : 'not_checked',
        setupRequired: false, adapterVersion: version,
        diagnostics: [entryLine, cliLine, sqliteError, entry && detected && !node ? `未找到可用的外部 Node.js：${nodeError}` : '', safeLine,
          ...(manual && detected && !detected.manual ? ['手动指定路径无效，已回退自动检测'] : []), NATIVE_TOOLS_DIAGNOSTIC].filter((line) => line.length > 0) }
    }
    const executable = config.executable ? findExecutable(config.executable) : undefined
    const valid = config.executable ? !!executable : config.command.trim().length > 0
    return { ...base, available: valid, health: valid ? 'not_checked' : 'executable_missing', setupRequired: false,
      diagnostics: [config.executable ? valid ? '结构化启动命令可用；协议将在启动时验证' : '找不到指定可执行文件' : '旧版完整 shell 命令保留；启动时按原命令执行，不以空格拆分', NATIVE_TOOLS_DIAGNOSTIC] }
  }))
}

export async function listAcpAgents(refresh = false): Promise<{ ok: true; agents: AcpAgentStatus[] }> {
  if (!lastProbe || refresh) lastProbe = probe().catch((error) => { lastProbe = undefined; throw error })
  return { ok: true, agents: await lastProbe }
}

/** Fresh selected-runtime admission. Full discovery/version queries belong to Settings,
 * not session startup. Native readiness/authentication still belongs to acpx/the adapter. */
export async function resolveAcpRuntimeLaunch(id: string): Promise<{ config: AcpAgentConfig; argv: string[] } | IpcFail> {
  const config = runtimeDefinitions().find((item) => item.id === id)
  if (!config?.enabled) return ipcFail(IpcErrorCode.InvalidArg, 'Runtime 未启用或不可用')
  try { return { config, argv: await launchArgv(config) } }
  catch (error) { return ipcFail(IpcErrorCode.InvalidArg, errorMessage(error)) }
}

export async function launchArgv(config: AcpAgentConfig): Promise<string[]> {
  if (config.launchKind === 'managed' && !isManaged(config)) throw new Error('历史 Runtime 固定版本不可用，请保留历史并显式创建新会话')
  if (isManaged(config)) {
    const node = await externalNode()
    const entry = installedEntry(config.id)
    if (!entry) throw new Error('Runtime 尚未安装，请先点击安装；启动不会自动下载')
    return [node.path, entry]
  }
  if (isNative(config)) {
    const spec = NATIVES[config.id]
    const detected = nativeExecutable(config.id)
    if (!detected) throw new Error(`未找到 ${spec.commandName}，请安装后重新探测（${spec.installHint}）`)
    return [detected.path, ...spec.launchArgs]
  }
  if (isBundled(config)) {
    const node = await externalNode()
    await assertZcodeNode(node.path)
    const entry = resolveAdapterEntry()
    if (!entry) throw new Error('内置适配器文件缺失，请重新安装应用')
    const zcode = zcodeExecutable()
    if (!zcode) throw new Error('未检测到 ZCode CLI，请安装 ZCode 后重新探测，或在设置中手动指定路径')
    // 显式传参免 PATH 依赖。默认真实用户态（不传 --isolated）：模型目录与登录态复用本机
    // ~/.zcode（2026-10-22 用户决策）；隔离是适配器 --isolated 显式可选项，测试/诊断用。
    // translate.ts 依赖 Node 类型剥离：22.13–22.17 需显式旗标，22.18+ 冗余无害。
    return [node.path, '--experimental-strip-types', entry, '--zcode-bin', zcode.path,
      ...(bundledAutomationAllowed() ? ['--enable-automation-tools'] : [])]
  }
  if (config.executable) {
    const executable = findExecutable(config.executable)
    if (!executable) throw new Error('指定可执行文件不存在，请刷新或修改 Runtime 配置')
    return [executable, ...(config.args ?? [])]
  }
  if (!config.command.trim()) throw new Error('Runtime 启动命令为空，请修改 Runtime 配置')
  // Explicit legacy shell semantics preserve the complete original command.
  // Do not infer executable/argv boundaries by splitting user input.
  return process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', config.command]
    : ['/bin/sh', '-lc', config.command]
}

/** npm 安装失败时保留原始 stderr 摘要，便于区分网络/权限/包名问题。 */
function stderrTail(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? (error as { stderr?: unknown }).stderr : undefined
  const text = typeof stderr === 'string' ? stderr.trim() : ''
  return text ? `：${text.slice(-600)}` : ''
}

export async function setupAcpRuntime(id: string): Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail> {
  if (Object.hasOwn(BUNDLED, id)) return ipcFail(IpcErrorCode.InvalidArg, '内置 Runtime 随应用提供，无需安装')
  const native = Object.hasOwn(NATIVES, id)
  if (!Object.hasOwn(BUILTINS, id) && !native) return ipcFail(IpcErrorCode.InvalidArg, '自定义 Runtime 请在本机自行安装和配置')
  const pending = setups.get(id)
  if (pending) return pending
  const task = (async (): Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail> => {
    try {
      const node = await externalNode()
      const npmCli = npmCliFor(node.path)
      if (!npmCli) return ipcFail(IpcErrorCode.NotFound, '选定 Node 旁未找到 npm-cli.js，请选择包含 npm 的 Node 安装')
      if (native) {
        const spec = NATIVES[id as NativeId]
        // npm -g 安装落在 node 前缀目录并生成 PATH 可见的 shim；重复执行即升级（不 pin 版本）。
        await run(node.path, [npmCli, 'install', '-g', '--no-audit', '--no-fund', '--loglevel=error', spec.npmPackage], 600000)
        return listAcpAgents(true)
      }
      const spec = BUILTINS[id as BuiltinId]
      const directory = acpDataPath('runtimes', id, spec.version)
      writeJson(join(directory, 'package.json'), { name: `trellis-acp-${id}`, private: true, version: '1.0.0' })
      await run(node.path, [npmCli, 'install', '--prefix', directory, '--no-audit', '--no-fund', '--save-exact', `${spec.packageName}@${spec.version}`], 180000)
      if (!installedEntry(id as BuiltinId)) throw new Error('安装结果缺少预期版本或入口，未标记为可用')
      writeJson(join(directory, 'trellis-runtime.json'), { schemaVersion: 1, packageName: spec.packageName, version: spec.version, nodePath: node.path, installedAt: Date.now() })
      return listAcpAgents(true)
    } catch (error) { return ipcFail(IpcErrorCode.Io, `Runtime 安装失败：${errorMessage(error)}${stderrTail(error)}`) }
  })()
  setups.set(id, task)
  try { return await task } finally { setups.delete(id) }
}

export type AcpSettingsWriter = (patch: Partial<Settings>) => Promise<Settings>
const localSettingsWriter: AcpSettingsWriter = async patch => setSettings(patch)
export async function pickAcpNode(write: AcpSettingsWriter = localSettingsWriter): Promise<{ ok: true; cancelled?: boolean; nodePath?: string; agents?: AcpAgentStatus[] } | IpcFail> {
  const selection = await dialog.showOpenDialog({ title: '选择独立 Node.js（>=22.13）', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Node.js', extensions: ['exe'] }] : [] })
  const nodePath = selection.filePaths[0]
  if (selection.canceled || !nodePath) return { ok: true, cancelled: true }
  const previous = getSettings().acp
  await write({ acp: { ...previous, nodePath } })
  try {
    await externalNode()
    return { ...await listAcpAgents(true), nodePath }
  } catch (error) {
    await write({ acp: previous })
    return ipcFail(IpcErrorCode.InvalidArg, errorMessage(error))
  }
}

/** 为原生直连与内置（bundled）Runtime 手动指定 CLI 可执行路径；校验通过才保存，保存后立即重新探测。 */
export async function pickAcpRuntimePath(id: string, write: AcpSettingsWriter = localSettingsWriter): Promise<{ ok: true; cancelled?: boolean; agents?: AcpAgentStatus[] } | IpcFail> {
  const native = Object.hasOwn(NATIVES, id)
  const spec = native ? NATIVES[id as NativeId] : Object.hasOwn(BUNDLED, id) ? BUNDLED[id as BundledId] : undefined
  if (!spec) return ipcFail(IpcErrorCode.InvalidArg, '仅原生直连与内置 Runtime 支持配置 CLI 路径')
  const selection = await dialog.showOpenDialog({ title: native ? `选择 ${spec.name} 可执行文件` : `选择 ${spec.name} CLI 可执行文件`, properties: ['openFile'] })
  const selected = selection.filePaths[0]
  if (selection.canceled || !selected) return { ok: true, cancelled: true }
  if (!isAbsolute(selected) || !regularFile(selected)) return ipcFail(IpcErrorCode.InvalidArg, '所选路径不是可执行文件，未保存')
  const previous = getSettings().acp
  await write({ acp: { ...previous, nativePaths: { ...previous?.nativePaths, [id]: selected } } })
  try {
    return await listAcpAgents(true)
  } catch (error) {
    await write({ acp: previous })
    return ipcFail(IpcErrorCode.Io, `状态刷新失败，已还原路径设置：${errorMessage(error)}`)
  }
}
