import type { JSX } from 'react'
import { CheckCircle2, FileText, Loader2, RotateCcw } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import { Button } from '../../my/ui'
import type { TaskMaterialReviewState } from '../task-materials/TaskMaterials'

export function WorkflowReviewBanner({ state, snapshot, task, actorId, writable, onOpen, onInputs }: {
  state: TaskMaterialReviewState
  snapshot: CruxSnapshot
  task: CruxTask
  actorId: string | null
  writable: boolean
  onOpen(): void
  onInputs?(): void
}): JSX.Element {
  const document = state.document
  const review = document?.latestSubmission ?? document?.approved
  const version = state.versionNumber === undefined ? 'PRD · 固定版本' : `PRD v${state.versionNumber}`
  const space = snapshot.spaces.find((item) => item.id === task.spaceId)
  const approvers = document?.approverIds.flatMap((id) => {
    const member = snapshot.members.find((person) => person.id === id)
    return member && space?.memberIds.includes(id) ? [member.name] : []
  }) ?? []
  const decider = snapshot.members.find((person) => person.id === review?.decidedBy)?.name ?? '原评审人'
  const canReview = Boolean(writable && actorId && space?.memberIds.includes(actorId) && document?.approverIds.includes(actorId) && review?.status === 'pending')
  if (state.state === 'unavailable') return <section className="workflow-review-banner space-y-2 rounded-my-md border border-my-line p-3" aria-label="需求评审状态"><p role="status" className="text-my-sm font-medium">需求评审状态尚未核对</p><p className="break-words text-my-xs text-my-secondary">{state.error}</p><Button size="sm" variant="outline" onClick={onOpen}>重新核对评审材料</Button></section>
  if (state.state === 'loading') return <section className="workflow-review-banner flex items-center gap-2 rounded-my-md border border-my-line p-3" aria-label="需求评审状态"><Loader2 size={15} className="animate-spin text-my-icon-secondary" /><p role="status" className="text-my-sm text-my-secondary">正在读取 PRD 与同事评审状态…</p></section>
  if (!document) return <section className="workflow-review-banner space-y-2 rounded-my-md border border-my-line p-3" aria-label="需求评审状态"><p role="status" className="text-my-xs text-my-secondary">{state.incomplete ? '材料目录尚未完整载入，PRD 状态待核对。' : '尚无共享 PRD 材料。'}</p><Button size="sm" variant="outline" onClick={onOpen}>查看需求材料</Button></section>
  const pending = review?.status === 'pending'
  const approved = review?.status === 'approved'
  const rejected = review?.status === 'rejected'
  return <section className="workflow-review-banner space-y-3 rounded-my-md border border-my-line bg-my-layer-2 p-3" aria-label="需求评审状态">
    <div className="flex items-start gap-2">{approved ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-my-success-text" /> : rejected ? <RotateCcw size={17} className="mt-0.5 shrink-0 text-my-warning-text" /> : <FileText size={17} className="mt-0.5 shrink-0 text-my-icon-secondary" />}<div className="min-w-0 flex-1"><p role="status" className="break-words text-my-sm font-semibold text-my-primary">{pending ? `${version} · ${approvers.length ? `待 ${approvers.join('、')} 评审` : '评审人需重新指定'}` : approved ? `${version} · 已由 ${decider} 批准` : rejected ? `${version} · 已由 ${decider} 退回` : `${version} · 草稿，尚未提交同事评审`}</p>{state.refreshing && <p className="mt-1 text-my-xs text-my-tertiary">正在核对最新评审状态…</p>}{rejected && review?.reason && <p className="mt-2 whitespace-pre-wrap break-words text-my-sm text-my-secondary">{review.reason}</p>}</div></div>
    <div className="flex flex-wrap gap-2"><Button size="sm" variant={pending ? 'primary' : 'outline'} onClick={onOpen}>{canReview ? '去评审' : pending || approved || rejected ? '查看评审稿' : '查看需求草稿'}</Button>{approved && onInputs && <Button size="sm" variant="outline" onClick={onInputs}>查看固定输入</Button>}</div>
  </section>
}
