import type { HifoxWorkLocal } from '@shared/hifox-work'
import { api } from '../api'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { projectRootKey } from '../my/navigation'
import { useHifox } from './store'
import { taskSourceKey } from './pages/task-detail/use-task-source'
import { nativeDevelopmentApi } from './development/bridge'
import { canReturnToDevelopmentSource, captureDevelopmentPosition, captureScrollPositions, forgetDevelopmentPositions, ownsDevelopmentSource, restoreDevelopmentScroll, restoreScrollPositions, retainedDevelopmentPosition } from './development/context'
import type { WorkPageSnapshot, WorkReturnContext } from './development/types'

export function hasLocalWorkBridge(): boolean {
  return Boolean(api && Object.hasOwn(api, 'hifoxWork') && api.hifoxWork && Object.hasOwn(api.hifoxWork, 'prepare') && typeof api.hifoxWork.prepare === 'function')
}

export function captureWorkPage(): WorkPageSnapshot {
  const state = useHifox.getState(), app = useApp.getState()
  return { fromPage: app.page, personalTaskSource: app.personalTaskSource, module: state.module, currentSpaceId: state.currentSpaceId,
    taskFilter: structuredClone(state.taskFilter), activeViewId: state.activeViewId, listLocations: structuredClone(state.taskWorkspaceLocations),
    scrollPositions: captureScrollPositions(document.querySelector('[aria-label="来源工作视图"]')) }
}

export function restoreWorkPage(page: WorkPageSnapshot, taskId: string | null): void {
  useApp.getState().setPersonalTaskSource(page.personalTaskSource)
  useApp.getState().setPage(page.fromPage)
  useHifox.setState({ module: page.module, currentSpaceId: page.currentSpaceId, taskFilter: page.taskFilter,
    activeViewId: page.activeViewId, taskWorkspaceLocations: page.listLocations, openTaskId: taskId })
  requestAnimationFrame(() => restoreScrollPositions(document.querySelector('[aria-label="来源工作视图"]'), page.scrollPositions))
}

async function enterDevelopment(origin: WorkReturnContext, owns: () => boolean, beforeCommit: () => void): Promise<void> {
  const bridge = nativeDevelopmentApi(), development = origin.local.development
  if (!bridge || !development) throw Error('当前客户端缺少版本化本机开发能力，请更新桌面客户端。')
  const result = await bridge.development({ workspaceKey: origin.workspaceKey, taskId: origin.taskId })
  if (!owns()) return
  if (!result.ok) throw Error(result.error)
  if (result.sourceError) throw Error(result.sourceError)
  if (!result.active || result.active.ref.contextId !== development.contextId || result.active.ref.generation !== development.generation || result.active.stage !== 'ready') throw Error('原开发尝试已变化或尚未就绪，请返回团队任务核对。')
  const targetRoot = projectRootKey(origin.projectRoot)
  if (projectRootKey(useApp.getState().snapshot?.meta.root) !== targetRoot) await useApp.getState().openProjectPath(origin.projectRoot)
  if (!owns()) return
  if (projectRootKey(useApp.getState().snapshot?.meta.root) !== targetRoot) throw Error(useApp.getState().openError || '本机项目尚未就绪')
  await useApp.getState().refresh()
  if (!owns()) return
  const app = useApp.getState()
  if (projectRootKey(app.snapshot?.meta.root) !== targetRoot) return
  const task = [...(app.snapshot?.tasks ?? []), ...(app.snapshot?.archived ?? [])].find((entry) => entry.dirName === origin.local.taskDir || entry.path === origin.local.taskDir)
  if (!task) throw Error('原开发任务未出现在本机快照中，请返回团队任务核对。')
  beforeCommit()
  useHifox.setState({ workReturn: { ...origin, taskDir: task.dirName }, developmentMode: null, openTaskId: null })
  app.setPage(origin.page.fromPage)
  useApp.getState().expandTaskWorkspace({ fromPage: origin.page.fromPage, taskDir: task.dirName, archived: origin.local.archived, scrollTop: 0 }, origin.developmentPosition.panel ? undefined : origin.developmentPosition.materialPath ?? undefined)
  useHifox.setState((state) => ({ developmentMode: 'task', developmentRevision: state.developmentRevision + 1 }))
  useMy.getState().setShellView('development')
  restoreDevelopmentScroll(origin)
}

/** Retain the source before opening a project, including tasks entered from My Tasks. */
export async function openLocalWork(workspaceKey: string, taskId: string, local: HifoxWorkLocal): Promise<void> {
  const state = useHifox.getState(), app = useApp.getState()
  const task = state.snapshot?.tasks.find((item) => item.id === taskId)
  if (state.localWorkOpening) return
  if (!task || !state.snapshot || state.openTaskId !== taskId || state.workspaceContext.key !== workspaceKey || !['hifox', 'tasks'].includes(app.page)) throw Error('原任务来源已不可操作')
  const previous = state.workReturn
  const origin: WorkReturnContext = { workspaceKey, actorId: state.workspaceContext.actorId, epoch: state.workspaceContext.epoch, instanceId: state.workspaceContext.instanceId,
    sourceKey: taskSourceKey(state.snapshot, state.workspaceContext), taskId, taskCreatedAt: task.createdAt, spaceId: task.spaceId,
    handlerId: task.workflow?.handlerId ?? task.assigneeIds[0], taskTitle: task.title, projectRoot: local.projectRoot, taskDir: local.taskDir, local,
    page: captureWorkPage(), developmentPosition: previous?.sourceKey === taskSourceKey(state.snapshot, state.workspaceContext) && previous.taskCreatedAt === task.createdAt && previous.local.development?.contextId === local.development?.contextId
      ? previous.developmentPosition : retainedDevelopmentPosition(taskSourceKey(state.snapshot, state.workspaceContext), taskId, local) ?? { materialPath: null, scrollPositions: [] } }
  if (!ownsDevelopmentSource(origin)) throw Error('原任务来源已不可操作')
  let invalidated = false
  const navigation = app.navigationRevision
  const offTeam = useHifox.subscribe((next) => { if (!ownsDevelopmentSource(origin) || next.module !== origin.page.module || next.currentSpaceId !== origin.page.currentSpaceId || next.openTaskId !== taskId) invalidated = true })
  const offApp = useApp.subscribe((next) => { if (next.navigationRevision !== navigation || projectRootKey(next.snapshot?.meta.root) !== projectRootKey(app.snapshot?.meta.root) && projectRootKey(next.snapshot?.meta.root) !== projectRootKey(local.projectRoot)) invalidated = true })
  useHifox.setState({ localWorkOpening: { projectRoot: local.projectRoot, taskId } })
  try { await enterDevelopment(origin, () => !invalidated && ownsDevelopmentSource(origin), () => { offApp(); offTeam() }) }
  catch (cause) {
    offApp(); offTeam()
    if (!invalidated && ownsDevelopmentSource(origin)) restoreWorkPage(origin.page, origin.taskId)
    throw cause
  }
  finally { offApp(); offTeam(); useHifox.setState({ localWorkOpening: null }) }
}

export async function resumeLocalWork(): Promise<void> {
  const state = useHifox.getState(), origin = state.workReturn, bridge = nativeDevelopmentApi()
  if (!origin || !bridge || state.localWorkOpening || !ownsDevelopmentSource(origin)) throw Error('原开发来源已失效，请返回团队任务重新核对。')
  let invalidated = false
  const offTeam = useHifox.subscribe(() => { if (!ownsDevelopmentSource(origin) || !useHifox.getState().workReturn) invalidated = true })
  const off = useApp.subscribe((next, previous) => {
    if (next.navigationRevision !== previous.navigationRevision || projectRootKey(next.snapshot?.meta.root) !== projectRootKey(previous.snapshot?.meta.root) && projectRootKey(next.snapshot?.meta.root) !== projectRootKey(origin.projectRoot)) invalidated = true
  })
  useHifox.setState({ localWorkOpening: { projectRoot: origin.projectRoot, taskId: origin.taskId } })
  try {
    const result = await bridge.status({ workspaceKey: origin.workspaceKey, taskId: origin.taskId })
    if (invalidated || !ownsDevelopmentSource(origin)) return
    if (!result.ok) throw Error(result.error)
    if (!result.prepared || result.reviewRequired || result.local.development?.contextId !== origin.local.development?.contextId || result.local.development?.generation !== origin.local.development?.generation) throw Error('原开发环境需要核对，请返回团队任务处理。')
    await enterDevelopment({ ...origin, local: result.local }, () => !invalidated && ownsDevelopmentSource(origin), () => { off(); offTeam() })
  } finally { off(); offTeam(); useHifox.setState({ localWorkOpening: null }) }
}

export function returnToTeamWork(): void {
  captureDevelopmentPosition()
  const state = useHifox.getState(), origin = state.workReturn
  if (!origin) return
  const valid = canReturnToDevelopmentSource(origin)
  useHifox.setState({ developmentMode: null, developmentRevision: state.developmentRevision + 1, ...(valid ? {} : { workReturn: null }) })
  useMy.getState().setShellView('collaboration')
  if (valid) restoreWorkPage(origin.page, origin.taskId)
  else { useApp.getState().setPage('hifox'); useHifox.setState({ module: 'my-tasks', openTaskId: null }) }
}

/** Observe actual transitions synchronously so React batching cannot revive old forms. */
export function observeDevelopmentNavigation(): () => void {
  let handlingSource = false
  const offTeam = useHifox.subscribe((next, previous) => {
    if (handlingSource) return
    handlingSource = true
    try {
      const identity = (state: typeof next): string | null => state.snapshot ? taskSourceKey(state.snapshot, state.workspaceContext) : null
      if (identity(next) !== identity(previous)) { forgetDevelopmentPositions(); useHifox.setState({ taskWorkspaceLocations: {} }) }
      if (next.workReturn && !canReturnToDevelopmentSource(next.workReturn)) useHifox.setState({ workReturn: null, developmentMode: null, developmentRevision: next.developmentRevision + 1 })
      else if (next.workReturn && next.developmentMode === 'task' && !ownsDevelopmentSource(next.workReturn)) {
        captureDevelopmentPosition()
        useHifox.setState({ developmentMode: 'independent', developmentRevision: next.developmentRevision + 1 })
      }
    } finally { handlingSource = false }
  })
  const offApp = useApp.subscribe((next, previous) => {
    const state = useHifox.getState(), origin = state.workReturn
    const changed = projectRootKey(next.snapshot?.meta.root) !== projectRootKey(previous.snapshot?.meta.root) || next.page !== previous.page || next.openTaskDir !== previous.openTaskDir || next.taskExpandOrigin !== previous.taskExpandOrigin
    if (!changed) return
    if (origin && state.developmentMode === 'task') captureDevelopmentPosition()
    if (state.localWorkOpening) { useHifox.setState({ developmentRevision: state.developmentRevision + 1 }); return }
    if (origin && state.developmentMode === 'task' && next.page === previous.page && projectRootKey(next.snapshot?.meta.root) === projectRootKey(origin.projectRoot) &&
      (next.openTaskDir === null && previous.openTaskDir === origin.taskDir || previous.taskExpandOrigin?.taskDir === origin.taskDir && next.taskExpandOrigin === null && next.openTaskDir === origin.taskDir)) {
      useHifox.setState({ developmentMode: null, developmentRevision: state.developmentRevision + 1 })
      queueMicrotask(() => {
        const app = useApp.getState()
        if (useHifox.getState().workReturn?.local.development?.contextId === origin.local.development?.contextId && !app.taskExpandOrigin && (!app.openTaskDir || app.openTaskDir === origin.taskDir)) returnToTeamWork()
      })
      return
    }
    useHifox.setState({ developmentRevision: state.developmentRevision + 1, ...(origin && state.developmentMode !== null ? { developmentMode: 'independent' as const } : {}) })
  })
  return () => { offApp(); offTeam() }
}
