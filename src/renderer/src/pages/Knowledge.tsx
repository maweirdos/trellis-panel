import { rememberVisit } from '../my/personal-history'
import { ModuleLinks } from '../my/layout/ModuleLinks'
import { PageContent, PageSection } from '../my/layout/PageLayout'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Library,
  FileText,
  BookOpenText,
  Archive,
  ScrollText,
  RefreshCw,
  ExternalLink,
  Sparkles,
  Loader2,
  Send,
  X,
  BrainCircuit,
  Cloud,
  StickyNote,
  Plus,
  Save,
  Trash2,
  History,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { clsx } from 'clsx'
import { fmtBytes, relTime } from '../utils/format'
import { MarkdownView } from '../components/MarkdownView'
import { DocumentReader } from '../reader/DocumentReader'
import { relativePathUnderRoot } from '../reader/reader-paths'
import { Button, SearchInput } from '../my/ui'
import { useMy } from '../my/store'
import { getPageNavigation } from '../my/navigation'
import { SidebarResizeHandle, useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import type { KbDoc, KbHit, KbLibrary, KbQaEntry, KbSearchResult, WeknoraDocSummary, WeknoraHit } from '../../../shared/types'
import type { JSX } from 'react'

type LibFilter = KbLibrary | 'all' | 'company'

/** 公司库文档在浏览态聚合多个 WeKnora 知识库，额外携带来源库名 */
type CompanyDoc = WeknoraDocSummary & { kbName: string }

/** 右侧阅读器当前打开的远程（WeKnora）文档 */
interface RemoteDoc {
  knowledgeId: string
  title: string
  fileName: string
  content: string | null
  loading: boolean
  error?: string
}

/** zustand 选择器兜底用的稳定空数组（每次返回新 [] 会触发 getSnapshot 重渲染问题） */
const NO_KB_IDS: string[] = []

const LIBS: Array<{ id: LibFilter; label: string; icon: JSX.Element; desc: string }> = [
  { id: 'notes', label: '笔记', icon: <StickyNote size={14} />, desc: '当前项目 .trellis/notes 文件，可新建 / 编辑 / 删除；不提供个人私密权限' },
  { id: 'requirements', label: '需求', icon: <ScrollText size={14} />, desc: '原始需求文档（活动任务 PRD / task.json 提炼）' },
  { id: 'spec', label: '规范库', icon: <BookOpenText size={14} />, desc: '.trellis/spec 团队规范' },
  { id: 'wiki', label: '文档', icon: <FileText size={14} />, desc: 'README / docs / wiki 等仓库文档' },
  { id: 'archive', label: '归档', icon: <Archive size={14} />, desc: '已归档任务的沉淀经验' },
  { id: 'company', label: '知识库', icon: <Cloud size={14} />, desc: 'WeKnora 跨项目知识（规范 / 历史归档 / 接口文档）' },
  { id: 'all', label: '全部', icon: <Library size={14} />, desc: '跨库联合检索（本地五库 + 知识库异步追加）' }
]

const LIB_CHIP: Record<KbLibrary, string> = {
  requirements: 'bg-my-label-yellow text-my-label-yellow-text',
  spec: 'bg-my-label-emerald text-my-label-emerald-text',
  wiki: 'bg-my-label-indigo text-my-label-indigo-text',
  notes: 'bg-my-label-orange text-my-label-orange-text',
  archive: 'bg-my-label-purple text-my-label-purple-text'
}

function highlight(text: string): JSX.Element {
  const parts = text.split(/[\u0000\u0001]/)
  // 奇数下标是命中片段
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-my-sm bg-my-accent-subtle px-0.5 text-my-accent-text">{p}</mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

export function KnowledgePage(): JSX.Element {
  const sidebarStyle = useSidebarWidthStyle()
  const sidebarCollapsed = useMy((state) => state.sidebarCollapsed)
  const toggleSidebar = useMy((state) => state.toggleSidebar)
  const snapshot = useApp((s) => s.snapshot)
  const pushToast = useApp((s) => s.pushToast)
  const viewerTabs = useApp((s) => s.viewerTabs)
  const openArtifact = useApp((s) => s.openArtifact)
  const setPage = useApp((s) => s.setPage)
  const openSpecDocument = useApp((s) => s.openSpecDocument)

  const knowledgeView = useMy((state) => state.knowledgeView)
  const [lib, setLib] = useState<LibFilter>(() => knowledgeView === 'company' ? 'company' : 'requirements')
  useEffect(() => { setLib(knowledgeView === 'company' ? 'company' : 'requirements') }, [knowledgeView])
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [result, setResult] = useState<KbSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState<KbDoc | null>(null)
  const [docContent, setDocContent] = useState<string | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const searchSeq = useRef(0)
  const docSeq = useRef(0)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const readerRef = useRef<HTMLDivElement | null>(null)
  const browserVisible = !sidebarCollapsed

  /* 公司库（WeKnora）——独立状态与序号，异步追加，绝不阻塞本地检索 */
  const weknoraEnabled = useApp((s) => s.settings?.weknora?.enabled ?? false)
  const weknoraKbIds = useApp((s) => s.settings?.weknora?.searchKbIds ?? NO_KB_IDS)
  const [companyHits, setCompanyHits] = useState<WeknoraHit[]>([])
  const [companyDocs, setCompanyDocs] = useState<CompanyDoc[]>([])
  const [companyLoading, setCompanyLoading] = useState(false)
  const [companyError, setCompanyError] = useState<string | null>(null)
  const [companyMs, setCompanyMs] = useState(0)
  const companySeq = useRef(0)
  const [remoteDoc, setRemoteDoc] = useState<RemoteDoc | null>(null)

  /* AI 问答 */
  const aiEnabled = useApp((s) => s.settings?.ai.enabled ?? false)
  const [aiQuestion, setAiQuestion] = useState('')
  const [aiAnswer, setAiAnswer] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiSources, setAiSources] = useState<KbDoc[]>([])
  const [aiRemoteSources, setAiRemoteSources] = useState<WeknoraHit[]>([])
  const [qaHistory, setQaHistory] = useState<KbQaEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)

  /* Project notes are repository files, not private personal storage. */
  const [noteDraft, setNoteDraft] = useState<{ name: string; content: string; isNew: boolean } | null>(null)
  const [noteSaving, setNoteSaving] = useState(false)

  useEffect(() => () => {
    searchSeq.current += 1
    companySeq.current += 1
    docSeq.current += 1
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  /** 公司库检索/浏览：本地结果先上屏，这里异步补充（失败只记错误不打扰本地） */
  const runCompanySearch = useCallback(
    async (mode: 'search' | 'browse') => {
      const seq = ++companySeq.current
      if (!weknoraEnabled) {
        setCompanyHits([])
        setCompanyDocs([])
        setCompanyError(null)
        setCompanyLoading(false)
        return
      }
      setCompanyLoading(true)
      setCompanyError(null)
      try {
        if (mode === 'search') {
          const res = await api.weknoraSearch(debounced, 10)
          if (seq !== companySeq.current) return
          setCompanyHits(res.ok ? res.hits : [])
          setCompanyMs(res.elapsedMs ?? 0)
          setCompanyError(res.ok ? null : res.error ?? null)
        } else {
          const docs: CompanyDoc[] = []
          let err: string | null = null
          const t0 = Date.now()
          for (const kbId of weknoraKbIds) {
            const res = await api.weknoraListDocs(kbId)
            if (seq !== companySeq.current) return
            if (res.ok && res.docs) docs.push(...res.docs.map((d) => ({ ...d, kbName: kbId })))
            else err = res.error ?? null
          }
          setCompanyDocs(docs)
          setCompanyMs(Date.now() - t0)
          setCompanyError(docs.length === 0 ? err : null)
        }
      } catch (error) {
        if (seq === companySeq.current) setCompanyError(error instanceof Error ? error.message : '知识库读取失败')
      } finally {
        if (seq === companySeq.current) setCompanyLoading(false)
      }
    },
    [debounced, weknoraEnabled, weknoraKbIds]
  )

  const runSearch = useCallback(async () => {
    const seq = ++searchSeq.current
    if (!hasIpc) return
    if (lib === 'company') {
      setLoading(false)
      setResult(null)
      setActive(null)
      void runCompanySearch(debounced ? 'search' : 'browse')
      return
    }
    setLoading(true)
    try {
      const res = await api.kbSearch(lib, debounced)
      if (seq !== searchSeq.current) return
      if (res.ok) setResult(res)
      else pushToast({ kind: 'error', title: '检索失败', body: res.error })
    } catch (error) {
      if (seq !== searchSeq.current) return
      pushToast({ kind: 'error', title: '本地检索失败', body: error instanceof Error ? error.message : '读取失败' })
    } finally {
      if (seq === searchSeq.current) setLoading(false)
    }
    if (seq !== searchSeq.current) return
    // 联邦检索：'all' 检索态下公司库命中异步追加
    if (lib === 'all' && debounced) void runCompanySearch('search')
    else {
      companySeq.current += 1
      setCompanyHits([])
      setCompanyError(null)
      setCompanyLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, debounced, runCompanySearch])

  useEffect(() => {
    if (!hasIpc) return
    void runSearch()
    // 切库时关闭远程阅读器
    setRemoteDoc(null)
  }, [runSearch, snapshot?.meta.root])

  const focusReader = (): void => {
    // Preserve the browser/results state while giving narrow windows a full-width reader.
    if ((pageRef.current?.clientWidth ?? 0) < 1000) {
      if (!useMy.getState().sidebarCollapsed) useMy.getState().toggleSidebar()
      requestAnimationFrame(() => readerRef.current?.focus({ preventScroll: true }))
    }
  }

  const openDoc = useCallback(async (doc: KbDoc): Promise<void> => {
    if (!doc.synthetic && relativePathUnderRoot(snapshot?.meta.root ?? '', doc.path) !== null) rememberVisit({ kind: 'document', target: doc.path, title: doc.title })
    const seq = ++docSeq.current
    setRemoteDoc(null)
    setNoteDraft(null)
    setActive(doc)
    focusReader()
    setDocContent(null)
    setDocError(null)
    // Project files use the shared version-aware reader below; remote content does not.
    if (doc.synthetic || relativePathUnderRoot(snapshot?.meta.root ?? '', doc.path) !== null) return
    try {
      const res = await api.readTextFile(doc.path)
      if (seq !== docSeq.current) return
      if (res.ok && res.content !== undefined) setDocContent(res.content)
      else setDocError(res.error ?? '读取失败')
    } catch (error) {
      if (seq === docSeq.current) setDocError(error instanceof Error ? error.message : '读取失败')
    }
  }, [snapshot?.meta.root])

  /** 打开公司库（WeKnora）文档：拉取 preview 正文 */
  const openRemoteDoc = useCallback(async (hit: { knowledgeId: string; title: string }): Promise<void> => {
    const seq = ++docSeq.current
    setActive(null)
    setNoteDraft(null)
    focusReader()
    setRemoteDoc({ knowledgeId: hit.knowledgeId, title: hit.title, fileName: '', content: null, loading: true })
    try {
      const res = await api.weknoraRead(hit.knowledgeId)
      if (seq !== docSeq.current) return
      setRemoteDoc((cur) =>
        cur && cur.knowledgeId === hit.knowledgeId
          ? res.ok
            ? {
                knowledgeId: hit.knowledgeId,
                title: res.title || hit.title,
                fileName: res.fileName ?? '',
                content: res.content ?? null,
                loading: false,
                error: res.content === undefined ? '非文本文档——请在 WeKnora 中查看' : undefined
              }
            : { knowledgeId: hit.knowledgeId, title: hit.title, fileName: '', content: null, loading: false, error: res.error }
          : cur
      )
    } catch (error) {
      if (seq === docSeq.current) setRemoteDoc({ knowledgeId: hit.knowledgeId, title: hit.title, fileName: '', content: null, loading: false, error: error instanceof Error ? error.message : '知识库文档读取失败' })
    }
  }, [])

  /* AI 问答（本地 + 公司库上下文） */
  const aiAsk = async (): Promise<void> => {
    const q = aiQuestion.trim()
    if (!q || aiBusy) return
    setAiBusy(true)
    setAiAnswer(null)
    setAiSources([])
    setAiRemoteSources([])
    try {
      let context = ''
      const sources: KbDoc[] = []
      if (lib !== 'company') {
        const search = await api.kbSearch(lib === 'all' ? 'all' : lib, q)
        const top = search.ok ? search.hits.slice(0, 6) : []
        for (const h of top) {
          const res = await api.readTextFile(h.doc.path)
          const content = res.ok && res.content ? res.content.slice(0, 4000) : h.snippet.replace(/[\u0000\u0001]/g, '')
          context += `\n\n--- 来源：${h.doc.title}（${h.doc.path}）---\n${content}`
          sources.push(h.doc)
        }
        setAiSources(sources)
      }
      // 公司库补充上下文（启用且配置了检索范围时）
      const remoteSources: WeknoraHit[] = []
      if (weknoraEnabled && weknoraKbIds.length > 0 && (lib === 'all' || lib === 'company')) {
        const remote = await api.weknoraSearch(q, 3)
        if (remote.ok) {
          for (const h of remote.hits.slice(0, 3)) {
            context += `\n\n--- 来源 [知识库]：${h.title || h.filename}（WeKnora）---\n${h.content.slice(0, 3000)}`
            remoteSources.push(h)
          }
          setAiRemoteSources(remoteSources)
        }
      }
      const res = await api.aiChat([
        {
          role: 'system',
          content:
            '你是项目知识助手。仅依据提供的知识库上下文回答问题；上下文不足时明确说明并给出建议去哪里补充。用中文回答，引用来源时标注标题（WeKnora 来源注明 [知识库]）。'
        },
        { role: 'user', content: `知识库上下文：\n${context || '（未检索到相关内容）'}\n\n问题：${q}` }
      ])
      if (res.ok && res.content) {
        setAiAnswer(res.content)
        // 问答历史落盘（userData，个人维度）
        const sourcesForHistory = [
          ...sources.map((s) => ({ title: s.title, path: s.path, library: s.library })),
          ...remoteSources.map((h) => ({ title: h.title || h.filename || '知识库文档', path: h.knowledgeId, library: '知识库' }))
        ]
        void api.kbQaSave({ question: q, answer: res.content, sources: sourcesForHistory }).then((r) => {
          if (r.ok && r.entries) setQaHistory(r.entries)
        })
      } else {
        pushToast({ kind: 'error', title: 'AI 回答失败', body: res.error })
      }
    } finally {
      setAiBusy(false)
    }
  }

  /* Project-note editing uses the existing repository note service. */
  const startNewNote = (): void => {
    docSeq.current += 1
    setActive(null)
    setRemoteDoc(null)
    setNoteDraft({ name: '', content: '# 新笔记\n\n', isNew: true })
    focusReader()
  }

  const startEditNote = (doc: KbDoc): void => {
    if (doc.synthetic) return
    const seq = ++docSeq.current
    void api.readTextFile(doc.path).then((r) => {
      if (seq !== docSeq.current) return
      if (!r.ok || r.content === undefined) {
        pushToast({ kind: 'error', title: '无法编辑笔记', body: r.error ?? '读取失败' })
        return
      }
      setNoteDraft({ name: doc.name, content: r.content, isNew: false })
    }).catch((error: unknown) => {
      if (seq === docSeq.current) pushToast({ kind: 'error', title: '无法编辑笔记', body: error instanceof Error ? error.message : '读取失败' })
    })
  }

  const saveNote = async (): Promise<void> => {
    if (!noteDraft || noteSaving) return
    const name = noteDraft.name.trim()
    if (!name) {
      pushToast({ kind: 'error', title: '请填写笔记名' })
      return
    }
    const seq = docSeq.current
    setNoteSaving(true)
    try {
      const res = await api.kbSaveNote(name, noteDraft.content)
      if (seq !== docSeq.current) return
      if (res.ok) {
        pushToast({ kind: 'success', title: '笔记已保存', body: '已写入 .trellis/notes/，检索立即可用' })
        setNoteDraft(null)
        void runSearch()
      } else {
        pushToast({ kind: 'error', title: '保存失败', body: res.error })
      }
    } finally {
      setNoteSaving(false)
    }
  }

  const deleteNote = async (doc: KbDoc): Promise<void> => {
    const seq = docSeq.current
    const res = await api.kbDeleteNote(doc.name)
    if (seq !== docSeq.current) return
    if (res.ok) {
      pushToast({ kind: 'success', title: '笔记已删除' })
      setActive(null)
      void runSearch()
    } else {
      pushToast({ kind: 'error', title: '删除失败', body: res.error })
    }
  }

  useEffect(() => {
    if (!hasIpc) return
    void api.kbQaHistory().then((r) => {
      if (r.ok && r.entries) setQaHistory(r.entries)
    })
  }, [])

  const totalDocs = result?.totalDocs ?? 0
  const isSearch = debounced.length > 0
  const list: Array<{ doc: KbDoc; hit?: KbHit }> = useMemo(() => {
    if (!result) return []
    if (isSearch) return result.hits.map((h) => ({ doc: h.doc, hit: h }))
    return result.docs.map((d) => ({ doc: d }))
  }, [result, isSearch])

  /** 公司库条目：company tab 直接作为主体列表；all 检索态作为追加区域 */
  const companyList: Array<{ key: string; title: string; sub: string; snippet?: string; score?: number; knowledgeId: string }> = useMemo(() => {
    if (lib === 'company') {
      if (isSearch) {
        return companyHits.map((h, i) => ({
          key: `${h.knowledgeId}-${i}`,
          title: h.title || h.filename || h.knowledgeId,
          sub: h.filename || h.sourceType,
          snippet: h.content,
          score: h.score,
          knowledgeId: h.knowledgeId
        }))
      }
      return companyDocs.map((d, i) => ({
        key: `${d.id}-${i}`,
        title: d.title || d.fileName,
        sub: `${d.kbName} · ${d.fileName || d.fileType}${d.parseStatus && d.parseStatus !== 'completed' ? ` · ${d.parseStatus}` : ''}`,
        knowledgeId: d.id
      }))
    }
    if (lib === 'all' && isSearch) {
      return companyHits.map((h, i) => ({
        key: `${h.knowledgeId}-${i}`,
        title: h.title || h.filename || h.knowledgeId,
        sub: h.filename || h.sourceType,
        snippet: h.content,
        score: h.score,
        knowledgeId: h.knowledgeId
      }))
    }
    return []
  }, [lib, isSearch, companyHits, companyDocs])

  const LIB_ICON: Record<KbLibrary, JSX.Element> = {
    notes: <StickyNote size={12} />,
    requirements: <ScrollText size={12} />,
    spec: <BookOpenText size={12} />,
    wiki: <FileText size={12} />,
    archive: <Archive size={12} />
  }
  const LIB_LABEL: Record<KbLibrary, string> = {
    notes: '笔记',
    requirements: '需求',
    spec: '规范',
    wiki: 'Wiki',
    archive: '归档'
  }

  const relativePath = active && !active.synthetic ? relativePathUnderRoot(snapshot?.meta.root ?? '', active.path) : null
  const scopeNote = getPageNavigation('knowledge').scopeNote

  return (
    <div ref={pageRef} className="flex h-full min-h-0 min-w-0 flex-row bg-my-surface-1">
      {/* 左列：知识导航、来源与检索 */}
      <div id="knowledge-browser" style={sidebarStyle} className={clsx('my-context-sidebar shrink-0 flex-col border-r border-my-line', browserVisible ? 'flex' : 'hidden')}>
        <SidebarResizeHandle />
        <div className="shrink-0 px-4 py-3">
          <h1 className="text-my-md font-semibold text-my-primary">知识</h1>
        </div>
        <ModuleLinks domain="knowledge" />
        {scopeNote && <p className="shrink-0 px-4 pb-3 pt-2 text-my-xs leading-relaxed text-my-tertiary">{scopeNote}</p>}
        <div className="space-y-2.5 border-b border-my-line px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {LIBS.filter((l) => knowledgeView === 'company' ? l.id === 'company' : l.id !== 'company' && l.id !== 'spec').map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setLib(l.id)}
                aria-pressed={lib === l.id}
                title={l.desc}
                className={clsx(
                  'my-control my-control-sm border',
                  lib === l.id
                    ? 'border-my-line-accent-subtle bg-my-accent-subtle text-my-accent-text'
                    : 'border-transparent text-my-tertiary hover:bg-my-layer-1-hover hover:text-my-secondary'
                )}
              >
                {l.icon} {l.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <SearchInput value={query} onChange={setQuery} placeholder="全文检索：中文/英文关键词混排…" />
            {loading && (
              <Loader2 size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-my-tertiary" />
            )}
          </div>
          <div className="flex items-center gap-2 text-my-xs text-my-tertiary">
            <span>
              {lib === 'company'
                ? `${companyList.length} 条${isSearch ? '命中' : '文档'}${companyMs ? ` · ${companyMs}ms` : ''}`
                : `${isSearch ? `${list.length} 条命中` : `${list.length} 篇文档`} · 库内共 ${totalDocs} 篇 · ${result?.elapsedMs ?? 0}ms`}
            </span>
            {lib === 'notes' && (
              <Button variant="neutral" size="sm" onClick={startNewNote} disabled={!hasIpc || !snapshot} title="新建项目笔记（写入 .trellis/notes/，不提供私密权限）">
                <Plus size={10} /> 新建笔记
              </Button>
            )}
            <Button variant="ghost" size="sm" className="ml-auto px-1.5" onClick={() => void runSearch()} disabled={!hasIpc} title="重建检索">
              <RefreshCw size={11} />
            </Button>
          </div>
        </div>

        <div className="my-scrollbar min-h-0 flex-1 p-2">
          {list.map(({ doc, hit }) => (
            <button
              key={doc.id}
              type="button"
              onClick={() => void openDoc(doc)}
              aria-pressed={active?.id === doc.id}
              className={clsx(
                'mb-1.5 w-full rounded-my-lg border px-3 py-2 text-left transition-colors',
                active?.id === doc.id
                  ? 'border-my-line-accent-subtle bg-my-accent-subtle'
                  : 'border-transparent hover:border-my-line hover:bg-my-layer-1'
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={clsx('my-chip', LIB_CHIP[doc.library])}>
                  {LIB_ICON[doc.library]} {LIB_LABEL[doc.library]}
                </span>
                <span className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-primary">{doc.title}</span>
                {hit && <span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{hit.score.toFixed(1)}</span>}
              </div>
              {hit ? (
                <div className="mt-1 line-clamp-2 text-my-xs leading-4 text-my-tertiary">{highlight(hit.snippet)}</div>
              ) : (
                <div className="mt-1 flex items-center gap-1.5 text-my-xs text-my-tertiary">
                  <span className="truncate font-mono">{doc.group}/{doc.name}</span>
                  <span className="ml-auto shrink-0">{relTime(doc.mtime)}</span>
                </div>
              )}
            </button>
          ))}

          {/* 公司库（WeKnora）区块：company tab 为主体；all 检索态作为追加段 */}
          {(lib === 'company' || (lib === 'all' && isSearch)) && (
            <>
              {lib === 'all' && list.length > 0 && companyList.length > 0 && (
                <div className="my-2 flex items-center gap-2 px-1">
                  <span className="text-my-2xs font-semibold uppercase tracking-wide text-my-tertiary">知识库（WeKnora）</span>
                  <span className="h-px flex-1 bg-my-line" />
                </div>
              )}
              {companyList.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => void openRemoteDoc({ knowledgeId: c.knowledgeId, title: c.title })}
                  aria-pressed={remoteDoc?.knowledgeId === c.knowledgeId}
                  className={clsx(
                    'mb-1.5 w-full rounded-my-lg border px-3 py-2 text-left transition-colors',
                    remoteDoc?.knowledgeId === c.knowledgeId
                      ? 'border-my-line-accent-subtle bg-my-accent-subtle'
                      : 'border-transparent hover:border-my-line hover:bg-my-layer-1'
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="my-chip bg-my-accent-subtle text-my-2xs text-my-accent-text">
                      <Cloud size={12} /> 知识库
                    </span>
                    <span className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-primary">{c.title}</span>
                    {c.score !== undefined && <span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{c.score.toFixed(2)}</span>}
                  </div>
                  {c.snippet ? (
                    <div className="mt-1 line-clamp-2 text-my-xs leading-4 text-my-tertiary">{c.snippet.replace(/\s+/g, ' ').slice(0, 200)}</div>
                  ) : (
                    <div className="mt-1 truncate font-mono text-my-xs text-my-tertiary">{c.sub}</div>
                  )}
                </button>
              ))}
              {companyLoading && (
                <div className="flex items-center gap-2 px-2 py-3 text-my-xs text-my-tertiary">
                  <Loader2 size={12} className="animate-spin" /> 正在检索知识库（WeKnora）…
                </div>
              )}
              {companyError && (
                <div className="mx-1 mb-1.5 rounded-my-lg border border-my-line-warning bg-my-warning-subtle px-2.5 py-2 text-my-xs leading-4 text-my-warning-text">
                  知识库不可用：{companyError}
                  {lib === 'all' && '（本地结果不受影响）'}
                </div>
              )}
              {lib === 'company' && !weknoraEnabled && (
                <div className="grid place-items-center gap-2 py-10 text-center text-my-xs text-my-tertiary">
                  <Cloud size={20} className="text-my-icon-tertiary" />
                  未启用知识库联动
                  <Button variant="outline" size="sm" onClick={() => setPage('settings')}>
                    到设置页接入 WeKnora
                  </Button>
                </div>
              )}
            </>
          )}

          {list.length === 0 && !loading && lib !== 'company' && (
            <div className="grid place-items-center gap-2 py-14 text-center text-my-xs text-my-tertiary">
              <Library size={20} className="text-my-icon-tertiary" />
              {isSearch ? '没有匹配的文档——试试更短的关键词' : '该库暂无文档'}
            </div>
          )}
        </div>
      </div>

      {/* 右列：当前知识视图与阅读器 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-my-surface-1">
        <div className="my-page-toolbar-row">
          <h1 className="text-my-md font-semibold text-my-primary">{knowledgeView === 'company' ? '知识库' : '资料'}</h1>
          <button type="button" onClick={toggleSidebar} aria-expanded={browserVisible} aria-controls="knowledge-browser" aria-label={browserVisible ? '收起来源与检索' : '展开来源与检索'} title={browserVisible ? '收起来源与检索' : '展开来源与检索'} className="my-icon-control ml-auto">
            {browserVisible ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
        </div>
        <div ref={readerRef} tabIndex={-1} aria-label="知识阅读区" className="flex min-h-0 min-w-0 flex-1 flex-col bg-my-surface-1 outline-none">
        {noteDraft ? (
          <>
            <div className="my-page-toolbar-row">
              <span className="my-chip bg-my-label-emerald text-my-label-emerald-text">
                <StickyNote size={12} /> {noteDraft.isNew ? '新建笔记' : '编辑笔记'}
              </span>
              <input
                value={noteDraft.name}
                onChange={(e) => setNoteDraft({ ...noteDraft, name: e.target.value })}
                placeholder="笔记名（支持中英文/数字/空格）"
                className="min-w-0 max-w-[260px] flex-1 rounded-my-md border border-my-line bg-my-layer-2 px-2 py-1 font-mono text-my-xs text-my-primary outline-none focus:border-my-line-accent"
                disabled={!noteDraft.isNew}
              />
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="primary" size="sm" onClick={() => void saveNote()} disabled={noteSaving}>
                  {noteSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存
                </Button>
                <Button variant="ghost" size="sm" className="px-1.5" onClick={() => { docSeq.current += 1; setNoteDraft(null) }} title="取消">
                  <X size={13} />
                </Button>
              </div>
            </div>
            <div className="my-page-workspace-padding min-h-0 flex-1">
              <textarea
                value={noteDraft.content}
                onChange={(e) => setNoteDraft({ ...noteDraft, content: e.target.value })}
                spellCheck={false}
                className="h-full w-full resize-none rounded-my-lg border border-my-line bg-my-surface-1 p-4 font-mono text-my-sm leading-6 text-my-primary outline-none focus:border-my-line-accent"
                placeholder="# 标题&#10;&#10;用 Markdown 记录知识，保存后立即进入五库检索与 AI 问答…"
              />
            </div>
          </>
        ) : remoteDoc ? (
          <>
            <div className="my-page-toolbar-row">
              <span className="my-chip bg-my-accent-subtle text-my-2xs text-my-accent-text">
                <Cloud size={12} /> 知识库
              </span>
              <span className="min-w-0 truncate text-my-xs font-semibold text-my-primary">{remoteDoc.title}</span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="ghost" size="sm" className="px-1.5" onClick={() => setRemoteDoc(null)} title="关闭">
                  <X size={13} />
                </Button>
              </div>
            </div>
            <div className="my-scrollbar min-h-0 flex-1">
              <PageContent variant="centered">
                {remoteDoc.fileName && <div className="mb-3 truncate font-mono text-my-xs text-my-tertiary">{remoteDoc.fileName}</div>}
                {remoteDoc.loading && (
                  <div className="flex items-center gap-2 py-8 text-my-xs text-my-tertiary">
                    <Loader2 size={14} className="animate-spin" /> 正在从知识库读取正文…
                  </div>
                )}
                {remoteDoc.error && (
                  <div className="rounded-my-lg border border-my-line-danger bg-my-danger-subtle p-3 text-my-xs text-my-danger-text">{remoteDoc.error}</div>
                )}
                {remoteDoc.content !== null && (
                  remoteDoc.fileName.endsWith('.md') || remoteDoc.fileName.endsWith('.markdown') ? (
                    <MarkdownView content={remoteDoc.content} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words rounded-my-lg border border-my-line bg-my-surface-1 p-3 font-mono text-my-sm leading-5 text-my-primary">{remoteDoc.content}</pre>
                  )
                )}
              </PageContent>
            </div>
          </>
        ) : active ? (
          <>
            <div className="my-page-toolbar-row">
              <span className={clsx('my-chip', LIB_CHIP[active.library])}>
                {LIB_ICON[active.library]} {LIB_LABEL[active.library]}
              </span>
              <span className="min-w-0 truncate text-my-xs font-semibold text-my-primary">{active.title}</span>
              <span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{fmtBytes(active.size)} · {relTime(active.mtime)}</span>
              <div className="ml-auto flex items-center gap-1.5">
                {!active.synthetic && active.library === 'spec' && (
                  <Button variant="ghost" size="sm" onClick={() => openSpecDocument(active.path)}>去规范页编辑</Button>
                )}
                {!active.synthetic && active.library === 'notes' && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => startEditNote(active)} title="编辑这篇笔记">
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-1.5 text-my-danger-text"
                      onClick={() => void deleteNote(active)}
                      title="删除笔记"
                    >
                      <Trash2 size={12} />
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" className="px-1.5" onClick={() => void api.revealInExplorer(active.path)} title="在资源管理器显示">
                  <ExternalLink size={12} />
                </Button>
                <Button variant="ghost" size="sm" className="px-1.5" onClick={() => { docSeq.current += 1; setActive(null) }} title="关闭">
                  <X size={13} />
                </Button>
              </div>
            </div>
            <div className="my-scrollbar min-h-0 flex-1">
              <PageContent variant="centered">
                <div className="mb-3 truncate font-mono text-my-xs text-my-tertiary" title={active.path}>{active.path}</div>
                {docError && <div className="rounded-my-lg border border-my-line-danger bg-my-danger-subtle p-3 text-my-xs text-my-danger-text">{docError}</div>}
                {active.synthetic && (
                  <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-4 text-my-xs leading-6 text-my-primary">
                    这是任务提炼的合成文档（task.json 的描述 / 备注 / 子任务）。原始 JSON：
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-2"
                      onClick={() => openArtifact({ name: 'task.json', path: active.path, kind: 'file', size: active.size, mtime: active.mtime, ext: '.json' }, true)}
                    >
                      查看 task.json
                    </Button>
                  </div>
                )}
                {!active.synthetic && relativePath !== null && snapshot && (
                  <DocumentReader key={`${snapshot.meta.root}:${active.path}`} workspaceId={snapshot.meta.root} relativePath={relativePath} />
                )}
                {relativePath === null && docContent !== null && (active.path.endsWith('.md') || active.path.endsWith('.markdown') ? (
                  <MarkdownView content={docContent} />
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-my-lg border border-my-line bg-my-surface-1 p-3 font-mono text-my-sm leading-5 text-my-primary">{docContent}</pre>
                ))}
              </PageContent>
            </div>
          </>
        ) : (
          <div className="my-scrollbar grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 py-8">
            <section className="w-full max-w-lg rounded-my-xl border border-my-line bg-my-layer-1 px-7 py-8 text-center shadow-[var(--my-shadow-raised-100)]">
              <span className="mx-auto grid h-11 w-11 place-items-center rounded-my-xl bg-my-layer-2 text-my-icon-tertiary">
                <Library size={22} />
              </span>
              <p className="mt-4 text-my-xs font-medium text-my-tertiary">{lib === 'company' ? '知识库' : '项目知识库'}</p>
              <h2 className="mt-1 text-my-lg font-semibold text-my-primary">从材料中找到答案</h2>
              <p className="mx-auto mt-2 max-w-md text-my-sm leading-relaxed text-my-secondary">
                选择左侧的笔记、需求或文档开始阅读；也可以在下方直接提问。WeKnora 知识库按独立配置检索。
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {!aiEnabled && <Button variant="primary" size="sm" onClick={() => setPage('settings')}><Sparkles size={12} />配置 AI 问答</Button>}
                <Button variant="outline" size="sm" onClick={() => setPage('gateway')} title="到 MCP 网关查看与配置本地 MCP 服务">
                  <BrainCircuit size={12} /> 前往 MCP 知识网关
                </Button>
              </div>
            </section>
          </div>
        )}

        {/* AI 问答条 */}
        {aiEnabled && (
          <div className="shrink-0 border-t border-my-line bg-my-layer-1 py-2.5">
            {qaHistory.length > 0 && (
              <PageSection variant="centered" className="mb-2">
                <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  className="flex w-full items-center gap-1.5 text-my-xs text-my-tertiary hover:text-my-secondary"
                >
                  <History size={11} /> 本机个人问答历史（跨项目，{qaHistory.length}）
                  <span className="flex-1" />
                  <span className="text-my-placeholder">{showHistory ? '收起' : '展开'}</span>
                </button>
                  {!showHistory && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void api.kbQaClear().then(() => setQaHistory([]))
                      }}
                      className="ml-2 text-my-placeholder hover:text-my-danger-text"
                      title="清空问答历史"
                    >
                      清空
                    </button>
                  )}
                </div>
                {showHistory && (
                  <div className="my-scrollbar mt-1.5 max-h-40 space-y-1 overflow-y-auto">
                    {qaHistory.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => {
                          setAiQuestion(h.question)
                          setAiAnswer(h.answer)
                          setAiSources([])
                          setAiRemoteSources([])
                        }}
                        className="block w-full truncate rounded-my-md border border-my-line bg-my-layer-2 px-2.5 py-1.5 text-left text-my-xs text-my-secondary hover:border-my-line-strong hover:text-my-primary"
                        title={h.question}
                      >
                        <span className="text-my-placeholder">{relTime(h.createdAt)}</span> · {h.question}
                      </button>
                    ))}
                  </div>
                )}
              </PageSection>
            )}
            {aiAnswer && (
              <PageSection variant="centered" className="mb-2.5">
                <div className="rounded-my-lg border border-my-line-accent-subtle bg-my-accent-subtle p-3">
                  <MarkdownView content={aiAnswer} />
                  {aiSources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1 border-t border-my-line pt-2">
                      {aiSources.map((s) => (
                        <button key={s.id} type="button" onClick={() => void openDoc(s)} className="my-chip border border-my-line bg-my-layer-2 text-my-2xs text-my-tertiary hover:text-my-primary">
                          {s.title}
                        </button>
                      ))}
                    </div>
                  )}
                  {aiRemoteSources.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {aiRemoteSources.map((h, i) => (
                        <button
                          key={`${h.knowledgeId}-${i}`}
                          type="button"
                          onClick={() => void openRemoteDoc({ knowledgeId: h.knowledgeId, title: h.title })}
                          className="my-chip border border-my-line-accent-subtle bg-my-surface-1 text-my-2xs text-my-accent-text hover:bg-my-accent-subtle"
                        >
                          <Cloud size={10} /> {h.title || h.filename}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </PageSection>
            )}
            <PageSection variant="centered" className="flex items-center gap-2">
              <Sparkles size={13} className="shrink-0 text-my-icon-accent" />
              <input
                value={aiQuestion}
                onChange={(e) => setAiQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void aiAsk()
                }}
                placeholder={`向${LIBS.find((l) => l.id === lib)?.label ?? '知识库'}提问…`}
                className="my-input flex-1"
              />
              <Button variant="primary" onClick={() => void aiAsk()} disabled={aiBusy || !aiQuestion.trim()}>
                {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} 提问
              </Button>
            </PageSection>
          </div>
        )}
        </div>
      </div>
      {/* 打开的产物查看器标签保留在最上层（外部组件渲染） */}
      {viewerTabs.length > 0 && null}
    </div>
  )
}
