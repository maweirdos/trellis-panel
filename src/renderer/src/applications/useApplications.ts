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
  selectedId: string | null
  dockOpen: boolean
  dockTabs: string[]
  dockHeight: number | null
}

const listeners = new Set<() => void>()
let state: ApplicationProjection = {
  root: null, rootKey: null, generation: 0, apps: [], loading: false,
  error: null, busy: {}, errors: {}, editor: null, editorFocus: null,
  selectedId: null, dockOpen: false, dockTabs: [], dockHeight: null
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

type RunPreferences = { selectedId: string | null; dockHeight: number | null }
function preferenceKey(rootKey: string): string { return `tpanel.my.run.v1:${encodeURIComponent(rootKey)}` }
function readPreferences(rootKey: string | null): RunPreferences {
  if (!rootKey) return { selectedId: null, dockHeight: null }
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(preferenceKey(rootKey)) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) return { selectedId: null, dockHeight: null }
    const value = parsed as Record<string, unknown>
    return { selectedId: typeof value.selectedId === 'string' && value.selectedId.length <= 80 ? value.selectedId : null, dockHeight: typeof value.dockHeight === 'number' && Number.isFinite(value.dockHeight) && value.dockHeight > 0 ? value.dockHeight : null }
  } catch { return { selectedId: null, dockHeight: null } }
}
function writePreferences(): void {
  if (!state.rootKey) return
  try { localStorage.setItem(preferenceKey(state.rootKey), JSON.stringify({ selectedId: state.selectedId, dockHeight: state.dockHeight })) }
  catch { /* Presentation still works when local storage is unavailable. */ }
}
function reconcilePresentation(apps: ApplicationSummary[]): Pick<ApplicationProjection, 'selectedId' | 'dockTabs'> {
  const ids = new Set(apps.map((app) => app.definition.id))
  return { selectedId: state.selectedId && ids.has(state.selectedId) ? state.selectedId : apps[0]?.definition.id ?? null, dockTabs: state.dockTabs.filter((id) => ids.has(id)) }
}

function setRoot(root: string | null): void {
  const rootKey = projectRootKey(root)
  if (rootKey === state.rootKey) return
  canonicalKey = null
  appVersions.clear()
  request += 1
  publish({ root, rootKey, generation: state.generation + 1, apps: [], loading: false, error: null, busy: {}, errors: {}, editor: null, editorFocus: null, ...readPreferences(rootKey), dockOpen: false, dockTabs: [] })
  if (hasIpc && root) void refreshApplications()
}

function current(generation: number): boolean {
  return consumers > 0 && generation === state.generation
}

function applyApp(app: ApplicationSummary): void {
  appVersions.set(app.definition.id, (appVersions.get(app.definition.id) ?? 0) + 1)
  const existing = state.apps.some((item) => item.definition.id === app.definition.id)
  const apps = existing ? state.apps.map((item) => item.definition.id === app.definition.id ? app : item) : [...state.apps, app]
  publish({ apps, ...reconcilePresentation(apps) })
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
      // A later same-root mount is a new projection owner, not an old action's recipient.
      publish({ generation: state.generation + 1, loading: false, busy: {}, editor: null, editorFocus: null, dockOpen: false, dockTabs: [] })
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
      publish({ apps: refreshed, loading: false, ...reconcilePresentation(refreshed) })
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
  if (action !== 'stop') showApplicationOutput(id, generation)
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
    const apps = state.apps.filter((app) => app.definition.id !== definition.id)
    publish({ apps, loading: false, ...reconcilePresentation(apps) })
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

export function selectApplication(id: string, generation: number): void {
  if (generation !== state.generation || !state.apps.some((app) => app.definition.id === id)) return
  publish({ selectedId: id })
  writePreferences()
}
export function showApplicationOutput(id: string, generation: number): void {
  if (generation !== state.generation || !state.apps.some((app) => app.definition.id === id)) return
  publish({ selectedId: id, dockOpen: true, dockTabs: state.dockTabs.includes(id) ? state.dockTabs : [...state.dockTabs, id] })
  writePreferences()
}
export function closeApplicationOutput(id?: string): void {
  if (!id) { publish({ dockOpen: false }); return }
  const dockTabs = state.dockTabs.filter((tab) => tab !== id)
  publish({ dockTabs, dockOpen: dockTabs.length > 0 })
}
export function setApplicationDockHeight(height: number): void {
  if (!Number.isFinite(height) || height <= 0) return
  publish({ dockHeight: height })
  writePreferences()
}
export async function runConfiguredApplication(id: string, action: 'start' | 'stop' | 'restart', generation: number): Promise<void> {
  if (generation !== state.generation) return
  const app = state.apps.find((candidate) => candidate.definition.id === id)
  if (app) await runApplication(app, action, generation)
}

export function applicationById(id: string): ApplicationSummary | null { return state.apps.find((app) => app.definition.id === id) ?? null }
