import { useMemo, useState, type JSX } from 'react'
import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react'
import { clsx } from 'clsx'
import { useCrux } from '../store'
import { workflowActionLabel } from '../TaskWorkflow'
import { PriorityBadge, Select } from '../ui'
import { Button } from '../../my/ui'
import { api } from '../../api'
import { getCruxLightweightTaskCapabilities } from '@shared/crux-domain/lightweight'
import { hasLocalWorkBridge } from '../local-work'
import {
  cockpitActor,
  localCalendarDate,
  NEXT_STEP_GROUPS,
  nextSteps,
  taskInsights,
  type NextStepGroup
} from './model'
import { useCockpitGeneration, useCockpitOwner } from './use-cockpit-owner'

export function MyNextSteps({ spaceId, iterationId }: { spaceId?: string; iterationId?: string } = {}): JSX.Element {
  const generation = useCockpitGeneration(Boolean(spaceId))
  return <MyNextStepsSource key={generation} spaceId={spaceId} iterationId={iterationId} />
}

const COLLAPSED_STORAGE_KEY = 'crux-my-next-steps-collapsed'
const MAX_DEFAULT_ITEMS = 3

const GROUP_CONFIG: Record<NextStepGroup, { label: string; badgeClass: string }> = {
  confirm: {
    label: '待确认',
    badgeClass: 'bg-my-warning-subtle text-my-warning-text'
  },
  blocked: {
    label: '受阻',
    badgeClass: 'bg-my-danger-subtle text-my-danger-text'
  },
  handle: {
    label: '待处理',
    badgeClass: 'bg-my-info-subtle text-my-info-text'
  },
  continue: {
    label: '继续',
    badgeClass: 'bg-my-layer-2 text-my-secondary'
  }
}

function MyNextStepsSource({ spaceId, iterationId }: { spaceId?: string; iterationId?: string }): JSX.Element | null {
  const { snapshot, workspaceContext } = useCrux()
  const owns = useCockpitOwner(Boolean(spaceId))
  const [expanded, setExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const toggleCollapsed = (): void => {
    if (!owns()) return
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next))
      } catch {
        // 静默降级
      }
      return next
    })
  }

  const items = useMemo(
    () =>
      snapshot
        ? nextSteps(taskInsights(snapshot, workspaceContext), localCalendarDate()).filter(
            (item) =>
              (!spaceId || item.task.spaceId === spaceId) &&
              (!iterationId || item.task.iterationIds.includes(iterationId))
          )
        : [],
    [snapshot, workspaceContext, spaceId, iterationId]
  )

  const groupCounts = useMemo(() => {
    const counts: Partial<Record<NextStepGroup, number>> = {}
    for (const item of items) {
      if (item.group) counts[item.group] = (counts[item.group] ?? 0) + 1
    }
    return counts
  }, [items])

  if (!snapshot) return null
  const actor = cockpitActor(snapshot, workspaceContext)
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)

  const open = (id: string, createdAt: string): void => {
    if (!owns()) return
    const current = useCrux.getState()
    const task = current.snapshot?.tasks.find((entry) => entry.id === id && entry.createdAt === createdAt)
    if (task && current.snapshot && taskInsights(current.snapshot, current.workspaceContext).some((entry) => entry.task.id === id && entry.group)) {
      current.openTask(id)
    }
  }

  const create = (): void => {
    if (!owns() || !actor) return
    const state = useCrux.getState()
    const target = state.snapshot?.spaces.find(
      (space) => space.id === (spaceId ?? state.currentSpaceId) && !space.archived && space.memberIds.includes(actor)
    )
    if (target) state.beginCreateTask({ spaceId: target.id })
  }

  const changeStatus = (taskId: string, createdAt: string, statusId: string): void => {
    if (busy || !owns()) return
    const state = useCrux.getState()
    const task = state.snapshot?.tasks.find((entry) => entry.id === taskId && entry.createdAt === createdAt)
    if (!state.snapshot || !task) return
    const capabilities = getCruxLightweightTaskCapabilities(state.snapshot, task, actor)
    if (!capabilities.canEditStatus || task.statusId === statusId) return
    void state.run('更新状态', () => capabilities.lightweight
      ? api.crux.updateTask({ id: task.id, patch: { statusId } })
      : api.crux.restoreLightweightTask({ taskId: task.id, expectedUpdatedAt: task.updatedAt, statusId }))
  }

  // 没有待办事项且折叠时保持极简静默
  if (items.length === 0 && collapsed) return null

  if (items.length === 0) {
    return (
      <section aria-label="我的下一步" className="shrink-0 border-b border-my-line bg-my-surface-1">
        <div className="my-page-container px-3 py-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-my-xs text-my-tertiary">
              <CheckCircle2 size={13} className="shrink-0 text-my-success" />
              <span>当前没有待处理事项</span>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => { if (owns()) useCrux.getState().setModule('tasks') }}>
                查看空间任务
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  !snapshot.spaces.some(
                    (space) =>
                      space.id === (spaceId ?? useCrux.getState().currentSpaceId) &&
                      !space.archived &&
                      space.memberIds.includes(actor ?? '')
                  ) || workspaceContext.state === 'offline'
                }
                onClick={create}
              >
                新建任务
              </Button>
            </div>
          </div>
        </div>
      </section>
    )
  }

  const visibleItems = expanded ? items : items.slice(0, MAX_DEFAULT_ITEMS)

  return (
    <section aria-label="我的下一步" className="shrink-0 border-b border-my-line bg-my-surface-1">
      <div className="my-page-container px-3 py-1.5">
        {/* 头部折叠触发条 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
              className="group flex items-center gap-1.5 rounded-my-control px-1.5 py-1 text-left transition-colors hover:bg-my-layer-1"
            >
              <span className="text-my-icon-tertiary group-hover:text-my-primary">
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </span>
              <span className="my-item-title text-my-sm font-semibold text-my-primary">我的下一步</span>
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-my-layer-2 px-1.5 text-my-2xs font-medium tabular-nums text-my-secondary">
                {items.length}
              </span>
            </button>

            {/* 分类统计徽标 */}
            <div className="hidden sm:flex min-w-0 select-none items-center gap-1.5">
              {NEXT_STEP_GROUPS.map((g) => {
                const count = groupCounts[g.id]
                if (!count) return null
                return (
                  <span
                    key={g.id}
                    className={clsx(
                      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-my-2xs font-medium',
                      GROUP_CONFIG[g.id].badgeClass
                    )}
                  >
                    <span>{GROUP_CONFIG[g.id].label}</span>
                    <span className="tabular-nums">{count}</span>
                  </span>
                )
              })}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {workspaceContext.state === 'offline' && (
              <span className="rounded bg-my-warning-subtle px-1.5 py-0.5 text-my-2xs text-my-warning-text select-none">
                离线缓存
              </span>
            )}
            {!collapsed && items.length > MAX_DEFAULT_ITEMS && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="cursor-pointer select-none text-my-2xs text-my-secondary transition-colors hover:text-my-primary"
              >
                {expanded ? '收起至前 3 项' : `展开全部 (${items.length})`}
              </button>
            )}
          </div>
        </div>

        {/* 待办事项展开列表：高密度单行卡片，最大高度限制，杜绝无限延展挤爆页面 */}
        {!collapsed && (
          <div className="mt-1 pb-1">
            <div className="my-scrollbar max-h-[220px] overflow-y-auto pr-0.5" style={{ scrollbarGutter: 'auto' }}>
              <ul className="flex flex-col gap-1">
                {visibleItems.map((item) => {
                  const desktopRequired = item.action === 'begin_development' && !hasLocalWorkBridge()
                  const actionLabel =
                    item.action && item.canAct && !desktopRequired
                      ? workflowActionLabel(item.action, item.task)
                      : '查看任务'
                  const handler =
                    snapshot.members.find((member) => member.id === item.handlerId)?.name ??
                    (item.handlerId ? '原处理人不可用' : '未指派')
                  const spaceName = snapshot.spaces.find((space) => space.id === item.task.spaceId)?.name
                  const warnings = [
                    item.waiting,
                    ...item.missing,
                    desktopRequired ? '技术规划需在桌面端准备本机任务' : null
                  ].filter(Boolean) as string[]

                  return (
                    <li
                      key={item.task.id}
                      className="group flex min-w-0 items-center justify-between gap-2.5 rounded-my-base border border-my-line bg-my-panel px-3 py-1.5 transition-colors hover:border-my-line-strong hover:bg-my-layer-1"
                      data-next-step={item.group}
                    >
                      {/* 左侧：类别徽标 + 任务 ID + 优先级 + 标题 + 关键告警 */}
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {item.group && (
                          <span
                            className={clsx(
                              'shrink-0 select-none rounded px-1.5 py-0.5 text-my-2xs font-medium',
                              GROUP_CONFIG[item.group].badgeClass
                            )}
                          >
                            {GROUP_CONFIG[item.group].label}
                          </span>
                        )}
                        <span className="shrink-0 select-none font-mono text-my-xs text-my-tertiary">
                          {item.task.id}
                        </span>
                        {item.task.priority !== 'none' && (
                          <span className="flex shrink-0 items-center">
                            <PriorityBadge priority={item.task.priority} />
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => open(item.task.id, item.task.createdAt)}
                          className="min-w-0 truncate text-left text-my-sm font-medium text-my-primary hover:text-my-accent hover:underline"
                          title={item.task.title}
                        >
                          {item.task.title}
                        </button>
                        {warnings.length > 0 && (
                          <span
                            className="inline-flex shrink-0 items-center rounded bg-my-warning-subtle px-1.5 py-0.5 text-my-2xs font-medium text-my-warning-text"
                            title={warnings.join(' · ')}
                          >
                            {warnings[0]}
                          </span>
                        )}
                      </div>

                      {/* 右侧：上下文元信息（空间 · 阶段 · 处理人 · 截止）+ 紧致操作按钮 */}
                      <div className="flex shrink-0 items-center gap-3">
                        <div className="hidden lg:flex select-none items-center gap-1.5 text-my-2xs text-my-tertiary">
                          {spaceName && <span>{spaceName}</span>}
                          <span>·</span>
                          <span>{item.stage}</span>
                          <span>·</span>
                          <span>处理人 · {handler}</span>
                          {item.deadline && (
                            <>
                              <span>·</span>
                              <span>截止 {item.deadline}</span>
                            </>
                          )}
                        </div>
                        {getCruxLightweightTaskCapabilities(snapshot, item.task, actor).canEditStatus ? <Select
                          size="sm"
                          ariaLabel={`更改 ${item.task.id} 状态`}
                          className="h-6 px-2 text-my-xs"
                          disabled={busy}
                          value={item.task.statusId}
                          onChange={(statusId: string) => changeStatus(item.task.id, item.task.createdAt, statusId)}
                          options={getCruxLightweightTaskCapabilities(snapshot, item.task, actor).statusOptions.map((status) => ({ value: status.id, label: status.name }))}
                        /> : null}
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`${actionLabel} ${item.task.id}`}
                          onClick={() => open(item.task.id, item.task.createdAt)}
                          className="flex h-6 shrink-0 items-center gap-1 px-2 text-my-xs font-medium"
                        >
                          <span>{actionLabel}</span>
                          <ArrowRight size={11} className="text-my-icon-secondary" />
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>

            {/* 超出默认展示条数时的极简提示 */}
            {!expanded && items.length > MAX_DEFAULT_ITEMS && (
              <div className="mt-1.5 flex items-center justify-between px-1 text-my-2xs text-my-tertiary">
                <span>还有 {items.length - MAX_DEFAULT_ITEMS} 项待处理工作未展开</span>
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="cursor-pointer font-medium text-my-primary transition-colors hover:text-my-accent hover:underline"
                >
                  查看全部 ({items.length})
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
