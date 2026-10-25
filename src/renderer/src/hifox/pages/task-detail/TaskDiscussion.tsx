import { useRef, useState, type JSX } from 'react'
import type { HifoxSnapshot, HifoxTask } from '@shared/hifox'
import { api } from '../../../api'
import { Button, Tooltip } from '../../../my/ui'
import { memberOf } from '../../store'
import { Field, formatCollaborationTime, textareaClass } from '../../ui'
import type { TaskMutation } from './use-task-source'

export function TaskDiscussion({ snapshot, task, actorId, disabled, mutate }: {
  snapshot: HifoxSnapshot
  task: HifoxTask
  actorId?: string
  disabled: boolean
  mutate: TaskMutation
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [replyToId, setReplyToId] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const comments = snapshot.comments.filter((comment) => comment.taskId === task.id)
  const members = snapshot.members.filter((member) => snapshot.spaces.find((space) => space.id === task.spaceId)?.memberIds.includes(member.id))
  const replying = comments.find((comment) => comment.id === replyToId)
  const mention = draft.match(/(?:^|\s)@([^\s@]*)$/)
  const candidates = mention ? members.filter((member) => member.name.toLowerCase().includes(mention[1].toLowerCase())) : []
  const authorName = (id: string): string => id.startsWith('agent:')
    ? `Agent · ${snapshot.agents.find((agent) => agent.id === id.slice(6))?.name ?? 'Agent'}`
    : memberOf(snapshot, id)?.name ?? '成员不可用'
  const send = async (): Promise<void> => {
    if (disabled || !actorId || !draft.trim()) return
    const submitted = draft
    const result = await mutate('发表评论', () => api.hifox.addComment({ taskId: task.id, body: submitted.trim(), authorId: actorId, parentId: replying?.id }))
    if (result) { setDraft((current) => current === submitted ? '' : current); setReplyToId(null) }
  }
  return <section className="flex flex-col gap-3" aria-label="任务讨论">
    {!comments.length && <p className="text-my-sm text-my-tertiary">暂无讨论</p>}
    {comments.map((comment) => {
      const parent = comments.find((candidate) => candidate.id === comment.parentId)
      return <article key={comment.id} data-comment-id={comment.id} className="border-b border-my-line pb-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-my-xs text-my-tertiary"><span className="font-medium text-my-secondary">{authorName(comment.authorId)}</span><time dateTime={comment.createdAt}>{formatCollaborationTime(comment.createdAt)}</time>{comment.resolved && <span>已解决</span>}<div className="ml-auto flex gap-1"><Button size="sm" variant="ghost" disabled={disabled || !actorId} onClick={() => { setReplyToId(comment.id); input.current?.focus() }}>回复</Button><Button size="sm" variant="ghost" disabled={disabled || !actorId} onClick={() => void mutate('更新评论', () => api.hifox.resolveComment({ id: comment.id, resolved: !comment.resolved }))}>{comment.resolved ? '重新打开' : '标记解决'}</Button></div></div>
        {parent && <p className="mb-2 truncate rounded-my-sm bg-my-layer-1 px-2 py-1 text-my-xs text-my-tertiary">回复 {authorName(parent.authorId)}：{parent.body.slice(0, 100)}</p>}
        <p className={`whitespace-pre-wrap break-words text-my-sm ${comment.resolved ? 'text-my-tertiary' : 'text-my-primary'}`}>{comment.body}</p>
      </article>
    })}
    {replying && <div className="flex items-center gap-2 rounded-my-md bg-my-layer-1 p-2"><span className="min-w-0 flex-1 truncate text-my-xs text-my-secondary">回复 {authorName(replying.authorId)}：{replying.body.slice(0, 100)}</span><Button size="sm" variant="ghost" disabled={disabled} onClick={() => setReplyToId(null)}>取消回复</Button></div>}
    <Tooltip label="输入 @成员姓名 提醒成员；Ctrl+Enter 或 Command+Enter 发送" wrap><span className="w-full"><Field label="发表评论"><textarea ref={input} className={textareaClass} disabled={disabled || !actorId} rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /></Field></span></Tooltip>
    {candidates.length > 0 && <div className="flex flex-wrap gap-2" aria-label="提及成员">{candidates.map((member) => <Button key={member.id} size="sm" disabled={disabled} onClick={() => { setDraft((current) => current.replace(/@[^\s@]*$/, `@${member.name} `)); input.current?.focus() }}>@{member.name}</Button>)}</div>}
    {!actorId && <p role="status" className="text-my-xs text-my-tertiary">当前身份无法发表评论。</p>}
    <div className="flex justify-end"><Button size="sm" variant="primary" disabled={disabled || !actorId || !draft.trim()} onClick={() => void send()}>发送评论</Button></div>
  </section>
}
