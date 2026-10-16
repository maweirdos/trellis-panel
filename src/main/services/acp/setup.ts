/** Explicit, pinned adapter provisioning. Discovery and Start never install. */
import { app, dialog } from 'electron'
import { execFile } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { delimiter, dirname, isAbsolute, join } from 'path'
import type { AcpAgentConfig, AcpAgentStatus } from '../../../shared/types'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { getSettings, setSettings } from '../store'
import { acpDataPath, writeJson } from './metadata'
import { errorMessage, objectValue } from './types'

export const NATIVE_TOOLS_DIAGNOSTIC = '工具由适配器原生能力提供；ACP 客户端文件和终端回调未启用，实际工具以该适配器报告和运行结果为准。'

const BUILTINS = {
  codex: { name: 'Codex', packageName: '@agentclientprotocol/codex-acp', version: '2.2.2', bin: 'codex-acp' },
  claude: { name: 'Claude Code', packageName: '@agentclientprotocol/claude-agent-acp', version: '0.91.0', bin: 'claude-agent-acp' }
} as const
type BuiltinId = keyof typeof BUILTINS
const setups = new Map<string, Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail>>()
let lastProbe: Promise<AcpAgentStatus[]> | undefined

function run(executable: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())))
}

function regularFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

export function findExecutable(command: string): string | undefined {
  if (isAbsolute(command)) return regularFile(command) ? command : undefined
  if (!command || /[\\/]/.test(command)) return undefined
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
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
  const items: AcpAgentConfig[] = Object.entries(BUILTINS).map(([id, spec]) => ({ id, name: spec.name, command: `${spec.packageName}@${spec.version}`, enabled: true, launchKind: 'managed' }))
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

async function probe(): Promise<AcpAgentStatus[]> {
  let node: { path: string; version: string } | undefined
  let nodeError = ''
  try { node = await externalNode() } catch (error) { nodeError = errorMessage(error) }
  return runtimeDefinitions().map((config): AcpAgentStatus => {
    const base = { ...config, runtimeId: config.id, checkedAt: Date.now(), nodePath: node?.path }
    if (isManaged(config)) {
      const entry = installedEntry(config.id)
      return { ...base, available: !!node && !!entry, health: !node ? 'executable_missing' : !entry ? 'adapter_missing' : 'not_checked',
        adapterVersion: BUILTINS[config.id].version, setupRequired: !entry,
        diagnostics: [nodeError || `Node ${node?.version}；固定 acpx 0.19.5 / compat 1`, entry ? '适配器已安装；认证和 ACP 就绪状态将在启动时验证' : '请显式安装此 Runtime；启动不会自动下载', NATIVE_TOOLS_DIAGNOSTIC] }
    }
    const executable = config.executable ? findExecutable(config.executable) : undefined
    const valid = config.executable ? !!executable : config.command.trim().length > 0
    return { ...base, available: valid, health: valid ? 'not_checked' : 'executable_missing', setupRequired: false,
      diagnostics: [config.executable ? valid ? '结构化启动命令可用；协议将在启动时验证' : '找不到指定可执行文件' : '旧版完整 shell 命令保留；启动时按原命令执行，不以空格拆分', NATIVE_TOOLS_DIAGNOSTIC] }
  })
}

export async function listAcpAgents(refresh = false): Promise<{ ok: true; agents: AcpAgentStatus[] }> {
  if (!lastProbe || refresh) lastProbe = probe().catch((error) => { lastProbe = undefined; throw error })
  return { ok: true, agents: await lastProbe }
}

export async function launchArgv(config: AcpAgentConfig): Promise<string[]> {
  if (config.launchKind === 'managed' && !isManaged(config)) throw new Error('历史 Runtime 固定版本不可用，请保留历史并显式创建新会话')
  if (isManaged(config)) {
    const node = await externalNode()
    const entry = installedEntry(config.id)
    if (!entry) throw new Error('Runtime 尚未安装，请先点击安装；启动不会自动下载')
    return [node.path, entry]
  }
  if (config.executable) {
    const executable = findExecutable(config.executable)
    if (!executable) throw new Error('指定可执行文件不存在，请刷新或修改 Runtime 配置')
    return [executable, ...(config.args ?? [])]
  }
  // Explicit legacy shell semantics preserve the complete original command.
  // Do not infer executable/argv boundaries by splitting user input.
  return process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', config.command]
    : ['/bin/sh', '-lc', config.command]
}

export async function setupAcpRuntime(id: string): Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail> {
  if (!Object.hasOwn(BUILTINS, id)) return ipcFail(IpcErrorCode.InvalidArg, '自定义 Runtime 请在本机自行安装和配置')
  const pending = setups.get(id)
  if (pending) return pending
  const task = (async (): Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail> => {
    try {
      const node = await externalNode()
      const spec = BUILTINS[id as BuiltinId]
      const directory = acpDataPath('runtimes', id, spec.version)
      const npmCli = [join(dirname(node.path), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(node.path), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(regularFile)
      if (!npmCli) return ipcFail(IpcErrorCode.NotFound, '选定 Node 旁未找到 npm-cli.js，请选择包含 npm 的 Node 安装')
      writeJson(join(directory, 'package.json'), { name: `trellis-acp-${id}`, private: true, version: '1.0.0' })
      await run(node.path, [npmCli, 'install', '--prefix', directory, '--no-audit', '--no-fund', '--save-exact', `${spec.packageName}@${spec.version}`], 180000)
      if (!installedEntry(id as BuiltinId)) throw new Error('安装结果缺少预期版本或入口，未标记为可用')
      writeJson(join(directory, 'trellis-runtime.json'), { schemaVersion: 1, packageName: spec.packageName, version: spec.version, nodePath: node.path, installedAt: Date.now() })
      return listAcpAgents(true)
    } catch (error) { return ipcFail(IpcErrorCode.Io, `Runtime 安装失败：${errorMessage(error)}`) }
  })()
  setups.set(id, task)
  try { return await task } finally { setups.delete(id) }
}

export async function pickAcpNode(): Promise<{ ok: true; cancelled?: boolean; nodePath?: string; agents?: AcpAgentStatus[] } | IpcFail> {
  const selection = await dialog.showOpenDialog({ title: '选择独立 Node.js（>=22.13）', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Node.js', extensions: ['exe'] }] : [] })
  const nodePath = selection.filePaths[0]
  if (selection.canceled || !nodePath) return { ok: true, cancelled: true }
  const previous = getSettings().acp
  setSettings({ acp: { ...previous, nodePath } })
  try {
    await externalNode()
    return { ...await listAcpAgents(true), nodePath }
  } catch (error) {
    setSettings({ acp: previous })
    return ipcFail(IpcErrorCode.InvalidArg, errorMessage(error))
  }
}
