import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import type { TimelineEvent } from '../../../../shared/types'
import type { RunRef } from '../../../../shared/workflow'
import { api } from '../../api'
import { Button, Modal } from '../../my/ui'
import { useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { EventRow } from '../TranscriptRow'
import { compileItems } from '../timeline'

export type StageHistoryTarget = { sessionId: string; turnId: string; run: RunRef; historySeq: number | null; historyCommitted: boolean }
/** Ephemeral, read-only view of the original archive, scoped to one recorded turn. */
export function StageHistory({ target, onClose, onOpenFull }: { target: StageHistoryTarget | null; onClose: () => void; onOpenFull: (id: string) => void }): JSX.Element {
  const canInteract = useInteractionGuard(), signal = useInteractionSignal()
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loadedKey, setLoadedKey] = useState('')
  const [before, setBefore] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const ticket = useRef(0)
  const identity = target ? JSON.stringify(target) : ''
  const owner = useRef(identity); owner.current = identity
  const read = async (more = false): Promise<void> => {
    if (!target || !canInteract()) return
    const serial = ++ticket.current, key = identity, selected = target
    setLoadedKey(identity)
    setBusy(true); setError('')
    if (!more) { setEvents([]); setNotice(''); setBefore(null) }
    try {
      let cursor = more ? before : null
      let excludedUnsequenced = false
      for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
        if (serial !== ticket.current || key !== owner.current || signal?.aborted || !canInteract()) return
        const page = await api.acpHistoryEvents(selected.sessionId, { ...(cursor ? { before: cursor } : {}), limit: 200 })
        if (serial !== ticket.current || key !== owner.current || signal?.aborted || !canInteract()) return
        if (!page.ok) throw Error(page.error)
        const sameTurn = page.events.filter((event) => event.sessionId === selected.sessionId && event.turnId === selected.turnId)
        const pinned = selected.historyCommitted && selected.historySeq !== null
        excludedUnsequenced ||= pinned && sameTurn.some((event) => typeof event.historySeq !== 'number')
        const matching = sameTurn.filter((event) => !pinned || (typeof event.historySeq === 'number' && event.historySeq <= selected.historySeq!))
        cursor = page.hasEarlier ? page.beforeCursor : null
        setBefore(cursor)
        if (matching.length) {
          setBefore(page.startsMidTurn ? cursor : null)
          let bytes = 0
          const combined = [...new Map([...matching, ...(more ? events : [])].map((event) => [event.id, event])).values()]
          const bounded = combined.slice(0, 500).filter((event) => { bytes += (event.text?.length ?? 0) * 2; return bytes <= 512 * 1024 })
          setEvents(bounded)
          setNotice((excludedUnsequenced ? '已排除缺少提交位置的记录，不能确认它属于该固定历史版本。' : '') + (bounded.length < combined.length || page.oversized ? '本轮较长，当前展示有界记录；可打开完整执行会话继续阅读。' : page.startsMidTurn || page.coverage.state !== 'complete' ? '档案未能确认此轮开头或完整覆盖，当前仅展示实际找到的记录。' : '已定位到原执行轮次，其他轮次不会混入。'))
          return
        }
        if (!cursor) { setNotice(excludedUnsequenced ? '该轮记录缺少提交位置，不能作为此固定历史版本展示。' : '原档案中尚未找到该轮次，不能用最新一轮替代。'); return }
      }
      setNotice('本次已向前查找 8 页，尚未定位该轮次；可继续查找或打开完整会话。')
    } catch (cause) { if (serial === ticket.current && key === owner.current) setError(cause instanceof Error ? cause.message : '读取原执行历史失败') }
    finally { if (serial === ticket.current && key === owner.current) setBusy(false) }
  }
  useEffect(() => { if (target && canInteract()) void read(); return () => { ticket.current++ } }, [identity, signal])
  const items = useMemo(() => compileItems(loadedKey === identity ? events : []), [events, loadedKey, identity])
  return <Modal open={Boolean(target)} onClose={onClose} ariaLabel="本阶段原始执行记录" width={800}>
    <section className="wf-history"><header><h2>本阶段执行记录</h2><button type="button" className="my-icon-control" aria-label="关闭阶段执行记录" onClick={onClose}><X size={16} /></button></header>
      {target && <><p>{target.historyCommitted ? '查看该阶段已提交的历史版本' : '历史提交尚未确认'}</p><details className="wf-history-identity"><summary>执行来源与提交位置</summary><p>运行 {target.run.runId} / r{target.run.revision} · 会话 {target.sessionId}<br />轮次 {target.turnId} · {target.historyCommitted ? `历史已提交 #${target.historySeq ?? '未观察到'}` : '历史提交未确认'}</p></details><div className="wf-history-actions"><Button size="sm" variant="outline" onClick={() => { if (canInteract()) { onClose(); onOpenFull(target.sessionId) } }}>打开完整执行会话<ArrowUpRight size={12} /></Button>{before && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void read(true) }}>继续向前查找</Button>}</div></>}
      {(notice || error || busy || loadedKey !== identity) && <p role={error && loadedKey === identity ? 'alert' : 'status'} className="wf-history-notice">{loadedKey !== identity || busy ? '正在原历史档案中定位本轮记录…' : error || notice}</p>}
      <div className="wf-history-events my-scrollbar">{items.map((item) => ['user', 'agent', 'thought', 'tool', 'activity', 'turn'].includes(item.type)
        ? <EventRow key={item.key} item={item.type === 'activity' ? { ...item, active: false } : item} events={events} pendingPerm={{}} permissionPending={{}} permissionErrors={{}} suppressWorkingIndicator onRespond={() => {}} onOpenTask={() => {}} onOpenArtifact={() => {}} onOpenSpec={() => {}} onOpenJira={() => {}} />
        : <p key={item.key} className="wf-history-static-event">{item.type === 'perm' ? '历史权限事件（仅供追溯，不含当前可操作的授权请求）' : '此轮还包含来源或材料记录，可在完整执行会话中查看。'}</p>)}</div>
    </section>
  </Modal>
}
