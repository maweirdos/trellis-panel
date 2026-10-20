import { useEffect, useId, useState, type JSX } from 'react'
import { CircleAlert, ChevronRight, Loader2, X } from 'lucide-react'
import { Button } from '../my/ui'
import type { AcpSessionRecord } from '../../../shared/types'
import { getModelRecovery } from './model-recovery'

export function describeConnectionError(message: string): { title: string; hint: string } {
  if (/session is in use by another|already in use|session.*locked/i.test(message)) return {
    title: '原会话正被其他客户端占用', hint: '请在占用它的窗口、终端或 IDE 中关闭该会话，再重试连接。你可以继续阅读和编辑草稿。'
  }
  if (/OpenCode.*free tier|OpenCode Zen Free/i.test(message) && /403|Forbidden|only.*within OpenCode/i.test(message)) return {
    title: '模型服务拒绝了当前请求', hint: '此免费服务仅允许在 OpenCode 内使用。请切换可用于当前执行引擎的模型或服务配置。'
  }
  if (/authentication required|AUTH_REQUIRED|not authenticated|not logged in|\b401\b/i.test(message)) return {
    title: '执行引擎需要登录或有效凭据', hint: '请检查本机执行引擎的登录与服务配置，完成后重试连接。'
  }
  if (/cannot replay saved.*model|model.*not.*advertis|ACP_MODEL_UNSUPPORTED|saved session model/i.test(message)) return { title: '原模型已不可用，无法继续此会话', hint: '需要由执行引擎验证另一个模型，再重新连接原会话。已有消息仍可阅读。' }
  if (/ECONN|ENOTFOUND|timeout|timed out|network|socket|connection.*(?:lost|closed|failed)/i.test(message)) return { title: '连接中断', hint: '请检查网络与模型服务，恢复后可以重试。重连不会自动发送草稿。' }
  return { title: '本次请求未完成', hint: message.length <= 180 ? message : '展开详情查看执行引擎返回的原因。你可以继续编辑草稿。' }
}

export function ConnectionNotice({ message }: { message: string }): JSX.Element {
  const { title, hint } = describeConnectionError(message)
  return <div role="alert" className="acp-connection-notice">
    <div className="acp-notice-heading"><CircleAlert size={15} aria-hidden="true" /><strong>{title}</strong></div><p>{hint}</p>
    <details><summary><ChevronRight size={12} />错误详情</summary><pre>{message}</pre></details>
  </div>
}

/** Current connection recovery is independent from stored turn outcomes. */
export function ConnectionRecovery({ session, message, pending, onRetry, onCleanup, onRetryHistory, onNew, onEnvironment }: {
  session: AcpSessionRecord; message?: string; pending?: string
  onRetry: () => void; onCleanup: () => void
  onRetryHistory: () => void; onNew: () => void; onEnvironment: () => void
}): JSX.Element | null {
  const [reading, setReading] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  const offline = !['ready', 'busy', 'awaiting_permission', 'cancelling', 'starting'].includes(session.status)
  const storage = session.historyPersistence
  const degraded = storage?.state === 'degraded'
  const canRetryStorage = storage && (!storage.unarchivedCount || storage.pendingCount > storage.unarchivedCount)
  const cleanup = session.cleanupRequired === true
  const { modelFailure, models, environmentRequired } = getModelRecovery(session, message)
  const confirmed = session.recovery?.modelConfirmed === true
  const environmentPrimary = environmentRequired || (modelFailure && models.length === 0)
  useEffect(() => { setReading(false); setDetailsOpen(false) }, [session.sessionId, session.connectionGeneration, message, degraded, cleanup, pending])
  const description = confirmed ? { title: '模型已确认，连接仍失败', hint: `执行引擎已确认 ${session.recovery?.confirmedModelId ?? session.currentModelId ?? '所选模型'}。请排查连接后重试，草稿不会自动发送。` }
    : cleanup ? { title: '会话尚未完全结束', hint: '执行引擎的资源仍由此会话持有。请重试结束，完成后再连接。' }
    : modelFailure ? { title: '当前模型不可用', hint: '请在输入框右下角选择可用模型并重新连接。已有消息和草稿会保留，重连后需手动发送。' }
    : message ? describeConnectionError(message) : { title: '当前未连接', hint: '连接原会话后可继续对话。重连不会自动发送草稿。' }
  if (!offline && !message && !degraded && !cleanup && !['resume', 'recover-model', 'kill'].includes(pending ?? '')) return null
  if (reading && !degraded && !cleanup && !pending) return null
  return <section className="acp-recovery" aria-label="当前连接与保存状态">
    {(offline || message || cleanup || pending) && <>
      <div className="acp-recovery-line" role="status">
        <button type="button" className="acp-recovery-status-trigger" aria-expanded={detailsOpen} aria-controls={detailsId} title={detailsOpen ? '收起错误详情' : '展开错误详情'} onClick={() => setDetailsOpen((value) => !value)}>
          {pending ? <Loader2 size={14} className="acp-progress-spinner" aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
          <strong>{pending === 'recover-model' ? '正在验证模型并连接…' : pending === 'resume' ? '正在连接原会话…' : pending === 'kill' ? '正在结束会话…' : description.title}</strong>
          <ChevronRight size={11} className={detailsOpen ? 'is-open' : ''} aria-hidden="true" />
        </button>
        {cleanup ? <Button size="sm" variant="outline" className="acp-recovery-primary" disabled={Boolean(pending)} onClick={onCleanup}>重试结束会话</Button> : environmentPrimary ? <Button size="sm" variant="outline" className="acp-recovery-primary" disabled={Boolean(pending)} onClick={onEnvironment}>检查执行引擎</Button> : offline && session.canResume && !modelFailure && <Button size="sm" variant="outline" className="acp-recovery-primary" disabled={Boolean(pending)} onClick={onRetry}>重试连接</Button>}
        {!degraded && !cleanup && !pending && <button type="button" className="acp-recovery-dismiss my-icon-control" aria-label="收起连接提示" title="稍后处理" onClick={() => setReading(true)}><X size={13} /></button>}
      </div>
      <div id={detailsId} hidden={!detailsOpen} className="acp-recovery-details my-scrollbar" role="region" aria-label="连接错误详情">
        <p>{description.hint}</p>
        {modelFailure && models.length === 0 && <p>未保存可验证的模型选项。可在执行引擎中修复配置后重试，或新建对话。</p>}
        {message && <pre>{message}</pre>}
        {offline && <div className="acp-recovery-secondary">{!environmentPrimary && <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={onEnvironment}>检查执行引擎</Button>}{(!session.canResume || (modelFailure && models.length === 0)) && <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={onNew}>新建对话</Button>}</div>}
      </div>
    </>}
    {degraded && <div className="acp-storage-notice" role="alert"><div className="acp-recovery-line"><CircleAlert size={14} aria-hidden="true" /><strong>{storage.unarchivedCount ? `${storage.unarchivedCount} 条事件未确认保存，历史可能不完整` : `部分内容尚未保存${storage.pendingCount ? ` · ${storage.pendingCount} 条事件待写入` : ''}`}</strong>{canRetryStorage && <Button size="sm" variant="outline" className="acp-recovery-primary" disabled={Boolean(pending)} onClick={onRetryHistory}>重试保存</Button>}</div><details><summary>保存详情</summary><p>{storage.unarchivedCount ? '部分事件未能进入保存队列，重试不能补回；可核对保留的原始快照。' : '请先重试保存，再关闭应用。'}</p>{storage.error && <pre>{storage.error}</pre>}</details></div>}
  </section>
}
