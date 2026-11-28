import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Copy, FileText, RefreshCw, X } from 'lucide-react'
import type { TaskConversationContinuation } from '../../../../shared/task-conversations'
import { errorText } from '../../../../shared/errors'
import { statusLabel } from '../../utils/labels'
import { useInteractionActive, useInteractionGuard } from '../../utils/interaction-scope'
import { Button, Modal } from '../ui'
import { taskConversationDirectory, type TaskConversationController } from '../use-task-conversations'

export function TaskContinuationModal({ projectRoot, taskDir, taskTitle, historyOnly, reason, controller, onClose }: {
  projectRoot: string
  taskDir: string
  taskTitle: string
  historyOnly: boolean
  reason?: string
  controller: TaskConversationController
  onClose: () => void
}): JSX.Element {
  const active = useInteractionActive()
  const canInteract = useInteractionGuard()
  const mounted = useRef(false)
  const sequence = useRef(0)
  const [packet, setPacket] = useState<TaskConversationContinuation | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { prepare } = controller
  const load = useCallback(async (): Promise<void> => {
    if (!canInteract()) return
    const request = ++sequence.current
    setLoading(true)
    setPacket(null)
    setError(null)
    try {
      const result = await prepare(taskDir)
      if (mounted.current && canInteract() && request === sequence.current) setPacket(result)
    } catch (cause) {
      if (mounted.current && canInteract() && request === sequence.current) setError(errorText(cause, '读取任务接续说明失败。'))
    } finally {
      if (mounted.current && canInteract() && request === sequence.current) setLoading(false)
    }
  }, [prepare, taskDir, canInteract])
  useEffect(() => {
    mounted.current = true
    if (active) void load()
    return () => { mounted.current = false; sequence.current++ }
  }, [active, load])
  const copy = async (): Promise<void> => {
    if (!packet || !canInteract() || controller.pendingTaskDir !== null) return
    const request = sequence.current
    const result = await controller.continueTask(taskDir)
    if (result && mounted.current && canInteract() && request === sequence.current) setPacket(result.packet)
  }
  const history = packet ? packet.mode === 'history' : historyOnly
  const feedback = controller.feedback?.taskDir && taskConversationDirectory(projectRoot, controller.feedback.taskDir) === taskConversationDirectory(projectRoot, taskDir) ? controller.feedback : null
  const busy = controller.pendingTaskDir !== null

  return <Modal open={active} onClose={onClose} width={560} placement="center" ariaLabel={history ? '任务交接与历史资料' : '接续当前任务'}>
    <div className="my-modal-content my-task-continuation">
      <header className="my-task-conversation-association__header">
        <div className="min-w-0"><h2 className="text-my-lg font-medium text-my-primary">{history ? '任务交接与历史资料' : '接续此任务'}</h2><p className="my-task-conversation-association__task">{packet?.taskTitle ?? taskTitle}</p></div>
        <button type="button" className="my-icon-control" aria-label="关闭任务接续说明" onClick={onClose}><X size={16} /></button>
      </header>
      <p className="my-task-continuation__note"><FileText size={16} aria-hidden="true" /><span>{history ? '此任务已完成或归档。可查看或复制交接资料，不会重新执行任务。' : '尚未恢复旧会话历史。复制说明后，在常用的外部编辑器中粘贴并发送。'}</span></p>
      {reason && <p className="text-my-xs text-my-secondary">{reason}</p>}
      {loading && <p role="status" className="text-my-sm text-my-secondary">准备当前任务的说明…</p>}
      {error && <div className="flex items-center gap-2"><p role="alert" className="text-my-sm text-my-danger-text">{error}</p><Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw size={14} />重试</Button></div>}
      {packet && <>
        <p className="text-my-xs text-my-secondary">当前状态：{statusLabel(packet.status)}</p>
        <pre tabIndex={0} aria-label={history ? '当前任务交接资料' : '当前任务接续说明'} className="my-task-continuation__text my-scrollbar">{packet.text}</pre>
        {packet.issues.length > 0 && <ul className="text-my-xs text-my-secondary">{packet.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      </>}
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'text-my-sm text-my-danger-text' : 'text-my-sm text-my-secondary'}>{feedback.message}</p>}
      <footer className="my-task-conversation-association__footer">
        <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        <Button variant="primary" size="sm" disabled={!packet || loading || busy} onClick={() => void copy()}><Copy size={14} />{busy ? '复制中…' : history ? '复制交接资料' : '复制接续说明'}</Button>
      </footer>
    </div>
  </Modal>
}
