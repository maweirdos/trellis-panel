// 全局命令面板（Ctrl+K）：统一复用 CommandPaletteSurface，覆盖任务、Agent、空间、导航与全局操作。
import { useCallback, useEffect, useMemo, type JSX, type ReactNode } from 'react'
import { Calendar, Columns3, Copy, FolderKanban, Layers, ListTodo, Moon, Plus, Sparkles, Star, Sun } from 'lucide-react'
import { useApp, type Page } from '../store'
import { useMy } from './store'
import { NavIcon, PriorityIcon, StateGroupIcon } from './icons'
import { DOMAIN_LABELS, getPageNavigation, navigationScopeLabel, PAGE_NAVIGATION } from './navigation'
import { statusDisplayName, statusOf, useCrux } from '../crux/store'
import { COLLABORATION_MODULES } from '../crux/navigation'
import { FlowIcon } from '../crux/icons'
import { AgentAvatar } from '../crux/AgentAvatar'
import { useAgentChatBridge } from '../crux/agent-chat-bridge'
import { useCollaborationPlatform } from '../crux/collaboration-platform-store'
import { CRUX_STATE_GROUPS, cruxStatusColor } from '../crux/task-workspace-adapter'
import { hasIpc } from '../api'
import {
  CommandPaletteSurface,
  type CommandPaletteCategory,
  type CommandPaletteItem
} from './CommandPaletteSurface'
import type { Priority } from './types'

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

export function CommandPalette(): JSX.Element {
  const open = useMy((s) => s.paletteOpen)
  const setOpen = useMy((s) => s.setPaletteOpen)
  const data = useMy((s) => s.data)
  const projectRoot = useApp((s) => s.snapshot?.meta.root)
  const page = useApp((s) => s.page)
  const collaboration = useCrux((s) => s.snapshot)
  const currentSpaceId = useCrux((s) => s.currentSpaceId)
  const favorites = useCollaborationPlatform((s) => s.favorites)
  const theme = useMy((s) => s.theme)
  const setCreateIssueOpen = useMy((s) => s.setCreateIssueOpen)
  const openIssue = useMy((s) => s.openIssue)
  const setWorkItemsView = useMy((s) => s.setWorkItemsView)
  const setPageMain = useApp((s) => s.setPage)

  useEffect(() => {
    if (open) void useCrux.getState().bootstrap()
  }, [open])

  const close = useCallback((): void => setOpen(false), [setOpen])

  const go = useCallback((target: Page): void => {
    const ui = useMy.getState()
    if (target === 'tasks') { setWorkItemsView('items'); ui.setWorkItemsTab('all') }
    if (target === 'team') ui.setTeamView('overview')
    if (target === 'settings') ui.setSettingsView('preferences')
    if (target === 'knowledge') ui.setKnowledgeView('team')
    if (target === 'devtools') ui.setToolView('git')
    if (target === 'acp') ui.requestAgentView('conversation')
    setPageMain(target)
    setOpen(false)
  }, [setWorkItemsView, setPageMain, setOpen])

  const { items, categories } = useMemo<{ items: CommandPaletteItem[]; categories: CommandPaletteCategory[] }>(() => {
    const stateIcon = (stateId: string): ReactNode => {
      const st = data.states.find((s) => s.id === stateId)
      return <StateGroupIcon stateGroup={st?.group ?? 'unstarted'} color={st?.color} size={14} />
    }

    const activeSpace = collaboration?.spaces.find((item) => item.id === currentSpaceId)
      ?? collaboration?.spaces.find((item) => !item.archived)

    const teamTasks: CommandPaletteItem[] = [...(collaboration?.tasks ?? [])]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 60)
      .map((task) => {
        const space = collaboration?.spaces.find((entry) => entry.id === task.spaceId)
        const status = collaboration ? statusOf(collaboration, task.statusId) : undefined
        const stateGroup = status ? CRUX_STATE_GROUPS[status.category] : 'unstarted'
        const stateColor = status ? cruxStatusColor(status.category) : undefined
        const statusLabel = status ? statusDisplayName(status) : '未分类'
        const assignees = task.assigneeIds
          .map((id) => collaboration?.members.find((m) => m.id === id)?.name)
          .filter((name): name is string => Boolean(name))
        const icon = <StateGroupIcon stateGroup={stateGroup} color={stateColor} size={14} />
        const openDetail = (): void => {
          const crux = useCrux.getState()
          crux.setCurrentSpace(task.spaceId)
          crux.setModule('tasks')
          crux.openTask(task.id)
          go('crux')
        }
        return {
          id: `team-task-${task.id}`,
          category: 'tasks',
          section: '团队任务',
          label: `${task.id} · ${task.title}`,
          icon,
          hint: space?.name,
          actionVerb: '打开',
          keywords: `${task.id} ${task.title} ${space?.name ?? ''} ${statusLabel} ${assignees.join(' ')}`,
          fulltext: task.description,
          preview: {
            eyebrow: '团队任务',
            code: task.id,
            icon,
            title: task.title,
            summary: task.description?.trim() || undefined,
            meta: [
              { label: '状态', value: <span className="inline-flex items-center gap-1.5">{icon}<span>{statusLabel}</span></span> },
              { label: '优先级', value: <span className="inline-flex items-center gap-1.5"><PriorityIcon priority={task.priority} size={12} /><span>{PRIORITY_LABELS[task.priority]}</span></span> },
              { label: '负责人', value: assignees.length > 0 ? assignees.join('、') : (task.executor?.name ?? '未分配') },
              ...(space ? [{ label: '所属空间', value: space.name }] : [])
            ],
            footerHint: '回车打开任务详情 · Tab 查看更多任务操作'
          },
          drilldown: {
            label: task.id,
            icon,
            placeholder: `选择对「${task.id}」执行的操作…`,
            actions: [
              {
                id: `drill:${task.id}:open`,
                category: 'tasks',
                section: `${task.id} · 任务操作`,
                label: '打开任务详情',
                subtitle: space?.name,
                icon,
                actionVerb: '打开',
                run: openDetail
              },
              {
                id: `drill:${task.id}:copy-id`,
                category: 'tasks',
                section: `${task.id} · 任务操作`,
                label: '复制任务编号',
                subtitle: task.id,
                icon: <Copy size={13} />,
                actionVerb: '复制',
                run: () => { copyText(task.id, '任务编号'); close() }
              },
              {
                id: `drill:${task.id}:copy-title`,
                category: 'tasks',
                section: `${task.id} · 任务操作`,
                label: '复制编号与标题',
                icon: <Copy size={13} />,
                actionVerb: '复制',
                run: () => { copyText(`${task.id} ${task.title}`, '任务标题'); close() }
              },
              ...(space ? [{
                id: `drill:${task.id}:space`,
                category: 'tasks',
                section: `${task.id} · 任务操作`,
                label: `前往「${space.name}」任务列表`,
                icon: <FolderKanban size={13} />,
                actionVerb: '跳转',
                run: () => {
                  const crux = useCrux.getState()
                  crux.setCurrentSpace(space.id)
                  crux.setModule('tasks')
                  go('crux')
                }
              }] : [])
            ]
          },
          run: openDetail
        }
      })

    const localIssues: CommandPaletteItem[] = (page === 'crux' || (hasIpc && !projectRoot) ? [] : data.issues)
      .slice(0, 60)
      .map((issue) => {
        const st = data.states.find((s) => s.id === issue.stateId)
        const assignee = data.members.find((m) => m.id === issue.assigneeId)
        const icon = stateIcon(issue.stateId)
        const openLocal = (): void => {
          useApp.getState().setPersonalTaskSource('local')
          setWorkItemsView('items')
          setPageMain('tasks')
          openIssue(issue.id)
          close()
        }
        return {
          id: `i-${issue.id}`,
          category: 'tasks',
          section: '项目任务',
          label: issue.name,
          icon,
          hint: issue.id,
          actionVerb: '打开',
          keywords: `${issue.id} ${st?.name ?? ''} ${assignee?.name ?? ''}`,
          fulltext: issue.description,
          preview: {
            eyebrow: '项目任务',
            code: issue.id,
            icon,
            title: issue.name,
            summary: issue.description?.trim() || undefined,
            meta: [
              ...(st ? [{ label: '状态', value: <span className="inline-flex items-center gap-1.5">{icon}<span>{st.name}</span></span> }] : []),
              { label: '优先级', value: <span className="inline-flex items-center gap-1.5"><PriorityIcon priority={issue.priority} size={12} /><span>{PRIORITY_LABELS[issue.priority]}</span></span> },
              { label: '负责人', value: assignee?.name ?? '未分配' }
            ],
            footerHint: '回车打开详情 · Tab 查看更多操作'
          },
          drilldown: {
            label: issue.id,
            icon,
            actions: [
              { id: `drill:local:${issue.id}:open`, category: 'tasks', section: `${issue.id} · 任务操作`, label: '打开任务详情', icon, actionVerb: '打开', run: openLocal },
              { id: `drill:local:${issue.id}:copy`, category: 'tasks', section: `${issue.id} · 任务操作`, label: '复制任务编号', subtitle: issue.id, icon: <Copy size={13} />, actionVerb: '复制', run: () => { copyText(issue.id, '任务编号'); close() } }
            ]
          },
          run: openLocal
        }
      })

    const agents: CommandPaletteItem[] = (collaboration?.agents ?? [])
      .filter((item) => !item.archived && item.enabled)
      .map((agent) => {
        const sp = collaboration?.spaces.find((entry) => entry.id === agent.spaceId)
        const icon = <AgentAvatar avatarId={agent.avatarId} size={18} />
        const startChat = (): void => {
          close()
          useAgentChatBridge.getState().startAgentChat(agent.id, {
            runtimeKind: agent.runtimeKind,
            workingDirectory: agent.workingDirectory
          })
        }
        return {
          id: `agent-${agent.id}`,
          category: 'agents',
          section: 'AI Agent',
          label: agent.name,
          subtitle: agent.description || undefined,
          icon,
          hint: sp?.name ?? agent.runtimeKind,
          actionVerb: '对话',
          keywords: `agent ai bot ${agent.name} ${agent.description ?? ''} ${agent.runtimeKind} ${sp?.name ?? ''}`,
          preview: {
            eyebrow: 'AI Agent',
            code: agent.runtimeKind,
            icon: <AgentAvatar avatarId={agent.avatarId} size={20} />,
            title: agent.name,
            summary: agent.description?.trim() || '回车立即发起对话，支持流式协作与任务派发。',
            meta: [
              ...(sp ? [{ label: '所属空间', value: sp.name }] : []),
              { label: '运行引擎', value: agent.runtimeKind },
              ...(agent.workingDirectory ? [{ label: '工作目录', value: <span className="max-w-36 truncate font-mono text-my-2xs">{agent.workingDirectory}</span> }] : [])
            ],
            footerHint: '回车发起对话 · Tab 查看更多操作'
          },
          drilldown: {
            label: agent.name,
            icon: <AgentAvatar avatarId={agent.avatarId} size={14} />,
            actions: [
              { id: `drill:agent:${agent.id}:chat`, category: 'agents', section: `${agent.name} · Agent 操作`, label: '立即发起对话', icon: <Sparkles size={13} />, actionVerb: '对话', run: startChat },
              ...(sp ? [{
                id: `drill:agent:${agent.id}:config`,
                category: 'agents',
                section: `${agent.name} · Agent 操作`,
                label: `查看「${sp.name}」Agent 配置`,
                icon: <Layers size={13} />,
                actionVerb: '打开',
                run: () => {
                  const crux = useCrux.getState()
                  crux.setCurrentSpace(sp.id)
                  crux.setModule('agents')
                  go('crux')
                }
              }] : [])
            ]
          },
          run: startChat
        }
      })

    const spaces: CommandPaletteItem[] = (collaboration?.spaces ?? [])
      .filter((item) => !item.archived)
      .map((space) => {
        const starred = favorites.some((fav) => fav.kind === 'space' && fav.id === space.id)
        const taskCount = collaboration?.tasks.filter((task) => task.spaceId === space.id).length ?? 0
        const icon = starred ? <Star size={14} className="fill-current" /> : <Layers size={14} />
        const openSpaceTasks = (): void => {
          const crux = useCrux.getState()
          crux.setCurrentSpace(space.id)
          crux.setModule('tasks')
          go('crux')
        }
        return {
          id: `space-${space.id}`,
          category: 'spaces',
          section: '协作空间',
          label: space.name,
          subtitle: space.key,
          icon,
          hint: `${taskCount} 项任务`,
          actionVerb: '打开',
          keywords: `space 空间 ${space.name} ${space.key} ${space.description ?? ''}`,
          preview: {
            eyebrow: '协作空间',
            code: space.key,
            icon,
            title: space.name,
            summary: space.description?.trim() || '团队任务、迭代排期与 AI Agent 协作工作区。',
            meta: [
              { label: '成员', value: `${space.memberIds.length} 名` },
              { label: '任务', value: `${taskCount} 项` },
              { label: '可见性', value: space.visibility === 'private' ? '私有' : '公开' }
            ],
            footerHint: '回车打开任务列表 · Tab 查看空间操作'
          },
          drilldown: {
            label: space.name,
            icon,
            actions: [
              { id: `drill:space:${space.id}:tasks`, category: 'spaces', section: `${space.name} · 空间操作`, label: '打开任务列表', icon: <ListTodo size={13} />, actionVerb: '打开', run: openSpaceTasks },
              {
                id: `drill:space:${space.id}:board`,
                category: 'spaces',
                section: `${space.name} · 空间操作`,
                label: '打开看板视图',
                icon: <Columns3 size={13} />,
                actionVerb: '打开',
                run: () => { const crux = useCrux.getState(); crux.setCurrentSpace(space.id); crux.setModule('board'); go('crux') }
              },
              {
                id: `drill:space:${space.id}:new-task`,
                category: 'spaces',
                section: `${space.name} · 空间操作`,
                label: '在此空间新建任务',
                icon: <Plus size={13} />,
                actionVerb: '创建',
                run: () => {
                  const crux = useCrux.getState()
                  crux.setCurrentSpace(space.id)
                  go('crux')
                  crux.beginCreateTask({ spaceId: space.id })
                }
              },
              {
                id: `drill:space:${space.id}:iterations`,
                category: 'spaces',
                section: `${space.name} · 空间操作`,
                label: '查看空间迭代',
                icon: <Calendar size={13} />,
                actionVerb: '打开',
                run: () => { const crux = useCrux.getState(); crux.setCurrentSpace(space.id); crux.setModule('iterations'); go('crux') }
              }
            ]
          },
          run: openSpaceTasks
        }
      })

    const actions: CommandPaletteItem[] = [
      {
        id: 'a-new-team',
        category: 'actions',
        section: '快捷操作',
        label: activeSpace ? `在「${activeSpace.name}」新建任务` : '新建团队任务',
        icon: <Plus size={14} />,
        hint: activeSpace?.name ?? '当前协作空间',
        actionVerb: '创建',
        keywords: `new task create 新建任务 创建任务 团队任务 ${activeSpace?.name ?? ''}`,
        preview: {
          eyebrow: '快捷操作',
          icon: <Plus size={15} />,
          title: activeSpace ? `在「${activeSpace.name}」新建任务` : '新建团队任务',
          summary: '打开任务创建弹窗，支持手动录入或切换 AI Agent 协助梳理属性并自动入队。',
          meta: [
            { label: '目标空间', value: activeSpace?.name ?? '协作空间' },
            { label: '草稿保护', value: '关闭自动暂存' }
          ]
        },
        run: () => {
          go('crux')
          const state = useCrux.getState()
          if (state.currentSpaceId) state.beginCreateTask({ spaceId: state.currentSpaceId })
          else if (activeSpace) { state.setCurrentSpace(activeSpace.id); state.beginCreateTask({ spaceId: activeSpace.id }) }
          else state.setModule('spaces')
        }
      },
      {
        id: 'a-assistant',
        category: 'actions',
        section: '快捷操作',
        label: '发起小助手对话',
        icon: <Sparkles size={14} />,
        hint: '自由对话',
        actionVerb: '打开',
        keywords: 'chat assistant 小助手 对话 AI',
        preview: {
          eyebrow: '快捷操作',
          icon: <Sparkles size={15} />,
          title: '发起小助手对话',
          summary: '直接进入小助手对话界面，可随时挂载项目上下文或切换执行 Agent。',
          meta: [{ label: '范围', value: '全局工作台' }]
        },
        run: () => { close(); useAgentChatBridge.getState().startAgentChat(null) }
      },
      {
        id: 'a-theme',
        category: 'actions',
        section: '快捷操作',
        label: '切换浅色 / 深色主题',
        icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />,
        hint: `当前: ${theme === 'dark' ? '深色' : '浅色'}`,
        actionVerb: '切换',
        keywords: 'theme dark light 主题 深色 浅色 外观',
        preview: {
          eyebrow: '外观偏好',
          icon: theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />,
          title: '切换浅色 / 深色主题',
          summary: '立即在浅色与深色语义色板间切换，全应用表面、边框与阴影同步响应。',
          meta: [
            { label: '当前主题', value: theme === 'dark' ? '深色' : '浅色' },
            { label: '切换后', value: theme === 'dark' ? '浅色' : '深色' }
          ]
        },
        run: () => {
          useMy.getState().toggleTheme()
          close()
        }
      },
      ...(Boolean(projectRoot) || !hasIpc ? [{
        id: 'a-new',
        category: 'actions',
        section: '快捷操作',
        label: '新建项目任务',
        icon: <ListTodo size={14} />,
        hint: '当前本地项目',
        actionVerb: '创建',
        keywords: 'new issue 新建项目任务 本地任务',
        preview: {
          eyebrow: '快捷操作',
          icon: <ListTodo size={15} />,
          title: '新建项目任务',
          summary: '在当前打开的本地工程工作项列表中创建一条新的本地任务记录。',
          meta: [{ label: '范围', value: '当前项目' }]
        },
        run: () => {
          useApp.getState().setPersonalTaskSource('local')
          setWorkItemsView('items')
          setPageMain('tasks')
          setCreateIssueOpen(true)
          close()
        }
      }] : [])
    ]

    const nav: CommandPaletteItem[] = (Object.keys(PAGE_NAVIGATION) as Page[]).map((p) => {
      const entry = getPageNavigation(p)
      const hint = p === 'jira' ? 'Jira · 导入当前项目' : entry.commandHint ?? navigationScopeLabel(entry.scope)
      const icon = <NavIcon name={entry.icon} size={14} />
      return {
        id: `n-${p}`,
        category: 'nav',
        section: `导航 · ${DOMAIN_LABELS[entry.domain]}`,
        label: entry.title,
        icon,
        hint,
        actionVerb: '跳转',
        keywords: `${DOMAIN_LABELS[entry.domain]} ${entry.keywords ?? ''} ${hint}`,
        preview: {
          eyebrow: `导航 · ${DOMAIN_LABELS[entry.domain]}`,
          icon,
          title: entry.title,
          summary: `切换到「${entry.title}」工作区视图。`,
          meta: [{ label: '适用范围', value: hint }]
        },
        run: () => go(p)
      }
    })
    nav.splice(1, 0, {
      id: 'n-task-cycle',
      category: 'nav',
      section: '导航 · 任务',
      label: '项目版本',
      icon: <NavIcon name="cycles" size={14} />,
      hint: '当前项目',
      actionVerb: '跳转',
      keywords: '排期 自然周 版本 迭代',
      preview: {
        eyebrow: '导航 · 任务',
        icon: <NavIcon name="cycles" size={14} />,
        title: '项目版本',
        summary: '按自然周或项目版本排期查看当前项目任务进度。',
        meta: [{ label: '适用范围', value: '当前项目' }]
      },
      run: () => { useApp.getState().setPersonalTaskSource('local'); setWorkItemsView('iterations'); setPageMain('tasks'); close() }
    })

    const extra: CommandPaletteItem[] = [
      ...COLLABORATION_MODULES.filter((entry) => entry.id !== 'automations').map((entry) => {
        const icon = <FlowIcon name={entry.icon} size={15} />
        return {
          id: `n-collaboration-${entry.id}`,
          category: 'nav',
          section: '导航 · 团队',
          label: entry.label,
          icon,
          hint: `团队协作 · ${entry.group}`,
          actionVerb: '跳转',
          keywords: `${entry.id} 团队协作 ${entry.group}`,
          preview: {
            eyebrow: '导航 · 团队协作',
            icon,
            title: entry.label,
            summary: `打开团队协作中的「${entry.label}」模块。`,
            meta: [{ label: '所属分组', value: entry.group }]
          },
          run: () => { useCrux.getState().setModule(entry.id); go('crux') }
        }
      }),
      ...(['members', 'activity', 'reports'] as const).map((section) => {
        const label = { members: '项目成员记录', activity: '项目动态', reports: '项目报告' }[section]
        const icon = <NavIcon name="views" size={14} />
        return {
          id: `n-team-${section}`,
          category: 'nav',
          section: '导航 · 团队',
          label,
          icon,
          hint: '当前项目',
          actionVerb: '跳转',
          preview: { eyebrow: '导航 · 团队', icon, title: label, meta: [{ label: '适用范围', value: '当前项目' }] },
          run: () => { useMy.getState().setTeamView(section); setPageMain('team'); close() }
        }
      }),
      {
        id: 'n-roles', category: 'nav', section: '导航 · 对话', label: '角色',
        icon: <NavIcon name="inbox" size={14} />, hint: '当前项目', actionVerb: '跳转', keywords: 'Agent 我的角色',
        preview: { eyebrow: '导航 · 对话', icon: <NavIcon name="inbox" size={14} />, title: '角色', meta: [{ label: '适用范围', value: '当前项目' }] },
        run: () => { useMy.getState().requestAgentView('roles'); setPageMain('acp'); close() }
      },
      {
        id: 'n-company', category: 'nav', section: '导航 · 知识', label: '知识库',
        icon: <NavIcon name="pages" size={14} />, hint: '跨项目资料', actionVerb: '跳转',
        preview: { eyebrow: '导航 · 知识', icon: <NavIcon name="pages" size={14} />, title: '知识库', meta: [{ label: '适用范围', value: '跨项目资料' }] },
        run: () => { useMy.getState().setKnowledgeView('company'); setPageMain('knowledge'); close() }
      },
      {
        id: 'n-engines', category: 'nav', section: '导航 · 机器与 Runtime', label: '机器与 Runtime 中心',
        icon: <NavIcon name="modules" size={14} />, hint: '本机', actionVerb: '跳转', keywords: 'Runtime ACP Codex Claude 环境 机器',
        preview: { eyebrow: '导航 · 机器与 Runtime', icon: <NavIcon name="modules" size={14} />, title: '机器与 Runtime 中心', meta: [{ label: '适用范围', value: '本机' }] },
        run: () => { setPageMain('machines'); close() }
      },
      {
        id: 'n-run', category: 'nav', section: '导航 · 任务', label: '运行',
        icon: <NavIcon name="views" size={14} />, hint: '本机项目工具', actionVerb: '跳转',
        preview: { eyebrow: '导航 · 任务', icon: <NavIcon name="views" size={14} />, title: '运行', meta: [{ label: '适用范围', value: '本机项目工具' }] },
        run: () => { useMy.getState().setToolView('run'); setPageMain('devtools'); close() }
      },
      {
        id: 'n-git', category: 'nav', section: '导航 · 任务', label: 'Git',
        icon: <NavIcon name="views" size={14} />, hint: '当前项目 · 只读', actionVerb: '跳转',
        preview: { eyebrow: '导航 · 任务', icon: <NavIcon name="views" size={14} />, title: 'Git', meta: [{ label: '适用范围', value: '当前项目 · 只读' }] },
        run: () => { useMy.getState().setToolView('git'); setPageMain('devtools'); close() }
      }
    ]

    const sections = Object.values(DOMAIN_LABELS).map((label) => `导航 · ${label}`)
    const sortedNav = [...nav, ...extra].sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section))
    const prioritizedTasks = page === 'crux' ? teamTasks : [...localIssues, ...teamTasks]

    const allItems: CommandPaletteItem[] = [
      ...prioritizedTasks,
      ...agents,
      ...spaces,
      ...actions,
      ...sortedNav
    ]

    const cats: CommandPaletteCategory[] = [
      { id: 'all', label: '全部' },
      ...(prioritizedTasks.length > 0 ? [{ id: 'tasks', label: '任务' }] : []),
      ...(agents.length > 0 ? [{ id: 'agents', label: 'Agent' }] : []),
      ...(spaces.length > 0 ? [{ id: 'spaces', label: '空间' }] : []),
      { id: 'nav', label: '导航' },
      { id: 'actions', label: '操作' }
    ]

    return { items: allItems, categories: cats }
  }, [data, collaboration, currentSpaceId, favorites, theme, go, close, setWorkItemsView, setPageMain, openIssue, setCreateIssueOpen, page, projectRoot])

  return (
    <CommandPaletteSurface
      open={open}
      onClose={close}
      ariaLabel="搜索页面、任务与命令"
      placeholder="搜索任务、Agent、空间、页面或输入命令…"
      categories={categories}
      items={items}
      maxVisible={80}
    />
  )
}
