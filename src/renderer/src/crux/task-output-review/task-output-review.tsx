import { useState, type JSX } from 'react'
import { Check, ClipboardCheck, Send } from 'lucide-react'
import type { CruxTask, CruxTaskOutputReviewOutput, CruxTaskOutputReviewPatch, CruxTaskOutputReviewRecord } from '@shared/crux'
import { canRestoreLightweightTask } from '@shared/crux-domain/lightweight'
import { Button } from '../../my/ui'
import { api } from '../../api'
import { useCrux } from '../store'
import { textareaClass } from '../ui'
import { type TaskSourceOwner, useTaskMutation } from '../pages/task-detail/use-task-source'
import './task-output-review.css'

export function currentOutputReview(task: CruxTask) {
  const history = task.outputReview?.history ?? []
  const submission = [...history].reverse().find((entry): entry is Extract<CruxTaskOutputReviewRecord, { kind: 'submission' }> => entry.kind === 'submission')
  const last = history.at(-1)
  const status = !submission ? 'none' : last?.kind === 'confirmation' && last.submissionId === submission.submissionId ? 'confirmed' : submission.feedback.length ? 'changes_requested' : 'awaiting_review'
  return { submission, status, revision: submission ? history.indexOf(submission) : 0 } as const
}

export function submitOutputPatch(task: CruxTask, output: CruxTaskOutputReviewOutput): CruxTaskOutputReviewPatch | null {
  const { submission, status, revision } = currentOutputReview(task)
  if (status === 'awaiting_review' || submission?.creationId === output.creationId && submission.revisionId === output.revisionId) return null
  const { creationId, revisionId, bodyDigest, revisionNumber, title } = output
  return { action: 'submit', expectedRevision: revision, expectedStatus: status, output: { creationId, revisionId, bodyDigest, revisionNumber, title } }
}

export function TaskOutputReviewBoardBadge({ task }: { task: CruxTask }): JSX.Element | null {
  const { status } = currentOutputReview(task)
  if (status === 'none') return null
  return <span className="task-output-review-board" data-state={status}><ClipboardCheck size={12} aria-hidden="true" />
    {status === 'confirmed' ? '成果已确认' : status === 'changes_requested' ? '成果待修改' : '成果待审阅'}
  </span>
}

export function TaskOutputReviewInlineActions({ task, actorId, output, source }: { task: CruxTask; actorId?: string; output: CruxTaskOutputReviewOutput; source: TaskSourceOwner }): JSX.Element | null {
  const context = useCrux(state => state.workspaceContext)
  const category = useCrux(state => state.snapshot?.taskStatuses.find(item => item.id === task.statusId)?.category)
  const { mutate, pending, error } = useTaskMutation(source)
  const [editing, setEditing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const { submission, status } = currentOutputReview(task)
  const active = submission?.creationId === output.creationId && submission.revisionId === output.revisionId ? submission : undefined
  const submit = submitOutputPatch(task, output)
  const writable = context.state === 'connected' && context.actorId === actorId && Boolean(actorId) && (!task.workflow || canRestoreLightweightTask(task)) && category !== 'done' && category !== 'cancelled'
  const save = (label: string, patch: CruxTaskOutputReviewPatch) => mutate(label, () => api.crux.updateTask({ id: task.id, patch: { outputReview: patch } }))
  if (!active && (!submit || !writable)) return null
  const expected = active && { expectedSubmissionId: active.submissionId, expectedFeedbackCount: active.feedback.length }
  return <>
    {active && <TaskOutputReviewBoardBadge task={task} />}
    {writable && !active && submit && <Button size="sm" variant="ghost" disabled={pending} onClick={() => void save('提交审阅', submit)}><Send size={13} />提交审阅</Button>}
    {writable && expected && status === 'awaiting_review' && <>
      <Button size="sm" variant="ghost" disabled={pending} aria-expanded={editing} onClick={() => setEditing(!editing)}>要求修改</Button>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void save('确认审阅', { action: 'confirm', ...expected })}><Check size={13} />确认审阅</Button>
      {editing && <form className="w-full space-y-2" onSubmit={async event => {
        event.preventDefault()
        if (feedback.trim() && await save('要求修改', { action: 'requestChanges', feedback: feedback.trim(), ...expected })) { setFeedback(''); setEditing(false) }
      }}><textarea className={textareaClass} autoFocus aria-label="修改意见" placeholder="哪里需要改？" maxLength={10000} value={feedback} onChange={event => setFeedback(event.target.value)} /><Button type="submit" size="sm" disabled={pending || !feedback.trim()}>发送修改意见</Button></form>}
    </>}
    {active?.feedback.map(item => <p className="w-full whitespace-pre-wrap break-words text-my-sm text-my-secondary" key={item.id}>{item.body}</p>)}
    {error && <p className="collab-inline-error w-full" role="alert">{error}</p>}
  </>
}
