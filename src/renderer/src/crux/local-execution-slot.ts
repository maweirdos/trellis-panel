import { create } from 'zustand'
import type { CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'

export type LocalApprovalPolicy = 'follow-runtime' | 'on-request' | 'unless-trusted' | 'never' | 'auto-edit' | 'bypass'

export interface LocalExecutionSlot {
  runtimeKind: CruxRuntimeKind
  model: string
  approvalPolicy: LocalApprovalPolicy
  workingDirectory: CruxWorkingDirectoryMode
  localWorkdirPath: string
}

const STORAGE_KEY = 'crux.local.execution-slot.v1'

export const RUNTIME_KIND_OPTIONS: ReadonlyArray<{ value: CruxRuntimeKind; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'custom', label: '自定义' }
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
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { defaultSlot: { ...DEFAULT_SLOT }, agentOverrides: {} }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const runtime = parsed.defaultSlot?.runtimeKind
    const runtimeKind: CruxRuntimeKind = runtime === 'claude-code' || runtime === 'custom' || runtime === 'codex' ? runtime : DEFAULT_SLOT.runtimeKind
    const rawApproval = parsed.defaultSlot?.approvalPolicy ?? 'follow-runtime'
    const normalized = resetIncompatibleApprovalForRuntime(runtimeKind, rawApproval)
    return {
      defaultSlot: {
        runtimeKind,
        model: typeof parsed.defaultSlot?.model === 'string' && parsed.defaultSlot.model ? parsed.defaultSlot.model : DEFAULT_SLOT.model,
        approvalPolicy: normalized.approval,
        workingDirectory: parsed.defaultSlot?.workingDirectory === 'repo' ? 'repo' : 'temp',
        localWorkdirPath: typeof parsed.defaultSlot?.localWorkdirPath === 'string' ? parsed.defaultSlot.localWorkdirPath : ''
      },
      agentOverrides: parsed.agentOverrides && typeof parsed.agentOverrides === 'object' ? parsed.agentOverrides : {}
    }
  } catch {
    return { defaultSlot: { ...DEFAULT_SLOT }, agentOverrides: {} }
  }
}

function persistState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ defaultSlot: state.defaultSlot, agentOverrides: state.agentOverrides }))
  } catch {
    // Ignore storage quota errors in restricted preview sessions.
  }
}

interface LocalExecutionSlotStore extends PersistedState {
  conflictNotice: string | null
  clearConflictNotice: () => void
  setDefaultSlot: (patch: Partial<LocalExecutionSlot>) => void
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
  conflictNotice: null,
  clearConflictNotice: () => set({ conflictNotice: null }),
  setDefaultSlot: (patch) => {
    const prev = get().defaultSlot
    const nextRuntime = patch.runtimeKind ?? prev.runtimeKind
    const nextApproval = patch.approvalPolicy ?? prev.approvalPolicy
    const checked = resetIncompatibleApprovalForRuntime(nextRuntime, nextApproval)
    const next: LocalExecutionSlot = {
      ...prev,
      ...patch,
      runtimeKind: nextRuntime,
      approvalPolicy: checked.approval
    }
    const notice = checked.cleared
      ? `切换至 ${runtimeKindLabel(nextRuntime)} 后，已自动清除不兼容的审批策略并恢复为「跟随 Runtime 默认」，避免启动冲突。`
      : null
    set({ defaultSlot: next, conflictNotice: notice })
    persistState({ defaultSlot: next, agentOverrides: get().agentOverrides })
  },
  setAgentOverride: (agentId, patch) => {
    const state = get()
    const currentOverride = state.agentOverrides[agentId] ?? {}
    const mergedBase = { ...state.defaultSlot, ...currentOverride }
    const nextRuntime = patch.runtimeKind ?? mergedBase.runtimeKind
    const nextApproval = patch.approvalPolicy ?? mergedBase.approvalPolicy
    const checked = resetIncompatibleApprovalForRuntime(nextRuntime, nextApproval)
    const updatedOverride: Partial<LocalExecutionSlot> = {
      ...currentOverride,
      ...patch,
      runtimeKind: nextRuntime,
      approvalPolicy: checked.approval
    }
    const agentOverrides = { ...state.agentOverrides, [agentId]: updatedOverride }
    const notice = checked.cleared
      ? `切换至 ${runtimeKindLabel(nextRuntime)} 后，已自动清理该岗位不兼容的本机审批策略，防止 409 运行冲突。`
      : null
    set({ agentOverrides, conflictNotice: notice })
    persistState({ defaultSlot: state.defaultSlot, agentOverrides })
  },
  clearAgentOverride: (agentId) => {
    const state = get()
    if (!Object.hasOwn(state.agentOverrides, agentId)) return
    const nextOverrides = { ...state.agentOverrides }
    delete nextOverrides[agentId]
    set({ agentOverrides: nextOverrides, conflictNotice: null })
    persistState({ defaultSlot: state.defaultSlot, agentOverrides: nextOverrides })
  },
  resolveAgentSlot: (agentId) => {
    const state = get()
    const override = state.agentOverrides[agentId]
    if (!override) return { slot: state.defaultSlot, overridden: false }
    const runtimeKind = override.runtimeKind ?? state.defaultSlot.runtimeKind
    const rawApproval = override.approvalPolicy ?? state.defaultSlot.approvalPolicy
    const normalized = resetIncompatibleApprovalForRuntime(runtimeKind, rawApproval)
    return {
      slot: {
        ...state.defaultSlot,
        ...override,
        runtimeKind,
        approvalPolicy: normalized.approval
      },
      overridden: true
    }
  }
}))
