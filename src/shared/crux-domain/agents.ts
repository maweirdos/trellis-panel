/** Agent、技能与小队配置；执行保持在 Runtime 边界之外。 */
import { z } from 'zod'
import type {
  CruxAgent, CruxAgentInput, CruxCrew, CruxCrewInput,
  CruxCrewMemberRef, CruxID, CruxSnapshot
} from '../crux'
import { mutate, nextId, nowIso } from './store'
import { cruxCrewInputSchema } from '../crux-schema'
import { refreshTaskDispatch } from './planning'

export class CruxError extends Error {}

function fail(message: string): never {
  throw new CruxError(message)
}

const idSchema = z.string().min(1)
const agentInputSchema = z.object({
  id: idSchema.optional(), spaceId: idSchema,
  name: z.string().trim().min(1, 'Agent 名称不能为空'),
  description: z.string().optional(),
  instructions: z.string().trim().min(1, 'Agent 指令不能为空'),
  skillIds: z.array(idSchema).optional(),
  repositories: z.array(z.object({ name: z.string().trim().min(1), url: z.string().optional() })).optional(),
  runtimeKind: z.enum(['claude-code', 'codex', 'custom']).optional(),
  workingDirectory: z.enum(['repo', 'temp']).optional(),
  enabled: z.boolean().optional(), archived: z.boolean().optional()
})
const skillInputSchema = z.object({
  id: idSchema.optional(), spaceId: idSchema.optional(),
  name: z.string().trim().min(1, '技能名称不能为空'), description: z.string().optional(),
  content: z.string().trim().min(1, '技能内容不能为空')
})

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) fail(result.error.issues[0]?.message ?? '参数无效')
  return result.data
}

/** 归档/停用保留任务的历史执行者，只停止等待派发并关闭自动化。 */
function stopAssignments(draft: CruxSnapshot, kind: 'agent' | 'crew', id: CruxID): void {
  for (const task of draft.tasks) {
    if (task.executor?.kind === kind && task.executor.id === id) task.dispatch = undefined
  }
  for (const rule of draft.automations) {
    if (rule.target.kind === kind && rule.target.id === id) rule.enabled = false
  }
}

function refreshAgentCrews(draft: CruxSnapshot, agentId: CruxID): void {
  const crews = new Set(draft.crews.filter((crew) => crew.members.some((member) => member.kind === 'agent' && member.id === agentId)).map((crew) => crew.id))
  for (const task of draft.tasks) if (task.executor?.kind === 'crew' && crews.has(task.executor.id)) refreshTaskDispatch(draft, task, '小队 Agent 配置更新')
}

function requireReplaceCaptain(draft: CruxSnapshot, id: CruxID): void {
  const crew = draft.crews.find((item) => !item.archived && item.captain.kind === 'agent' && item.captain.id === id)
  if (crew) fail(`请先更换「${crew.name}」的队长或归档小队`)
}

function syncExecutorName(draft: CruxSnapshot, kind: 'agent' | 'crew', id: CruxID, name: string): void {
  for (const task of draft.tasks) {
    if (task.executor?.kind === kind && task.executor.id === id) task.executor.name = name
  }
  for (const rule of draft.automations) {
    if (rule.target.kind === kind && rule.target.id === id) rule.target.name = name
  }
}

export function saveAgent(raw: CruxAgentInput & { id?: CruxID }): CruxSnapshot {
  const input = parse(agentInputSchema, raw)
  return mutate((draft) => {
    if (!draft.spaces.some((space) => space.id === input.spaceId)) fail('空间不存在')
    const existing = input.id ? draft.agents.find((agent) => agent.id === input.id) ?? fail('Agent 不存在') : undefined
    if (existing && existing.spaceId !== input.spaceId) fail('不能更改 Agent 所属空间')
    if (draft.agents.some((agent) => agent.spaceId === input.spaceId && agent.name === input.name && agent.id !== input.id)) {
      fail('该空间已存在同名 Agent')
    }
    const skillIds = [...new Set(input.skillIds ?? existing?.skillIds ?? [])]
    for (const id of skillIds) {
      const skill = draft.skills.find((item) => item.id === id) ?? fail('技能不存在')
      if (skill.spaceId && skill.spaceId !== input.spaceId) fail('不能绑定其他空间的技能')
    }
    const enabled = input.enabled ?? existing?.enabled ?? true
    const archived = input.archived ?? existing?.archived ?? false
    if (existing && (!enabled || archived)) requireReplaceCaptain(draft, existing.id)
    const agent: CruxAgent = {
      id: existing?.id ?? nextId('ag'), spaceId: input.spaceId,
      name: input.name, description: input.description?.trim() || undefined,
      instructions: input.instructions, skillIds,
      repositories: input.repositories ?? existing?.repositories ?? [],
      runtimeKind: input.runtimeKind ?? existing?.runtimeKind ?? 'claude-code',
      workingDirectory: input.workingDirectory ?? existing?.workingDirectory ?? 'repo',
      enabled, archived, exclusiveCrewId: existing?.exclusiveCrewId,
      createdAt: existing?.createdAt ?? nowIso()
    }
    if (existing) Object.assign(existing, agent)
    else draft.agents.push(agent)
    if (!enabled || archived) stopAssignments(draft, 'agent', agent.id)
    syncExecutorName(draft, 'agent', agent.id, agent.name)
    for (const crew of draft.crews) {
      if (crew.captain.kind === 'agent' && crew.captain.id === agent.id) crew.captain.name = agent.name
      for (const ref of crew.members) if (ref.kind === 'agent' && ref.id === agent.id) ref.name = agent.name
    }
    refreshAgentCrews(draft, agent.id)
  }).snapshot
}

/** 保留 API 名称以兼容 preload；移除操作执行可恢复归档。 */
export function removeAgent(raw: { id: CruxID }): CruxSnapshot {
  const input = parse(z.object({ id: idSchema }), raw)
  return mutate((draft) => {
    const agent = draft.agents.find((item) => item.id === input.id) ?? fail('Agent 不存在')
    requireReplaceCaptain(draft, agent.id)
    agent.archived = true
    stopAssignments(draft, 'agent', agent.id)
    refreshAgentCrews(draft, agent.id)
  }).snapshot
}

export function saveSkill(raw: { id?: CruxID; name: string; description?: string; content: string; spaceId?: CruxID }): CruxSnapshot {
  const input = parse(skillInputSchema, raw)
  return mutate((draft) => {
    const existing = input.id ? draft.skills.find((skill) => skill.id === input.id) ?? fail('技能不存在') : undefined
    const spaceId = input.spaceId ?? existing?.spaceId
    if (spaceId && !draft.spaces.some((space) => space.id === spaceId)) fail('空间不存在')
    if (existing && input.spaceId && existing.spaceId !== input.spaceId) fail('不能更改技能所属范围')
    if (draft.skills.some((skill) => skill.spaceId === spaceId && skill.name === input.name && skill.id !== input.id)) fail('同名技能已存在')
    const skill = {
      id: existing?.id ?? nextId('sk'), spaceId, name: input.name,
      description: input.description?.trim() || undefined, content: input.content,
      createdAt: existing?.createdAt ?? nowIso()
    }
    if (existing) Object.assign(existing, skill)
    else draft.skills.push(skill)
  }).snapshot
}

export function removeSkill(raw: { id: CruxID }): CruxSnapshot {
  const input = parse(z.object({ id: idSchema }), raw)
  return mutate((draft) => {
    if (!draft.skills.some((skill) => skill.id === input.id)) fail('技能不存在')
    for (const agent of draft.agents) agent.skillIds = agent.skillIds.filter((id) => id !== input.id)
    draft.skills = draft.skills.filter((skill) => skill.id !== input.id)
  }).snapshot
}

export function saveCrew(raw: CruxCrewInput): CruxSnapshot {
  const input = parse(cruxCrewInputSchema, raw)
  return mutate((draft) => {
    const space = draft.spaces.find((item) => item.id === input.spaceId) ?? fail('空间不存在')
    const existing = input.id ? draft.crews.find((crew) => crew.id === input.id) ?? fail('小队不存在') : undefined
    if (existing && existing.spaceId !== input.spaceId) fail('不能更改小队所属空间')
    if (draft.crews.some((crew) => crew.spaceId === input.spaceId && crew.name === input.name && crew.id !== input.id)) fail('该空间已存在同名小队')
    let captain: CruxCrewMemberRef
    if (input.captainAgentId) {
      const agent = draft.agents.find((item) => item.id === input.captainAgentId && item.spaceId === space.id)
      if (!agent || !agent.enabled || agent.archived) fail('队长必须是本空间已启用且未归档的 Agent')
      if (agent.exclusiveCrewId && agent.exclusiveCrewId !== existing?.id) fail('队长已是其他小队专属 Agent')
      captain = { kind: 'agent', id: agent.id, name: agent.name }
    } else {
      const member = draft.members.find((item) => item.id === input.captainMemberId)
      if (!member || !space.memberIds.includes(member.id)) fail('队长必须是本空间成员')
      captain = { kind: 'member', id: member.id, name: member.name }
    }
    const ownerId = input.ownerId === null ? undefined : input.ownerId ?? existing?.ownerId
    if (ownerId && (!space.memberIds.includes(ownerId) || !draft.members.some((member) => member.id === ownerId))) fail('小队负责人必须是本空间成员')
    const members: CruxCrewMemberRef[] = [{ ...captain }]
    const seen = new Set([`${captain.kind}:${captain.id}`])
    for (const ref of input.memberRefs) {
      const key = `${ref.kind}:${ref.id}`
      if (seen.has(key)) continue
      const retained = existing?.members.some((member) => member.kind === ref.kind && member.id === ref.id)
      if (ref.kind === 'agent') {
        const agent = draft.agents.find((item) => item.id === ref.id && item.spaceId === space.id)
        if (!agent) fail('小队成员 Agent 不在该空间内')
        if ((!agent.enabled || agent.archived) && !retained) fail('不能添加停用或已归档的 Agent')
        if (agent.exclusiveCrewId && agent.exclusiveCrewId !== existing?.id) fail('Agent 已是其他小队专属成员')
        members.push({ kind: 'agent', id: agent.id, name: agent.name })
      } else {
        const member = draft.members.find((item) => item.id === ref.id)
        if (!member || !space.memberIds.includes(ref.id)) fail('小队人员必须是本空间成员')
        members.push({ kind: 'member', id: member.id, name: member.name })
      }
      seen.add(key)
    }
    const priorExclusiveIds = existing ? draft.agents.filter((agent) => agent.exclusiveCrewId === existing.id && !(captain.kind === 'agent' && agent.id === captain.id) &&
      members.some((ref) => ref.kind === 'agent' && ref.id === agent.id)).map((agent) => agent.id) : []
    const exclusiveIds = new Set(input.exclusiveAgentIds ?? priorExclusiveIds)
    for (const id of exclusiveIds) {
      if (captain.kind === 'agent' && id === captain.id) fail('当前队长不能设为小队专属成员')
      if (!members.some((ref) => ref.kind === 'agent' && ref.id === id)) fail('小队专属 Agent 必须在成员名册中')
      if (draft.crews.some((crew) => crew.id !== existing?.id && ((crew.captain.kind === 'agent' && crew.captain.id === id) || crew.members.some((ref) => ref.kind === 'agent' && ref.id === id)))) {
        fail('该 Agent 还在其他小队，请先将它移出')
      }
    }
    const crew: CruxCrew = {
      id: existing?.id ?? nextId('cr'), spaceId: space.id, name: input.name,
      description: input.description?.trim() || undefined,
      instructions: input.instructions === undefined ? existing?.instructions : input.instructions.trim() || undefined,
      ownerId, archived: input.archived ?? existing?.archived ?? false,
      captain, members,
      createdAt: existing?.createdAt ?? nowIso()
    }
    if (existing) Object.assign(existing, crew)
    else draft.crews.push(crew)
    for (const agent of draft.agents) {
      if (exclusiveIds.has(agent.id)) {
        agent.exclusiveCrewId = crew.id
        stopAssignments(draft, 'agent', agent.id)
      } else if (agent.exclusiveCrewId === crew.id) agent.exclusiveCrewId = undefined
    }
    if (crew.archived) stopAssignments(draft, 'crew', crew.id)
    syncExecutorName(draft, 'crew', crew.id, crew.name)
    for (const task of draft.tasks) if (task.executor?.kind === 'crew' && task.executor.id === crew.id) refreshTaskDispatch(draft, task, '小队配置更新')
  }).snapshot
}

export function removeCrew(raw: { id: CruxID }): CruxSnapshot {
  const input = parse(z.object({ id: idSchema }), raw)
  return mutate((draft) => {
    const crew = draft.crews.find((item) => item.id === input.id) ?? fail('小队不存在')
    crew.archived = true
    stopAssignments(draft, 'crew', crew.id)
  }).snapshot
}
