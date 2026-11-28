import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronRight, FileText, Palette } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { TeamTaskMaterialKind } from '@shared/team-task-materials'
import { Button, DisclosureGrid } from '../../my/ui'
import { useCrux } from '../store'
import { Field, textareaClass } from '../ui'
import { useTaskDraft, useTaskDraftField } from '../pages/task-detail/task-drafts'
import { initialTaskMaterial } from '../task-materials/material-presentation'
import { DesignRevisionPicker } from './DesignRevisionPicker'
import { WorkflowReviewBanner } from './WorkflowReviewBanner'
import type { TaskMaterialReviewState } from '../task-materials/TaskMaterials'
import { designHandoffText, taskDesignReference } from './design-reference'

export function WorkflowWorkbench({ snapshot, task, cancelled, canHandle, actions, onMaterialWork, onOpenInputs, shared, reviewState, actorId, writable }: {
  snapshot: CruxSnapshot
  task: CruxTask
  cancelled: boolean
  canHandle: boolean
  actions: ReactNode
  onMaterialWork(kind: TeamTaskMaterialKind, mode?: 'work' | 'review'): void
  onOpenInputs?(): void
  shared: boolean
  reviewState: TaskMaterialReviewState
  actorId: string | null
  writable: boolean
}): JSX.Element {
  const stage = task.triagePending ? 'accepted' : task.workflow?.stage ?? 'accepted'
  const handlerId = task.workflow?.handlerId ?? task.assigneeIds[0]
  const handler = snapshot.members.find((member) => member.id === handlerId)
  const event = task.workflow?.history.slice().reverse().find((item) => item.body?.trim())
  const reference = taskDesignReference(task)
  const defaultHandoffOpen = event?.action === 'request_info' || event?.action === 'return_development' || event?.action === 'return_delivery'
  const [handoffOpen, setHandoffOpen] = useState(defaultHandoffOpen)
  const handoffKey = `${task.id}:${event?.action ?? ''}:${event?.body ?? ''}`
  useEffect(() => {
    setHandoffOpen(defaultHandoffOpen)
  }, [handoffKey, defaultHandoffOpen])
  return <div className="workflow-workbench">
    {shared && <WorkflowReviewBanner state={reviewState} snapshot={snapshot} task={task} actorId={actorId} writable={writable} showEmpty={false} onOpen={() => onMaterialWork('prd', 'review')} onInputs={onOpenInputs} />}
    <div className="workflow-workbench-actions">{actions}
      {canHandle && stage === 'designing' && <Button size="sm" variant="outline" onClick={() => onMaterialWork('design')}><Palette size={14} />继续编写设计</Button>}
    </div>
    {event?.body && <div className="workflow-handoff-record">
      <button type="button" className="flex w-full cursor-pointer items-center gap-1.5 text-left text-my-xs font-medium text-my-primary transition-colors hover:text-my-primary" aria-expanded={handoffOpen} onClick={() => setHandoffOpen((v) => !v)}>
        <ChevronRight size={12} className="my-disclosure-chevron shrink-0 text-my-tertiary" data-open={handoffOpen || undefined} />
        <span>最近交接 · {snapshot.members.find((member) => member.id === event.actorId)?.name ?? '原处理人'} → {snapshot.members.find((member) => member.id === event.assigneeId)?.name ?? '原处理人'}</span>
      </button>
      <DisclosureGrid open={handoffOpen}>
        <p className="mt-2 whitespace-pre-wrap break-words text-my-sm text-my-secondary">{designHandoffText(event.body)}</p>
      </DisclosureGrid>
    </div>}
    {reference && <DesignRevisionPicker task={task} purpose="read" value={reference} />}
    {!canHandle && !cancelled && stage !== 'done' && <p className="text-my-xs text-my-tertiary">{handler ? `当前由 ${handler.name} 处理，可阅读材料和交接记录。` : '请由空间管理员明确安排负责同事。'}</p>}
  </div>
}

export function ManualDesignDraft({ snapshot, task, disabled, openRequest, onSubmit }: {
  snapshot: CruxSnapshot
  task: CruxTask
  disabled: boolean
  openRequest: number
  onSubmit(body: string): void
}): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const draft = useTaskDraft(snapshot, context, { kind: 'workflow', spaceId: task.spaceId, task, creationContext: ['manual-design'] })
  const [body, setBody] = useTaskDraftField(draft, 'body', () => initialTaskMaterial('design', task.title).text)
  const editor = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (openRequest && !disabled) editor.current?.focus({ preventScroll: true }) }, [openRequest, disabled])
  return <section className="workflow-manual-design space-y-3 rounded-my-base border border-my-line p-3" aria-label="人工设计草稿"><h3 className="flex items-center gap-2 text-my-sm font-medium"><FileText size={15} />人工设计草稿</h3><p className="text-my-xs text-my-tertiary">草稿暂存在本次应用会话。提交后正文进入任务交接记录。</p><Field label="设计正文"><textarea ref={editor} className={textareaClass} rows={12} value={body} disabled={disabled} onChange={(event) => setBody(event.target.value)} /></Field><div className="flex justify-end"><Button size="sm" variant="primary" disabled={disabled || !body.trim()} onClick={() => onSubmit(body)}>选择评审人并提交</Button></div></section>
}
