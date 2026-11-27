import { useEffect, useState, type JSX } from 'react'
import { Check, ChevronRight, Circle, Rocket, X } from 'lucide-react'
import type { AcpAgentStatus } from '../../../shared/types'
import { ensureRuntimeInventoryLoaded, getRuntimeInventorySnapshot, subscribeRuntimeInventory } from '../acp/useRuntimeInventoryRefresh'
import { useApp } from '../store'
import { Button } from '../my/ui'
import { useCollaborationPlatform } from './collaboration-platform-store'
import { statusOf, useCrux } from './store'
import { useTaskRuns } from './task-run-store'

interface MissionStep {
  id: string
  title: string
  description: string
  done: boolean
  ctaLabel: string
  onAction: () => void
}

function useGetStartedSteps(): MissionStep[] {
  const snapshot = useCrux((state) => state.snapshot)
  const currentSpaceId = useCrux((state) => state.currentSpaceId)
  const setModule = useCrux((state) => state.setModule)
  const beginCreateTask = useCrux((state) => state.beginCreateTask)
  const openTask = useCrux((state) => state.openTask)
  const appProjectRoot = useApp((state) => state.snapshot?.meta.root)
  const customRuntimes = useCollaborationPlatform((state) => state.customRuntimes)
  const runs = useTaskRuns((state) => state.runs)
  const [detected, setDetected] = useState<AcpAgentStatus[]>(getRuntimeInventorySnapshot)

  useEffect(() => {
    const unsubscribe = subscribeRuntimeInventory(setDetected)
    void ensureRuntimeInventoryLoaded()
    return unsubscribe
  }, [])

  if (!snapshot) return []

  const hasMachine = detected.some((item) => item.available && !item.setupRequired) || customRuntimes.some((rt) => !rt.archived)
  const activeAgents = snapshot.agents.filter((agent) => !agent.archived && agent.enabled)
  const hasAgent = activeAgents.length > 0
  const hasWorkspace = Boolean(
    appProjectRoot ||
    activeAgents.some((agent) => agent.repositories.length > 0)
  )
  const delegatedTasks = snapshot.tasks.filter((task) => task.executor?.kind === 'agent' || task.executor?.kind === 'crew')
  const hasDelegated = delegatedTasks.length > 0 || runs.length > 0
  const hasReviewedDone = snapshot.tasks.some((task) =>
    (task.executor?.kind === 'agent' || task.executor?.kind === 'crew') &&
    statusOf(snapshot, task.statusId)?.category === 'done'
  )

  return [
    {
      id: 'machine',
      title: '连接工作机器',
      description: '配置至少 1 个本地 CLI 或自定义 Runtime 执行环境',
      done: hasMachine,
      ctaLabel: '配置机器',
      onAction: () => setModule('runtimes')
    },
    {
      id: 'agent',
      title: '创建一个能工作的 Agent',
      description: '在「全部 Agent」中从模板或空白创建 AI 队友',
      done: hasAgent,
      ctaLabel: '去创建',
      onAction: () => setModule('all-agents')
    },
    {
      id: 'workspace',
      title: '指定工作目录或仓库',
      description: '为空间或 Agent 关联 Git 仓库或本机代码目录',
      done: hasWorkspace,
      ctaLabel: '去关联',
      onAction: () => setModule('all-agents')
    },
    {
      id: 'delegate',
      title: '指派第一个任务',
      description: '创建任务并将处理人指派给 Agent 执行',
      done: hasDelegated,
      ctaLabel: '新建并委派',
      onAction: () => beginCreateTask(currentSpaceId ? { spaceId: currentSpaceId } : undefined)
    },
    {
      id: 'review',
      title: '验收并完成',
      description: '检查 Agent 的工作结果，把任务状态改为已完成',
      done: hasReviewedDone,
      ctaLabel: delegatedTasks[0] ? '查看任务' : '打开任务',
      onAction: () => {
        if (delegatedTasks[0]) openTask(delegatedTasks[0].id)
        else setModule('tasks')
      }
    }
  ]
}

export function GetStartedWidget({ variant = 'overview' }: { variant?: 'sidebar' | 'overview' }): JSX.Element | null {
  const steps = useGetStartedSteps()
  const setModule = useCrux((state) => state.setModule)
  const getStarted = useCollaborationPlatform((state) => state.getStarted)
  const setGetStarted = useCollaborationPlatform((state) => state.setGetStarted)

  if (steps.length === 0 || getStarted.dismissed || getStarted.skipped) return null
  const completedCount = steps.filter((step) => step.done).length
  const percent = Math.round((completedCount / steps.length) * 100)

  if (variant === 'sidebar') {
    return (
      <div className="shrink-0 border-t border-my-line px-2 py-1.5">
        <button
          type="button"
          onClick={() => setModule('overview')}
          className="collab-nav-item w-full justify-between"
          aria-label={`新手指引，已完成 ${completedCount}/${steps.length}`}
        >
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="collab-tone-avatar grid h-5 w-5 shrink-0 place-items-center rounded-my-sm" data-tone="indigo">
              <Rocket size={12} />
            </span>
            <span className="truncate font-medium text-my-primary">新手指引</span>
            <span className={`inline-grid h-4 w-4 shrink-0 place-items-center rounded-full border text-my-2xs tabular-nums ${
              completedCount === steps.length
                ? 'border-transparent bg-my-success-subtle text-my-success-text'
                : 'border-my-line-strong text-my-tertiary'
            }`} title={`已完成 ${percent}%`}>
              {completedCount === steps.length ? <Check size={10} /> : ''}
            </span>
          </span>
          <ChevronRight size={14} className="shrink-0 text-my-icon-tertiary" />
        </button>
      </div>
    )
  }

  return (
    <section aria-label="新手指引" className="rounded-my-base border border-my-line bg-my-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-my-sm font-semibold text-my-primary">新手指引 · 开始第一次 AI 协作</h2>
            <span className="my-chip tabular-nums">已完成 {completedCount}/{steps.length}（{percent}%）</span>
          </div>
          <p className="mt-0.5 text-my-xs text-my-tertiary">按真实数据自动点亮进度，带你走完从机器准备、创建 Agent 到任务验收的全流程。</p>
        </div>
        <Button size="sm" variant="ghost" aria-label="隐藏引导" onClick={() => setGetStarted({ dismissed: true })}>
          <X size={13} />隐藏引导
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-5">
        {steps.map((step, index) => (
          <div
            key={step.id}
            className={`flex flex-col justify-between gap-2.5 rounded-my-base border p-3 ${step.done ? 'border-my-line bg-my-layer-1' : 'border-my-line-strong bg-my-canvas'}`}
          >
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-my-xs font-medium">
                {step.done ? (
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-my-success-subtle text-my-success-text"><Check size={11} /></span>
                ) : (
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-my-line-strong text-my-2xs tabular-nums text-my-secondary">{index + 1}</span>
                )}
                <span className={step.done ? 'text-my-secondary line-through' : 'text-my-primary'}>{step.title}</span>
              </div>
              <p className="text-my-2xs leading-relaxed text-my-tertiary">{step.description}</p>
            </div>
            {!step.done ? (
              <Button size="sm" variant="outline" className="w-full justify-between" onClick={step.onAction}>
                <span>{step.ctaLabel}</span>
                <ChevronRight size={12} />
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1 text-my-2xs text-my-success-text"><Circle size={8} className="fill-current" />已完成</span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
