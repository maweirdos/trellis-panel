import type { ConversationProjectedWorkItem } from '../../../shared/conversation/command-runtime'
import type { ProviderInteractionMode } from '../../../shared/conversation/providerPolicy'
import { isActiveRun, type ConversationMessage, type ConversationRun } from './threadProjectionModel'

export interface PromptSuggestion {
  readonly key: string
  readonly text: string
  readonly reason: string
}

export interface DerivePromptSuggestionInput {
  readonly threadId: string
  readonly runs: readonly ConversationRun[]
  readonly messages: readonly ConversationMessage[]
  readonly turnItems?: readonly ConversationProjectedWorkItem[]
  readonly interactionMode?: ProviderInteractionMode
}

const TEST_COMMAND_PATTERN = /\b(test|vitest|jest|pytest|cargo\s+test|go\s+test|tsc|typecheck|check|lint|build)\b/i

/**
 * 零延迟确定性续问预测（对标 t3code Prompt Suggestion）：
 * 仅在会话空闲且上一轮已结束时，依据上一轮结果类型（计划卡 / 失败 / 中断 / 改动文件 / 常规完成）
 * 推导出最直接的一条下一步指令，用户按 Tab 即可一键采纳。
 */
export function deriveNextPromptSuggestion(input: DerivePromptSuggestionInput): PromptSuggestion | null {
  const { threadId, runs, messages, turnItems = [], interactionMode = 'default' } = input
  if (!threadId || runs.length === 0) return null
  if (runs.some((run) => isActiveRun(run))) return null

  const latestSettled = [...runs]
    .filter((run) => !run.compaction && !run.outcomeUnknown && ['completed', 'failed', 'interrupted', 'cancelled'].includes(run.status))
    .sort((left, right) => left.ordinal - right.ordinal)
    .at(-1)
  if (!latestSettled) return null

  const key = `${threadId}:${latestSettled.id}:${latestSettled.status}`

  if (latestSettled.status === 'failed') {
    return {
      key,
      text: '定位上述报错根因并直接修复。',
      reason: '上次执行出错',
    }
  }
  if (latestSettled.status === 'interrupted' || latestSettled.status === 'cancelled') {
    return {
      key,
      text: '从中断处继续完成剩余改动。',
      reason: '上次回合已中断',
    }
  }

  const latestItems = turnItems.filter((item) => item.runId === latestSettled.id)
  const hasProposedPlan = latestItems.some((item) => item.type === 'proposed_plan')
  if (hasProposedPlan || interactionMode === 'plan') {
    return {
      key,
      text: '按上述方案开始实施。',
      reason: hasProposedPlan ? '方案已生成' : '规划模式就绪',
    }
  }

  const hasFileChange = latestItems.some((item) => item.type === 'file_change')
  const ranChecks = latestItems.some(
    (item) => item.type === 'command_execution' && TEST_COMMAND_PATTERN.test(item.input),
  )
  if (hasFileChange && !ranChecks) {
    return {
      key,
      text: '运行类型检查与相关测试，验证刚才的改动。',
      reason: '已修改工作区文件',
    }
  }

  const latestAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.runId === latestSettled.id && !message.streaming)
  const replyText = latestAssistant?.text.trim() ?? ''
  if (!replyText) return null

  if (/[？?]\s*$/m.test(replyText.slice(-260)) && /(?:下一步|继续|是否|方案|选项)/.test(replyText.slice(-260))) {
    return {
      key,
      text: '按推荐方案继续推进下一步。',
      reason: '等待确认下一步',
    }
  }

  if (hasFileChange && ranChecks) {
    return {
      key,
      text: '总结本次改动影响范围，并检查是否遗漏边界情况。',
      reason: '改动与检查已完成',
    }
  }

  if (replyText.length >= 80) {
    return {
      key,
      text: '继续细化关键步骤并落地实现。',
      reason: '续问建议',
    }
  }

  return null
}
