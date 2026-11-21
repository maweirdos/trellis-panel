import { useId, useMemo, useRef, useState, type JSX } from 'react'
import { CornerUpLeft, MoreHorizontal, RotateCcw, Send } from 'lucide-react'
import type { CruxActivity, CruxComment, CruxSnapshot, CruxTask } from '@shared/crux'
import { canConfirmTaskClarification } from '@shared/crux'
import { api } from '../../../api'
import { TaskPostFiles } from './TaskPostFiles'
import { useCrux } from '../../store'
import { useTaskDraftField, type TaskDraft } from './task-drafts'
import { useTaskSource } from './use-task-source'
import { Avatar, Button, Dropdown, DropdownItem } from '../../../my/ui'
import { promptDialog } from '../../../components/Dialogs'
import { formatCollaborationTime } from '../../ui'
import type { TaskMutation, TaskSourceOwner } from './use-task-source'
import './task-discussion.css'

interface DiscussionAuthor {
  name: string
  color: string
}

interface MentionQuery {
  start: number
  end: number
  query: string
}

interface MentionOption {
  id: string
  name: string
  color: string
}

type FeedEntry =
  | { kind: 'activity'; key: string; at: string; activity: CruxActivity }
  | { kind: 'thread'; key: string; at: string; root: CruxComment; replies: CruxComment[] }

function authorOf(snapshot: CruxSnapshot, authorId: string): DiscussionAuthor {
  if (authorId.startsWith('agent:')) {
    const agent = snapshot.agents.find((candidate) => candidate.id === authorId.slice(6))
    return { name: agent ? `Agent · ${agent.name}` : 'Agent', color: 'var(--my-avatar-bg)' }
  }
  const member = snapshot.members.find((candidate) => candidate.id === authorId)
  return member
    ? { name: member.name, color: `hsl(${member.avatarHue} 26% 38%)` }
    : { name: '成员不可用', color: 'var(--my-avatar-bg)' }
}

function timestamp(value: string): number {
  const time = Date.parse(value)
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

function activeMention(value: string, caret: number): MentionQuery | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret))
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null
}

function insertMention(value: string, mention: MentionQuery, name: string): string {
  return `${value.slice(0, mention.start)}@${name} ${value.slice(mention.end)}`
}

function activityAuthorLabel(snapshot: CruxSnapshot, authorId: string): string {
  if (authorId.startsWith('agent:')) {
    const agent = snapshot.agents.find((candidate) => candidate.id === authorId.slice(6))
    return `Agent「${agent?.name ?? 'Agent'}」`
  }
  return snapshot.members.find((candidate) => candidate.id === authorId)?.name ?? '成员不可用'
}

function isDuplicatedCommentActivity(activity: CruxActivity, comments: readonly CruxComment[], snapshot: CruxSnapshot): boolean {
  if (activity.kind !== 'comment') return false
  return comments.some((comment) => {
    const expected = `${activityAuthorLabel(snapshot, comment.authorId)} 评论：${comment.body.slice(0, 30)}${comment.body.length > 30 ? '……' : ''}`
    return expected === activity.text
  })
}

function buildFeed(snapshot: CruxSnapshot, comments: readonly CruxComment[], activities: readonly CruxActivity[]): FeedEntry[] {
  const rootComments = comments.filter((comment) => !comment.parentId || !comments.some((candidate) => candidate.id === comment.parentId))
  const childrenByParent = new Map<string, CruxComment[]>()
  for (const comment of comments) {
    if (!comment.parentId || !comments.some((candidate) => candidate.id === comment.parentId)) continue
    const children = childrenByParent.get(comment.parentId) ?? []
    children.push(comment)
    childrenByParent.set(comment.parentId, children)
  }
  const collectReplies = (parentId: string, visited: Set<string>): CruxComment[] => {
    const replies: CruxComment[] = []
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      replies.push(child, ...collectReplies(child.id, visited))
    }
    return replies
  }
  const entries: FeedEntry[] = rootComments.map((root) => ({
    kind: 'thread',
    key: `thread:${root.id}`,
    at: root.createdAt,
    root,
    replies: collectReplies(root.id, new Set([root.id])).sort((left: CruxComment, right: CruxComment) => timestamp(left.createdAt) - timestamp(right.createdAt))
  }))
  entries.push(...activities.filter((activity) => !isDuplicatedCommentActivity(activity, comments, snapshot)).map((activity) => ({
    kind: 'activity' as const,
    key: `activity:${activity.id}`,
    at: activity.at,
    activity
  })))
  return entries.slice().sort((left: FeedEntry, right: FeedEntry) => timestamp(left.at) - timestamp(right.at))
}

export function TaskDiscussion({ snapshot, task, actorId, disabled, mutate, taskDraft, source: parentSource }: {
  taskDraft: TaskDraft
  snapshot: CruxSnapshot
  task: CruxTask
  actorId?: string
  disabled: boolean
  mutate: TaskMutation
  source?: TaskSourceOwner
}): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const ownSource = useTaskSource({ taskId: task.id, spaceId: task.spaceId, embedded: Boolean(parentSource) })
  const source = parentSource ?? ownSource
  const [draft, setDraft] = useTaskDraftField(taskDraft, 'comment', '')
  const [replyToId, setReplyToId] = useTaskDraftField<string | null>(taskDraft, 'commentReplyId', null)
  const [caret, setCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dismissedMention, setDismissedMention] = useState('')
  const mentionListId = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const comments = useMemo(
    () => snapshot.comments.filter((comment) => comment.taskId === task.id),
    [snapshot.comments, task.id]
  )
  const activities = useMemo(
    () => snapshot.activities.filter((activity) => activity.taskId === task.id),
    [snapshot.activities, task.id]
  )
  const members = useMemo(
    () => snapshot.members.filter((member) => snapshot.spaces.find((space) => space.id === task.spaceId)?.memberIds.includes(member.id)),
    [snapshot.members, snapshot.spaces, task.spaceId]
  )
  const feed = useMemo(() => buildFeed(snapshot, comments, activities), [snapshot, comments, activities])
  const replying = comments.find((comment) => comment.id === replyToId)
  const canConfirm = canConfirmTaskClarification(snapshot, task, actorId)
  const activeQuery = activeMention(draft, caret)
  const mention = activeQuery && `${activeQuery.start}:${activeQuery.query}` !== dismissedMention ? activeQuery : null
  const mentionQuery = mention?.query
  const mentionOptions = useMemo(() => {
    if (mentionQuery === undefined) return []
    const query = mentionQuery.toLowerCase()
    return members
      .filter((member) => member.name.toLowerCase().includes(query))
      .map((member) => ({ id: member.id, name: member.name, color: `hsl(${member.avatarHue} 26% 38%)` }))
  }, [members, mentionQuery])
  const authorName = (id: string): string => authorOf(snapshot, id).name

  const changeClarification = async (commentId: string, action: 'confirm' | 'withdraw'): Promise<void> => {
    const history = task.clarifications?.filter((note) => note.commentId === commentId) ?? []
    const expectedCount = history.reduce((count, note) => count + (note.withdrawn ? 2 : 1), 0)
    const reason = action === 'withdraw'
      ? await promptDialog({ title: '撤回补充', label: '撤回原因', validator: text => text.trim() && text.trim().length <= 500 ? null : '请输入 1 到 500 字的原因' })
      : undefined
    if (reason === null) return
    await mutate('更新任务补充', () => api.crux.updateTask({ id: task.id, patch: { clarification: { commentId, action, expectedCount, reason } } }))
  }
  const chooseMention = (member: MentionOption): void => {
    if (!mention) return
    const value = insertMention(draft, mention, member.name)
    const nextCaret = mention.start + member.name.length + 2
    setDraft(value)
    setCaret(nextCaret)
    setMentionIndex(0)
    setDismissedMention('')
    requestAnimationFrame(() => {
      const field = input.current
      if (field) {
        field.focus()
        field.setSelectionRange(nextCaret, nextCaret)
      }
    })
  }
  const send = async (): Promise<void> => {
    if (disabled || !actorId || !draft.trim()) return
    const submitted = draft
    const result = await mutate('发表评论', () => api.crux.addComment({ taskId: task.id, body: submitted.trim(), authorId: actorId, parentId: replying?.id }))
    if (result) {
      setDraft((current) => current === submitted ? '' : current)
      setReplyToId(null)
      setCaret(0)
      setMentionIndex(0)
      setDismissedMention('')
    }
  }
  const syncCaret = (): void => {
    setCaret(input.current?.selectionStart ?? 0)
    setMentionIndex(0)
    setDismissedMention('')
  }
  const renderedMentionIndex = Math.min(mentionIndex, Math.max(0, mentionOptions.length - 1))

  return <section className="task-discussion" aria-label="任务动态">
    <div className="task-discussion-feed" role="feed" aria-label="任务动态流">
      {feed.length === 0 && <p className="task-discussion-empty">暂无动态</p>}
      {feed.map((entry) => {
        if (entry.kind === 'activity') {
          return <article key={entry.key} className="task-discussion-activity">
            <span className="task-discussion-event-dot" aria-hidden="true" />
            <p>{entry.activity.text}</p>
            <time dateTime={entry.activity.at}>{formatCollaborationTime(entry.activity.at)}</time>
          </article>
        }
        const { root, replies } = entry
        const rootAuthor = authorOf(snapshot, root.authorId)
        return <article key={entry.key} id={`task-comment-${root.id}`} tabIndex={-1} data-comment-id={root.id} className="task-discussion-thread">
          <div className="task-discussion-message">
            <Avatar name={rootAuthor.name} color={rootAuthor.color} size={24} />
            <div className="task-discussion-message-main">
              <div className="task-discussion-message-meta">
                <span className="task-discussion-author">{rootAuthor.name}</span>
                <time dateTime={root.createdAt}>{formatCollaborationTime(root.createdAt)}</time>
                {root.resolved && <span className="task-discussion-resolved">已解决</span>}
              </div>
              <p className={`task-discussion-body ${root.resolved ? 'is-resolved' : ''}`}>{root.body}</p>
              {root.sourceId && root.sourceFiles?.length ? <TaskPostFiles scope={{ workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }} sourceId={root.sourceId} files={root.sourceFiles} current={source.owns} /> : null}
            </div>
            <div className="task-discussion-actions">
              <Button size="sm" variant="ghost" aria-label={`回复 ${rootAuthor.name} 的评论`} disabled={disabled || !actorId} onClick={() => { setReplyToId(root.id); input.current?.focus() }}><CornerUpLeft size={14} /></Button>
              <Dropdown align="right" width={150} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" aria-label="更多评论操作" aria-expanded={open} disabled={disabled} onClick={toggle}><MoreHorizontal size={14} /></Button>}>
                {close => {
                  const active = task.clarifications?.some((note) => note.commentId === root.id && !note.withdrawn)
                  return <>
                    <DropdownItem onClick={() => { close(); void mutate('更新评论', () => api.crux.resolveComment({ id: root.id, resolved: !root.resolved })) }}>
                      {root.resolved ? '重新打开' : '标记解决'}
                    </DropdownItem>
                    {canConfirm && <DropdownItem onClick={() => { close(); void changeClarification(root.id, active ? 'withdraw' : 'confirm') }}>
                      {active ? '撤回补充' : '确认为补充'}
                    </DropdownItem>}
                  </>
                }}
              </Dropdown>
            </div>
          </div>
          {replies.length > 0 && <div className="task-discussion-replies">
            {replies.map((reply) => {
              const parent = comments.find((candidate) => candidate.id === reply.parentId)
              const parentAuthor = parent ? authorOf(snapshot, parent.authorId) : undefined
              const replyAuthor = authorOf(snapshot, reply.authorId)
              return <div key={reply.id} id={`task-comment-${reply.id}`} tabIndex={-1} data-comment-id={reply.id} className="task-discussion-message is-reply">
                <Avatar name={replyAuthor.name} color={replyAuthor.color} size={20} />
                <div className="task-discussion-message-main">
                  <div className="task-discussion-message-meta">
                    <span className="task-discussion-author">{replyAuthor.name}</span>
                    {parentAuthor && parent?.id !== root.id && <span className="task-discussion-parent">回复 {parentAuthor.name}</span>}
                    <time dateTime={reply.createdAt}>{formatCollaborationTime(reply.createdAt)}</time>
                    {reply.resolved && <span className="task-discussion-resolved">已解决</span>}
                  </div>
                  <p className={`task-discussion-body ${reply.resolved ? 'is-resolved' : ''}`}>{reply.body}</p>
                  {reply.sourceId && reply.sourceFiles?.length ? <TaskPostFiles scope={{ workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }} sourceId={reply.sourceId} files={reply.sourceFiles} current={source.owns} /> : null}
                </div>
                <div className="task-discussion-actions">
                  <Button size="sm" variant="ghost" aria-label={`回复 ${replyAuthor.name} 的评论`} disabled={disabled || !actorId} onClick={() => { setReplyToId(reply.id); input.current?.focus() }}><CornerUpLeft size={14} /></Button>
                  <Dropdown align="right" width={150} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" aria-label="更多回复操作" aria-expanded={open} disabled={disabled} onClick={toggle}><MoreHorizontal size={14} /></Button>}>
                    {close => {
                      const active = task.clarifications?.some((note) => note.commentId === reply.id && !note.withdrawn)
                      return <>
                        <DropdownItem onClick={() => { close(); void mutate('更新评论', () => api.crux.resolveComment({ id: reply.id, resolved: !reply.resolved })) }}>
                          {reply.resolved ? '重新打开' : '标记解决'}
                        </DropdownItem>
                        {canConfirm && <DropdownItem onClick={() => { close(); void changeClarification(reply.id, active ? 'withdraw' : 'confirm') }}>
                          {active ? '撤回补充' : '确认为补充'}
                        </DropdownItem>}
                      </>
                    }}
                  </Dropdown>
                </div>
              </div>
            })}
          </div>}
        </article>
      })}
    </div>

    {replying && <div className="task-discussion-reply-target">
      <RotateCcw size={13} aria-hidden="true" />
      <span>回复 {authorName(replying.authorId)}</span>
      <span className="task-discussion-reply-preview">{replying.body}</span>
      <Button size="sm" variant="ghost" aria-label="取消回复" disabled={disabled} onClick={() => setReplyToId(null)}>取消</Button>
    </div>}

    <div className="task-discussion-composer-wrap">
      {mention && mentionOptions.length > 0 && <div id={mentionListId} className="task-discussion-mentions" role="listbox" aria-label="提及成员">
        {mentionOptions.map((member, index) => <button
          key={member.id}
          id={`${mentionListId}-${index}`}
          type="button"
          role="option"
          aria-selected={index === renderedMentionIndex}
          className={`task-discussion-mention ${index === renderedMentionIndex ? 'is-active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => chooseMention(member)}
        ><Avatar name={member.name} color={member.color} size={18} />{member.name}</button>)}
      </div>}
      <div className="task-discussion-composer">
        <textarea
          id={`task-comment-input-${task.id}`}
          ref={input}
          className="task-discussion-input"
          aria-label={replying ? `回复 ${authorName(replying.authorId)}` : '发表评论'}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(mention && mentionOptions.length)}
          aria-controls={mentionListId}
          aria-activedescendant={mention && mentionOptions.length ? `${mentionListId}-${renderedMentionIndex}` : undefined}
          placeholder={replying ? `回复 ${authorName(replying.authorId)}…` : '写下评论…'}
          disabled={disabled || !actorId}
          rows={2}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); syncCaret() }}
          onClick={syncCaret}
          onFocus={syncCaret}
          onKeyDown={(event) => {
            if (mention && mentionOptions.length > 0) {
              if (event.key === 'ArrowDown' && !event.nativeEvent.isComposing) {
                event.preventDefault(); setMentionIndex((renderedMentionIndex + 1) % mentionOptions.length); return
              }
              if (event.key === 'ArrowUp' && !event.nativeEvent.isComposing) {
                event.preventDefault(); setMentionIndex((renderedMentionIndex - 1 + mentionOptions.length) % mentionOptions.length); return
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
                event.preventDefault(); chooseMention(mentionOptions[renderedMentionIndex]); return
              }
              if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                event.preventDefault(); setDismissedMention(activeQuery ? `${activeQuery.start}:${activeQuery.query}` : ''); return
              }
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
              event.preventDefault(); void send()
            }
          }}
        />
        <div className="task-discussion-composer-actions">
          <span className="task-discussion-shortcut" aria-hidden="true">Ctrl↵</span>
          <Button
            size="sm"
            variant="ghost"
            className="task-discussion-send"
            aria-label="发送评论"
            disabled={disabled || !actorId || !draft.trim()}
            onClick={() => void send()}
          ><Send size={14} aria-hidden="true" /></Button>
        </div>
      </div>
      {!actorId && <p role="status" className="task-discussion-unavailable">当前身份无法发表评论。</p>}
    </div>
  </section>
}
