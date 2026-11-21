import { useEffect, useRef, useState, type JSX } from 'react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import { postSources } from '@shared/crux'
import type { TeamContentJob } from '@shared/team-content'
import { api } from '../../../api'
import { Button } from '../../../my/ui'
import { MarkdownView } from '../../../components/MarkdownView'
import { useCrux } from '../../store'
import { readPostFile } from './TaskPostFiles'
import { bodyDigest } from '../../intake/requirements'
import { textareaClass } from '../../ui'
import { useTaskDraftField, type TaskDraft } from './task-drafts'
import type { TaskSourceOwner } from './use-task-source'

export function TaskResearch({ task, snapshot, source, draft, onQuote }: {
  task: CruxTask; snapshot: CruxSnapshot; source: TaskSourceOwner; draft: TaskDraft; onQuote(text: string): void
}): JSX.Element {
  const context = useCrux(state => state.workspaceContext)
  const content = api.teamContent
  const [question, setQuestion] = useTaskDraftField(draft, 'researchQuestion', '')
  const [pendingId, setPendingId] = useTaskDraftField(draft, 'researchCommand', '')
  const [job, setJob] = useTaskDraftField<TeamContentJob | null>(draft, 'researchJob', null)
  const [, setComment] = useTaskDraftField(draft, 'comment', '')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const flight = useRef(false)
  const [busy, setBusy] = useState(false)
  const active = job?.state === 'pending' || job?.state === 'running'
  const scope = { workspaceKey: context.key, taskId: task.id }
  const matches = (result: TeamContentJob, id: string): boolean => result.commandId === id &&
    result.kind === 'summary' && result.ownerId === context.actorId && result.instanceId === context.instanceId &&
    result.epoch === context.epoch && result.projectId === context.projectId && result.spaceId === task.spaceId &&
    result.taskId === task.id && result.taskCreatedAt === task.createdAt
  useEffect(() => {
    if (!content || (!active && !pendingId) || busy) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const read = async (): Promise<void> => {
      try {
        const reply = pendingId ? await content.receipt({ ...scope, commandId: pendingId }) :
          await content.job({ ...scope, jobId: job!.jobId })
        if (!live || !source.owns()) return
        if (!reply.ok) throw Error(reply.error)
        if (!reply.data) throw Error('暂未查到原请求回执，请重新核对。')
        if (!matches(reply.data, pendingId || job!.commandId)) throw Error('返回结果与原任务不符')
        setJob(reply.data); setPendingId(''); setError('')
        if (['pending', 'running'].includes(reply.data.state)) timer = setTimeout(() => void read(), 1500)
      } catch (cause) { if (live && source.owns()) setError(cause instanceof Error ? cause.message : '读取失败') }
    }
    timer = setTimeout(() => void read(), 350)
    return () => { live = false; clearTimeout(timer) }
  }, [context.key, context.epoch, active, pendingId, busy, job?.jobId, attempt])

  const ask = async (): Promise<void> => {
    if (!content || flight.current || pendingId || active || !source.canWrite()) return
    const ticket = source.ticket()
    flight.current = true; setBusy(true); setError('')
    try {
      const comments = snapshot.comments.filter(comment => comment.taskId === task.id).map(comment => ({
        id: comment.id, replyTo: comment.parentId, author: comment.authorId, text: comment.body
      }))
      const material = task.handoff?.material
      let document: string | undefined
      if (material) {
        if (!api.cruxMaterials) throw Error('当前客户端无法读取原需求版本')
        const fixed = await api.cruxMaterials.read({ ...scope, spaceId: task.spaceId, taskCreatedAt: task.createdAt,
          documentId: material.documentId, versionId: material.versionId })
        if (!source.canWrite(ticket)) return
        if (!fixed.ok) throw Error(fixed.error)
        if (fixed.value.selected.bodyDigest !== material.bodyDigest || fixed.value.selected.versionId !== material.versionId ||
          fixed.value.document.taskId !== task.id || fixed.value.document.taskCreatedAt !== task.createdAt) throw Error('原需求版本已变化')
        if (await bodyDigest(fixed.value.text) !== material.bodyDigest) throw Error('需求正文与所选版本不符')
        document = fixed.value.text
      }
      const bundles = postSources(task, snapshot.comments)
      const attachments = []
      for (const bundle of bundles) for (const file of bundle.files) {
        let text: string | undefined
        if (/\.(?:txt|md|csv|tsv|json)$/i.test(file.name) && file.bytes <= 24 * 1024) {
          const bytes = await readPostFile({ ...scope, spaceId: task.spaceId, taskCreatedAt: task.createdAt }, bundle.id, file, () => source.canWrite(ticket))
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* Show the unread version alongside the readable sources. */ }
        }
        attachments.push({ name: file.name, revision: file.revision, ...(text !== undefined ? { text } : { coverage: '仅有文件名和版本，未读取正文' }) })
      }
      const text = JSON.stringify({ question: question.trim() || '梳理已有依据和仍需业务负责人决定的问题。回答时注明评论或资料来源。',
        comments, document, attachments, previousAnswer: job?.candidate?.body })
      if (!source.canWrite(ticket)) return
      if (new TextEncoder().encode(text).byteLength > 32 * 1024) throw Error('本次调研材料超过团队单次 32 KiB 上限')
      const commandId = crypto.randomUUID()
      setPendingId(commandId)
      const reply = await content.generate({ ...scope, spaceId: task.spaceId, taskCreatedAt: task.createdAt,
        expectedTaskUpdatedAt: task.updatedAt, kind: 'summary', commandId, text })
      if (!source.owns(ticket)) return
      if (!reply.ok) { if (!reply.outcomeUnknown) setPendingId(''); throw Error(reply.error) }
      if (!matches(reply.data.job, commandId)) throw Error('请核对原调研请求')
      setJob(reply.data.job); setPendingId(''); setQuestion('')
    } catch (cause) { if (source.owns(ticket)) setError(cause instanceof Error ? cause.message : '调研失败') }
    finally { flight.current = false; if (source.owns(ticket)) setBusy(false) }
  }
  return <section className="flex flex-col gap-3" aria-label="任务调研">
    {job?.candidate && <div className="my-chat-prose"><MarkdownView content={job.candidate.body} /><Button variant="ghost" size="sm" onClick={() => {
      if (!source.canWrite() || !job.candidate) return
      const quote = job.candidate.body
      setComment(previous => [previous, quote].filter(Boolean).join('\n\n'))
      onQuote(quote)
    }}>引用到评论草稿</Button></div>}
    <textarea aria-label="任务调研问题" className={textareaClass} value={question} onChange={event => setQuestion(event.target.value)} placeholder="请梳理已知信息和待确认问题…" rows={2} />
    {error && <p role="alert" className="collab-inline-error">{error}</p>}
    {active && <p role="status">Agent 正在调研…</p>}
    {job && !active && !job.candidate && <p role="status">{job.errorCode ?? '本次调研未返回结论'}</p>}
    <div>{(pendingId || active) && error ? <Button onClick={() => setAttempt(value => value + 1)}>核对原请求</Button> :
      <Button disabled={busy || active || Boolean(pendingId) || job?.state === 'unknown'} onClick={() => void ask()}>发送给 Agent</Button>}</div>
  </section>
}
