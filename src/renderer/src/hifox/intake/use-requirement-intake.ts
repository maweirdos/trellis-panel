import { useEffect, useRef, useState } from 'react'
import type { HifoxSnapshot } from '@shared/hifox'
import type { TeamContentJob, TeamContentReadiness } from '@shared/team-content'
import { api } from '../../api'
import { useHifox } from '../store'
import { useTaskDraftField, type TaskDraft } from '../pages/task-detail/task-drafts'
import { useTaskMutation, useTaskSource } from '../pages/task-detail/use-task-source'
import { discussionInput } from './requirements'
import { contentErrorMessage } from './content-errors'

export type IntakeFile = { name: string; text: string }
export type IntakeAdoption = { taskId: string; taskCreatedAt: string; jobId: string; text: string; title: string; criteria: string[]; reviewerId: string; mode?: 'draft' | 'review' }
export function useRequirementIntake(snapshot: HifoxSnapshot, spaceId: string, actorId: string, draft: TaskDraft) {
  const originalSource = useTaskSource({ spaceId, creating: true })
  const context = useHifox(state => state.workspaceContext)
  const [original, setOriginal] = useTaskDraftField(draft, 'intakeOriginal', '')
  const [files, setFiles] = useTaskDraftField<IntakeFile[]>(draft, 'intakeFiles', [])
  const [references, setReferences] = useTaskDraftField<{ documentId: string; versionId: string }[]>(draft, 'intakeReferences', [])
  const [taskId, setTaskId] = useTaskDraftField(draft, 'intakeTaskId', '')
  const [taskCreatedAt, setTaskCreatedAt] = useTaskDraftField(draft, 'intakeTaskCreatedAt', '')
  const [taskSaveUnknown, setTaskSaveUnknown] = useTaskDraftField(draft, 'intakeTaskSaveUnknown', false)
  const [generatedFrom, setGeneratedFrom] = useTaskDraftField(draft, 'intakeGeneratedFrom', '')
  const [pendingInputs, setPendingInputs] = useTaskDraftField(draft, 'intakePendingInputs', '')
  const [job, setJob] = useTaskDraftField<TeamContentJob | null>(draft, 'intakeJob', null)
  const [commandId, setCommandId] = useTaskDraftField(draft, 'intakeCommandId', '')
  const [cancelCommand, setCancelCommand] = useTaskDraftField(draft, 'intakeCancelCommand', '')
  const [candidate, setCandidate] = useTaskDraftField(draft, 'intakeCandidate', '')
  const [answer, setAnswer] = useTaskDraftField(draft, 'intakeAnswer', '')
  const [adoption, writeAdoption] = useTaskDraftField<IntakeAdoption | null>(draft, 'intakeAdoption', null)
  const adoptionRef = useRef(adoption)
  adoptionRef.current = adoption
  const setAdoption = (value: IntakeAdoption): void => { adoptionRef.current = value; writeAdoption(value) }
  const matchesTask = (): boolean => !taskId || Boolean(taskCreatedAt && useHifox.getState().snapshot?.tasks.some(task => task.id === taskId && task.spaceId === spaceId && task.createdAt === taskCreatedAt))
  const source = { ...originalSource, available: originalSource.available && matchesTask(), owns: (ticket?: number) => originalSource.owns(ticket) && matchesTask(), canWrite: (ticket?: number) => originalSource.canWrite(ticket) && matchesTask() }
  const mutation = useTaskMutation(source)
  const [readiness, setReadiness] = useState<TeamContentReadiness | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const flight = useRef(false)
  const running = job?.state === 'pending' || job?.state === 'running'
  const scope = { workspaceKey: context.key }
  const refreshReadiness = async (): Promise<void> => {
    if (!api.teamContent || !source.owns()) return
    try { const reply = await api.teamContent.readiness(scope); if (source.owns()) { if (reply.ok) { setReadiness(reply.data); setError('') } else setError(contentErrorMessage(reply.code, reply.error)) } }
    catch (reason) { if (source.owns()) setError(reason instanceof Error ? reason.message : '团队AI状态读取失败，请稍后重试。') }
  }
  const staleInputs = Boolean(candidate && generatedFrom !== JSON.stringify([original, files, references]))
  const canEditInputs = (): boolean => source.canWrite() && !flight.current && !running && !commandId && !cancelCommand && !taskSaveUnknown && job?.state !== 'unknown' && !adoptionRef.current
  const matchesJob = (value: TeamContentJob, id: string, createdAt: string, command: string): boolean => value.kind === 'requirements' && value.taskId === id && value.spaceId === spaceId && value.taskCreatedAt === createdAt && value.ownerId === actorId && value.projectId === context.projectId && value.instanceId === context.instanceId && value.epoch === context.epoch && value.commandId === command
  const acceptJob = (value: TeamContentJob, id: string, createdAt: string, command: string, inputs: string): void => {
    if (!matchesJob(value, id, createdAt, command)) throw Error('整理结果不属于原任务或原请求，请回到原任务核对。')
    setJob(value)
    if (value.state === 'succeeded' && !value.cancelRequested && value.candidate) { setCandidate(value.candidate.body); setGeneratedFrom(inputs); setAnswer(''); setError('') }
    else if (!['pending', 'running'].includes(value.state)) setError(value.state === 'unknown' ? '原执行结果待核对，请联系管理员核对这次请求，不要重复生成。' : value.state === 'cancelled' ? '本次整理已取消，原素材和上一版候选已保留。' : contentErrorMessage(value.errorCode, '本次整理未完成，原素材和上一版候选已保留。'))
  }
  useEffect(() => {
    if (!api.teamContent) { setError('当前客户端尚未接入团队AI，请更新客户端，或先手动创建。'); return }
    void api.teamContent.readiness(scope).then(reply => {
      if (!source.owns()) return
      if (reply.ok) setReadiness(reply.data); else setError(contentErrorMessage(reply.code, reply.error))
    }).catch(reason => { if (source.owns()) setError(reason instanceof Error ? reason.message : '团队AI状态读取失败，请稍后重试。') })
    // The enclosing form is keyed to the complete original authority.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.key, context.epoch, context.actorId])
  useEffect(() => {
    const content = api.teamContent
    if (!job || !taskId || !running || !content) return
    let timer: ReturnType<typeof setTimeout> | undefined, live = true
    const poll = async (): Promise<void> => {
      if (!live || !source.owns()) return
      if (document.visibilityState !== 'visible') { timer = setTimeout(() => void poll(), 1500); return }
      try {
        const reply = await content.job({ ...scope, taskId, jobId: job.jobId })
        if (!live || !source.owns()) return
        if (reply.ok) {
          if (reply.data.jobId !== job.jobId) throw Error('返回了其他整理任务，请核对原请求。')
          acceptJob(reply.data, taskId, taskCreatedAt, job.commandId, pendingInputs)
          if (!['pending', 'running'].includes(reply.data.state)) return
        } else setError(contentErrorMessage(reply.code, reply.error))
      } catch (reason) { if (live && source.owns()) setError(reason instanceof Error ? reason.message : '整理状态读取失败，原请求已保留。') }
      if (live && source.owns()) timer = setTimeout(() => void poll(), 1500)
    }
    timer = setTimeout(() => void poll(), 500)
    return () => { live = false; if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId, running, taskId, taskCreatedAt])
  const run = async (): Promise<void> => {
    const content = api.teamContent
    if (!content || !canEditInputs() || !original.trim()) return
    const text = discussionInput(original, files, candidate, answer)
    if (new TextEncoder().encode(text).byteLength > 32 * 1024) { setError('本轮素材、候选和补充合计超过32KB。请减少资料或精简上一版正文。'); return }
    if (!readiness?.capabilities.includes('requirements')) { setError('团队尚未开放需求整理。请管理员配置团队AI；素材仍可手动保存。'); return }
    flight.current = true; setBusy(true); setError('')
    try {
      let id = taskId, createdAt = taskCreatedAt
      if (!id) {
        const type = snapshot.taskTypes.find(type => type.spaceId === spaceId && type.isDefault)
        const reply = await mutation.mutate('保存需求素材', async () => {
          setTaskSaveUnknown(true)
          const result = await api.hifox.createTask({ spaceId, creatorId: actorId, title: original.trim().split('\n')[0].slice(0, 160), description: discussionInput(original, files, '', ''), acceptanceCriteria: [], workKind: 'code', typeId: type?.id, assigneeIds: [actorId], iterationIds: [], labelIds: [], triagePending: true })
          // A closed form can retain a known task receipt under the same draft authority.
          if (result.ok) { setTaskId(result.taskId); setTaskCreatedAt(result.data.tasks.find(task => task.id === result.taskId)?.createdAt ?? ''); setTaskSaveUnknown(false) }
          else if (!result.outcomeUnknown && !result.pending && !['ORIGINAL_COMMAND_RECONCILED', 'COMMITTED_NOT_VISIBLE'].includes(result.code ?? '')) setTaskSaveUnknown(false)
          return result
        })
        if (!reply || !source.owns()) return
        id = reply.taskId
        createdAt = reply.data.tasks.find(task => task.id === id)?.createdAt ?? ''
      }
      const task = useHifox.getState().snapshot?.tasks.find(task => task.id === id && task.spaceId === spaceId)
      if (!task || !createdAt || task.createdAt !== createdAt) throw Error('原需求身份已变化，请先核对原任务，不要重复创建。')
      const originalCommand = crypto.randomUUID()
      setCommandId(originalCommand)
      const sentFrom = JSON.stringify([original, files, references])
      setPendingInputs(sentFrom)
      if (!source.canWrite()) return
      const reply = await content.generate({ ...scope, taskId: id, spaceId, taskCreatedAt: task.createdAt, expectedTaskUpdatedAt: task.updatedAt, kind: 'requirements', text, commandId: originalCommand, references })
      if (!source.owns()) return
      if (!reply.ok) { if (!reply.outcomeUnknown) setCommandId(''); setError(contentErrorMessage(reply.code, reply.error)); return }
      acceptJob(reply.data.job, id, task.createdAt, originalCommand, sentFrom); setCommandId('')
    } catch (reason) { if (source.owns()) setError(reason instanceof Error ? reason.message : '整理未完成，请核对原请求。') }
    finally { flight.current = false; if (source.owns()) setBusy(false) }
  }
  const reconcile = async (): Promise<void> => {
    const content = api.teamContent
    const originalCommand = commandId || (job?.state === 'unknown' ? job.commandId : '')
    if (!content || !originalCommand || !taskId || !source.owns() || flight.current) return
    flight.current = true; setBusy(true)
    try {
      const reply = await content.receipt({ ...scope, taskId, commandId: originalCommand })
      if (!source.owns()) return
      if (reply.ok && reply.data) { setError(''); acceptJob(reply.data, taskId, taskCreatedAt, originalCommand, pendingInputs); setCommandId('') }
      else setError(reply.ok ? '服务尚未确认这次请求。请保留原素材，稍后继续核对，不会发送另一份请求。' : reply.error)
    } catch (reason) { if (source.owns()) setError(reason instanceof Error ? reason.message : '原请求核对失败，请稍后继续核对。') }
    finally { flight.current = false; if (source.owns()) setBusy(false) }
  }
  const cancel = async (): Promise<void> => {
    const content = api.teamContent
    if (!content || !job || !taskId || !source.owns() || flight.current || adoptionRef.current) return
    flight.current = true; setBusy(true)
    try {
      const originalCommand = cancelCommand || crypto.randomUUID()
      setCancelCommand(originalCommand)
      const reply = await content.cancel({ ...scope, taskId, jobId: job.jobId, commandId: originalCommand })
      if (!source.owns()) return
      if (reply.ok) { if (reply.data.jobId !== job.jobId) throw Error('取消回执不属于原请求，请核对。'); acceptJob(reply.data, taskId, taskCreatedAt, job.commandId, pendingInputs); setCancelCommand('') }
      else setError(contentErrorMessage(reply.code, reply.error))
    } catch (reason) { if (source.owns()) setError(reason instanceof Error ? reason.message : '取消结果尚未确认，请核对原请求。') }
    finally { flight.current = false; if (source.owns()) setBusy(false) }
  }
  return { source, mutation, scope, original, setOriginal, files, setFiles, references, setReferences, taskId, taskCreatedAt, taskSaveUnknown, job, candidate, setCandidate, answer, setAnswer, readiness, refreshReadiness, busy, error: error || mutation.error, setError, running, commandId, cancelCommand, staleInputs, adoption, setAdoption, canEditInputs, matchesJob, run, reconcile, cancel }
}
