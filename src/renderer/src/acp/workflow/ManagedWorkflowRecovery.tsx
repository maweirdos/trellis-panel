import { useRef, useState, type JSX } from 'react'
import { ArchiveRestore, ArrowUpRight, RefreshCw, Square } from 'lucide-react'
import type { RunRef } from '@shared/workflow'
import type { WorkflowWorkspaceRecovery } from '@shared/workflow-recovery'
import { api, hasIpc } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { projectRootKey } from '../../my/navigation'
import { Button, Modal } from '../../my/ui'
import { useApp } from '../../store'
import { useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { stableCommandId } from '../../utils/stable-command-id'

const states: Record<string, string> = {
  planned: '已规划', queued: '排队中', dispatched: '已派发', running: '运行中', waiting: '等待中',
  stopping: '正在停止', stopped: '已停止',
  cancelled: '已取消', verified: '已验证', failed: '失败', 'outcome-unknown': '结果待核对',
}
const terminal = new Set(['verified', 'stopped', 'cancelled', 'failed'])
const sameRun = (left: RunRef | undefined, right: RunRef): boolean =>
  left?.runId === right.runId && left.revision === right.revision
type StopReceipt = { commandId: string; run: RunRef; pending: boolean; text: string }

export function ManagedWorkflowRecovery({ root }: { root: string }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [record, setRecord] = useState<WorkflowWorkspaceRecovery>()
  const [target, setTarget] = useState<RunRef>()
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState('')
  const [receipts, setReceipts] = useState<StopReceipt[]>([])
  const generation = useRef(0)
  const lock = useRef(false)
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  if (!hasIpc || typeof api.managedWorkflow?.inspectRecovery !== 'function') return null

  function current(ticket: number): boolean {
    return generation.current === ticket && !signal?.aborted && canInteract() &&
      projectRootKey(useApp.getState().snapshot?.meta.root) === projectRootKey(root)
  }
  async function read(run: RunRef | undefined, ticket: number): Promise<void> {
    const result = await api.managedWorkflow.inspectRecovery(root, run ? { run } : {})
    if (!current(ticket)) return
    if (!result.ok) throw Error(result.error)
    const actual = result.value.projection?.snapshot?.run.run
    if (run && !sameRun(actual, run)) throw Error('返回记录与原工作流运行不匹配。')
    setTarget(run ?? actual)
    setRecord(result.value)
  }
  function rememberStop(receipt: StopReceipt): void {
    setReceipts(previous => [receipt, ...previous.filter(item => item.commandId !== receipt.commandId)])
  }
  async function reconcile(stop: StopReceipt, ticket: number): Promise<void> {
    const result = await api.managedWorkflow.inspectRecovery(root, { run: stop.run })
    if (!current(ticket)) return
    if (!result.ok) throw Error(result.error)
    const run = result.value.projection?.snapshot?.run
    if (!run || !sameRun(run.run, stop.run)) throw Error('返回记录与原停止请求的运行不匹配。')
    const settled = terminal.has(run.state)
    rememberStop({ ...stop, pending: !settled, text: `原运行${states[run.state] ?? run.state}，停止命令回执仍待确认。` })
  }
  async function execute(action: (ticket: number) => Promise<void>): Promise<void> {
    const ticket = generation.current
    if (lock.current || !current(ticket)) return
    lock.current = true
    setBusy(true); setIssue('')
    try { await action(ticket) }
    catch (cause) { if (current(ticket)) setIssue(cause instanceof Error ? cause.message : '工作流核对未完成。') }
    finally {
      lock.current = false
      if (current(ticket)) setBusy(false)
    }
  }

  const runState = record?.projection?.snapshot?.run.state
  const stopTarget = record?.stopTarget
  const canStop = Boolean(target && stopTarget && sameRun(stopTarget.run, target) &&
    runState && !terminal.has(runState) && record?.ownership?.state !== 'released' &&
    !receipts.some(receipt => receipt.pending && sameRun(receipt.run, target)))
  const projection = record?.projection
  const outputs = projection?.nodes.flatMap(node => node.run && node.outputRefs.length ? [{
    id: node.nodeId, title: projection.graph?.nodes.find(item => item.nodeId === node.nodeId)?.label ?? node.nodeId,
    run: node.run, refs: node.outputRefs,
  }] : []) ?? []

  function openOutput(run: RunRef, ref: string): void {
    void execute(async ticket => {
      const result = await api.managedWorkflow.recoveryArtifact(root, { run, ref })
      if (!current(ticket)) return
      if (!result.ok) throw Error(result.error)
      const origin = projection?.origin
      const response = await api.documentOpenWindow({ token: result.value.token, origin: origin ?? {} })
      if (current(ticket) && !response.ok) throw Error(response.error)
    })
  }

  function stop(): void {
    if (!stopTarget || !canStop) return
    const { run: selected, taskDir } = stopTarget
    void execute(async ticket => {
      const confirmed = await confirmDialog({ title: '停止这次工作流？', message: `${selected.runId} · r${selected.revision}`, confirmText: '停止', danger: true }, signal)
      if (!confirmed || !current(ticket)) return
      const commandId = await stableCommandId(JSON.stringify(['desktop-workflow-stop', projectRootKey(root), taskDir, selected]))
      if (!current(ticket)) return
      const receipt = { commandId, run: selected, pending: true, text: '停止回执待核对。' }
      rememberStop(receipt)
      const result = await api.managedWorkflow.stop(root, { taskDir, run: selected, commandId })
      if (!current(ticket)) return
      if (result.ok && result.value.commandId === commandId && sameRun(result.value.run, selected) && result.value.status === 'stopped') {
        rememberStop({ ...receipt, pending: false, text: '原停止回执已确认。' })
      } else if (result.ok && result.value.commandId === commandId && sameRun(result.value.run, selected) && result.value.status === 'requested') {
        rememberStop({ ...receipt, text: '停止请求已受理，仍待终态。' })
      } else if (!result.ok) {
        rememberStop({ ...receipt, text: result.error })
      }
      await read(undefined, ticket)
    })
  }

  return <>
    <button type="button" className="my-icon-control" aria-label="核对受管工作流" title="核对受管工作流" onClick={() => {
      if (lock.current || !canInteract()) return
      generation.current++
      setTarget(undefined); setRecord(undefined)
      setOpen(true)
      void execute(ticket => read(undefined, ticket))
    }}><ArchiveRestore size={16} aria-hidden="true" /></button>
    <Modal open={open} onClose={() => {
      if (lock.current) return
      generation.current++
      setTarget(undefined); setRecord(undefined)
      setOpen(false)
    }} ariaLabel="受管工作流" width={560}>
      <section className="space-y-3 p-4">
        <h2 className="my-item-title">受管工作流</h2>
        {target ? <>
          <p className="my-item-description break-all">{target.runId} · r{target.revision}</p>
          <p className="my-item-title" role="status">{runState ? states[runState] ?? runState : busy ? '正在核对当前运行…' : '运行待核对'}</p>
          {stopTarget && <p className="my-item-description">{stopTarget.taskDir}</p>}
          {record?.source.reason && <p className="my-item-description">{record.source.reason}</p>}
        </> : !busy && <p className="my-item-description">当前工程没有可核对的保留运行。</p>}
        {busy && <p role="status" className="my-item-description">正在核对原记录…</p>}
        {receipts.length > 0 && <details open={receipts.some(receipt => receipt.pending)}>
          <summary className="my-item-description">停止回执</summary>
          <ul className="space-y-2">{receipts.map(receipt => <li key={receipt.commandId} className="my-item-description break-words">
            <p>{receipt.run.runId} · r{receipt.run.revision} · {receipt.text}</p>
            {receipt.pending && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void execute(ticket => reconcile(receipt, ticket))}>
              核对原运行
            </Button>}
          </li>)}</ul>
        </details>}
        {issue && <p role="alert" className="my-item-description">{issue}</p>}
        {typeof api.managedWorkflow.recoveryArtifact === 'function' && outputs.length > 0 && <ul className="space-y-2" aria-label="原工作流产物">
          {outputs.map(output => <li key={output.id}>
            <p className="my-item-title">{output.title}</p>
            <div className="flex flex-wrap gap-2">
              {output.refs.map((ref, index) => <Button key={ref} size="sm" variant="ghost" disabled={busy} onClick={() => openOutput(output.run, ref)}>
                阅读原产物 {index + 1}<ArrowUpRight size={14} aria-hidden="true" />
              </Button>)}
            </div>
          </li>)}
        </ul>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void execute(ticket => read(target, ticket))}>
            <RefreshCw size={14} aria-hidden="true" />核对运行
          </Button>
          {canStop && <Button size="sm" variant="outline" disabled={busy} onClick={stop}>
            <Square size={14} aria-hidden="true" />停止原运行
          </Button>}
        </div>
      </section>
    </Modal>
  </>
}
