import { useState, type JSX, type ReactNode } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import type { ProjectWorkbenchAction, ProjectWorkbenchProject, ProjectWorkbenchResult } from '../../../shared/conversation/project-workbench'
import type { GitLabTaskStatus } from '../../../shared/types'
import type { GitWorkspaceSnapshot } from '../../../shared/git-workspace'
import { Select } from '../components/Select'
import { Button } from '../my/ui'

export type ExecuteProjectAction = (action: ProjectWorkbenchAction) => Promise<ProjectWorkbenchResult | undefined>
type DiffAction = Extract<ProjectWorkbenchAction, { kind: 'diff' }>

function GitRemoteControls({ snapshot, pending, disabled, execute }: {
  snapshot: GitWorkspaceSnapshot; pending: boolean; disabled: boolean; execute: ExecuteProjectAction
}): JSX.Element | null {
  const [remoteName, setRemote] = useState('')
  const [remoteBranch, setRemoteBranch] = useState('')
  const [targetBranch, setTargetBranch] = useState('')
  const [title, setTitle] = useState('')
  const [issue, setIssue] = useState('')
  const [status, setStatus] = useState<{ remote: string; read: GitLabTaskStatus }>()
  const branch = snapshot.branch
  const remote = snapshot.remotes.find(item => item.name === remoteName)
  const statusForRemote = status?.remote === remote?.name ? status?.read : undefined
  const issueNumber = /^\d+$/u.test(issue) ? Number(issue) : 0
  if (!snapshot.remotes.length) return null
  return <section className="conversation-project-card">
    <h3 className="my-item-title">远端</h3>
    <Select ariaLabel="仓库" placeholder="选择远端" value={remote?.name ?? ''} onChange={setRemote}
      options={snapshot.remotes.map(item => item.name)} />
    {remote && <>
      <label className="conversation-project-field">推送目标分支
        <input className="my-input" value={remoteBranch} onChange={event => setRemoteBranch(event.target.value)} maxLength={250} />
      </label>
      <Button size="sm" variant="neutral" disabled={disabled || !branch || !snapshot.head || !remoteBranch.trim()}
        onClick={() => {
          if (branch) void execute({ kind: 'git.push', revision: snapshot.revision, remote: remote.name,
            branch, remoteBranch: remoteBranch.trim() })
        }}>推送</Button>
      <details className="conversation-project-disclosure">
        <summary>合并请求与工单</summary>
        <div className="conversation-project-fields">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
            void execute({ kind: 'gitlab.status', remote: remote.name }).then(result => {
              if (result?.ok && result.kind === 'gitlab.status') setStatus({ remote: remote.name, read: result.status })
            })
          }}>查看远端状态</Button>
          {statusForRemote && <p className="my-item-description" role="status">{statusForRemote.ok
            ? [statusForRemote.mr?.title, statusForRemote.pipeline?.status].filter(Boolean).join(' · ') || '当前分支暂无合并请求或流水线。'
            : statusForRemote.error ?? '远端状态不可用。'}</p>}
          <label className="conversation-project-field">目标分支<input className="my-input" value={targetBranch}
            onChange={event => setTargetBranch(event.target.value)} maxLength={250} /></label>
          <label className="conversation-project-field">合并请求标题<input className="my-input" value={title}
            onChange={event => setTitle(event.target.value)} maxLength={500} /></label>
          <Button size="sm" variant="neutral" disabled={disabled || !branch || !targetBranch.trim() || targetBranch.trim() === branch || !title.trim()}
            onClick={() => {
              if (branch) void execute({ kind: 'gitlab.pr.create', revision: snapshot.revision, remote: remote.name, sourceBranch: branch,
                targetBranch: targetBranch.trim(), title: title.trim() })
            }}>创建合并请求</Button>
          <label className="conversation-project-field">工单编号<input className="my-input" inputMode="numeric"
            value={issue} onChange={event => setIssue(event.target.value)} /></label>
          <Button size="sm" variant="ghost" disabled={pending || issueNumber < 1 || !Number.isSafeInteger(issueNumber)}
            onClick={() => void execute({ kind: 'gitlab.issue.open', remote: remote.name, iid: issueNumber })}>打开工单</Button>
        </div>
      </details>
    </>}
  </section>
}

function GitChanges({ snapshot, disabled, execute, renderDiff }: {
  snapshot: GitWorkspaceSnapshot; disabled: boolean; execute: ExecuteProjectAction; renderDiff(action: DiffAction): ReactNode
}): JSX.Element {
  const [selected, setSelected] = useState<DiffAction>()
  const changed = [
    { mode: 'staged', title: '已暂存', paths: snapshot.staged.map(item => item.path) },
    { mode: 'unstaged', title: '未暂存', paths: snapshot.unstaged.map(item => item.path) },
    { mode: 'untracked', title: '未跟踪', paths: snapshot.untracked },
  ] as const
  if (snapshot.clean) return <p className="my-item-description">工作树没有未提交改动。</p>
  return <>{changed.filter(group => group.paths.length).map(({ mode, title, paths }) => <section className="conversation-project-card" key={mode}>
    <div className="conversation-project-toolbar"><h3 className="my-item-title">{title}</h3>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() =>
        void execute({ kind: mode === 'staged' ? 'git.unstage' : 'git.stage', revision: snapshot.revision, paths })}>
        {mode === 'staged' ? '全部取消暂存' : '全部暂存'}
      </Button>
    </div>
    <ul className="conversation-project-list">
      {paths.map(path => {
        const expanded = selected?.mode === mode && selected.path === path
        return <li key={path}>
          <div className="conversation-project-row">
            <button type="button" className="my-nav-item" aria-expanded={expanded} title={path}
              onClick={() => setSelected(expanded ? undefined : { kind: 'diff', path, mode })}>
              <span className="my-item-title">{path}</span>
            </button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() =>
              void execute({ kind: mode === 'staged' ? 'git.unstage' : 'git.stage', revision: snapshot.revision, paths: [path] })}>
              {mode === 'staged' ? '取消暂存' : '暂存'}
            </Button>
          </div>
          {expanded && selected && renderDiff(selected)}
        </li>
      })}
    </ul>
  </section>)}</>
}

export function ConversationProjectGit({ project, pending, writable, execute, reload, renderDiff }: {
  project: ProjectWorkbenchProject; pending: boolean; writable: boolean
  execute: ExecuteProjectAction; reload(): void; renderDiff(action: DiffAction): ReactNode
}): JSX.Element {
  const [commitMessage, setCommitMessage] = useState('')
  const [branch, setBranch] = useState('')
  const [newBranch, setNewBranch] = useState('')
  if (!project.git.available) return <p className="my-item-description">{project.git.reason}</p>
  const { snapshot, stats } = project.git
  const writeAccess = writable && project.gitWrite.available
  const disabled = pending || !writeAccess || snapshot.conflicts || Boolean(snapshot.operation)
  const availableBranches = snapshot.branches.filter(item => !item.current)
  const selectedBranch = availableBranches.find(item => item.name === branch)
  return <>
    <div className="conversation-project-toolbar">
      <GitBranch size={15} aria-hidden="true" /><h2 className="my-item-title">{snapshot.branch ?? snapshot.head?.slice(0, 8) ?? '改动'}</h2>
      {'files' in stats && <span className="conversation-project-stats" aria-label={`新增 ${stats.additions} 行，删除 ${stats.deletions} 行`}>
        <span>+{stats.additions}</span><span>−{stats.deletions}</span></span>}
      <button type="button" className="my-icon-control" aria-label="刷新 Git 状态" disabled={pending} onClick={reload}>
        <RefreshCw size={14} aria-hidden="true" />
      </button>
    </div>
    {'error' in stats && <p className="my-item-description">{stats.error}</p>}
    {!project.gitWrite.available && <p className="my-item-description">{project.gitWrite.reason}</p>}
    <GitChanges snapshot={snapshot} disabled={disabled} execute={execute} renderDiff={renderDiff} />
    {snapshot.staged.length > 0 && <form className="conversation-project-card" onSubmit={event => {
      event.preventDefault()
      const message = commitMessage.trim()
      if (message && !disabled) {
        void execute({ kind: 'git.commit', revision: snapshot.revision, message }).then(result => {
          if (result && (result.ok || result.mutationCompleted)) setCommitMessage(current => current.trim() === message ? '' : current)
        })
      }
    }}>
      <label className="conversation-project-field">提交说明<textarea className="my-input" rows={3}
        value={commitMessage} maxLength={65_536} onChange={event => setCommitMessage(event.target.value)} /></label>
      <Button size="sm" variant="neutral" type="submit" disabled={disabled || !commitMessage.trim()}>提交已暂存改动</Button>
    </form>}
    <section className="conversation-project-card">
      <h3 className="my-item-title">分支</h3>
      {availableBranches.length > 0 && <div className="conversation-project-fields">
        <Select ariaLabel="现有分支" placeholder="选择分支" value={selectedBranch?.name ?? ''} onChange={setBranch}
          options={availableBranches.map(item => item.name)} />
        <Button size="sm" variant="ghost" disabled={disabled || !snapshot.clean || !selectedBranch}
          onClick={() => {
            if (selectedBranch) void execute({ kind: 'git.branch.switch', revision: snapshot.revision, name: selectedBranch.name })
          }}>切换分支</Button>
      </div>}
      <label className="conversation-project-field">新分支名称<input className="my-input" value={newBranch}
        onChange={event => setNewBranch(event.target.value)} maxLength={250} /></label>
      <Button size="sm" variant="ghost" disabled={disabled || !snapshot.head || !newBranch.trim()}
        onClick={() => {
          const name = newBranch.trim()
          void execute({ kind: 'git.branch.create', revision: snapshot.revision, name }).then(result => {
            if (result?.ok) setNewBranch(current => current.trim() === name ? '' : current)
          })
        }}>创建分支</Button>
    </section>
    <GitRemoteControls snapshot={snapshot} pending={pending} disabled={disabled} execute={execute} />
  </>
}
