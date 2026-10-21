import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { GitBranch, RefreshCw, X } from 'lucide-react'
import type { FlowDef } from '../../../../shared/types'
import type { RunRef } from '../../../../shared/workflow'
import type { WorkflowRevisionPreview, WorkflowRevisionStatus } from '../../../../shared/workflow-revisions'
import { api } from '../../api'
import { Button, Modal } from '../../my/ui'
import { Select } from '../../components/Select'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { RevisionImpactCanvas } from './RevisionImpactCanvas'
import { readPendingRevision, revisionNeedsReconciliation, revisionOwnerKey, revisionStateLabel, sameRun, savePendingRevision, type PendingRevision } from './revision-model'

const message = (error: unknown): string => error instanceof Error ? error.message : '修订操作未能确认，请核对原接纳记录。'
type Props = { root: string; taskDir: string; run: RunRef | null; originKey: string; disabled: boolean; onRefresh: () => Promise<void>; onOpenMaterial: (ref: string, run: RunRef) => Promise<boolean> | boolean | void }
type Draft = { flowId: string; reason: string; boundary: 'after-current-stage' | 'now'; startStepId: string; inputs: Record<string, string> }
export function WorkflowRevision({ root, taskDir, run, originKey, disabled, onRefresh, onOpenMaterial }: Props): JSX.Element | null {
  const interactive = useInteractionActive(), canInteract = useInteractionGuard(), signal = useInteractionSignal()
  const key = revisionOwnerKey(root, taskDir), lifetime = useMemo(() => Symbol('revision-view'), [key, originKey, signal])
  const current = useRef({ key, lifetime, run }); current.current = { key, lifetime, run }
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [notice, setNotice] = useState('')
  const [openedBy, setOpenedBy] = useState<symbol | null>(null)
  const [editing, setEditing] = useState(true)
  const [draft, setDraft] = useState<Draft>({ flowId: 'trellis-managed-v1', reason: '', boundary: 'after-current-stage', startStepId: '', inputs: {} })
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; description: string }>>([])
  const [fields, setFields] = useState<FlowDef['inputs']>([]), [steps, setSteps] = useState<Array<{ id: string; label: string }>>([])
  const [sourceReady, setSourceReady] = useState(true), [sourceLoading, setSourceLoading] = useState(false)
  const [target, setTarget] = useState<RunRef | null>(null), [preview, setPreview] = useState<WorkflowRevisionPreview | null>(null)
  const [pendingState, setPendingState] = useState<{ key: string; value: PendingRevision | null }>(() => ({ key, value: readPendingRevision(root, taskDir) }))
  const pending = pendingState.key === key ? pendingState.value : readPendingRevision(root, taskDir)
  const [receipt, setReceipt] = useState<{ commandId: string; value: WorkflowRevisionStatus } | null>(null)
  const status = pending && receipt?.commandId === pending.commandId ? receipt.value : null
  const [notFound, setNotFound] = useState(false), [now, setNow] = useState(Date.now())
  const lock = useRef<symbol | null>(null), ticket = useRef(0), sourceTicket = useRef(0)
  const valid = (captured: typeof current.current): boolean => current.current.lifetime === captured.lifetime && canInteract() && !signal?.aborted
  const statusRef = useRef(status); statusRef.current = status
  const apiAvailable = ['previewRevision', 'acceptRevision', 'cancelRevision', 'revisionStatus'].every((name) => typeof api.managedWorkflow?.[name as keyof typeof api.managedWorkflow] === 'function')
  const unsettled = Boolean(pending && revisionNeedsReconciliation(status))
  useEffect(() => { ticket.current++; sourceTicket.current++; setSourceReady(true); setSourceLoading(false); setOpen(false); setBusy(''); setNotice(''); setPreview(null); setTarget(null); setReceipt(null); setNotFound(false); lock.current = null; setPendingState({ key, value: readPendingRevision(root, taskDir) }) }, [lifetime])
  const operation = async (name: string, action: (captured: typeof current.current) => Promise<void>): Promise<void> => {
    if (lock.current || !canInteract() || !apiAvailable) return
    const token = Symbol(name), captured = current.current
    lock.current = token; setBusy(name); setNotice('')
    try { await action(captured) } catch (error) { if (valid(captured)) setNotice(message(error)) }
    finally { if (lock.current === token) { lock.current = null; if (valid(captured)) setBusy('') } }
  }
  const query = async (): Promise<void> => operation('status', async (captured) => {
    if (!pending) return
    const result = await api.managedWorkflow.revisionStatus(root, { taskDir: pending.taskDir, commandId: pending.commandId })
    if (!valid(captured)) return
    if (!result.ok) { setNotFound(result.code === 'E_NOT_FOUND'); throw Error(result.code === 'E_NOT_FOUND' ? '该命令目前尚无可读取的接纳记录；这不证明原请求以后不会提交。保留原命令标识。' : result.error) }
    if (result.value.commandId !== pending.commandId || result.value.previewId !== pending.previewId || !sameRun(result.value.target, pending.run)) throw Error('返回的修订记录与原命令不匹配，未采用该结果。')
    setReceipt({ commandId: pending.commandId, value: result.value }); setNotFound(false)
    await onRefresh()
  })
  useEffect(() => {
    if (!open || !interactive || openedBy !== lifetime) return
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    if (pending) void query()
    const poll = window.setInterval(() => { if (!document.hidden && pending && revisionNeedsReconciliation(statusRef.current)) void query() }, 2000)
    return () => { clearInterval(clock); clearInterval(poll) }
  }, [open, openedBy, interactive, pending?.commandId, lifetime])
  const begin = async (): Promise<void> => {
    if (!canInteract()) return
    // Another retained window may have saved a lookup while this view stayed
    // mounted. Reopening is an explicit read; it never resends that command.
    setPendingState({ key, value: readPendingRevision(root, taskDir) })
    sourceTicket.current++; setSourceReady(true); setSourceLoading(false)
    setOpenedBy(lifetime); setOpen(true); setEditing(true); setNotice(''); setPreview(null); setTarget(run ? { ...run } : null); setDraft({ flowId: 'trellis-managed-v1', reason: '', boundary: 'after-current-stage', startStepId: '', inputs: {} }); setFields([]); setSteps([])
    const serial = ++ticket.current, captured = current.current
    try {
      const result = await api.managedWorkflow.templates(root)
      if (!valid(captured) || serial !== ticket.current) return
      if (!result.ok) throw Error(result.error)
      setTemplates(result.value)
    } catch (error) { if (valid(captured) && serial === ticket.current) setNotice(message(error)) }
  }
  const change = (patch: Partial<Draft>): void => { ticket.current++; setPreview(null); setDraft((old) => ({ ...old, ...patch })); setNotice('') }
  const chooseFlow = async (id: string): Promise<void> => {
    change({ flowId: id, startStepId: '', inputs: {} }); setFields([]); setSteps([])
    const serial = ++sourceTicket.current, captured = current.current
    if (id === 'trellis-managed-v1') { setSourceReady(true); setSourceLoading(false); return }
    setSourceReady(false); setSourceLoading(true)
    try {
      const result = await api.flowRead(id)
      if (!valid(captured) || serial !== sourceTicket.current) return
      if (!result.ok || !result.def) throw Error(result.error ?? '工作流源文件不可读')
      const definition = result.def
      setFields(definition.inputs); setSteps(definition.phases.flatMap((phase) => phase.steps.map((step) => ({ id: step.id, label: `${phase.name} / ${step.name}` }))))
      setDraft((old) => ({ ...old, inputs: Object.fromEntries(definition.inputs.map((field) => [field.name, field.default ?? ''])) }))
      setPreview(null); setSourceReady(true)
    } catch (error) { if (valid(captured) && serial === sourceTicket.current) setNotice(message(error)) }
    finally { if (valid(captured) && serial === sourceTicket.current) setSourceLoading(false) }
  }
  const createPreview = async (): Promise<void> => operation('preview', async (captured) => {
    if (!sourceReady || sourceLoading) throw Error('请先读取并核对所选流程的实际输入项。')
    if (!target || unsettled || !sameRun(target, captured.run)) throw Error('当前运行已变化，请关闭后重新打开，核对新的目标运行。')
    const serial = ticket.current
    const result = await api.managedWorkflow.previewRevision(root, { taskDir, run: target, flowId: draft.flowId, reason: draft.reason, boundary: draft.boundary, ...(draft.startStepId ? { startStepId: draft.startStepId } : {}), inputs: draft.inputs })
    if (!valid(captured) || serial !== ticket.current) return
    if (!result.ok) throw Error(result.error)
    if (!sameRun(result.value.target, target) || result.value.taskDir !== taskDir || result.value.flowId !== draft.flowId) throw Error('预览与所选目标不一致，未提供采用操作。')
    setPreview(result.value); setEditing(false)
    if (!steps.length) setSteps(result.value.impact.nodes.filter((node) => node.after !== null).map((node) => ({ id: node.stepId, label: result.value.after.nodes.find((entry) => entry.nodeId === node.after)?.label ?? node.stepId })))
    setNow(Date.now())
  })
  const accept = async (retry = false): Promise<void> => operation('accept', async (captured) => {
    if (!preview || !target || (!retry && unsettled) || !sameRun(target, captured.run) || preview.expiresAt <= Date.now()) throw Error('预览已过期、目标已变化或有未核对的接纳请求；请先核对原记录。')
    const command: PendingRevision = retry && pending ? pending : { version: 1, root, taskDir, run: { ...target }, previewId: preview.previewId, commandId: crypto.randomUUID() }
    if (command.previewId !== preview.previewId || !sameRun(command.run, target)) throw Error('不能把原命令用于另一份预览。')
    savePendingRevision(root, taskDir, command)
    setPendingState({ key, value: command }); setNotFound(false)
    const result = await api.managedWorkflow.acceptRevision(root, { taskDir: command.taskDir, run: command.run, previewId: command.previewId, commandId: command.commandId })
    if (!valid(captured)) return
    if (!result.ok) throw Error(`${result.error}；采用结果尚未确认，请先核对原命令，不能另发一份。`)
    if (result.value.commandId !== command.commandId || result.value.previewId !== command.previewId || !sameRun(result.value.target, command.run)) throw Error('接纳回执与原命令不匹配，请保留原标识并核对。')
    setReceipt({ commandId: command.commandId, value: result.value }); await onRefresh()
  })
  const cancel = async (): Promise<void> => operation('cancel', async (captured) => {
    if (!pending) return
    const result = await api.managedWorkflow.cancelRevision(root, { taskDir: pending.taskDir, commandId: pending.commandId })
    if (!valid(captured)) return
    if (!result.ok) throw Error(result.error)
    if (result.value.commandId !== pending.commandId || result.value.previewId !== pending.previewId || !sameRun(result.value.target, pending.run)) throw Error('取消回执与原命令不匹配，请核对。')
    setReceipt({ commandId: pending.commandId, value: result.value }); await onRefresh()
  })
  if (!apiAvailable || !taskDir) return null
  const stale = Boolean(target && !sameRun(target, run)), expired = Boolean(preview && preview.expiresAt <= now)
  const visiblePreview = preview ?? status?.preview ?? null
  return <>
    <button type="button" className="my-control my-control-sm" disabled={Boolean(busy) || (disabled && !pending)} onClick={() => { void begin() }}><GitBranch size={13} />{pending ? '修订接纳记录' : '调整后续流程'}</button>
    <Modal open={open && openedBy === lifetime && interactive} onClose={() => { ticket.current++; setOpen(false) }} ariaLabel="调整后续工作流" width={1100}>
      <section className="wf-revision"><header><div><p>工作流修订</p><h2>{pending && unsettled ? '核对原接纳请求' : '调整后续流程'}</h2></div><button type="button" className="my-icon-control" aria-label="关闭流程修订" onClick={() => { ticket.current++; setOpen(false) }}><X size={17} /></button></header>
        <div className="wf-revision-body my-scrollbar">
          {pending && <section className="wf-revision-receipt" aria-label="修订接纳状态"><div><strong>{status ? revisionStateLabel(status.state) : '接纳结果尚未核对'}</strong><Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => { void query() }}><RefreshCw size={12} />核对接纳结果</Button></div><p>{status?.reason ?? '状态只依据原接纳记录；预览保存、请求采用与后继执行是不同事实。'}</p>{status?.recoveryRequired && <p role="alert">原执行或接续仍需恢复核对，不能视为已停止或已成功接续。</p>}<details><summary>原命令与运行来源</summary><p>{pending.commandId} · {pending.run.runId} / r{pending.run.revision}<br />预览 {pending.previewId}</p>{status?.evidenceRefs.map((ref) => <p key={ref}>{ref}</p>)}</details>
            {unsettled && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => { void cancel() }}>取消这次接续</Button>}<p>取消发生在停止之后，只阻止后继；不会恢复原执行。停止未确认的状态会保留。</p>
            {!unsettled && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => { try { savePendingRevision(root, taskDir, null, pending.commandId); setPendingState({ key, value: null }); setReceipt(null); setPreview(null); setTarget(run ? { ...run } : null) } catch (error) { setNotice(message(error)) } }}>保留历史，准备新的修订</Button>}
          </section>}
          {!pending && (!preview || editing) && <div className="wf-revision-form"><label>后续流程<Select ariaLabel="修订工作流模板" disabled={Boolean(busy)} value={draft.flowId} options={templates.map((item) => ({ value: item.id, label: item.name }))} onChange={(id) => { void chooseFlow(id) }} /></label><label>调整原因<textarea aria-label="流程调整原因" className="my-input" rows={2} maxLength={2000} disabled={Boolean(busy)} value={draft.reason} onChange={(event) => change({ reason: event.target.value })} placeholder="例如：补充权限检查，再继续实现。" /></label><div className="wf-revision-fields"><label>接续时机<Select ariaLabel="修订接续时机" disabled={Boolean(busy)} value={draft.boundary} options={[{ value: 'after-current-stage', label: '当前阶段完成后' }, { value: 'now', label: '现在停止并切换' }]} onChange={(value) => change({ boundary: value as Draft['boundary'] })} /></label><label>从哪个阶段开始<Select ariaLabel="修订开始阶段" disabled={Boolean(busy) || !steps.length} value={draft.startStepId} options={[{ value: '', label: steps.length ? '由预览确定首个阶段' : '预览后可选择实际阶段' }, ...steps.map((step) => ({ value: step.id, label: step.label }))]} onChange={(startStepId) => change({ startStepId })} /></label></div>{fields.map((field) => <label key={field.name}>{field.label}{field.required ? '（必填）' : ''}<input aria-label={`修订输入 ${field.label}`} className="my-input" disabled={Boolean(busy)} value={draft.inputs[field.name] ?? ''} onChange={(event) => change({ inputs: { ...draft.inputs, [field.name]: event.target.value } })} /></label>)}<p>{draft.boundary === 'now' ? '先核对原生停止结果，再启动后继。无法确认停止时不会切换执行。' : '当前阶段继续完成，达到已选边界后接续；坏稿不会中断它。'}</p><Button size="sm" variant="outline" disabled={Boolean(busy) || disabled || sourceLoading || !sourceReady || !target || stale || !draft.reason.trim() || fields.some((field) => field.required && !draft.inputs[field.name]?.trim())} onClick={() => { void createPreview() }}>{busy === 'preview' ? '核对差异中…' : '预览差异与影响'}</Button>{sourceLoading && <p role="status">正在读取流程的实际输入项…</p>}{!sourceReady && !sourceLoading && <Button size="sm" variant="ghost" onClick={() => { void chooseFlow(draft.flowId) }}>重新读取流程选项</Button>}</div>}
          {!pending && preview && !editing && <section className="wf-revision-draft-summary"><div><strong>{preview.reason}</strong><p>{preview.boundary === 'now' ? '现在停止并切换' : '当前阶段完成后接续'} · 从 {steps.find((step) => step.id === preview.startStepId)?.label ?? preview.startStepId} 开始</p></div><Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => setEditing(true)}>修改修订选项</Button></section>}
          {stale && <p className="wf-notice" role="alert">运行已推进，当前预览仍指向原运行。请关闭后重新打开，不能自动改为新目标。</p>}
          {visiblePreview && <><RevisionImpactCanvas preview={visiblePreview} /><section className="wf-revision-impact-notes"><h3>影响与交接</h3><p>{visiblePreview.impact.affectedNodeIds.length} 个节点受影响 · {visiblePreview.impact.preservedNodeIds.length} 个定义保留 · 开始阶段 {steps.find((step) => step.id === visiblePreview.startStepId)?.label ?? visiblePreview.startStepId}</p>{visiblePreview.impact.pendingBoundaryOutput && <p>尚待当前边界产物：{visiblePreview.before.nodes.find((node) => node.nodeId === visiblePreview.impact.pendingBoundaryOutput)?.label ?? visiblePreview.impact.pendingBoundaryOutput}</p>}<p>已有产物只作为版本化输入交接；不会据此自动跳过执行，也不代表原生记忆复用。</p>{visiblePreview.impact.materials.map((material, index) => <button key={material.ref} type="button" className="my-control my-control-sm" disabled={Boolean(busy)} onClick={() => { void operation('material', async (captured) => { const opened = await onOpenMaterial(material.ref, material.run); if (valid(captured) && opened === false) throw Error('交接材料未能打开，请核对原版本来源或检查保留记录。') }) }}>查看交接材料 {index + 1} · 仅作输入</button>)}<details><summary>原因、限制与预览来源</summary><p>{visiblePreview.reason}</p>{visiblePreview.limitations.map((line) => <p key={line}>{line}</p>)}<p>预览到期 {new Date(visiblePreview.expiresAt).toLocaleString()} · 摘要 {visiblePreview.fingerprint}</p></details></section></>}
          {notice && <p className="wf-notice" role="alert">{notice}</p>}
        </div>
        {preview && <footer><span>{expired ? '预览已过期，请重新核对' : stale ? '原目标已经变化' : pending ? '已保存原命令身份' : '预览已保存，尚未采用'}</span>{(!pending || notFound) && <Button variant="primary" disabled={Boolean(busy) || disabled || stale || expired || (unsettled && !notFound)} onClick={() => { void accept(Boolean(pending)) }}>{pending ? notFound ? '按原命令重新请求采用' : '等待原接纳结果' : draft.boundary === 'now' ? '采用并停止后切换' : '采用此修订'}</Button>}</footer>}
      </section>
    </Modal>
  </>
}
