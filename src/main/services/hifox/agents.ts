/**
 * HiFox Agent 域服务：Agent、技能、小队（配置层）。
 * 业务规则来源：docs/prd-hifox 2.1 / 2.9 / 2.10。
 * Runtime 边界：runtimeKind / workingDirectory 仅是配置引用，不建立连接、不执行；
 * 执行链路由 runtime 模块接入后打通（当前派发止步于「等待 Runtime」）。
 */
import type {
  HifoxAgent,
  HifoxAgentInput,
  HifoxCrew,
  HifoxCrewMemberRef,
  HifoxID,
  HifoxRuntimeKind,
  HifoxSkill,
  HifoxSnapshot
} from '../../../shared/hifox'
import { mutate, nextId, nowIso } from './store'

export class HifoxError extends Error {}

function fail(message: string): never {
  throw new HifoxError(message)
}

const RUNTIME_KINDS: HifoxRuntimeKind[] = ['claude-code', 'codex', 'custom']

/* ---------------- Agent（PRD 2.1） ---------------- */

export function saveAgent(input: HifoxAgentInput & { id?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.spaces.some((s) => s.id === input.spaceId)) fail('空间不存在')
    if (!input.name.trim()) fail('Agent 名称不能为空')
    if (!input.instructions.trim()) fail('Agent 指令不能为空')
    const skillIds = [...new Set(input.skillIds ?? [])]
    for (const id of skillIds) {
      if (!draft.skills.some((s) => s.id === id)) fail(`技能 ${id} 不存在`)
    }
    const runtimeKind = input.runtimeKind ?? 'claude-code'
    if (!RUNTIME_KINDS.includes(runtimeKind)) fail('不支持的 Runtime 类型')
    const duplicate = draft.agents.find((a) => a.spaceId === input.spaceId && a.name === input.name.trim() && a.id !== input.id)
    if (duplicate) fail('该空间已存在同名 Agent')

    if (input.id) {
      const agent = draft.agents.find((a) => a.id === input.id) ?? fail('Agent 不存在')
      agent.name = input.name.trim()
      agent.description = input.description?.trim() || undefined
      agent.instructions = input.instructions.trim()
      agent.skillIds = skillIds
      agent.repositories = [...(input.repositories ?? [])]
      agent.runtimeKind = runtimeKind
      agent.workingDirectory = input.workingDirectory ?? agent.workingDirectory
      const wasEnabled = agent.enabled
      agent.enabled = input.enabled ?? true
      // 停用后不允许继续承接：清空以其为执行槽的任务（PRD 2.1 启停语义）
      if (wasEnabled && !agent.enabled) {
        for (const task of draft.tasks) {
          if (task.executor?.kind === 'agent' && task.executor.id === agent.id) {
            task.executor = undefined
            task.dispatch = undefined
          }
        }
        for (const crew of draft.crews) {
          crew.members = crew.members.filter((ref) => !(ref.kind === 'agent' && ref.id === agent.id))
        }
      }
      // 名称同步到既有引用
      for (const task of draft.tasks) {
        if (task.executor?.kind === 'agent' && task.executor.id === agent.id) task.executor.name = agent.name
      }
      for (const crew of draft.crews) {
        if (crew.captain.id === agent.id) crew.captain.name = agent.name
        for (const ref of crew.members) if (ref.kind === 'agent' && ref.id === agent.id) ref.name = agent.name
      }
      return agent.id
    }

    const agent: HifoxAgent = {
      id: nextId('ag'),
      spaceId: input.spaceId,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      instructions: input.instructions.trim(),
      skillIds,
      repositories: [...(input.repositories ?? [])],
      runtimeKind,
      workingDirectory: input.workingDirectory ?? 'repo',
      enabled: input.enabled ?? true,
      createdAt: nowIso()
    }
    draft.agents.push(agent)
    return agent.id
  }).snapshot
}

export function removeAgent(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const agent = draft.agents.find((a) => a.id === input.id) ?? fail('Agent 不存在')
    for (const task of draft.tasks) {
      if (task.executor?.kind === 'agent' && task.executor.id === agent.id) {
        task.executor = undefined
        task.dispatch = undefined
      }
    }
    for (const crew of draft.crews) {
      crew.members = crew.members.filter((ref) => !(ref.kind === 'agent' && ref.id === agent.id))
    }
    draft.crews = draft.crews.filter((c) => c.captain.id !== agent.id)
    for (const automation of draft.automations) {
      if (automation.target.kind === 'agent' && automation.target.id === agent.id) {
        automation.target = { kind: 'none' }
        automation.enabled = false
      }
    }
    draft.agents = draft.agents.filter((a) => a.id !== input.id)
    return undefined
  }).snapshot
}

/* ---------------- 技能（PRD 2.9） ---------------- */

export function saveSkill(input: { id?: HifoxID; name: string; description?: string; content: string; spaceId?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    if (!input.name.trim()) fail('技能名称不能为空')
    if (!input.content.trim()) fail('技能内容不能为空')
    if (draft.skills.some((s) => s.name === input.name.trim() && s.id !== input.id)) fail('同名技能已存在')
    if (input.id) {
      const skill = draft.skills.find((s) => s.id === input.id) ?? fail('技能不存在')
      skill.name = input.name.trim()
      skill.description = input.description?.trim() || undefined
      skill.content = input.content.trim()
      return skill.id
    }
    const skill: HifoxSkill = {
      id: nextId('sk'),
      spaceId: input.spaceId,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      content: input.content.trim(),
      createdAt: nowIso()
    }
    draft.skills.push(skill)
    return skill.id
  }).snapshot
}

export function removeSkill(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const skill = draft.skills.find((s) => s.id === input.id) ?? fail('技能不存在')
    for (const agent of draft.agents) {
      agent.skillIds = agent.skillIds.filter((id) => id !== skill.id)
    }
    draft.skills = draft.skills.filter((s) => s.id !== skill.id)
    return undefined
  }).snapshot
}

/* ---------------- 小队（PRD 2.10） ---------------- */

export function saveCrew(input: { id?: HifoxID; spaceId: HifoxID; name: string; description?: string; captainAgentId: HifoxID; memberRefs: Array<{ kind: 'agent' | 'member'; id: HifoxID }> }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.spaces.some((s) => s.id === input.spaceId)) fail('空间不存在')
    if (!input.name.trim()) fail('小队名称不能为空')
    const captainAgent = draft.agents.find((a) => a.id === input.captainAgentId && a.spaceId === input.spaceId)
    if (!captainAgent) fail('队长必须是本空间的 Agent')
    const members: HifoxCrewMemberRef[] = []
    const seen = new Set<string>()
    // 队长也是成员，但不重复登记
    seen.add(`agent:${captainAgent.id}`)
    for (const ref of input.memberRefs) {
      const key = `${ref.kind}:${ref.id}`
      if (seen.has(key)) continue
      if (ref.kind === 'agent') {
        const agent = draft.agents.find((a) => a.id === ref.id && a.spaceId === input.spaceId)
        if (!agent) fail('小队成员 Agent 不在该空间内')
        members.push({ kind: 'agent', id: agent.id, name: agent.name })
      } else {
        const member = draft.members.find((m) => m.id === ref.id)
        if (!member) fail('小队成员不存在')
        members.push({ kind: 'member', id: member.id, name: member.name })
      }
      seen.add(key)
    }
    if (input.id) {
      const crew = draft.crews.find((c) => c.id === input.id) ?? fail('小队不存在')
      crew.name = input.name.trim()
      crew.description = input.description?.trim() || undefined
      crew.captain = { kind: 'agent', id: captainAgent.id, name: captainAgent.name }
      crew.members = members
      for (const task of draft.tasks) {
        if (task.executor?.kind === 'crew' && task.executor.id === crew.id) task.executor.name = crew.name
      }
      return crew.id
    }
    const crew: HifoxCrew = {
      id: nextId('cr'),
      spaceId: input.spaceId,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      captain: { kind: 'agent', id: captainAgent.id, name: captainAgent.name },
      members,
      createdAt: nowIso()
    }
    draft.crews.push(crew)
    return crew.id
  }).snapshot
}

export function removeCrew(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const crew = draft.crews.find((c) => c.id === input.id) ?? fail('小队不存在')
    for (const task of draft.tasks) {
      if (task.executor?.kind === 'crew' && task.executor.id === crew.id) {
        task.executor = undefined
        task.dispatch = undefined
      }
    }
    for (const automation of draft.automations) {
      if (automation.target.kind === 'crew' && automation.target.id === crew.id) {
        automation.target = { kind: 'none' }
        automation.enabled = false
      }
    }
    draft.crews = draft.crews.filter((c) => c.id !== input.id)
    return undefined
  }).snapshot
}
