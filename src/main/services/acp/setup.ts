/** Explicit, pinned adapter provisioning. Discovery and Start never install. */
import { app, dialog } from 'electron'
import { execFile } from 'child_process'
import { readFileSync, realpathSync, statSync } from 'fs'
import { delimiter, dirname, isAbsolute, join, normalize } from 'path'
import type { AcpAgentConfig, AcpAgentStatus, Settings } from '../../../shared/types'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { getSettings, setSettings } from '../store'
import { acpDataPath, writeJson } from './metadata'
import { errorMessage, objectValue } from './types'
import { resolveNodeRuntime, validateNodeExecutable, type NodeExecutable, type NodeRuntime } from './managed-node'
import { resolveZcodeInstallation, resolveZcodeOverride } from './zcode-installation'
import { prepareBundledZcodeStartup } from './zcode-startup'
import { piEngineAvailable, piEngineEntry, piRuntimeDefinition } from '../pi/catalog'
import { PI_VERSION } from '../pi/protocol'
import { applyRuntimeVerification, hasRuntimeVerification, runtimeVerificationEvidenceForLaunch, runtimeVerificationIdentity } from './runtime-verification'
import { acpExtraArgv, acpLaunchEnvironment, acpProcessEnv, resolveAcpLaunchOptions } from '../../../shared/acp-launch-options'
import type { AcpRuntimeDefaults } from '../../../shared/types'
import { compareReleaseVersions, openCodeRelease, OPENCODE_MIGRATION_GUIDE, OPENCODE_V2_PACKAGE, OPENCODE_V2_VERSION, parseReleaseVersion } from './native-releases'
import { BUILTINS, BUNDLED, NATIVES, isManaged, isNative, isBundled, isSupportedRuntimeSnapshot, type BuiltinId, type NativeId, type BundledId } from './runtime-definitions'
import { listLocalProviders, localProviderLaunchEnvironment, resolveAdmittedLocalProvider } from './local-providers'
export { isSupportedRuntimeSnapshot } from './runtime-definitions'

export { BUILTINS }

export const NATIVE_TOOLS_DIAGNOSTIC = '工具由适配器原生能力提供；ACP 客户端文件和终端回调未启用，实际工具以该适配器报告和运行结果为准。'
export const LEGACY_CUSTOM_RUNTIME_ERROR = '旧自定义执行引擎已停用，无法继续执行、启动或恢复；原会话和配置仍可查看，请选择受支持的执行引擎创建新会话'

const setups = new Map<string, Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail>>()
let lastProbe: Promise<AcpAgentStatus[]> | undefined
let lastDiscoveryIdentity: string | undefined
let probeInFlight: Promise<AcpAgentStatus[]> | undefined
let probeQueriesRegistry = false
let inventoryFinishedAt = 0
const LOCAL_INVENTORY_TTL_MS = 1000
const DISCOVERY_METADATA_TTL_MS = 30_000
const LATEST_VERSION_TTL_MS = 5 * 60_000
const latestVersions = new Map<string, { checkedAt: number; version?: string }>()
type DiscoveryRead<T> = { finishedAt: number; pending: boolean; value: Promise<T> }
const runtimeVersions = new Map<string, DiscoveryRead<string | undefined>>()
const inventoryNodeChecks = new Map<string, DiscoveryRead<NodeExecutable>>()
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function batchArgument(value: string, doubleEscape: boolean): string {
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`.replace(CMD_META, '^$1')
  return doubleEscape ? quoted.replace(CMD_META, '^$1') : quoted
}

/** Node ≥18 拒绝直接 spawn Windows 批处理 shim（EINVAL）：与 acpx 同款经 cmd.exe /d /s /c 包装。
 * 持久 stdio（connection-probe）与 execFile（run()）共用同一条包装策略。 */
export function batchShell(executable: string, args: string[]): { target: string; argv: string[]; batch: boolean } {
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
  const target = batch ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe') : executable
  const doubleEscape = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i.test(executable)
  const command = batch ? [executable.replace(CMD_META, '^$1'), ...args.map(value => batchArgument(value, doubleEscape))].join(' ') : ''
  const argv = batch ? ['/d', '/s', '/c', `"${command}"`] : args
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

async function externalNode({ sqlite = false, npm = false }: { sqlite?: boolean; npm?: boolean } = {}): Promise<NodeRuntime> {
  return externalNodeFor(getSettings().acp, { sqlite, npm })
}

async function externalNodeFor(settings: Settings['acp'], { sqlite = false, npm = false, discoveryRefresh }: { sqlite?: boolean; npm?: boolean; discoveryRefresh?: boolean } = {}): Promise<NodeRuntime> {
  return resolveNodeRuntime({
    explicitPath: settings?.nodePath,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    pathNode: findExecutable(process.platform === 'win32' ? 'node.exe' : 'node'),
    sqlite,
    validate: discoveryRefresh === undefined ? undefined : (path, options = {}) => {
      const file = statSync(path, { bigint: true })
      const key = JSON.stringify([path, realpathSync.native(path), options.sqlite === true,
        ...[file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs, file.birthtimeNs].map(String),
        process.env.PATH ?? process.env.Path, process.env.SystemRoot])
      return cachedDiscoveryRead(inventoryNodeChecks, key, discoveryRefresh, () => validateNodeExecutable(path, options))
    },
    accepts: npm ? path => !!npmCliFor(path) : undefined
  })
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
  return runtimeDefinitionsFor(getSettings().acp)
}

/** A provenance-free old snapshot cannot be attributed to a builtin when that ID was overridden. */
export function isRuntimeSnapshotAvailable(config: AcpAgentConfig): boolean {
  return isSupportedRuntimeSnapshot(config) && (config.launchKind !== undefined
    || !getSettings().acp?.agents?.some(item => item.id === config.id))
}

function runtimeDefinitionsFor(settings: Settings['acp']): AcpAgentConfig[] {
  const overrides = settings?.agents ?? []
  const items: AcpAgentConfig[] = [
    piRuntimeDefinition,
    ...Object.entries(BUILTINS).map(([id, spec]) => ({ id, name: spec.name, command: `${spec.packageName}@${spec.version}`, enabled: true, launchKind: 'managed' as const })),
    ...Object.entries(NATIVES).map(([id, spec]) => ({ id, name: spec.name, command: [spec.commandName, ...spec.launchArgs].join(' '), enabled: true, launchKind: 'native' as const })),
    ...Object.entries(BUNDLED).map(([id, spec]) => ({ id, name: spec.name, command: 'bundled ACP bridge（随应用提供）', enabled: true, launchKind: 'bundled' as const }))
  ]
  for (const config of overrides) {
    // Retire only the old auto-generated diagnostic fixture, including saved copies.
    if (config.id === 'mock' && config.name === '诊断 Mock（开发专用）' && config.command === 'diagnostic fixture'
      && config.args?.length === 2 && config.args[1] === '--serve'
      && /[\\/]scripts[\\/]smoke[\\/]acp-mock-agent\.mjs$/i.test(config.args[0])) continue
    const index = items.findIndex((item) => item.id === config.id)
    // Keep a disabled identity marker so a legacy override cannot resolve to a same-ID builtin.
    const custom = { ...config, launchKind: 'custom' as const }
    if (index >= 0) items[index] = custom
    else items.push(custom)
  }
  let localProviders: AcpAgentConfig[] = []
  try { localProviders = listLocalProviders().map(provider => ({
    id: provider.id, name: provider.name, command: `${provider.agentId} · ${provider.name}`, enabled: provider.enabled,
    launchKind: 'local' as const, executable: provider.executable, args: [...provider.argv], env: structuredClone(provider.env)
  })) }
  catch { /* Keep built-in engine availability independent of provider-store corruption. */ }
  for (const provider of localProviders) {
    items.push({
      id: provider.id,
      name: provider.name,
      command: provider.command,
      enabled: provider.enabled,
      launchKind: provider.launchKind,
      executable: provider.executable,
      args: provider.args,
      env: provider.env
    })
  }
  return items
}

/** 宽松读取 CLI --version 输出中的首个版本号形态 token，避免把横幅文案当版本展示。 */
function versionToken(output: string): string | undefined {
  const line = output.split(/\r?\n/).find((entry) => entry.trim().length > 0)
  const token = line?.trim().split(/\s+/).at(-1)?.replace(/^v(?=\d)/, '')
  return token && /^\d[\w.\-+]*$/.test(token) ? token : undefined
}

/** Only inventory metadata is cached. Launch admission always validates its current source. */
async function cachedDiscoveryRead<T>(cache: Map<string, DiscoveryRead<T>>, key: string, refresh: boolean, read: () => Promise<T>): Promise<T> {
  const cached = cache.get(key)
  if (cached && (cached.pending || !refresh && Date.now() - cached.finishedAt < DISCOVERY_METADATA_TTL_MS)) return cached.value
  const entry = { finishedAt: 0, pending: true, value: read() }
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > 64) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  try { return await entry.value }
  catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error }
  finally { entry.finishedAt = Date.now(); entry.pending = false }
}

async function runtimeVersion(source: string, executable: string, args: string[], refresh: boolean): Promise<string | undefined> {
  return cachedDiscoveryRead(runtimeVersions, JSON.stringify([source, executable, args]), refresh,
    () => run(executable, args).then(versionToken, () => undefined))
}

/** R8 检测优先级：nativePaths 手动指定（须为存在的文件）> PATH 自动检测；无效手动路径回退自动检测。 */
function nativeExecutable(id: NativeId): { path: string; manual: boolean } | undefined {
  return nativeExecutableFor(id, getSettings().acp)
}

function nativeExecutableFor(id: NativeId, settings: Settings['acp']): { path: string; manual: boolean } | undefined {
  const manual = settings?.nativePaths?.[id]
  if (manual && isAbsolute(manual) && regularFile(manual)) return { path: manual, manual: true }
  const auto = findExecutable(NATIVES[id].commandName)
  return auto ? { path: auto, manual: false } : undefined
}

function nativeSourceIdentity(config: AcpAgentConfig, settings: Settings['acp'], detected: { path: string } | undefined, node?: NodeRuntime): string {
  return runtimeVerificationIdentity(config, [...(detected ? [detected.path] : []), ...(node ? [node.path] : [])], {
    nativePath: settings?.nativePaths?.[config.id], nodePath: settings?.nodePath
  })
}

/** Registry evidence belongs to the selected executable, Node and package, never just a Runtime ID. */
async function latestNativeVersion(packageName: string, source: string, node: NodeRuntime | undefined, queryRegistry: boolean): Promise<string | undefined> {
  if (!node) return undefined
  const key = JSON.stringify([packageName, node.path, source])
  const cached = latestVersions.get(key)
  if (!queryRegistry) return cached && Date.now() - cached.checkedAt < LATEST_VERSION_TTL_MS ? cached.version : undefined
  let version: string | undefined
  try {
    const npmCli = npmCliFor(node.path)
    if (npmCli) {
      const candidate = await run(node.path, [npmCli, 'view', packageName, 'version'], 8000)
      if (parseReleaseVersion(candidate)) version = candidate
    }
  } catch { /* Registry failure is unknown; do not retain a previous successful result. */ }
  latestVersions.set(key, { checkedAt: Date.now(), version })
  if (latestVersions.size > 64) {
    const oldest = latestVersions.keys().next().value
    if (oldest !== undefined) latestVersions.delete(oldest)
  }
  return version
}

/** bundled 适配器 entry 解析（dev/prod 收敛一处）：dev 直读源码，打包读 electron-builder extraResources 复制产物。 */
export function resolveAdapterEntry(): string | undefined {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'adapters', 'zcode-acp')
    : join(app.getAppPath(), 'adapters', 'zcode-acp')
  const entry = join(base, 'src', 'index.mjs')
  return regularFile(entry) ? entry : undefined
}

/** bundled 条目的内部 CLI 检测：nativePaths 手动指定 > 环境变量 ZCODE_BIN > PATH > 标准安装位置表（复刻 Crux 发现顺序）。 */
export function resolveZcodeExecutable(): { path: string; manual: boolean } | undefined {
  return resolveZcodeExecutableFor(getSettings().acp)
}

function resolveZcodeExecutableFor(settings: Settings['acp']): { path: string; manual: boolean } | undefined {
  const manual = settings?.nativePaths?.zcode
  const manualPath = manual ? resolveZcodeOverride(manual) : undefined
  if (manualPath) return { path: manualPath, manual: true }
  // 环境变量与适配器同款语义（TRELLIS_ZCODE_BIN / ZCODE_BIN）：值指向 zcode.cjs/js 或可执行文件。
  const envBin = process.env.TRELLIS_ZCODE_BIN ?? process.env.ZCODE_BIN
  const envPath = envBin ? resolveZcodeOverride(envBin) : undefined
  if (envPath) return { path: envPath, manual: true }
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

async function probe(queryRegistry: boolean, settings: Settings['acp'], definitions: AcpAgentConfig[]): Promise<AcpAgentStatus[]> {
  let node: NodeRuntime | undefined
  let nodeError = ''
  try { node = await externalNodeFor(settings, { discoveryRefresh: queryRegistry }) } catch (error) { nodeError = errorMessage(error) }
  return Promise.all(definitions.map(async (config): Promise<AcpAgentStatus> => {
    const base = { ...config, runtimeId: config.id, checkedAt: Date.now(), nodePath: node?.path }
    if (!isSupportedRuntimeSnapshot(config)) return { ...base, available: false, health: 'executable_missing', setupRequired: false,
      setupBlockedReason: LEGACY_CUSTOM_RUNTIME_ERROR, diagnostics: [LEGACY_CUSTOM_RUNTIME_ERROR] }
    if (config.launchKind === 'local') {
      return { ...base, available: true, health: 'not_checked', setupRequired: false,
        diagnostics: [`本地 ACP provider：${config.executable}`, '启动、恢复和交接时会重新校验文件身份；连接检查仅发送 initialize'] }
    }
    if (config.id === 'pi' && config.launchKind === 'sdk') {
      const compatible = !!node && Number(node.version.slice(1).split('.')[0]) >= 24 || !!node && /^v22\.(?:19|[2-9]\d)\./.test(node.version)
      return { ...base, available: compatible && piEngineAvailable(), health: !compatible ? 'executable_missing' : !piEngineAvailable() ? 'adapter_missing' : 'not_checked',
        adapterVersion: PI_VERSION, setupRequired: false, diagnostics: [compatible ? `Node ${node?.version}；Pi SDK ${PI_VERSION} 随应用提供` : nodeError || 'Pi 需要 Node >=22.19',
          'Pi 使用原生 SDK 而非 ACP v2；ACP provider 矩阵中保持未验证，不能凭安装状态可用'] }
    }
    if (isManaged(config)) {
      const entry = installedEntry(config.id)
      return { ...base, available: !!node && !!entry, health: !node ? 'executable_missing' : !entry ? 'adapter_missing' : 'not_checked',
        adapterVersion: BUILTINS[config.id].version, setupRequired: !entry,
        diagnostics: [nodeError || `Node ${node?.version}；ACP v2 运行时`, entry ? '适配器已安装；认证和 ACP v2 就绪状态将在启动时验证' : '请显式安装此 Runtime；启动不会自动下载', NATIVE_TOOLS_DIAGNOSTIC] }
    }
    if (isNative(config)) {
      const spec = NATIVES[config.id]
      const manual = settings?.nativePaths?.[config.id]
      const detected = nativeExecutableFor(config.id, settings)
      if (!detected) return { ...base, available: false, health: 'executable_missing', setupRequired: false,
        setupBlockedReason: manual ? '指定路径不可用，请先配置有效路径或清除路径设置' : undefined,
        diagnostics: [...(manual ? [`手动指定的路径不可用（${manual}），且 PATH 自动检测未命中`] : []), spec.missingHint, NATIVE_TOOLS_DIAGNOSTIC] }
      const source = nativeSourceIdentity(config, settings, detected, node)
      const version = await runtimeVersion(source, detected.path, ['--version'], queryRegistry)
      if (source !== nativeSourceIdentity(config, settings, nativeExecutableFor(config.id, settings), node)) {
        return { ...base, available: true, health: 'not_checked', setupRequired: false, updateStatus: 'unknown',
          setupBlockedReason: '程序路径或文件已变化，请重新探测', diagnostics: ['程序路径或文件已变化，请重新探测', NATIVE_TOOLS_DIAGNOSTIC] }
      }
      if (config.id === 'opencode') return { ...base, available: false, health: 'incompatible', setupRequired: false,
        adapterVersion: version, setupBlockedReason: 'OpenCode 2.3.2 的 ACP server 返回 v1，不能用于 ACP v2；其 HTTP v2 API 是另一个 provider surface',
        diagnostics: [`${detected.manual ? '手动指定' : '自动检测'}：检测到 OpenCode：${detected.path}`,
          'OpenCode 当前不可用于 ACP v2', NATIVE_TOOLS_DIAGNOSTIC] }
      const candidate = await latestNativeVersion(spec.npmPackage, source, node, queryRegistry)
      const latestVersion = candidate
      const comparison = compareReleaseVersions(version, latestVersion)
      const setupBlockedReason = manual ? '自定义路径的程序请使用原安装方式升级，再重新探测' : !parseReleaseVersion(version)
        ? '无法读取程序版本，请使用原安装方式更新或配置有效路径' : undefined
      return { ...base, available: true, health: 'not_checked', setupRequired: false, adapterVersion: version, latestVersion,
        updateStatus: comparison === undefined ? 'unknown' : comparison < 0 ? 'available' : comparison === 0 ? 'current' : 'ahead',
        setupBlockedReason,
        diagnostics: [`${detected.manual ? '手动指定' : '自动检测'}：检测到 ${spec.name}：${detected.path}；协议与登录状态将在连接时验证`,
          ...(manual && !detected.manual ? ['手动指定路径无效，已回退 PATH 自动检测'] : []),
          ...(setupBlockedReason ? [setupBlockedReason] : []), NATIVE_TOOLS_DIAGNOSTIC] }
    }
    if (isBundled(config)) {
      const entry = resolveAdapterEntry()
      const manual = settings?.nativePaths?.zcode
      const detected = resolveZcodeExecutableFor(settings)
      let zcodeNode: NodeRuntime | undefined
      let zcodeNodeError = ''
      try { zcodeNode = await externalNodeFor(settings, { sqlite: true, discoveryRefresh: queryRegistry }) } catch (error) { zcodeNodeError = errorMessage(error) }
      let version: string | undefined
      if (detected && zcodeNode) {
        // zcode.cjs 需要 node 加载；PATH 命中的 shim 走既有批处理包装。版本失败不改变可用性。
        try {
          const cjs = /\.(?:cjs|mjs|js)$/i.test(detected.path)
          const source = nativeSourceIdentity(config, settings, detected, zcodeNode)
          version = await runtimeVersion(source, cjs ? zcodeNode.path : detected.path, cjs ? [detected.path, '--version'] : ['--version'], queryRegistry)
          if (source !== nativeSourceIdentity(config, settings, resolveZcodeExecutableFor(settings), zcodeNode)) version = undefined
        } catch { /* 版本留空即"未知" */ }
      }
      const entryLine = entry ? `内置适配器就绪：${entry}` : '内置适配器文件缺失，请重新安装应用'
      const cliLine = detected
        ? `${detected.manual ? '手动指定' : '自动检测'}：ZCode CLI：${detected.path}${version ? `（v${version}）` : ''}；协议与登录状态将在连接时验证`
        : manual
          ? `手动指定的 zcode 路径不可用（${manual}），且环境变量、PATH 与标准安装位置均未检测到 ZCode CLI`
          : '未检测到 ZCode，请选择官方 ZCode 的安装目录'
      const safeLine = settings?.zcode?.enableAutomationTools === true
        ? '自动化计划工具（Cron*）已按设置放行'
        : '安全默认：自动化计划工具（Cron*）已禁用'
      return { ...base, nodePath: zcodeNode?.path, available: !!entry && !!detected && !!zcodeNode,
        health: !entry ? 'adapter_missing' : !zcodeNode || !detected ? 'executable_missing' : 'not_checked',
        setupRequired: false, adapterVersion: version,
        diagnostics: [entryLine, cliLine, zcodeNode ? `Node ${zcodeNode.version}（${zcodeNode.source === 'managed' ? '随应用提供' : zcodeNode.source === 'explicit' ? '自定义路径' : 'PATH 自动检测'}）` : zcodeNodeError, safeLine,
          ...(manual && detected && !detected.manual ? ['手动指定路径无效，已回退自动检测'] : []), NATIVE_TOOLS_DIAGNOSTIC].filter((line) => line.length > 0) }
    }
    return { ...base, available: false, health: 'executable_missing', setupRequired: false, diagnostics: [LEGACY_CUSTOM_RUNTIME_ERROR] }
  }))
}

export async function listAcpAgents(refresh = false): Promise<{ ok: true; agents: AcpAgentStatus[] }> {
  const settings = structuredClone(getSettings().acp)
  const definitions = runtimeDefinitionsFor(settings)
  const discoveryIdentity = JSON.stringify({ definitions, nodePath: settings?.nodePath, nativePaths: settings?.nativePaths, zcode: settings?.zcode, runtimeDefaults: settings?.runtimeDefaults })
  const sameInventory = lastDiscoveryIdentity === discoveryIdentity
  if (refresh && sameInventory && probeInFlight && !probeQueriesRegistry) {
    await probeInFlight
    return listAcpAgents(true)
  }
  if (!lastProbe || !sameInventory || !probeInFlight && (refresh || Date.now() - inventoryFinishedAt >= LOCAL_INVENTORY_TTL_MS)) {
    lastDiscoveryIdentity = discoveryIdentity
    const request = probe(refresh, settings, definitions).then((agents) => {
      if (lastProbe === request) inventoryFinishedAt = Date.now()
      return agents
    }).catch((error) => { if (lastProbe === request) lastProbe = undefined; throw error }).finally(() => {
      if (probeInFlight === request) probeInFlight = undefined
    })
    lastProbe = request
    probeInFlight = request
    probeQueriesRegistry = refresh
  }
  const agents = await lastProbe
  const currentDiscoveryIdentity = (): string => {
    const current = getSettings().acp
    return JSON.stringify({ definitions: runtimeDefinitions(), nodePath: current?.nodePath, nativePaths: current?.nativePaths, zcode: current?.zcode, runtimeDefaults: current?.runtimeDefaults })
  }
  if (currentDiscoveryIdentity() !== discoveryIdentity) return listAcpAgents(refresh)
  const verified = await Promise.all(agents.map(async agent => {
    if (!isSupportedRuntimeSnapshot(agent) || !hasRuntimeVerification(agent.id)) return agent
    const current = definitions.find(config => config.id === agent.id)
    if (!current) return agent
    const launch = await runtimeLaunchSnapshot(current)
    if (currentDiscoveryIdentity() !== discoveryIdentity) return agent
    return applyRuntimeVerification(agent, launch.identity)
  }))
  if (currentDiscoveryIdentity() !== discoveryIdentity) return listAcpAgents(refresh)
  return { ok: true, agents: verified }
}

/** Capture the exact argv used by an explicit connection test, including failed resolution. */
export async function runtimeLaunchSnapshot(config: AcpAgentConfig): Promise<{ identity: string; argv?: string[]; env?: Record<string, string>; error?: string }> {
  const settings = getSettings().acp
  const selection = { nodePath: settings?.nodePath, nativePath: settings?.nativePaths?.[config.id],
    runtimeDefaults: settings?.runtimeDefaults?.[config.id],
    enableAutomationTools: config.launchKind === 'bundled' ? settings?.zcode?.enableAutomationTools === true : undefined }
  try {
    const defaults = resolveAcpLaunchOptions(selection.runtimeDefaults, undefined, process.platform)
    if (config.launchKind === 'sdk' && defaults.args?.length) throw new Error('Pi SDK 不支持额外启动参数；请清除执行引擎的参数后重试')
    const argv = [...await launchArgv(config), ...acpExtraArgv(defaults)]
    const env = { ...acpLaunchEnvironment(config, defaults, process.platform), ...(config.launchKind === 'local' ? localProviderLaunchEnvironment(config) : {}) }
    const localSelection = config.launchKind === 'local' ? { ...selection, localProviderEnv: env } : selection
    return { identity: runtimeVerificationIdentity(config, argv, localSelection), argv, env }
  } catch (error) {
    return { identity: runtimeVerificationIdentity(config, undefined, selection), error: errorMessage(error) }
  }
}

/** Fresh selected-runtime admission. Full discovery/version queries belong to Settings,
 * not session startup. Native readiness/authentication still belongs to acpx/the adapter. */
export async function resolveAcpRuntimeLaunch(id: string): Promise<{ config: AcpAgentConfig; argv: string[] } | IpcFail> {
  const config = runtimeDefinitions().find((item) => item.id === id)
  if (config && !isSupportedRuntimeSnapshot(config)) return ipcFail(IpcErrorCode.Unavailable, LEGACY_CUSTOM_RUNTIME_ERROR)
  if (!config?.enabled) return ipcFail(IpcErrorCode.InvalidArg, 'Runtime 未启用或不可用')
  try {
    const argv = await launchArgv(config)
    if (config.launchKind !== 'sdk') {
      const launch = await runtimeLaunchSnapshot(config)
      const evidence = launch.argv === undefined || launch.error !== undefined ? undefined : runtimeVerificationEvidenceForLaunch(id, launch.identity)
      if (evidence?.ok !== true || evidence.protocolVersion !== 2) {
        return ipcFail(IpcErrorCode.Unavailable, 'Runtime 尚未通过 ACP v2 initialize 验证；请先测试连接，注册表或安装状态不能替代握手证据')
      }
    }
    return { config, argv }
  }
  catch (error) { return ipcFail(IpcErrorCode.InvalidArg, errorMessage(error)) }
}

export function runtimeProcessEnv(config: AcpAgentConfig, options: AcpRuntimeDefaults): Record<string, string> {
  return config.launchKind === 'local'
    ? { ...acpProcessEnv(options, process.platform), ...localProviderLaunchEnvironment(config) }
    : acpLaunchEnvironment(config, options, process.platform)
}

export async function launchArgv(config: AcpAgentConfig): Promise<string[]> {
  if (!isRuntimeSnapshotAvailable(config)) throw new Error(LEGACY_CUSTOM_RUNTIME_ERROR)
  if (config.id === 'pi' && config.launchKind === 'sdk') {
    const node = await externalNode()
    const [major, minor] = node.version.slice(1).split('.').map(Number)
    if (major < 22 || major === 22 && minor < 19) throw new Error('Pi SDK 需要 Node >=22.19')
    if (!piEngineAvailable()) throw new Error('Pi 引擎入口缺失，请重新构建或安装应用')
    return [node.path, piEngineEntry()]
  }
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
    const node = await externalNode({ sqlite: true })
    const entry = resolveAdapterEntry()
    if (!entry) throw new Error('内置适配器文件缺失，请重新安装应用')
    const zcode = resolveZcodeExecutable()
    if (!zcode) throw new Error('未检测到 ZCode，请在设置中选择官方 ZCode 的安装目录')
    // 显式传参免 PATH 依赖。默认真实用户态（不传 --isolated）：模型目录与登录态复用本机
    // ~/.zcode（2026-10-22 用户决策）；隔离是适配器 --isolated 显式可选项，测试/诊断用。
    // translate.ts 依赖 Node 类型剥离：22.13–22.17 需显式旗标，22.18+ 冗余无害。
    return [node.path, '--experimental-strip-types', entry, '--zcode-bin', zcode.path,
      ...(bundledAutomationAllowed() ? ['--enable-automation-tools'] : [])]
  }
  if (config.launchKind === 'local') {
    const provider = resolveAdmittedLocalProvider(config.id)
    return [provider.executable, ...provider.argv]
  }
  throw new Error(LEGACY_CUSTOM_RUNTIME_ERROR)
}

/** npm 安装失败时保留原始 stderr 摘要，便于区分网络/权限/包名问题。 */
function stderrTail(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? (error as { stderr?: unknown }).stderr : undefined
  const text = typeof stderr === 'string' ? stderr.trim() : ''
  return text ? `：${text.slice(-600)}` : ''
}

function sameExecutable(left: string, right: string): boolean {
  const canonical = (path: string): string => {
    let value = normalize(path)
    try { value = realpathSync.native(path) } catch { /* Missing installation target remains a lexical path. */ }
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  return canonical(left) === canonical(right)
}

async function setupNativeRuntime(config: AcpAgentConfig & { id: NativeId }, settings: Settings['acp'], node: NodeRuntime, npmCli: string): Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail> {
  const spec = NATIVES[config.id]
  const detected = nativeExecutableFor(config.id, settings)
  if (settings?.nativePaths?.[config.id]) return ipcFail(IpcErrorCode.InvalidArg, '已配置程序路径，请使用原安装方式升级，再重新探测')
  const source = nativeSourceIdentity(config, settings, detected, node)
  let version: string | undefined
  if (detected) {
    try { version = versionToken(await run(detected.path, ['--version'])) } catch { /* Unknown version must not choose a package. */ }
    if (!parseReleaseVersion(version)) return ipcFail(IpcErrorCode.InvalidArg, '无法读取当前程序版本，未安装任何软件包；请配置有效路径或使用原安装方式更新')
  }
  const release = config.id === 'opencode' ? detected ? openCodeRelease(version) : { packageName: OPENCODE_V2_PACKAGE, major: 2 } : undefined
  if (config.id === 'opencode' && !release) return ipcFail(IpcErrorCode.InvalidArg, '此 OpenCode 主版本尚无受支持的更新通道，请使用官方安装方式')
  const packageName = release?.packageName ?? spec.npmPackage
  const prefix = await run(node.path, [npmCli, 'prefix', '-g'], 8000)
  if (!isAbsolute(prefix)) return ipcFail(IpcErrorCode.InvalidArg, '无法确认 npm 全局安装目录，未安装任何软件包')
  const binDirectory = process.platform === 'win32' ? prefix : join(prefix, 'bin')
  const targets = (process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']).map(suffix => join(binDirectory, `${spec.commandName}${suffix}`))
  if (detected && !targets.some(target => sameExecutable(detected.path, target))) {
    return ipcFail(IpcErrorCode.InvalidArg, `当前 ${spec.name} 不属于所选 npm 的全局安装目录，请使用原安装方式升级或配置路径`)
  }
  // Resolve and pin this exact release after reading the selected CLI. A moved latest tag
  // must not cross a major version or downgrade an installation ahead of the registry.
  const latest = await latestNativeVersion(packageName, source, node, true)
  if (!latest) return ipcFail(IpcErrorCode.Io, '无法读取更新版本，未安装任何软件包；请重新探测后重试')
  if (release && parseReleaseVersion(latest)?.major !== release.major) return ipcFail(IpcErrorCode.InvalidArg, '注册表版本与当前 OpenCode 主版本不一致，请查看官方迁移指南')
  if ((compareReleaseVersions(version, latest) ?? 0) > 0) return ipcFail(IpcErrorCode.InvalidArg, '当前版本高于注册表版本，未执行降级')
  if (detected) {
    let currentVersion: string | undefined
    try { currentVersion = versionToken(await run(detected.path, ['--version'])) } catch { /* Source drift fails before installation. */ }
    if (compareReleaseVersions(currentVersion, version) !== 0) return ipcFail(IpcErrorCode.Conflict, '当前程序版本已变化，未安装任何软件包；请重新探测')
  }
  const current = runtimeDefinitions().find(item => item.id === config.id)
  const currentSettings = getSettings().acp
  if (!current || !isNative(current) || source !== nativeSourceIdentity(current, currentSettings, nativeExecutableFor(config.id, currentSettings), node)) {
    return ipcFail(IpcErrorCode.Conflict, '程序或路径设置已变化，未安装任何软件包；请重新探测')
  }
  const exactVersion = config.id === 'opencode' ? spec.version : latest
  await run(node.path, [npmCli, 'install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', `${packageName}@${exactVersion}`], 600000)
  const afterSettings = getSettings().acp
  const afterConfig = runtimeDefinitions().find(item => item.id === config.id)
  const after = nativeExecutableFor(config.id, afterSettings)
  if (!afterConfig || !isNative(afterConfig) || JSON.stringify(afterConfig) !== JSON.stringify(config)
    || afterSettings?.nodePath !== settings?.nodePath || afterSettings?.nativePaths?.[config.id] !== settings?.nativePaths?.[config.id]
    || !after || detected && !sameExecutable(after.path, detected.path) || !targets.some(target => sameExecutable(after.path, target))) {
    return ipcFail(IpcErrorCode.Conflict, 'npm 安装已结束，但当前程序来源已变化，请重新探测并核对路径')
  }
  let installedVersion: string | undefined
  try { installedVersion = versionToken(await run(after.path, ['--version'])) } catch { /* Report unverified installation below. */ }
  if (compareReleaseVersions(installedVersion, exactVersion) !== 0) return ipcFail(IpcErrorCode.Io, 'npm 安装已结束，但当前程序版本未匹配安装结果，请使用原安装方式更新并核对路径')
  return listAcpAgents(true)
}

export async function setupAcpRuntime(id: string): Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail> {
  const settings = structuredClone(getSettings().acp)
  const config = runtimeDefinitionsFor(settings).find(item => item.id === id)
  if (config && !isSupportedRuntimeSnapshot(config)) return ipcFail(IpcErrorCode.Unavailable, LEGACY_CUSTOM_RUNTIME_ERROR)
  if (config?.launchKind === 'sdk') return listAcpAgents(true)
  if (Object.hasOwn(BUNDLED, id)) return ipcFail(IpcErrorCode.InvalidArg, '内置 Runtime 随应用提供，无需安装')
  const native = Object.hasOwn(NATIVES, id)
  if (native && id === 'opencode') return ipcFail(IpcErrorCode.Unavailable, 'OpenCode 2.3.2 的 ACP server 返回 v1，不能作为 ACP v2 provider')
  if (!Object.hasOwn(BUILTINS, id) && !native) return ipcFail(IpcErrorCode.InvalidArg, '执行引擎不存在或不可安装')
  if (!config || native && !isNative(config) || !native && !isManaged(config)) return ipcFail(IpcErrorCode.InvalidArg, '执行引擎不可安装')
  const pending = setups.get(id)
  if (pending) return pending
  const task = (async (): Promise<{ ok: true; agents: AcpAgentStatus[] } | IpcFail> => {
    try {
      const node = await externalNodeFor(settings, { npm: true })
      const npmCli = npmCliFor(node.path)
      if (!npmCli) return ipcFail(IpcErrorCode.NotFound, '选定 Node 旁未找到 npm-cli.js，请选择包含 npm 的 Node 安装')
      if (isNative(config)) return await setupNativeRuntime(config, settings, node, npmCli)
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
  try {
    await validateNodeExecutable(nodePath)
  } catch (error) {
    return ipcFail(IpcErrorCode.InvalidArg, errorMessage(error))
  }
  await write({ acp: { ...previous, nodePath } })
  try {
    return { ...await listAcpAgents(true), nodePath }
  } catch (error) {
    await write({ acp: previous })
    return ipcFail(IpcErrorCode.InvalidArg, errorMessage(error))
  }
}

/** ZCode selects its installation directory; other native CLIs retain file selection. */
export async function pickAcpRuntimePath(id: string, write: AcpSettingsWriter = localSettingsWriter): Promise<{ ok: true; cancelled?: boolean; agents?: AcpAgentStatus[] } | IpcFail> {
  const config = runtimeDefinitions().find(item => item.id === id)
  if (config && !isSupportedRuntimeSnapshot(config)) return ipcFail(IpcErrorCode.Unavailable, LEGACY_CUSTOM_RUNTIME_ERROR)
  const native = Object.hasOwn(NATIVES, id)
  const spec = native ? NATIVES[id as NativeId] : Object.hasOwn(BUNDLED, id) ? BUNDLED[id as BundledId] : undefined
  if (!spec) return ipcFail(IpcErrorCode.InvalidArg, '仅原生直连与内置 Runtime 支持配置 CLI 路径')
  const selection = await dialog.showOpenDialog({ title: native ? `选择 ${spec.name} 可执行文件` : `选择 ${spec.name} 安装目录`, properties: native ? ['openFile'] : ['openDirectory'] })
  const selected = selection.filePaths[0]
  if (selection.canceled || !selected) return { ok: true, cancelled: true }
  let selectedPath = selected
  let cliToPrepare: string | undefined
  if (native) {
    if (!isAbsolute(selected) || !regularFile(selected)) return ipcFail(IpcErrorCode.InvalidArg, '所选路径不是可执行文件，未保存')
  } else {
    try {
      const installation = resolveZcodeInstallation(selected)
      selectedPath = installation.installationRoot
      cliToPrepare = installation.cliPath
    }
    catch (error) { return ipcFail(IpcErrorCode.InvalidArg, errorMessage(error)) }
  }
  const previous = getSettings().acp
  await write({ acp: { ...previous, nativePaths: { ...previous?.nativePaths, [id]: selectedPath } } })
  if (cliToPrepare) {
    // A preparation failure never invalidates an otherwise valid installation.
    // The startup service owns bounded diagnostics and the official-entry fallback.
    try {
      const node = await externalNode({ sqlite: true })
      await prepareBundledZcodeStartup(node.path, cliToPrepare)
    } catch { /* Missing runtime/preparation failures remain visible in discovery. */ }
  }
  try {
    return await listAcpAgents(true)
  } catch (error) {
    await write({ acp: previous })
    return ipcFail(IpcErrorCode.Io, `状态刷新失败，已还原路径设置：${errorMessage(error)}`)
  }
}
