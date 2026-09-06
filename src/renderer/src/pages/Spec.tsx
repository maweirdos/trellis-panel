import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  FileText,
  SquarePen,
  Save,
  RotateCcw,
  Link2,
  Eye
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { fmtBytes } from '../utils/format'
import type { JSX } from 'react'
import type { SpecNode } from '../../../shared/types'

function TreeItem({
  node,
  depth,
  selected,
  refCount,
  onSelect
}: {
  node: SpecNode
  depth: number
  selected: string | null
  refCount: Record<string, number> | null
  onSelect: (n: SpecNode) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(depth < 1)
  const isDir = node.type === 'dir'
  const refs = refCount?.[node.path]

  return (
    <div>
      <button
        onClick={() => {
          if (isDir) setExpanded((e) => !e)
          onSelect(node)
        }}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={clsx(
          'flex w-full items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-xs transition-colors',
          selected === node.path
            ? 'bg-leaf-dim/15 font-medium text-leaf-soft'
            : 'text-mist-300 hover:bg-ink-700/50 hover:text-mist-100'
        )}
      >
        {isDir ? (
          expanded ? (
            <ChevronDown size={12} className="shrink-0 text-mist-500" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-mist-500" />
          )
        ) : (
          <FileText size={12} className="shrink-0 text-mist-500" />
        )}
        <span className="truncate">{node.name}</span>
        {!isDir && refs !== undefined && (
          <span
            className={clsx(
              'ml-auto shrink-0 rounded px-1 text-[9.5px] font-mono',
              refs === 0 ? 'bg-ink-750 text-mist-600' : 'bg-leaf-dim/15 text-leaf-soft/90'
            )}
            title={refs === 0 ? '从未被引用（候选死规范）' : `被 ${refs} 处引用`}
          >
            {refs === 0 ? '未引用' : `${refs}`}
          </span>
        )}
      </button>
      {isDir && expanded && node.children?.map((c) => (
        <TreeItem key={c.path} node={c} depth={depth + 1} selected={selected} refCount={refCount} onSelect={onSelect} />
      ))}
    </div>
  )
}

function flattenFiles(nodes: SpecNode[]): SpecNode[] {
  const out: SpecNode[] = []
  const walk = (list: SpecNode[]): void => {
    for (const n of list) {
      if (n.type === 'file') out.push(n)
      else if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

export function SpecPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const pushToast = useApp((s) => s.pushToast)
  const [selected, setSelected] = useState<SpecNode | null>(null)
  const [state, setState] = useState<{ loading: boolean; content?: string; mtime?: number; error?: string }>({ loading: false })
  const [refCount, setRefCount] = useState<Record<string, number> | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const files = useMemo(() => flattenFiles(snapshot.spec), [snapshot.spec])

  const load = (n: SpecNode): void => {
    setSelected(n)
    setEditing(false)
    if (n.type !== 'file') return
    setState({ loading: true })
    api.readTextFile(n.path).then((res) => {
      if (res.ok) setState({ loading: false, content: res.content, mtime: res.mtime })
      else setState({ loading: false, error: res.error })
    })
  }

  const loadBacklinks = (): void => {
    api.specBacklinks().then((res) => {
      if (res.ok && res.counts) setRefCount(res.counts)
    })
  }

  useEffect(() => {
    if (files.length > 0) load(files[0])
    loadBacklinks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.meta.root])

  const relPath = selected?.path.replace(snapshot.meta.root + '\\', '').replace(snapshot.meta.root + '/', '') ?? ''

  const save = async (): Promise<void> => {
    if (!selected) return
    setSaving(true)
    const res = await api.writeSpecFile(selected.path, draft, state.mtime)
    setSaving(false)
    if (res.ok) {
      pushToast({ kind: 'success', title: '规范已保存', body: relPath })
      setEditing(false)
      setState((s) => ({ ...s, content: draft }))
      loadBacklinks()
    } else if (res.conflict) {
      pushToast({ kind: 'warn', title: '保存冲突', body: '文件已被外部修改，已重新加载' })
      load(selected)
    } else {
      pushToast({ kind: 'error', title: '保存失败', body: res.error })
    }
  }

  return (
    <div className="flex h-full animate-fade-in">
      <div className="w-72 shrink-0 overflow-y-auto border-r border-ink-700 bg-ink-850/40 p-2">
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-mist-500">
          .trellis/spec
          <button
            onClick={loadBacklinks}
            className="ml-auto text-mist-600 hover:text-mist-300"
            title="统计每个文档被任务/其他规范的引用次数"
          >
            <Link2 size={11} /> 引用
          </button>
        </div>
        {snapshot.spec.length === 0 && (
          <div className="px-2 py-6 text-center text-[11px] text-mist-500">没有规范文档</div>
        )}
        {snapshot.spec.map((n) => (
          <TreeItem key={n.path} node={n} depth={0} selected={selected?.path ?? null} refCount={refCount} onSelect={load} />
        ))}
      </div>

      <div className="relative min-w-0 flex-1 overflow-y-auto">
        {selected?.type === 'file' ? (
          <>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-700 bg-ink-900/90 px-5 py-2.5 backdrop-blur">
              <FileText size={13} className="text-leaf" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mist-300">{relPath}</span>
              {refCount?.[selected.path] !== undefined && (
                <span className="chip bg-ink-750 text-mist-400">
                  <Link2 size={10} /> 被引用 {refCount[selected.path]} 处
                </span>
              )}
              {selected.size !== undefined && <span className="text-[10.5px] text-mist-500">{fmtBytes(selected.size)}</span>}
              {!editing ? (
                <button onClick={() => { setDraft(state.content ?? ''); setEditing(true) }} className="btn-outline">
                  <SquarePen size={12} /> 编辑
                </button>
              ) : (
                <div className="flex gap-1.5">
                  <button onClick={() => setEditing(false)} className="btn-ghost">
                    <RotateCcw size={12} /> 取消
                  </button>
                  <button onClick={() => void save()} disabled={saving} className="btn-primary disabled:opacity-50">
                    <Save size={12} /> {saving ? '保存中…' : '保存'}
                  </button>
                </div>
              )}
            </div>

            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="h-[calc(100vh-140px)] w-full resize-none bg-ink-950/60 p-5 font-mono text-[12px] leading-5 text-mist-200 outline-none"
              />
            ) : (
              <div className="mx-auto max-w-3xl px-6 py-5">
                {state.loading && <div className="text-xs text-mist-500">加载中…</div>}
                {state.error && <div className="text-xs text-rose-300">{state.error}</div>}
                {!state.loading && !state.error && (
                  /\.(md|markdown)$/i.test(selected.name) ? (
                    <MarkdownView content={state.content ?? ''} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-mist-300">
                      {state.content}
                    </pre>
                  )
                )}
              </div>
            )}
          </>
        ) : (
          <div className="grid h-full place-items-center text-xs text-mist-500">
            <span className="flex items-center gap-1.5"><Eye size={13} /> 选择左侧文件查看 / 编辑</span>
          </div>
        )}
      </div>
    </div>
  )
}
