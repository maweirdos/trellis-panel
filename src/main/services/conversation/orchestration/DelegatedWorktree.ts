import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { workcopyIdentitySchema, type WorkcopyIdentity } from '../../../../shared/workcopy-use'
import { DaemonError } from '../../../daemon/errors'
import { readBounded, writeExclusiveAtomic } from '../../../daemon/files'
import { resolveWorkcopy } from '../../workcopy-use/identity'
import { recoverDaemonWorkcopyCommand, runFreshDaemonWorkcopyCommand, type NativeWorkcopyCommandResult } from '../../workcopy-use/native-command'
import type { WorkcopyUseRegistry } from '../../workcopy-use/registry'

const operationIdSchema = z.string().min(1).max(200)
const pathSchema = z.string().min(1).max(4096)
export const delegatedWorktreeBindingSchema = z.strictObject({
  version: z.literal(1),
  operationId: operationIdSchema,
  identity: workcopyIdentitySchema,
  daemonDirectory: pathSchema,
  daemonPhysicalId: pathSchema,
  containerPhysicalId: pathSchema,
})
export type DelegatedWorktreeBinding = z.infer<typeof delegatedWorktreeBindingSchema>
const receiptSchema = z.strictObject({ pinnedParent: workcopyIdentitySchema, binding: delegatedWorktreeBindingSchema })

type PrepareDelegatedWorktree = {
  parentRoot: string
  pinnedParent: WorkcopyIdentity
  operationId: string
  directory: string
  registry: WorkcopyUseRegistry
  signal?: AbortSignal
  assertCurrent(): void
}

const active = new Set<string>()
const repositoryQueues = new Map<string, Promise<void>>()
const gitOptions = [
  '--no-optional-locks',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sparseCheckout=false',
  '-c', 'submodule.recurse=false',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.ext.allow=never',
  '-c', 'maintenance.auto=false',
  '-c', 'gc.auto=0',
]

function pathKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function physicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new DaemonError('E_INVALID_ARG', '委派工作树需要绝对目录。')
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (!stat?.isDirectory() || pathKey(realpathSync.native(path)) !== pathKey(path)) {
    throw new DaemonError('E_CONFLICT', '委派工作树的物理目录不可用或已重定向。')
  }
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

function locations(directory: string, operationId: string) {
  const key = createHash('sha256').update(operationId).digest('hex')
  const container = join(directory, 'conversation-delegated-worktrees')
  return { key, container, destination: join(container, key), receipt: join(container, `${key}.json`) }
}

function inside(parent: string, target: string): boolean {
  const path = relative(parent, target)
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

function observeWorktree(root: string): WorkcopyIdentity {
  const directoryId = physicalDirectory(root)
  const marker = lstatSync(join(root, '.git'), { throwIfNoEntry: false })
  if (!marker?.isDirectory() && !marker?.isFile()) throw new DaemonError('E_CONFLICT', '委派需要实际 Git 工作树根目录。')
  const identity = resolveWorkcopy(root)
  if (!identity.repoRoot || !identity.worktreeGitDir || !identity.gitCommonDir || !identity.commonId ||
    identity.physicalId !== directoryId || pathKey(identity.repoRoot) !== pathKey(root)) {
    throw new DaemonError('E_CONFLICT', '委派工作树的 Git 根或物理身份与原目录不符。')
  }
  physicalDirectory(identity.worktreeGitDir)
  physicalDirectory(identity.gitCommonDir)
  return identity
}

function assertSameCheckout(actual: WorkcopyIdentity, original: WorkcopyIdentity): void {
  if (actual.id !== original.id || actual.physicalId !== original.physicalId || actual.commonId !== original.commonId ||
    actual.canonicalRoot !== original.canonicalRoot || actual.repoRoot !== original.repoRoot ||
    actual.worktreeGitDir !== original.worktreeGitDir || actual.gitCommonDir !== original.gitCommonDir) {
    throw new DaemonError('E_CONFLICT', '原委派工作树、Git 元数据目录或共享仓库已被替换。')
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
  return Object.assign(env, {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  })
}

function assertSafeCheckout(root: string, base: string, env: NodeJS.ProcessEnv): void {
  const readGit = (args: string[]): string => execFileSync('git', [...gitOptions, ...args], {
    cwd: root, env, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  }).trimEnd()
  try {
    if (readGit(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]) !== base) {
      throw new DaemonError('E_CONFLICT', '父工作树的固定提交不再可用。')
    }
  } catch {
    throw new DaemonError('E_CONFLICT', '父工作树的固定提交不再可用。')
  }
  try {
    readGit(['config', '--includes', '--name-only', '--get-regexp', '^(filter\\.|core\\.worktree$|includeif\\.)'])
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return
    throw new DaemonError('E_CONFLICT', '无法核验委派工作树的 Git 检出配置。')
  }
  throw new DaemonError('E_DENIED', '此仓库配置了 Git 内容过滤器、自定义工作树路径或条件配置，无法安全检出委派工作树。')
}

function matchesPinnedCheckout(child: WorkcopyIdentity, parent: WorkcopyIdentity): boolean {
  return child.commonId === parent.commonId && child.gitCommonDir === parent.gitCommonDir &&
    child.branch === null && child.head === parent.head && child.worktreeGitDir !== parent.worktreeGitDir
}

function parentPin({ id, revision, physicalId, commonId }: WorkcopyIdentity) {
  return { id, revision, physicalId, commonId }
}

export function verifyDelegatedWorktree(raw: DelegatedWorktreeBinding): WorkcopyIdentity {
  const binding = delegatedWorktreeBindingSchema.parse(raw)
  const { container, destination } = locations(binding.daemonDirectory, binding.operationId)
  if (physicalDirectory(binding.daemonDirectory) !== binding.daemonPhysicalId ||
    physicalDirectory(container) !== binding.containerPhysicalId ||
    pathKey(binding.identity.canonicalRoot) !== pathKey(destination)) {
    throw new DaemonError('E_CONFLICT', '原委派工作树的受管位置已变化。')
  }
  const actual = observeWorktree(destination)
  assertSameCheckout(actual, binding.identity)
  return actual
}

export async function recoverDelegatedWorktreePreparation(
  input: Pick<PrepareDelegatedWorktree, 'directory' | 'registry' | 'operationId' | 'pinnedParent'>
): Promise<NativeWorkcopyCommandResult | null> {
  const operationId = operationIdSchema.parse(input.operationId)
  const parent = workcopyIdentitySchema.parse(input.pinnedParent)
  physicalDirectory(input.directory)
  return recoverDaemonWorkcopyCommand(parent.canonicalRoot, `delegate-worktree:${locations(input.directory, operationId).key}`, {
    directory: input.directory, registry: input.registry, pinnedParent: parentPin(parent),
  })
}

export async function prepareDelegatedWorktree(input: PrepareDelegatedWorktree): Promise<DelegatedWorktreeBinding> {
  const pinnedParent = workcopyIdentitySchema.parse(input.pinnedParent)
  const commonId = pinnedParent.commonId
  if (!commonId) throw new DaemonError('E_CONFLICT', '委派需要父 Git 工作树的固定仓库。')
  if (input.signal?.aborted) throw new DaemonError('E_DENIED', '原委派工作树准备已取消。')
  input.assertCurrent()
  const previous = repositoryQueues.get(commonId) ?? Promise.resolve()
  const work = previous.then(() => prepareQueued({ ...input, pinnedParent }))
  const settled = work.then(() => {}, () => {})
  repositoryQueues.set(commonId, settled)
  try { return await work }
  finally { if (repositoryQueues.get(commonId) === settled) repositoryQueues.delete(commonId) }
}

async function prepareQueued(input: PrepareDelegatedWorktree): Promise<DelegatedWorktreeBinding> {
  const operationId = operationIdSchema.parse(input.operationId)
  const pinnedParent = input.pinnedParent
  const { head, gitCommonDir } = pinnedParent
  if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || !gitCommonDir) {
    throw new DaemonError('E_CONFLICT', '委派需要父 Git 工作树的固定提交。')
  }
  const assertCurrent = (): void => {
    if (input.signal?.aborted) throw new DaemonError('E_DENIED', '原委派工作树准备已取消。')
    input.assertCurrent()
  }
  assertCurrent()
  const parentRoot = input.parentRoot
  const parent = observeWorktree(parentRoot)
  assertSameCheckout(parent, pinnedParent)
  const directory = input.directory
  const daemonPhysicalId = physicalDirectory(directory)
  const { key, container, destination, receipt } = locations(directory, operationId)
  if (inside(parent.canonicalRoot, container) || inside(gitCommonDir, container) || inside(destination, parent.canonicalRoot)) {
    throw new DaemonError('E_CONFLICT', '委派工作树位置与父工作树或仓库元数据重叠。')
  }
  if (!lstatSync(container, { throwIfNoEntry: false })) mkdirSync(container)
  const containerPhysicalId = physicalDirectory(container)
  if (lstatSync(receipt, { throwIfNoEntry: false })) {
    const original = receiptSchema.parse(JSON.parse(readBounded(receipt, 64 * 1024)))
    if (original.binding.operationId !== operationId || original.binding.daemonDirectory !== directory ||
      original.pinnedParent.revision !== pinnedParent.revision || !matchesPinnedCheckout(original.binding.identity, pinnedParent)) {
      throw new DaemonError('E_CONFLICT', '原委派操作编号对应不同的工作树准备意图。')
    }
    assertSameCheckout(original.pinnedParent, pinnedParent)
    verifyDelegatedWorktree(original.binding)
    assertCurrent()
    return original.binding
  }
  const pendingKey = pathKey(destination)
  if (active.has(pendingKey)) throw new DaemonError('E_BUSY', '原委派工作树正在准备。')
  const env = gitEnvironment()
  const assertDestinationVacant = (): void => {
    if (lstatSync(destination, { throwIfNoEntry: false }) || lstatSync(receipt, { throwIfNoEntry: false })) {
      throw new DaemonError('E_CONFLICT', '委派工作树位置已有内容且无法确认原回执。')
    }
  }
  const assertPreparationPaths = (): void => {
    if (physicalDirectory(directory) !== daemonPhysicalId || physicalDirectory(container) !== containerPhysicalId) {
      throw new DaemonError('E_CONFLICT', '委派工作树的准备目录已被替换。')
    }
    assertSameCheckout(observeWorktree(parentRoot), pinnedParent)
  }
  active.add(pendingKey)
  try {
    let recovered: NativeWorkcopyCommandResult | null
    try { recovered = await recoverDelegatedWorktreePreparation(input) }
    catch { throw new DaemonError('E_UNKNOWN', '原工作树准备命令的回执或清理待核对。', 'unknown') }
    if (recovered?.cleanupConfirmed && recovered.failedToStart) {
      throw new DaemonError('E_UNAVAILABLE', '已确认原委派工作树的 Git 命令未启动。')
    }
    if (recovered) throw new DaemonError('E_UNKNOWN', '原 Git 命令已有回执，尚无可验证的工作树绑定。', 'unknown')
    assertCurrent()
    assertPreparationPaths()
    assertDestinationVacant()
    const result = await runFreshDaemonWorkcopyCommand(parent.canonicalRoot, {
      operationId: `delegate-worktree:${key}`,
      executable: 'git',
      args: [...gitOptions, 'worktree', 'add', '--detach', '--', destination, head],
      env,
      timeoutMs: 60_000,
    }, {
      directory,
      registry: input.registry,
      pinnedParent: parentPin(pinnedParent),
      expected: { id: parent.id, revision: parent.revision },
      signal: input.signal,
      assertCurrent: () => {
        assertCurrent()
        assertPreparationPaths()
        assertDestinationVacant()
        const worktrees = join(gitCommonDir, 'worktrees')
        if (lstatSync(worktrees, { throwIfNoEntry: false })) physicalDirectory(worktrees)
        assertSafeCheckout(parent.canonicalRoot, head, env)
      }
    })
    if (!result.cleanupConfirmed || result.aborted) throw new DaemonError('E_UNKNOWN', '委派工作树准备或原进程清理待核对。', 'unknown')
    if (result.failedToStart) throw new DaemonError('E_UNAVAILABLE', '委派工作树的 Git 命令未启动。')
    if (result.code !== 0) throw new DaemonError('E_UNKNOWN', 'Git 未确认委派工作树创建结果，请核对原操作。', 'unknown')
    let binding: DelegatedWorktreeBinding
    try {
      assertPreparationPaths()
      const identity = observeWorktree(destination)
      if (!matchesPinnedCheckout(identity, pinnedParent)) {
        throw new DaemonError('E_CONFLICT', 'Git 创建的工作树与原固定提交或仓库不符。')
      }
      binding = delegatedWorktreeBindingSchema.parse({ version: 1, operationId, identity, daemonDirectory: directory, daemonPhysicalId, containerPhysicalId })
      writeExclusiveAtomic(receipt, JSON.stringify(receiptSchema.parse({ pinnedParent, binding })))
    } catch {
      throw new DaemonError('E_UNKNOWN', 'Git 已运行，委派工作树原绑定未能确认。', 'unknown')
    }
    assertCurrent()
    return binding
  } finally { active.delete(pendingKey) }
}
