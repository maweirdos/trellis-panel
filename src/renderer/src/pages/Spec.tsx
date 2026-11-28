import { rememberVisit } from '../my/personal-history'
import { ModuleLinks } from '../my/layout/ModuleLinks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PageContent } from '../my/layout/PageLayout'
import {
  ChevronRight,
  ChevronLeft,
  FileText,
  SquarePen,
  Save,
  RotateCw,
  Link2,
  NotebookPen,
  Share2,
  BookOpenText,
  FolderOpen,
  Copy
} from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { stageKnowledgeReferenceHandoff } from '../acp/knowledge-reference-handoff'
import { useKnowledgeDiscussion } from '../knowledge/discussion-panel'
import { useProjectKnowledge } from '../knowledge/bridge'
import { DocumentReader } from '../reader/DocumentReader'
import { relativePathUnderRoot } from '../reader/reader-paths'
import { readingSessionKey } from '../reader/reading-session'
import { projectRootKey } from '../my/navigation'
import { Button } from '../my/ui'
import { SpecBrowser } from '../knowledge/SpecBrowser'
import '../knowledge/KnowledgeBrowser.css'
import { SidebarResizeHandle, useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { ContextRegion } from '../my/layout/ContextRegion'
import { useMy } from '../my/store'
import { fmtBytes } from '../utils/format'
import type { JSX } from 'react'
import type { DocSearchHit, SpecNode } from '../../../shared/types'

/**
 * 规范文档（项目文档统一入口）：
 * - 规范树：查看 / 编辑 + 引用统计
 * - 全文检索：跨规范、工作区日志与共享索引
 * - 非规范文档只读，规范文档可编辑
 */

const GROUP_META: Record<DocSearchHit['group'], { label: string; icon: JSX.Element }> = {
  spec: { label: '规范文档', icon: <BookOpenText size={12} /> },
  workspace: { label: '工作区日志', icon: <NotebookPen size={12} /> },
  shared: { label: '共享索引', icon: <Share2 size={12} /> }
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

interface SpecDraft {
  content: string
  baseContent: string
  baseMtime?: number
  savedWhileAway?: boolean
}

// Keep unsaved edits with their original disk baseline across document and project switches.
const specDrafts = new Map<string, SpecDraft>()
const draftKey = (root: string, path: string): string => JSON.stringify([projectRootKey(root), path])

export function SpecPage(): JSX.Element {
  const sidebarStyle = useSidebarWidthStyle()
  const sidebarCollapsed = useMy((state) => state.sidebarCollapsed)
  const snapshot = useApp((s) => s.snapshot)
  const pushToast = useApp((s) => s.pushToast)
  const knowledge = useProjectKnowledge(snapshot?.meta.root ?? '')

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
  const [referenceVersion, setReferenceVersion] = useState<{ root: string; path: string; revision: string } | null>(null)
  const [treeVisible, setTreeVisible] = useState(true)
  const [showList, setShowList] = useState(true)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const readerRef = useRef<HTMLDivElement | null>(null)
  const readSeq = useRef(0)
  const rootEpoch = useRef(0)
  const saveInFlight = useRef(false)

  useEffect(() => useApp.subscribe((next, previous) => {
    if (next.snapshot?.meta.root !== previous.snapshot?.meta.root) rootEpoch.current += 1
  }), [])

  const ownsRead = (seq: number, root: string, epoch: number): boolean =>
    seq === readSeq.current && epoch === rootEpoch.current && useApp.getState().snapshot?.meta.root === root

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
      setTreeVisible(false)
      requestAnimationFrame(() => readerRef.current?.focus({ preventScroll: true }))
    }
  }

  const loadSpec = (n: SpecNode): void => {
    const root = snapshot?.meta.root
    if (!root || useApp.getState().snapshot?.meta.root !== root) return
    const seq = ++readSeq.current
    const epoch = rootEpoch.current
    setSpecSelected(n)
    setDocSelected(null)
    setEditing(false)
    if (n.type !== 'file') {
      setState({ loading: false })
      return
    }
    setShowList(false)
    focusReader()
    const savedDraft = specDrafts.get(draftKey(root, n.path))
    if (savedDraft) {
      setState({ loading: false, content: savedDraft.baseContent, mtime: savedDraft.baseMtime })
      setDraft(savedDraft.content)
      setEditing(true)
      return
    }
    setState({ loading: true })
    api.readTextFile(n.path).then((res) => {
      if (!ownsRead(seq, root, epoch)) return
      if (res.ok) setState({ loading: false, content: res.content, mtime: res.mtime })
      else setState({ loading: false, error: res.error })
    }).catch((error: unknown) => {
      if (ownsRead(seq, root, epoch)) setState({ loading: false, error: error instanceof Error ? error.message : '读取失败' })
    })
  }

  const loadDoc = (d: SelectedDoc): void => {
    const root = snapshot?.meta.root
    if (!root || useApp.getState().snapshot?.meta.root !== root) return
    if (editing && selected?.path === d.path) { setShowList(false); focusReader(); return }
    rememberVisit({ kind: 'document', target: d.path, title: d.name })
    const node = d.group === 'spec' ? files.find((file) => file.path === d.path) : undefined
    if (node) {
      loadSpec(node)
      return
    }
    const seq = ++readSeq.current
    const epoch = rootEpoch.current
    setSpecSelected(null)
    setDocSelected(d)
    setEditing(false)
    setShowList(false)
    focusReader()
    setState({ loading: true })
    api.readTextFile(d.path).then((res) => {
      if (!ownsRead(seq, root, epoch)) return
      if (res.ok) setState({ loading: false, content: res.content })
      else setState({ loading: false, error: res.error })
    }).catch((error: unknown) => {
      if (ownsRead(seq, root, epoch)) setState({ loading: false, error: error instanceof Error ? error.message : '读取失败' })
    })
  }

  const loadBacklinks = (): void => {
    const root = snapshot?.meta.root
    const epoch = rootEpoch.current
    if (!root || useApp.getState().snapshot?.meta.root !== root) return
    api.specBacklinks().then((res) => {
      if (epoch === rootEpoch.current && useApp.getState().snapshot?.meta.root === root && res.ok && res.counts) setRefCount(res.counts)
    })
  }

  useEffect(() => {
    if (!hasIpc) return
    setRefCount(null)
    const target = useApp.getState().consumeSpecDocumentTarget()
    const root = snapshot?.meta.root
    const targetRelative = target && root ? relativePathUnderRoot(root, target.path) : null
    const validTarget = target && root && projectRootKey(target.projectRoot) === projectRootKey(root) &&
      targetRelative !== null && !targetRelative.split('/').includes('..')
    if (validTarget) {
      const node = files.find((file) => file.path === target.path)
      if (node) loadSpec(node)
      else loadDoc({ path: target.path, name: target.path.replace(/\\/g, '/').split('/').pop() ?? target.path, group: 'spec', size: 0, mtime: 0 })
    } else { setSpecSelected(null); setDocSelected(null); setEditing(false); setShowList(true) }
    loadBacklinks()
    return () => { readSeq.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.meta?.root])

  const selected = specSelected ?? docSelected
  const relPath = snapshot && specSelected ? specSelected.path.replace(snapshot.meta.root + '\\', '').replace(snapshot.meta.root + '/', '') : ''
  const relativePath = selected ? relativePathUnderRoot(snapshot?.meta.root ?? '', selected.path) : null
  const sessionKey = selected && relativePath !== null && snapshot ? readingSessionKey({ workspaceId: snapshot.meta.root }, relativePath) : null
  const displayed = useApp((s) => sessionKey ? s.readingSessions[sessionKey]?.displayed : undefined)
  const displayedText = displayed?.text
  const referenceReady = Boolean(!editing && !showList && snapshot && selected && relativePath && referenceVersion?.root === snapshot.meta.root && referenceVersion.path === selected.path && referenceVersion.revision === displayed?.revision)

  const startEditing = async (): Promise<void> => {
    const root = snapshot?.meta.root
    if (specSelected?.type !== 'file' || !root || useApp.getState().snapshot?.meta.root !== root) return
    const seq = ++readSeq.current
    const epoch = rootEpoch.current
    try {
      const res = await api.readTextFile(specSelected.path)
      if (!ownsRead(seq, root, epoch)) return
      if (!res.ok || res.content === undefined) {
        pushToast({ kind: 'error', title: '无法进入编辑', body: res.error ?? '读取失败' })
        return
      }
      specDrafts.set(draftKey(root, specSelected.path), { content: res.content, baseContent: res.content, baseMtime: res.mtime })
      setState({ loading: false, content: res.content, mtime: res.mtime })
      setDraft(res.content)
      setEditing(true)
    } catch (error) {
      if (ownsRead(seq, root, epoch)) pushToast({ kind: 'error', title: '无法进入编辑', body: error instanceof Error ? error.message : '读取失败' })
    }
  }

  const save = async (): Promise<void> => {
    const root = snapshot?.meta.root
    if (!specSelected || specSelected.type !== 'file' || !root || saveInFlight.current || useApp.getState().snapshot?.meta.root !== root) return
    const seq = readSeq.current
    const epoch = rootEpoch.current
    const savingNode = specSelected
    const key = draftKey(root, savingNode.path)
    const savedDraft = specDrafts.get(key)
    if (!savedDraft) return
    const savingDraft = savedDraft.content
    saveInFlight.current = true
    setSaving(true)
    try {
      const res = await api.writeSpecFile(savingNode.path, savingDraft, savedDraft.baseMtime)
      if (!ownsRead(seq, root, epoch)) {
        const currentDraft = specDrafts.get(key)
        if (res.ok && currentDraft?.content === savingDraft) specDrafts.set(key, { ...currentDraft, savedWhileAway: true })
        return
      }
      if (res.ok) {
        if (specDrafts.get(key)?.content === savingDraft) specDrafts.delete(key)
        pushToast({ kind: 'success', title: '规范已保存', body: relPath })
        setEditing(false)
        setState((s) => ({ ...s, content: savingDraft }))
        loadBacklinks()
      } else if (res.conflict) {
        pushToast({ kind: 'warn', title: '保存冲突', body: '文件已被外部修改，草稿已保留。请从编辑区复制草稿后取消编辑并重新打开文件。' })
      } else {
        pushToast({ kind: 'error', title: '保存失败', body: res.error })
      }
    } catch (error) {
      if (ownsRead(seq, root, epoch)) pushToast({ kind: 'error', title: '保存失败', body: error instanceof Error ? error.message : '写入失败' })
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  const referenceInAgent = (): void => {
    const root = snapshot?.meta.root
    if (!referenceReady || !root || !selected || !relativePath || !sessionKey || !referenceVersion || useApp.getState().page !== 'spec' || useApp.getState().snapshot?.meta.root !== root) {
      pushToast({ kind: 'error', title: '无法引用文档', body: '当前展示版本不可用，请重新打开文档。' })
      return
    }
    const currentRevision = useApp.getState().readingSessions[sessionKey]?.displayed?.revision
    if (currentRevision !== referenceVersion.revision) {
      pushToast({ kind: 'error', title: '无法引用文档', body: '展示版本已变化，请重新确认文档。' })
      return
    }
    const context = knowledge.context
    if (!context?.selectionToken || !knowledge.current() || projectRootKey(context.scope.root) !== projectRootKey(root)) {
      pushToast({ kind: 'error', title: '无法引用文档', body: '项目知识范围尚未就绪，请稍后重试。' })
      return
    }
    try {
      if (!stageKnowledgeReferenceHandoff({ root, selectionToken: context.selectionToken, projectGeneration: context.scope.projectGeneration, document: { title: selected.name, relativePath, displayedRevision: currentRevision } })) {
        pushToast({ kind: 'error', title: '无法引用文档', body: '请先处理待加入的引用，再重试。' })
        return
      }
      useApp.getState().setPage('knowledge')
      if (!useKnowledgeDiscussion.getState().show(root)) {
        useApp.getState().setPage('acp')
        pushToast({ kind: 'warn', title: '讨论面板不可用', body: '引用已暂存，请在 Agent 中选择会话并加入草稿。' })
      }
    } catch (error) {
      pushToast({ kind: 'error', title: '无法引用文档', body: error instanceof Error ? error.message : '请重试。' })
    }
  }

  const copyContent = async (): Promise<void> => {
    await api.copyToClipboard(displayedText ?? state.content ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div ref={pageRef} className="flex h-full min-h-0 min-w-0 flex-row bg-my-surface-1">
      <ContextRegion collapsed={sidebarCollapsed}><div style={sidebarStyle} className="my-context-sidebar flex shrink-0 flex-col border-r border-my-line">
        <SidebarResizeHandle />
        <header className="flex h-my-header shrink-0 items-center px-4"><h1 className="my-sidebar-heading flex-1 truncate font-medium text-my-primary">知识</h1></header>
        <ModuleLinks domain="knowledge" />
      </div></ContextRegion>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-my-surface-1">
        <div className="my-page-toolbar-row"><h1 className="text-my-md font-medium text-my-primary">规范</h1></div>
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <SpecBrowser snapshot={snapshot} query={query} onQuery={(value) => { setQuery(value); setShowList(true) }} scope={scope} onScope={setScope} hits={hits} searching={searching} error={searchError} selectedPath={selected?.path} refCount={refCount} onRefreshReferences={loadBacklinks} onOpen={loadDoc} showList={showList} onBrowse={() => setShowList(true)} treeVisible={treeVisible}>
      <div ref={readerRef} tabIndex={-1} aria-label="文档阅读区" className="my-scrollbar relative h-full min-h-0 min-w-0 overflow-y-auto bg-my-surface-1 outline-none">
        {selected && (!specSelected || specSelected.type === 'file') ? (
          <>
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-my-line bg-my-surface-1 px-5 py-2.5">
              <Button variant="ghost" size="sm" onClick={() => setShowList(true)}><ChevronLeft size={13} /> 返回列表</Button>
              {docSelected ? (
                GROUP_META[docSelected.group].icon
              ) : (
                <FileText size={13} className="text-my-icon-accent" />
              )}
              <span className="my-item-title min-w-0 flex-1 truncate font-mono">
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
              <Button variant="outline" size="sm" disabled={!referenceReady} onClick={referenceInAgent}>引用到 Agent</Button>
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
                    <Button variant="ghost" size="sm" disabled={saving} onClick={() => { if (snapshot && specSelected) specDrafts.delete(draftKey(snapshot.meta.root, specSelected.path)); setEditing(false) }}>
                      <RotateCw size={12} /> 取消
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
                      <Save size={12} /> {saving ? '保存中…' : '保存'}
                    </Button>
                  </div>
                ))}
            </div>

            {editing && (
              <div className="border-b border-my-line bg-my-layer-1 px-5 py-2 text-my-xs text-my-secondary">{snapshot && specSelected && specDrafts.get(draftKey(snapshot.meta.root, specSelected.path))?.savedWhileAway ? '离开此文档后保存已完成。若继续修改，请先复制草稿，再取消编辑并重新打开文件。' : '草稿在本次应用运行期间保留；保存时检查进入编辑时的磁盘版本。'}</div>
            )}
            {editing && (
              <textarea
                value={draft}
                onChange={(e) => {
                  const content = e.target.value
                  if (snapshot && specSelected) {
                    const key = draftKey(snapshot.meta.root, specSelected.path)
                    const existing = specDrafts.get(key)
                    if (existing) specDrafts.set(key, { ...existing, content })
                  }
                  setDraft(content)
                }}
                disabled={saving}
                spellCheck={false}
                className="my-page-workspace-padding h-[calc(100vh-140px)] w-full resize-none bg-my-canvas font-mono text-my-sm leading-5 text-my-secondary outline-none"
              />
            )}
              <PageContent variant="centered" className={clsx(editing && 'hidden')}>
                {relativePath !== null && snapshot ? (
                  <DocumentReader key={`${snapshot.meta.root}:${selected.path}`} workspaceId={snapshot.meta.root} relativePath={relativePath} onDisplayedRevision={(value) => {
                    const root = snapshot.meta.root
                    const path = selected.path
                    setReferenceVersion((current) => value && value.relativePath === relativePath ? { root, path, revision: value.displayedRevision } : current?.root === root && current.path === path ? null : current)
                  }} />
                ) : state.loading ? <div className="text-my-xs text-my-tertiary">加载中…</div> : state.error ? <div className="text-my-xs text-my-danger-text">{state.error}</div> : (
                  /\.(md|markdown)$/i.test(selected.name) ? (
                    <MarkdownView content={state.content ?? ''} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-mono text-my-sm leading-5 text-my-secondary">
                      {state.content}
                    </pre>
                  )
                )}
              </PageContent>
          </>
        ) : (
          <div className="grid h-full place-items-center text-my-xs text-my-tertiary">
            <span>选择文件查看</span>
          </div>
        )}
      </div>
          </SpecBrowser>
          <button type="button" onClick={() => setTreeVisible((value) => !value)} aria-expanded={treeVisible} aria-controls="spec-directory" aria-label={treeVisible ? '收起文件目录' : '展开文件目录'} title={treeVisible ? '收起文件目录' : '展开文件目录'} className="knowledge-browser-toggle my-icon-control border border-my-line bg-my-surface-1" data-tree-open={treeVisible}>{treeVisible ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}</button>
        </div>
      </div>
    </div>
  )
}
