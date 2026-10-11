import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, type Page } from '../store'
import { clsx } from 'clsx'
import type { JSX } from 'react'

interface Cmd {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

/**
 * 全局命令面板（Ctrl+K）：页面跳转、任务搜索、常用动作。
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const snapshot = useApp((s) => s.snapshot)
  const setPage = useApp((s) => s.setPage)
  const showTask = useApp((s) => s.showTask)
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
  const refresh = useApp((s) => s.refresh)
  const toggleTheme = useApp((s) => s.toggleTheme)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  const cmds = useMemo<Cmd[]>(() => {
    const out: Cmd[] = []
    const pages: Array<[Page, string]> = [
      ['dashboard', '概览'],
      ['inbox', '待处理'],
      ['tasks', '任务看板'],
      ['knowledge', '知识库'],
      ['spec', '规范文档'],
      ['archive', '归档'],
      ['channels', 'AI 频道'],
      ['team', '团队协作'],
      ['jira', 'Jira'],
      ['architecture', '架构图'],
      ['studio', '定制中心'],
      ['chat', 'AI 对话'],
      ['acp', 'Agent 会话'],
      ['settings', '设置']
    ]
    for (const [p, label] of pages) {
      out.push({ id: `page:${p}`, label, group: '页面', hint: '跳转', run: () => setPage(p) })
    }
    if (snapshot) {
      for (const t of snapshot.tasks.slice(0, 200)) {
        out.push({
          id: `task:${t.dirName}`,
          label: t.record?.title ?? t.dirName,
          hint: t.dirName,
          group: '任务',
          run: () => {
            setPage('tasks')
            showTask(t.dirName)
          }
        })
      }
      out.push({ id: 'action:intake', label: '新建待办', group: '动作', run: () => { setPage('tasks'); setIntakeOpen(true) } })
      out.push({ id: 'action:refresh', label: '重新扫描', group: '动作', run: () => void refresh() })
      out.push({ id: 'action:theme', label: '切换主题', group: '动作', run: () => toggleTheme() })
    }
    return out
  }, [snapshot, setPage, showTask, setIntakeOpen, refresh, toggleTheme])

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return cmds.filter((c) => c.group !== '任务').concat(cmds.filter((c) => c.group === '任务').slice(0, 8))
    return cmds
      .filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(query))
      .slice(0, 24)
  }, [cmds, q])

  useEffect(() => setIdx(0), [q])

  if (!open) return null

  const exec = (c?: Cmd): void => {
    if (!c) return
    c.run()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-ink-950/60 pt-[14vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, filtered.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)) }
            else if (e.key === 'Enter') { e.preventDefault(); exec(filtered[idx]) }
            else if (e.key === 'Escape') onClose()
          }}
          placeholder="搜索页面、任务，或执行动作…"
          className="w-full border-0 border-b border-ink-700 bg-transparent px-4 py-3 text-sm text-mist-100 outline-none placeholder:text-mist-600"
        />
        <div className="max-h-80 overflow-y-auto p-1.5">
          {filtered.map((c, i) => {
            const showGroup = i === 0 || filtered[i - 1].group !== c.group
            return (
              <div key={c.id}>
                {showGroup && <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-mist-600">{c.group}</div>}
                <button
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => exec(c)}
                  className={clsx(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px]',
                    i === idx ? 'bg-leaf-dim/15 text-leaf-soft' : 'text-mist-300'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="shrink-0 font-mono text-[10px] text-mist-600">{c.hint}</span>}
                </button>
              </div>
            )
          })}
          {filtered.length === 0 && <div className="py-8 text-center text-xs text-mist-600">无匹配</div>}
        </div>
      </div>
    </div>
  )
}
