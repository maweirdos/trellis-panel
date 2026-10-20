import { useEffect, useSyncExternalStore } from 'react'
import type { ApplicationDefinition, ApplicationFailure, ApplicationResult, ApplicationRuntimeEvent, ApplicationSaveInput, ApplicationSummary } from '@shared/app-runtime'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'

export type ApplicationEditor = { kind: 'new'; npm?: boolean } | { kind: 'edit' | 'remove'; definition: ApplicationDefinition }

type ApplicationProjection = {
  root: string | null
  rootKey: string | null
  generation: number
  apps: ApplicationSummary[]
  loading: boolean
  error: string | null
  busy: Record<string, string>
  errors: Record<string, string>
  editor: ApplicationEditor | null
  editorFocus: HTMLElement | null
}

const listeners = new Set<() => void>()
let state: ApplicationProjection = {
  root: null, rootKey: null, generation: 0, apps: [], loading: false,
  error: null, busy: {}, errors: {}, editor: null, editorFocus: null
}
let canonicalKey: string | null = null
let request = 0
let consumers = 0
let detachRoot: (() => void) | undefined
let detachEvents: (() => void) | undefined
const appVersions = new Map<string, number>()

function publish(patch: Partial<ApplicationProjection>): void {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

function setRoot(root: string | null): void {
  const rootKey = projectRootKey(root)
  if (rootKey === state.rootKey) return
  canonicalKey = null
  appVersions.clear()
  request += 1
  publish({ root, rootKey, generation: state.generation + 1, apps: [], loading: false, error: null, busy: {}, errors: {}, editor: null, editorFocus: null })
  if (hasIpc && root) void refreshApplications()
}

function current(generation: number): boolean {
  return consumers > 0 && generation === state.generation
}

function applyApp(app: ApplicationSummary): void {
  appVersions.set(app.definition.id, (appVersions.get(app.definition.id) ?? 0) + 1)
  const existing = state.apps.some((item) => item.definition.id === app.definition.id)
  publish({ apps: existing ? state.apps.map((item) => item.definition.id === app.definition.id ? app : item) : [...state.apps, app] })
}

function receiveEvent(event: ApplicationRuntimeEvent): void {
  const eventKey = projectRootKey(event.root)
  if (!eventKey || (eventKey !== state.rootKey && eventKey !== canonicalKey)) return
  applyApp(event.app)
}

function attach(): () => void {
  consumers += 1
  if (consumers === 1) {
    detachRoot = useApp.subscribe((next) => setRoot(next.snapshot?.meta.root ?? null))
    const previousRootKey = state.rootKey
    setRoot(useApp.getState().snapshot?.meta.root ?? null)
    if (hasIpc) {
      detachEvents = api.onAppRuntimeEvent(receiveEvent)
      if (previousRootKey === state.rootKey) void refreshApplications()
    }
  }
  return () => {
    consumers -= 1
    if (consumers === 0) {
      request += 1
      detachRoot?.()
      detachEvents?.()
      detachRoot = undefined
      detachEvents = undefined
    }
  }
}

export async function refreshApplications(): Promise<void> {
  if (!hasIpc || !state.root) return
  const root = state.root
  const generation = state.generation
  const sequence = ++request
  const versions = new Map(appVersions)
  publish({ loading: true, error: null })
  try {
    const result = await api.appRuntimeList(root)
    if (!current(generation) || sequence !== request) return
    if (result.ok === true) {
      canonicalKey = projectRootKey(result.root)
      const latest = new Map(state.apps.map((app) => [app.definition.id, app]))
      const refreshed = result.apps.map((app) => (appVersions.get(app.definition.id) ?? 0) !== (versions.get(app.definition.id) ?? 0) ? latest.get(app.definition.id) ?? app : app)
      for (const app of latest.values()) if (!refreshed.some((item) => item.definition.id === app.definition.id) && (appVersions.get(app.definition.id) ?? 0) !== (versions.get(app.definition.id) ?? 0)) refreshed.push(app)
      publish({ apps: refreshed, loading: false })
    } else publish({ loading: false, error: result.error })
  } catch {
    if (current(generation) && sequence === request) publish({ loading: false, error: '应用列表读取失败，请重试。' })
  }
}

async function operate(id: string, label: string, action: (root: string) => Promise<ApplicationResult>): Promise<ApplicationResult | null> {
  if (!hasIpc || !state.root || state.busy[id]) return null
  const generation = state.generation
  const root = state.root
  const version = appVersions.get(id) ?? 0
  publish({ busy: { ...state.busy, [id]: label }, errors: { ...state.errors, [id]: '' } })
  try {
    const result = await action(root)
    if (!current(generation)) return null
    if (result.ok === true) {
      if ((appVersions.get(id) ?? 0) === version) applyApp(result.app)
    }
    else {
      publish({ errors: { ...state.errors, [id]: result.error } })
      void refreshApplications()
    }
    return result
  } catch {
    if (current(generation)) publish({ errors: { ...state.errors, [id]: '操作未完成，请重试。' } })
    return null
  } finally {
    if (current(generation)) {
      const busy = { ...state.busy }
      delete busy[id]
      publish({ busy })
    }
  }
}

export async function runApplication(app: ApplicationSummary, action: 'start' | 'stop' | 'restart', generation: number): Promise<void> {
  if (generation !== state.generation) return
  const { id, revision } = app.definition
  const labels = { start: '正在启动', stop: '正在停止', restart: '正在重启' }
  await operate(id, labels[action], (root) => action === 'stop'
    ? api.appRuntimeStop(root, id)
    : action === 'restart' ? api.appRuntimeRestart(root, id, revision) : api.appRuntimeStart(root, id, revision))
}

export async function saveApplication(input: ApplicationSaveInput, generation: number): Promise<ApplicationFailure | null> {
  if (generation !== state.generation) return { ok: false, code: 'E_CONFLICT', error: '项目已切换，请重新打开配置。' }
  const result = await operate(input.config.id, '正在保存', (root) => api.appRuntimeSave(root, input))
  if (!current(generation)) return { ok: false, code: 'E_CONFLICT', error: '项目已切换，请重新打开配置。' }
  if (!result) return { ok: false, code: 'E_IO', error: '配置未保存，请重试。' }
  return result.ok === true ? null : result
}

export async function removeApplication(definition: ApplicationDefinition): Promise<string | null> {
  if (!hasIpc || !state.root || state.busy[definition.id]) return '当前无法删除应用。'
  const root = state.root
  const generation = state.generation
  publish({ busy: { ...state.busy, [definition.id]: '正在删除' } })
  try {
    const result = await api.appRuntimeRemove(root, definition.id, definition.revision)
    if (!current(generation)) return '项目已切换。'
    if (result.ok === false) return result.error
    request += 1
    publish({ apps: state.apps.filter((app) => app.definition.id !== definition.id), loading: false })
    return null
  } catch { return '应用未删除，请重试。' }
  finally {
    if (current(generation)) {
      const busy = { ...state.busy }
      delete busy[definition.id]
      publish({ busy })
    }
  }
}

export function openApplicationEditor(editor: ApplicationEditor, generation: number, opener?: HTMLElement): void {
  if (hasIpc && state.root && generation === state.generation) publish({ editor, editorFocus: opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null) })
}

export function closeApplicationEditor(): void { publish({ editor: null, editorFocus: null }) }

export function useApplications(): ApplicationProjection {
  const snapshot = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => state
  )
  useEffect(attach, [])
  return snapshot
}

export function applicationsGeneration(): number { return state.generation }

export function matchesApplicationRoot(root: string): boolean {
  const key = projectRootKey(root)
  return key !== null && (key === state.rootKey || key === canonicalKey)
}
