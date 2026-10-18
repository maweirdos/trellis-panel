import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  FileText,
  SquarePen,
  Save,
  RotateCw,
  Link2,
  Eye,
  NotebookPen,
  Share2,
  BookOpenText,
  FolderOpen,
  Copy,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { DocumentReader } from '../reader/DocumentReader'
import { relativePathUnderRoot } from '../reader/reader-paths'
import { readingSessionKey } from '../reader/reading-session'
import { projectRootKey } from '../my/navigation'
import { Button, SearchInput } from '../my/ui'
import { useMy } from '../my/store'
import { SidebarResizeHandle, useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
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
          <mark key={i} className="rounded-my-sm bg-my-accent-subtle px-0.5 text-my-accent-text">
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
        type="button"
        onClick={() => {
          if (isDir) setExpanded((e) => !e)
          onSelect(node)
        }}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={clsx(
          'flex w-full items-center gap-1.5 rounded-my-md py-[5px] pr-2 text-left text-my-xs transition-colors',
          selected === node.path
            ? 'bg-my-accent-subtle font-medium text-my-accent-text'
            : 'text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary'
        )}
      >
        {isDir ? (
          expanded ? (
            <ChevronDown size={12} className="shrink-0 text-my-icon-tertiary" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-my-icon-tertiary" />
          )
        ) : (
          <FileText size={12} className="shrink-0 text-my-icon-tertiary" />
        )}
        <span className="truncate">{node.name}</span>
        {!isDir && refs !== undefined && (
          <span
            className={clsx(
              'ml-auto shrink-0 rounded-my-sm px-1 text-my-2xs font-mono',
              refs === 0 ? 'bg-my-layer-3 text-my-tertiary' : 'bg-my-accent-subtle text-my-accent-text'
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
  const sidebarStyle = useSidebarWidthStyle()
  const sidebarCollapsed = useMy((state) => state.sidebarCollapsed)
  const toggleSidebar = useMy((state) => state.toggleSidebar)
  const snapshot = useApp((s) => s.snapshot)
  const pushToast = useApp((s) => s.pushToast)

  /* 检索 */
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'spec' | 'workspace'>('all')
  const [hits, setHits] = useState<DocSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  /* 选中与阅读/编辑 */
  const [specSelected, setSpecSelected] = useState<SpecNode | null>(null)
  const [docSelected, setDocSelected] = useState<SelectedDoc | null>(null)
  const [state, setState] = useState<{ loading: boolean; content?: string; mtime?: number; error?: string }>({ loading: false })
  const [refCount, setRefCount] = useState<Record<string, number> | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const browserVisible = !sidebarCollapsed
  const pageRef = useRef<HTMLDivElement | null>(null)
  const readerRef = useRef<HTMLDivElement | null>(null)
  const readSeq = useRef(0)

  const files = useMemo(() => flattenFiles(snapshot?.spec ?? []), [snapshot?.spec])

  /* 检索：空 query = 浏览态（规范树 + 工作区日志） */
  useEffect(() => {
    if (!hasIpc) return
    let alive = true
    setSearching(true)
    setSearchError(null)
    const t = setTimeout(() => {
      api.docsSearch(query, scope).then((res) => {
        if (!alive) return
        setSearching(false)
        setHits(res.ok ? res.hits ?? [] : [])
        setSearchError(res.ok ? null : res.error ?? '文档检索失败')
      }).catch((error: unknown) => {
        if (!alive) return
        setSearching(false)
        setSearchError(error instanceof Error ? error.message : '文档检索失败')
      })
    }, query ? 200 : 0)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, scope, snapshot?.scannedAt])

  const focusReader = (): void => {
    if ((pageRef.current?.clientWidth ?? 0) < 1000) {
      if (!useMy.getState().sidebarCollapsed) useMy.getState().toggleSidebar()
      requestAnimationFrame(() => readerRef.current?.focus({ preventScroll: true }))
    }
  }

  const loadSpec = (n: SpecNode): void => {
    const seq = ++readSeq.current
    setSpecSelected(n)
    setDocSelected(null)
    setEditing(false)
    if (n.type !== 'file') {
      setState({ loading: false })
      return
    }
    focusReader()
    setState({ loading: true })
    api.readTextFile(n.path).then((res) => {
      if (seq !== readSeq.current) return
      if (res.ok) setState({ loading: false, content: res.content, mtime: res.mtime })
      else setState({ loading: false, error: res.error })
    }).catch((error: unknown) => {
      if (seq === readSeq.current) setState({ loading: false, error: error instanceof Error ? error.message : '读取失败' })
    })
  }

  const loadDoc = (d: SelectedDoc): void => {
    const node = d.group === 'spec' ? files.find((file) => file.path === d.path) : undefined
    if (node) {
      loadSpec(node)
      return
    }
    const seq = ++readSeq.current
    setSpecSelected(null)
    setDocSelected(d)
    setEditing(false)
    focusReader()
    setState({ loading: true })
    api.readTextFile(d.path).then((res) => {
      if (seq !== readSeq.current) return
      if (res.ok) setState({ loading: false, content: res.content })
      else setState({ loading: false, error: res.error })
    }).catch((error: unknown) => {
      if (seq === readSeq.current) setState({ loading: false, error: error instanceof Error ? error.message : '读取失败' })
    })
  }

  const loadBacklinks = (): void => {
    api.specBacklinks().then((res) => {
      if (res.ok && res.counts) setRefCount(res.counts)
    })
  }

  useEffect(() => {
    if (!hasIpc) return
    const target = useApp.getState().consumeSpecDocumentTarget()
    const root = snapshot?.meta.root
    const targetRelative = target && root ? relativePathUnderRoot(root, target.path) : null
    const validTarget = target && root && projectRootKey(target.projectRoot) === projectRootKey(root) &&
      targetRelative !== null && !targetRelative.split('/').includes('..')
    if (validTarget) {
      const node = files.find((file) => file.path === target.path)
      if (node) loadSpec(node)
      else loadDoc({ path: target.path, name: target.path.replace(/\\/g, '/').split('/').pop() ?? target.path, group: 'spec', size: 0, mtime: 0 })
    } else if (files.length > 0) loadSpec(files[0])
    loadBacklinks()
    return () => { readSeq.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.meta?.root])

  const selected = specSelected ?? docSelected
  const relPath = snapshot && specSelected ? specSelected.path.replace(snapshot.meta.root + '\\', '').replace(snapshot.meta.root + '/', '') : ''
  const relativePath = selected ? relativePathUnderRoot(snapshot?.meta.root ?? '', selected.path) : null
  const sessionKey = selected && relativePath !== null && snapshot ? readingSessionKey({ workspaceId: snapshot.meta.root }, relativePath) : null
  const displayedText = useApp((s) => sessionKey ? s.readingSessions[sessionKey]?.displayed?.text : undefined)

  const startEditing = async (): Promise<void> => {
    if (specSelected?.type !== 'file') return
    const seq = ++readSeq.current
    try {
      const res = await api.readTextFile(specSelected.path)
      if (seq !== readSeq.current) return
      if (!res.ok || res.content === undefined) {
        pushToast({ kind: 'error', title: '无法进入编辑', body: res.error ?? '读取失败' })
        return
      }
      setState({ loading: false, content: res.content, mtime: res.mtime })
      setDraft(res.content)
      setEditing(true)
    } catch (error) {
      if (seq === readSeq.current) pushToast({ kind: 'error', title: '无法进入编辑', body: error instanceof Error ? error.message : '读取失败' })
    }
  }

  const save = async (): Promise<void> => {
    if (!specSelected || specSelected.type !== 'file') return
    const seq = readSeq.current
    const savingNode = specSelected
    const savingDraft = draft
    setSaving(true)
    try {
      const res = await api.writeSpecFile(savingNode.path, savingDraft, state.mtime)
      if (seq !== readSeq.current) return
      if (res.ok) {
        pushToast({ kind: 'success', title: '规范已保存', body: relPath })
        setEditing(false)
        setState((s) => ({ ...s, content: savingDraft }))
        loadBacklinks()
      } else if (res.conflict) {
        pushToast({ kind: 'warn', title: '保存冲突', body: '文件已被外部修改，已重新加载' })
        loadSpec(savingNode)
      } else {
        pushToast({ kind: 'error', title: '保存失败', body: res.error })
      }
    } catch (error) {
      if (seq === readSeq.current) pushToast({ kind: 'error', title: '保存失败', body: error instanceof Error ? error.message : '写入失败' })
    } finally {
      setSaving(false)
    }
  }

  const copyContent = async (): Promise<void> => {
    await api.copyToClipboard(displayedText ?? state.content ?? '')
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
    <div ref={pageRef} className="my-fade flex h-full min-h-0 min-w-0 flex-col bg-my-surface-1">
      <div className="flex shrink-0 items-center gap-3 border-b border-my-line px-4 py-2">
        <button type="button" onClick={toggleSidebar} aria-expanded={browserVisible} aria-controls="spec-browser" className="my-control text-my-secondary hover:bg-my-layer-1-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-my-line-accent">
          {browserVisible ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />} 目录与检索
        </button>
        <span className="min-w-0 truncate text-my-xs text-my-secondary">规范可编辑 · 工作区日志与共享索引只读</span>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
      {/* 左栏：检索 + 规范树 / 命中列表 / 工作区日志 */}
      <div id="spec-browser" style={sidebarStyle} className={clsx('my-context-sidebar shrink-0 flex-col border-r border-my-line bg-my-layer-1', browserVisible ? 'flex' : 'hidden')}>
        <SidebarResizeHandle />
        <div className="space-y-2 border-b border-my-line p-2.5">
          <SearchInput value={query} onChange={setQuery} placeholder="全文搜索规范 / 日志 / 共享文档…" />
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
                  type="button"
                  onClick={() => setScope(v)}
                  className={clsx(
                    'rounded-my-md px-2 py-0.5 text-my-xs transition-colors',
                    scope === v ? 'bg-my-accent-subtle text-my-accent-text' : 'text-my-tertiary hover:bg-my-layer-1-hover hover:text-my-secondary'
                  )}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto text-my-xs text-my-tertiary">
                {searching ? '检索中…' : `${hits.length} 篇命中`}
              </span>
            </div>
          )}
        </div>

        <div className="my-scrollbar min-h-0 flex-1 p-2">
          {searchError && <p role="status" className="mb-2 rounded-my-md border border-my-line-warning bg-my-warning-subtle p-2 text-my-xs text-my-warning-text">{searchError}</p>}
          {searching_ ? (
            /* 搜索态：跨来源命中列表 */
            <>
              {!searching && hits.length === 0 && (
                <div className="px-2 py-8 text-center text-my-xs text-my-tertiary">没有匹配的文档</div>
              )}
              {GROUP_ORDER.filter((g) => groupedHits.has(g)).map((g) => {
                const groupHits = groupedHits.get(g) ?? []
                return (
                  <div key={g} className="mb-2">
                    <div className="flex items-center gap-1.5 px-2 py-1.5 text-my-xs font-semibold uppercase tracking-wider text-my-tertiary">
                      {GROUP_META[g].icon} {GROUP_META[g].label}
                      <span className="ml-auto font-mono font-normal">{groupHits.length}</span>
                    </div>
                    <div className="space-y-0.5">
                      {groupHits.map((h) => (
                      <button
                        key={h.path}
                        type="button"
                        onClick={() => loadDoc(h)}
                        title={h.path}
                        className={clsx(
                          'w-full rounded-my-lg border px-2.5 py-2 text-left transition-colors',
                          selected?.path === h.path
                            ? 'border-my-line-accent-subtle bg-my-accent-subtle'
                            : 'border-transparent hover:border-my-line hover:bg-my-layer-1'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <FileText size={12} className="shrink-0 text-my-icon-accent" />
                          <span className="min-w-0 flex-1 truncate text-my-sm text-my-secondary">{h.name}</span>
                          <span className="shrink-0 text-my-2xs text-my-placeholder">{relTime(h.mtime)}</span>
                        </div>
                        {h.snippet && (
                          <div className="mt-1 line-clamp-2 pl-5 text-my-xs leading-4 text-my-tertiary">
                            <Snippet text={h.snippet} />
                          </div>
                        )}
                      </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </>
          ) : (
            /* 浏览态：规范树 + 工作区日志 */
            <>
              <div className="flex items-center gap-1.5 px-2 py-1.5 text-my-xs font-semibold uppercase tracking-wider text-my-tertiary">
                .trellis/spec
                <button
                  type="button"
                  onClick={loadBacklinks}
                  className="ml-auto text-my-placeholder hover:text-my-secondary"
                  title="统计每个文档被任务/其他规范的引用次数"
                >
                  <Link2 size={11} /> 引用
                </button>
              </div>
              {snapshot?.spec.length === 0 && (
                <div className="px-2 py-4 text-center text-my-xs text-my-tertiary">没有规范文档</div>
              )}
              {snapshot?.spec.map((n) => (
                <TreeItem key={n.path} node={n} depth={0} selected={selected?.path ?? null} refCount={refCount} onSelect={loadSpec} />
              ))}

              {(snapshot?.developers.length ?? 0) > 0 && (
                <div className="mt-3">
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-my-xs font-semibold uppercase tracking-wider text-my-tertiary">
                    <NotebookPen size={11} /> 工作区日志
                  </div>
                  {snapshot?.developers.map((d) => (
                    <div key={d.name} className="mb-1">
                      <div className="px-2 py-1 text-my-xs text-my-tertiary">
                        {d.name} <span className="text-my-placeholder">· {relTime(d.lastActive)}</span>
                      </div>
                      {[...d.journals, ...d.otherFiles].map((f) => (
                        <button
                          key={f.path}
                          type="button"
                          onClick={() =>
                            loadDoc({ path: f.path, name: f.name, group: 'workspace', size: f.size, mtime: f.mtime })
                          }
                          className={clsx(
                            'flex w-full items-center gap-2 rounded-my-md py-[5px] pl-6 pr-2 text-left text-my-sm transition-colors',
                            selected?.path === f.path
                              ? 'bg-my-accent-subtle text-my-accent-text'
                              : 'text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary'
                          )}
                        >
                          <NotebookPen size={11} className="shrink-0 text-my-icon-tertiary" />
                          <span className="min-w-0 flex-1 truncate">{f.name}</span>
                          <span className="shrink-0 text-my-2xs text-my-placeholder">{fmtBytes(f.size)}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {(snapshot?.sharedWorkspaceFiles.length ?? 0) > 0 && (
                <div className="mt-2">
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-my-xs font-semibold uppercase tracking-wider text-my-tertiary">
                    <Share2 size={11} /> 共享索引
                  </div>
                  {snapshot?.sharedWorkspaceFiles.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => loadDoc({ path: f.path, name: f.name, group: 'shared', size: f.size, mtime: f.mtime })}
                      className={clsx(
                        'flex w-full items-center gap-2 rounded-my-md py-[5px] pl-6 pr-2 text-left text-my-sm transition-colors',
                        selected?.path === f.path
                          ? 'bg-my-accent-subtle text-my-accent-text'
                          : 'text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary'
                      )}
                    >
                      <FileText size={11} className="shrink-0 text-my-icon-tertiary" />
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
      <div ref={readerRef} tabIndex={-1} aria-label="文档阅读区" className="my-scrollbar relative min-w-0 flex-1 overflow-y-auto bg-my-surface-1 outline-none">
        {selected && (!specSelected || specSelected.type === 'file') ? (
          <>
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-my-line bg-my-surface-1 px-5 py-2.5">
              {docSelected ? (
                GROUP_META[docSelected.group].icon
              ) : (
                <FileText size={13} className="text-my-icon-accent" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-my-sm text-my-secondary">
                {docSelected ? docSelected.name : relPath}
              </span>
              {docSelected && <span className="my-chip bg-my-layer-3 text-my-2xs text-my-tertiary">{GROUP_META[docSelected.group].label}</span>}
              {specSelected && refCount?.[specSelected.path] !== undefined && (
                <span className="my-chip bg-my-layer-3 text-my-tertiary">
                  <Link2 size={10} /> 被引用 {refCount[specSelected.path]} 处
                </span>
              )}
              <span className="text-my-xs text-my-tertiary">
                {fmtBytes(docSelected ? docSelected.size : (specSelected?.size ?? 0))}
              </span>
              <Button variant="ghost" size="sm" className="px-1.5" onClick={() => void copyContent()} title="复制全文">
                <Copy size={12} /> {copied ? '已复制' : ''}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5"
                onClick={() => api.revealInExplorer(selected.path)}
                title="在资源管理器中显示"
              >
                <FolderOpen size={12} />
              </Button>
              {!docSelected && specSelected?.type === 'file' &&
                (!editing ? (
                  <Button variant="outline" size="sm" onClick={() => void startEditing()} disabled={state.loading || !!state.error}>
                    <SquarePen size={12} /> 编辑
                  </Button>
                ) : (
                  <div className="flex gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                      <RotateCw size={12} /> 取消
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
                      <Save size={12} /> {saving ? '保存中…' : '保存'}
                    </Button>
                  </div>
                ))}
            </div>

            {editing && (
              <div className="border-b border-my-line bg-my-layer-1 px-5 py-2 text-my-xs text-my-secondary">编辑基于进入编辑时的磁盘版本；保存时检查外部修改。</div>
            )}
            {editing && (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="h-[calc(100vh-140px)] w-full resize-none bg-my-canvas p-5 font-mono text-my-sm leading-5 text-my-secondary outline-none"
              />
            )}
              <div className={clsx('mx-auto max-w-3xl px-6 py-5', editing && 'hidden')}>
                {relativePath !== null && snapshot ? (
                  <DocumentReader key={`${snapshot.meta.root}:${selected.path}`} workspaceId={snapshot.meta.root} relativePath={relativePath} />
                ) : state.loading ? <div className="text-my-xs text-my-tertiary">加载中…</div> : state.error ? <div className="text-my-xs text-my-danger-text">{state.error}</div> : (
                  /\.(md|markdown)$/i.test(selected.name) ? (
                    <MarkdownView content={state.content ?? ''} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-mono text-my-sm leading-5 text-my-secondary">
                      {state.content}
                    </pre>
                  )
                )}
              </div>
          </>
        ) : (
          <div className="grid h-full place-items-center text-my-xs text-my-tertiary">
            <span className="flex items-center gap-1.5"><Eye size={13} /> 选择左侧文件查看；或全文搜索跨文档定位</span>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
