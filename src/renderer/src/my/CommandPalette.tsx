// 全局命令面板（Ctrl+K）：页面导航 + 工作项搜索 + 主题切换，键盘上下循环选择。
import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Search } from 'lucide-react'
import { useApp, type Page } from '../store'
import { useMy } from './store'
import { NavIcon, StateGroupIcon } from './icons'
import { DOMAIN_LABELS, getPageNavigation, navigationScopeLabel, PAGE_NAVIGATION } from './navigation'

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
  const theme = useMy((s) => s.theme)
  const setCreateIssueOpen = useMy((s) => s.setCreateIssueOpen)
  const openIssue = useMy((s) => s.openIssue)
  const setWorkItemsView = useMy((s) => s.setWorkItemsView)
  const setPageMain = useApp((s) => s.setPage)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const go = useCallback((page: Page): void => {
    if (page === 'tasks') setWorkItemsView('items')
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
        hint: entry.commandHint ?? navigationScopeLabel(entry.scope),
        keywords: `${DOMAIN_LABELS[entry.domain]} ${entry.keywords ?? ''}`,
        run: () => go(page)
      }
    })
    nav.splice(1, 0, {
      id: 'n-task-cycle', section: '导航 · 迭代', label: '迭代', icon: <NavIcon name="cycles" size={14} />,
      hint: '当前项目', keywords: '排期 自然周',
      run: () => { setWorkItemsView('iterations'); setPageMain('tasks'); setOpen(false) }
    })
    const issues: PaletteItem[] = data.issues.slice(0, 60).map((issue) => ({
      id: `i-${issue.id}`,
      section: '工作项',
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
        label: '新建工作项',
        icon: stateIcon('st-planning'),
        run: () => {
          setWorkItemsView('items')
          setPageMain('tasks')
          setCreateIssueOpen(true)
          setOpen(false)
        }
      }
    ]
    return [...nav, ...issues, ...actions]
  }, [data, theme, go, setWorkItemsView, setPageMain, openIssue, setOpen, setCreateIssueOpen])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        (it.keywords ?? '').toLowerCase().includes(q) ||
        (it.fulltext ?? '').toLowerCase().includes(q)
    )
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

  if (!open) return null

  let lastSection = ''

  return (
    <div className="my-fade my-modal-backdrop fixed inset-0" onMouseDown={() => setOpen(false)}>
      <div
        className="my-pop my-modal-panel mx-auto mt-[14vh] w-[560px] overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-my-header items-center gap-2 border-b border-my-line px-3">
          <Search size={15} className="text-my-icon-tertiary" />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            placeholder="搜索或输入命令..."
            className="min-w-0 flex-1 bg-transparent text-my-lg text-my-primary outline-none placeholder:text-my-placeholder"
          />
          <span className="my-kbd">Esc</span>
        </div>
        <div className="my-scrollbar max-h-[46vh] p-1.5">
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
