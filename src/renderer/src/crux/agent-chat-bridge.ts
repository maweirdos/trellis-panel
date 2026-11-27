import { create } from 'zustand'
import type { CruxAgent, CruxRuntimeKind, CruxSnapshot } from '@shared/crux'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { useLocalExecutionSlot } from './local-execution-slot'
import { useCrux, type CruxModule } from './store'
import type { ComposerModel } from '../conversation-workbench/useComposerSend'
import type { ConversationModelCatalog } from '../conversation-workbench/useConversationModelCatalog'

export interface ConversationAgentContext {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly spaceId: string
  readonly spaceName: string
  readonly spaceKey: string
  readonly instructions: string
  readonly skills: ReadonlyArray<{ id: string; name: string; content: string }>
  readonly repositories: ReadonlyArray<{ name: string; url?: string }>
  readonly runtimeKind: CruxRuntimeKind
  readonly preferredModel: string
  readonly approvalPolicy: string
  readonly workingDirectory: 'repo' | 'temp'
}

interface AgentChatBridgeState {
  selectedAgentId: string | null
  startNonce: number
  returnModule: CruxModule
  inspectAgentId: string | null
  selectAgent: (agentId: string | null) => void
  setInspectAgentId: (agentId: string | null) => void
  startAgentChat: (agentId: string | null, sharedFallback?: { runtimeKind?: CruxRuntimeKind; workingDirectory?: 'repo' | 'temp' }) => void
}

export const useAgentChatBridge = create<AgentChatBridgeState>()((set) => ({
  selectedAgentId: null,
  startNonce: 0,
  returnModule: 'all-agents',
  inspectAgentId: null,
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
  setInspectAgentId: (inspectAgentId) => set({ inspectAgentId }),
  startAgentChat: (agentId, sharedFallback) => {
    if (agentId) {
      const { slot } = useLocalExecutionSlot.getState().resolveAgentSlot(agentId, sharedFallback)
      const hasProject = Boolean(useApp.getState().snapshot?.meta.root)
      if (slot.workingDirectory === 'repo' && hasProject) {
        useMy.getState().setChatWorkdirMode('directory')
      } else if (slot.workingDirectory === 'temp') {
        useMy.getState().setChatWorkdirMode('default')
      }
    }
    const crux = useCrux.getState()
    const currentModule = crux.module
    set((state) => ({
      selectedAgentId: agentId,
      startNonce: state.startNonce + 1,
      returnModule: currentModule !== 'chat' ? currentModule : state.returnModule
    }))
    if (useApp.getState().page !== 'crux') {
      useApp.getState().setPage('crux')
    }
    crux.setModule('chat')
  }
}))

export function buildCruxAgentContext(snapshot: CruxSnapshot | null, agentId: string | null): ConversationAgentContext | null {
  if (!snapshot || !agentId) return null
  const agent = snapshot.agents.find((item) => item.id === agentId && !item.archived && item.enabled)
  if (!agent) return null
  const space = snapshot.spaces.find((item) => item.id === agent.spaceId && !item.archived)
  if (!space) return null
  const { slot } = useLocalExecutionSlot.getState().resolveAgentSlot(agent.id, {
    runtimeKind: agent.runtimeKind,
    workingDirectory: agent.workingDirectory
  })
  const skills = agent.skillIds
    .map((id) => snapshot.skills.find((skill) => skill.id === id))
    .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
    .map((skill) => ({ id: skill.id, name: skill.name, content: skill.content }))
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    spaceId: space.id,
    spaceName: space.name,
    spaceKey: space.key,
    instructions: agent.instructions,
    skills,
    repositories: agent.repositories,
    runtimeKind: slot.runtimeKind,
    preferredModel: slot.model,
    approvalPolicy: slot.approvalPolicy,
    workingDirectory: slot.workingDirectory
  }
}

export function listChatEligibleAgents(snapshot: CruxSnapshot | null): Array<{ agent: CruxAgent; spaceName: string; spaceKey: string }> {
  if (!snapshot) return []
  const spaceMap = new Map(snapshot.spaces.filter((space) => !space.archived).map((space) => [space.id, space]))
  return snapshot.agents
    .filter((agent) => !agent.archived && agent.enabled && !agent.exclusiveCrewId && spaceMap.has(agent.spaceId))
    .map((agent) => {
      const space = spaceMap.get(agent.spaceId)!
      return { agent, spaceName: space.name, spaceKey: space.key }
    })
}

/** 构造首轮发往真实 Runtime 的岗位指令与技能前缀；保留对话气泡为用户的原始提问。 */
export function formatAgentWirePrefix(context: ConversationAgentContext): string {
  const lines: string[] = [
    `[Agent 岗位上下文]`,
    `名称：${context.name}`,
    `所属空间：${context.spaceName} (${context.spaceKey})`,
    context.description ? `职责描述：${context.description}` : '',
    '',
    '### 岗位工作指令',
    context.instructions.trim()
  ].filter((line, index, arr) => line !== '' || (index > 0 && arr[index - 1] !== ''))

  if (context.skills.length > 0) {
    lines.push('', '### 绑定技能规范')
    for (const skill of context.skills) {
      lines.push(`#### ${skill.name}`, skill.content.trim().slice(0, 4000))
    }
  }
  if (context.repositories.length > 0) {
    lines.push('', `### 关联代码库：${context.repositories.map((repo) => repo.name).join('、')}`)
  }
  lines.push('', '---', '以下是用户本轮请求，请严格按上述岗位指令和技能规范执行与回复：', '')
  return lines.join('\n')
}

/** 根据 Agent 本机执行槽指定的 Runtime 与模型偏好，从真实可用模型目录中自动匹配最佳实例。 */
export function matchCatalogModelForRuntime(
  catalog: ConversationModelCatalog,
  runtimeKind: CruxRuntimeKind,
  preferredModel: string
): ComposerModel | null {
  if (catalog.models.length === 0) return null
  const matchesKind = (instanceId: string): boolean => {
    const instance = catalog.instances.find((item) => item.instanceId === instanceId)
    const token = `${instance?.driverKind ?? ''} ${instanceId}`.toLowerCase()
    if (runtimeKind === 'codex') return token.includes('codex')
    if (runtimeKind === 'claude-code') return token.includes('claude')
    return token.includes('pi') || (!token.includes('codex') && !token.includes('claude'))
  }
  const byRuntime = catalog.models.filter((model) => matchesKind(model.instanceId))
  const pool = byRuntime.length > 0 ? byRuntime : catalog.models
  if (preferredModel && preferredModel !== 'follow-runtime') {
    const exact = pool.find((model) => model.id.toLowerCase() === preferredModel.toLowerCase() || model.displayName.toLowerCase().includes(preferredModel.toLowerCase()))
    if (exact) return { instanceId: exact.instanceId, id: exact.id, displayName: exact.displayName }
  }
  const first = pool[0]
  return first ? { instanceId: first.instanceId, id: first.id, displayName: first.displayName } : null
}
