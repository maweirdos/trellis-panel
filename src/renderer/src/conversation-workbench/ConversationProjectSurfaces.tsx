import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, ChevronRight, Code, FileText, Folder, FolderOpen, GitBranch, Monitor, Play, RefreshCw, Square, Terminal } from 'lucide-react'
import type { ProjectWorkbenchAction, ProjectWorkbenchInput, ProjectWorkbenchProject, ProjectWorkbenchResult, ProjectWorkbenchStats } from '../../../shared/conversation/project-workbench'
import type { ApplicationProcessState } from '../../../shared/app-runtime'
import { api } from '../api'
import { Select } from '../components/Select'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { UnifiedDiff } from '../my/git/UnifiedDiff'
import { Button } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import { conversationFileSurface, type ConversationRightPanelSurface } from './conversationRightPanelStore'
import { conversationError } from './useComposerSend'
import { ConversationProjectGit, type ExecuteProjectAction } from './ConversationProjectGit'

type ProjectTarget = Omit<ProjectWorkbenchInput, 'action'>
type ReadState = { result?: ProjectWorkbenchResult; error?: string; refreshing?: boolean }
const ProjectTabActive = createContext(true)
const scriptStateLabels: Record<ApplicationProcessState, string> = {
  stopped: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止',
  exited: '已退出', failed: '失败', unknown: '待核对', 'cleanup-required': '待清理',
}

function useProjectRead(target: ProjectTarget, action: ProjectWorkbenchAction | undefined, refresh: number, enabled = true): ReadState {
  const canInteract = useInteractionGuard()
  const tabActive = useContext(ProjectTabActive) && enabled
  const input = action ? JSON.stringify({ ...target, action } satisfies ProjectWorkbenchInput) : null
  const [read, setRead] = useState<{ input: string; refresh: number; state: ReadState }>()
  useEffect(() => {
    if (!input || !tabActive || !canInteract()) return
    let current = true
    const request: ProjectWorkbenchInput = JSON.parse(input)
    void api.conversationProjectWorkbench(request).then(result => {
      if (current && canInteract()) setRead({ input, refresh, state: { result } })
    }).catch(error => {
      if (current && canInteract()) setRead({ input, refresh, state: { error: conversationError(error) } })
    })
    return () => { current = false }
  }, [input, refresh, tabActive, canInteract])
  if (!read || read.input !== input) return {}
  return read.refresh === refresh ? read.state : { ...read.state, refreshing: true }
}

function ProjectReadStatus({ read, retry }: { read: ReadState; retry(): void }): JSX.Element {
  const error = read.error ?? (read.result && !read.result.ok ? read.result.error : undefined)
  return error ? <FeedbackNotice variant="inline" tone="error" title="读取失败" description={error}
    actions={<Button size="sm" variant="ghost" onClick={retry}>重试</Button>} />
    : <p className="my-item-description" role="status">正在读取…</p>
}

function ProjectToolbar({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return <div className="conversation-project-toolbar">
    <h2 className="my-item-title">{title}</h2>{children}
  </div>
}

function ChangeStats({ stats }: { stats: Pick<ProjectWorkbenchStats, 'additions' | 'deletions'> }): JSX.Element {
  return <span className="conversation-project-stats" aria-label={`新增 ${stats.additions} 行，删除 ${stats.deletions} 行`}>
    <span>+{stats.additions}</span><span>−{stats.deletions}</span>
  </span>
}

function ProjectOverview({ project, execute, pending, open, children }: {
  project: ProjectWorkbenchProject; execute: ExecuteProjectAction; pending: boolean
  open(surface: ConversationRightPanelSurface): void; children?: ReactNode
}): JSX.Element {
  const git = project.git
  const stats = git.available && 'files' in git.stats ? git.stats : undefined
  return <>
    <section className="conversation-project-card" aria-label="当前工程">
      <div className="conversation-project-row"><Monitor size={15} aria-hidden="true" /><span>{project.machine}</span></div>
      <div className="conversation-project-row">
        <FolderOpen size={15} aria-hidden="true" />
        <span className="my-item-title" title={project.cwd}>{project.cwd}</span>
        <button type="button" className="my-icon-control" aria-label="打开工程目录" disabled={pending}
          onClick={() => void execute({ kind: 'open.directory' })}><ArrowUpRight size={14} aria-hidden="true" /></button>
      </div>
      {git.available && <div className="conversation-project-row">
        <GitBranch size={15} aria-hidden="true" />
        <span className="my-item-title">{git.snapshot.branch ?? git.snapshot.head?.slice(0, 8) ?? '未建立分支'}</span>
        {stats && <ChangeStats stats={stats} />}
      </div>}
      <div className="conversation-project-actions">
        <Button size="sm" variant="ghost" onClick={() => open({ id: 'files', kind: 'files' })}>文件</Button>
        {git.available && <Button size="sm" variant="ghost" onClick={() => open({ id: 'changes', kind: 'changes' })}>改动</Button>}
        {git.available && git.snapshot.head && <Button size="sm" variant="ghost" onClick={() => open({ id: 'diff', kind: 'diff' })}>分支比较</Button>}
        {project.ides.map(ide => <Button key={ide.id} size="sm" variant="ghost" disabled={pending}
          onClick={() => void execute({ kind: 'open.ide', ideId: ide.id })}><Code size={14} aria-hidden="true" />{ide.label}</Button>)}
        {project.terminal.available && <Button variant="ghost" size="sm" onClick={() => open({ id: 'terminal', kind: 'terminal' })}>终端</Button>}
        {project.scripts.available && project.scripts.items.length > 0 &&
          <Button variant="ghost" size="sm" onClick={() => open({ id: 'scripts', kind: 'scripts' })}>脚本</Button>}
      </div>
      {!git.available && <p className="my-item-description">{git.reason}</p>}
      {!project.ides.length && <p className="my-item-description">当前机器未检测到可用的 IDE。</p>}
    </section>
    {children}
    {!project.restore.available && <section className="conversation-project-card" aria-label="文件恢复">
      <h3 className="my-item-title">文件恢复</h3>
      <p className="my-item-description">{project.restore.reason}</p>
    </section>}
  </>
}

function ProjectFiles({ target, open }: { target: ProjectTarget; open(surface: ConversationRightPanelSurface): void }): JSX.Element {
  const [directory, setDirectory] = useState('')
  const [refresh, reload] = useState(0)
  const read = useProjectRead(target, { kind: 'files', ...(directory && { directory }) }, refresh)
  const result = read.result
  return <>
    <ProjectToolbar title={directory || '工程文件'}>
      {directory && <button type="button" className="my-icon-control" aria-label="上一层目录"
        onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}><ArrowLeft size={15} aria-hidden="true" /></button>}
    </ProjectToolbar>
    {result?.ok && result.kind === 'files' ? <>
      <ul className="conversation-project-list">
        {result.entries.map(entry => <li key={entry.path}>
          <button type="button" className="my-nav-item"
            onClick={() => entry.kind === 'directory' ? setDirectory(entry.path) : open(conversationFileSurface(entry.path))}>
            {entry.kind === 'directory' ? <Folder size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
            <span className="my-item-title">{entry.name}</span>
            {entry.kind === 'directory' && <ChevronRight size={13} aria-hidden="true" />}
          </button>
        </li>)}
      </ul>
      {!result.entries.length && <p className="my-item-description">此目录为空。</p>}
      {result.truncated && <p className="my-item-description" role="status">已达目录读取上限。</p>}
    </> : <ProjectReadStatus read={read} retry={() => reload(value => value + 1)} />}
  </>
}

function ProjectFile({ target, path, line, selected }: { target: ProjectTarget; path: string; line?: number; selected: boolean }): JSX.Element {
  const [refresh, reload] = useState(0)
  const read = useProjectRead(target, { kind: 'file', path }, refresh)
  const result = read.result
  const focusedLine = useRef<HTMLSpanElement>(null)
  const text = result?.ok && result.kind === 'file' ? result.text : undefined
  useLayoutEffect(() => {
    if (selected) focusedLine.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [line, text, selected])
  const lines = line === undefined ? undefined : text?.split('\n')
  const foundLine = line !== undefined && lines && line <= lines.length
  return <>
    <ProjectToolbar title={path}><button type="button" className="my-icon-control" aria-label="刷新文件"
      onClick={() => reload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" /></button></ProjectToolbar>
    {text !== undefined ? <pre className="conversation-project-code my-scrollbar" tabIndex={0} aria-label={foundLine ? `${path}，第 ${line} 行` : path}>
      {foundLine ? <>{lines.slice(0, line - 1).join('\n')}{line > 1 && '\n'}
        <span ref={focusedLine} className="conversation-project-code-line">{lines[line - 1]}</span>
        {line < lines.length && '\n'}{lines.slice(line).join('\n')}</> : text}
    </pre>
      : <ProjectReadStatus read={read} retry={() => reload(value => value + 1)} />}
  </>
}

type DiffAction = Extract<ProjectWorkbenchAction, { kind: 'diff' }>

export function ProjectFileDiff({ target, action, revision }: { target: ProjectTarget; action?: DiffAction; revision: number }): JSX.Element | null {
  const [retry, setRetry] = useState(0)
  const read = useProjectRead(target, action, revision + retry)
  const result = read.result
  if (!action) return null
  return result?.ok && result.kind === 'diff' ? <UnifiedDiff value={result} />
    : <ProjectReadStatus read={read} retry={() => setRetry(value => value + 1)} />
}

function BranchComparison({ target, project, refresh }: { target: ProjectTarget; project: ProjectWorkbenchProject; refresh: number }): JSX.Element {
  const [base, setBase] = useState('')
  const [file, setFile] = useState('')
  const [retry, setRetry] = useState(0)
  const refs = project.git.available ? project.git.snapshot.branches.filter(branch => !branch.current) : []
  const comparison = refs.some(branch => branch.name === base) ? base : ''
  const read = useProjectRead(target, comparison ? { kind: 'branch.diff', baseBranch: comparison } : undefined, refresh + retry)
  const result = read.result
  return <>
    <ProjectToolbar title="分支比较" />
    {!project.git.available ? <p className="my-item-description">{project.git.reason}</p>
      : !refs.length ? <p className="my-item-description">当前仓库没有可比较的本地分支。</p>
        : <Select ariaLabel="基准分支" placeholder="选择基准分支" value={comparison} options={refs.map(ref => ref.name)}
          onChange={value => { setBase(value); setFile('') }} />}
    {comparison && (result?.ok && result.kind === 'branch.diff' ? <>
      <div className="conversation-project-row"><span>{result.stats.files.length} 个文件</span><ChangeStats stats={result.stats} /></div>
      <ul className="conversation-project-list">
        {result.stats.files.map(change => <li key={change.path}><button type="button" className="my-nav-item"
          aria-pressed={change.path === file} onClick={() => setFile(change.path === file ? '' : change.path)}>
          <span className="my-item-title" title={change.path}>{change.path}</span><ChangeStats stats={change} />
        </button>
        {file === change.path && <ProjectFileDiff target={target} action={{ kind: 'diff', mode: 'branch', path: file, baseBranch: comparison }} revision={refresh} />}
        </li>)}
      </ul>
    </> : <ProjectReadStatus read={read} retry={() => setRetry(value => value + 1)} />)}
  </>
}

function ProjectScripts({ target, project, writable, pending, execute }: {
  target: ProjectTarget; project: ProjectWorkbenchProject; writable: boolean; pending: boolean; execute: ExecuteProjectAction
}): JSX.Element {
  const [logs, setLogs] = useState<{ appId: string; runId: string }>()
  const [refresh, reload] = useState(0)
  const read = useProjectRead(target, logs && { kind: 'script.logs', ...logs }, refresh)
  const result = read.result
  return <>
    <ProjectToolbar title="项目脚本" />
    {!project.scripts.available ? <p className="my-item-description">{project.scripts.reason}</p>
      : project.scripts.items.length === 0 ? <p className="my-item-description">此工程没有已登记的脚本。</p>
        : <ul className="conversation-project-list">
          {project.scripts.items.map(script => <li key={script.appId}>
            <div className="conversation-project-row">
              <span className="my-item-title" title={script.name}>{script.name}</span>
              <small className="my-item-description">{scriptStateLabels[script.processState]}</small>
              {script.runId && <Button size="sm" variant="ghost" onClick={() => {
                if (script.runId) { setLogs({ appId: script.appId, runId: script.runId }); reload(value => value + 1) }
              }}>日志</Button>}
              {script.canStart && <button type="button" className="my-icon-control" aria-label={`运行 ${script.name}`} disabled={pending || !writable}
                onClick={() => void execute({ kind: 'script.start', appId: script.appId, revision: script.revision })}><Play size={14} aria-hidden="true" /></button>}
              {script.canStop && script.runId && <button type="button" className="my-icon-control" aria-label={`停止 ${script.name}`} disabled={pending || !writable}
                onClick={() => { if (script.runId) void execute({ kind: 'script.stop', appId: script.appId, runId: script.runId }) }}><Square size={14} aria-hidden="true" /></button>}
            </div>
          </li>)}
        </ul>}
    {logs && <section className="conversation-project-card" aria-label="脚本日志">
      <ProjectToolbar title="脚本日志"><button type="button" className="my-icon-control" aria-label="刷新日志"
        onClick={() => reload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" /></button></ProjectToolbar>
      {result?.ok && result.kind === 'script.logs' ? <>
        <pre className="conversation-project-code my-scrollbar" tabIndex={0} aria-label="当前脚本输出">{result.output || '暂无输出'}</pre>
        {result.outputTruncated && <p className="my-item-description">已达日志读取上限。</p>}
      </> : <ProjectReadStatus read={read} retry={() => reload(value => value + 1)} />}
    </section>}
  </>
}

export function ConversationProjectSurfaces({ target, surface, selected, open, writable, activeRun, children }: {
  target: ProjectTarget; surface: Exclude<ConversationRightPanelSurface, { kind: 'thread' }>
  selected: boolean; open(surface: ConversationRightPanelSurface): void; writable: boolean; activeRun: boolean; children?: ReactNode
}): JSX.Element {
  const canInteract = useInteractionGuard()
  const [refresh, setRefresh] = useState(0)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<{ title: string; detail?: string; tone: 'success' | 'error' | 'warning' }>()
  const alive = useRef(false)
  const busy = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const reload = (): void => setRefresh(value => value + 1)
  const read = useProjectRead(target, surface.kind === 'files' || surface.kind === 'file' ? undefined : { kind: 'inspect' }, refresh, selected)
  const execute: ExecuteProjectAction = async action => {
    const external = action.kind === 'open.directory' || action.kind === 'open.ide' ||
      action.kind === 'gitlab.status' || action.kind === 'gitlab.issue.open'
    if (!selected || (!external && !writable) || !canInteract() || busy.current) return
    busy.current = true
    setPending(true)
    setNotice(undefined)
    try {
      const result = await api.conversationProjectWorkbench({ ...target, action })
      if (!alive.current || !canInteract()) return
      if (!result.ok) {
        const uncertain = result.outcome === 'unknown' || result.uncertain
        setNotice({ title: uncertain ? '操作结果待核对' : result.mutationCompleted ? '操作已执行，后续检查失败' : '操作未完成',
          detail: result.committed ? `${result.error} (${result.committed})` : result.error, tone: uncertain || result.mutationCompleted ? 'warning' : 'error' })
      } else if ('message' in result) {
        setNotice({ title: result.message, tone: 'success' })
      } else if (result.kind === 'gitlab.pr.create') {
        setNotice({ title: '合并请求已创建', detail: result.url, tone: 'success' })
      }
      if (action.kind !== 'gitlab.status') reload()
      return result
    } catch (error) {
      if (alive.current && canInteract()) {
        setNotice({ title: '操作结果待核对', detail: conversationError(error), tone: 'warning' })
        reload()
      }
    } finally {
      busy.current = false
      if (alive.current) setPending(false)
    }
  }
  const result = read.result
  const project = result?.ok && result.kind === 'inspect' ? result.project : undefined
  let body: ReactNode
  switch (surface.kind) {
    case 'files': body = <ProjectFiles target={target} open={open} />; break
    case 'file': body = <ProjectFile key={surface.path} target={target} path={surface.path} line={surface.line} selected={selected} />; break
    default:
      if (!project) body = <><ProjectReadStatus read={read} retry={reload} />{surface.kind === 'project' && children}</>
      else switch (surface.kind) {
        case 'project': body = <ProjectOverview project={project} execute={execute} pending={pending} open={open}>{children}</ProjectOverview>; break
        case 'diff': body = <BranchComparison target={target} project={project} refresh={refresh} />; break
        case 'changes': body = <ConversationProjectGit project={project} pending={pending || Boolean(read.refreshing)}
          writable={writable && !activeRun} execute={execute} reload={reload}
          renderDiff={action => <ProjectFileDiff target={target} action={action} revision={refresh} />} />; break
        case 'scripts': body = <ProjectScripts target={target} project={project} writable={writable} pending={pending} execute={execute} />; break
        case 'terminal': body = <><ProjectToolbar title="工程终端" />
          {project.terminal.available ? <Button size="sm" variant="neutral" disabled={!writable || pending}
            onClick={() => void execute({ kind: 'terminal.open' })}><Terminal size={15} aria-hidden="true" />打开终端</Button>
            : <p className="my-item-description">{project.terminal.reason}</p>}</>; break
      }
  }
  return <ProjectTabActive.Provider value={selected}><div className="conversation-project-content">
    {notice && (notice.tone === 'success'
      ? <p role="status" className="my-item-description">{notice.title}{notice.detail && ` · ${notice.detail}`}</p>
      : <FeedbackNotice variant="inline" title={notice.title} description={notice.detail} tone={notice.tone} />)}
    {body}
  </div></ProjectTabActive.Provider>
}
