import { create } from 'zustand'
import type { CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'
import type { IsolationMode } from './collaboration-platform-store'

/** 对标 HiFox 7 态 Run 生命周期（index.1042a5a6bd.js task_status） */
export type TaskRunStatus =
  | 'queued'
  | 'dispatched'
  | 'waiting_local_directory'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 对标 HiFox Agent 实时工作状态（index.1042a5a6bd.js agent_state） */
export type AgentPresenceState = 'idle' | 'working' | 'blocked' | 'error' | 'offline'

export type RunFailureKind = 'agent_error' | 'timeout' | 'runtime_offline' | 'runtime_recovery' | 'manual'

export interface TaskRunLogEntry {
  at: string
  level: 'info' | 'warn' | 'error' | 'output'
  text: string
}

export interface TaskRunInteraction {
  id: string
  kind: 'confirm' | 'worktree_fallback' | 'input'
  title: string
  detail: string
  options?: string[]
  createdAt: string
  resolvedAt?: string
  answer?: string
}

export interface TaskRunRecord {
  id: string
  taskId: string
  spaceId: string
  executorKind: 'agent' | 'crew'
  executorId: string
  executorName: string
  runtimeKind: CruxRuntimeKind
  model: string
  workingDirectory: CruxWorkingDirectoryMode
  localWorkdirPath?: string
  isolationMode: IsolationMode
  status: TaskRunStatus
  triggerSource: 'delegate' | 'manual' | 'rerun' | 'ai-action'
  actionTitle?: string
  prompt: string
  priorityScore: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  logs: TaskRunLogEntry[]
  interaction?: TaskRunInteraction
  summary?: string
  failureKind?: RunFailureKind
  chatOpened?: boolean
}

export const RUN_STATUS_META: Record<TaskRunStatus, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' }> = {
  queued: { label: '排队中', tone: 'neutral' },
  dispatched: { label: '已派发', tone: 'info' },
  waiting_local_directory: { label: '等待工作目录', tone: 'warning' },
  running: { label: '执行中', tone: 'info' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '执行失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' }
}

export const AGENT_PRESENCE_META: Record<AgentPresenceState, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' }> = {
  idle: { label: '空闲', tone: 'success' },
  working: { label: '执行中', tone: 'info' },
  blocked: { label: '等待确认', tone: 'warning' },
  error: { label: '异常', tone: 'danger' },
  offline: { label: 'Runtime 离线', tone: 'neutral' }
}

export const FAILURE_KIND_LABEL: Record<RunFailureKind, string> = {
  agent_error: 'Agent 执行异常',
  timeout: '执行超时',
  runtime_offline: '本地 Runtime 服务离线',
  runtime_recovery: '本地服务已重启',
  manual: '已手动停止'
}

const ACTIVE_STATUSES = new Set<TaskRunStatus>(['dispatched', 'waiting_local_directory', 'running'])
const STORAGE_KEY = 'crux.hifox.task-runs.v1'

function loadRuns(): TaskRunRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as TaskRunRecord[] : []
  } catch {
    return []
  }
}

function persistRuns(runs: TaskRunRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs.slice(0, 120)))
  } catch {
    // 忽略本地存储受限错误
  }
}

function makeRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function isActiveRunStatus(status: TaskRunStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

export function computeAgentPresence(
  agentId: string,
  runs: readonly TaskRunRecord[],
  runtimeReady: boolean
): { state: AgentPresenceState; activeRun?: TaskRunRecord; queuedCount: number } {
  const mine = runs.filter((run) => run.executorId === agentId)
  const queuedCount = mine.filter((run) => run.status === 'queued').length
  const activeRun = mine.find((run) => isActiveRunStatus(run.status))
  if (activeRun) {
    if (activeRun.status === 'waiting_local_directory' || (activeRun.interaction && !activeRun.interaction.resolvedAt)) {
      return { state: 'blocked', activeRun, queuedCount }
    }
    return { state: 'working', activeRun, queuedCount }
  }
  if (!runtimeReady) return { state: 'offline', queuedCount }
  const latest = mine[0]
  if (latest?.status === 'failed') return { state: 'error', queuedCount }
  return { state: 'idle', queuedCount }
}

export interface EnqueueRunInput {
  taskId: string
  spaceId: string
  executorKind: 'agent' | 'crew'
  executorId: string
  executorName: string
  runtimeKind: CruxRuntimeKind
  model: string
  workingDirectory: CruxWorkingDirectoryMode
  localWorkdirPath?: string
  isolationMode: IsolationMode
  triggerSource: TaskRunRecord['triggerSource']
  actionTitle?: string
  prompt: string
  runtimeReady: boolean
  chatOpened?: boolean
}

function promoteNextQueuedForExecutor(runs: TaskRunRecord[], executorId: string): TaskRunRecord[] {
  const hasActive = runs.some((run) => run.executorId === executorId && isActiveRunStatus(run.status))
  if (hasActive) return runs
  const queued = runs
    .filter((run) => run.executorId === executorId && run.status === 'queued')
    .sort((a, b) => b.priorityScore - a.priorityScore || a.createdAt.localeCompare(b.createdAt))
  const next = queued[0]
  if (!next) return runs
  const now = new Date().toISOString()
  return runs.map((run) => {
    if (run.id !== next.id) return run
    const needsDir = run.workingDirectory === 'repo' && !run.localWorkdirPath?.trim()
    const nextStatus: TaskRunStatus = needsDir ? 'waiting_local_directory' : 'running'
    return {
      ...run,
      status: nextStatus,
      startedAt: now,
      logs: [
        ...run.logs,
        { at: now, level: 'info', text: '已从排队队列调度至本机 Runtime 认领执行。' },
        ...(needsDir
          ? [{ at: now, level: 'warn' as const, text: '未绑定本机项目目录，等待确认目录或切换临时目录后继续。' }]
          : [{ at: now, level: 'info' as const, text: `已进入执行中（${run.runtimeKind} · ${run.isolationMode === 'worktree' ? '独立 worktree' : '原地目录'}）。` }])
      ],
      interaction: needsDir
        ? {
            id: `int-${Date.now().toString(36)}`,
            kind: 'worktree_fallback',
            title: '等待确认工作目录',
            detail: '当前执行要求绑定本机项目目录，你可以选择在临时目录运行，或前往「电脑与 Runtime」绑定本地目录后继续。',
            options: ['切换原地/临时目录并继续', '保持等待目录'],
            createdAt: now
          }
        : run.interaction
    }
  })
}

interface TaskRunStore {
  runs: TaskRunRecord[]
  enqueueRun: (input: EnqueueRunInput) => TaskRunRecord
  prioritizeRun: (runId: string) => void
  unscheduleRun: (runId: string) => void
  stopRun: (runId: string, reason?: string) => void
  rerun: (runId: string, runtimeReady: boolean) => TaskRunRecord | null
  requestInteraction: (runId: string, interaction: Omit<TaskRunInteraction, 'id' | 'createdAt'>) => void
  respondInteraction: (runId: string, answer: string, options?: { switchToInPlace?: boolean }) => void
  appendLog: (runId: string, text: string, level?: TaskRunLogEntry['level']) => void
  completeRun: (runId: string, summary: string) => void
  failRun: (runId: string, failureKind: RunFailureKind, detail: string) => void
}

export const useTaskRuns = create<TaskRunStore>()((set, get) => {
  const commit = (runs: TaskRunRecord[]): void => {
    persistRuns(runs)
    set({ runs })
  }

  return {
    runs: loadRuns(),

    enqueueRun: (input) => {
      const now = new Date().toISOString()
      const existing = get().runs
      const busy = existing.some((run) => run.executorId === input.executorId && isActiveRunStatus(run.status))
      const needsDir = input.workingDirectory === 'repo' && !input.localWorkdirPath?.trim()
      const initialStatus: TaskRunStatus = busy
        ? 'queued'
        : !input.runtimeReady
          ? 'queued'
          : needsDir
            ? 'waiting_local_directory'
            : 'running'

      const logs: TaskRunLogEntry[] = [
        {
          at: now,
          level: 'info',
          text: `创建执行任务：${input.actionTitle ? `${input.actionTitle} · ` : ''}${input.executorName}（${input.runtimeKind} / ${input.model}）`
        }
      ]
      if (busy) {
        logs.push({ at: now, level: 'info', text: `${input.executorName} 正在处理其他任务，已加入排队队列。` })
      } else if (!input.runtimeReady) {
        logs.push({ at: now, level: 'warn', text: '当前本机 Runtime 尚未就绪，已排队等待本机服务在线后认领。' })
      } else if (needsDir) {
        logs.push({ at: now, level: 'warn', text: '缺少绑定的本机项目目录，等待确认工作目录策略。' })
      } else {
        logs.push({
          at: now,
          level: 'info',
          text: `本机 Runtime 已认领并开始执行（目录隔离：${input.isolationMode === 'worktree' ? 'worktree 独立工作树' : 'in_place 原地目录'}）。`
        })
      }

      const record: TaskRunRecord = {
        id: makeRunId(),
        taskId: input.taskId,
        spaceId: input.spaceId,
        executorKind: input.executorKind,
        executorId: input.executorId,
        executorName: input.executorName,
        runtimeKind: input.runtimeKind,
        model: input.model,
        workingDirectory: input.workingDirectory,
        localWorkdirPath: input.localWorkdirPath,
        isolationMode: input.isolationMode,
        status: initialStatus,
        triggerSource: input.triggerSource,
        actionTitle: input.actionTitle,
        prompt: input.prompt,
        priorityScore: 0,
        createdAt: now,
        startedAt: initialStatus === 'running' || initialStatus === 'waiting_local_directory' ? now : undefined,
        logs,
        chatOpened: input.chatOpened,
        interaction: initialStatus === 'waiting_local_directory'
          ? {
              id: `int-${Date.now().toString(36)}`,
              kind: 'worktree_fallback',
              title: '工作目录尚未就绪',
              detail: 'Agent 配置为仓库目录模式但本机未指定路径。可一键切换为原地/托管目录并立即继续执行。',
              options: ['切换原地/托管目录并继续', '保持等待'],
              createdAt: now
            }
          : undefined
      }
      commit([record, ...existing])
      return record
    },

    prioritizeRun: (runId) => {
      const now = new Date().toISOString()
      const current = get().runs
      const maxScore = current.reduce((max, run) => Math.max(max, run.priorityScore), 0)
      commit(current.map((run) => run.id === runId && run.status === 'queued'
        ? {
            ...run,
            priorityScore: maxScore + 1,
            logs: [...run.logs, { at: now, level: 'info', text: '已置顶为队列最高优先级。' }]
          }
        : run))
    },

    unscheduleRun: (runId) => {
      const now = new Date().toISOString()
      commit(get().runs.map((run) => run.id === runId && run.status === 'queued'
        ? {
            ...run,
            status: 'cancelled',
            finishedAt: now,
            failureKind: 'manual',
            logs: [...run.logs, { at: now, level: 'warn', text: '已从排队队列取消调度。' }]
          }
        : run))
    },

    stopRun: (runId, reason) => {
      const now = new Date().toISOString()
      const target = get().runs.find((run) => run.id === runId)
      if (!target) return
      const updated = get().runs.map((run) => run.id === runId
        ? {
            ...run,
            status: 'cancelled' as const,
            finishedAt: now,
            failureKind: 'manual' as const,
            logs: [...run.logs, { at: now, level: 'warn' as const, text: reason || '已手动停止当前执行。' }]
          }
        : run)
      commit(promoteNextQueuedForExecutor(updated, target.executorId))
    },

    rerun: (runId, runtimeReady) => {
      const source = get().runs.find((run) => run.id === runId)
      if (!source) return null
      return get().enqueueRun({
        taskId: source.taskId,
        spaceId: source.spaceId,
        executorKind: source.executorKind,
        executorId: source.executorId,
        executorName: source.executorName,
        runtimeKind: source.runtimeKind,
        model: source.model,
        workingDirectory: source.workingDirectory,
        localWorkdirPath: source.localWorkdirPath,
        isolationMode: source.isolationMode,
        triggerSource: 'rerun',
        actionTitle: source.actionTitle,
        prompt: source.prompt,
        runtimeReady,
        chatOpened: source.chatOpened
      })
    },

    requestInteraction: (runId, interaction) => {
      const now = new Date().toISOString()
      commit(get().runs.map((run) => run.id === runId
        ? {
            ...run,
            interaction: { ...interaction, id: `int-${Date.now().toString(36)}`, createdAt: now },
            logs: [...run.logs, { at: now, level: 'warn', text: `等待人工确认：${interaction.title}` }]
          }
        : run))
    },

    respondInteraction: (runId, answer, options) => {
      const now = new Date().toISOString()
      commit(get().runs.map((run) => {
        if (run.id !== runId || !run.interaction) return run
        const switchInPlace = Boolean(options?.switchToInPlace)
        return {
          ...run,
          status: run.status === 'waiting_local_directory' && switchInPlace ? 'running' : run.status,
          isolationMode: switchInPlace ? 'in_place' : run.isolationMode,
          workingDirectory: switchInPlace && run.workingDirectory === 'repo' && !run.localWorkdirPath?.trim() ? 'temp' : run.workingDirectory,
          interaction: { ...run.interaction, resolvedAt: now, answer },
          logs: [
            ...run.logs,
            {
              at: now,
              level: 'info',
              text: switchInPlace
                ? `已确认切换为原地/托管目录模式（in_place），继续执行。回复：${answer}`
                : `已提交人工确认回复：${answer}`
            }
          ]
        }
      }))
    },

    appendLog: (runId, text, level = 'output') => {
      const now = new Date().toISOString()
      commit(get().runs.map((run) => run.id === runId
        ? { ...run, logs: [...run.logs, { at: now, level, text }] }
        : run))
    },

    completeRun: (runId, summary) => {
      const now = new Date().toISOString()
      const target = get().runs.find((run) => run.id === runId)
      if (!target) return
      const updated = get().runs.map((run) => run.id === runId
        ? {
            ...run,
            status: 'completed' as const,
            finishedAt: now,
            summary,
            interaction: run.interaction && !run.interaction.resolvedAt
              ? { ...run.interaction, resolvedAt: now, answer: '已随完成关闭' }
              : run.interaction,
            logs: [...run.logs, { at: now, level: 'info' as const, text: `执行完成：${summary}` }]
          }
        : run)
      commit(promoteNextQueuedForExecutor(updated, target.executorId))
    },

    failRun: (runId, failureKind, detail) => {
      const now = new Date().toISOString()
      const target = get().runs.find((run) => run.id === runId)
      if (!target) return
      const updated = get().runs.map((run) => run.id === runId
        ? {
            ...run,
            status: 'failed' as const,
            finishedAt: now,
            failureKind,
            logs: [...run.logs, { at: now, level: 'error' as const, text: `${FAILURE_KIND_LABEL[failureKind]}：${detail}` }]
          }
        : run)
      commit(promoteNextQueuedForExecutor(updated, target.executorId))
    }
  }
})
