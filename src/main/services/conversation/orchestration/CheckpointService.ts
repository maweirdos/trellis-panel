import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ConversationCheckpointSummary } from '../../../../shared/conversation/command-runtime'
import type { ConversationCheckpointDiffFile, ConversationCheckpointDiffResult } from '../../../../shared/conversation/desktop'
import { CHECKPOINT_DIFF_TRUNCATED_MARKER } from '../../../../shared/conversation/checkpointDiff'
import { DaemonError } from '../../../daemon/errors'
import type { ConversationProjectionStore } from '../persistence/ProjectionStore'
import type { ConversationEventSink } from './EventSink'
import { lifecycleEvent } from './ThreadCommands'

const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const CHECKPOINT_DIFF_MAX_CHARS = 256 * 1024
const CHECKOUT_BATCH_SIZE = 100
const SHADOW_REF_PREFIX = 'shadow:'
const SHADOW_EXCLUDES = [
  '.git/',
  'node_modules/',
  'dist/',
  'out/',
  '.next/',
  '.nuxt/',
  '.cache/',
  'target/',
  'build/',
  '__pycache__/',
  '.venv/',
  'venv/',
].join('\n') + '\n'

export interface ActiveExecutionScope {
  readonly threadId: string
  readonly cwd: string
}

export interface CheckpointCaptureInput {
  readonly threadId: string
  readonly runId: string
  readonly phase: 'before' | 'after'
  readonly cwd: string
}

export interface CheckpointRestoreInput {
  readonly threadId: string
  readonly runId: string
  readonly phase: 'before' | 'after'
  readonly cwd: string
}

function normalizeCanonicalPath(inputPath: string): string | null {
  try {
    const resolved = realpathSync.native(inputPath)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  } catch {
    return null
  }
}

function pathsOverlap(leftCanonical: string, rightCanonical: string): boolean {
  if (leftCanonical === rightCanonical) return true
  const relA = relative(leftCanonical, rightCanonical)
  if (relA === '' || (!relA.startsWith('..') && !isAbsolute(relA))) return true
  const relB = relative(rightCanonical, leftCanonical)
  return relB === '' || (!relB.startsWith('..') && !isAbsolute(relB))
}

function isWithinDirectory(rootCanonical: string, targetPath: string): boolean {
  const normalizedTarget = process.platform === 'win32' ? resolve(targetPath).toLowerCase() : resolve(targetPath)
  const rel = relative(rootCanonical, normalizedTarget)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function execGit(
  args: readonly string[],
  cwd: string,
  envOverrides?: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message
          rejectPromise(new Error(`git ${args[0] ?? ''} 失败：${detail}`))
          return
        }
        resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  if (!existsSync(cwd)) return null
  try {
    const { stdout } = await execGit(['rev-parse', '--show-toplevel'], cwd)
    const root = stdout.trim()
    return root ? realpathSync.native(root) : null
  } catch {
    return null
  }
}

function createTemporaryIndexPath(): { readonly dir: string; readonly indexFile: string } {
  const dir = join(tmpdir(), `crux-ckpt-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return { dir, indexFile: join(dir, 'index') }
}

function parsePorcelainStatus(stdout: string): {
  readonly dirtyFileCount: number
  readonly untrackedCount: number
  readonly untrackedPaths: readonly string[]
} {
  if (!stdout) return { dirtyFileCount: 0, untrackedCount: 0, untrackedPaths: [] }
  const tokens = stdout.split('\0')
  let dirtyFileCount = 0
  let untrackedCount = 0
  const untrackedPaths: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index]
    if (!entry || entry.length < 4) continue
    const code = entry.slice(0, 2)
    const filePath = entry.slice(3)
    if (code === '??') {
      untrackedCount += 1
      untrackedPaths.push(filePath)
    } else {
      dirtyFileCount += 1
      if (code.includes('R') || code.includes('C')) index += 1
    }
  }
  return { dirtyFileCount, untrackedCount, untrackedPaths }
}

function parseDiffTreeNameStatus(stdout: string): ReadonlyArray<{ readonly status: string; readonly path: string }> {
  const entries: Array<{ readonly status: string; readonly path: string }> = []
  const tokens = stdout.split('\0')
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index]
    const filePath = tokens[index + 1]
    if (!status || !filePath) continue
    entries.push({ status: status[0], path: filePath })
  }
  return entries
}

function removeEmptyParentDirs(startDir: string, stopAtCanonicalRoot: string): void {
  let current = startDir
  while (isWithinDirectory(stopAtCanonicalRoot, current)) {
    const base = current.split(/[\\/]/).at(-1)
    if (base === '.git') break
    try {
      rmSync(current, { recursive: false })
      current = dirname(current)
    } catch {
      break
    }
  }
}

/**
 * M7 检查点快照、安全闸门与安全文件恢复服务：
 * 1. 基于一次性临时 `GIT_INDEX_FILE` 捕获含未跟踪（非忽略）文件的轻量树对象，不触碰用户 `.git/index` 与分支历史；
 * 2. 回滚前校验工作区归属，拦截多会话并发重叠目录写入冲突；
 * 3. 支持精确 diff-tree 还原与安全清理检查点后新增的文件，并保留 `.gitignore` 忽略目录（如 `node_modules`）。
 */
export class CheckpointService {
  constructor(
    private readonly projections: ConversationProjectionStore,
    private readonly eventSink: ConversationEventSink,
    private readonly listActiveExecutionCwds: () => readonly ActiveExecutionScope[],
    private readonly storageDirectory?: string,
  ) {}

  private async ensureShadowGitDir(canonicalCwd: string): Promise<string | null> {
    if (!this.storageDirectory) return null
    const hash = createHash('sha256').update(canonicalCwd).digest('hex').slice(0, 24)
    const shadowDir = join(this.storageDirectory, 'conversation-v2', 'folder-checkpoints', hash)
    if (!existsSync(join(shadowDir, 'HEAD'))) {
      mkdirSync(shadowDir, { recursive: true })
      await execGit(['init', '--bare', shadowDir], this.storageDirectory)
    }
    const infoDir = join(shadowDir, 'info')
    mkdirSync(infoDir, { recursive: true })
    writeFileSync(join(infoDir, 'exclude'), SHADOW_EXCLUDES, 'utf8')
    return shadowDir
  }

  private resolveGitEnv(
    repoRoot: string,
    gitRefName: string | null | undefined,
    extra?: NodeJS.ProcessEnv,
  ): { readonly execCwd: string; readonly env: NodeJS.ProcessEnv; readonly isShadow: boolean } {
    if (gitRefName && gitRefName.startsWith(SHADOW_REF_PREFIX)) {
      const shadowDir = gitRefName.slice(SHADOW_REF_PREFIX.length)
      return {
        execCwd: repoRoot,
        isShadow: true,
        env: {
          ...extra,
          GIT_DIR: shadowDir,
          GIT_WORK_TREE: repoRoot,
        },
      }
    }
    return {
      execCwd: repoRoot,
      isShadow: false,
      env: { ...extra },
    }
  }

  async capture(input: CheckpointCaptureInput): Promise<ConversationCheckpointSummary> {
    const createdAt = new Date().toISOString()
    const checkpointId = `ckpt_${randomUUID()}`
    const canonicalCwd = normalizeCanonicalPath(input.cwd)
    if (!canonicalCwd) {
      return this.recordSummary({
        checkpointId,
        threadId: input.threadId,
        runId: input.runId,
        phase: input.phase,
        cwd: input.cwd,
        gitTreeRef: null,
        headRef: null,
        dirtyFileCount: 0,
        untrackedCount: 0,
        status: 'skipped',
        detail: '工作目录当前不可访问，仅保留对话记录回退能力。',
        createdAt,
      })
    }

    const gitRepoRoot = await resolveGitRoot(input.cwd)
    const shadowDir = gitRepoRoot ? null : await this.ensureShadowGitDir(canonicalCwd).catch(() => null)
    if (!gitRepoRoot && !shadowDir) {
      return this.recordSummary({
        checkpointId,
        threadId: input.threadId,
        runId: input.runId,
        phase: input.phase,
        cwd: input.cwd,
        gitTreeRef: null,
        headRef: null,
        dirtyFileCount: 0,
        untrackedCount: 0,
        status: 'skipped',
        detail: '当前目录不是 Git 仓库且无法创建隔离文件夹快照，仅支持回退对话历史。',
        createdAt,
      })
    }

    const repoRoot = gitRepoRoot ?? input.cwd
    const tempIndex = createTemporaryIndexPath()
    try {
      const baseEnv: NodeJS.ProcessEnv = shadowDir
        ? { GIT_DIR: shadowDir, GIT_WORK_TREE: repoRoot, GIT_INDEX_FILE: tempIndex.indexFile }
        : { GIT_INDEX_FILE: tempIndex.indexFile }
      await execGit(['add', '-A'], repoRoot, baseEnv)
      const { stdout: treeOut } = await execGit(['write-tree'], repoRoot, baseEnv)
      const gitTreeRef = treeOut.trim()
      if (!gitTreeRef) throw new Error('git write-tree 未返回有效树对象哈希。')

      let headRef: string | null = null
      if (!shadowDir) {
        try {
          const { stdout: headOut } = await execGit(['rev-parse', '--verify', 'HEAD'], repoRoot)
          headRef = headOut.trim() || null
        } catch {
          headRef = null
        }
      }

      const statusSummary = shadowDir
        ? { dirtyFileCount: 0, untrackedCount: 0, untrackedPaths: [] as string[] }
        : parsePorcelainStatus((await execGit(['status', '--porcelain=v1', '-z'], repoRoot)).stdout)
      const refName = `refs/crux/checkpoints/${checkpointId}`
      try {
        const { stdout: commitOut } = await execGit(
          ['commit-tree', gitTreeRef, '-m', `crux checkpoint ${checkpointId}`],
          repoRoot,
          {
            ...(shadowDir ? { GIT_DIR: shadowDir, GIT_WORK_TREE: repoRoot } : {}),
            GIT_AUTHOR_NAME: 'Crux Checkpoint',
            GIT_AUTHOR_EMAIL: 'checkpoint@crux.local',
            GIT_COMMITTER_NAME: 'Crux Checkpoint',
            GIT_COMMITTER_EMAIL: 'checkpoint@crux.local',
          },
        )
        const commitHash = commitOut.trim()
        if (commitHash) {
          await execGit(['update-ref', refName, commitHash], repoRoot, shadowDir ? { GIT_DIR: shadowDir, GIT_WORK_TREE: repoRoot } : undefined)
        }
      } catch {
        // 即使 update-ref 因锁定失败，tree 对象仍可作为短周期引用使用。
      }

      return this.recordSummary(
        {
          checkpointId,
          threadId: input.threadId,
          runId: input.runId,
          phase: input.phase,
          cwd: input.cwd,
          gitTreeRef,
          headRef,
          dirtyFileCount: statusSummary.dirtyFileCount,
          untrackedCount: statusSummary.untrackedCount,
          status: 'captured',
          createdAt,
        },
        {
          repoRoot,
          canonicalCwd,
          gitRefName: shadowDir ? `${SHADOW_REF_PREFIX}${shadowDir}` : refName,
          untrackedManifestJson: JSON.stringify(statusSummary.untrackedPaths),
        },
      )
    } catch (error) {
      return this.recordSummary({
        checkpointId,
        threadId: input.threadId,
        runId: input.runId,
        phase: input.phase,
        cwd: input.cwd,
        gitTreeRef: null,
        headRef: null,
        dirtyFileCount: 0,
        untrackedCount: 0,
        status: 'failed',
        detail: error instanceof Error ? error.message.slice(0, 400) : '捕获检查点失败。',
        createdAt,
      })
    } finally {
      rmSync(tempIndex.dir, { recursive: true, force: true })
    }
  }

  checkRestoreSafety(input: CheckpointRestoreInput): {
    readonly checkpoint: ConversationCheckpointSummary
    readonly repoRoot: string
    readonly gitRefName: string | null
  } {
    const canonicalCwd = normalizeCanonicalPath(input.cwd)
    if (!canonicalCwd) {
      throw new DaemonError('E_CONFLICT', '原工作目录当前不存在或不可访问，无法安全还原文件。')
    }
    for (const active of this.listActiveExecutionCwds()) {
      if (active.threadId === input.threadId) continue
      const activeCanonical = normalizeCanonicalPath(active.cwd)
      if (activeCanonical && pathsOverlap(canonicalCwd, activeCanonical)) {
        throw new DaemonError(
          'E_BUSY',
          '当前工作目录正被其他运行中的会话占用，已阻止文件覆盖；可取消勾选「还原文件」以仅回退对话历史。',
        )
      }
    }

    const stored = this.projections.readCheckpointWithScope(input.threadId, input.runId, input.phase)
    if (!stored || stored.checkpoint.status !== 'captured' || !stored.checkpoint.gitTreeRef || !stored.scope?.repoRoot) {
      throw new DaemonError(
        'E_CONFLICT',
        stored?.checkpoint.detail ?? '所选轮次缺少可用的文件检查点，可取消勾选「还原文件」仅回退对话历史。',
      )
    }

    const canonicalRepoRoot = normalizeCanonicalPath(stored.scope.repoRoot)
    if (!canonicalRepoRoot || (!pathsOverlap(canonicalCwd, canonicalRepoRoot))) {
      throw new DaemonError('E_CONFLICT', '检查点所属工作目录与当前目录不一致，已阻止还原。')
    }

    return {
      checkpoint: stored.checkpoint,
      repoRoot: stored.scope.repoRoot,
      gitRefName: stored.scope.gitRefName,
    }
  }

  async restoreFiles(input: CheckpointRestoreInput): Promise<ConversationCheckpointSummary> {
    const { checkpoint, repoRoot, gitRefName } = this.checkRestoreSafety(input)
    const targetTree = checkpoint.gitTreeRef!
    const canonicalRepoRoot = normalizeCanonicalPath(repoRoot)
    if (!canonicalRepoRoot) {
      throw new DaemonError('E_CONFLICT', '无法解析检查点所属目录。')
    }

    const gitCtx = this.resolveGitEnv(repoRoot, gitRefName)
    try {
      await execGit(['rev-parse', '--verify', `${targetTree}^{tree}`], gitCtx.execCwd, gitCtx.env)
    } catch {
      throw new DaemonError('E_CONFLICT', '原检查点树对象已失效或被清理，无法还原文件；请取消勾选「还原文件」仅回退对话历史。')
    }

    const tempIndex = createTemporaryIndexPath()
    try {
      const env = { ...gitCtx.env, GIT_INDEX_FILE: tempIndex.indexFile }
      await execGit(['add', '-A'], gitCtx.execCwd, env)
      const { stdout: currentTreeOut } = await execGit(['write-tree'], gitCtx.execCwd, env)
      const currentTree = currentTreeOut.trim()
      if (currentTree === targetTree) {
        return checkpoint
      }

      const { stdout: diffOut } = await execGit(
        ['diff-tree', '-r', '--name-status', '--no-renames', '-z', targetTree, currentTree],
        gitCtx.execCwd,
        gitCtx.env,
      )
      const changes = parseDiffTreeNameStatus(diffOut)
      const toDelete = changes.filter(item => item.status === 'A').map(item => item.path)
      const toCheckout = changes.filter(item => item.status !== 'A').map(item => item.path)

      for (const relPath of toDelete) {
        const absPath = join(repoRoot, relPath)
        if (!isWithinDirectory(canonicalRepoRoot, absPath)) continue
        try {
          const stats = statSync(absPath)
          if (stats.isDirectory()) rmSync(absPath, { recursive: true, force: true })
          else unlinkSync(absPath)
          removeEmptyParentDirs(dirname(absPath), canonicalRepoRoot)
        } catch {
          // 文件可能已在外部移除，继续处理其余变更。
        }
      }

      if (toCheckout.length > 0) {
        await execGit(['read-tree', targetTree], gitCtx.execCwd, env)
        for (let offset = 0; offset < toCheckout.length; offset += CHECKOUT_BATCH_SIZE) {
          const batch = toCheckout.slice(offset, offset + CHECKOUT_BATCH_SIZE)
          await execGit(['checkout-index', '-f', '--', ...batch], gitCtx.execCwd, env)
        }
      }

      return checkpoint
    } catch (error) {
      if (error instanceof DaemonError) throw error
      throw new DaemonError(
        'E_UNKNOWN',
        `还原工作区文件失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      rmSync(tempIndex.dir, { recursive: true, force: true })
    }
  }

  async readCheckpointDiff(input: {
    readonly threadId: string
    readonly runId: string
    readonly fromPhase?: 'before' | 'after'
    readonly toPhase?: 'before' | 'after' | 'workspace'
    readonly ignoreWhitespace?: boolean
  }): Promise<ConversationCheckpointDiffResult> {
    const fromPhase = input.fromPhase ?? 'before'
    const toPhase = input.toPhase ?? 'after'
    const fromStored = this.projections.readCheckpointWithScope(input.threadId, input.runId, fromPhase)
    if (!fromStored || fromStored.checkpoint.status !== 'captured' || !fromStored.checkpoint.gitTreeRef || !fromStored.scope?.repoRoot) {
      return {
        threadId: input.threadId,
        runId: input.runId,
        fromPhase,
        toPhase,
        files: [],
        diff: '',
        truncated: false,
      }
    }

    const repoRoot = fromStored.scope.repoRoot
    const gitCtx = this.resolveGitEnv(repoRoot, fromStored.scope.gitRefName)
    let toTreeRef: string | null = null
    let tempIndex: { readonly dir: string; readonly indexFile: string } | undefined

    try {
      if (toPhase === 'workspace') {
        tempIndex = createTemporaryIndexPath()
        const env = { ...gitCtx.env, GIT_INDEX_FILE: tempIndex.indexFile }
        await execGit(['add', '-A'], gitCtx.execCwd, env)
        const { stdout } = await execGit(['write-tree'], gitCtx.execCwd, env)
        toTreeRef = stdout.trim() || null
      } else {
        const toStored = this.projections.readCheckpointWithScope(input.threadId, input.runId, toPhase)
        toTreeRef = toStored?.checkpoint.status === 'captured' ? toStored.checkpoint.gitTreeRef : null
      }

      if (!toTreeRef || toTreeRef === fromStored.checkpoint.gitTreeRef) {
        return {
          threadId: input.threadId,
          runId: input.runId,
          fromPhase,
          toPhase,
          files: [],
          diff: '',
          truncated: false,
        }
      }

      const wsArgs = input.ignoreWhitespace ? ['-w'] : []
      const [statusRes, numstatRes, patchRes] = await Promise.all([
        execGit(['diff-tree', '-r', '--name-status', '--no-renames', '-z', fromStored.checkpoint.gitTreeRef, toTreeRef], gitCtx.execCwd, gitCtx.env),
        execGit(['diff-tree', '-r', '--numstat', '--no-renames', '-z', fromStored.checkpoint.gitTreeRef, toTreeRef], gitCtx.execCwd, gitCtx.env),
        execGit(['diff', '--no-color', '--no-ext-diff', ...wsArgs, fromStored.checkpoint.gitTreeRef, toTreeRef], gitCtx.execCwd, gitCtx.env),
      ])

      const statusMap = new Map<string, ConversationCheckpointDiffFile['status']>()
      for (const entry of parseDiffTreeNameStatus(statusRes.stdout)) {
        const mapped = entry.status === 'A' ? 'added' : entry.status === 'D' ? 'deleted' : entry.status === 'R' ? 'renamed' : 'modified'
        statusMap.set(entry.path, mapped)
      }

      const files: ConversationCheckpointDiffFile[] = []
      const statTokens = numstatRes.stdout.split('\0').filter(Boolean)
      for (const token of statTokens) {
        const parts = token.split('\t')
        if (parts.length < 3) continue
        const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0
        const deletions = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0
        const filePath = parts.slice(2).join('\t')
        files.push({
          path: filePath,
          status: statusMap.get(filePath) ?? 'modified',
          additions,
          deletions,
        })
      }

      const rawDiff = patchRes.stdout
      const truncated = rawDiff.length > CHECKPOINT_DIFF_MAX_CHARS
      const diff = truncated
        ? `${rawDiff.slice(0, CHECKPOINT_DIFF_MAX_CHARS)}${CHECKPOINT_DIFF_TRUNCATED_MARKER}`
        : rawDiff

      return {
        threadId: input.threadId,
        runId: input.runId,
        fromPhase,
        toPhase,
        files,
        diff,
        truncated,
      }
    } catch {
      return {
        threadId: input.threadId,
        runId: input.runId,
        fromPhase,
        toPhase,
        files: [],
        diff: '',
        truncated: false,
      }
    } finally {
      if (tempIndex) rmSync(tempIndex.dir, { recursive: true, force: true })
    }
  }

  private recordSummary(
    summary: ConversationCheckpointSummary,
    scope?: {
      readonly repoRoot: string
      readonly canonicalCwd: string
      readonly gitRefName?: string | null
      readonly untrackedManifestJson?: string | null
    },
  ): ConversationCheckpointSummary {
    const existing = this.projections.readCheckpointWithScope(summary.threadId, summary.runId, summary.phase)
    if (existing && existing.checkpoint.status === 'captured' && summary.status !== 'captured') {
      return existing.checkpoint
    }
    try {
      this.eventSink.commit({
        hostEvents: [lifecycleEvent(summary.threadId, { kind: 'checkpoint', checkpoint: summary }, summary.runId, summary.createdAt)],
      }, () => {
        this.projections.upsertCheckpoint(summary, scope)
      })
    } catch {
      // 忽略因父线程已被截断/删除导致的延迟落盘冲突。
    }
    return summary
  }
}
