// 全局命令面板（Ctrl+K）：页面导航 + 工作项搜索 + 主题切换，键盘上下循环选择。
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Search } from 'lucide-react'
import { useApp, type Page } from '../store'
import { useMy } from './store'
import { NavIcon, StateGroupIcon } from './icons'
import { DOMAIN_LABELS, getPageNavigation, navigationScopeLabel, PAGE_NAVIGATION } from './navigation'
import { useHifox } from '../hifox/store'
import { COLLABORATION_MODULES } from '../hifox/navigation'
import { FlowIcon } from '../hifox/icons'
import { hasIpc } from '../api'

interface PaletteItem {
  id: string
  section: string
  label: string
  icon: ReactNode
  hint?: string
  keywords?: string
  /** 全文匹配域（如工作项描述），命中时标签补「描述」角标 */
  fulltext?: string
  run: () => void
}

export function CommandPalette(): JSX.Element | null {
  const open = useMy((s) => s.paletteOpen)
  const setOpen = useMy((s) => s.setPaletteOpen)
  const data = useMy((s) => s.data)
  const projectRoot = useApp((s) => s.snapshot?.meta.root)
  const page = useApp((s) => s.page)
  const collaboration = useHifox((s) => s.snapshot)
  const theme = useMy((s) => s.theme)
  const setCreateIssueOpen = useMy((s) => s.setCreateIssueOpen)
  const openIssue = useMy((s) => s.openIssue)
  const setWorkItemsView = useMy((s) => s.setWorkItemsView)
  const setPageMain = useApp((s) => s.setPage)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const selectedItemRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) void useHifox.getState().bootstrap() }, [open])

  const go = useCallback((page: Page): void => {
    const ui = useMy.getState()
    if (page === 'tasks') { setWorkItemsView('items'); ui.setWorkItemsTab('all') }
    if (page === 'team') ui.setTeamView('overview')
    if (page === 'settings') ui.setSettingsView('preferences')
    if (page === 'knowledge') ui.setKnowledgeView('materials')
    if (page === 'devtools') ui.setToolView('git')
    if (page === 'acp') ui.requestAgentView('conversation')
    setPageMain(page)
    setOpen(false)
  }, [setWorkItemsView, setPageMain, setOpen])

  const items = useMemo<PaletteItem[]>(() => {
    const stateIcon = (stateId: string): ReactNode => {
      const st = data.states.find((s) => s.id === stateId)
      return <StateGroupIcon stateGroup={st?.group ?? 'unstarted'} color={st?.color} size={14} />
    }
    const nav: PaletteItem[] = (Object.keys(PAGE_NAVIGATION) as Page[]).map((page) => {
      const entry = getPageNavigation(page)
      return {
        id: `n-${page}`,
        section: `导航 · ${DOMAIN_LABELS[entry.domain]}`,
        label: entry.title,
        icon: <NavIcon name={entry.icon} size={14} />,
        hint: page === 'jira' ? 'Jira · 导入当前项目' : entry.commandHint ?? navigationScopeLabel(entry.scope),
        keywords: `${DOMAIN_LABELS[entry.domain]} ${entry.keywords ?? ''}`,
        run: () => go(page)
      }
    })
    nav.splice(1, 0, {
      id: 'n-task-cycle', section: '导航 · 任务', label: '项目版本', icon: <NavIcon name="cycles" size={14} />,
      hint: '当前项目', keywords: '排期 自然周',
      run: () => { setWorkItemsView('iterations'); setPageMain('tasks'); setOpen(false) }
    })
    const extra: PaletteItem[] = [
      ...COLLABORATION_MODULES.map((entry) => ({
        id: `n-collaboration-${entry.id}`, section: '导航 · 团队', label: entry.label,
        icon: <FlowIcon name={entry.icon} size={16} />, hint: `团队协作 · ${entry.group}`,
        keywords: `${entry.id} 团队协作`, run: () => { useHifox.getState().setModule(entry.id); go('hifox') }
      })),
      ...(['members', 'activity', 'reports'] as const).map((section) => ({
        id: `n-team-${section}`, section: '导航 · 团队', label: { members: '项目成员记录', activity: '项目动态', reports: '项目报告' }[section], icon: <NavIcon name="views" size={14} />, hint: '当前项目',
        run: () => { useMy.getState().setTeamView(section); setPageMain('team'); setOpen(false) }
      })),
      { id: 'n-roles', section: '导航 · 对话', label: '角色', icon: <NavIcon name="inbox" size={14} />, hint: '当前项目', keywords: 'Agent 我的角色', run: () => { useMy.getState().requestAgentView('roles'); setPageMain('acp'); setOpen(false) } },
      { id: 'n-company', section: '导航 · 知识', label: '知识库', icon: <NavIcon name="pages" size={14} />, hint: '跨项目资料', run: () => { useMy.getState().setKnowledgeView('company'); setPageMain('knowledge'); setOpen(false) } },
      { id: 'n-engines', section: '导航 · 设置', label: '引擎', icon: <NavIcon name="modules" size={14} />, hint: '本机', keywords: 'Runtime ACP Codex Claude 环境', run: () => { useMy.getState().setSettingsView('engines'); setPageMain('settings'); setOpen(false) } },
      { id: 'n-run', section: '导航 · 任务', label: '运行', icon: <NavIcon name="views" size={14} />, hint: '本机项目工具', run: () => { useMy.getState().setToolView('run'); setPageMain('devtools'); setOpen(false) } },
      { id: 'n-git', section: '导航 · 任务', label: 'Git', icon: <NavIcon name="views" size={14} />, hint: '当前项目 · 只读', run: () => { useMy.getState().setToolView('git'); setPageMain('devtools'); setOpen(false) } }
    ]
    const issues: PaletteItem[] = (page === 'hifox' || (hasIpc && !projectRoot) ? [] : data.issues).slice(0, 60).map((issue) => ({
      id: `i-${issue.id}`,
      section: '任务',
      label: issue.name,
      icon: stateIcon(issue.stateId),
      keywords: issue.id,
      fulltext: issue.description,
      run: () => {
        setWorkItemsView('items')
        setPageMain('tasks')
        openIssue(issue.id)
        setOpen(false)
      }
    }))
    const actions: PaletteItem[] = [
      { id: 'a-new-team', section: '操作', label: '新建团队任务', icon: <FlowIcon name="tasks" size={16} />, hint: '当前协作空间', run: () => {
        go('hifox')
        const state = useHifox.getState()
        if (state.currentSpaceId) state.setCreateTaskOpen(true)
        else state.setModule('spaces')
      } },
      {
        id: 'a-theme',
        section: '操作',
        label: '切换浅色 / 深色主题',
        icon: stateIcon('st-planning'),
        hint: `当前: ${theme === 'dark' ? '深色' : '浅色'}`,
        run: () => {
          useMy.getState().toggleTheme()
          setOpen(false)
        }
      },
      {
        id: 'a-new',
        section: '操作',
        label: '新建项目任务',
        icon: stateIcon('st-planning'),
        run: () => {
          setWorkItemsView('items')
          setPageMain('tasks')
          setCreateIssueOpen(true)
          setOpen(false)
        }
      }
    ]
    const sections = ['首页', '对话', '任务', '团队', '知识', '设置'].map((label) => `导航 · ${label}`)
    const teamTasks: PaletteItem[] = (collaboration?.tasks ?? []).map((task) => ({ id: `team-task-${task.id}`, section: '团队任务', label: `${task.id} · ${task.title}`, icon: <FlowIcon name="tasks" size={16} />, hint: collaboration?.spaces.find((space) => space.id === task.spaceId)?.name, fulltext: task.description, run: () => { useHifox.getState().setModule('tasks'); useHifox.getState().openTask(task.id); go('hifox') } }))
    return [...nav, ...extra].sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section)).concat(page === 'hifox' ? teamTasks : issues, page === 'hifox' ? [] : teamTasks, actions.filter((item) => item.id !== 'a-new' || Boolean(projectRoot) || !hasIpc))
  }, [data, collaboration, theme, go, setWorkItemsView, setPageMain, openIssue, setOpen, setCreateIssueOpen, page, projectRoot])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, 100)
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        (it.keywords ?? '').toLowerCase().includes(q) ||
        (it.fulltext ?? '').toLowerCase().includes(q)
    ).slice(0, 100)
  }, [items, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((s) => (filtered.length === 0 ? 0 : (s + 1) % filtered.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => (filtered.length === 0 ? 0 : (s - 1 + filtered.length) % filtered.length))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        filtered[selected]?.run()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, filtered, selected, setOpen])

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected, open])

  if (!open) return null

  let lastSection = ''

  return (
    <div className="my-fade my-modal-backdrop my-command-backdrop fixed inset-0" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="搜索页面与命令"
        className="my-pop my-modal-panel my-command-panel overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-my-line p-2.5">
          <div className="my-command-search flex h-9 items-center gap-2.5 rounded-my-lg border border-transparent px-3">
            <Search size={15} className="shrink-0 text-my-icon-tertiary" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSelected(0)
              }}
              placeholder="搜索或输入命令..."
              aria-label="搜索页面与命令"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-results"
              aria-activedescendant={filtered[selected] ? `palette-option-${selected}` : undefined}
              aria-autocomplete="list"
              className="min-w-0 flex-1 bg-transparent text-my-lg text-my-primary outline-none placeholder:text-my-placeholder"
            />
            <span className="my-kbd">Esc</span>
          </div>
        </div>
        <div id="palette-results" role="listbox" aria-label="搜索结果" className="my-scrollbar my-command-results min-h-0 p-1.5">
          {filtered.length === 0 && (
            <div className="px-2.5 py-6 text-center text-my-sm text-my-tertiary">无匹配结果</div>
          )}
          {filtered.map((item, index) => {
            const header = item.section !== lastSection ? item.section : null
            lastSection = item.section
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pb-1 pt-2 text-my-xs text-my-tertiary">{header}</div>}
                <button
                  type="button"
                  id={`palette-option-${index}`}
                  role="option"
                  aria-selected={selected === index}
                  ref={selected === index ? selectedItemRef : undefined}
                  onMouseEnter={() => setSelected(index)}
                  onClick={item.run}
                  className={clsx(
                    'flex h-9 w-full items-center gap-2.5 rounded-my-md px-2.5 text-left text-my-md',
                    selected === index ? 'bg-my-layer-1-active text-my-primary' : 'text-my-secondary'
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.fulltext && query.trim() && !item.label.toLowerCase().includes(query.trim().toLowerCase()) && (
                    <span className="shrink-0 rounded bg-my-layer-3 px-1 text-my-2xs text-my-tertiary">描述命中</span>
                  )}
                  {item.hint && <span className="shrink-0 text-my-xs text-my-tertiary">{item.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
