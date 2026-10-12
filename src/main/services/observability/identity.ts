import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

/**
 * 绑定身份层（design §3.1/§4.1，S0 G3 第一片）：
 * - installationId 持久化在仓库外（Windows 首发 %LOCALAPPDATA%/TrellisPanel/），
 *   普通升级保持不变；Hook 按相同固定规则读取（本模块的读取函数即该规则；
 *   Hook 侧接入属 G1-C，不在本片改造）。
 * - binding.json 原子替换写入 root 的私有 runtime 目录；installationId 不符或
 *   canonical root 不符 → 停止采集并要求重新绑定，不删除数据。
 * - repositoryId 是本机绑定组 ID：只有已验证的 Git common dir 关系才归为同组
 *   （登记表存于安装目录，不凭 remote URL 跨设备合并）；非 Git 仓库允许绑定，
 *   记录无 git 信息且不归组。
 * 诊断与错误文本不包含原始上下文；本文件自身写在仓库外/私有 runtime，绝对路径
 * 不进入观测事件或共享面。
 */

export const INSTALLATION_DIR_NAME = 'TrellisPanel'
export const INSTALLATION_FILE_NAME = 'installation.json'
export const REPOSITORY_REGISTRY_FILE_NAME = 'repository-registry.json'
export const BINDING_FILE_NAME = 'binding.json'

export interface InstallationIdentity {
  installationId: string
  createdAtMs: number
}

/** 安装目录（Windows 首发 %LOCALAPPDATA%；其余平台回退 XDG 风格，仅本机使用）。 */
export function installationDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share')
  return join(base, INSTALLATION_DIR_NAME)
}

/**
 * Hook 同款固定规则读取：只读该文件，缺失/结构非法返回 null；
 * 不自动创建、不接受仓库内容提供任意路径。
 */
export function readInstallationIdentity(dir = installationDir()): InstallationIdentity | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, INSTALLATION_FILE_NAME), 'utf-8'))
    if (
      typeof raw === 'object' &&
      raw !== null &&
      typeof raw.installationId === 'string' &&
      raw.installationId.length >= 8 &&
      Number.isFinite(raw.createdAtMs)
    ) {
      return { installationId: raw.installationId, createdAtMs: raw.createdAtMs }
    }
    return null
  } catch {
    return null
  }
}

/** Panel 侧确保安装身份存在：缺失才生成（随机 UUID），普通升级不动既有文件。 */
export function ensureInstallationIdentity(dir = installationDir()): InstallationIdentity {
  const existing = readInstallationIdentity(dir)
  if (existing !== null) return existing
  const fresh: InstallationIdentity = { installationId: randomUUID(), createdAtMs: Date.now() }
  mkdirSync(dir, { recursive: true })
  atomicWriteJson(join(dir, INSTALLATION_FILE_NAME), fresh)
  return fresh
}

/* ---------------- 原子写（同目录临时文件 + rename） ---------------- */

export function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = join(dirname(filePath), `.${basenameOf(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8')
  renameSync(tmp, filePath)
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/* ---------------- repositoryId（本机绑定组） ---------------- */

interface RepositoryRegistry {
  schemaVersion: 1
  /** canonical gitCommonDir → repositoryId（仅本机分组依据）。 */
  groups: Record<string, string>
}

function readRepositoryRegistry(dir: string): RepositoryRegistry {
  try {
    const raw = JSON.parse(readFileSync(join(dir, REPOSITORY_REGISTRY_FILE_NAME), 'utf-8'))
    if (typeof raw === 'object' && raw !== null && typeof raw.groups === 'object' && raw.groups !== null) {
      return { schemaVersion: 1, groups: raw.groups as Record<string, string> }
    }
  } catch {
    /* 缺失/坏文件按空表处理（重建映射，不影响既有绑定文件） */
  }
  return { schemaVersion: 1, groups: {} }
}

/**
 * 解析本机绑定组 ID：有已验证 git common dir → 查/建登记表条目（同组稳定）；
 * 非 Git → 每次绑定独立新 ID（不归组）。
 */
function resolveRepositoryId(dir: string, gitCommonDir: string | null): string {
  if (gitCommonDir === null) return `repo-${randomUUID()}`
  const registry = readRepositoryRegistry(dir)
  const existing = registry.groups[gitCommonDir]
  if (typeof existing === 'string' && existing.length > 0) return existing
  const id = `repo-${randomUUID()}`
  registry.groups[gitCommonDir] = id
  atomicWriteJson(join(dir, REPOSITORY_REGISTRY_FILE_NAME), registry)
  return id
}

/* ---------------- git 事实（绑定一次性探测） ---------------- */

export interface GitBindingFacts {
  gitCommonDir: string | null
  worktreeRoot: string | null
}

/** 绑定时一次性同步探测 git 事实（5s 预算；非仓库/失败 → null，不猜）。 */
export function gitFactsForRoot(root: string): GitBindingFacts {
  const run = (args: string[]): string | null => {
    try {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8', timeout: 5000, windowsHide: true })
      if (r.status !== 0 || r.error) return null
      const out = String(r.stdout ?? '').trim()
      return out.length > 0 ? out : null
    } catch {
      return null
    }
  }
  const commonRaw = run(['rev-parse', '--git-common-dir'])
  if (commonRaw === null) return { gitCommonDir: null, worktreeRoot: null }
  const gitCommonDir = resolve(root, commonRaw)
  const topRaw = run(['rev-parse', '--show-toplevel'])
  const worktreeRoot = topRaw !== null ? resolve(topRaw) : resolve(root)
  return { gitCommonDir, worktreeRoot }
}

/* ---------------- binding.json ---------------- */

export interface PanelBinding {
  schemaVersion: 1
  installationId: string
  repositoryId: string
  workspaceId: string
  canonicalRoot: string
  gitCommonDir: string | null
  worktreeRoot: string | null
  boundAtMs: number
  collectionEnabled: boolean
}

export function bindingFilePath(runtimeDir: string): string {
  return join(runtimeDir, BINDING_FILE_NAME)
}

/** Hook/主进程共用的固定规则读取：缺失/非法 → null（不创建、不修复）。 */
export function readBinding(runtimeDir: string): PanelBinding | null {
  try {
    const raw = JSON.parse(readFileSync(bindingFilePath(runtimeDir), 'utf-8'))
    if (
      typeof raw === 'object' &&
      raw !== null &&
      typeof raw.installationId === 'string' &&
      typeof raw.repositoryId === 'string' &&
      typeof raw.workspaceId === 'string' &&
      typeof raw.canonicalRoot === 'string' &&
      raw.canonicalRoot.length > 0 &&
      Number.isFinite(raw.boundAtMs) &&
      typeof raw.collectionEnabled === 'boolean'
    ) {
      return {
        schemaVersion: 1,
        installationId: raw.installationId,
        repositoryId: raw.repositoryId,
        workspaceId: raw.workspaceId,
        canonicalRoot: raw.canonicalRoot,
        gitCommonDir: typeof raw.gitCommonDir === 'string' ? raw.gitCommonDir : null,
        worktreeRoot: typeof raw.worktreeRoot === 'string' ? raw.worktreeRoot : null,
        boundAtMs: raw.boundAtMs,
        collectionEnabled: raw.collectionEnabled
      }
    }
    return null
  } catch {
    return null
  }
}

export type BindingVerification =
  | { status: 'bound'; binding: PanelBinding; created: boolean }
  | {
      /** installationId/canonical root 不符或绑定文件坏：停止采集并要求重新绑定；数据保留。 */
      status: 'rebind_required'
      reason: 'installation_mismatch' | 'root_mismatch' | 'malformed'
      detail: string
    }

/** Windows 盘符/大小写不敏感比较 canonical root（双方都过 realpath 后仍有盘符大小写差异可能）。 */
export function sameRoot(a: string, b: string): boolean {
  if (a === b) return true
  if (process.platform === 'win32') {
    const na = a.replace(/[\\/]+/g, '\\').toLowerCase()
    const nb = b.replace(/[\\/]+/g, '\\').toLowerCase()
    return na === nb || na === nb + '\\' || nb === na + '\\'
  }
  return false
}

function canonicalRootOf(root: string): string {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}

/**
 * 首次显式绑定或校验既有绑定（design §3.1）。
 * - 无绑定文件：生成 workspaceId/repositoryId 并原子写入。
 * - 有绑定文件：installationId/canonical root 任一不符 → rebind_required（不删数据）。
 * - rebind=true：用户显式确认迁移后强制覆盖（重新绑定）。
 */
export function createOrVerifyBinding(options: {
  runtimeDir: string
  root: string
  installation: InstallationIdentity
  /** 用户显式确认的重新绑定（覆盖不符的旧绑定；旧数据仍保留）。 */
  rebind?: boolean
  /** 覆盖安装目录（冒烟用）；缺省 installationDir()。 */
  installDir?: string
  /** 覆盖 git 探测（冒烟用）。 */
  gitFacts?: GitBindingFacts
}): BindingVerification {
  const { runtimeDir, root, installation } = options
  const installDir = options.installDir ?? installationDir()
  const canonicalRoot = canonicalRootOf(root)
  const existing = readBinding(runtimeDir)

  if (existing !== null) {
    const installationOk = existing.installationId === installation.installationId
    const rootOk = sameRoot(existing.canonicalRoot, canonicalRoot)
    if (installationOk && rootOk) {
      return { status: 'bound', binding: existing, created: false }
    }
    if (options.rebind === true) {
      // 显式确认迁移：覆盖绑定（旧数据不删，等待用户后续处理）
      const fresh = buildFreshBinding(installDir, canonicalRoot, installation, options.gitFacts)
      atomicWriteJson(bindingFilePath(runtimeDir), fresh)
      return { status: 'bound', binding: fresh, created: false }
    }
    const reason = !installationOk ? 'installation_mismatch' : 'root_mismatch'
    const detail = !installationOk
      ? '本机安装身份与绑定记录不符（可能复制自其他机器或安装身份被重置）'
      : '仓库 canonical root 与绑定记录不符（可能目录被移动/重挂载）'
    return { status: 'rebind_required', reason, detail }
  }

  // 绑定文件缺失但内容损坏残留（parse 失败 readBinding 返回 null）也允许直接新建
  const fresh = buildFreshBinding(installDir, canonicalRoot, installation, options.gitFacts)
  atomicWriteJson(bindingFilePath(runtimeDir), fresh)
  return { status: 'bound', binding: fresh, created: true }
}

function buildFreshBinding(
  installDir: string,
  canonicalRoot: string,
  installation: InstallationIdentity,
  gitFactsOverride?: GitBindingFacts
): PanelBinding {
  const facts = gitFactsOverride ?? gitFactsForRoot(canonicalRoot)
  return {
    schemaVersion: 1,
    installationId: installation.installationId,
    repositoryId: resolveRepositoryId(installDir, facts.gitCommonDir),
    workspaceId: `ws-${randomUUID()}`,
    canonicalRoot,
    gitCommonDir: facts.gitCommonDir,
    worktreeRoot: facts.worktreeRoot,
    boundAtMs: Date.now(),
    collectionEnabled: true
  }
}

/** 显式启用/停用采集（写 binding.collectionEnabled；停用立即影响后续写入）。 */
export function setCollectionEnabled(runtimeDir: string, enabled: boolean): PanelBinding | null {
  const existing = readBinding(runtimeDir)
  if (existing === null) return null
  const next: PanelBinding = { ...existing, collectionEnabled: enabled }
  atomicWriteJson(bindingFilePath(runtimeDir), next)
  return next
}

/** runtime 目录的物理体积（库+sidecar 固定文件 stat，不扫目录）。 */
export function statFixedFileBytes(paths: string[]): number {
  let total = 0
  for (const p of paths) {
    try {
      const st = statSync(p)
      if (st.isFile()) total += st.size
    } catch {
      /* 缺失不计 */
    }
  }
  return total
}

/** runtime 目录（<root>/.trellis/.panel/runtime；不存在则创建）。 */
export function ensureRuntimeDir(root: string): string {
  const dir = join(canonicalRootOf(root), '.trellis', '.panel', 'runtime')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
