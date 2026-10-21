import { useEffect, useRef, useState } from 'react'
import { ClipboardList, X, Trash2, Check, ChevronDown, ChevronUp, Split } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { Button } from '../my/ui'
import { clsx } from 'clsx'
import { errorMessage } from '../../../shared/errors'
import { FloatingFrame, FloatingIconButton, readFloatingPreference, writeFloatingPreference } from './FloatingWindow'
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

  const [text, setText] = useState(() => readFloatingPreference(DRAFT_KEY) ?? '')
  const [priority, setPriority] = useState('P2')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(() => readFloatingPreference(LIST_OPEN_KEY) !== 'false')
  const saveLock = useRef(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const projectRoot = snapshot?.meta.root

  useEffect(() => {
    if (projectRoot) textareaRef.current?.focus()
  }, [projectRoot])

  useEffect(() => {
    void loadTodos().catch((cause: unknown) => setError(errorMessage(cause) ?? '收件箱加载失败，请重试'))
    textareaRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void api.closeQuickTodo()
    }
    window.addEventListener('keydown', onKey)
    // 窗口常驻复用（隐藏而非销毁），每次热键呼出后把焦点放回编辑区
    const offShown = api.onQuickTodoShown(() => { textareaRef.current?.focus(); void loadTodos().catch((cause: unknown) => setError(errorMessage(cause) ?? '收件箱加载失败，请重试')) })
    const offSnapshot = api.onSnapshotUpdated((next) => useApp.getState().setSnapshot(next))
    return () => {
      window.removeEventListener('keydown', onKey)
      offShown()
      offSnapshot()
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
    writeFloatingPreference(DRAFT_KEY, next)
  }

  const points = splitLines(text)
  const canSave = text.trim().length > 0 && !!snapshot && !busy

  const save = async (): Promise<void> => {
    if (!canSave || saveLock.current) return
    saveLock.current = true
    setBusy(true)
    setError(null)
    try {
      const res = await api.todoSave({ title: deriveTitle(text), description: text.trim(), priority, source: 'manual' })
      if (!res.ok) throw new Error(res.error || '保存失败，请重试')
      updateText('')
      showToast('已保存到收件箱')
      await loadTodos()
    } catch (cause) { setError(errorMessage(cause) ?? '保存失败，请重试') } finally { saveLock.current = false; setBusy(false) }
  }

  const saveSplit = async (): Promise<void> => {
    if (!canSave || points.length < 2 || saveLock.current) return
    saveLock.current = true
    setBusy(true)
    setError(null)
    let ok = 0
    const remaining: string[] = []
    try {
      for (const line of points) {
        try {
          const res = await api.todoSave({ title: line.slice(0, 60), description: line, priority, source: 'manual' })
          if (res.ok) ok += 1
          else remaining.push(line)
        } catch { remaining.push(line) }
      }
      // Failed lines remain editable so a partial save never discards the draft.
      updateText(remaining.join('\n'))
      if (ok) showToast(`已保存 ${ok} 条`)
      if (remaining.length) setError(`${remaining.length} 条未保存，已保留在编辑区，请重试。`)
      await loadTodos()
    } catch (cause) { setError(errorMessage(cause) ?? '拆分保存失败，请重试') } finally { saveLock.current = false; setBusy(false) }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      const result = await api.todoDelete(id)
      if (!result.ok) throw new Error(result.error || '删除失败')
      await loadTodos()
    } catch (cause) { setError(errorMessage(cause) ?? '删除失败，请重试') }
  }

  const toggleList = (): void => {
    const next = !listOpen
    setListOpen(next)
    writeFloatingPreference(LIST_OPEN_KEY, String(next))
  }

  const pending = todos.filter((t) => t.status === 'pending')

  return (
    <FloatingFrame>
      {/* 顶栏：可拖拽 + 折叠列表 + 关闭 */}
      <div className="drag-region my-floating-header">
        <ClipboardList size={16} className="shrink-0 text-my-icon-secondary" />
        <span className="shrink-0 text-my-sm font-medium">速记待办</span>
        <span className="min-w-0 flex-1 truncate text-my-xs text-my-secondary" title={snapshot?.meta.name}>{snapshot?.meta.name ?? '未打开项目'}</span>
        <FloatingIconButton onClick={toggleList} aria-expanded={listOpen} label={listOpen ? '收起最近待办' : '展开最近待办'}>
          {listOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </FloatingIconButton>
        <FloatingIconButton
          onClick={() => void api.closeQuickTodo()}
          label="隐藏速记待办 (Esc)"
        >
          <X size={12} />
        </FloatingIconButton>
      </div>

      {/* Markdown 编辑区 */}
      <textarea
        ref={textareaRef}
        value={text}
        disabled={!snapshot || busy}
        aria-label="待办内容"
        onChange={(e) => updateText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            void save()
          }
        }}
        placeholder={
          snapshot
            ? '记下想法、问题或下一步行动…\n\n支持 Markdown，多行内容可拆分为独立待办。'
            : '未打开项目 — 先在主面板打开项目'
        }
        className="my-floating-editor no-drag min-h-0 flex-1 resize-none bg-transparent text-my-md leading-relaxed text-my-primary placeholder:text-my-placeholder select-text"
        spellCheck={false}
      />

      {/* 最近待办列表（可折叠） */}
      {listOpen && (
        <div className="my-floating-recent my-scrollbar">
          <div className="mb-1 flex justify-between px-2 text-my-xs text-my-secondary"><span>待处理</span><span className="tabular-nums">{pending.length}</span></div>
          {pending.length === 0 ? (
            <div className="py-2 text-center text-my-xs text-my-tertiary">
              {snapshot ? '暂无待处理待办' : '打开项目后即可随手速记'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {pending.slice(0, 8).map((t) => (
                <div
                  key={t.id}
                  className="group flex items-center gap-2 rounded-my-md px-2 py-1 hover:bg-my-layer-2-hover"
                  title={t.title}
                >
                  <span
                    className={clsx(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      t.priority === 'P0'
                        ? 'bg-my-urgent'
                        : t.priority === 'P1'
                          ? 'bg-my-high'
                          : t.priority === 'P3'
                            ? 'bg-my-low'
                            : 'bg-my-medium'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-my-xs text-my-primary">{t.title}</span>
                  <FloatingIconButton
                    onClick={() => void remove(t.id)}
                    label={`删除待办：${t.title}`}
                  >
                    <Trash2 size={11} />
                  </FloatingIconButton>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 底栏：优先级 + 保存动作 */}
      <div className="my-floating-feedback" role={error ? 'alert' : 'status'}>
        {error ? <span className="text-my-danger-text">{error}</span> : flash ? <span className="flex items-center gap-1 text-my-success-text"><Check size={13} />{flash}</span> : 'Ctrl+Enter 保存 · Esc 隐藏 · 草稿自动保留'}
      </div>
      <div className="my-floating-footer flex-wrap gap-y-2">
        <div className="my-segmented" role="group" aria-label="待办优先级">
        {(
          [
            ['P0', 'text-my-urgent'],
            ['P1', 'text-my-high'],
            ['P2', 'text-my-medium'],
            ['P3', 'text-my-low']
          ] as const
        ).map(([p, tone]) => (
          <button
            key={p}
            onClick={() => setPriority(p)}
            disabled={!snapshot || busy}
            aria-pressed={priority === p}
            title={`优先级 ${p}`}
            className={clsx(
              'no-drag my-segment font-mono disabled:opacity-40',
              tone
            )}
          >
            {p}
          </button>
        ))}

        </div>
        <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void saveSplit()}
          disabled={!canSave || points.length < 2}
          className="no-drag ml-auto"
          title="每个非空行各存一条待办（适合逐点转任务）"
        >
          <Split size={11} className="mr-1 inline" />
          {points.length >= 2 ? `拆分保存 ${points.length} 条` : '拆分保存'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={!canSave}
          className="no-drag"
          title="整段存为一条待办（首行作标题）"
        >
          {busy ? '保存中…' : '保存'}
        </Button>
        </div>
      </div>
    </FloatingFrame>
  )
}
