import { useEffect, useLayoutEffect, type JSX } from 'react'
import { useApp } from '../../store'
import { hasIpc } from '../../api'
import { useMy } from '../store'
import { projectRootKey } from '../navigation'
import { PageToolbar } from '../layout/PageLayout'
import { Button, EmptyState } from '../ui'
import { WorkItemsPage } from './WorkItemsPage'
import { TaskWorkspace } from '../../hifox/TaskWorkspace'
import { useHifox } from '../../hifox/store'
import { useCollaborationWorkspace } from '../../hifox/HiFoxApp'
import { ConnectionPanel } from '../../hifox/ConnectionPanel'
import { NewTaskModal, TaskDetailDrawer } from '../../hifox/pages/TaskDetailDrawer'

function PersonalTeamTasks(): JSX.Element {
  useCollaborationWorkspace()
  const { snapshot, loadError, bootstrap, createTaskOpen, createTaskContext, setCreateTaskOpen } = useHifox()
  useEffect(() => () => {
    useHifox.getState().openTask(null)
    useHifox.getState().setCreateTaskOpen(false)
  }, [])
  if (loadError) return <div className="flex flex-col items-center"><EmptyState title={loadError} /><Button variant="outline" onClick={() => void bootstrap()}>重新加载</Button></div>
  if (!snapshot) return <div role="status" className="grid h-full place-items-center text-my-sm text-my-tertiary">正在加载团队任务…</div>
  return <>
    <TaskWorkspace scope="mine" />
    <TaskDetailDrawer />
    <NewTaskModal {...createTaskContext} open={createTaskOpen} onClose={() => setCreateTaskOpen(false)} />
  </>
}

/** A source switch composes the existing task pages without sharing their mutations. */
export function PersonalTasksPage(): JSX.Element {
  const chosenSource = useApp((state) => state.personalTaskSource)
  const localTaskOpen = useApp((state) => state.openTaskDir !== null)
  const root = useApp((state) => projectRootKey(state.snapshot?.meta.root))
  const source = localTaskOpen ? 'local' : chosenSource
  useLayoutEffect(() => {
    if (localTaskOpen && chosenSource !== 'local') useApp.getState().setPersonalTaskSource('local')
  }, [localTaskOpen, chosenSource])
  const selectSource = (next: 'team' | 'local'): void => {
    if (next === source) return
    useMy.getState().closeIssue()
    useMy.getState().setCreateIssueOpen(false)
    useApp.getState().showTask(null)
    useApp.getState().setPersonalTaskSource(next)
  }
  return <div className="flex h-full min-h-0 min-w-0 flex-col" data-personal-task-source={source}>
    <PageToolbar>
      <span className="text-my-xs text-my-tertiary">来源</span>
      <div className="my-segmented shrink-0" role="group" aria-label="任务来源">
        {([{ id: 'team', label: '团队任务' }, { id: 'local', label: '本地工作' }] as const).map((item) => <button key={item.id} type="button" aria-pressed={source === item.id} className={`my-control my-control-sm shrink-0 whitespace-nowrap ${source === item.id ? 'bg-my-layer-1-active text-my-primary' : 'text-my-tertiary'}`} onClick={() => selectSource(item.id)}>{item.label}</button>)}
      </div>
      {source === 'team' && hasIpc && <div className="ml-auto min-w-0"><ConnectionPanel /></div>}
    </PageToolbar>
    <div className="min-h-0 min-w-0 flex-1">
      {source === 'team' ? <PersonalTeamTasks /> : root ? <WorkItemsPage key={root} /> : <div className="flex flex-col items-center"><EmptyState title="先打开本机项目" /><Button variant="outline" disabled={!hasIpc} onClick={() => void useApp.getState().pickAndOpen()}>打开项目</Button></div>}
    </div>
  </div>
}
