import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ArrowRight, Check, FolderOpen, GitBranch, History, Loader2, RefreshCw } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { CruxDevelopmentSummary, CruxDevelopmentView, CruxWorkChangeInput, CruxWorkLocal, CruxWorkResult } from '@shared/crux-work'
import type { TeamTaskCodeResourceDto } from '@shared/team-code-resources'
import { api } from '../../api'
import { Button, Modal } from '../../my/ui'
import { useCrux } from '../store'
import { taskSourceKey, useTaskSource, useTaskSurfaceGeneration } from '../pages/task-detail/use-task-source'
import { nativeDevelopmentApi } from './bridge'
import { DesktopTaskLocator } from './DesktopTaskLocator'
import { claimDevelopmentCommand, finishDevelopmentCommand, releaseDevelopmentCommand, rememberDevelopmentCommand, retainedDevelopmentCommand, type DevelopmentCommand } from './command-journal'

type DevelopmentView = Extract<CruxDevelopmentView, { ok: true }>
type ReadState = { view: DevelopmentView; status: CruxWorkResult; at: number; resource: TeamTaskCodeResourceDto | null }
const stageLabels: Record<CruxDevelopmentSummary['stage'], string> = { registered: '待准备', dispatching: '准备中 · 待核对', failed: '准备未完成', uncertain: '原结果待核对', cli_created: '任务已创建 · 待恢复', ready: '已准备' }
const short = (value: string | null | undefined): string => value ? value.slice(0, 12) : '未核实'
const copyName = (root: string): string => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : '开发环境暂不可用，请重试。'

export function TaskDevelopmentCard(props: { snapshot: CruxSnapshot; task: CruxTask; resourceRefresh?: number; openRequest?: number; onEnter(local: CruxWorkLocal): Promise<void> }): JSX.Element {
  const context = useCrux((state) => state.workspaceContext), surface = useTaskSurfaceGeneration()
  const revision = useCrux((state) => state.developmentRevision)
  const lifecycle = useRef(0), [generation, setGeneration] = useState(0)
  useLayoutEffect(() => {
    const identity = (state: ReturnType<typeof useCrux.getState>): string => {
      const task = state.snapshot?.tasks.find((item) => item.id === props.task.id && item.createdAt === props.task.createdAt)
      return JSON.stringify([state.workspaceContext.state, task?.workKind, task?.triagePending, task?.workflow?.stage, task?.workflow?.handlerId ?? task?.assigneeIds[0], state.snapshot?.taskStatuses.find((status) => status.id === task?.statusId)?.category])
    }
    return useCrux.subscribe((next, previous) => { if (identity(next) !== identity(previous)) { lifecycle.current++; setGeneration(lifecycle.current) } })
  }, [props.task.id, props.task.createdAt])
  return <DevelopmentCard key={`${taskSourceKey(props.snapshot, context)}:${props.task.id}:${props.task.createdAt}:${surface}:${revision}:${generation}`} {...props} ownsSurface={() => lifecycle.current === generation} />
}

function DevelopmentCard({ snapshot, task, resourceRefresh = 0, openRequest = 0, onEnter, ownsSurface }: { snapshot: CruxSnapshot; task: CruxTask; resourceRefresh?: number; openRequest?: number; onEnter(local: CruxWorkLocal): Promise<void>; ownsSurface(): boolean }): JSX.Element {
  const context = useCrux((state) => state.workspaceContext), teamBusy = useCrux((state) => state.busy)
  const revision = useCrux((state) => state.developmentRevision)
  const source = useTaskSource({ spaceId: task.spaceId, taskId: task.id })
  const sourceKey = taskSourceKey(snapshot, context), bridge = nativeDevelopmentApi()
  const [read, setRead] = useState<ReadState | null>(null), [loading, setLoading] = useState(Boolean(bridge))
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState(''), [operation, setOperation] = useState('')
  const [refresh, setRefresh] = useState(0), [dialog, setDialog] = useState<'first' | 'choose-copy' | 'adopt-inputs' | null>(null)
  const [candidateId, setCandidateId] = useState(''), [acknowledged, setAcknowledged] = useState(false)
  const [journalVersion, setJournalVersion] = useState(0)
  const requests = useRef(0), inFlight = useRef(false), mounted = useRef(false), root = useRef<HTMLElement>(null)
  const handledOpenRequest = useRef(openRequest)
  const view = read?.view, active = view?.active
  const pending = retainedDevelopmentCommand(sourceKey, task.createdAt, task.id)
  const original = active?.changeCommandId ? retainedDevelopmentCommand(sourceKey, task.createdAt, task.id, active.changeCommandId) : undefined
  const unknown = Boolean(pending || active && ['dispatching', 'uncertain', 'cli_created'].includes(active.stage))
  const local = read?.status.ok && read.status.prepared ? read.status.local : undefined
  const ready = Boolean(active?.stage === 'ready' && local?.development?.contextId === active.ref.contextId && local.development.generation === active.ref.generation && read?.status.ok && read.status.prepared && !read.status.reviewRequired)
  const statusError = read && !read.status.ok && read.status.reason !== 'cancelled' ? read.status.error : ''
  const inputChanged = Boolean(active && view?.currentInputVersion && active.inputVersion !== view.currentInputVersion)
  const category = snapshot.taskStatuses.find((status) => status.id === task.statusId)?.category
  const developmentAllowed = !task.triagePending && !['done', 'cancelled'].includes(category ?? '') && (!task.workflow || ['dev_ready', 'planning', 'developing'].includes(task.workflow.stage))
  const writable = ['local', 'connected'].includes(context.state) && developmentAllowed && ownsSurface() && source.canWrite() && useCrux.getState().developmentRevision === revision && !teamBusy && !operation && !loading && !readError
  const query = { workspaceKey: context.key, taskId: task.id }
  const live = (): boolean => mounted.current && ownsSurface() && source.owns() && useCrux.getState().developmentRevision === revision
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requests.current++ } }, [])
  useEffect(() => {
    if (!bridge || !source.available) return
    if (!['local', 'connected'].includes(context.state)) { setLoading(false); return }
    const ticket = ++requests.current
    setLoading(true)
    void (async () => {
      try {
        const [development, status, resourceReply] = await Promise.all([
          bridge.development(query), bridge.status(query),
          context.state !== 'local' && api && Object.hasOwn(api, 'cruxResources') && api.cruxResources && Object.hasOwn(api.cruxResources, 'task')
            ? api.cruxResources.task(query) : Promise.resolve(null)
        ])
        if (!live() || ticket !== requests.current) return
        if (!development.ok) throw Error(development.error)
        const resource = resourceReply?.ok && resourceReply.value.taskCreatedAt === task.createdAt && resourceReply.value.spaceId === task.spaceId ? resourceReply.value : null
        setRead({ view: development, status, resource, at: Date.now() }); setReadError('')
        const retained = retainedDevelopmentCommand(sourceKey, task.createdAt, task.id)
        if (retained && development.active?.changeCommandId === retained.input.commandId && development.active.stage === 'ready' &&
          development.active.previousContextId === retained.input.expected.contextId && development.active.ref.generation === retained.input.expected.generation + 1 &&
          development.active.inputVersion === retained.input.expectedInputVersion) {
          finishDevelopmentCommand(retained, false); setJournalVersion((value) => value + 1)
        }
      } catch (cause) { if (live() && ticket === requests.current) setReadError(errorText(cause)) }
      finally { if (live() && ticket === requests.current) setLoading(false) }
    })()
    return () => { requests.current++ }
  }, [sourceKey, task.id, task.createdAt, task.updatedAt, resourceRefresh, refresh, source.available, bridge, context.state])

  async function acceptResult(result: CruxWorkResult, enter: boolean): Promise<void> {
    if (!live()) return
    if (!result.ok) {
      if (result.reason === 'cancelled') setNotice('已取消，原开发环境与文件保留。')
      else setError(result.error)
    } else if (result.prepared) {
      if (result.reviewRequired) setError('本机材料有修改或输入已变化，请核对原计划并比较当前采用输入。')
      else { setNotice('开发环境已准备，Agent 与服务可分别启动。'); if (enter) await onEnter(result.local) }
    } else setNotice('原准备尚未完成，请核对原操作。')
    if (live()) setRefresh((value) => value + 1)
  }
  async function prepare(candidate?: string): Promise<void> {
    if (!bridge || !writable || inFlight.current || pending || active?.changeCommandId && unknown) return
    inFlight.current = true; setOperation(active ? '恢复原准备' : '准备开发环境'); setError(''); setNotice('')
    try { await acceptResult(await bridge.prepare({ ...query, ...(candidate ? { candidateId: candidate } : {}) }), true) }
    catch (cause) { if (live()) { setError(`${errorText(cause)} 原准备结果需要核对。`); setRefresh((value) => value + 1) } }
    finally { inFlight.current = false; if (live()) setOperation('') }
  }
  async function change(mode: CruxWorkChangeInput['mode'], retry?: DevelopmentCommand): Promise<void> {
    if (!bridge || !writable || inFlight.current || !retry && (unknown || !active || !view?.currentInputVersion)) return
    let command: DevelopmentCommand
    try {
      if (retry) command = retry
      else {
        if (!active || !view?.currentInputVersion) return
        command = rememberDevelopmentCommand(sourceKey, task.createdAt, {
          ...query, commandId: crypto.randomUUID(), expected: active.ref, expectedInputVersion: view.currentInputVersion, mode,
          ...(mode === 'choose-copy' && candidateId ? { candidateId } : {})
        })
      }
    } catch (cause) { setError(errorText(cause)); return }
    if (!claimDevelopmentCommand(command)) return
    inFlight.current = true; setOperation(retry ? '核对原更换操作' : '核对新开发环境'); setError(''); setNotice(''); setDialog(null)
    try {
      const result = await bridge.change(command.input)
      finishDevelopmentCommand(command, result.ok ? !result.prepared : Boolean(result.outcomeUnknown || result.reason === 'outcome_unknown' || retry && retry.state !== 'settled'))
      await acceptResult(result, false)
    } catch (cause) {
      finishDevelopmentCommand(command, true)
      if (live()) setError(`${errorText(cause)} 请核对原操作，不要重新建立尝试。`)
    } finally {
      releaseDevelopmentCommand(command); inFlight.current = false
      if (live()) { setOperation(''); setJournalVersion((value) => value + 1); setRefresh((value) => value + 1) }
    }
  }
  function choose(mode: 'first' | 'choose-copy' | 'adopt-inputs'): void { setCandidateId(''); setAcknowledged(false); setDialog(mode) }
  async function enter(): Promise<void> {
    if (!writable || !ready || !local || unknown || inFlight.current) return
    inFlight.current = true; setOperation('打开原开发环境'); setError('')
    try { await onEnter(local) } catch (cause) { if (live()) setError(errorText(cause)) }
    finally { inFlight.current = false; if (live()) setOperation('') }
  }
  useEffect(() => {
    if (openRequest === handledOpenRequest.current || !read || loading || !source.available) return
    handledOpenRequest.current = openRequest
    root.current?.scrollIntoView({ block: 'nearest' })
    if (!active && !unknown) choose('first')
    else if (ready && !unknown) void enter()
  }, [openRequest, read, loading, source.available])
  const resourceName = read?.resource?.resource?.name
  const boundResourceName = active?.resourceId
    ? read?.resource?.resource?.resourceId === active.resourceId ? resourceName : `原资源 ${active.resourceId}`
    : '本机项目'
  return <section ref={root} className="mt-3 min-w-0 space-y-3 rounded-my-md border border-my-line p-3" aria-label="任务开发环境" data-journal-version={journalVersion}>
    <header className="flex flex-wrap items-center gap-2"><FolderOpen size={15} className="text-my-secondary" /><h3 className="min-w-0 flex-1 text-my-sm font-medium text-my-primary">本机开发环境</h3>{active && <span className="my-chip text-my-secondary">{stageLabels[active.stage]}</span>}{bridge && <Button variant="ghost" size="sm" disabled={Boolean(operation) || loading} onClick={() => setRefresh((value) => value + 1)} aria-label="核对开发环境"><RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /></Button>}</header>
    {!bridge ? <DesktopTaskLocator snapshot={snapshot} task={task} context={context} available={source.available} ownsSource={live} /> : <>
      {!['local', 'connected'].includes(context.state) && <p role="status" className="text-my-xs text-my-secondary">连接不可用，暂无法核对本机开发环境。</p>}
      {loading && !read && <p role="status" className="flex items-center gap-2 text-my-xs text-my-secondary"><Loader2 size={13} className="animate-spin" />正在核对原绑定与可用副本</p>}
      {active && <><dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 text-my-xs"><div className="min-w-0"><dt className="text-my-tertiary">代码资源</dt><dd className="break-words text-my-primary">{boundResourceName}</dd></div><div className="min-w-0"><dt className="text-my-tertiary">当前副本</dt><dd className="break-words text-my-primary" title={active.projectRoot}>{copyName(active.projectRoot)}</dd></div><div><dt className="text-my-tertiary">准备时分支</dt><dd className="flex min-w-0 items-center gap-1 text-my-primary"><GitBranch size={12} className="shrink-0" /><span className="min-w-0 break-all">{active.branch ?? '分支未核实'}</span></dd></div><div><dt className="text-my-tertiary">当前采用输入</dt><dd className="font-mono text-my-primary">{short(active.inputVersion)}</dd></div></dl>
        <details className="text-my-xs text-my-secondary"><summary className="cursor-pointer">环境详情与最后核对</summary><dl className="mt-2 space-y-1 break-all"><div>副本：{active.projectRoot}</div><div>本机任务：{active.taskDir ?? '目录尚未核实'}</div><div>HEAD：{active.head ?? '未核实'}</div><div>输入：{active.inputVersion}</div><div>尝试：{active.ref.generation} · {active.ref.contextId}</div><div>最后读取：{read ? new Date(read.at).toLocaleString() : '未核对'}</div></dl></details></>}
      {view && !active && <p className="text-my-xs text-my-secondary">尚未选择本机开发环境{resourceName ? ` · ${resourceName}` : ''}</p>}
      {view?.sourceError && <p role="alert" className="break-words text-my-xs text-my-danger-text">{view.sourceError}</p>}
      {!developmentAllowed && <p role="status" className="text-my-xs text-my-secondary">当前阶段仅可核对开发记录，原文件与服务保留。</p>}
      {inputChanged && <div className="flex flex-wrap items-center gap-2 text-my-xs text-my-warning-text"><span className="min-w-0 flex-1">任务采用输入已变化，当前尝试仍保留 {short(active?.inputVersion)}。</span><Button variant="outline" size="sm" disabled={!writable || unknown || !view?.currentInputVersion} onClick={() => choose('adopt-inputs')}>比较并采用新输入</Button></div>}
      {(error || readError || statusError) && <p role="alert" className="break-words text-my-xs text-my-danger-text">{error || readError || statusError}</p>}
      {notice && <p role="status" className="text-my-xs text-my-secondary">{notice}</p>}
      {unknown && <div className="space-y-2 rounded-my-md bg-my-layer-1 p-2 text-my-xs text-my-secondary"><p>原操作结果待核对，当前不能建立替代尝试。</p>{(pending ?? original)?.state !== 'settled' && (pending ?? original) && <Button variant="outline" size="sm" disabled={!writable} onClick={() => { const command = pending ?? original; if (command) void change(command.input.mode, command) }}>重试原更换操作</Button>}<Button variant="ghost" size="sm" disabled={Boolean(operation) || loading || !source.owns() || !ownsSurface()} onClick={() => setRefresh((value) => value + 1)}>核对原结果</Button>{active && !active.changeCommandId && !pending && <Button variant="outline" size="sm" disabled={!writable} onClick={() => void prepare()}>恢复原准备</Button>}</div>}
      <div className="flex flex-wrap gap-2">
        {view && !active && !unknown && <Button size="sm" disabled={!writable || Boolean(view.sourceError)} onClick={() => choose('first')}>选择本机开发环境</Button>}
        {active && ready && !unknown && <Button size="sm" disabled={!writable || Boolean(view?.sourceError)} onClick={() => void enter()}><ArrowRight size={13} />{task.workflow?.stage === 'dev_ready' ? '确认并进入规划' : '继续开发'}</Button>}
        {active && !unknown && <Button variant="outline" size="sm" disabled={!writable || !view?.currentInputVersion} onClick={() => choose('choose-copy')}>更换副本</Button>}
        {active && !ready && !unknown && !inputChanged && !active.changeCommandId && <Button variant="outline" size="sm" disabled={!writable || Boolean(view?.sourceError)} onClick={() => void prepare()}>恢复原准备</Button>}
        {active && !ready && !unknown && !inputChanged && active.changeCommandId && original && <Button variant="outline" size="sm" disabled={!writable} onClick={() => void change(original.input.mode, original)}>恢复原更换操作</Button>}
      </div>
      {operation && <p role="status" className="flex items-center gap-2 text-my-xs text-my-secondary"><Loader2 size={13} className="animate-spin" />{operation}</p>}
      {view && view.history.length > 0 && <details className="text-my-xs text-my-secondary"><summary className="cursor-pointer"><History size={12} className="mr-1 inline" />原开发尝试（{view.history.length}{view.historyHasMore ? '+' : ''}）</summary><ol className="mt-2 space-y-2">{view.history.map((entry) => <li key={entry.ref.contextId} className="min-w-0 space-y-1 rounded-my-md border border-my-line p-2"><p>尝试 {entry.ref.generation} · {stageLabels[entry.stage]} · 历史记录</p><p className="break-all">{entry.projectRoot}</p><p>分支：{entry.branch ?? '未核实'} · HEAD：{short(entry.head)}</p><p className="break-all">采用输入：{entry.inputVersion}</p><p className="break-all">本机任务：{entry.taskDir ?? '目录尚未核实'}</p></li>)}</ol>{view.historyHasMore && <p className="mt-2">更早记录仍保留在本机，当前显示最近记录。</p>}</details>}
    </>}
    {dialog && view && <Modal open onClose={() => { if (!operation) setDialog(null) }} width={640} ariaLabel={dialog === 'first' ? '选择本机开发环境' : dialog === 'adopt-inputs' ? '比较并采用新输入' : '更换开发副本'}>
      <div className="min-w-0 space-y-4 p-4"><h3 className="text-my-md font-semibold text-my-primary">{dialog === 'first' ? '选择本机开发环境' : dialog === 'adopt-inputs' ? '比较并采用新输入' : '更换开发副本'}</h3><p className="break-words text-my-xs text-my-secondary">{snapshot.spaces.find((space) => space.id === task.spaceId)?.name} / {task.id} · {task.title}</p>
        {active && <div className="grid min-w-0 gap-3 sm:grid-cols-2"><div className="space-y-1 rounded-my-md border border-my-line p-3 text-my-xs"><p className="font-medium">原尝试 {active.ref.generation}</p><p className="break-all">{active.projectRoot}</p><p>分支：{active.branch ?? '未核实'}</p><p className="break-all">输入：{active.inputVersion}</p></div><div className="space-y-1 rounded-my-md border border-my-line p-3 text-my-xs"><p className="font-medium">新尝试</p><p className="break-all">{dialog === 'adopt-inputs' ? active.projectRoot : view.candidates.find((candidate) => candidate.id === candidateId)?.projectRoot ?? '下一步选择目录并原生核对'}</p><p className="break-all">输入：{view.currentInputVersion ?? '尚未核实'}</p><p>分支、改动与占用将在本机确认时核对。</p></div></div>}
        {dialog !== 'adopt-inputs' && <fieldset className="min-w-0 space-y-2"><legend className="mb-2 text-my-xs text-my-secondary">此设备已核对的候选副本</legend>{view.candidates.map((candidate) => <label key={candidate.id} className="flex min-w-0 items-start gap-2 rounded-my-md border border-my-line p-3 text-my-xs"><input type="radio" name="development-copy" className="mt-0.5 shrink-0" checked={candidateId === candidate.id} onChange={() => setCandidateId(candidate.id)} /><span className="min-w-0 flex-1"><span className="block break-all font-medium">{copyName(candidate.projectRoot)}</span><span className="block break-all text-my-secondary">{candidate.projectRoot}</span><span className="block text-my-tertiary">核对于 {new Date(candidate.checkedAt).toLocaleString()}</span></span>{candidateId === candidate.id && <Check size={13} />}</label>)}{!view.candidates.length && <p className="text-my-xs text-my-secondary">暂无可复用候选，请选择此电脑已有的 clone 或 worktree。</p>}<label className="flex items-center gap-2 text-my-xs"><input type="radio" name="development-copy" checked={!candidateId} onChange={() => setCandidateId('')} />选择其他本机目录…</label></fieldset>}
        <label className="flex items-start gap-2 text-my-xs text-my-secondary"><input type="checkbox" className="mt-0.5 shrink-0" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>{active ? '保留原文件、材料、会话与服务；新尝试分别准备，不自动启动 Agent 或服务。' : '核对实际资源、副本、分支与占用后绑定；准备不启动 Agent 或服务。'}</span></label>
        <footer className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={() => setDialog(null)}>取消</Button><Button disabled={!acknowledged || !writable || unknown || Boolean(view.sourceError)} onClick={() => { const mode = dialog; setDialog(null); if (mode === 'first') void prepare(candidateId || undefined); else void change(mode) }}>{dialog === 'first' ? '确认绑定并进入' : dialog === 'adopt-inputs' ? '核对并准备新尝试' : '下一步：本机核对'}</Button></footer>
      </div>
    </Modal>}
  </section>
}
