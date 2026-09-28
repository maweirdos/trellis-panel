import { useEffect, useRef, useState } from 'react'
import { ClipboardList, X, Trash2, Check, ChevronDown, ChevronUp, Split } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'

const DRAFT_KEY = 'trellis:quickTodoDraft'
const LIST_OPEN_KEY = 'trellis:quickTodoListOpen'

/** 标题取首个非空行，剥掉 markdown 前缀（#/列表符/序号），截断 60 字 */
function deriveTitle(text: string): string {
  const first = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? ''
  const clean = first
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.、)．]\s*/, '')
  return clean.slice(0, 60) || '速记待办'
}

/** 拆分候选：每个非空行各算一点（剥掉列表符/序号），>=2 行才可拆分 */
function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^[-*+]\s+\[[ xX]\]\s*/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+[.、)．]\s*/, '')
        .trim()
    )
    .filter((l) => l.length > 0)
}

/**
 * 速记窗视图（全局热键呼出的 Markdown 编辑窗，540x420）：
 * 多行 Markdown 记录测试问题/待办 → Ctrl+Enter 或「保存」整段一条落盘，
 * 或「拆分保存」每个非空行各存一条；Esc/失焦隐藏，草稿本地保留，不触碰主面板当前页面。
 */
export function QuickTodoView(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const todos = useApp((s) => s.todos)
  const loadTodos = useApp((s) => s.loadTodos)

  const [text, setText] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '')
  const [priority, setPriority] = useState('P2')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(() => localStorage.getItem(LIST_OPEN_KEY) !== 'false')
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    void loadTodos()
    textareaRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void api.closeQuickTodo()
    }
    window.addEventListener('keydown', onKey)
    // 窗口常驻复用（隐藏而非销毁），每次热键呼出后把焦点放回编辑区
    const offShown = api.onQuickTodoShown(() => textareaRef.current?.focus())
    return () => {
      window.removeEventListener('keydown', onKey)
      offShown()
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showToast = (msg: string): void => {
    setFlash(msg)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 1800)
  }

  const updateText = (next: string): void => {
    setText(next)
    try {
      localStorage.setItem(DRAFT_KEY, next)
    } catch {}
  }

  const points = splitLines(text)
  const canSave = text.trim().length > 0 && !!snapshot && !busy

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    const res = await api.todoSave({ title: deriveTitle(text), description: text.trim(), priority, source: 'manual' })
    setBusy(false)
    if (!res.ok) return
    updateText('')
    await loadTodos()
    showToast('已保存')
  }

  const saveSplit = async (): Promise<void> => {
    if (!canSave || points.length < 2) return
    setBusy(true)
    let ok = 0
    for (const line of points) {
      const res = await api.todoSave({ title: line.slice(0, 60), description: '', priority, source: 'manual' })
      if (res.ok) ok += 1
    }
    setBusy(false)
    if (ok === 0) return
    updateText('')
    await loadTodos()
    showToast(ok >= 2 ? `已拆分保存 ${ok} 条` : '已保存')
  }

  const remove = async (id: string): Promise<void> => {
    await api.todoDelete(id)
    await loadTodos()
  }

  const toggleList = (): void => {
    const next = !listOpen
    setListOpen(next)
    try {
      localStorage.setItem(LIST_OPEN_KEY, String(next))
    } catch {}
  }

  const pending = todos.filter((t) => t.status === 'pending')

  return (
    <div className="capsule-card flex h-full w-full flex-col overflow-hidden rounded-2xl border border-ink-600 bg-ink-850 text-mist-100 select-none">
      {/* 顶栏：可拖拽 + 折叠列表 + 关闭 */}
      <div className="drag-region flex shrink-0 items-center gap-1.5 border-b border-ink-700 bg-ink-800/90 px-3 py-2">
        <ClipboardList size={12} className="text-leaf" />
        <span className="text-[11px] font-semibold text-leaf-soft">速记待办</span>
        {snapshot && (
          <span className="max-w-[140px] truncate text-[10px] text-mist-400" title={snapshot.meta.name}>
            · {snapshot.meta.name}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-mist-400">{pending.length} 条待处理</span>
        <button
          onClick={toggleList}
          className="no-drag btn-ghost p-1 text-mist-400 hover:text-mist-100"
          title={listOpen ? '收起最近待办' : '展开最近待办'}
        >
          {listOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <button
          onClick={() => void api.closeQuickTodo()}
          className="no-drag btn-ghost p-1 text-mist-400 hover:text-rose-400"
          title="隐藏 (Esc)"
        >
          <X size={12} />
        </button>
      </div>

      {/* Markdown 编辑区 */}
      <textarea
        ref={textareaRef}
        value={text}
        disabled={!snapshot}
        onChange={(e) => updateText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            void save()
          }
        }}
        placeholder={
          snapshot
            ? '随手记录，支持多行 Markdown，如：\n1. 切换药品后未清除免试标识\n2. 皮试医嘱没有开嘱时间\n\nCtrl+Enter 保存 · 每行可拆分为独立待办'
            : '未打开项目 — 先在主面板打开项目'
        }
        className="no-drag min-h-0 flex-1 resize-none bg-transparent px-3.5 py-2.5 text-[12.5px] leading-relaxed text-mist-100 placeholder:text-mist-600 focus:outline-none select-text"
        spellCheck={false}
      />

      {/* 最近待办列表（可折叠） */}
      {listOpen && (
        <div className="max-h-[112px] shrink-0 overflow-y-auto border-t border-ink-700/70 px-2 py-1.5">
          {pending.length === 0 ? (
            <div className="py-2 text-center text-[11px] text-mist-600">
              {snapshot ? '暂无待处理待办' : '打开项目后即可随手速记'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {pending.slice(0, 8).map((t) => (
                <div
                  key={t.id}
                  className="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-ink-800/80"
                  title={t.title}
                >
                  <span
                    className={clsx(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      t.priority === 'P0'
                        ? 'bg-rose-400'
                        : t.priority === 'P1'
                          ? 'bg-orange-400'
                          : t.priority === 'P3'
                            ? 'bg-mist-600'
                            : 'bg-leaf-dim'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-mist-200">{t.title}</span>
                  <span className="shrink-0 font-mono text-[9.5px] text-mist-600">{t.createdAt}</span>
                  <button
                    onClick={() => void remove(t.id)}
                    className="no-drag shrink-0 p-0.5 text-mist-600 opacity-0 transition-opacity hover:text-rose-400 group-hover:opacity-100"
                    title="删除"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 底栏：优先级 + 保存动作 */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-ink-700 bg-ink-800/60 px-3 py-2">
        {(
          [
            ['P0', 'text-rose-300'],
            ['P1', 'text-orange-300'],
            ['P2', 'text-mist-200'],
            ['P3', 'text-mist-400']
          ] as const
        ).map(([p, tone]) => (
          <button
            key={p}
            onClick={() => setPriority(p)}
            disabled={!snapshot}
            className={clsx(
              'no-drag rounded px-1.5 py-0.5 font-mono text-[10px] disabled:opacity-40',
              priority === p ? 'bg-ink-600 ring-1 ring-leaf-dim/60' : 'hover:text-mist-200',
              tone
            )}
          >
            {p}
          </button>
        ))}

        <span className="ml-2 flex items-center gap-1 text-[10px] text-mist-500">
          {flash ? (
            <span className="flex items-center gap-1 text-leaf animate-fade-in">
              <Check size={11} /> {flash}
            </span>
          ) : (
            <>Ctrl+Enter 保存 · Esc 隐藏</>
          )}
        </span>

        <button
          onClick={() => void saveSplit()}
          disabled={!canSave || points.length < 2}
          className="btn-outline no-drag ml-auto px-2 py-1 text-[11px] disabled:opacity-35"
          title="每个非空行各存一条待办（适合逐点转任务）"
        >
          <Split size={11} className="mr-1 inline" />
          {points.length >= 2 ? `拆分保存 ${points.length} 条` : '拆分保存'}
        </button>
        <button
          onClick={() => void save()}
          disabled={!canSave}
          className="btn-primary no-drag px-2.5 py-1 text-[11px] disabled:opacity-50"
          title="整段存为一条待办（首行作标题）"
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
