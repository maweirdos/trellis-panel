import { useMemo, useState, type JSX } from 'react'
import { ArrowLeft, ChevronRight, Code2, FolderOpen, GitBranch, Loader2 } from 'lucide-react'
import { useApp } from '../../store'
import { projectRootKey } from '../../my/navigation'
import { Button, DisclosureGrid } from '../../my/ui'
import { useMy } from '../../my/store'
import { useGitWorkspace } from '../../git-workspace/useGitWorkspace'
import { TaskApplicationServices } from '../../applications/TaskApplicationServices'
import { TaskOutputs } from '../task-outputs'
import { useCrux } from '../store'
import { resumeLocalWork, returnToTeamWork } from '../local-work'
import { canReturnToDevelopmentSource, getTaskDevelopmentTarget, ownsDevelopmentSource } from './context'

export function DevelopmentScopeTag(): JSX.Element | null {
  const mode = useCrux((state) => state.developmentMode)
  const origin = useCrux((state) => state.workReturn)
  const root = useApp((state) => state.snapshot?.meta.root)
  if (!mode || !origin) return null
  const taskMode = mode === 'task' && projectRootKey(root) === projectRootKey(origin.projectRoot) && getTaskDevelopmentTarget()
  return <span className="my-chip shrink-0 text-my-xs text-my-secondary">{taskMode ? `任务 ${origin.taskId}` : '独立查看'}</span>
}

/** Fixed task facts stay separate from the project currently being browsed. */
export function DevelopmentContextBar(): JSX.Element | null {
  const origin = useCrux((state) => state.workReturn), mode = useCrux((state) => state.developmentMode)
  const revision = useCrux((state) => state.developmentRevision)
  const opening = useCrux((state) => state.localWorkOpening)
  const teamSnapshot = useCrux((state) => state.snapshot)
  const snapshot = useApp((state) => state.snapshot)
  const git = useGitWorkspace()
  const [error, setError] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const members = useMemo(() => {
    const space = teamSnapshot?.spaces.find((item) => item.id === origin?.spaceId)
    return teamSnapshot?.members.filter((member) => space?.memberIds.includes(member.id)).map(({ id, name }) => ({ id, name })) ?? []
  }, [teamSnapshot, origin?.spaceId])
  if (!origin || !mode || !canReturnToDevelopmentSource(origin)) return null
  const target = getTaskDevelopmentTarget()
  const taskMode = Boolean(target)
  const canResume = ownsDevelopmentSource(origin)
  const originalCopy = origin.projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? origin.projectRoot
  const actualCopy = snapshot?.meta.name ?? snapshot?.meta.root ?? '尚未打开工程'
  const actualGit = projectRootKey(git.root) === projectRootKey(snapshot?.meta.root) ? git.snapshot : null
  const key = `${origin.sourceKey}:${origin.taskId}:${origin.local.development?.contextId}:${origin.local.development?.generation}:${revision}`
  return <section className="shrink-0 border-b border-my-line bg-my-layer-1 px-4 py-2" aria-label="开发上下文" data-development-mode={taskMode ? 'task' : 'independent'}>
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-my-xs">
      {taskMode ? <><Code2 size={14} className="shrink-0 text-my-secondary" /><span className="min-w-0 flex-1 truncate text-my-primary" title={`${origin.taskId} · ${origin.taskTitle}`}>{origin.taskId} · {origin.taskTitle}</span><span className="flex min-w-0 items-center gap-1 text-my-secondary" title={origin.projectRoot}><FolderOpen size={12} /><span className="truncate">{originalCopy}</span></span></>
        : <><FolderOpen size={14} className="shrink-0 text-my-secondary" /><span className="min-w-0 flex-1 truncate text-my-primary">独立查看 · {actualCopy}</span><span className="min-w-0 max-w-full truncate text-my-secondary" title={`原任务 ${origin.taskId} · ${originalCopy}`}>原任务 {origin.taskId} · {originalCopy}</span></>}
      <span className="flex min-w-0 max-w-full items-center gap-1 text-my-secondary"><GitBranch size={12} className="shrink-0" /><span className="min-w-0 truncate" title={actualGit?.branch ?? undefined}>{actualGit?.branch ?? (actualGit?.detached ? '分离 HEAD' : '分支待核对')}</span></span>
      {taskMode && <span className="text-my-tertiary">输入 {origin.local.development?.inputVersion.slice(0, 12)} · 环境见服务计划</span>}
      {!taskMode && canResume && <Button size="sm" variant="outline" disabled={Boolean(opening)} onClick={() => { setError(''); void resumeLocalWork().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '原开发环境无法恢复')) }}>{opening ? <Loader2 size={12} className="animate-spin" /> : <ArrowLeft size={12} />}回原开发环境</Button>}
      {!taskMode && !canResume && projectRootKey(snapshot?.meta.root) !== projectRootKey(origin.projectRoot) && <Button size="sm" variant="outline" disabled={Boolean(opening)} onClick={() => {
        setError('')
        void useApp.getState().openProjectPath(origin.projectRoot).then(() => {
          if (!canReturnToDevelopmentSource(origin)) return
          if (projectRootKey(useApp.getState().snapshot?.meta.root) !== projectRootKey(origin.projectRoot)) throw Error(useApp.getState().openError || '原工程尚未打开')
          useMy.getState().setChatWorkdirMode('directory')
        }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '原工程无法打开'))
      }}>独立查看原工程</Button>}
      <Button size="sm" variant="ghost" disabled={Boolean(opening)} onClick={returnToTeamWork}><ArrowLeft size={12} />返回团队任务</Button>
    </div>
    {!canResume && <p role="status" className="mt-1 text-my-xs text-my-secondary">原任务当前无法核实或继续开发，当前独立查看工程。原服务可在本机运行中核对。</p>}
    {error && <p role="alert" className="mt-2 break-words text-my-xs text-my-danger-text">{error}</p>}
    {taskMode && target && <div className="mt-1 text-my-xs text-my-secondary">
      <button type="button" className="flex cursor-pointer items-center gap-1.5 text-my-xs text-my-secondary transition-colors hover:text-my-primary" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((v) => !v)}>
        <ChevronRight size={12} className="my-disclosure-chevron shrink-0 text-my-tertiary" data-open={detailsOpen || undefined} />
        <span>开发环境、任务服务与产物</span>
      </button>
      <DisclosureGrid open={detailsOpen}>
        <div className="my-scrollbar max-h-80 min-w-0 space-y-3 overflow-y-auto py-3"><dl className="space-y-1 break-all"><div>原副本：{origin.projectRoot}</div><div>资源：{origin.local.resourceBinding?.resourceId ?? '本机项目'}</div><div>准备时分支：{origin.local.development?.branch ?? '未核实'} · HEAD：{origin.local.development?.head ?? '未核实'}</div><div>当前 Git 改动：{actualGit ? actualGit.clean ? '工作树干净' : `${actualGit.staged.length + actualGit.unstaged.length + actualGit.untracked.length} 项` : '待核对'}</div></dl><TaskApplicationServices key={key} query={{ workspaceKey: target.workspaceKey, taskId: target.taskId }} expected={target.expected} contextKey={key} /><div className="border-t border-my-line pt-3"><TaskOutputs key={key} query={{ workspaceKey: target.workspaceKey, taskId: target.taskId }} expected={target.expected} contextKey={key} members={members} /></div></div>
      </DisclosureGrid>
    </div>}
  </section>
}
