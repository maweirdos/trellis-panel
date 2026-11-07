import { useRef, useState } from 'react'
import { cruxTransitionTaskInputSchema } from '@shared/crux-schema'
import { api } from '../../api'
import { useCrux } from '../store'
import { useTaskDraftField, type TaskDraft } from '../pages/task-detail/task-drafts'
import type { TeamTaskMaterialReceipt } from '@shared/team-task-materials'
import type { useRequirementIntake } from './use-requirement-intake'
import { bodyDigest, requirementOutline } from './requirements'

export function useIntakeSave(intake: ReturnType<typeof useRequirementIntake>, draft: TaskDraft, spaceId: string, actorId: string, reviewerId: string, onClose: () => void) {
  const [documentId, setDocumentId] = useTaskDraftField(draft, 'intakeDocumentId', '')
  const [materialCommand, setMaterialCommand] = useTaskDraftField(draft, 'intakeMaterialCommand', '')
  const [submissionCommand, setSubmissionCommand] = useTaskDraftField(draft, 'intakeSubmissionCommand', '')
  const [saving, setSaving] = useState(false), [step, setStep] = useState('')
  const flight = useRef(false)
  const intent = useRef(intake.adoption)
  intent.current ??= intake.adoption
  const locked = Boolean(intent.current || documentId || materialCommand || submissionCommand)
  const frozenMode = locked ? intent.current?.mode ?? 'review' : null
  const save = async (mode: 'draft' | 'review' = 'review'): Promise<void> => {
    const materials = api.cruxMaterials, content = api.teamContent
    if (!intake.source.canWrite() || flight.current) return
    const originalMode = intent.current?.mode ?? (intent.current || documentId || materialCommand || submissionCommand ? 'review' : null)
    if (originalMode && originalMode !== mode) { intake.setError('本次保存方式已固定，请继续核对原请求，不能切换草稿与评审。'); return }
    if (!intake.taskId || !intake.candidate.trim() || mode === 'review' && !reviewerId || intake.busy || intake.running || intake.commandId || intake.cancelCommand || intake.staleInputs || intake.answer.trim() || intake.job?.state !== 'succeeded' || intake.job.cancelRequested) return
    const task = useCrux.getState().snapshot?.tasks.find(task => task.id === intake.taskId && task.spaceId === spaceId)
    const context = useCrux.getState().workspaceContext
    if (!task || task.createdAt !== intake.taskCreatedAt || !context.epoch || !materials || !content) { intake.setError('原任务身份或团队材料接口当前不可用，请核对原任务。'); return }
    const outline = requirementOutline(intake.candidate, intake.original)
    if (!outline.criteria.length) { intake.setError('候选还缺少可验证的验收标准。请在讨论中补充，让AI列出“验收标准”后再采用。'); return }
    if (!cruxTransitionTaskInputSchema.shape.acceptanceCriteria.safeParse(outline.criteria).success) { intake.setError('验收标准最多100条、每条最多10000字，请精简后再采用；当前没有保存或截断内容。'); return }
    const responsibleId = mode === 'draft' ? actorId : reviewerId
    const adopted = intent.current ?? { taskId: task.id, taskCreatedAt: task.createdAt, jobId: intake.job.jobId, text: intake.candidate, title: outline.title, criteria: outline.criteria, reviewerId: responsibleId, mode }
    if (adopted.taskId !== task.id || adopted.taskCreatedAt !== task.createdAt || adopted.jobId !== intake.job.jobId || adopted.text !== intake.candidate || adopted.reviewerId !== responsibleId) { intake.setError('本次保存已绑定原正文和责任人，请继续核对原任务。'); return }
    flight.current = true; setSaving(true); intake.setError('')
    intent.current = adopted
    intake.setAdoption(adopted)
    const scope = { ...intake.scope, taskId: task.id, taskCreatedAt: task.createdAt, spaceId }
    const checkReceipt = (receipt: TeamTaskMaterialReceipt, commandId: string, action: 'create' | 'submit', id?: string): void => {
      if (receipt.commandId !== commandId || receipt.action !== action || receipt.taskId !== task.id || receipt.taskCreatedAt !== task.createdAt || receipt.spaceId !== spaceId || receipt.projectId !== context.projectId || receipt.epoch !== context.epoch || receipt.instanceId !== context.instanceId || receipt.actorId !== actorId || receipt.outcome !== 'applied' || id && receipt.documentId !== id) throw Error('材料回执与原任务或原命令不匹配，请进入原任务核对。')
    }
    try {
      const digest = await bodyDigest(adopted.text)
      if (!intake.source.canWrite()) return
      const latest = await content.job({ ...intake.scope, taskId: task.id, jobId: adopted.jobId })
      if (!intake.source.canWrite()) return
      if (!latest.ok) throw Error(latest.error)
      if (!intake.matchesJob(latest.data, task.id, task.createdAt, intake.job.commandId) || latest.data.jobId !== adopted.jobId || latest.data.state !== 'succeeded' || latest.data.cancelRequested || !latest.data.candidate) throw Error('原整理结果已取消或尚未确认，不能发布为需求。')
      let id = documentId
      if (materialCommand) {
        setStep('正在核对上次保存结果')
        const original = await materials.reconcile({ ...scope, commandId: materialCommand })
        if (!intake.source.canWrite()) return
        if (!original.ok) throw Error(original.error)
        if (original.value) { checkReceipt(original.value, materialCommand, 'create'); id = original.value.documentId; setDocumentId(id); setMaterialCommand('') }
        else {
          const retried = await materials.retry({ ...scope, commandId: materialCommand })
          if (!intake.source.canWrite()) return
          if (!retried.ok) throw Error(retried.error)
          checkReceipt(retried.value.result, materialCommand, 'create')
          id = retried.value.result.documentId; setDocumentId(id); setMaterialCommand('')
        }
      }
      if (!id) {
        setStep('正在保存完整需求说明')
        const commandId = crypto.randomUUID(), text = adopted.text
        const references = latest.data.sources.filter(source => source.kind === 'published-material').map(source => {
          const [materialId = '', version = ''] = source.sourceId.split('@')
          return { kind: 'material' as const, materialId, version: Number(version), bodyDigest: source.digest }
        })
        setMaterialCommand(commandId)
        const reply = await materials.command({ ...scope, command: { action: 'create', spaceId, taskCreatedAt: task.createdAt, commandId, expectedEpoch: context.epoch, kind: 'prd', title: adopted.title + ' · 需求说明', text, expectedDigest: digest, references, editorIds: [actorId], approverIds: [adopted.reviewerId] } })
        if (!intake.source.canWrite()) return
        if (!reply.ok) throw Error(reply.error)
        checkReceipt(reply.value.result, commandId, 'create')
        id = reply.value.result.documentId; setDocumentId(id); setMaterialCommand('')
      }
      const view = await materials.read({ ...scope, documentId: id })
      if (!intake.source.canWrite()) return
      if (!view.ok) throw Error(view.error)
      const doc = view.value.document
      if (doc.documentId !== id || doc.kind !== 'prd' || doc.taskId !== task.id || doc.taskCreatedAt !== task.createdAt || doc.spaceId !== spaceId || doc.projectId !== context.projectId || doc.ownerId !== actorId || doc.approverIds.length !== 1 || doc.approverIds[0] !== adopted.reviewerId) throw Error('共享需求的归属或评审人已变化，请进入原任务核对。')
      if (doc.draft.bodyDigest !== digest || view.value.selected.versionId !== doc.draft.versionId || await bodyDigest(view.value.text) !== digest) throw Error('共享需求正文已被修改，请进入原任务比较两份正文，未覆盖同事修改。')
      if (mode === 'draft' && (doc.latestSubmission || doc.approved || submissionCommand)) throw Error('原需求已存在评审记录，请进入原任务核对，未改变这次保存方式。')
      if (!intake.source.canWrite()) return
      setStep('正在更新任务标题与验收标准')
      // Material commands can advance the workspace revision without a task-field mutation.
      const refreshed = await intake.mutation.mutate('核对原任务修订', () => api.crux.snapshot())
      if (!refreshed || !intake.source.canWrite()) return
      const currentTask = refreshed.data.tasks.find(current => current.id === task.id && current.spaceId === spaceId && current.createdAt === task.createdAt)
      if (!currentTask || currentTask.updatedAt !== task.updatedAt) throw Error('原任务内容已更新，请核对最新任务后继续提交，未覆盖这次变化。')
      // The task description retains the original request and attachments; the PRD owns the candidate body.
      if (currentTask.title !== adopted.title || JSON.stringify(currentTask.acceptanceCriteria ?? []) !== JSON.stringify(adopted.criteria)) {
        const updated = await intake.mutation.mutate('采用需求候选', () => api.crux.updateTask({ id: task.id, patch: { title: adopted.title, acceptanceCriteria: adopted.criteria } }))
        if (!updated || !intake.source.canWrite()) return
      }
      if (mode === 'review') {
        setStep('正在提交需求评审')
        if (submissionCommand) {
          const original = await materials.reconcile({ ...scope, commandId: submissionCommand })
          if (!intake.source.canWrite()) return
          if (!original.ok) throw Error(original.error)
          let receipt = original.value
          if (!receipt) {
            const retry = await materials.retry({ ...scope, commandId: submissionCommand })
            if (!intake.source.canWrite()) return
            if (!retry.ok) throw Error(retry.error)
            receipt = retry.value.result
          }
          checkReceipt(receipt, submissionCommand, 'submit', id)
          if (receipt.versionId !== doc.draft.versionId) throw Error('原评审提交绑定了其他版本，请进入原任务核对。')
          setSubmissionCommand('')
        } else if (!doc.latestSubmission || doc.latestSubmission.versionId !== doc.draft.versionId) {
          const commandId = crypto.randomUUID()
          setSubmissionCommand(commandId)
          const submitted = await materials.command({ ...scope, command: { action: 'submit', spaceId, taskCreatedAt: task.createdAt, commandId, expectedEpoch: context.epoch, documentId: id, expectedRevision: doc.revision, expectedDraftRevision: doc.draftRevision, versionId: doc.draft.versionId, bodyDigest: doc.draft.bodyDigest } })
          if (!intake.source.canWrite()) return
          if (!submitted.ok) throw Error(submitted.error)
          checkReceipt(submitted.value.result, commandId, 'submit', id)
          if (submitted.value.result.versionId !== doc.draft.versionId) throw Error('评审回执绑定了其他版本，请进入原任务核对。')
          setSubmissionCommand('')
        } else if (doc.latestSubmission.status === 'rejected') throw Error('原需求评审已被退回，请进入原任务修改后重新提交。')
      }
      const visible = await intake.mutation.mutate(mode === 'draft' ? '刷新需求草稿' : '刷新需求评审', () => api.crux.snapshot())
      if (!visible || !intake.source.owns()) return
      draft.acknowledge()()
      onClose(); useCrux.getState().openTask(task.id)
    } catch (reason) { if (intake.source.owns()) intake.setError(reason instanceof Error ? reason.message : '需求保存未完成，原任务与候选已保留。') }
    finally { flight.current = false; if (intake.source.owns()) { setSaving(false); setStep('') } }
  }
  return { saving, step, save, documentId, locked, mode: frozenMode }
}
