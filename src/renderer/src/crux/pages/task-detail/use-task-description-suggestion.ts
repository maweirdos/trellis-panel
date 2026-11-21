import { useCallback, useEffect, useRef, useState } from 'react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { TaskDescriptionSuggestionResult } from '@shared/crux-task-suggestions'
import { conversationClient, conversationValue } from '../../../conversations/client'
import { useCrux } from '../../store'

export interface TaskDescriptionSuggestionSelection {
  text: string
  from: number
  to: number
  comparisonOnly?: boolean
}

export interface TaskDescriptionSuggestionState {
  commandId?: string
  status: 'idle' | 'running' | 'candidate' | 'adopted' | 'closed' | 'failed' | 'unknown'
  message: string
  source?: TaskDescriptionSuggestionSelection
  replacement?: string
  busy: boolean
  stale: boolean
  cancel(): void
  start(selection: TaskDescriptionSuggestionSelection, instruction: string): Promise<boolean>
  check(): Promise<void>
  adopt(): Promise<void>
  close(): void
}

export interface TaskDescriptionSuggestionPort {
  conversationId: string
  entryKey: string
  workspaceKey: string
  actorId: string
}

async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const value = (result: TaskDescriptionSuggestionResult): Pick<TaskDescriptionSuggestionState, 'status' | 'message' | 'source' | 'replacement'> =>
  result.state === 'candidate' ? { status: result.state, message: result.message, source: { text: result.source.text, from: result.source.from, to: result.source.to, ...(result.source.comparisonOnly ? { comparisonOnly: true } : {}) }, replacement: result.replacement }
    : { status: result.state, message: result.state === 'adopted' ? `已采用任务正文建议。` : result.message, ...(result.state === 'adopted' ? { replacement: undefined, source: undefined } : {}) }

export function useTaskDescriptionSuggestion({ snapshot, task, port, enabled }: {
  snapshot: CruxSnapshot | null
  task: CruxTask | null
  port?: TaskDescriptionSuggestionPort
  enabled: boolean
}): TaskDescriptionSuggestionState {
  const [state, setState] = useState<Pick<TaskDescriptionSuggestionState, 'commandId' | 'status' | 'message' | 'source' | 'replacement'>>({ status: 'idle', message: '' })
  const [busy, setBusy] = useState(false)
  const sourceRevision = useRef('')
  const commandId = useRef('')
  const selectionRef = useRef<TaskDescriptionSuggestionSelection | null>(null)
  const ready = Boolean(snapshot && task)
  const revision = task?.description ?? ''
  const stale = ready && state.status === 'candidate' && sourceRevision.current !== revision
  const owner = JSON.stringify([task?.id, task?.createdAt, port?.conversationId, port?.actorId, port?.workspaceKey])
  const latestOwner = useRef(owner); latestOwner.current = owner
  useEffect(() => {
    commandId.current = ''; selectionRef.current = null; setState({ status: 'idle', message: '' }); setBusy(false)
  }, [owner])

  const current = useCallback((): boolean => Boolean(snapshot && task && port && conversationClient()?.taskSuggestion), [port, snapshot, task])

  const start = useCallback(async (selection: TaskDescriptionSuggestionSelection, instruction: string): Promise<boolean> => {
    if (!enabled || !snapshot || !task || busy || !port || !current() || selection.to <= selection.from || !selection.text.trim() || !instruction.trim()) return false
    setBusy(true)
    try {
      const client = conversationClient()
      if (!client?.taskSuggestion) throw new Error('任务正文建议入口尚未加载。')
      const text = task.description ?? ''
      if (text.slice(selection.from, selection.to) !== selection.text) throw new Error('原选区与当前任务正文不一致。')
      const bodyRevision = await digest(text)
      const id = crypto.randomUUID()
      commandId.current = id; selectionRef.current = selection; sourceRevision.current = text
      if (port.workspaceKey !== useCrux.getState().workspaceContext.key) throw new Error('任务工作区身份已变化，请重新打开任务。')
      const result = conversationValue(await client.taskSuggestion.start(port.conversationId, {
        conversationId: port.conversationId, workspaceKey: port.workspaceKey, actorId: port.actorId, taskId: task.id, taskCreatedAt: task.createdAt, commandId: id,
        selection: { text: selection.text, bodyRevision, from: selection.from, to: selection.to, ...(selection.comparisonOnly ? { comparisonOnly: true } : {}) }, instruction: instruction.trim()
      }))
      if (latestOwner.current !== owner || commandId.current !== id) return false
      setState({ commandId: id, ...value(result) })
      return result.state === 'running' || result.state === 'unknown'
    } catch (cause) {
      setState({ status: 'failed', message: cause instanceof Error ? cause.message : '任务正文建议生成失败。' })
      return false
    } finally { setBusy(false) }
  }, [busy, current, enabled, port, snapshot, task])

  const check = useCallback(async (): Promise<void> => {
    if (!enabled || busy || !port || !current() || !commandId.current) return
    setBusy(true)
    try {
      const client = conversationClient()
      if (!client?.taskSuggestion) throw new Error('任务正文建议入口尚未加载。')
      const result = conversationValue(await client.taskSuggestion.check(port.conversationId, { conversationId: port.conversationId, commandId: commandId.current }))
      if (latestOwner.current !== owner) return
      setState({ commandId: commandId.current, ...value(result) })
    } catch (cause) {
      setState({ status: 'failed', message: cause instanceof Error ? cause.message : '任务正文建议结果读取失败。' })
    } finally { setBusy(false) }
  }, [busy, current, enabled, port])

  useEffect(() => {
    if (!enabled || busy || state.status !== 'running') return
    const timer = setTimeout(() => void check(), 1400)
    return () => clearTimeout(timer)
  }, [enabled, busy, state.status, check])

  const adopt = useCallback(async (): Promise<void> => {
    if (!enabled || !snapshot || !task || busy || stale || !port || !current() || !commandId.current || state.status !== 'candidate' || !state.source || state.replacement === undefined || selectionRef.current?.text !== state.source.text || selectionRef.current.from !== state.source.from || selectionRef.current.to !== state.source.to) return
    setBusy(true)
    try {
      const client = conversationClient()
      if (!client?.taskSuggestion) throw new Error('任务正文建议入口尚未加载。')
      const expectedDescription = task.description ?? ''
      if (expectedDescription.slice(state.source.from, state.source.to) !== state.source.text) throw new Error('任务正文已更新，请重新选择。')
      if (port.workspaceKey !== useCrux.getState().workspaceContext.key) throw new Error('任务工作区身份已变化，请重新打开任务。')
      const description = expectedDescription.slice(0, state.source.from) + state.replacement + expectedDescription.slice(state.source.to)
      const result = conversationValue(await client.taskSuggestion.adopt(port.conversationId, {
        conversationId: port.conversationId, workspaceKey: port.workspaceKey, actorId: port.actorId, taskId: task.id, taskCreatedAt: task.createdAt, commandId: commandId.current, expectedDescription, description
      }))
      if (latestOwner.current !== owner) return
      setState({ commandId: commandId.current, ...value(result) })
      if (result.state === 'adopted') void useCrux.getState().bootstrap()
    } catch (cause) {
      setState({ status: 'failed', message: cause instanceof Error ? cause.message : '任务正文建议采用失败。' })
    } finally { setBusy(false) }
  }, [busy, current, enabled, port, snapshot, stale, state.replacement, state.source, state.status, task])

  const close = useCallback((): void => {
    if (state.status === 'adopted' || !commandId.current) return
    setState({ status: 'closed', message: '建议已关闭，任务正文保持原文。' })
    if (port && current()) void conversationClient()?.taskSuggestion?.close(port.conversationId, { conversationId: port.conversationId, commandId: commandId.current }).catch(() => undefined)
  }, [current, port, state.status])

  const cancel = useCallback((): void => {
    if (state.status !== 'running' || !commandId.current || busy) return
    setState({ status: 'closed', message: '润色已取消，任务正文保持原文。' })
    if (port && current()) void conversationClient()?.taskSuggestion?.close(port.conversationId, { conversationId: port.conversationId, commandId: commandId.current }).catch(() => undefined)
  }, [busy, current, port, state.status])

  return { ...state, commandId: commandId.current, busy, stale, cancel, start, check, adopt, close }
}
