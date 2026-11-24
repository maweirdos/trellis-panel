import type { TaskPlanningRuntimeObservation } from '../../../shared/conversation/task-planning-runtime'
import { DaemonError } from '../errors'
import type { ConversationRuntime } from './conversation'
import type { resolveTaskPlanningLaunch } from '../../services/task-planning/runtime-authority'

type PlanningLaunch = Awaited<ReturnType<typeof resolveTaskPlanningLaunch>>

export function observePlanningConversation(
  conversation: ConversationRuntime, launch: PlanningLaunch, cleanupConfirmed = false,
): TaskPlanningRuntimeObservation {
  const { ownerId, spaceId, projectId } = launch.authority
  const receipt = conversation.readCommand(launch.commandId, ownerId, spaceId, projectId)
  if (!receipt) return { threadId: null, runId: null, state: 'unrecorded', cleanupConfirmed }
  const { threadId, runId } = receipt
  const snapshot = conversation.readThread(threadId, ownerId, spaceId, projectId)
  const run = snapshot?.runs.find(item => item.id === runId)
  const result = { threadId, runId, cleanupConfirmed, ...(receipt.detail && { detail: receipt.detail }) }
  if (!run || receipt.dispatch === 'pending-reconciliation') return { ...result, state: 'unknown' }
  if (run.status === 'cancelled' || run.status === 'interrupted') return { ...result, state: 'cancelled' }
  if (receipt.dispatch === 'failed') return { ...result, state: 'failed' }
  if (receipt.dispatch !== 'completed') return { ...result, state: 'waiting' }
  if (run.status !== 'completed' || !run.engineAcceptedAt || !run.completedAt) return { ...result, state: 'unknown' }
  const messages = snapshot?.messages.filter(item => item.runId === runId && item.role === 'assistant') ?? []
  if (messages.some(item => item.streaming)) return { ...result, state: 'unknown' }
  const finalText = messages.map(item => item.text).join('\n\n').trim()
  return finalText
    ? { ...result, state: 'completed', finalText }
    : { ...result, state: 'failed', detail: '原规划回合没有完整的模型答复。' }
}

export function startPlanningConversation(conversation: ConversationRuntime, launch: PlanningLaunch): TaskPlanningRuntimeObservation {
  const { authority, selection, commandId, text, title } = launch
  const existing = observePlanningConversation(conversation, launch)
  if (existing.state !== 'unrecorded') return existing
  authority.assertSpawnCurrent()
  conversation.createThread({
    ...authority, title, text, commandId, model: selection.modelId, instanceId: selection.instanceId,
    options: selection.options, assertCurrent: authority.assertSpawnCurrent,
    assertAuthorityCurrent: authority.assertCurrent, assertSpawnCurrent: authority.assertSpawnCurrent,
  })
  const observed = observePlanningConversation(conversation, launch)
  if (observed.state === 'unrecorded') throw new DaemonError('E_UNKNOWN', '原规划命令尚待核对。', 'unknown')
  return observed
}
