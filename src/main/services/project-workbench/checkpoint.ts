import { isAbsolute, relative, sep } from 'node:path'
import { DaemonError } from '../../daemon/errors'
import type { ConversationThreadSnapshot } from '../../../shared/conversation/command-runtime'
import type { WorkcopyIdentity } from '../../../shared/workcopy-use'
import { checkedDirectory, pathKey } from '../private-conversations/files'
import { inspectWorkcopyUse } from '../workcopy-use/client'
import { resolveWorkcopy } from '../workcopy-use/identity'
import { registeredGitWorktrees, workbenchGitStatus, workbenchHasUntrackedFiles } from './git'

export interface WorkbenchCheckpointEvidence {
  threadId: string
  runId: string
  checkpointId: string
  cwd: string
  workcopyId: string
  relatedRoots: readonly string[]
  occupiedRoots: readonly string[]
  nativeRollback: boolean
}

function contains(parent: string, child: string): boolean {
  const part = relative(pathKey(parent), pathKey(child))
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

export function overlapsWorkbenchPath(first: string, second: string): boolean {
  return contains(first, second) || contains(second, first)
}

export async function boundWorkbenchRoot(project: string, worktree: string | null, current: () => void): Promise<string> {
  if (!worktree) return project
  const cwd = checkedDirectory(worktree)
  if (pathKey(cwd) === pathKey(project)) throw new DaemonError('E_CONFLICT', '会话工作树与主工程重合。')
  current()
  const original = resolveWorkcopy(project)
  const selected = resolveWorkcopy(cwd)
  if (!selected.repoRoot || pathKey(selected.repoRoot) !== pathKey(cwd) || !original.commonId || original.commonId !== selected.commonId ||
      selected.worktreeGitDir === selected.gitCommonDir ||
      !(await registeredGitWorktrees(cwd)).some(candidate => pathKey(candidate) === pathKey(cwd))) {
    throw new DaemonError('E_DENIED', '无法把会话目录核实为原工程的链接工作树。')
  }
  current()
  return cwd
}

export async function assertWorkbenchCheckpointRestore(
  project: string, snapshot: ConversationThreadSnapshot, request: { runId: string; checkpointId: string; revision: string },
  evidence: WorkbenchCheckpointEvidence | undefined, current: () => void,
): Promise<WorkcopyIdentity> {
  const thread = snapshot.thread
  if (!thread.worktreePath) throw new DaemonError('E_UNAVAILABLE', '主工程只能回看对话和差异。')
  const run = snapshot.runs.find(candidate => candidate.id === request.runId)
  if (!evidence?.nativeRollback || !run || run.checkpointId !== request.checkpointId ||
    evidence.threadId !== thread.id || evidence.runId !== request.runId || evidence.checkpointId !== request.checkpointId) {
    throw new DaemonError('E_UNAVAILABLE', '原回合没有同时具备已核实的检查点和原生回退能力。')
  }
  const cwd = await boundWorkbenchRoot(project, thread.worktreePath, current)
  if (pathKey(cwd) !== pathKey(checkedDirectory(evidence.cwd)) || overlapsWorkbenchPath(cwd, project)) {
    throw new DaemonError('E_CONFLICT', '原检查点并非来自独立工作树。')
  }
  const identity = resolveWorkcopy(cwd)
  if (identity.id !== evidence.workcopyId || evidence.relatedRoots.length) {
    throw new DaemonError('E_CONFLICT', '原检查点的工作树身份或关联恢复范围需要重新核实。')
  }
  if (snapshot.runs.some(candidate => candidate.lifecycle?.backgroundRunning || ['queued', 'preparing', 'starting', 'running', 'waiting'].includes(candidate.status)) ||
      snapshot.runtimeRequests.some(candidate => ['pending', 'responding', 'pending-reconciliation'].includes(candidate.status)) ||
      evidence.occupiedRoots.some(root => overlapsWorkbenchPath(cwd, checkedDirectory(root)))) {
    throw new DaemonError('E_CONFLICT', '当前或重叠工作树仍有会话占用。')
  }
  const uses = await inspectWorkcopyUse(cwd)
  if (uses.identity.id !== identity.id || uses.identity.revision !== identity.revision || uses.uses.length) {
    throw new DaemonError('E_CONFLICT', '工作副本身份已变化或仍有原生占用。')
  }
  const trees = await registeredGitWorktrees(cwd)
  for (const tree of trees) {
    const root = checkedDirectory(tree)
    const selected = pathKey(root) === pathKey(cwd)
    if (!selected && overlapsWorkbenchPath(root, cwd)) throw new DaemonError('E_CONFLICT', '原工作树与其他工作树目录重叠。')
    const state = await workbenchGitStatus(root, current)
    if (!state.clean || state.conflicts || state.operation || (selected && state.revision !== request.revision) || await workbenchHasUntrackedFiles(root)) {
      throw new DaemonError('E_CONFLICT', 'Git 工作树有更改、未跟踪文件或当前修订已变化。')
    }
  }
  current()
  return identity
}
