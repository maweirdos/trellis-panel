import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { Bot, FileText, Palette, UserRound } from 'lucide-react'
import type { HifoxSnapshot, HifoxTask, HifoxTaskStage } from '@shared/hifox'
import type { TeamTaskMaterialKind } from '@shared/team-task-materials'
import { Button } from '../../my/ui'
import { useHifox } from '../store'
import { Field, textareaClass } from '../ui'
import { useTaskDraft, useTaskDraftField } from '../pages/task-detail/task-drafts'
import { initialTaskMaterial } from '../task-materials/material-presentation'
import { DesignRevisionPicker } from './DesignRevisionPicker'
import { WorkflowReviewBanner } from './WorkflowReviewBanner'
import type { TaskMaterialReviewState } from '../task-materials/TaskMaterials'
import { designHandoffText, taskDesignReference } from './design-reference'

const STAGE_WORK: Record<HifoxTaskStage, { title: string; action: string; input: string; output: string }> = {
  accepted: { title: '安排工作', action: '确定验收标准、负责同事和下一工作阶段。', input: '需求描述、验收标准', output: '明确分工与下一阶段' },
  needs_info: { title: '补充任务信息', action: '按本轮问题补充信息，再交回接续处理人。', input: '本轮补充请求', output: '补充说明与验收依据' },
  design_ready: { title: '设计工作区', action: '阅读需求与验收标准，开始人工设计并编写设计草稿。', input: '需求描述、验收标准、采用输入', output: '设计说明与固定评审版本' },
  designing: { title: '人工设计工作区', action: '完善设计方案、页面状态与风险，完成后选择评审人并提交。', input: '需求与本轮调整意见', output: '设计正文、固定版本、评审交接' },
  design_review: { title: '设计评审工作区', action: '阅读提交的固定设计版本，记录评审结论，再明确交给开发或退回。', input: '本轮提交的设计正文', output: '评审结论与开发负责人' },
  dev_ready: { title: '开发工作区', action: '核对设计与采用输入，选择本机开发环境后进入技术规划。', input: '设计定稿、验收标准、采用输入', output: '本机开发环境与技术方案' },
  planning: { title: '技术规划工作区', action: '在本机工作区编写实施计划，确认技术方案后开始实现。', input: '需求、设计与本机代码', output: '实现方案与验证范围' },
  developing: { title: '实现与交付工作区', action: '完成本轮工作并保存成果与验证记录，再明确交接测试或验收。', input: '已确认方案与验收标准', output: '实际成果、验证记录与交付说明' },
  testing: { title: '测试工作区', action: '按验收标准核对本轮交付，记录实际结果；存在问题时退回开发。', input: '本轮交付与检查范围', output: '逐项测试结果或问题复现记录' },
  acceptance: { title: '验收工作区', action: '对照验收标准检查本轮成果，确认通过或记录未满足的验收点。', input: '交付成果、测试结果与验收标准', output: '验收决定或明确的返工意见' },
  done: { title: '流程结果', action: '查看实际交付、验收结论与阶段交接记录。', input: '阶段成果与交接记录', output: '已记录的流程结果' }
}

export function WorkflowWorkbench({ snapshot, task, cancelled, canHandle, actions, onMaterialWork, onOpenInputs, shared, reviewState, actorId, writable }: {
  snapshot: HifoxSnapshot
  task: HifoxTask
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
  const work = STAGE_WORK[stage]
  const handlerId = task.workflow?.handlerId ?? task.assigneeIds[0]
  const handler = snapshot.members.find((member) => member.id === handlerId)
  const event = task.workflow?.history.slice().reverse().find((item) => item.body?.trim())
  const reference = taskDesignReference(task)
  const designing = ['design_ready', 'designing'].includes(stage)
  return <div className="workflow-workbench">
    <header className="workflow-workbench-heading"><div className="min-w-0 flex-1"><p className="text-my-xs text-my-tertiary">{task.triagePending ? '需求分拣' : '当前工作'}</p><h2 className="mt-1 break-words text-my-md font-semibold text-my-primary">{cancelled ? '任务已取消' : work.title}</h2><p className="mt-1 break-words text-my-sm text-my-secondary">{task.title}</p></div></header>
    {shared && <WorkflowReviewBanner state={reviewState} snapshot={snapshot} task={task} actorId={actorId} writable={writable} onOpen={() => onMaterialWork('prd', 'review')} onInputs={onOpenInputs} />}
    <dl className="workflow-workbench-owners"><div><dt><UserRound size={13} />负责同事</dt><dd>{handler?.name ?? (handlerId ? '原处理人已不在当前成员目录' : '待明确指定')}{handler?.title ? ` · ${handler.title}` : ''}</dd></div><div><dt><Bot size={13} />执行配置</dt><dd>{task.executor ? `${task.executor.kind === 'agent' ? 'Agent' : '小队'} · ${task.executor.name}` : '人工处理'}</dd><p>{designing ? '当前设计由人工编写；选择 Agent 仅保存分工配置。' : task.workKind === 'code' ? '实际执行与授权在本机开发会话中确认。' : '选择执行配置后仍需明确启动实际运行。'}</p></div></dl>
    {!cancelled && <><p className="text-my-sm text-my-secondary">{work.action}</p><dl className="workflow-workbench-io"><div><dt>本阶段输入</dt><dd>{work.input}</dd></div><div><dt>本阶段产出</dt><dd>{work.output}</dd></div></dl></>}
    {event?.body && <details className="workflow-handoff-record"><summary>最近交接 · {snapshot.members.find((member) => member.id === event.actorId)?.name ?? '原处理人'} → {snapshot.members.find((member) => member.id === event.assigneeId)?.name ?? '原处理人'}</summary><p className="mt-2 whitespace-pre-wrap break-words text-my-sm text-my-secondary">{designHandoffText(event.body)}</p></details>}
    {reference && <DesignRevisionPicker task={task} purpose="read" value={reference} />}
    <div className="workflow-workbench-actions">{actions}{canHandle && stage === 'designing' && <Button size="sm" variant="outline" onClick={() => onMaterialWork('design')}><Palette size={14} />继续编写设计</Button>}{shared && canHandle && stage === 'planning' && <Button size="sm" variant="outline" onClick={() => onMaterialWork('implement')}><FileText size={14} />编写实施计划</Button>}{shared && canHandle && stage === 'developing' && <Button size="sm" variant="outline" onClick={() => onMaterialWork('delivery-note')}><FileText size={14} />整理交付说明</Button>}{onOpenInputs && <Button size="sm" variant="ghost" onClick={onOpenInputs}>核对任务输入</Button>}</div>
    {!canHandle && !cancelled && stage !== 'done' && <p className="text-my-xs text-my-tertiary">{handler ? `当前由 ${handler.name} 处理，可阅读材料和交接记录。` : '请由空间管理员明确安排负责同事。'}</p>}
  </div>
}

export function ManualDesignDraft({ snapshot, task, disabled, openRequest, onSubmit }: {
  snapshot: HifoxSnapshot
  task: HifoxTask
  disabled: boolean
  openRequest: number
  onSubmit(body: string): void
}): JSX.Element {
  const context = useHifox((state) => state.workspaceContext)
  const draft = useTaskDraft(snapshot, context, { kind: 'workflow', spaceId: task.spaceId, task, creationContext: ['manual-design'] })
  const [body, setBody] = useTaskDraftField(draft, 'body', () => initialTaskMaterial('design', task.title).text)
  const editor = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (openRequest && !disabled) editor.current?.focus({ preventScroll: true }) }, [openRequest, disabled])
  return <section className="workflow-manual-design space-y-3 rounded-my-md border border-my-line p-3" aria-label="人工设计草稿"><h3 className="flex items-center gap-2 text-my-sm font-medium"><FileText size={15} />人工设计草稿</h3><p className="text-my-xs text-my-tertiary">草稿暂存在本次应用会话。提交后正文进入任务交接记录。</p><Field label="设计正文"><textarea ref={editor} className={textareaClass} rows={12} value={body} disabled={disabled} onChange={(event) => setBody(event.target.value)} /></Field><div className="flex justify-end"><Button size="sm" variant="primary" disabled={disabled || !body.trim()} onClick={() => onSubmit(body)}>选择评审人并提交</Button></div></section>
}
