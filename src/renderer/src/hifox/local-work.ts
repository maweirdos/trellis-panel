import type { HifoxWorkLocal } from '@shared/hifox-work'
import { api } from '../api'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'
import { useHifox } from './store'

export function hasLocalWorkBridge(): boolean {
  return Boolean(api && Object.hasOwn(api, 'hifoxWork') && api.hifoxWork)
}

/** Enter the existing native task reader, retaining the business source for return. */
export async function openLocalWork(workspaceKey: string, taskId: string, local: HifoxWorkLocal): Promise<void> {
  const initial = useHifox.getState()
  const originTask = initial.snapshot?.tasks.find((task) => task.id === taskId)
  const { actorId, epoch } = initial.workspaceContext
  const sourceModule = initial.module
  const sourceSpace = initial.currentSpaceId
  const sourceCreatedAt = originTask?.createdAt
  const sourceHandler = originTask?.workflow?.handlerId ?? originTask?.assigneeIds[0]
  const targetRoot = projectRootKey(local.projectRoot)
  const navigationRevision = useApp.getState().navigationRevision
  let awaitingProject = false
  if (initial.localWorkOpening) return
  let superseded = false
  const ownsSource = (): boolean => {
    const state = useHifox.getState()
    const current = state.snapshot?.tasks.find((task) => task.id === taskId)
    return !superseded && state.workspaceContext.key === workspaceKey && state.workspaceContext.actorId === actorId && state.workspaceContext.epoch === epoch && state.workspaceContext.state !== 'access-revoked'
      && state.openTaskId === taskId && state.module === sourceModule && state.currentSpaceId === sourceSpace && Boolean(current && current.createdAt === sourceCreatedAt && (current.workflow?.handlerId ?? current.assigneeIds[0]) === sourceHandler)
  }
  if (!ownsSource() || useApp.getState().page !== 'hifox' || !sourceCreatedAt) throw new Error('原任务来源已不可操作')
  const stopTeam = useHifox.subscribe(() => { if (!ownsSource()) superseded = true })
  const stopApp = useApp.subscribe((state, previous) => {
    const root = projectRootKey(state.snapshot?.meta.root)
    const previousRoot = projectRootKey(previous.snapshot?.meta.root)
    const ownProjectOpen = awaitingProject && state.page === 'dashboard' && root === targetRoot
    if (state.navigationRevision !== navigationRevision) superseded = true
    if (state.page !== previous.page && !ownProjectOpen) superseded = true
    if (root !== previousRoot && root !== targetRoot) superseded = true
    if (state.openTaskDir && state.openTaskDir !== previous.openTaskDir) superseded = true
  })
  useHifox.setState({ localWorkOpening: { projectRoot: local.projectRoot, taskId } })
  try {
    if (projectRootKey(useApp.getState().snapshot?.meta.root) !== targetRoot) {
      awaitingProject = true
      try { await useApp.getState().openProjectPath(local.projectRoot) } finally { awaitingProject = false }
    }
    if (!ownsSource()) return
    if (projectRootKey(useApp.getState().snapshot?.meta.root) !== targetRoot) throw new Error(useApp.getState().openError || '本机项目尚未就绪')
    // Same-project preparation must be visible immediately, without waiting for a file watcher.
    await useApp.getState().refresh()
    if (!ownsSource()) return
    const app = useApp.getState()
    if (projectRootKey(app.snapshot?.meta.root) !== targetRoot) return
    const task = [...(app.snapshot?.tasks ?? []), ...(app.snapshot?.archived ?? [])].find((entry) => entry.dirName === local.taskDir || entry.path === local.taskDir)
    if (!task) throw new Error('开发任务尚未出现在项目快照中，请刷新后重试')
    stopTeam(); stopApp()
    useHifox.setState({ workReturn: { workspaceKey, actorId, epoch, taskId, taskCreatedAt: sourceCreatedAt, projectRoot: local.projectRoot, taskDir: task.dirName }, openTaskId: null })
    app.setPage('hifox')
    useApp.getState().expandTaskWorkspace({ fromPage: 'hifox', taskDir: task.dirName, archived: local.archived, scrollTop: 0 })
  } finally {
    stopTeam(); stopApp()
    useHifox.setState({ localWorkOpening: null })
  }
}
