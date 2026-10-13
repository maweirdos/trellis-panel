// 参考 风格命令面板（Ctrl+K）：分区（导航/项目/操作）、大小写不敏感过滤、
// 键盘上下循环选择 + Enter 执行 + Esc 关闭。打开时重置搜索与选中项。
import { useEffect, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { CircleUser, FilePlus, Folder, FolderPlus, Moon, Search, Sun } from 'lucide-react'
import { useMy } from './store'
import { NavIcon, WorkspaceMark } from './icons'

type CommandSection = '导航' | '项目' | '操作'

interface CommandItem {
  id: string
  section: CommandSection
  label: string
  icon: JSX.Element
  hint?: string
  run: () => void
}

const SECTION_ORDER: CommandSection[] = ['导航', '项目', '操作']

export function CommandPalette(): JSX.Element | null {
  const open = useMy((s) => s.paletteOpen)
  const setPaletteOpen = useMy((s) => s.setPaletteOpen)
  const theme = useMy((s) => s.theme)
  const setTheme = useMy((s) => s.setTheme)
  const projects = useMy((s) => s.data.projects)
  const navigateWorkspace = useMy((s) => s.navigateWorkspace)
  const navigateProject = useMy((s) => s.navigateProject)
  const setCreateProjectOpen = useMy((s) => s.setCreateProjectOpen)
  const setCreateIssueOpen = useMy((s) => s.setCreateIssueOpen)

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const items: CommandItem[] = [
    {
      id: 'nav-your-work',
      section: '导航',
      label: 'Your work',
      icon: <NavIcon name="your-work" size={15} className="text-my-icon-tertiary" />,
      run: () => navigateWorkspace('your-work')
    },
    {
      id: 'nav-inbox',
      section: '导航',
      label: 'Inbox',
      icon: <NavIcon name="inbox" size={15} className="text-my-icon-tertiary" />,
      run: () => navigateWorkspace('inbox')
    },
    {
      id: 'nav-analytics',
      section: '导航',
      label: 'Analytics',
      icon: <NavIcon name="analytics" size={15} className="text-my-icon-tertiary" />,
      run: () => navigateWorkspace('analytics')
    },
    {
      id: 'nav-projects',
      section: '导航',
      label: 'Projects',
      icon: <Folder size={15} className="text-my-icon-tertiary" />,
      run: () => navigateWorkspace('projects')
    },
    {
      id: 'nav-profile',
      section: '导航',
      label: 'Profile',
      icon: <CircleUser size={15} className="text-my-icon-tertiary" />,
      run: () => navigateWorkspace('profile')
    },
    ...projects.map((p) => ({
      id: `project-${p.id}`,
      section: '项目' as const,
      label: p.name,
      icon: <WorkspaceMark color={p.color} letter={p.icon.slice(0, 1)} size={16} />,
      hint: '进入项目',
      run: () => navigateProject(p.id)
    })),
    {
      id: 'act-theme',
      section: '操作',
      label: '切换浅色 / 深色主题',
      icon: theme === 'dark' ? <Sun size={15} className="text-my-icon-tertiary" /> : <Moon size={15} className="text-my-icon-tertiary" />,
      hint: `当前：${theme === 'dark' ? '深色' : '浅色'}`,
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark')
    },
    {
      id: 'act-new-project',
      section: '操作',
      label: '新建项目',
      icon: <FolderPlus size={15} className="text-my-icon-tertiary" />,
      run: () => setCreateProjectOpen(true)
    },
    {
      id: 'act-new-issue',
      section: '操作',
      label: '新建工作项',
      icon: <FilePlus size={15} className="text-my-icon-tertiary" />,
      run: () => {
        // 无激活项目时先落到默认项目，再打开新建弹窗
        if (useMy.getState().activeProjectId === '') navigateProject('p-web')
        setCreateIssueOpen(true)
      }
    }
  ]

  // 过滤：label 大小写不敏感包含
  const kw = query.trim().toLowerCase()
  const filtered = kw ? items.filter((it) => it.label.toLowerCase().includes(kw)) : items
  const activeIndex = filtered.length > 0 ? Math.min(selectedIndex, filtered.length - 1) : 0

  // 打开时重置搜索词与选中项
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
    }
  }, [open])

  // 键盘：Esc 关闭 / ArrowDown-Up 循环移动 / Enter 执行（capture，先于输入框默认行为）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setPaletteOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (filtered.length > 0) setSelectedIndex((i) => (Math.min(i, filtered.length - 1) + 1) % filtered.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (filtered.length > 0) {
          setSelectedIndex((i) => (Math.min(i, filtered.length - 1) - 1 + filtered.length) % filtered.length)
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = filtered[activeIndex]
        if (item) {
          item.run()
          setPaletteOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, filtered, activeIndex, setPaletteOpen])

  if (!open) return null

  // 按分区聚合，行内保留扁平索引供键盘/hover 选中
  const groups = SECTION_ORDER.map((section) => ({
    section,
    rows: filtered.map((item, index) => ({ item, index })).filter((r) => r.item.section === section)
  })).filter((g) => g.rows.length > 0)

  return (
    <div className="my-fade fixed inset-0 z-[85] bg-my-backdrop pt-[14vh]" onMouseDown={() => setPaletteOpen(false)}>
      <div className="mx-auto w-[560px]">
        <div
          className="my-pop overflow-hidden rounded-xl border border-my-line bg-my-layer-2 shadow-[var(--my-shadow-overlay-200)]"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 搜索行 */}
          <div className="flex h-12 items-center gap-2 border-b border-my-line px-3">
            <Search size={15} className="shrink-0 text-my-icon-tertiary" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSelectedIndex(0)
              }}
              placeholder="搜索或输入命令…"
              className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-my-primary outline-none placeholder:text-my-placeholder"
            />
            <span className="my-kbd shrink-0">Esc</span>
          </div>
          {/* 结果列表 */}
          <div className="my-scrollbar max-h-[46vh] overflow-y-auto p-1.5">
            {groups.map((g) => (
              <div key={g.section}>
                <div className="px-2.5 pb-1 pt-2 text-[11px] text-my-tertiary">{g.section}</div>
                {g.rows.map(({ item, index }) => (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => {
                      item.run()
                      setPaletteOpen(false)
                    }}
                    ref={(el) => {
                      if (index === activeIndex) el?.scrollIntoView({ block: 'nearest' })
                    }}
                    className={clsx(
                      'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px]',
                      index === activeIndex ? 'bg-my-layer-1-active text-my-primary' : 'text-my-secondary'
                    )}
                  >
                    {item.icon}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint && <span className="shrink-0 text-[11px] text-my-tertiary">{item.hint}</span>}
                  </button>
                ))}
              </div>
            ))}
            {filtered.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-my-tertiary">无匹配结果</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
