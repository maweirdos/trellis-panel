import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  FileText,
  SquarePen,
  Save,
  RotateCw,
  Link2,
  Eye,
  Search,
  NotebookPen,
  Share2,
  BookOpenText,
  FolderOpen,
  Copy
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { fmtBytes, relTime } from '../utils/format'
import type { JSX } from 'react'
import type { DocSearchHit, SpecNode } from '../../../shared/types'

/**
 * 规范文档（项目文档统一入口）：
 * - 规范树：查看 / 编辑 + 引用统计
 * - 全文检索：跨 规范 / 工作区日志 / 共享索引（搜索时左栏切换为命中列表）
 * - 非规范文档只读，规范文档可编辑
 */

const GROUP_META: Record<DocSearchHit['group'], { label: string; icon: JSX.Element }> = {
  spec: { label: '规范文档', icon: <BookOpenText size={12} /> },
  workspace: { label: '工作区日志', icon: <NotebookPen size={12} /> },
  shared: { label: '共享索引', icon: <Share2 size={12} /> }
}

const GROUP_ORDER: DocSearchHit['group'][] = ['spec', 'workspace', 'shared']

/** snippet 用 \u0000 \u0001 标记命中区间，这里转成高亮 */
function Snippet({ text }: { text: string }): JSX.Element {
  const parts = text.split(/[\u0000\u0001]/)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-leaf-dim/25 px-0.5 text-leaf-soft">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

/* ---------------- 左栏条目 ---------------- */

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

/** 阅读器当前选中的文件：规范（可编辑）或 日志/共享/命中（只读） */
interface SelectedDoc {
  path: string
  name: string
  group: DocSearchHit['group']
  size: number
  mtime: number
}

export function SpecPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const pushToast = useApp((s) => s.pushToast)

  /* 检索 */
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'spec' | 'workspace'>('all')
  const [hits, setHits] = useState<DocSearchHit[]>([])
  const [searching, setSearching] = useState(false)

  /* 选中与阅读/编辑 */
  const [specSelected, setSpecSelected] = useState<SpecNode | null>(null)
  const [docSelected, setDocSelected] = useState<SelectedDoc | null>(null)
  const [state, setState] = useState<{ loading: boolean; content?: string; mtime?: number; error?: string }>({ loading: false })
  const [refCount, setRefCount] = useState<Record<string, number> | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  const files = useMemo(() => flattenFiles(snapshot.spec), [snapshot.spec])

  /* 检索：空 query = 浏览态（规范树 + 工作区日志） */
  useEffect(() => {
    let alive = true
    setSearching(true)
    const t = setTimeout(() => {
      api.docsSearch(query, scope).then((res) => {
        if (!alive) return
        setSearching(false)
        setHits(res.ok ? res.hits ?? [] : [])
      })
    }, query ? 200 : 0)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, scope, snapshot.scannedAt])

  const loadSpec = (n: SpecNode): void => {
    setSpecSelected(n)
    setDocSelected(null)
    setEditing(false)
    if (n.type !== 'file') return
    setState({ loading: true })
    api.readTextFile(n.path).then((res) => {
      if (res.ok) setState({ loading: false, content: res.content, mtime: res.mtime })
      else setState({ loading: false, error: res.error })
    })
  }

  const loadDoc = (d: SelectedDoc): void => {
    setSpecSelected(null)
    setDocSelected(d)
    setEditing(false)
    setState({ loading: true })
    api.readTextFile(d.path).then((res) => {
      if (res.ok) setState({ loading: false, content: res.content })
      else setState({ loading: false, error: res.error })
    })
  }

  const loadBacklinks = (): void => {
    api.specBacklinks().then((res) => {
      if (res.ok && res.counts) setRefCount(res.counts)
    })
  }

  useEffect(() => {
    if (files.length > 0) loadSpec(files[0])
    loadBacklinks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.meta.root])

  const selected = specSelected ?? docSelected
  const relPath = specSelected?.path.replace(snapshot.meta.root + '\\', '').replace(snapshot.meta.root + '/', '') ?? ''

  const save = async (): Promise<void> => {
    if (!specSelected || specSelected.type !== 'file') return
    setSaving(true)
    const res = await api.writeSpecFile(specSelected.path, draft, state.mtime)
    setSaving(false)
    if (res.ok) {
      pushToast({ kind: 'success', title: '规范已保存', body: relPath })
      setEditing(false)
      setState((s) => ({ ...s, content: draft }))
      loadBacklinks()
    } else if (res.conflict) {
      pushToast({ kind: 'warn', title: '保存冲突', body: '文件已被外部修改，已重新加载' })
      loadSpec(specSelected)
    } else {
      pushToast({ kind: 'error', title: '保存失败', body: res.error })
    }
  }

  const copyContent = async (): Promise<void> => {
    await api.copyToClipboard(state.content ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const groupedHits = useMemo(() => {
    const map = new Map<DocSearchHit['group'], DocSearchHit[]>()
    for (const h of hits) {
      const list = map.get(h.group) ?? []
      list.push(h)
      map.set(h.group, list)
    }
    return map
  }, [hits])

  const searching_ = query.trim().length > 0

  return (
    <div className="flex h-full animate-fade-in">
      {/* 左栏：检索 + 规范树 / 命中列表 / 工作区日志 */}
      <div className="flex w-80 shrink-0 flex-col border-r border-ink-700 bg-ink-850/40">
        <div className="space-y-2 border-b border-ink-700 p-2.5">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="全文搜索规范 / 日志 / 共享文档…"
              className="field w-full pl-8"
            />
          </div>
          {searching_ && (
            <div className="flex items-center gap-1">
              {(
                [
                  ['all', '全部'],
                  ['spec', '规范'],
                  ['workspace', '工作区']
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setScope(v)}
                  className={clsx(
                    'rounded-md px-2 py-0.5 text-[11px] transition-colors',
                    scope === v ? 'bg-leaf-dim/20 text-leaf-soft' : 'text-mist-400 hover:bg-ink-700/40 hover:text-mist-200'
                  )}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto text-[10.5px] text-mist-500">
                {searching ? '检索中…' : `${hits.length} 篇命中`}
              </span>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {searching_ ? (
            /* 搜索态：跨来源命中列表 */
            <>
              {!searching && hits.length === 0 && (
                <div className="px-2 py-8 text-center text-[11px] text-mist-500">没有匹配的文档</div>
              )}
              {GROUP_ORDER.filter((g) => groupedHits.has(g)).map((g) => (
                <div key={g} className="mb-2">
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-mist-500">
                    {GROUP_META[g].icon} {GROUP_META[g].label}
                    <span className="ml-auto font-mono font-normal">{groupedHits.get(g)!.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {groupedHits.get(g)!.map((h) => (
                      <button
                        key={h.path}
                        onClick={() => loadDoc(h)}
                        title={h.path}
                        className={clsx(
                          'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                          selected?.path === h.path
                            ? 'border-leaf-dim/40 bg-leaf-dim/10'
                            : 'border-transparent hover:border-ink-600 hover:bg-ink-750/50'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <FileText size={12} className="shrink-0 text-leaf/80" />
                          <span className="min-w-0 flex-1 truncate text-[11.5px] text-mist-200">{h.name}</span>
                          <span className="shrink-0 text-[10px] text-mist-600">{relTime(h.mtime)}</span>
                        </div>
                        {h.snippet && (
                          <div className="mt-1 line-clamp-2 pl-5 text-[10.5px] leading-4 text-mist-500">
                            <Snippet text={h.snippet} />
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </>
          ) : (
            /* 浏览态：规范树 + 工作区日志 */
            <>
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
                <div className="px-2 py-4 text-center text-[11px] text-mist-500">没有规范文档</div>
              )}
              {snapshot.spec.map((n) => (
                <TreeItem key={n.path} node={n} depth={0} selected={selected?.path ?? null} refCount={refCount} onSelect={loadSpec} />
              ))}

              {snapshot.developers.length > 0 && (
                <div className="mt-3">
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-mist-500">
                    <NotebookPen size={11} /> 工作区日志
                  </div>
                  {snapshot.developers.map((d) => (
                    <div key={d.name} className="mb-1">
                      <div className="px-2 py-1 text-[11px] text-mist-400">
                        {d.name} <span className="text-mist-600">· {relTime(d.lastActive)}</span>
                      </div>
                      {[...d.journals, ...d.otherFiles].map((f) => (
                        <button
                          key={f.path}
                          onClick={() =>
                            loadDoc({ path: f.path, name: f.name, group: 'workspace', size: f.size, mtime: f.mtime })
                          }
                          className={clsx(
                            'flex w-full items-center gap-2 rounded-md py-[5px] pl-6 pr-2 text-left text-[11.5px] transition-colors',
                            selected?.path === f.path
                              ? 'bg-leaf-dim/15 text-leaf-soft'
                              : 'text-mist-300 hover:bg-ink-700/40 hover:text-mist-100'
                          )}
                        >
                          <NotebookPen size={11} className="shrink-0 text-mist-500" />
                          <span className="min-w-0 flex-1 truncate">{f.name}</span>
                          <span className="shrink-0 text-[9.5px] text-mist-600">{fmtBytes(f.size)}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {snapshot.sharedWorkspaceFiles.length > 0 && (
                <div className="mt-2">
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-mist-500">
                    <Share2 size={11} /> 共享索引
                  </div>
                  {snapshot.sharedWorkspaceFiles.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => loadDoc({ path: f.path, name: f.name, group: 'shared', size: f.size, mtime: f.mtime })}
                      className={clsx(
                        'flex w-full items-center gap-2 rounded-md py-[5px] pl-6 pr-2 text-left text-[11.5px] transition-colors',
                        selected?.path === f.path
                          ? 'bg-leaf-dim/15 text-leaf-soft'
                          : 'text-mist-300 hover:bg-ink-700/40 hover:text-mist-100'
                      )}
                    >
                      <FileText size={11} className="shrink-0 text-mist-500" />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 右栏：阅读 / 编辑 */}
      <div className="relative min-w-0 flex-1 overflow-y-auto">
        {selected && specSelected?.type !== 'dir' ? (
          <>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-700 bg-ink-900/90 px-5 py-2.5 backdrop-blur">
              {docSelected ? (
                GROUP_META[docSelected.group].icon
              ) : (
                <FileText size={13} className="text-leaf" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mist-300">
                {docSelected ? docSelected.name : relPath}
              </span>
              {docSelected && <span className="chip bg-ink-750 text-[10px] text-mist-400">{GROUP_META[docSelected.group].label}</span>}
              {!docSelected && refCount?.[specSelected!.path] !== undefined && (
                <span className="chip bg-ink-750 text-mist-400">
                  <Link2 size={10} /> 被引用 {refCount[specSelected!.path]} 处
                </span>
              )}
              <span className="text-[10.5px] text-mist-500">
                {fmtBytes(docSelected ? docSelected.size : (specSelected?.size ?? 0))}
              </span>
              <button onClick={() => void copyContent()} className="btn-ghost px-1.5 py-1" title="复制全文">
                <Copy size={12} /> {copied ? '已复制' : ''}
              </button>
              <button
                onClick={() => api.revealInExplorer(selected.path)}
                className="btn-ghost px-1.5 py-1"
                title="在资源管理器中显示"
              >
                <FolderOpen size={12} />
              </button>
              {!docSelected && specSelected?.type === 'file' &&
                (!editing ? (
                  <button onClick={() => { setDraft(state.content ?? ''); setEditing(true) }} className="btn-outline">
                    <SquarePen size={12} /> 编辑
                  </button>
                ) : (
                  <div className="flex gap-1.5">
                    <button onClick={() => setEditing(false)} className="btn-ghost">
                      <RotateCw size={12} /> 取消
                    </button>
                    <button onClick={() => void save()} disabled={saving} className="btn-primary disabled:opacity-50">
                      <Save size={12} /> {saving ? '保存中…' : '保存'}
                    </button>
                  </div>
                ))}
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
            <span className="flex items-center gap-1.5"><Eye size={13} /> 选择左侧文件查看；或全文搜索跨文档定位</span>
          </div>
        )}
      </div>
    </div>
  )
}
