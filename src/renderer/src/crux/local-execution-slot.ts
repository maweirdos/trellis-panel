import { create } from 'zustand'
import type { CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'
import type { AcpAgentStatus } from '../../../shared/types'

export type LocalApprovalPolicy = 'follow-runtime' | 'on-request' | 'unless-trusted' | 'never' | 'auto-edit' | 'bypass'
export type MachineVisibilityScope = 'personal' | 'spaces' | 'organization'

export interface LocalExecutionSlot {
  runtimeKind: CruxRuntimeKind
  model: string
  approvalPolicy: LocalApprovalPolicy
  workingDirectory: CruxWorkingDirectoryMode
  localWorkdirPath: string
}

const STORAGE_KEY = 'crux.local.execution-slot.v2'

export const RUNTIME_KIND_OPTIONS: ReadonlyArray<{ value: CruxRuntimeKind; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'custom', label: '本机托管 / Pi' }
]

export const MODEL_PRESET_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'follow-runtime', label: '跟随 Runtime 默认模型' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'o3', label: 'o3' }
]

export const WORKDIR_MODE_OPTIONS: ReadonlyArray<{ value: CruxWorkingDirectoryMode; label: string }> = [
  { value: 'repo', label: '绑定本机项目目录' },
  { value: 'temp', label: '托管临时目录 (workdir)' }
]

export const MACHINE_VISIBILITY_OPTIONS: ReadonlyArray<{ value: MachineVisibilityScope; label: string; description: string }> = [
  { value: 'personal', label: '仅我个人独享', description: '仅响应我自己发起的对话与任务，不向其他成员暴露本机算力。' },
  { value: 'spaces', label: '指定空间可用', description: '允许选定空间内的协作任务调用本机已就绪的 Runtime。' },
  { value: 'organization', label: '全组织共享', description: '当前组织内具备权限的空间均可调度本机已启用的 Runtime。' }
]

export const APPROVAL_OPTIONS_BY_RUNTIME: Record<CruxRuntimeKind, ReadonlyArray<{ value: LocalApprovalPolicy; label: string }>> = {
  codex: [
    { value: 'follow-runtime', label: '跟随 Runtime 默认' },
    { value: 'on-request', label: '高危动作前询问 (on-request)' },
    { value: 'unless-trusted', label: '仅受信命令自动执行 (unless-trusted)' },
    { value: 'never', label: '全自动免询问 (never)' }
  ],
  'claude-code': [
    { value: 'follow-runtime', label: '跟随 Runtime 默认' },
    { value: 'auto-edit', label: '允许自动改写文件 (auto-edit)' },
    { value: 'on-request', label: '每次命令需确认 (on-request)' },
    { value: 'bypass', label: '跳过确认提示 (bypass)' }
  ],
  custom: [
    { value: 'follow-runtime', label: '跟随 Runtime 默认' },
    { value: 'on-request', label: '命令执行前询问' },
    { value: 'never', label: '直接执行' }
  ]
}

const DEFAULT_SLOT: LocalExecutionSlot = {
  runtimeKind: 'codex',
  model: 'follow-runtime',
  approvalPolicy: 'follow-runtime',
  workingDirectory: 'temp',
  localWorkdirPath: ''
}

export function runtimeKindLabel(kind: CruxRuntimeKind): string {
  return RUNTIME_KIND_OPTIONS.find((item) => item.value === kind)?.label ?? kind
}

/** 将 CruxRuntimeKind 映射到真实的本机 AcpAgentStatus 记录。 */
export function matchDetectedRuntime(agents: readonly AcpAgentStatus[], kind: CruxRuntimeKind): AcpAgentStatus | undefined {
  const active = agents.filter((agent) => agent.launchKind !== 'custom' && agent.id !== 'opencode')
  if (kind === 'codex') {
    return active.find((agent) => (agent.runtimeId ?? agent.id).toLowerCase().includes('codex'))
  }
  if (kind === 'claude-code') {
    return active.find((agent) => (agent.runtimeId ?? agent.id).toLowerCase().includes('claude'))
  }
  return active.find((agent) => (agent.runtimeId ?? agent.id).toLowerCase().includes('pi')) ?? active[0]
}

export function resetIncompatibleApprovalForRuntime(
  runtime: CruxRuntimeKind,
  approval: LocalApprovalPolicy
): { approval: LocalApprovalPolicy; cleared: boolean } {
  const valid = APPROVAL_OPTIONS_BY_RUNTIME[runtime].some((item) => item.value === approval)
  return valid ? { approval, cleared: false } : { approval: 'follow-runtime', cleared: true }
}

interface PersistedState {
  defaultSlot: LocalExecutionSlot
  agentOverrides: Record<string, Partial<LocalExecutionSlot>>
  machineVisibility: MachineVisibilityScope
  allowedSpaceIds: string[]
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('crux.local.execution-slot.v1')
    if (!raw) return { defaultSlot: { ...DEFAULT_SLOT }, agentOverrides: {}, machineVisibility: 'personal', allowedSpaceIds: [] }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const runtime = parsed.defaultSlot?.runtimeKind
    const runtimeKind: CruxRuntimeKind = runtime === 'claude-code' || runtime === 'custom' || runtime === 'codex' ? runtime : DEFAULT_SLOT.runtimeKind
    const rawApproval = parsed.defaultSlot?.approvalPolicy ?? 'follow-runtime'
    const normalized = resetIncompatibleApprovalForRuntime(runtimeKind, rawApproval)
    const visibility = parsed.machineVisibility === 'spaces' || parsed.machineVisibility === 'organization' ? parsed.machineVisibility : 'personal'
    return {
      defaultSlot: {
        runtimeKind,
        model: typeof parsed.defaultSlot?.model === 'string' && parsed.defaultSlot.model ? parsed.defaultSlot.model : DEFAULT_SLOT.model,
        approvalPolicy: normalized.approval,
        workingDirectory: parsed.defaultSlot?.workingDirectory === 'repo' ? 'repo' : 'temp',
        localWorkdirPath: typeof parsed.defaultSlot?.localWorkdirPath === 'string' ? parsed.defaultSlot.localWorkdirPath : ''
      },
      agentOverrides: parsed.agentOverrides && typeof parsed.agentOverrides === 'object' ? parsed.agentOverrides : {},
      machineVisibility: visibility,
      allowedSpaceIds: Array.isArray(parsed.allowedSpaceIds) ? parsed.allowedSpaceIds.filter((id): id is string => typeof id === 'string') : []
    }
  } catch {
    return { defaultSlot: { ...DEFAULT_SLOT }, agentOverrides: {}, machineVisibility: 'personal', allowedSpaceIds: [] }
  }
}

function persistState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      defaultSlot: state.defaultSlot,
      agentOverrides: state.agentOverrides,
      machineVisibility: state.machineVisibility,
      allowedSpaceIds: state.allowedSpaceIds
    }))
  } catch {
    // 隐私模式下忽略本地存储受限错误。
  }
}

interface LocalExecutionSlotStore extends PersistedState {
  conflictNotice: string | null
  clearConflictNotice: () => void
  setDefaultSlot: (patch: Partial<LocalExecutionSlot>) => void
  setMachineVisibility: (visibility: MachineVisibilityScope, allowedSpaceIds?: string[]) => void
  setAgentOverride: (agentId: string, patch: Partial<LocalExecutionSlot>) => void
  clearAgentOverride: (agentId: string) => void
  resolveAgentSlot: (agentId: string, sharedFallback?: { runtimeKind?: CruxRuntimeKind; workingDirectory?: CruxWorkingDirectoryMode }) => {
    slot: LocalExecutionSlot
    overridden: boolean
  }
}

const initial = loadState()

export const useLocalExecutionSlot = create<LocalExecutionSlotStore>()((set, get) => ({
  defaultSlot: initial.defaultSlot,
  agentOverrides: initial.agentOverrides,
  machineVisibility: initial.machineVisibility,
  allowedSpaceIds: initial.allowedSpaceIds,
  conflictNotice: null,
  clearConflictNotice: () => set({ conflictNotice: null }),

  setDefaultSlot: (patch) => {
    const current = get().defaultSlot
    const nextRuntime = patch.runtimeKind ?? current.runtimeKind
    const nextApprovalCandidate = patch.approvalPolicy ?? current.approvalPolicy
    const checked = resetIncompatibleApprovalForRuntime(nextRuntime, nextApprovalCandidate)
    const nextSlot: LocalExecutionSlot = {
      ...current,
      ...patch,
      runtimeKind: nextRuntime,
      approvalPolicy: checked.approval
    }
    const nextState: PersistedState = {
      defaultSlot: nextSlot,
      agentOverrides: get().agentOverrides,
      machineVisibility: get().machineVisibility,
      allowedSpaceIds: get().allowedSpaceIds
    }
    persistState(nextState)
    set({
      defaultSlot: nextSlot,
      conflictNotice: checked.cleared ? `已切换默认 Runtime 为 ${runtimeKindLabel(nextRuntime)}，原不兼容审批策略已重置为「跟随 Runtime 默认」。` : null
    })
  },

  setMachineVisibility: (machineVisibility, nextSpaceIds) => {
    const allowedSpaceIds = nextSpaceIds ?? get().allowedSpaceIds
    const nextState: PersistedState = {
      defaultSlot: get().defaultSlot,
      agentOverrides: get().agentOverrides,
      machineVisibility,
      allowedSpaceIds
    }
    persistState(nextState)
    set({ machineVisibility, allowedSpaceIds })
  },

  setAgentOverride: (agentId, patch) => {
    const state = get()
    const base = { ...state.defaultSlot, ...(state.agentOverrides[agentId] ?? {}) }
    const nextRuntime = patch.runtimeKind ?? base.runtimeKind
    const checked = resetIncompatibleApprovalForRuntime(nextRuntime, patch.approvalPolicy ?? base.approvalPolicy)
    const nextOverrides = {
      ...state.agentOverrides,
      [agentId]: {
        ...state.agentOverrides[agentId],
        ...patch,
        runtimeKind: nextRuntime,
        approvalPolicy: checked.approval
      }
    }
    persistState({
      defaultSlot: state.defaultSlot,
      agentOverrides: nextOverrides,
      machineVisibility: state.machineVisibility,
      allowedSpaceIds: state.allowedSpaceIds
    })
    set({
      agentOverrides: nextOverrides,
      conflictNotice: checked.cleared ? `该 Agent 的本机 Runtime 已改为 ${runtimeKindLabel(nextRuntime)}，原不兼容审批策略已重置。` : null
    })
  },

  clearAgentOverride: (agentId) => {
    const state = get()
    const nextOverrides = { ...state.agentOverrides }
    delete nextOverrides[agentId]
    persistState({
      defaultSlot: state.defaultSlot,
      agentOverrides: nextOverrides,
      machineVisibility: state.machineVisibility,
      allowedSpaceIds: state.allowedSpaceIds
    })
    set({ agentOverrides: nextOverrides, conflictNotice: null })
  },

  resolveAgentSlot: (agentId, sharedFallback) => {
    const state = get()
    const override = state.agentOverrides[agentId]
    const overridden = Boolean(override && Object.keys(override).length > 0)
    const runtimeKind = override?.runtimeKind ?? state.defaultSlot.runtimeKind ?? sharedFallback?.runtimeKind ?? 'codex'
    const checked = resetIncompatibleApprovalForRuntime(runtimeKind, override?.approvalPolicy ?? state.defaultSlot.approvalPolicy)
    return {
      overridden,
      slot: {
        runtimeKind,
        model: override?.model ?? state.defaultSlot.model,
        approvalPolicy: checked.approval,
        workingDirectory: override?.workingDirectory ?? state.defaultSlot.workingDirectory ?? sharedFallback?.workingDirectory ?? 'temp',
        localWorkdirPath: override?.localWorkdirPath ?? state.defaultSlot.localWorkdirPath
      }
    }
  }
}))
