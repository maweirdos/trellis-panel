import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, CircleAlert, CircleHelp, Lightbulb, Link2Off, MessageSquare, MessageSquarePlus, Send, X } from 'lucide-react'
import type { CreationComment, CreationView } from '@shared/creations'
import { Button, Dropdown, DropdownItem } from '../my/ui'
import { useHifox } from '../hifox/store'
import { targetLabel, type CreationTarget } from './creation-state'
import type { useCreationCommands } from './hooks'

const severityLabels: Record<CreationComment['severity'], string> = { required: '必须修改', suggestion: '建议', question: '疑问' }
const statusLabels: Record<CreationComment['status'], string> = { open: '待处理', confirmed: '已确认', dismissed: '已关闭' }

function SeverityIcon({ value }: { value: CreationComment['severity'] }): JSX.Element {
  return value === 'required' ? <CircleAlert size={13} /> : value === 'question' ? <CircleHelp size={13} /> : <Lightbulb size={13} />
}

function ReviewComment({ comment, index, active, missing, selected, selectable, canReply, canManage, busy, displayedRevisionId, origin, reviewed, onSelect, onToggle, onCommand, onOpenOrigin }: {
  comment: CreationComment; index: number; active: boolean; missing: boolean; selected: boolean; selectable: boolean
  canReply: boolean; canManage: boolean; busy: boolean; displayedRevisionId: string; origin: string; reviewed?: string
  onSelect: () => void; onToggle: () => void
  onOpenOrigin: () => void
  onCommand: ReturnType<typeof useCreationCommands>['run']
}): JSX.Element {
  const members = useHifox((state) => state.snapshot?.members)
  const [reply, setReply] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [finalRule, setFinalRule] = useState(comment.finalRule ?? comment.body)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const author = members?.find((member) => member.id === comment.authorId)?.name ?? comment.authorId
  return <article className="creation-comment" data-active={active || undefined} id={`creation-comment-${comment.commentId}`}>
    <div className="creation-row creation-comment-heading">
      <Button variant="ghost" size="sm" aria-label={`定位批注 ${index}`} onClick={onSelect}><span className="creation-marker-number">{index}</span><span className="creation-truncate">{author}</span></Button>
      <span className="creation-grow" />
      {selectable && <input type="checkbox" aria-label={`将批注 ${index} 用于 AI 修改`} checked={selected} onChange={onToggle} disabled={busy} />}
    </div>
    <Button size="sm" variant="ghost" className="creation-comment-target" onClick={onSelect}>{missing ? <Link2Off size={13} /> : <MessageSquare size={13} />}<span className="creation-truncate">{targetLabel(comment.target)}</span></Button>
    {comment.revisionId !== displayedRevisionId && <Button size="sm" variant="ghost" title={comment.revisionId} onClick={onOpenOrigin}>来源 {origin}</Button>}
    {missing && <p className="creation-anchor-missing"><Link2Off size={13} />原位置已失效，可按意见手动核对</p>}
    <p className="creation-comment-body">{comment.body}</p>
    <div className="creation-row creation-meta"><SeverityIcon value={comment.severity} /><span>{severityLabels[comment.severity]}</span><span>· {statusLabels[comment.status]}</span>{comment.private && <span>· 草稿批注</span>}</div>
    {comment.finalRule && <div className="creation-final-rule"><Check size={13} /><div><p>{comment.finalRule}</p>{reviewed && <span className="creation-meta">确认于 {reviewed}</span>}</div></div>}
    {canManage && <div className="creation-row creation-comment-actions">
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setFinalRule(comment.finalRule ?? comment.body); setConfirming(!confirming) }}><Check size={13} />{comment.status === 'confirmed' ? comment.reviewedRevisionId === displayedRevisionId ? '编辑规则' : '在此修订确认' : '确认规则'}</Button>
      {comment.status === 'open' ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onCommand({ action: 'disposition', commentId: comment.commentId, status: 'dismissed' })}><X size={13} />关闭</Button>
        : <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onCommand({ action: 'disposition', commentId: comment.commentId, status: 'open' })}>重新打开</Button>}
    </div>}
    {confirming && <div className="creation-form-grid">
      <label>最终规则<textarea autoFocus className="my-input" value={finalRule} rows={3} maxLength={2000} onChange={(event) => setFinalRule(event.target.value)} /></label>
      <div className="creation-row"><Button size="sm" variant="primary" disabled={busy || !finalRule.trim()} onClick={() => {
        const disposition = { action: 'disposition' as const, commentId: comment.commentId, status: 'confirmed' as const, finalRule: finalRule.trim(), ...(comment.private ? {} : { reviewRevisionId: displayedRevisionId }) }
        void onCommand(disposition).then((result) => { if (result && mounted.current) setConfirming(false) })
      }}>确认</Button><Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>取消</Button></div>
    </div>}
    <details className="creation-replies"><summary>回复{comment.replies.length ? ` (${comment.replies.length})` : ''}</summary>
      {comment.replies.map((entry) => <div key={entry.replyId} className="creation-reply"><span className="creation-meta">{members?.find((member) => member.id === entry.authorId)?.name ?? entry.authorId}</span><p>{entry.body}</p></div>)}
      {canReply && comment.replies.length < 12 && <div className="creation-form-grid"><textarea className="my-input" aria-label={`回复批注 ${index}`} placeholder="回复意见…" value={reply} maxLength={2000} rows={2} onChange={(event) => setReply(event.target.value)} /><Button size="sm" disabled={busy || !reply.trim()} onClick={() => {
        const submitted = reply
        void onCommand({ action: 'reply', commentId: comment.commentId, body: reply.trim() }).then((result) => { if (result && mounted.current) setReply((current) => current === submitted ? '' : current) })
      }}><Send size={13} />回复</Button></div>}
      {comment.replies.length >= 12 && <p className="creation-meta">已达到此批注的 12 条回复上限</p>}
    </details>
  </article>
}

export function ReviewPanel({ view, target, activeCommentId, missingAnchors, canAnnotate, busy, selectedIds, loadingMore, onTarget, onSelectComment, onSelection, onCommand, onLoadMore, onOpenOrigin }: {
  view: CreationView; target: CreationTarget | null; activeCommentId: string | null; missingAnchors: Set<string>
  canAnnotate: boolean; busy: boolean; selectedIds: string[]; loadingMore: boolean
  onTarget: (target: CreationTarget | null) => void; onSelectComment: (comment: CreationComment) => void
  onSelection: (ids: string[]) => void; onCommand: ReturnType<typeof useCreationCommands>['run']; onLoadMore: () => Promise<void>
  onOpenOrigin: (revisionId: string) => void
}): JSX.Element {
  const actorId = useHifox((state) => state.workspaceContext.actorId)
  const [body, setBody] = useState('')
  const [severity, setSeverity] = useState<CreationComment['severity']>('suggestion')
  const [selectionError, setSelectionError] = useState('')
  const editor = useRef<HTMLTextAreaElement>(null)
  const mounted = useRef(true)
  const targetKey = JSON.stringify(target)
  const targetRef = useRef(targetKey)
  targetRef.current = targetKey
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (target) editor.current?.focus({ preventScroll: true }) }, [targetKey])
  const toggle = (id: string): void => {
    if (selectedIds.includes(id)) { onSelection(selectedIds.filter((entry) => entry !== id)); setSelectionError('') }
    else if (selectedIds.length >= 8) setSelectionError('每次最多选择 8 条批注')
    else { onSelection([...selectedIds, id]); setSelectionError('') }
  }
  const revisionLabel = (id: string): string => {
    const revision = view.revisions.find((entry) => entry.revisionId === id)
    return revision ? `R${revision.number}` : '草稿'
  }
  return <aside className="creation-review" aria-label="批注与讨论">
    <div className="creation-section-heading"><h2><MessageSquare size={16} />批注 <span className="creation-meta">{view.comments.length}{view.nextCommentOffset !== null ? '+' : ''}</span></h2>
      {canAnnotate && <Button size="sm" variant="ghost" aria-label="添加整体意见" onClick={() => onTarget({ kind: 'general' })}><MessageSquarePlus size={15} /></Button>}
    </div>
    <div className="creation-comment-list my-scrollbar">
      {view.comments.length === 0 && <div className="creation-empty-inline"><MessageSquare size={24} /><p>暂无批注</p></div>}
      {view.comments.map((comment, index) => <ReviewComment key={comment.commentId} comment={comment} index={index + 1} active={activeCommentId === comment.commentId} missing={missingAnchors.has(comment.commentId)}
        selected={selectedIds.includes(comment.commentId)} selectable={view.summary.canEdit}
        canReply={canAnnotate && (view.summary.canManageReview || view.revisions.find((revision) => revision.revisionId === comment.revisionId)?.reviewerIds.includes(actorId ?? '') === true)}
        canManage={view.summary.canManageReview || (canAnnotate && comment.authorId === actorId)} busy={busy}
        displayedRevisionId={view.selected.revisionId} origin={revisionLabel(comment.revisionId)} reviewed={'reviewedRevisionId' in comment && typeof comment.reviewedRevisionId === 'string' ? revisionLabel(comment.reviewedRevisionId) : undefined}
        onSelect={() => onSelectComment(comment)} onToggle={() => toggle(comment.commentId)} onCommand={onCommand} onOpenOrigin={() => onOpenOrigin(comment.revisionId)} />)}
      {view.nextCommentOffset !== null && <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => void onLoadMore()}>{loadingMore ? '正在加载…' : '加载更多批注'}</Button>}
    </div>
    {selectionError && <p role="status" className="creation-inline-error">{selectionError}</p>}
    {target && canAnnotate && <div className="creation-annotation-editor">
      <div className="creation-row"><span className="creation-meta creation-truncate">{targetLabel(target)}</span><span className="creation-grow" /><Button variant="ghost" size="sm" aria-label="收起批注编辑" onClick={() => onTarget(null)}><X size={14} /></Button></div>
      <textarea ref={editor} className="my-input" aria-label="批注意见" placeholder="写下这处意见…" value={body} maxLength={2000} rows={3} onChange={(event) => setBody(event.target.value)} />
      <div className="creation-row"><Dropdown trigger={({ toggle: open }) => <Button variant="ghost" size="sm" onClick={open}><SeverityIcon value={severity} />{severityLabels[severity]}</Button>}>
        {(close) => <>{(Object.keys(severityLabels) as CreationComment['severity'][]).map((value) => <DropdownItem key={value} selected={severity === value} icon={<SeverityIcon value={value} />} onClick={() => { setSeverity(value); close() }}>{severityLabels[value]}</DropdownItem>)}</>}
      </Dropdown><span className="creation-grow" /><Button size="sm" variant="primary" disabled={busy || !body.trim()} onClick={() => {
        const submitted = body
        const originalTarget = targetKey
        void onCommand({ action: 'annotate', revisionId: view.selected.revisionId, target, body: body.trim(), severity }).then((result) => {
          if (result && mounted.current && targetRef.current === originalTarget) { setBody((current) => current === submitted ? '' : current); onTarget(null) }
        })
      }}><Send size={13} />发送</Button></div>
    </div>}
  </aside>
}
