import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Check, ChevronDown, FileDiff, GitBranch, GitCommitHorizontal, History, Loader2, Minus, Plus, RefreshCw, Upload, X } from 'lucide-react'
import type { GitWorkspaceBranch, GitWorkspaceChange, GitWorkspaceSnapshot } from '@shared/git-workspace'
import type { GitReadonlyFileDiff } from '@shared/types'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { projectRootKey } from '../my/navigation'
import { computeInlineLineDiffs, InlineDiffText } from '../my/git/inline-diff'
import { patchRows } from '../my/git/patch'
import { Button, Checkbox, Dropdown, Modal, Tooltip } from '../my/ui'
import { Select } from '../components/Select'
import { useEscLayer } from '../utils/use-esc-layer'
import { closeGitWorkspace, gitActionScope, gitWorkspaceGeneration, hasGitWorkspace, openGitWorkspace, refreshGitWorkspace, runGitMutation, useGitWorkspace, type GitActionScope } from './useGitWorkspace'

type BranchDialog = ({ kind: 'create'; scope: GitActionScope } | { kind: 'switch'; scope: GitActionScope; branch: GitWorkspaceBranch } | { kind: 'push'; scope: GitActionScope }) & { opener?: HTMLElement }
const STATUS: Record<string, string> = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型变更', U: '冲突', '?': '未跟踪' }

function branchLabel(snapshot: GitWorkspaceSnapshot | null, errorCode: string | null): string {
  if (!snapshot) return errorCode === 'E_NOT_FOUND' ? '非 Git 仓库' : errorCode ? 'Git 不可用' : 'Git'
  if (snapshot.detached) return `分离 HEAD · ${snapshot.head?.slice(0, 8) ?? '未知'}`
  if (snapshot.unborn) return `${snapshot.branch ?? '分支'} · 尚无提交`
  return snapshot.branch ?? 'Git'
}

function history(): void {
  closeGitWorkspace()
  useMy.getState().setToolView('git')
  useApp.getState().setPage('devtools')
}

function pushDefaults(snapshot: GitWorkspaceSnapshot | null): { remote: string; branch: string; hasUpstream: boolean } {
  const upstream = snapshot?.branches.find((branch) => branch.current)?.upstream
  const tracked = upstream ? snapshot?.remotes.filter((remote) => upstream.startsWith(remote.name + '/')).sort((a, b) => b.name.length - a.name.length)[0] : undefined
  return { remote: tracked?.name ?? snapshot?.remotes[0]?.name ?? '', branch: tracked && upstream ? upstream.slice(tracked.name.length + 1) : snapshot?.branch ?? '', hasUpstream: Boolean(upstream) }
}

function GitFeedback(): JSX.Element | null {
  const state = useGitWorkspace()
  if (!state.error && !state.notice && !state.busy) return null
  return <div className="my-git-workspace-feedback">
    {state.busy && <p role="status" className="flex items-center gap-2 text-my-xs text-my-secondary"><Loader2 size={13} className="animate-spin" />{state.busy}</p>}
    {state.notice && <p role="status" className="break-words text-my-xs text-my-secondary">{state.notice}</p>}
    {state.error && <p role="alert" className="break-words text-my-xs text-my-danger-text">{state.error}</p>}
  </div>
}

function BranchForms({ dialog, onClose }: { dialog: BranchDialog | null; onClose: () => void }): JSX.Element | null {
  const state = useGitWorkspace()
  const [name, setName] = useState('')
  const [switchAfter, setSwitchAfter] = useState(false)
  const [remote, setRemote] = useState('')
  const [remoteBranch, setRemoteBranch] = useState('')
  const [setUpstream, setSetUpstream] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const snapshot = state.snapshot
  useEffect(() => {
    const defaults = pushDefaults(snapshot)
    setName(''); setError(null)
    setSwitchAfter(Boolean(snapshot?.clean && snapshot.head))
    setRemote(defaults.remote)
    setRemoteBranch(defaults.branch)
    setSetUpstream(!defaults.hasUpstream)
  }, [dialog])
  if (!dialog || !snapshot || dialog.scope.generation !== state.generation) return null
  const stale = dialog.scope.revision !== snapshot.revision
  const blocked = Boolean(state.busy) || stale
  const title = dialog.kind === 'create' ? '创建分支' : dialog.kind === 'switch' ? '切换分支' : '推送'
  const submit = async (): Promise<void> => {
    setError(null)
    if (stale) { setError('Git 状态已变化，请关闭后重新操作。'); return }
    const success = dialog.kind === 'create'
      ? await runGitMutation(dialog.scope, '正在创建分支…', (bridge, input) => bridge.createBranch({ ...input, name: name.trim(), switchAfter }))
      : dialog.kind === 'switch'
        ? await runGitMutation(dialog.scope, '正在切换分支…', (bridge, input) => bridge.switchBranch({ ...input, name: dialog.branch.name }))
        : await runGitMutation(dialog.scope, '正在推送…', (bridge, input) => bridge.push({ ...input, remote, branch: snapshot.branch ?? '', remoteBranch: remoteBranch.trim(), setUpstream }))
    if (success && dialog.scope.generation === gitWorkspaceGeneration()) onClose()
  }
  return <Modal open placement="center" onClose={onClose} ariaLabel={title}>
    <div className="my-git-workspace-form my-scrollbar">
      <header className="flex items-center gap-3"><h2 className="min-w-0 flex-1 text-my-lg font-medium text-my-primary">{title}</h2><button type="button" className="my-icon-control" aria-label={`关闭${title}`} onClick={onClose}><X size={16} /></button></header>
      {dialog.kind === 'create' && <>
        <label className="my-git-workspace-field"><span>分支名称</span><input className="my-input" aria-label="分支名称" value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(state.busy)} placeholder="例如 feature/search" /></label>
        <p className="break-words text-my-xs text-my-secondary">基于当前提交 {snapshot.head?.slice(0, 12) ?? '尚无提交'} 创建。</p>
        <label className="flex items-center gap-2 text-my-sm text-my-secondary"><Checkbox checked={switchAfter} onChange={(checked) => setSwitchAfter(checked)} disabled={!snapshot.clean || Boolean(state.busy)} />创建后切换</label>
        {!snapshot.clean && <p className="text-my-xs text-my-tertiary">工作区有未提交更改，可先创建分支，处理更改后再切换。</p>}
      </>}
      {dialog.kind === 'switch' && <>
        <p className="break-words text-my-sm text-my-primary">切换到 <strong>{dialog.branch.name}</strong>？</p>
        <p className="text-my-xs text-my-secondary">当前分支：{snapshot.branch ?? '分离 HEAD'}</p>
        {!snapshot.clean && <p role="alert" className="text-my-xs text-my-warning-text">工作区存在未提交更改，请先处理更改。</p>}
      </>}
      {dialog.kind === 'push' && <>
        <p className="break-words text-my-sm text-my-secondary">本地分支：{snapshot.branch ?? '分离 HEAD'}</p>
        <p className="break-words text-my-xs text-my-tertiary">上游：{snapshot.branches.find((branch) => branch.current)?.upstream ?? '未配置'}</p>
        <label className="my-git-workspace-field"><span>远端</span><Select ariaLabel="推送远端" value={remote} onChange={setRemote} options={snapshot.remotes.map((item) => ({ value: item.name, label: item.name }))} className="w-full" disabled={Boolean(state.busy)} /></label>
        <p className="break-words font-mono text-my-xs text-my-tertiary">{snapshot.remotes.find((item) => item.name === remote)?.pushUrl || '尚未配置远端'}</p>
        <label className="my-git-workspace-field"><span>远端分支</span><input className="my-input" aria-label="远端分支" value={remoteBranch} onChange={(event) => setRemoteBranch(event.target.value)} disabled={Boolean(state.busy)} /></label>
        <label className="flex items-center gap-2 text-my-sm text-my-secondary"><Checkbox checked={setUpstream} onChange={(checked) => setSetUpstream(checked)} disabled={Boolean(state.busy)} />设置为当前分支的上游</label>
      </>}
      {stale && <p role="alert" className="text-my-xs text-my-warning-text">Git 状态已变化，请关闭后重新查看。</p>}
      {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
      <GitFeedback />
      <footer className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" disabled={blocked || (dialog.kind === 'create' && (!name.trim() || !snapshot.head)) || (dialog.kind === 'switch' && !snapshot.clean) || (dialog.kind === 'push' && (!remote || !remoteBranch.trim() || !snapshot.branch))} onClick={() => void submit()}>{state.busy ? <Loader2 size={14} className="animate-spin" /> : null}{title}</Button></footer>
    </div>
  </Modal>
}

type SelectedFile = { path: string; staged: boolean; untracked?: boolean }

function WorkspaceDiff({ file, generation, root }: { file: SelectedFile; generation: number; root: string }): JSX.Element {
  const section = useRef<HTMLElement>(null)
  const [result, setResult] = useState<GitReadonlyFileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  useEffect(() => {
    if (result || error || file.untracked) section.current?.scrollIntoView({ block: 'start' })
  }, [result, error, file.untracked])
  useEffect(() => {
    const sequence = ++request.current
    setResult(null); setError(null)
    if (file.untracked) { setLoading(false); return }
    setLoading(true)
    void api.gitWorkspace.diff({ expectedRoot: root, path: file.path, staged: file.staged }).then((response) => {
      if (sequence !== request.current || generation !== gitWorkspaceGeneration()) return
      if (!response.ok) setError(response.error ?? '无法读取差异')
      else if (response.path !== file.path || response.staged !== file.staged || projectRootKey(response.root) !== projectRootKey(root)) setError('差异响应与所选项目或文件不匹配，请重新选择。')
      else setResult(response)
    }).catch(() => { if (sequence === request.current && generation === gitWorkspaceGeneration()) setError('差异读取失败，请重试。') })
      .finally(() => { if (sequence === request.current && generation === gitWorkspaceGeneration()) setLoading(false) })
    return () => { request.current += 1 }
  }, [file.path, file.staged, file.untracked, generation, root])
  const parsed = useMemo(() => {
    if (!result || result.binary || !result.diff) return null
    const rows = patchRows(result.diff)
    let added = 0
    let removed = 0
    for (const row of rows) {
      if (row.kind === 'add') added += 1
      else if (row.kind === 'remove') removed += 1
    }
    const inlineSegments = computeInlineLineDiffs(
      rows.map((row) => ({
        kind: row.kind === 'add' ? 'add' : row.kind === 'remove' ? 'remove' : 'other',
        text: row.kind === 'add' || row.kind === 'remove' ? row.text.slice(1) : row.text
      }))
    )
    return { rows, added, removed, inlineSegments }
  }, [result])
  return <section ref={section} className="my-git-workspace-diff" aria-label={`差异 ${file.path}`}>
    <header className="my-git-workspace-diff-header">
      <span className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary" title={file.path}>{file.path}</span>
      {parsed && (parsed.added > 0 || parsed.removed > 0) && (
        <span className="flex shrink-0 items-center gap-1 font-mono text-my-2xs tabular-nums">
          {parsed.added > 0 && <span className="rounded-my-full bg-my-success-subtle px-1.5 py-0.5 text-my-success-text">+{parsed.added}</span>}
          {parsed.removed > 0 && <span className="rounded-my-full bg-my-danger-subtle px-1.5 py-0.5 text-my-danger-text">−{parsed.removed}</span>}
        </span>
      )}
    </header>
    {loading && <p role="status" className="px-3 py-2 text-my-xs text-my-tertiary"><span className="my-shimmer-text">正在读取差异…</span></p>}
    {error && <p role="alert" className="px-3 py-2 text-my-xs text-my-danger-text">{error}</p>}
    {file.untracked && <p className="px-3 py-2 text-my-xs text-my-tertiary">新文件尚无 Git 基线，暂存后可查看添加内容。</p>}
    {result?.binary && <p className="px-3 py-2 text-my-xs text-my-secondary">二进制文件，未显示文本差异。</p>}
    {result?.truncated && <p role="status" className="px-3 py-2 text-my-xs text-my-warning-text">差异过长，已截断。</p>}
    {result && !result.binary && (parsed && parsed.rows.length > 0 ? (
      <div className="my-git-workspace-diff-lines my-scrollbar" tabIndex={0} aria-label="文件文本差异">
        {parsed.rows.map((row, index) => {
          const prefix = row.kind === 'add' || row.kind === 'remove' ? row.text.slice(0, 1) : ''
          const content = prefix ? row.text.slice(1) : row.text
          const rowClass =
            row.kind === 'add'
              ? 'my-git-workspace-diff-add'
              : row.kind === 'remove'
                ? 'my-git-workspace-diff-remove'
                : row.kind === 'hunk'
                  ? 'my-git-workspace-diff-hunk'
                  : row.kind === 'meta'
                    ? 'my-git-workspace-diff-meta'
                    : undefined
          return (
            <div key={index} className={rowClass ? `my-git-workspace-diff-row ${rowClass}` : 'my-git-workspace-diff-row'}>
              <span className="my-git-workspace-diff-num" aria-hidden="true">{row.a}</span>
              <span className="my-git-workspace-diff-num" aria-hidden="true">{row.b}</span>
              <code>
                {prefix}
                {row.kind === 'add' || row.kind === 'remove' ? (
                  <InlineDiffText segments={parsed.inlineSegments[index]} fallback={content || ' '} tone={row.kind} />
                ) : (
                  row.text || ' '
                )}
              </code>
            </div>
          )
        })}
      </div>
    ) : <p className="px-3 py-2 text-my-xs text-my-tertiary">无文本差异。</p>)}
  </section>
}

function FileGroup({ title, entries, selected, onToggle, onSelect, staged, busy }: { title: string; entries: Array<GitWorkspaceChange & { untracked?: boolean }>; selected: Set<string>; onToggle: (path: string) => void; onSelect: (file: SelectedFile) => void; staged: boolean; busy: boolean }): JSX.Element {
  return <section className="my-git-workspace-files" aria-label={title}>
    <h3 className="my-git-workspace-file-heading">{title}<span className="tabular-nums text-my-tertiary">{entries.length}</span></h3>
    {entries.length === 0 ? <p className="px-3 pb-2 text-my-xs text-my-tertiary">无更改</p> : <ul>{entries.map((entry) => <li key={entry.path} className="my-git-workspace-file-row">
      <Checkbox disabled={busy} checked={selected.has(entry.path)} onChange={() => onToggle(entry.path)} aria-label={`选择${staged ? '暂存' : '工作区'}文件 ${entry.path}`} />
      <button type="button" className="my-git-workspace-file-button" aria-label={`查看${staged ? '暂存' : '工作区'}差异 ${entry.path}`} onClick={() => onSelect({ path: entry.path, staged, untracked: entry.untracked })} title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}>
        <FileDiff size={13} className="shrink-0 text-my-icon-tertiary" /><span className="min-w-0 flex-1 truncate font-mono text-my-xs">{entry.path}</span><span className="shrink-0 text-my-2xs text-my-tertiary">{STATUS[staged ? entry.x : entry.y] ?? '更改'}</span>
      </button>
    </li>)}</ul>}
  </section>
}

function SourceControlPanel({ trigger, onBranchDialog }: { trigger: RefObject<HTMLButtonElement | null>; onBranchDialog: (dialog: BranchDialog) => void }): JSX.Element | null {
  const state = useGitWorkspace()
  const id = useId()
  const panel = useRef<HTMLElement>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const [portal, setPortal] = useState<HTMLElement | null>(null)
  const [worktreeSelection, setWorktreeSelection] = useState<Set<string>>(new Set())
  const [indexSelection, setIndexSelection] = useState<Set<string>>(new Set())
  const [file, setFile] = useState<SelectedFile | null>(null)
  const [message, setMessage] = useState('')
  const snapshot = state.snapshot
  useEscLayer(state.panelOpen, { kind: 'overlay', id: `git-workspace-${id}`, onClose: closeGitWorkspace, returnFocusRef: trigger })
  useEffect(() => { setPortal(anchor.current?.closest<HTMLElement>('.my-root') ?? null) }, [])
  useEffect(() => {
    setWorktreeSelection(new Set()); setIndexSelection(new Set()); setFile(null)
  }, [snapshot?.revision])
  useLayoutEffect(() => {
    if (state.panelOpen && portal) panel.current?.focus({ preventScroll: true })
  }, [state.panelOpen, portal])
  const close = (): void => { closeGitWorkspace(); if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }) }
  const toggle = (setter: (value: Set<string> | ((current: Set<string>) => Set<string>)) => void, path: string): void => setter((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })
  const stage = async (staged: boolean): Promise<void> => {
    const scope = gitActionScope()
    if (!scope) return
    const paths = [...(staged ? indexSelection : worktreeSelection)]
    const success = await runGitMutation(scope, staged ? '正在取消暂存…' : '正在暂存…', (bridge, input) => staged ? bridge.unstage({ ...input, paths }) : bridge.stage({ ...input, paths }))
    if (success && scope.generation === gitWorkspaceGeneration()) { setWorktreeSelection(new Set()); setIndexSelection(new Set()) }
  }
  const commit = async (): Promise<void> => {
    const scope = gitActionScope()
    if (!scope || !message.trim()) return
    const success = await runGitMutation(scope, '正在提交暂存内容…', (bridge, input) => bridge.commit({ ...input, message }))
    if (success && scope.generation === gitWorkspaceGeneration()) setMessage('')
  }
  const push = (opener: HTMLButtonElement): void => { const scope = gitActionScope(); if (scope) { opener.focus({ preventScroll: true }); onBranchDialog({ kind: 'push', scope, opener }) } }
  return <><span ref={anchor} hidden />{state.panelOpen && portal && createPortal(<aside ref={panel} role="dialog" aria-label="更改与提交" tabIndex={-1} className="my-git-workspace-panel my-scrollbar no-drag">
    <header className="my-git-workspace-panel-header"><div className="min-w-0 flex-1"><h2 className="text-my-sm font-medium text-my-primary">更改与提交</h2><p className="truncate font-mono text-my-xs text-my-tertiary" title={snapshot?.branch ?? state.root ?? ''}>{branchLabel(snapshot, state.errorCode)}</p></div><Tooltip label="刷新 Git 状态"><button type="button" className="my-icon-control" aria-label="刷新 Git 状态" disabled={state.loading || Boolean(state.busy) || !state.root || !hasGitWorkspace()} onClick={() => void refreshGitWorkspace()}><RefreshCw size={14} className={state.loading ? 'animate-spin' : undefined} /></button></Tooltip><button type="button" className="my-icon-control" aria-label="关闭更改面板" onClick={close}><X size={15} /></button></header>
    <GitFeedback />
    {!hasGitWorkspace() ? <p className="my-git-workspace-empty">{hasIpc ? '当前桥接不支持 Git 操作，请重新启动应用。' : '桌面端可查看项目 Git 并执行手动操作。'}</p> : !state.root ? <p className="my-git-workspace-empty">选择项目后查看更改。</p> : state.loading && !snapshot ? <p className="my-git-workspace-empty" role="status">正在读取 Git 状态…</p> : snapshot ? <>
      {snapshot.operation && <p role="alert" className="px-3 py-2 text-my-xs text-my-warning-text">仓库正在执行 {snapshot.operation}，请先完成该操作。</p>}
      {snapshot.conflicts && <p role="alert" className="px-3 py-2 text-my-xs text-my-warning-text">存在未解决的冲突。</p>}
      <div className="my-git-workspace-changes my-scrollbar">
        <FileGroup title="更改" staged={false} entries={[...snapshot.unstaged, ...snapshot.untracked.map((path) => ({ path, x: '?', y: '?', untracked: true }))]} selected={worktreeSelection} onToggle={(path) => toggle(setWorktreeSelection, path)} onSelect={setFile} busy={Boolean(state.busy)} />
        <div className="flex flex-wrap gap-1.5 px-3 py-2"><Button size="sm" variant="outline" disabled={!worktreeSelection.size || Boolean(state.busy) || Boolean(snapshot.operation)} onClick={() => void stage(false)}><Plus size={12} />暂存所选</Button><Button size="sm" variant="ghost" disabled={!snapshot.unstaged.length && !snapshot.untracked.length || Boolean(state.busy)} onClick={() => setWorktreeSelection(new Set([...snapshot.unstaged.map((entry) => entry.path), ...snapshot.untracked]))}>选择全部更改</Button></div>
        <FileGroup title="暂存内容" staged entries={snapshot.staged} selected={indexSelection} onToggle={(path) => toggle(setIndexSelection, path)} onSelect={setFile} busy={Boolean(state.busy)} />
        <div className="flex flex-wrap gap-1.5 px-3 py-2"><Button size="sm" variant="ghost" disabled={!indexSelection.size || Boolean(state.busy) || Boolean(snapshot.operation)} onClick={() => void stage(true)}><Minus size={12} />取消暂存所选</Button></div>
        {file && state.root && <WorkspaceDiff key={`${state.generation}:${snapshot.revision}:${file.path}:${file.staged}`} file={file} generation={state.generation} root={state.root} />}
      </div>
      <form className="my-git-workspace-commit" onSubmit={(event) => { event.preventDefault(); void commit() }}>
        <label htmlFor={`${id}-message`} className="text-my-xs font-medium text-my-secondary">提交说明</label>
        <textarea id={`${id}-message`} className="my-input my-scrollbar" aria-label="提交说明" value={message} onChange={(event) => setMessage(event.target.value)} disabled={Boolean(state.busy)} placeholder="说明这次更改…" rows={4} />
        <div className="flex flex-wrap items-center gap-2"><Button variant="primary" size="sm" disabled={!message.trim() || snapshot.staged.length === 0 || snapshot.conflicts || Boolean(snapshot.operation) || Boolean(state.busy)} onClick={() => void commit()}><GitCommitHorizontal size={13} />提交暂存内容</Button><Button variant="outline" size="sm" disabled={!snapshot.head || !snapshot.branch || !snapshot.remotes.length || Boolean(state.busy)} onClick={(event) => push(event.currentTarget)}><Upload size={13} />推送…</Button><span className="ml-auto text-my-2xs tabular-nums text-my-tertiary">{snapshot.staged.length} 个暂存文件</span></div>
      </form>
    </> : null}
    <footer className="my-git-workspace-panel-footer"><button type="button" className="my-control my-control-sm text-my-secondary" onClick={history}>查看工作区与历史<ArrowUpRight size={12} /></button></footer>
  </aside>, portal)}</>
}

function GitBranchSession(): JSX.Element {
  const state = useGitWorkspace()
  const trigger = useRef<HTMLButtonElement>(null)
  const returnAfterDialog = useRef<HTMLElement | null>(null)
  const [dialog, setDialog] = useState<BranchDialog | null>(null)
  useEffect(() => {
    if (dialog) return
    const opener = returnAfterDialog.current
    returnAfterDialog.current = null
    if (opener?.isConnected) opener.focus({ preventScroll: true })
  }, [dialog])
  const snapshot = state.snapshot
  const label = branchLabel(snapshot, state.errorCode)
  const changed = snapshot ? new Set([...snapshot.staged.map((entry) => entry.path), ...snapshot.unstaged.map((entry) => entry.path), ...snapshot.untracked]).size : 0
  const openCreate = (): void => { const scope = gitActionScope(); if (scope) setDialog({ kind: 'create', scope }) }
  return <>
    <Dropdown className="my-git-branch-control no-drag" align="left" placement="bottom" layoutKey={`${state.generation}:${snapshot?.revision ?? ''}`} trigger={({ open, toggle: toggleMenu }) =>
      <button ref={trigger} type="button" className="my-control my-button-ghost my-git-branch-trigger" aria-label={`Git 分支：${label}${state.busy ? `，${state.busy}` : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={toggleMenu} title={state.busy ? `${label} · ${state.busy}` : label}>
        {state.busy || state.loading ? <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden="true" /> : <GitBranch size={15} strokeWidth={1.7} className="shrink-0" aria-hidden="true" />}<span className="my-git-branch-name">{label}</span>{changed > 0 && <span className="my-git-branch-count text-my-2xs tabular-nums">{changed}</span>}<ChevronDown size={12} className="shrink-0 text-my-icon-tertiary" />
      </button>
    }>
      {(close) => <div role="dialog" aria-label="Git 分支与操作" className="my-git-branch-menu">
        <header className="flex items-center gap-2 px-2 py-1"><h2 className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-tertiary">{label}</h2><button type="button" aria-label="刷新分支" className="my-icon-control" disabled={!state.root || !hasGitWorkspace() || state.loading || Boolean(state.busy)} onClick={() => void refreshGitWorkspace()}><RefreshCw size={13} className={state.loading ? 'animate-spin' : undefined} /></button></header>
        <button type="button" aria-label="更改与提交" className="my-menu-item" onClick={() => { close(); openGitWorkspace() }}><FileDiff size={14} /><span className="flex-1 text-left">更改与提交</span>{changed > 0 && <span className="text-my-xs text-my-tertiary">{changed}</span>}</button>
        <button type="button" className="my-menu-item" disabled={!state.root} onClick={() => { close(); history() }}><History size={14} /><span>查看工作区与历史</span></button>
        {snapshot && <>
          <div className="my-git-workspace-menu-rule" />
          <button type="button" className="my-menu-item" disabled={!snapshot.head || Boolean(state.busy)} onClick={() => { close(); openCreate() }}><Plus size={14} /><span>创建分支…</span></button>
          <h3 className="my-menu-header">本地分支</h3>
          <div className="my-git-local-branches my-scrollbar">{snapshot.branches.map((branch) => <button type="button" className="my-menu-item" key={branch.name} title={branch.worktree ? `${branch.name} · ${branch.worktree}` : branch.name} aria-label={`切换到分支 ${branch.name}`} disabled={branch.current || !snapshot.clean || Boolean(snapshot.operation) || Boolean(branch.worktree) || Boolean(state.busy)} onClick={() => { const scope = gitActionScope(); if (scope) { close(); setDialog({ kind: 'switch', scope, branch }) } }}>
            <span className="min-w-0 flex-1 truncate text-left">{branch.name}</span>{branch.current && <Check size={14} className="shrink-0 text-my-primary" aria-hidden="true" />}{branch.worktree && !branch.current && <span className="text-my-2xs text-my-tertiary">工作树</span>}
          </button>)}</div>
          {!snapshot.clean && <p className="px-2 py-1 text-my-xs text-my-tertiary">处理未提交更改后可切换分支。</p>}
        </>}
        {!state.root && <p className="px-2 py-2 text-my-xs text-my-tertiary">选择项目后可管理 Git。</p>}
        {!hasGitWorkspace() && <p className="px-2 py-2 text-my-xs text-my-tertiary">{hasIpc ? '请重启应用以加载 Git 操作。' : '桌面端可连接本地 Git。'}</p>}
        {state.busy && <p role="status" className="px-2 py-2 text-my-xs text-my-secondary">{state.busy}</p>}
        {state.error && <p role="alert" className="px-2 py-2 text-my-xs text-my-danger-text">{state.error}</p>}
      </div>}
    </Dropdown>
    <SourceControlPanel trigger={trigger} onBranchDialog={setDialog} />
    <BranchForms dialog={dialog} onClose={() => { returnAfterDialog.current = dialog?.opener ?? trigger.current; setDialog(null) }} />
  </>
}

export function GitBranchControl(): JSX.Element {
  const state = useGitWorkspace()
  return <GitBranchSession key={state.generation} />
}
