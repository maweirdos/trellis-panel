// 协作工作区命令面板：统一复用全局 CommandPaletteSurface，完整保留 Modal 115ms 退场动效。
import { useMemo, type JSX } from 'react'
import { BarChart3, Calendar, Columns3, Copy, Cpu, FolderKanban, Inbox, Layers, ListTodo, Plus, Sparkles, Star, Users, Users2 } from 'lucide-react'
import { useApp } from '../store'
import { PriorityIcon, StateGroupIcon } from '../my/icons'
import type { Priority } from '../my/types'
import {
  CommandPaletteSurface,
  type CommandPaletteCategory,
  type CommandPaletteItem
} from '../my/CommandPaletteSurface'
import { AgentAvatar } from './AgentAvatar'
import { useAgentChatBridge } from './agent-chat-bridge'
import { useCollaborationPlatform } from './collaboration-platform-store'
import { statusDisplayName, statusOf, useCrux, type CruxModule } from './store'
import { CRUX_STATE_GROUPS, cruxStatusColor } from './task-workspace-adapter'
import { StatusBadge } from './ui'

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
  none: '无'
}

function copyText(text: string, label: string): void {
  void navigator.clipboard?.writeText(text)
    .then(() => useApp.getState().pushToast({ kind: 'success', title: `已复制${label}`, body: text }))
    .catch(() => undefined)
}

export function CruxCommandPalette({
  open,
  onClose,
  onOpenOrgSwitcher
}: {
  open: boolean
  onClose: () => void
  onOpenOrgSwitcher?: () => void
}): JSX.Element {
  const snapshot = useCrux((state) => state.snapshot)
  const currentSpaceId = useCrux((state) => state.currentSpaceId)
  const setModule = useCrux((state) => state.setModule)
  const setCurrentSpace = useCrux((state) => state.setCurrentSpace)
  const openTask = useCrux((state) => state.openTask)
  const beginCreateTask = useCrux((state) => state.beginCreateTask)
  const favorites = useCollaborationPlatform((state) => state.favorites)

  const { items, categories } = useMemo<{ items: CommandPaletteItem[]; categories: CommandPaletteCategory[] }>(() => {
    if (!snapshot) return { items: [], categories: [{ id: 'all', label: '全部' }] }
    const activeSpace = snapshot.spaces.find((item) => item.id === currentSpaceId) ?? snapshot.spaces.find((item) => !item.archived)
    const list: CommandPaletteItem[] = []

    const navAction = (id: string, label: string, subtitle: string, module: CruxModule, icon: JSX.Element, keywords: string) => {
      list.push({
        id: `nav:${id}`,
        category: 'actions',
        section: '快捷操作',
        label,
        subtitle,
        keywords: `${label} ${subtitle} ${keywords}`,
        icon,
        actionVerb: '打开',
        preview: {
          eyebrow: '工作区模块',
          icon,
          title: label,
          summary: subtitle,
          meta: activeSpace ? [{ label: '当前空间', value: activeSpace.name }] : undefined
        },
        run: () => { setModule(module); onClose() }
      })
    }

    if (activeSpace && !activeSpace.archived) {
      list.push({
        id: 'act:new-task',
        category: 'actions',
        section: '快捷操作',
        label: `在「${activeSpace.name}」新建任务`,
        subtitle: '快捷键 C · 支持派发给 AI Agent',
        keywords: `new task create 新建任务 创建任务 ${activeSpace.name} ${activeSpace.key}`,
        icon: <Plus size={14} />,
        actionVerb: '创建',
        preview: {
          eyebrow: '快捷操作',
          icon: <Plus size={15} />,
          title: `在「${activeSpace.name}」新建任务`,
          summary: '创建新任务并可选指派负责人或交由 AI Agent 自动入队执行。',
          meta: [{ label: '目标空间', value: activeSpace.name }, { label: '快捷键', value: 'C' }]
        },
        run: () => { onClose(); beginCreateTask({ spaceId: activeSpace.id }) }
      })
    }

    list.push({
      id: 'act:chat',
      category: 'actions',
      section: '快捷操作',
      label: '发起小助手对话',
      subtitle: '自由对话，随时切换 Agent 上下文',
      keywords: 'chat conversation assistant 小助手 对话',
      icon: <Sparkles size={14} />,
      actionVerb: '对话',
      preview: {
        eyebrow: '快捷操作',
        icon: <Sparkles size={15} />,
        title: '发起小助手对话',
        summary: '打开自由对话会话，可随时切换空间 Agent 或引用文档资料。'
      },
      run: () => { onClose(); useAgentChatBridge.getState().startAgentChat(null) }
    })

    if (onOpenOrgSwitcher) {
      list.push({
        id: 'act:org',
        category: 'actions',
        section: '快捷操作',
        label: '切换组织 / 账号与邀请',
        subtitle: '登录团队账号、创建新组织或切换工作区',
        keywords: 'org organization workspace switch 组织 切换 账号',
        icon: <Layers size={14} />,
        actionVerb: '打开',
        preview: {
          eyebrow: '组织管理',
          icon: <Layers size={15} />,
          title: '切换组织 / 账号与邀请',
          summary: '管理已连接的团队组织、邀请成员或切回本机单机工作区。'
        },
        run: () => { onClose(); onOpenOrgSwitcher() }
      })
    }

    navAction('inbox', '打开收件箱', '查看任务提醒、分栏处理与审批回复', 'inbox', <Inbox size={14} />, 'inbox notification 通知 收件箱')
    navAction('triage', '打开分拣台', '集中接纳、指派、暂缓或关闭待分拣需求', 'triage', <FolderKanban size={14} />, 'triage 分拣 需求')
    navAction('runtimes', '管理电脑与 Runtime', '配置 CLI Runtime、模型探测、默认目录与守护进程', 'runtimes', <Cpu size={14} />, 'runtime computer daemon 电脑 运行环境')
    navAction('analytics', '查看空间统计分析', '任务分布、成员与 Agent 吞吐和 Run 健康度', 'analytics', <BarChart3 size={14} />, 'analytics dashboard stats 统计 仪表盘')

    let spaceCount = 0
    for (const space of snapshot.spaces.filter((item) => !item.archived)) {
      spaceCount++
      const starred = favorites.some((fav) => fav.kind === 'space' && fav.id === space.id)
      const taskTotal = snapshot.tasks.filter((task) => task.spaceId === space.id).length
      const icon = starred ? <Star size={14} className="fill-current" /> : <Layers size={14} />
      list.push({
        id: `space:${space.id}`,
        category: 'spaces',
        section: '空间',
        label: `${space.name} (${space.key})`,
        subtitle: space.description || `${space.memberIds.length} 名成员`,
        keywords: `space 空间 ${space.name} ${space.key} ${space.description ?? ''}`,
        icon,
        hint: `${taskTotal} 项任务`,
        actionVerb: '打开',
        preview: {
          eyebrow: '协作空间',
          code: space.key,
          icon,
          title: space.name,
          summary: space.description?.trim() || undefined,
          meta: [
            { label: '成员', value: `${space.memberIds.length} 名` },
            { label: '任务', value: `${taskTotal} 项` },
            { label: '可见性', value: space.visibility === 'private' ? '私有' : '公开' }
          ],
          footerHint: '回车打开空间看板 · Tab 查看空间操作'
        },
        drilldown: {
          label: space.name,
          icon,
          actions: [
            { id: `drill:space:${space.id}:tasks`, category: 'spaces', section: `${space.name} · 空间操作`, label: '打开任务列表', icon: <ListTodo size={13} />, actionVerb: '打开', run: () => { setCurrentSpace(space.id); setModule('tasks'); onClose() } },
            { id: `drill:space:${space.id}:board`, category: 'spaces', section: `${space.name} · 空间操作`, label: '打开看板视图', icon: <Columns3 size={13} />, actionVerb: '打开', run: () => { setCurrentSpace(space.id); setModule('board'); onClose() } },
            { id: `drill:space:${space.id}:new`, category: 'spaces', section: `${space.name} · 空间操作`, label: '在此空间新建任务', icon: <Plus size={13} />, actionVerb: '创建', run: () => { setCurrentSpace(space.id); onClose(); beginCreateTask({ spaceId: space.id }) } },
            { id: `drill:space:${space.id}:iter`, category: 'spaces', section: `${space.name} · 空间操作`, label: '查看空间迭代', icon: <Calendar size={13} />, actionVerb: '打开', run: () => { setCurrentSpace(space.id); setModule('iterations'); onClose() } }
          ]
        },
        run: () => { setCurrentSpace(space.id); setModule('board'); onClose() }
      })
    }

    let agentCount = 0
    for (const agent of snapshot.agents.filter((item) => !item.archived && item.enabled)) {
      agentCount++
      const sp = snapshot.spaces.find((item) => item.id === agent.spaceId)
      const icon = <AgentAvatar avatarId={agent.avatarId} size={18} />
      const startChat = (): void => {
        onClose()
        useAgentChatBridge.getState().startAgentChat(agent.id, { runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory })
      }
      list.push({
        id: `agent:${agent.id}`,
        category: 'agents',
        section: 'AI Agent',
        label: agent.name,
        subtitle: `${sp?.name ?? '空间'} · ${agent.description || agent.runtimeKind}`,
        keywords: `agent ai bot ${agent.name} ${agent.description ?? ''} ${sp?.name ?? ''}`,
        icon,
        actionVerb: '对话',
        preview: {
          eyebrow: 'AI Agent',
          code: agent.runtimeKind,
          icon: <AgentAvatar avatarId={agent.avatarId} size={20} />,
          title: agent.name,
          summary: agent.description?.trim() || '回车立即与该 Agent 展开对话。',
          meta: [
            ...(sp ? [{ label: '所属空间', value: sp.name }] : []),
            { label: '运行引擎', value: agent.runtimeKind }
          ],
          footerHint: '回车发起对话 · Tab 查看更多操作'
        },
        drilldown: {
          label: agent.name,
          icon: <AgentAvatar avatarId={agent.avatarId} size={14} />,
          actions: [
            { id: `drill:agent:${agent.id}:chat`, category: 'agents', section: `${agent.name} · Agent 操作`, label: '立即发起对话', icon: <Sparkles size={13} />, actionVerb: '对话', run: startChat },
            ...(sp ? [{ id: `drill:agent:${agent.id}:cfg`, category: 'agents', section: `${agent.name} · Agent 操作`, label: `查看「${sp.name}」Agent 配置`, icon: <Layers size={13} />, actionVerb: '打开', run: () => { setCurrentSpace(sp.id); setModule('agents'); onClose() } }] : [])
          ]
        },
        run: startChat
      })
    }

    for (const crew of snapshot.crews.filter((item) => !item.archived)) {
      agentCount++
      const sp = snapshot.spaces.find((item) => item.id === crew.spaceId)
      list.push({
        id: `crew:${crew.id}`,
        category: 'agents',
        section: '协作小队',
        label: crew.name,
        subtitle: `${sp?.name ?? '空间'} · ${crew.members.length + 1} 名成员`,
        keywords: `crew team 小队 ${crew.name} ${crew.description ?? ''}`,
        icon: <Users2 size={14} />,
        actionVerb: '打开',
        preview: {
          eyebrow: '协作小队',
          icon: <Users2 size={15} />,
          title: crew.name,
          summary: crew.description?.trim() || undefined,
          meta: [
            ...(sp ? [{ label: '所属空间', value: sp.name }] : []),
            { label: '小队规模', value: `${crew.members.length + 1} 名` }
          ]
        },
        run: () => { setCurrentSpace(crew.spaceId); setModule('crews'); onClose() }
      })
    }

    const recentTasks = [...snapshot.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 60)
    for (const task of recentTasks) {
      const sp = snapshot.spaces.find((item) => item.id === task.spaceId)
      const status = statusOf(snapshot, task.statusId)
      const stateGroup = status ? CRUX_STATE_GROUPS[status.category] : 'unstarted'
      const stateColor = status ? cruxStatusColor(status.category) : undefined
      const icon = <StateGroupIcon stateGroup={stateGroup} color={stateColor} size={14} />
      const assignees = task.assigneeIds
        .map((id) => snapshot.members.find((m) => m.id === id)?.name)
        .filter((name): name is string => Boolean(name))
      const openDetail = (): void => {
        setCurrentSpace(task.spaceId)
        openTask(task.id)
        onClose()
      }
      list.push({
        id: `task:${task.id}`,
        category: 'tasks',
        section: '任务',
        label: `${task.id} · ${task.title}`,
        subtitle: sp ? `${sp.name}${task.executor ? ` · 执行者 ${task.executor.name}` : ''}` : undefined,
        keywords: `${task.id} ${task.title} ${sp?.name ?? ''} ${assignees.join(' ')}`,
        fulltext: task.description,
        icon,
        badge: status ? <StatusBadge status={status} /> : undefined,
        actionVerb: '打开',
        preview: {
          eyebrow: '团队任务',
          code: task.id,
          icon,
          title: task.title,
          summary: task.description?.trim() || undefined,
          meta: [
            ...(status ? [{ label: '状态', value: <span className="inline-flex items-center gap-1.5">{icon}<span>{statusDisplayName(status)}</span></span> }] : []),
            { label: '优先级', value: <span className="inline-flex items-center gap-1.5"><PriorityIcon priority={task.priority} size={12} /><span>{PRIORITY_LABELS[task.priority]}</span></span> },
            { label: '负责人', value: assignees.length > 0 ? assignees.join('、') : (task.executor?.name ?? '未分配') },
            ...(sp ? [{ label: '所属空间', value: sp.name }] : [])
          ],
          footerHint: '回车打开详情 · Tab 查看更多任务操作'
        },
        drilldown: {
          label: task.id,
          icon,
          actions: [
            { id: `drill:${task.id}:open`, category: 'tasks', section: `${task.id} · 任务操作`, label: '打开任务详情', icon, actionVerb: '打开', run: openDetail },
            { id: `drill:${task.id}:copy-id`, category: 'tasks', section: `${task.id} · 任务操作`, label: '复制任务编号', subtitle: task.id, icon: <Copy size={13} />, actionVerb: '复制', run: () => { copyText(task.id, '任务编号'); onClose() } },
            { id: `drill:${task.id}:copy-title`, category: 'tasks', section: `${task.id} · 任务操作`, label: '复制编号与标题', icon: <Copy size={13} />, actionVerb: '复制', run: () => { copyText(`${task.id} ${task.title}`, '任务标题'); onClose() } }
          ]
        },
        run: openDetail
      })
    }

    for (const member of snapshot.members) {
      list.push({
        id: `member:${member.id}`,
        category: 'members',
        section: '同事',
        label: member.name,
        subtitle: [member.title, member.email].filter(Boolean).join(' · ') || member.role,
        keywords: `member people 同事 ${member.name} ${member.email ?? ''} ${member.title ?? ''}`,
        icon: <Users size={14} />,
        actionVerb: '查看',
        preview: {
          eyebrow: '团队成员',
          icon: <Users size={15} />,
          title: member.name,
          meta: [
            { label: '角色', value: member.role },
            ...(member.title ? [{ label: '职位', value: member.title }] : []),
            ...(member.email ? [{ label: '邮箱', value: <span className="truncate">{member.email}</span> }] : [])
          ]
        },
        run: () => { setModule('members'); onClose() }
      })
    }

    const cats: CommandPaletteCategory[] = [
      { id: 'all', label: '全部' },
      ...(recentTasks.length > 0 ? [{ id: 'tasks', label: '任务' }] : []),
      ...(agentCount > 0 ? [{ id: 'agents', label: 'Agent' }] : []),
      ...(spaceCount > 0 ? [{ id: 'spaces', label: '空间' }] : []),
      ...(snapshot.members.length > 0 ? [{ id: 'members', label: '同事' }] : []),
      { id: 'actions', label: '操作' }
    ]

    return { items: list, categories: cats }
  }, [snapshot, currentSpaceId, favorites, beginCreateTask, onClose, onOpenOrgSwitcher, openTask, setCurrentSpace, setModule])

  return (
    <CommandPaletteSurface
      open={open}
      onClose={onClose}
      ariaLabel="全局命令与快速跳转"
      placeholder="搜索任务、空间、Agent、小队、成员或输入操作…"
      categories={categories}
      items={items}
      maxVisible={48}
    />
  )
}
