import type { HifoxDevelopmentTarget, HifoxWorkLocal } from '@shared/hifox-work'
import { useApp } from '../../store'
import { projectRootKey } from '../../my/navigation'
import { canReadTaskSpace, taskSourceKey } from '../pages/task-detail/use-task-source'
import { useHifox } from '../store'
import type { DevelopmentPanelPosition, DevelopmentPosition, ScrollPosition, WorkReturnContext } from './types'

const positions = new Map<string, DevelopmentPosition>()
const positionKey = (sourceKey: string, taskId: string, local: HifoxWorkLocal): string => JSON.stringify([sourceKey, taskId, local.development?.taskCreatedAt, local.development?.contextId, local.development?.generation])
export function retainedDevelopmentPosition(sourceKey: string, taskId: string, local: HifoxWorkLocal): DevelopmentPosition | undefined { return positions.get(positionKey(sourceKey, taskId, local)) }
function rememberPosition(origin: WorkReturnContext, position: DevelopmentPosition): void {
  const key = positionKey(origin.sourceKey, origin.taskId, origin.local)
  positions.delete(key); positions.set(key, position)
  while (positions.size > 24) { const oldest = positions.keys().next(); if (oldest.done) break; positions.delete(oldest.value) }
}
export function forgetDevelopmentPositions(): void { positions.clear() }
export function developmentPanelPosition(projectRoot: string | undefined, taskDir: string | null): DevelopmentPanelPosition | undefined {
  const state = useHifox.getState(), origin = state.workReturn
  return origin && state.developmentMode === 'task' && taskDir === origin.taskDir && projectRootKey(projectRoot) === projectRootKey(origin.projectRoot) && ownsDevelopmentSource(origin) ? origin.developmentPosition.panel : undefined
}
export function saveDevelopmentPanelPosition(projectRoot: string | undefined, taskDir: string | null, panel: DevelopmentPanelPosition): void {
  const state = useHifox.getState(), origin = state.workReturn
  if (!origin || state.developmentMode !== 'task' || taskDir !== origin.taskDir || projectRootKey(projectRoot) !== projectRootKey(origin.projectRoot) || !ownsDevelopmentSource(origin)) return
  const position = { ...origin.developmentPosition, panel }
  rememberPosition(origin, position)
  useHifox.setState({ workReturn: { ...origin, developmentPosition: position } })
}

export function canReturnToDevelopmentSource(origin: WorkReturnContext): boolean {
  const state = useHifox.getState()
  const task = state.snapshot?.tasks.find((item) => item.id === origin.taskId && item.createdAt === origin.taskCreatedAt && item.spaceId === origin.spaceId)
  return Boolean(state.snapshot && task && taskSourceKey(state.snapshot, state.workspaceContext) === origin.sourceKey &&
    state.workspaceContext.key === origin.workspaceKey && state.workspaceContext.actorId === origin.actorId && state.workspaceContext.epoch === origin.epoch &&
    canReadTaskSpace(state.snapshot, state.workspaceContext, origin.spaceId))
}

export function ownsDevelopmentSource(origin: WorkReturnContext): boolean {
  const state = useHifox.getState(), task = state.snapshot?.tasks.find((item) => item.id === origin.taskId && item.createdAt === origin.taskCreatedAt)
  const category = state.snapshot?.taskStatuses.find((status) => status.id === task?.statusId)?.category
  return Boolean(['local', 'connected'].includes(state.workspaceContext.state) && canReturnToDevelopmentSource(origin) && task && !state.snapshot?.spaces.find((space) => space.id === origin.spaceId)?.archived &&
    !task.triagePending && task.workKind !== 'general' && !['done', 'cancelled'].includes(category ?? '') &&
    (!task.workflow || ['dev_ready', 'planning', 'developing'].includes(task.workflow.stage)) &&
    (task.workflow?.handlerId ?? task.assigneeIds[0]) === origin.handlerId)
}

export function getTaskDevelopmentTarget(): HifoxDevelopmentTarget | undefined {
  const team = useHifox.getState(), app = useApp.getState(), origin = team.workReturn
  if (team.developmentMode !== 'task' || !origin?.local.development || !ownsDevelopmentSource(origin) ||
    projectRootKey(app.snapshot?.meta.root) !== projectRootKey(origin.projectRoot) || app.openTaskDir !== origin.taskDir || !app.taskExpandOrigin) return undefined
  return { workspaceKey: origin.workspaceKey, taskId: origin.taskId,
    expected: { contextId: origin.local.development.contextId, generation: origin.local.development.generation } }
}

const scrollSelector = '.my-scrollbar,[data-page-scroll],.acp-document__body,.acp-transcript,.my-page-body'
export function captureScrollPositions(root: Element | null): ScrollPosition[] {
  return root ? [root, ...root.querySelectorAll<HTMLElement>(scrollSelector)].map((element) => ({ top: element.scrollTop, left: element.scrollLeft })) : []
}
export function restoreScrollPositions(root: Element | null, positions: readonly ScrollPosition[]): void {
  if (!root) return
  const elements = [root, ...root.querySelectorAll<HTMLElement>(scrollSelector)]
  positions.forEach((position, index) => { if (elements[index]) { elements[index].scrollTop = position.top; elements[index].scrollLeft = position.left } })
}
export function captureDevelopmentPosition(): void {
  const state = useHifox.getState(), origin = state.workReturn
  if (!origin || state.developmentMode !== 'task') return
  const surface = document.querySelector('[data-task-presentation="workspace"]')
  const material = surface?.querySelector<HTMLElement>('[data-development-material][aria-current="page"]')?.dataset.developmentMaterial
  const position = { ...origin.developmentPosition, materialPath: material ?? useApp.getState().taskMaterialTarget ?? origin.developmentPosition.materialPath,
    scrollPositions: captureScrollPositions(surface ?? null) }
  rememberPosition(origin, position)
  useHifox.setState({ workReturn: { ...origin, developmentPosition: position } })
}

export function restoreDevelopmentScroll(origin: WorkReturnContext): void {
  const revision = useHifox.getState().developmentRevision
  const done = new Set<number>()
  let observer: MutationObserver | undefined, frame = 0
  const stop = (): void => {
    observer?.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer)
    document.removeEventListener('wheel', stop); document.removeEventListener('pointerdown', stop); document.removeEventListener('keydown', stop)
  }
  const attempt = (): void => {
    const current = useHifox.getState()
    if (current.developmentRevision !== revision || getTaskDevelopmentTarget()?.expected.contextId !== origin.local.development?.contextId) { stop(); return }
    const root = document.querySelector('[data-task-presentation="workspace"]')
    if (!root) return
    const elements = [root, ...root.querySelectorAll<HTMLElement>(scrollSelector)]
    origin.developmentPosition.scrollPositions.forEach((position, index) => {
      const element = elements[index]
      if (done.has(index) || !element) return
      element.scrollTop = position.top; element.scrollLeft = position.left
      if (Math.abs(element.scrollTop - position.top) < 1 && Math.abs(element.scrollLeft - position.left) < 1) done.add(index)
    })
    if (done.size === origin.developmentPosition.scrollPositions.length) stop()
  }
  const timer = setTimeout(stop, 5000)
  observer = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(attempt) })
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('wheel', stop, { once: true, passive: true })
  document.addEventListener('pointerdown', stop, { once: true })
  document.addEventListener('keydown', stop, { once: true })
  frame = requestAnimationFrame(attempt)
}
