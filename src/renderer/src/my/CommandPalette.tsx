// 全局命令面板（Ctrl+K）：页面导航 + 工作项搜索 + 主题切换，键盘上下循环选择。
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Search } from 'lucide-react'
import { useApp, type Page } from '../store'
import { useMy } from './store'
import { StateGroupIcon, WorkspaceMark } from './icons'
import type { StateGroup } from './types'

interface PaletteItem {
  id: string
  section: string
  label: string
  icon: ReactNode
  hint?: string
  keywords?: string
  run: () => void
}

export function CommandPalette(): JSX.Element | null {
  const open = useMy((s) => s.paletteOpen)
  const setOpen = useMy((s) => s.setPaletteOpen)
  const data = useMy((s) => s.data)
  const theme = useMy((s) => s.theme)
  const setCreateIssueOpen = useMy((s) => s.setCreateIssueOpen)
  const openIssue = useMy((s) => s.openIssue)
  const setPageMain = useApp((s) => s.setPage)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const go = (page: Page): void => {
    setPageMain(page)
    setOpen(false)
  }

  const items = useMemo<PaletteItem[]>(() => {
    const stateIcon = (stateId: string): ReactNode => {
      const st = data.states.find((s) => s.id === stateId)
      return <StateGroupIcon stateGroup={st?.group ?? 'unstarted'} color={st?.color} size={14} />
    }
    const nav: PaletteItem[] = [
      { id: 'n-your-work', section: '导航', label: 'Your work', icon: stateIcon('st-planning'), run: () => go('dashboard') },
      { id: 'n-analytics', section: '导航', label: 'Analytics', icon: stateIcon('st-planning'), run: () => go('analytics') },
      { id: 'n-work', section: '导航', label: 'Work items', icon: stateIcon('st-planning'), run: () => go('tasks') },
      { id: 'n-knowledge', section: '导航', label: '知识库', icon: stateIcon('st-planning'), run: () => go('knowledge') },
      { id: 'n-spec', section: '导航', label: '规范文档', icon: stateIcon('st-planning'), run: () => go('spec') },
      { id: 'n-archive', section: '导航', label: '归档', icon: stateIcon('st-planning'), run: () => go('archive') },
      { id: 'n-inbox', section: '导航', label: '待办池', icon: stateIcon('st-planning'), run: () => go('inbox') },
      { id: 'n-settings', section: '导航', label: '设置', icon: stateIcon('st-planning'), run: () => go('settings') }
    ]
    const project: PaletteItem[] = [
      {
        id: 'p-project',
        section: '项目',
        label: data.projects[0]?.name ?? '项目',
        icon: (
          <WorkspaceMark
            color={data.projects[0]?.color ?? '#006399'}
            letter={data.projects[0]?.icon.slice(0, 1) ?? 'T'}
            size={16}
          />
        ),
        hint: '进入项目',
        run: () => go('tasks')
      }
    ]
    const issues: PaletteItem[] = data.issues.slice(0, 60).map((issue) => ({
      id: `i-${issue.id}`,
      section: '工作项',
      label: issue.name,
      icon: stateIcon(issue.stateId),
      keywords: issue.id,
      run: () => {
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
          setPageMain('tasks')
          setCreateIssueOpen(true)
          setOpen(false)
        }
      }
    ]
    return [...nav, ...project, ...issues, ...actions]
  }, [data, theme, setPageMain, openIssue, setOpen, setCreateIssueOpen])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => it.label.toLowerCase().includes(q) || (it.keywords ?? '').toLowerCase().includes(q))
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
    <div className="my-fade fixed inset-0 z-[85] bg-my-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="my-pop mx-auto mt-[14vh] w-[560px] overflow-hidden rounded-xl border border-my-line bg-my-layer-2 shadow-[var(--my-shadow-overlay-200)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 items-center gap-2 border-b border-my-line px-3">
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
            className="min-w-0 flex-1 bg-transparent text-[14px] text-my-primary outline-none placeholder:text-my-placeholder"
          />
          <span className="my-kbd">Esc</span>
        </div>
        <div className="my-scrollbar max-h-[46vh] p-1.5">
          {filtered.length === 0 && (
            <div className="px-2.5 py-6 text-center text-[12.5px] text-my-tertiary">无匹配结果</div>
          )}
          {filtered.map((item, index) => {
            const header = item.section !== lastSection ? item.section : null
            lastSection = item.section
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pb-1 pt-2 text-[11px] text-my-tertiary">{header}</div>}
                <button
                  type="button"
                  onMouseEnter={() => setSelected(index)}
                  onClick={item.run}
                  className={clsx(
                    'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px]',
                    selected === index ? 'bg-my-layer-1-active text-my-primary' : 'text-my-secondary'
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-[11px] text-my-tertiary">{item.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
