import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { Bot, ChevronRight, Loader2, PenLine, Sparkles, X } from 'lucide-react'
import type { CruxID, CruxPriority, CruxSnapshot, CruxTaskInput, CruxTaskWorkKind } from '@shared/crux'
import { cruxTaskWorkKindSchema } from '@shared/crux-schema'
import type { TaskSourceFile } from '@shared/task-source-files'
import { taskInputCanonical } from '@shared/team-canonical'
import { api, hasIpc } from '../../api'
import { MOTION_EXIT_MS, usePresence } from '../../my/motion'
import { Button, Checkbox, DisclosureGrid, Modal, Segmented, Tooltip } from '../../my/ui'
import { useApp } from '../../store'
import { InteractionScope } from '../../utils/interaction-scope'
import { observeCollaborationWorkspace, PRIORITY_LABEL, useCrux, visibleLabels } from '../store'
import { useCollaborationPlatform, workflowKey } from '../collaboration-platform-store'
import { useLocalExecutionSlot } from '../local-execution-slot'
import { useTaskRuns } from '../task-run-store'
import { Field, inputClass, textareaClass, Select } from '../ui'
import { capturePostFiles, sendPostFiles, PostFilePicker } from './task-detail/TaskPostFiles'
import { TaskAllocationPicker, type TaskAllocation } from './task-detail/TaskAllocationPicker'
import { canReadTaskSpace, taskActorId, taskSourceKey, useTaskMutation, useTaskSource, useTaskSurfaceGeneration } from './task-detail/use-task-source'
import { useTaskDraft, useTaskDraftField } from './task-detail/task-drafts'
import { ConnectionPanel } from '../ConnectionPanel'
import { RequirementIntake } from '../intake/RequirementIntake'
import { bodyDigest, discussionInput } from '../intake/requirements'
import { clearTaskHandoffFields, clearTaskHandoffRecovery, readTaskHandoffIntent, readTaskHandoffRecovery, rememberTaskHandoffSource, saveTaskHandoffIntent, saveTaskHandoffRecovery, type TaskHandoffFields, type TaskHandoffIntent, type TaskHandoffRecovery, type TaskHandoffSource } from './task-detail/task-handoff-source'
import type { IntakeFile } from '../intake/use-requirement-intake'

export interface NewTaskModalProps {
  open: boolean
  onClose: () => void
  spaceId?: CruxID
  projectId?: CruxID
  iterationId?: CruxID
  parentTaskId?: CruxID
  triagePending?: boolean
  handoff?: TaskHandoffSource
  onCreated?: (receipt: { taskId: string; spaceId: string; triagePending: boolean; materialDocumentId?: string; materialVersionId?: string; files?: TaskSourceFile[] }) => void
}

const WORK_KIND_LABELS: Record<CruxTaskWorkKind, string> = { code: '研发工作', general: '日常工作' }
type TaskCreationIntent = 'triage' | 'schedule'
type UnsentHandoffFields = TaskHandoffFields

export function NewTaskModal(props: NewTaskModalProps): JSX.Element | null {
  const presence = usePresence(props.open, MOTION_EXIT_MS + 16)
  const lastOpenPropsRef = useRef(props)
  if (props.open) lastOpenPropsRef.current = props
  const activeProps = props.open ? props : { ...lastOpenPropsRef.current, open: false }
  const snapshot = useCrux((state) => state.snapshot)
  const currentSpaceId = useCrux((state) => state.currentSpaceId)
  const context = useCrux((state) => state.workspaceContext)
  const loadError = useCrux((state) => state.loadError)
  const busy = useCrux((state) => state.busy)
  const [checking, setChecking] = useState(Boolean(props.open && props.handoff))
  const [checkedHandoff, setCheckedHandoff] = useState<string | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const checkRequest = useRef(0)
  const refresh = async (): Promise<void> => {
    const ticket = ++checkRequest.current
    setChecking(true)
    try { await useCrux.getState().bootstrap() }
    finally {
      if (ticket === checkRequest.current) {
        setCheckedHandoff(props.handoff?.id ?? null)
        setChecking(false)
      }
    }
  }
  useEffect(() => {
    if (!props.open || !props.handoff) return
    void refresh()
    const release = observeCollaborationWorkspace()
    return () => { checkRequest.current++; release() }
  }, [props.open, props.handoff?.id])
  const liveGeneration = useTaskSurfaceGeneration(true)
  const lastOpenGenerationRef = useRef(liveGeneration)
  if (props.open) lastOpenGenerationRef.current = liveGeneration
  const generation = props.open ? liveGeneration : lastOpenGenerationRef.current
  const [, reloadRecovery] = useState(0)
  const [recoveryError, setRecoveryError] = useState('')
  const authority = snapshot ? taskSourceKey(snapshot, context) : ''
  const actorId = context.actorId ?? ''
  let recovery: TaskHandoffRecovery | null = null
  let retained: TaskHandoffIntent | null = null
  let readError = ''
  try {
    if (activeProps.handoff) {
      recovery = readTaskHandoffRecovery(activeProps.handoff)
      retained = recovery?.intent ?? readTaskHandoffIntent(context, recovery?.source.id ?? activeProps.handoff.id)
    }
  } catch (cause) { readError = cause instanceof Error ? cause.message : String(cause) }
  const handoff = recovery?.source ?? activeProps.handoff
  const spaces = snapshot?.spaces.filter(space => !space.archived && context.actorId && space.memberIds.includes(context.actorId)) ?? []
  const handoffAvailable = ['local', 'connected'].includes(context.state) && (!recovery || recovery.authority === authority && recovery.authorityIdentity === actorId)
  const existingTask = handoff && snapshot?.tasks.find(task => task.handoff?.id === handoff.id && task.creatorId === context.actorId)
  const handoffSpace = recovery?.spaceId ?? existingTask?.spaceId ?? retained?.input.spaceId ?? (spaces.find(space => space.id === currentSpaceId)?.id || spaces[0]?.id)
  const spaceId = activeProps.handoff ? handoffSpace : activeProps.spaceId ?? currentSpaceId
  const initialCheck = Boolean(activeProps.handoff && checkedHandoff !== activeProps.handoff.id)
  const waiting = checking || initialCheck || (busy && !snapshot)
  // Persist before admitting an editable form. A failed write leaves the source intact.
  useEffect(() => {
    if (props.open && handoff && !waiting && !loadError && !readError && !recoveryError && handoffAvailable && spaceId && spaces.some(space => space.id === spaceId) && !recovery) {
      try {
        saveTaskHandoffRecovery(handoff, authority, actorId, spaceId)
        if (retained) saveTaskHandoffIntent(context, handoff.id, retained, handoff)
        reloadRecovery(value => value + 1)
      } catch (cause) { setRecoveryError(cause instanceof Error ? cause.message : String(cause)) }
    }
  }, [props.open, props.handoff?.id, waiting, loadError, readError, recoveryError, handoffAvailable, spaceId, authority])
  if (!presence.mounted) return null
  if (activeProps.handoff && (waiting || loadError || readError || recoveryError || !recovery || !handoffAvailable || !spaceId || !spaces.some(space => space.id === spaceId) || connectionOpen)) {
    const message = waiting ? busy ? '正在连接团队工作区…' : '正在核对团队空间…'
      : readError || recoveryError ? readError || recoveryError
      : context.state === 'offline' ? '团队工作区离线，重新连接后继续原交接。'
      : context.state === 'access-revoked' ? '登录或访问权限已失效，请重新登录核对原工作区。'
      : context.state === 'local' ? '尚未连接团队工作区。'
      : recovery && (recovery.authority !== authority || recovery.authorityIdentity !== actorId) ? '当前账号或工作区与原交接不同，请恢复原连接。'
      : loadError ? '未能核对团队空间，请重试。'
      : !snapshot || !context.actorId ? '团队成员身份尚未核对，请重新连接。'
      : !snapshot.spaces.some(space => !space.archived) ? '当前团队暂无可用空间。'
      : !spaces.length ? '当前身份未加入可用空间，请联系管理员加入空间。'
      : '原目标空间已停用或当前身份已无创建权限，请联系空间管理员。'
    const content = <div className="flex flex-col gap-4 bg-my-canvas p-5">
          <h2 className="my-item-title">创建团队任务</h2>
          <p role={waiting ? 'status' : 'alert'} className="my-item-description">{message}</p>
          {!waiting && (context.error || loadError) && <details className="my-item-description"><summary className="cursor-pointer">查看连接详情</summary><p className="mt-2 whitespace-pre-wrap break-words">{context.error || loadError}</p></details>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={activeProps.onClose}>关闭</Button>
            {!waiting && <Button size="sm" variant="outline" disabled={!hasIpc} onClick={() => { setRecoveryError(''); void refresh() }}>重新核对</Button>}
            {!waiting && <Button size="sm" variant="primary" disabled={!hasIpc} onClick={() => setConnectionOpen(true)}>{context.state === 'access-revoked' ? '重新登录' : '账号与工作区'}</Button>}
          </div>
        </div>
    return <>
      {activeProps.handoff.draftId && activeProps.triagePending ? (props.open && !connectionOpen && content) : <Modal open={props.open && !connectionOpen} onClose={activeProps.onClose} ariaLabel="创建团队任务">{content}</Modal>}
      <ConnectionPanel open={connectionOpen} hideTrigger onOpenChange={open => { setConnectionOpen(open); if (!open) void refresh() }} />
    </>
  }
  if (!snapshot || !spaceId || !canReadTaskSpace(snapshot, context, spaceId)) return <Modal open={props.open} onClose={activeProps.onClose} ariaLabel="无法创建任务"><div className="flex flex-col gap-3 p-5"><h2 className="text-my-md font-semibold text-my-primary">当前空间不可用</h2><p role="alert" className="text-my-sm text-my-secondary">请重新选择有访问权限的空间。</p><div className="flex justify-end"><Button onClick={activeProps.onClose}>关闭</Button></div></div></Modal>
  const key = JSON.stringify([authority, spaceId, activeProps.projectId, activeProps.iterationId, activeProps.parentTaskId, activeProps.triagePending, generation, handoff?.id])
  return <InteractionScope key={key} active={props.open}><TaskCreateForm {...activeProps} open={props.open} handoff={handoff} retained={retained} unsent={recovery?.fields[spaceId]} onUnsentChange={fields => {
    if (!handoff) return
    const latest = useCrux.getState()
    if (!latest.snapshot || !['local', 'connected'].includes(latest.workspaceContext.state) || taskSourceKey(latest.snapshot, latest.workspaceContext) !== authority || !canReadTaskSpace(latest.snapshot, latest.workspaceContext, spaceId)) throw Error('原交接当前不可保存，请恢复原账号和空间权限。')
    if (fields) saveTaskHandoffRecovery(handoff, authority, actorId, spaceId, fields)
    else clearTaskHandoffFields(latest.workspaceContext, handoff, authority, actorId)
  }} snapshot={snapshot} spaceId={spaceId} handoffSpaces={spaces} onSelectSpace={id => {
    if (!handoff || !spaces.some(space => space.id === id)) return
    try { saveTaskHandoffRecovery(handoff, authority, actorId, id); reloadRecovery(value => value + 1) }
    catch (cause) { setRecoveryError(cause instanceof Error ? cause.message : String(cause)) }
  }} /></InteractionScope>
}

function TaskCreateForm({ open, unsent: cachedUnsent, retained, onUnsentChange, snapshot, spaceId, onClose, parentTaskId: initialParent, projectId: initialProject, iterationId: initialIteration, triagePending: explicitTriage, handoff, handoffSpaces, onSelectSpace, onCreated }: NewTaskModalProps & { retained: TaskHandoffIntent | null; unsent?: UnsentHandoffFields; onUnsentChange: (fields: UnsentHandoffFields | null) => void; snapshot: CruxSnapshot; spaceId: string; handoffSpaces: CruxSnapshot['spaces']; onSelectSpace: (id: string) => void }): JSX.Element | null {
  const context = useCrux((state) => state.workspaceContext)
  const busy = useCrux((state) => state.busy)
  const source = useTaskSource({ spaceId, taskId: initialParent, creating: true })
  const { mutate, error, pending } = useTaskMutation(source)
  const types = snapshot.taskTypes.filter((type) => type.spaceId === spaceId)
  const draft = useTaskDraft(snapshot, context, { kind: 'create', spaceId, task: snapshot.tasks.find((task) => task.id === initialParent), creationContext: [initialParent, initialProject, initialIteration, explicitTriage, handoff?.id] })
  const unsent = retained ? undefined : cachedUnsent
  const selectedMaterial = retained?.material ?? handoff?.material
  const [title, setTitle] = useTaskDraftField(draft, 'title', unsent?.title ?? (retained?.input.title ?? handoff?.title ?? ''))
  const [description, setDescription] = useTaskDraftField(draft, 'description', unsent?.description ?? (retained ? retained.input.description ?? '' : handoff?.description ?? ''))
  const [selectedFileIds, setSelectedFileIds] = useTaskDraftField<string[]>(draft, 'selectedFileIds', () => unsent?.selectedFileIds ?? handoff?.fileChoices?.filter(file => retained ? retained.input.handoff?.files?.some(ref => ref.revision === file.revision) : file.selected).map(file => file.fileId) ?? [])
  const [shareMaterial, setShareMaterial] = useTaskDraftField(draft, 'shareMaterial', unsent?.shareMaterial ?? (retained ? Boolean(retained.material) : handoff?.attachByDefault ?? false))
  const [submitted, setSubmitted] = useTaskDraftField<CruxTaskInput | null>(draft, 'handoffSubmitted', retained?.input ?? null)
  const submittedRef = useRef(submitted)
  const [handoffError, setHandoffError] = useState('')
  const [savingMaterial, setSavingMaterial] = useState(false)
  const flight = useRef(false)
  const [criteria, setCriteria] = useTaskDraftField(draft, 'criteria', unsent?.criteria ?? (retained?.input.acceptanceCriteria?.join('\n') ?? ''))
  const [workKind, setWorkKind] = useTaskDraftField<CruxTaskWorkKind>(draft, 'workKind', unsent?.workKind ?? (retained?.input.workKind ?? 'code'))
  const [staged, setStaged] = useTaskDraftField(draft, 'staged', unsent?.staged ?? Boolean(retained?.input.workKind))
  const [typeId, setTypeId] = useTaskDraftField(draft, 'typeId', unsent?.typeId ?? (retained ? retained.input.typeId ?? '' : types.find((type) => type.isDefault)?.id ?? types[0]?.id ?? ''))
  const [priority, setPriority] = useTaskDraftField<CruxPriority>(draft, 'priority', unsent?.priority ?? (retained?.input.priority ?? 'none'))
  const [allocation, setAllocation] = useTaskDraftField<TaskAllocation>(draft, 'allocation', unsent?.allocation ?? ({ assigneeIds: retained?.input.assigneeIds ?? [], executor: retained?.input.executor ?? null }))
  const [labelIds, setLabelIds] = useTaskDraftField<string[]>(draft, 'labelIds', unsent?.labelIds ?? (retained?.input.labelIds ?? []))
  const [projectId, setProjectId] = useTaskDraftField(draft, 'projectId', unsent?.projectId ?? (retained ? retained.input.projectId ?? '' : initialProject ?? ''))
  const [iterationId, setIterationId] = useTaskDraftField(draft, 'iterationId', unsent?.iterationId ?? (retained ? retained.input.iterationIds?.[0] ?? '' : explicitTriage === true ? '' : initialIteration ?? ''))
  const [parentTaskId, setParentTaskId] = useTaskDraftField(draft, 'parentTaskId', unsent?.parentTaskId ?? (retained ? retained.input.parentTaskId ?? '' : initialParent ?? ''))
  const [creationMode, setCreationMode] = useTaskDraftField<'ai' | 'manual'>(draft, 'creationMode', 'manual')
  const [creationIntent, setCreationIntent] = useTaskDraftField<TaskCreationIntent>(draft, 'creationIntent', unsent?.creationIntent ?? ((retained ? retained.input.triagePending : explicitTriage) ? 'triage' : 'schedule'))
  const [autoEnqueueRun, setAutoEnqueueRun] = useState(true)
  const typeWorkflows = useCollaborationPlatform((state) => state.typeWorkflows)
  const [intakeOriginal] = useTaskDraftField(draft, 'intakeOriginal', '')
  const [intakeFiles] = useTaskDraftField<IntakeFile[]>(draft, 'intakeFiles', [])
  const [draftError, setDraftError] = useState('')
  const [discarding, setDiscarding] = useState(false)
  const [reconciliationRequired, setReconciliationRequired] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [titleInvalid, setTitleInvalid] = useState(false)
  const [titleShaking, setTitleShaking] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleErrorId = useId()
  useEffect(() => {
    if (!titleShaking) return
    const timer = window.setTimeout(() => setTitleShaking(false), 280)
    return () => window.clearTimeout(timer)
  }, [titleShaking])
  useLayoutEffect(() => {
    if (!open || !handoff || !source.available || !source.owns() || submitted || retained || reconciliationRequired || flight.current) return
    try {
      onUnsentChange({ title, description, selectedFileIds, shareMaterial, criteria, workKind, staged, typeId, priority, allocation, labelIds, projectId, iterationId, parentTaskId, creationIntent })
      setDraftError('')
    } catch (cause) { setDraftError(cause instanceof Error ? cause.message : String(cause)) }
  }, [open, handoff?.id, source.available, submitted, retained, reconciliationRequired, title, description, selectedFileIds, shareMaterial, criteria, workKind, staged, typeId, priority, allocation, labelIds, projectId, iterationId, parentTaskId, creationIntent, onUnsentChange])
  const space = snapshot.spaces.find((candidate) => candidate.id === spaceId)
  if (!space || (open && !source.available)) return null
  const actorId = taskActorId(snapshot, context)
  const canAct = Boolean(actorId && space.memberIds.includes(actorId))
  const disabled = !open || busy || pending || !hasIpc || Boolean(space.archived) || !canAct
  const triagePending = explicitTriage ?? creationIntent === 'triage'
  const labels = visibleLabels(snapshot, spaceId)
  const iterations = snapshot.iterations.filter((iteration) => iteration.spaceId === spaceId && iteration.status !== 'completed')
  const needsFallback = Boolean(allocation.executor && !allocation.assigneeIds.some((id) => space.memberIds.includes(id)))
  const heading = handoff ? '创建团队任务' : initialParent ? '新建子任务' : '新建任务'
  const originalTask = handoff && snapshot.tasks.find(task => task.creatorId === actorId && task.handoff?.id === handoff.id && task.spaceId === spaceId)
  const locked = Boolean(submitted || retained || originalTask || reconciliationRequired)
  const requiresAssignee = Boolean(handoff && !triagePending && !allocation.assigneeIds.length)
  const canChooseIntent = !initialParent && explicitTriage === undefined
  const submitBlockedReason =
    space.archived ? '空间已停用，恢复后才能创建任务'
    : !canAct ? '当前身份不是该空间成员，无法创建任务'
    : !hasIpc ? '当前环境不支持创建任务'
    : reconciliationRequired ? '原交接状态待确认，请核对创建结果'
    : !locked && !title.trim() ? '请先输入任务标题'
    : !locked && needsFallback ? '请为 Agent 或小队选择一名兜底处理人'
    : !locked && requiresAssignee ? '请先选择负责人'
    : null
  const nudgeTitle = (): void => {
    setTitleInvalid(true)
    setTitleShaking(false)
    requestAnimationFrame(() => setTitleShaking(true))
    titleInputRef.current?.focus({ preventScroll: true })
  }
  const chooseIntent = (intent: TaskCreationIntent): void => {
    if (!canChooseIntent || source.owns() === false) return
    setCreationIntent(intent)
    if (intent === 'triage') setIterationId('')
  }
  const close = (): void => { if (open && source.owns()) onClose() }
  const discard = async (): Promise<void> => {
    if (!open || flight.current || busy || pending || locked || !source.owns()) return
    const ticket = source.ticket()
    flight.current = true
    setDiscarding(true)
    try {
      if (handoff) {
        const result = await api.crux.workspacePending()
        if (!source.owns(ticket)) return
        if (!result.ok) throw Error(result.error)
        if (readTaskHandoffRecovery(handoff)?.intent || readTaskHandoffIntent(context, handoff.id) ||
            result.data.some(command => command.operation === 'createTask' && command.taskHandoff?.id === handoff.id) ||
            useCrux.getState().snapshot?.tasks.some(task => task.handoff?.id === handoff.id && task.creatorId === actorId)) {
          setReconciliationRequired(true)
          throw Error('原交接已提交或结果待确认，请重新打开核对创建结果。')
        }
        onUnsentChange(null)
      }
      const capturedDraft = !handoff ? draft.snapshot() : null
      const capturedTitle = title.trim()
      draft.discard()
      onClose()
      if (capturedDraft && capturedDraft.size > 0) {
        useApp.getState().pushToast({
          kind: 'info',
          title: '已放弃任务草稿',
          body: capturedTitle ? `「${capturedTitle}」` : '点击撤销可恢复刚才填写的内容',
          durationMs: 6000,
          action: {
            label: '撤销',
            onClick: () => {
              if (!draft.restore(capturedDraft)) {
                useApp.getState().pushToast({ kind: 'warn', title: '无法恢复草稿', body: '当前账号或空间已变化。' })
                return
              }
              if (!initialParent && !initialProject) {
                useCrux.getState().beginCreateTask({
                  spaceId,
                  ...(initialIteration ? { iterationId: initialIteration } : {}),
                  ...(explicitTriage !== undefined ? { triagePending: explicitTriage } : {})
                })
              } else {
                useApp.getState().pushToast({ kind: 'success', title: '已恢复任务草稿', body: '重新打开新建弹窗即可继续编辑' })
              }
            }
          }
        })
      }
    } catch (cause) {
      if (source.owns(ticket)) setDraftError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      flight.current = false
      if (source.owns(ticket)) setDiscarding(false)
    }
  }
  const submit = async (): Promise<void> => {
    if (flight.current || disabled || reconciliationRequired || !actorId) return
    if (!locked && !title.trim()) {
      nudgeTitle()
      return
    }
    if (!locked && (needsFallback || requiresAssignee)) return
    const typeWf = typeId ? typeWorkflows[workflowKey(spaceId, typeId)] : undefined
    const input: CruxTaskInput = submittedRef.current ?? {
      spaceId, creatorId: actorId, title: title.trim(), description: handoff?.draftId ? handoff.description : description.trim() || undefined,
      ...(staged ? { workKind, acceptanceCriteria: criteria.split(/\r?\n/).map((criterion) => criterion.trim()).filter(Boolean) } : {}),
      typeId: typeId || undefined, statusId: typeWf?.defaultStatusId || undefined, priority, assigneeIds: allocation.assigneeIds, executor: allocation.executor,
      labelIds, projectId: projectId || undefined, iterationIds: triagePending ? [] : iterationId ? [iterationId] : [],
      parentTaskId: parentTaskId || undefined, triagePending,
      ...(handoff ? { handoff: { id: handoff.id, versionLabel: handoff.material?.versionLabel }, ...(handoff.conversationId ? { bindConversation: { id: handoff.conversationId, title: handoff.title } } : {}) } : {})
    }
    if (handoff) {
      const ticket = source.ticket()
      const material = (originalTask ? originalTask.handoff?.versionLabel : input.handoff?.versionLabel) ? retained?.material ?? handoff.material : undefined
      const materials = api.cruxMaterials
      if (material && (!material.body.trim() || new TextEncoder().encode(material.body).byteLength > 1024 * 1024)) {
        setHandoffError('需求材料须有正文且不超过 1 MiB，请保留原稿并选择可共享的版本。')
        return
      }
      if ((originalTask ? originalTask.handoff?.versionLabel : input.handoff?.versionLabel) && (!material || context.state !== 'local' && (!materials || !context.epoch))) {
        setHandoffError('原需求版本或材料接口不可用，请回到原需求后重试。')
        return
      }
      flight.current = true
      setHandoffError('')
      setSavingMaterial(true)
      try {
        const captures = await capturePostFiles(handoff, selectedFileIds, () => source.canWrite(ticket))
        if (!source.canWrite(ticket)) return
        if (!submittedRef.current && !originalTask) {
          if (captures.length && input.handoff) input.handoff.files = captures.map(item => item.file)
          if (material && input.handoff) {
            input.handoff.materialDigest = await bodyDigest(material.body)
            if (handoff.draftId) input.handoff.sourceDraftId = handoff.draftId
          }
          if (!source.canWrite(ticket)) return
          saveTaskHandoffIntent(context, handoff.id, { input, material }, handoff)
          submittedRef.current = input
          setSubmitted(input)
        }
        let task = originalTask || undefined
        // Only this handoff's own pending create command may need reconciliation.
        const pendingReply = await api.crux.workspacePending()
        if (!source.canWrite(ticket)) return
        if (!pendingReply.ok) throw Error(pendingReply.error)
        const pending = pendingReply.data
          .find(command => command.operation === 'createTask' && command.taskHandoff?.id === handoff.id && command.taskHandoff.spaceId === spaceId && command.taskHandoff.creatorId === actorId)
        if (!task || submittedRef.current && pending) {
          const created = await mutate('创建团队任务', () => api.crux.createTask(input))
          if (!created || !source.owns(ticket)) return
          task = created.data.tasks.find(candidate => candidate.id === created.taskId && candidate.spaceId === spaceId && candidate.creatorId === actorId && candidate.handoff?.id === handoff.id)
          if (!task) throw Error('无法核对原任务回执。')
        }
        if (handoff.conversationId) {
          try { rememberTaskHandoffSource(context, task, handoff.conversationId, handoff.creatorId) }
          catch { setHandoffError('任务已创建，当前设备无法保存私人来源入口。') }
        }
        if (taskInputCanonical(task.handoff?.files ?? []) !== taskInputCanonical(captures.map(item => item.file))) throw Error('附件与原交接不一致，请重选原版本')
        await sendPostFiles({ workspaceKey: context.key, taskId: task.id, spaceId, taskCreatedAt: task.createdAt }, handoff.id, captures, () => source.canWrite(ticket))
        let materialDocumentId: string | undefined, materialVersionId: string | undefined
        if (material && materials && context.epoch && context.state !== 'local') {
          const scope = { workspaceKey: context.key, taskId: task.id, spaceId, taskCreatedAt: task.createdAt }
          const reconciled = await materials.reconcile({ ...scope, commandId: handoff.id })
          if (!source.canWrite(ticket)) return
          if (!reconciled.ok && reconciled.code !== 'NOT_FOUND') throw Error(reconciled.error)
          let saved = reconciled.ok ? reconciled.value : null
          if (reconciled.ok && !saved) {
            const retried = await materials.retry({ ...scope, commandId: handoff.id })
            if (!source.canWrite(ticket)) return
            if (!retried.ok) throw Error(retried.error)
            saved = retried.value.result
          }
          if (!reconciled.ok) {
            const digest = await bodyDigest(material.body)
            if (!source.canWrite(ticket)) return
            if (task.handoff?.materialDigest !== digest) throw Error('需求版本与原交接正文不一致，请从原需求版本补挂。')
            const result = await materials.command({ ...scope, command: {
              action: 'create', kind: 'prd', commandId: handoff.id, expectedEpoch: context.epoch,
              spaceId, taskCreatedAt: task.createdAt, title: material.title, text: material.body, expectedDigest: digest,
              references: [], editorIds: [actorId], approverIds: [actorId]
            } })
            if (!source.canWrite(ticket)) return
            if (!result.ok) throw Error(result.error)
            saved = result.value.result
          }
          if (!saved) throw Error('原材料保存结果尚未确认。')
          if (saved.action !== 'create' || saved.outcome !== 'applied' || saved.commandId !== handoff.id || saved.taskId !== task.id ||
              saved.taskCreatedAt !== task.createdAt || saved.spaceId !== spaceId || saved.projectId !== context.projectId ||
              saved.actorId !== actorId || saved.epoch !== context.epoch || saved.instanceId !== context.instanceId) throw Error('材料回执与原任务不匹配。')
          materialDocumentId = saved.documentId
          if (!saved.versionId) throw Error('材料回执缺少固定版本。')
          materialVersionId = saved.versionId
          const fixed = await materials.read({ ...scope, documentId: saved.documentId, versionId: saved.versionId })
          if (!source.canWrite(ticket)) return
          if (!fixed.ok) throw Error(fixed.error)
          if (fixed.value.document.taskId !== task.id || fixed.value.document.taskCreatedAt !== task.createdAt ||
              fixed.value.selected.versionId !== saved.versionId || fixed.value.selected.bodyDigest !== task.handoff?.materialDigest ||
              await bodyDigest(fixed.value.text) !== task.handoff?.materialDigest) throw Error('原需求固定版本核对失败。')
          const refreshed = await mutate('刷新团队需求材料', () => api.crux.snapshot())
          if (!refreshed || !source.canWrite(ticket)) return
        }
        const completed = { taskId: task.id, spaceId, triagePending: Boolean(task.triagePending), materialDocumentId,
          materialVersionId,
          files: captures.map(item => item.file) }
        draft.discard()
        clearTaskHandoffRecovery(context, handoff, taskSourceKey(snapshot, context), actorId)
        onCreated?.(completed)
        onClose()

      } catch (cause) {
        if (source.owns(ticket)) setHandoffError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        flight.current = false
        if (source.owns(ticket)) setSavingMaterial(false)
      }
      return
    }
    const acknowledge = draft.acknowledge()
    const result = await mutate('新建任务', async () => { const result = await api.crux.createTask(input); if (result.ok) acknowledge(); return result })
    if (result) {
      if (autoEnqueueRun && allocation.executor && !triagePending) {
        const execAgent = allocation.executor.kind === 'agent'
          ? snapshot.agents.find((a) => a.id === allocation.executor?.id)
          : undefined
        const slot = useLocalExecutionSlot.getState().resolveAgentSlot(
          allocation.executor.id,
          execAgent ? { runtimeKind: execAgent.runtimeKind, workingDirectory: execAgent.workingDirectory } : undefined
        ).slot
        const agentMeta = useCollaborationPlatform.getState().getAgentMeta(allocation.executor.id)
        useTaskRuns.getState().enqueueRun({
          taskId: result.taskId,
          spaceId,
          executorKind: allocation.executor.kind,
          executorId: allocation.executor.id,
          executorName: allocation.executor.name,
          runtimeKind: slot.runtimeKind,
          model: slot.model,
          workingDirectory: slot.workingDirectory,
          localWorkdirPath: slot.localWorkdirPath,
          isolationMode: agentMeta.isolationMode,
          triggerSource: 'delegate',
          prompt: `新建委派任务 ${result.taskId}「${title.trim()}」：\n${description.trim() || '请按任务标题分析并推进'}`,
          runtimeReady: true
        })
      }
      onClose()
      useCrux.getState().openTask(result.taskId)
    }
  }
  if (handoff?.draftId && explicitTriage) {
    if (!open) return null
    return <section className="flex flex-wrap items-center gap-2 border-b border-my-line bg-my-panel px-4 py-2" aria-label="交接需求">
      <span className="my-item-title">{handoff.material?.versionLabel ?? handoff.title}</span>
      <Select ariaLabel="目标空间" disabled={disabled || locked || savingMaterial} value={spaceId} onChange={onSelectSpace} options={handoffSpaces.map(item => ({ value: item.id, label: item.name }))} />
      {context.state === 'connected' && <fieldset className="min-w-0 border-0" disabled={disabled || locked || savingMaterial}><PostFilePicker source={handoff} selected={selectedFileIds} onChange={setSelectedFileIds} /></fieldset>}
      <Button size="sm" variant="primary" disabled={disabled || savingMaterial || reconciliationRequired} onClick={() => void submit()}>{savingMaterial ? '正在交接…' : locked ? '核对原任务' : '创建任务'}</Button>
      <Button size="sm" variant="ghost" onClick={close}>收起</Button>
      {(handoffError || draftError || error) && <span role="alert" className="collab-inline-error">{handoffError || draftError || error}</span>}
    </section>
  }
  if (!handoff && creationMode === 'ai' && actorId) {
    if (!open) return null
    return <div className="relative flex min-h-0 flex-1 flex-col bg-my-canvas">
      <div className="z-10 flex shrink-0 items-center gap-2 border-b border-my-line bg-my-canvas px-4 py-2">
        <span className="text-my-xs text-my-tertiary">创建方式</span>
        <Button size="sm" variant="outline" aria-pressed={false} onClick={() => setCreationMode('manual')}><PenLine size={14} />手动创建</Button>
        <Button size="sm" variant="neutral" aria-pressed><Bot size={14} />Agent 整理</Button>
      </div>
      <div className="relative min-h-0 flex-1"><RequirementIntake snapshot={snapshot} spaceId={spaceId} actorId={actorId} draft={draft} onClose={close} onManual={() => {
        if (!source.canWrite()) return
        if (!title.trim() && intakeOriginal.trim()) setTitle(intakeOriginal.trim().split('\n')[0].slice(0, 160))
        if (!description.trim() && (intakeOriginal.trim() || intakeFiles.length)) setDescription(discussionInput(intakeOriginal, intakeFiles, '', ''))
        setCreationMode('manual')
      }} /></div>
    </div>
  }
  const submitting = pending || savingMaterial
  const submitDisabled = disabled || savingMaterial || discarding || reconciliationRequired || (!locked && (!title.trim() || needsFallback || requiresAssignee || !triagePending && !canAct))
  const submitTooltip = submitBlockedReason && !submitting
    ? submitBlockedReason
    : explicitTriage === true ? '先进入分拣，接纳后可安排版本' : 'Ctrl+Enter 或 Command+Enter 创建'
  return <Modal open={open} onClose={close} ariaLabel={heading}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col bg-my-panel">
      <header className="flex h-my-header shrink-0 items-center gap-3 border-b border-my-line px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="truncate text-my-md font-semibold text-my-primary">{heading}</h2>
          <span className="my-chip bg-my-layer-1 text-my-tertiary">{space.key}</span>
        </div>
        {!handoff && !initialParent && context.state !== 'local' && (
          <Segmented value={creationMode} size="sm" ariaLabel="创建方式">
            <button
              type="button"
              className={clsx('my-segment my-segment-label', creationMode === 'manual' ? 'text-my-primary' : 'text-my-secondary hover:text-my-primary')}
              aria-pressed={creationMode === 'manual'}
              onClick={() => setCreationMode('manual')}
            >
              <PenLine size={12} />
              <span>手动</span>
            </button>
            <button
              type="button"
              className={clsx('my-segment my-segment-label', creationMode === 'ai' ? 'text-my-primary' : 'text-my-secondary hover:text-my-primary')}
              aria-pressed={creationMode === 'ai'}
              onClick={() => setCreationMode('ai')}
            >
              <Sparkles size={12} />
              <span>Agent</span>
            </button>
          </Segmented>
        )}
        <Tooltip label="关闭新建任务">
          <Button size="sm" variant="ghost" className="w-7 px-0" aria-label="关闭新建任务" onClick={close}>
            <X size={15} />
          </Button>
        </Tooltip>
      </header>
      <div className="my-scrollbar min-h-0 overflow-y-auto px-6 py-5">
        {space.archived && <p role="alert" className="mb-3 text-my-sm text-my-secondary">空间已停用，恢复后才能创建任务。</p>}
        {!canAct && <p role="alert" className="mb-3 text-my-sm text-my-secondary">当前身份不是该空间成员，无法创建任务。</p>}
        {(error || handoffError || draftError) && <p role="alert" className="collab-inline-error mb-3">{handoffError || draftError || error}</p>}
        <fieldset disabled={disabled || locked || savingMaterial || discarding} className="flex min-w-0 flex-col gap-3.5 border-0 p-0" onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }}>
          {handoff && <Field label="团队空间">
            <Select
              className="w-full"
              value={spaceId}
              onChange={onSelectSpace}
              options={handoffSpaces.map((item) => ({ value: item.id, label: item.name }))}
            />
          </Field>}
          <Field label="任务标题">
            <input
              ref={titleInputRef}
              autoFocus
              required
              aria-invalid={titleInvalid || undefined}
              aria-describedby={titleInvalid ? titleErrorId : undefined}
              className={clsx(inputClass, titleShaking && 'my-shake')}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value)
                if (titleInvalid && event.target.value.trim()) setTitleInvalid(false)
              }}
            />
            {titleInvalid && <span id={titleErrorId} role="alert" className="pl-0.5 text-my-xs text-my-danger-text">请输入任务标题</span>}
          </Field>
          <Field label={handoff ? '共享的任务描述' : '描述'}><textarea className={textareaClass} rows={handoff ? 6 : 3} value={description} onChange={event => setDescription(event.target.value)} /></Field>
          {handoff && <PostFilePicker source={handoff} selected={selectedFileIds} onChange={setSelectedFileIds} />}
          {selectedMaterial && <div className="rounded-my-md border border-my-line bg-my-layer-1 p-3"><p className="text-my-sm text-my-primary">首次正文 · {selectedMaterial.versionLabel}</p><details className="mt-2 text-my-sm text-my-secondary"><summary className="cursor-pointer">查看共享正文</summary><p className="mt-2 whitespace-pre-wrap break-words">{selectedMaterial.body}</p></details></div>}
          {handoff && !triagePending && <Field label="负责人"><TaskAllocationPicker snapshot={snapshot} spaceId={spaceId} value={allocation} onChange={setAllocation} fallbackActorId={actorId} disabled={disabled || locked} /></Field>}
          {!handoff && (
            <Field label="负责人与 AI 委派执行者">
              <div className="flex min-w-0 flex-col gap-2">
                <TaskAllocationPicker snapshot={snapshot} spaceId={spaceId} value={allocation} onChange={setAllocation} fallbackActorId={actorId} disabled={disabled} />
                {allocation.executor && !triagePending && (
                  <div className="flex items-center gap-2 pl-0.5 text-my-xs text-my-secondary">
                    <Checkbox
                      checked={autoEnqueueRun}
                      onChange={setAutoEnqueueRun}
                      disabled={disabled || locked}
                      ariaLabel={`创建后立即派发给「${allocation.executor.name}」进入执行队列`}
                    />
                    <span
                      className="cursor-pointer select-none hover:text-my-primary"
                      onClick={() => { if (!disabled && !locked) setAutoEnqueueRun((checked) => !checked) }}
                    >
                      创建后立即派发给「{allocation.executor.name}」进入执行队列
                    </span>
                  </div>
                )}
              </div>
            </Field>
          )}
          <div className="pt-0.5">
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((prev) => !prev)}
              className="flex cursor-pointer items-center gap-1.5 pl-0.5 text-my-xs font-normal text-my-tertiary transition-colors hover:text-my-primary"
            >
              <ChevronRight size={13} className="my-disclosure-chevron" data-open={detailsOpen || undefined} />
              <span>完善任务属性</span>
            </button>
            <DisclosureGrid open={detailsOpen} innerClassName="pt-3">
              <div className="flex flex-col gap-3.5">
          {!initialParent && canChooseIntent && <Field label="安排"><Select value={creationIntent} onChange={value => chooseIntent(value as TaskCreationIntent)} options={[{ value: 'schedule', label: '加入看板' }, { value: 'triage', label: '交给分拣台' }]} /></Field>}
          {!triagePending && <Field label="版本">
            <Select
              className="w-full"
              value={iterationId}
              onChange={setIterationId}
              options={[
                { value: '', label: '稍后排期' },
                ...iterations.map((iteration) => ({ value: iteration.id, label: iteration.name }))
              ]}
            />
          </Field>}
            {staged && <>
              <Field label="验收标准"><textarea className={textareaClass} rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一条，创建后也可以补充" /></Field>
              <Field label="工作内容">
                <Select
                  className="w-full"
                  value={workKind}
                  onChange={(val) => setWorkKind(val as CruxTaskWorkKind)}
                  options={cruxTaskWorkKindSchema.options.map((kind) => ({ value: kind, label: WORK_KIND_LABELS[kind] }))}
                />
              </Field>
            </>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="类型">
                <Select
                  className="w-full"
                  value={typeId}
                  onChange={setTypeId}
                  options={[
                    { value: '', label: '默认类型' },
                    ...types.map((type) => ({ value: type.id, label: type.name }))
                  ]}
                />
              </Field>
              <Field label="优先级">
                <Select
                  className="w-full"
                  value={priority}
                  onChange={(val) => setPriority(val as CruxPriority)}
                  options={(Object.keys(PRIORITY_LABEL) as CruxPriority[]).map((value) => ({ value, label: PRIORITY_LABEL[value] }))}
                />
              </Field>
            </div>
          <div className="flex flex-col gap-3.5">
            <Field label="专项">
              <Select
                className="w-full"
                value={projectId}
                onChange={setProjectId}
                options={[
                  { value: '', label: '无专项' },
                  ...snapshot.projects.filter((project) => project.spaceId === spaceId && project.status === 'active').map((project) => ({ value: project.id, label: project.name }))
                ]}
              />
            </Field>
            <Field label="父任务">
              <Select
                className="w-full"
                value={parentTaskId}
                onChange={setParentTaskId}
                options={[
                  { value: '', label: '无父任务' },
                  ...snapshot.tasks.filter((task) => task.spaceId === spaceId).map((task) => ({ value: task.id, label: `${task.id} · ${task.title}` }))
                ]}
              />
            </Field>
            {labels.length > 0 && <Field label="标签"><div className="flex flex-wrap gap-1.5">{labels.map((label) => <Button key={label.id} size="sm" variant={labelIds.includes(label.id) ? 'surface' : 'outline'} aria-pressed={labelIds.includes(label.id)} onClick={() => setLabelIds((current) => current.includes(label.id) ? current.filter((id) => id !== label.id) : [...current, label.id])}>{label.name}</Button>)}</div></Field>}
          </div></div>
            </DisclosureGrid>
          </div>
        </fieldset>
        {originalTask && handoffError && <p role="status" className="mt-3 text-my-sm text-my-secondary">{originalTask.id} 已创建，需求材料待补挂。</p>}
        {needsFallback && <p role="alert" className="mt-3 text-my-xs text-my-secondary">请为 Agent 或小队选择一名兜底处理人。</p>}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-my-line px-6 py-3.5">
        {(draft.hasDraft || handoff) && !locked && (
          <div className="mr-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" className="text-my-tertiary hover:text-my-primary" disabled={busy || pending || discarding} onClick={() => void discard()}>
              {discarding ? '核对中…' : '放弃草稿'}
            </Button>
            {draft.hasDraft && !handoff && <span className="text-my-2xs text-my-tertiary">已自动暂存</span>}
          </div>
        )}
        <Button size="sm" variant="ghost" onClick={close}>取消</Button>
        <Tooltip label={submitTooltip} wrap>
          <Button size="sm" variant="primary" aria-busy={submitting || undefined} disabled={submitDisabled} onClick={() => void submit()}>
            {submitting && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {pending ? '创建中…' : savingMaterial ? '保存材料中…' : reconciliationRequired ? '需核对创建结果' : originalTask ? '核对任务和材料' : locked ? '核对并重试' : handoff ? '创建团队任务' : '创建任务'}
          </Button>
        </Tooltip>
      </footer>
    </div>
  </Modal>
}
