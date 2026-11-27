import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { BarChart3, Bot, Command, Cpu, FolderKanban, Inbox, Layers, Plus, Search, Sparkles, Star, Users, Users2 } from 'lucide-react'
import { Modal } from '../my/ui'
import { useAgentChatBridge } from './agent-chat-bridge'
import { useCollaborationPlatform } from './collaboration-platform-store'
import { statusOf, useCrux, type CruxModule } from './store'
import { StatusBadge } from './ui'

interface CommandEntry {
  id: string
  group: string
  title: string
  subtitle?: string
  keywords: string
  icon: JSX.Element
  badge?: JSX.Element
  run: () => void
}

export function CruxCommandPalette({
  open,
  onClose,
  onOpenOrgSwitcher
}: {
  open: boolean
  onClose: () => void
  onOpenOrgSwitcher?: () => void
}): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const currentSpaceId = useCrux((state) => state.currentSpaceId)
  const setModule = useCrux((state) => state.setModule)
  const setCurrentSpace = useCrux((state) => state.setCurrentSpace)
  const openTask = useCrux((state) => state.openTask)
  const beginCreateTask = useCrux((state) => state.beginCreateTask)
  const favorites = useCollaborationPlatform((state) => state.favorites)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const items = useMemo<CommandEntry[]>(() => {
    if (!snapshot) return []
    const activeSpace = snapshot.spaces.find((item) => item.id === currentSpaceId) ?? snapshot.spaces.find((item) => !item.archived)
    const list: CommandEntry[] = []

    const navAction = (id: string, title: string, subtitle: string, module: CruxModule, icon: JSX.Element, keywords: string) => {
      list.push({
        id: `nav:${id}`,
        group: '快捷操作',
        title,
        subtitle,
        keywords: `${title} ${subtitle} ${keywords}`.toLowerCase(),
        icon,
        run: () => { setModule(module); onClose() }
      })
    }

    if (activeSpace && !activeSpace.archived) {
      list.push({
        id: 'act:new-task',
        group: '快捷操作',
        title: `在「${activeSpace.name}」新建任务`,
        subtitle: '快捷键 C · 创建任务并可直接派发给 AI Agent',
        keywords: `new task create 新建任务 创建任务 ${activeSpace.name} ${activeSpace.key}`.toLowerCase(),
        icon: <Plus size={14} />,
        run: () => { onClose(); beginCreateTask({ spaceId: activeSpace.id }) }
      })
    }

    list.push({
      id: 'act:chat',
      group: '快捷操作',
      title: '发起小助手对话',
      subtitle: '打开自由对话，支持随时切换 Agent 上下文',
      keywords: 'chat conversation assistant 小助手 对话'.toLowerCase(),
      icon: <Sparkles size={14} />,
      run: () => { onClose(); useAgentChatBridge.getState().startAgentChat(null) }
    })

    if (onOpenOrgSwitcher) {
      list.push({
        id: 'act:org',
        group: '快捷操作',
        title: '切换组织 / 账号与邀请',
        subtitle: '登录团队账号、创建新组织或切换本机工作区',
        keywords: 'org organization workspace switch 组织 切换 账号'.toLowerCase(),
        icon: <Layers size={14} />,
        run: () => { onClose(); onOpenOrgSwitcher() }
      })
    }

    navAction('inbox', '打开收件箱', '查看任务提醒、分栏处理与审批回复', 'inbox', <Inbox size={14} />, 'inbox notification 通知 收件箱')
    navAction('triage', '打开分拣台', '集中接纳、指派、暂缓或关闭待分拣需求', 'triage', <FolderKanban size={14} />, 'triage 分拣 需求')
    navAction('runtimes', '管理电脑与 Runtime', '配置 CLI Runtime、模型探测、默认目录与守护进程', 'runtimes', <Cpu size={14} />, 'runtime computer daemon 电脑 运行环境')
    navAction('analytics', '查看空间统计分析', '任务分布、成员与 Agent 吞吐和 Run 健康度', 'analytics', <BarChart3 size={14} />, 'analytics dashboard stats 统计 仪表盘')

    for (const space of snapshot.spaces.filter((item) => !item.archived)) {
      const starred = favorites.some((fav) => fav.kind === 'space' && fav.id === space.id)
      list.push({
        id: `space:${space.id}`,
        group: '空间',
        title: `${space.name} (${space.key})`,
        subtitle: space.description || `${space.memberIds.length} 名成员`,
        keywords: `space 空间 ${space.name} ${space.key} ${space.description ?? ''}`.toLowerCase(),
        icon: starred ? <Star size={14} className="fill-current" /> : <Layers size={14} />,
        run: () => { setCurrentSpace(space.id); setModule('board'); onClose() }
      })
    }

    for (const agent of snapshot.agents.filter((item) => !item.archived && item.enabled)) {
      const sp = snapshot.spaces.find((item) => item.id === agent.spaceId)
      list.push({
        id: `agent:${agent.id}`,
        group: 'AI Agent（回车直接对话）',
        title: agent.name,
        subtitle: `${sp?.name ?? '空间'} · ${agent.description || agent.runtimeKind}`,
        keywords: `agent ai bot ${agent.name} ${agent.description ?? ''} ${sp?.name ?? ''}`.toLowerCase(),
        icon: <Bot size={14} />,
        run: () => {
          onClose()
          useAgentChatBridge.getState().startAgentChat(agent.id, { runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory })
        }
      })
    }

    for (const crew of snapshot.crews.filter((item) => !item.archived)) {
      const sp = snapshot.spaces.find((item) => item.id === crew.spaceId)
      list.push({
        id: `crew:${crew.id}`,
        group: '协作小队',
        title: crew.name,
        subtitle: `${sp?.name ?? '空间'} · ${crew.members.length + 1} 名成员`,
        keywords: `crew team 小队 ${crew.name} ${crew.description ?? ''}`.toLowerCase(),
        icon: <Users2 size={14} />,
        run: () => { setCurrentSpace(crew.spaceId); setModule('crews'); onClose() }
      })
    }

    const recentTasks = [...snapshot.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 60)
    for (const task of recentTasks) {
      const sp = snapshot.spaces.find((item) => item.id === task.spaceId)
      const status = statusOf(snapshot, task.statusId)
      list.push({
        id: `task:${task.id}`,
        group: '任务',
        title: `${task.id} · ${task.title}`,
        subtitle: sp ? `${sp.name}${task.executor ? ` · 执行者 ${task.executor.name}` : ''}` : undefined,
        keywords: `${task.id} ${task.title} ${task.description ?? ''} ${sp?.name ?? ''}`.toLowerCase(),
        icon: <FolderKanban size={14} />,
        badge: status ? <StatusBadge status={status} /> : undefined,
        run: () => {
          setCurrentSpace(task.spaceId)
          openTask(task.id)
          onClose()
        }
      })
    }

    for (const member of snapshot.members) {
      list.push({
        id: `member:${member.id}`,
        group: '同事',
        title: member.name,
        subtitle: [member.title, member.email].filter(Boolean).join(' · ') || member.role,
        keywords: `member people 同事 ${member.name} ${member.email ?? ''} ${member.title ?? ''}`.toLowerCase(),
        icon: <Users size={14} />,
        run: () => { setModule('members'); onClose() }
      })
    }

    return list
  }, [snapshot, currentSpaceId, favorites, beginCreateTask, onClose, onOpenOrgSwitcher, openTask, setCurrentSpace, setModule])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, 24)
    const tokens = q.split(/\s+/).filter(Boolean)
    return items.filter((entry) => tokens.every((token) => entry.keywords.includes(token))).slice(0, 32)
  }, [items, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  if (!open) return null

  const grouped: Array<{ group: string; entries: Array<{ entry: CommandEntry; flatIndex: number }> }> = []
  filtered.forEach((entry, flatIndex) => {
    const existing = grouped.find((g) => g.group === entry.group)
    if (existing) existing.entries.push({ entry, flatIndex })
    else grouped.push({ group: entry.group, entries: [{ entry, flatIndex }] })
  })

  const activeEntry = filtered[selectedIndex] ?? filtered[0]

  return (
    <Modal open={open} onClose={onClose} width={580} ariaLabel="全局命令与快速跳转">
      <div
        className="flex max-h-[var(--my-modal-max-height)] flex-col overflow-hidden"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setSelectedIndex((prev) => (filtered.length ? (prev + 1) % filtered.length : 0))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setSelectedIndex((prev) => (filtered.length ? (prev - 1 + filtered.length) % filtered.length : 0))
          } else if (event.key === 'Enter' && activeEntry) {
            event.preventDefault()
            activeEntry.run()
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-my-line px-4 py-3">
          <Search size={16} className="shrink-0 text-my-icon-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务、空间、Agent、小队、成员或输入操作…"
            aria-label="全局搜索与命令"
            className="min-w-0 flex-1 bg-transparent text-my-sm text-my-primary placeholder:text-my-tertiary focus:outline-none"
          />
          <kbd className="my-kbd">ESC</kbd>
        </div>

        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-2" style={{ maxHeight: '24rem' }}>
          {grouped.length === 0 ? (
            <div className="flex flex-col items-center gap-1 py-10 text-center text-my-xs text-my-tertiary">
              <Command size={18} />
              <span>没有找到与「{query}」匹配的内容</span>
            </div>
          ) : (
            grouped.map((section) => (
              <div key={section.group} className="mb-2 last:mb-0">
                <div className="px-2.5 py-1 text-my-2xs font-medium text-my-tertiary">{section.group}</div>
                <div className="flex flex-col gap-0.5">
                  {section.entries.map(({ entry, flatIndex }) => {
                    const selected = flatIndex === selectedIndex
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onMouseEnter={() => setSelectedIndex(flatIndex)}
                        onClick={entry.run}
                        className={`flex w-full items-center gap-2.5 rounded-my-base px-2.5 py-2 text-left transition-colors ${selected ? 'bg-my-navigation-selected text-my-primary' : 'text-my-secondary hover:bg-my-navigation-hover'}`}
                      >
                        <span className="shrink-0 text-my-icon-secondary">{entry.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-my-sm font-medium text-my-primary">{entry.title}</span>
                          {entry.subtitle && <span className="block truncate text-my-2xs text-my-tertiary">{entry.subtitle}</span>}
                        </span>
                        {entry.badge && <span className="shrink-0">{entry.badge}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-my-line bg-my-layer-1 px-4 py-2 text-my-2xs text-my-tertiary">
          <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          <span>Ctrl+K / ⌘K 随时呼出</span>
        </footer>
      </div>
    </Modal>
  )
}
