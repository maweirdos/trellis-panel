import { useEffect, useSyncExternalStore } from 'react'
import type { GitWorkspaceApi, GitWorkspaceMutationResult, GitWorkspaceSnapshot } from '@shared/git-workspace'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'

export interface GitWorkspaceState {
  root: string | null
  generation: number
  snapshot: GitWorkspaceSnapshot | null
  loading: boolean
  busy: string | null
  error: string | null
  errorCode: string | null
  notice: string | null
  panelOpen: boolean
}

export interface GitActionScope { root: string; generation: number; revision: string }
type MutationScope = { expectedRoot: string; revision: string; confirm: true }

let state: GitWorkspaceState = { root: null, generation: 0, snapshot: null, loading: false, busy: null, error: null, errorCode: null, notice: null, panelOpen: false }
const listeners = new Set<() => void>()
let consumers = 0
let sequence = 0
let applied = 0
let releaseRoot: (() => void) | undefined

function publish(patch: Partial<GitWorkspaceState>): void {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export function hasGitWorkspace(): boolean {
  return hasIpc && typeof api.gitWorkspace?.status === 'function'
}

function sameOwner(generation: number): boolean { return consumers > 0 && state.generation === generation }

function setRoot(root: string | null): void {
  if (projectRootKey(root) === projectRootKey(state.root)) return
  sequence += 1
  applied += 1
  publish({ root, generation: state.generation + 1, snapshot: null, loading: false, busy: null, error: null, errorCode: null, notice: null, panelOpen: false })
  if (root && hasGitWorkspace()) void refreshGitWorkspace()
}

export function gitWorkspaceGeneration(): number { return state.generation }

export function gitActionScope(): GitActionScope | null {
  return state.root && state.snapshot ? { root: state.root, revision: state.snapshot.revision, generation: state.generation } : null
}

export function openGitWorkspace(): void { publish({ panelOpen: true }) }
export function closeGitWorkspace(): void { publish({ panelOpen: false }) }

export async function refreshGitWorkspace(preserveFeedback = false): Promise<void> {
  if (!state.root || !hasGitWorkspace() || state.busy) return
  const root = state.root
  const generation = state.generation
  const request = ++sequence
  const revision = applied
  publish({ loading: true })
  try {
    const result = await api.gitWorkspace.status({ expectedRoot: root })
    if (!sameOwner(generation) || request !== sequence || revision !== applied) return
    if (result.ok === true) {
      if (projectRootKey(result.root) !== projectRootKey(root) || projectRootKey(result.snapshot.root) !== projectRootKey(root)) {
        publish({ error: 'Git 响应与当前项目不匹配，请刷新。', errorCode: 'E_CONFLICT', loading: false })
        return
      }
      applied += 1
      publish({ snapshot: result.snapshot, loading: false, ...(preserveFeedback ? {} : { error: null, errorCode: null }) })
    } else publish({ snapshot: null, loading: false, error: result.error, errorCode: result.code })
  } catch {
    if (sameOwner(generation) && request === sequence) publish({ loading: false, error: 'Git 状态读取失败，请重试。', errorCode: 'E_IO' })
  }
}

export async function runGitMutation(
  scope: GitActionScope,
  label: string,
  operation: (bridge: GitWorkspaceApi, input: MutationScope) => Promise<GitWorkspaceMutationResult>
): Promise<boolean> {
  if (!sameOwner(scope.generation) || projectRootKey(scope.root) !== projectRootKey(state.root) || !hasGitWorkspace() || state.busy) return false
  if (state.snapshot?.revision !== scope.revision) {
    publish({ error: 'Git 状态已变化，请重新查看后操作。', errorCode: 'E_CONFLICT' })
    return false
  }
  sequence += 1
  applied += 1
  publish({ busy: label, loading: false, error: null, errorCode: null, notice: null })
  try {
    const result = await operation(api.gitWorkspace, { expectedRoot: scope.root, revision: scope.revision, confirm: true })
    if (!sameOwner(scope.generation)) return false
    if (result.ok === true) {
      if (projectRootKey(result.root) !== projectRootKey(scope.root) || projectRootKey(result.snapshot.root) !== projectRootKey(scope.root)) {
        publish({ error: '操作响应与当前项目不匹配，请核验实际结果。', errorCode: 'E_CONFLICT' })
        return false
      }
      applied += 1
      publish({ snapshot: result.snapshot, notice: result.message, error: null, errorCode: null })
      return true
    }
    const suffix = result.uncertain ? ' 操作结果尚未确认，请刷新后核验。' : result.mutationCompleted ? ' 操作已产生变更，请核验后继续。' : ''
    publish({ error: result.error + suffix, errorCode: result.code, notice: result.committed ? `提交 ${result.committed.slice(0, 12)} 已生成。` : null })
    return false
  } catch {
    if (sameOwner(scope.generation)) publish({ error: '操作未能确认完成，请刷新 Git 状态后核验。', errorCode: 'E_IO' })
    return false
  } finally {
    if (sameOwner(scope.generation)) {
      publish({ busy: null })
      void refreshGitWorkspace(true)
    }
  }
}

function attach(): () => void {
  consumers += 1
  if (consumers === 1) {
    releaseRoot = useApp.subscribe((next) => setRoot(next.snapshot?.meta.root ?? null))
    const previousGeneration = state.generation
    setRoot(useApp.getState().snapshot?.meta.root ?? null)
    if (!hasGitWorkspace()) publish({ snapshot: null, loading: false, error: null, errorCode: null, notice: null })
    if (previousGeneration === state.generation) void refreshGitWorkspace()
    window.addEventListener('focus', refreshOnFocus)
  }
  return () => {
    consumers -= 1
    if (consumers === 0) {
      sequence += 1
      releaseRoot?.()
      releaseRoot = undefined
      window.removeEventListener('focus', refreshOnFocus)
      publish({ generation: state.generation + 1, busy: null, loading: false, panelOpen: false })
    }
  }
}

function refreshOnFocus(): void { void refreshGitWorkspace() }

export function useGitWorkspace(): GitWorkspaceState {
  useEffect(attach, [])
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener) }, () => state)
}
