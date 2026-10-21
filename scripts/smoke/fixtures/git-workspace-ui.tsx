import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { GitWorkspaceApi, GitWorkspaceDiffResult, GitWorkspaceMutationResult, GitWorkspaceSnapshot, GitWorkspaceStatusResult } from '../../../src/shared/git-workspace'
import { GitBranchControl } from '../../../src/renderer/src/git-workspace/GitBranchControl'
import { refreshGitWorkspace } from '../../../src/renderer/src/git-workspace/useGitWorkspace'
import { dispatchEscKey } from '../../../src/renderer/src/utils/esc-layer'
import { useApp } from '../../../src/renderer/src/store'
import { useMy } from '../../../src/renderer/src/my/store'
import { setCapability } from '../../../src/renderer/src/api'

const container = document.getElementById('root')
if (!container) throw Error('Missing fixture root')
const root = createRoot(container)
const project = 'D:/fixture-git'
const other = 'D:/fixture-other'
const branch = 'codex/a-deliberately-long-branch-name-for-truncation'
const calls: Array<[string, unknown]> = []
const snapshots = new Map<string, GitWorkspaceSnapshot>()
let revision = 0
const clone = <T,>(value: T): T => structuredClone(value)
const nextRevision = (): string => (++revision).toString(16).padStart(64, '0')
const makeSnapshot = (patch: Partial<GitWorkspaceSnapshot> = {}): GitWorkspaceSnapshot => ({
  root: project, repoRoot: project, revision: nextRevision(), head: 'a'.repeat(40), branch,
  unborn: false, detached: false, clean: false,
  staged: [{ path: 'src/staged.ts', x: 'M', y: ' ' }],
  unstaged: [{ path: 'src/changed.ts', x: ' ', y: 'M' }],
  untracked: ['notes/new file.txt'], branches: [{ name: branch, current: true, upstream: 'origin/' + branch, worktree: null }, { name: 'main', current: false, upstream: 'origin/main', worktree: null }],
  remotes: [{ name: 'origin', fetchUrl: 'https://example.invalid/project.git', pushUrl: 'https://example.invalid/project.git' }],
  conflicts: false, operation: null, observedAt: 1, ...patch
})
const wait = async (test: () => unknown, label: string): Promise<void> => {
  for (let i = 0; i < 180; i++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw Error('Timed out: ' + label)
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))
const button = (label: string): HTMLButtonElement => {
  const buttons = [...document.querySelectorAll('button')]
  const node = buttons.find(item => item.getAttribute('aria-label') === label) ?? buttons.find(item => item.textContent === label)
  if (!node) throw Error('Missing button ' + label)
  return node
}
const trigger = (): HTMLButtonElement => {
  const node = document.querySelector<HTMLButtonElement>('.my-git-branch-trigger')
  if (!node) throw Error('Missing branch trigger')
  return node
}
const setField = (label: string, value: string): void => {
  const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="' + label + '"]')
  if (!node) throw Error('Missing field ' + label)
  const setter = Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw Error('Missing native field setter')
  setter.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}
const success = (snapshot: GitWorkspaceSnapshot, message: string): GitWorkspaceMutationResult => ({ ok: true, root: snapshot.root, snapshot: clone(snapshot), message })
const setRoot = (path: string | null): void => {
  // The smoke replaces this store with a small typed project fixture.
  flushSync(() => useApp.setState({ snapshot: path ? { meta: { root: path, name: 'Git fixture' } } : null }))
}
const f = {
  project, other, branch, makeSnapshot, calls, snapshots, wait, settle, button, trigger, setField,
  refresh: refreshGitWorkspace, escape: dispatchEscKey, switchRoot: setRoot,
  deferStatus: false, pendingStatus: [] as Array<{ input: { expectedRoot: string }; resolve: (result: GitWorkspaceStatusResult) => void }>,
  deferDiff: false, pendingDiff: [] as Array<{ input: { expectedRoot: string; path: string; staged: boolean }; resolve: (result: GitWorkspaceDiffResult) => void }>,
  holdAction: false, actionRelease: null as ((decision?: string) => void) | null,
  denyCommit: false, failMutation: false, statusFailure: false,
  openPanel: async (): Promise<void> => {
    trigger().click(); await wait(() => document.querySelector('[aria-label="Git 分支与操作"]'), 'branch menu')
    button('更改与提交').click(); await wait(() => document.querySelector('.my-git-workspace-panel'), 'source control')
    await settle()
  },
  mount: ({ theme = 'dark', size = 'standard', snapshot = makeSnapshot(), path = project, ipc = true }: { theme?: string; size?: string; snapshot?: GitWorkspaceSnapshot; path?: string | null; ipc?: boolean } = {}): void => {
    flushSync(() => root.render(null))
    setCapability(ipc)
    calls.length = 0; snapshots.clear(); if (path) snapshots.set(path, clone(snapshot))
    f.deferStatus = false; f.pendingStatus = []; f.deferDiff = false; f.pendingDiff = []
    f.holdAction = false; f.actionRelease = null; f.denyCommit = false; f.failMutation = false; f.statusFailure = false
    setRoot(path)
    document.documentElement.classList.toggle('dark', theme === 'dark')
    flushSync(() => root.render(<div className="my-root" data-my-theme={theme} data-my-font-size={size} style={{ height: '100%', background: 'var(--my-bg-canvas)' }}>
      <header className="my-window-header git-fixture-header"><button type="button" className="my-control">项目</button><GitBranchControl /><span className="git-fixture-header-space" /><button type="button" className="my-control">运行</button></header>
      <main className="git-fixture-body"><h1>项目工作台</h1><p>Git 按需展开，其他工具保持原位。</p></main>
    </div>))
  },
  reset: (): void => flushSync(() => root.render(null)),
  navigation: (): { page: string; toolView: string } => ({ page: useApp.getState().page, toolView: useMy.getState().toolView })
}

async function mutation<T extends { expectedRoot: string; revision: string; confirm: true }>(kind: string, input: T, change: (snapshot: GitWorkspaceSnapshot) => void): Promise<GitWorkspaceMutationResult> {
  calls.push([kind, clone(input)])
  const apply = (decision = 'approve'): GitWorkspaceMutationResult => {
    const snapshot = snapshots.get(input.expectedRoot)
    if (!snapshot) return { ok: false, code: 'E_NOT_FOUND', error: '找不到仓库' }
    if (decision === 'deny' || kind === 'commit' && f.denyCommit) return { ok: false, code: 'E_DENIED', error: '你取消了本次操作。' }
    if (f.failMutation) return { ok: false, code: 'E_CONFLICT', error: '仓库已变化，请重新查看。' }
    if (snapshot.revision !== input.revision) return { ok: false, code: 'E_CONFLICT', error: '仓库已变化，请重新查看。' }
    change(snapshot)
    snapshot.revision = nextRevision()
    snapshot.clean = snapshot.staged.length + snapshot.unstaged.length + snapshot.untracked.length === 0
    return success(snapshot, kind + ' 已完成')
  }
  if (f.holdAction) return new Promise(resolve => { f.actionRelease = decision => resolve(apply(decision)) })
  return apply()
}

// No native IPC or Git executable is reachable from this bridge.
const bridge: GitWorkspaceApi = {
  status: async input => {
    calls.push(['status', clone(input)])
    if (f.deferStatus) return new Promise(resolve => f.pendingStatus.push({ input, resolve }))
    if (f.statusFailure) return { ok: false, code: 'E_NOT_FOUND', error: '当前项目不是 Git 仓库。' }
    const snapshot = snapshots.get(input.expectedRoot)
    return snapshot ? { ok: true, root: input.expectedRoot, snapshot: clone(snapshot) } : { ok: false, code: 'E_NOT_FOUND', error: '找不到仓库' }
  },
  diff: async input => {
    calls.push(['diff', clone(input)])
    if (f.deferDiff) return new Promise(resolve => f.pendingDiff.push({ input, resolve }))
    return { ok: true, root: input.expectedRoot, path: input.path, staged: input.staged, added: 2, removed: 1, binary: false, truncated: true, diff: 'diff --git a/src/changed.ts b/src/changed.ts\n--- a/src/changed.ts\n+++ b/src/changed.ts\n@@ -1 +1 @@\n-before\n+after\n+bounded preview\n' + Array.from({ length: 30 }, (_, i) => '+line ' + i).join('\n') }
  },
  stage: input => mutation('stage', input, snapshot => {
    for (const path of input.paths) {
      snapshot.unstaged = snapshot.unstaged.filter(item => item.path !== path)
      snapshot.untracked = snapshot.untracked.filter(item => item !== path)
      if (!snapshot.staged.some(item => item.path === path)) snapshot.staged.push({ path, x: 'M', y: ' ' })
    }
  }),
  unstage: input => mutation('unstage', input, snapshot => {
    for (const path of input.paths) {
      snapshot.staged = snapshot.staged.filter(item => item.path !== path)
      if (!snapshot.unstaged.some(item => item.path === path)) snapshot.unstaged.push({ path, x: ' ', y: 'M' })
    }
  }),
  commit: input => mutation('commit', input, snapshot => { snapshot.staged = [] }),
  createBranch: input => mutation('createBranch', input, snapshot => {
    snapshot.branches.push({ name: input.name, current: false, upstream: null, worktree: null })
    if (input.switchAfter) { snapshot.branch = input.name; snapshot.branches.forEach(item => { item.current = item.name === input.name }) }
  }),
  switchBranch: input => mutation('switchBranch', input, snapshot => { snapshot.branch = input.name; snapshot.branches.forEach(item => { item.current = item.name === input.name }) }),
  push: input => mutation('push', input, () => {})
}

Object.assign(window, { gitWorkspaceFixture: f, __gitWorkspaceApi: bridge })
window.addEventListener('keydown', event => { if (event.key === 'Escape' && dispatchEscKey()) event.preventDefault() })
f.mount()
