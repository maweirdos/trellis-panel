import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, ArchiveRestore, RefreshCw, X } from 'lucide-react'
import type { RunRef } from '../../../../shared/workflow'
import type { WorkflowWorkspaceRecovery } from '../../../../shared/workflow-recovery'
import { api } from '../../api'
import { Button, Modal } from '../../my/ui'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { WorkflowCanvas } from './WorkflowCanvas'
import { StageHistory, type StageHistoryTarget } from './StageHistory'
import { currentNode, defaultWorkflowView, stateLabel, type WorkflowView } from './model'

const sourceLabel = (state: string): string => ({ available: '原任务来源可读取', missing: '原任务来源缺失', ambiguous: '原任务身份存在歧义', unavailable: '来源信息暂不可读取', unknown: '没有可解析的保留归属' })[state] ?? '来源尚未核实'
type Props = { root: string; run: RunRef | null; originKey: string; onOpenHistory: (id: string) => void }
/** Explicit readonly retained-owner inspection; no force-unlock or restart controls. */
export function WorkflowRecovery({ root, run, originKey, onOpenHistory }: Props): JSX.Element | null {
  const interactive = useInteractionActive(), canInteract = useInteractionGuard(), signal = useInteractionSignal()
  const lifetime = useMemo(() => Symbol('recovery-view'), [root, originKey, signal])
  const current = useRef(lifetime); current.current = lifetime
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [openedBy, setOpenedBy] = useState<symbol | null>(null)
  const [target, setTarget] = useState<RunRef | null>(null), [result, setResult] = useState<WorkflowWorkspaceRecovery | null>(null)
  const [view, setView] = useState<WorkflowView>(() => ({ ...defaultWorkflowView(), collapsed: false }))
  const [historyTarget, setHistoryTarget] = useState<StageHistoryTarget | null>(null)
  const ticket = useRef(0), lock = useRef<symbol | null>(null)
  const valid = (captured: symbol, serial: number): boolean => current.current === captured && ticket.current === serial && canInteract() && !signal?.aborted
  const available = typeof api.managedWorkflow?.inspectRecovery === 'function' && typeof api.managedWorkflow?.recoveryArtifact === 'function'
  useEffect(() => { ticket.current++; lock.current = null; setOpen(false); setBusy(''); setError(''); setResult(null); setTarget(null); setHistoryTarget(null) }, [lifetime])
  const inspect = async (exact: RunRef | null, clear: boolean): Promise<void> => {
    if (!canInteract() || lock.current || !available) return
    const captured = lifetime, serial = ++ticket.current, token = Symbol('inspect')
    lock.current = token; setBusy('inspect'); setError(''); if (clear) { setResult(null); setView({ ...defaultWorkflowView(), collapsed: false }) }
    try {
      const response = await api.managedWorkflow.inspectRecovery(root, exact ? { run: exact } : {})
      if (!valid(captured, serial)) return
      if (!response.ok) throw Error(response.error)
      const actual = response.value.projection?.snapshot?.run.run
      if (exact && (!actual || actual.runId !== exact.runId || actual.revision !== exact.revision)) throw Error('保留记录未匹配指定运行，未改为展示其他运行。')
      setResult(response.value)
      // A head lookup becomes a fixed inspection after its first actual reply.
      if (!exact && actual) setTarget({ ...actual })
    } catch (cause) { if (valid(captured, serial)) setError(cause instanceof Error ? cause.message : '无法检查保留的运行记录') }
    finally { if (lock.current === token) { lock.current = null; if (valid(captured, serial)) setBusy('') } }
  }
  const begin = (): void => { if (!canInteract()) return; const exact = run ? { ...run } : null; setTarget(exact); setOpenedBy(lifetime); setOpen(true); setHistoryTarget(null); void inspect(exact, true) }
  const close = (): void => { ticket.current++; lock.current = null; setBusy(''); setOpen(false); setHistoryTarget(null) }
  const openArtifact = async (ref: string, selectedRun: RunRef): Promise<void> => {
    if (!canInteract() || lock.current) return
    const captured = lifetime, serial = ++ticket.current, token = Symbol('artifact')
    lock.current = token; setBusy('artifact'); setError('')
    try {
      const response = await api.managedWorkflow.recoveryArtifact(root, { run: selectedRun, ref })
      if (!valid(captured, serial)) return
      if (!response.ok) throw Error(response.error)
      const origin = result?.projection?.origin
      const opened = await api.documentOpenWindow({ token: response.value.token, ...(origin ? { origin: { sessionId: origin.sessionId, connectionGeneration: origin.connectionGeneration } } : { origin: {} }) })
      if (valid(captured, serial) && !opened.ok) throw Error(opened.error)
    } catch (cause) { if (valid(captured, serial)) setError(cause instanceof Error ? cause.message : '原始固定版本暂不可读取') }
    finally { if (lock.current === token) { lock.current = null; if (valid(captured, serial)) setBusy('') } }
  }
  if (!available || !root) return null
  const projection = result?.projection, graph = projection?.graph
  const selected = graph?.nodes.find((node) => node.nodeId === view.selected) ?? graph?.nodes.find((node) => node.nodeId === currentNode(projection ?? null)) ?? graph?.nodes[0]
  const node = projection?.nodes.find((entry) => entry.nodeId === selected?.nodeId)
  return <>
    <button type="button" className="my-control my-control-sm" onClick={begin}><ArchiveRestore size={13} />检查保留记录</button>
    <Modal open={open && openedBy === lifetime && interactive} onClose={close} ariaLabel="保留的工作流运行记录" width={940}>
      <section className="wf-recovery"><header><div><p>只读恢复检查</p><h2>保留的运行记录</h2></div><button type="button" className="my-icon-control" aria-label="关闭保留运行记录" onClick={close}><X size={17} /></button></header>
        <div className="wf-recovery-body my-scrollbar"><div className="wf-recovery-summary"><strong>{result ? sourceLabel(result.source.state) : busy ? '正在检查实际保留归属…' : '尚未取得检查记录'}</strong><Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => { void inspect(target, false) }}><RefreshCw size={12} />核对这次运行</Button></div><p className="wf-recovery-caution">这里保留原运行及产物的来源。旧进程号、租约时间或目录缺失，都不能证明原生执行已停止；不会据此自动释放或重跑。</p>
          {error && <p role="alert" className="wf-notice">{error}</p>}
          {result && <><details className="wf-recovery-source"><summary>来源与归属详情</summary><p>{result.source.reason ?? '来源按原任务身份核对，不按同名目录替换。'}</p>{result.source.alias && <p>已记录来源：{result.source.alias.currentDir} · {result.source.alias.status}</p>}{result.source.candidates.map((candidate) => <p key={candidate}>身份匹配候选：{candidate}</p>)}<p>{result.ownership ? `保留归属：${result.ownership.state}；${result.ownership.recoveryRequired ? '需要恢复核对' : '未记录恢复标记'}；租约记录 ${new Date(result.ownership.leaseUntil).toLocaleString()}` : '未找到此项目工作区的保留归属。'}</p>{projection?.snapshot && <p>原运行 {projection.snapshot.run.run.runId} / r{projection.snapshot.run.run.revision}</p>}</details>
            {!projection?.snapshot && <div className="wf-empty"><ArchiveRestore size={23} /><p>没有可展示的保留运行。</p><small>这不是对其他外部进程的停止证明。</small></div>}
            {graph && projection && <><WorkflowCanvas graph={graph} snapshot={projection} view={view} onView={(patch) => setView((old) => ({ ...old, ...patch }))} onSelected={(id) => setView((old) => ({ ...old, selected: id }))} locate={currentNode(projection)} />{selected && <section className="wf-recovery-stage"><div className="wf-detail-title"><strong>{selected.label}</strong><span>{stateLabel(node?.state ?? 'planned')}</span></div>{selected.kind === 'gate' ? <p>平台依据固定产物执行检查；此节点不代表原生会话。</p> : node?.sessionId && node.turnId && node.run ? <Button size="sm" variant="outline" onClick={() => { if (canInteract() && node.sessionId && node.turnId && node.run) setHistoryTarget({ sessionId: node.sessionId, turnId: node.turnId, run: node.run, historySeq: node.historySeq, historyCommitted: node.historyCommitted }) }}>查看原阶段对话<ArrowUpRight size={12} /></Button> : <p>没有可核实的原执行轮次，不以最近会话替代。</p>}{node?.outputRefs.map((ref, index) => <Button key={ref} size="sm" variant="ghost" disabled={Boolean(busy) || !node.run} onClick={() => { if (node.run) void openArtifact(ref, node.run) }}>阅读原产物 {index + 1}<ArrowUpRight size={12} /></Button>)}<details><summary>原阶段来源与提交位置</summary><p>{node?.sessionId ?? '未观察到会话'} · {node?.turnId ?? '未观察到轮次'} · {node?.historyCommitted ? `历史已提交 #${node.historySeq ?? '未观察到'}` : '历史提交未确认'}</p>{node?.outputRefs.map((ref) => <p key={ref}>{ref}</p>)}</details></section>}</>}
          </>}
        </div>
      </section>
    </Modal>
    <StageHistory target={open && openedBy === lifetime && interactive ? historyTarget : null} onClose={() => setHistoryTarget(null)} onOpenFull={onOpenHistory} />
  </>
}
