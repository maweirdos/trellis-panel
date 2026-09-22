import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
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
  History
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { fmtBytes, relTime } from '../utils/format'
import { MarkdownView } from '../components/MarkdownView'
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
  { id: 'notes', label: '我的笔记', icon: <StickyNote size={14} />, desc: '.trellis/notes 我的知识笔记（可新建 / 编辑 / 删除）' },
  { id: 'requirements', label: '需求库', icon: <ScrollText size={14} />, desc: '原始需求文档（活动任务 PRD / task.json 提炼）' },
  { id: 'spec', label: '规范库', icon: <BookOpenText size={14} />, desc: '.trellis/spec 团队规范' },
  { id: 'wiki', label: 'Wiki 库', icon: <FileText size={14} />, desc: 'README / docs / wiki 等仓库文档' },
  { id: 'archive', label: '归档库', icon: <Archive size={14} />, desc: '已归档任务的沉淀经验' },
  { id: 'company', label: '公司库', icon: <Cloud size={14} />, desc: 'WeKnora 公司级知识（跨项目规范 / 历史归档 / 接口文档）' },
  { id: 'all', label: '全部', icon: <Library size={14} />, desc: '跨库联合检索（本地五库 + 公司库异步追加）' }
]

function highlight(text: string): JSX.Element {
  const parts = text.split(/[\u0000\u0001]/)
  // 奇数下标是命中片段
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-leaf-dim/30 px-0.5 text-leaf-soft">{p}</mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

export function KnowledgePage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const pushToast = useApp((s) => s.pushToast)
  const viewerTabs = useApp((s) => s.viewerTabs)
  const openArtifact = useApp((s) => s.openArtifact)
  const setPage = useApp((s) => s.setPage)

  const [lib, setLib] = useState<LibFilter>('requirements')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [result, setResult] = useState<KbSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState<KbDoc | null>(null)
  const [docContent, setDocContent] = useState<string | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const searchSeq = useRef(0)

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

  /* 我的笔记：编辑态 */
  const [noteDraft, setNoteDraft] = useState<{ name: string; content: string; isNew: boolean } | null>(null)
  const [noteSaving, setNoteSaving] = useState(false)

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
      } finally {
        if (seq === companySeq.current) setCompanyLoading(false)
      }
    },
    [debounced, weknoraEnabled, weknoraKbIds]
  )

  const runSearch = useCallback(async () => {
    const seq = ++searchSeq.current
    if (lib === 'company') {
      setResult(null)
      setActive(null)
      void runCompanySearch(debounced ? 'search' : 'browse')
      return
    }
    setLoading(true)
    const res = await api.kbSearch(lib, debounced)
    if (seq !== searchSeq.current) return
    setLoading(false)
    if (res.ok) setResult(res)
    else pushToast({ kind: 'error', title: '检索失败', body: res.error })
    // 联邦检索：'all' 检索态下公司库命中异步追加
    if (lib === 'all' && debounced) void runCompanySearch('search')
    else {
      setCompanyHits([])
      setCompanyError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, debounced, runCompanySearch])

  useEffect(() => {
    void runSearch()
    // 切库时关闭远程阅读器
    setRemoteDoc(null)
  }, [runSearch, snapshot?.meta.root])

  const openDoc = useCallback(async (doc: KbDoc): Promise<void> => {
    setRemoteDoc(null)
    setActive(doc)
    setDocError(null)
    if (doc.synthetic) {
      setDocContent(null)
      return
    }
    const res = await api.readTextFile(doc.path)
    if (res.ok && res.content !== undefined) setDocContent(res.content)
    else {
      setDocContent(null)
      setDocError(res.error ?? '读取失败')
    }
  }, [])

  /** 打开公司库（WeKnora）文档：拉取 preview 正文 */
  const openRemoteDoc = useCallback(async (hit: { knowledgeId: string; title: string }): Promise<void> => {
    setActive(null)
    setRemoteDoc({ knowledgeId: hit.knowledgeId, title: hit.title, fileName: '', content: null, loading: true })
    const res = await api.weknoraRead(hit.knowledgeId)
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
            context += `\n\n--- 来源 [公司库]：${h.title || h.filename}（WeKnora）---\n${h.content.slice(0, 3000)}`
            remoteSources.push(h)
          }
          setAiRemoteSources(remoteSources)
        }
      }
      const res = await api.aiChat([
        {
          role: 'system',
          content:
            '你是项目知识助手。仅依据提供的知识库上下文回答问题；上下文不足时明确说明并给出建议去哪里补充。用中文回答，引用来源时标注标题（公司库来源注明 [公司库]）。'
        },
        { role: 'user', content: `知识库上下文：\n${context || '（未检索到相关内容）'}\n\n问题：${q}` }
      ])
      if (res.ok && res.content) {
        setAiAnswer(res.content)
        // 问答历史落盘（userData，个人维度）
        const sourcesForHistory = [
          ...sources.map((s) => ({ title: s.title, path: s.path, library: s.library })),
          ...remoteSources.map((h) => ({ title: h.title || h.filename || '公司库文档', path: h.knowledgeId, library: '公司库' }))
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

  /* 我的笔记：编辑动作 */
  const startNewNote = (): void => {
    setActive(null)
    setRemoteDoc(null)
    setNoteDraft({ name: '', content: '# 新笔记\n\n', isNew: true })
  }

  const startEditNote = (doc: KbDoc): void => {
    if (doc.synthetic) return
    void api.readTextFile(doc.path).then((r) => {
      setNoteDraft({ name: doc.name, content: r.ok && r.content ? r.content : '', isNew: false })
    })
  }

  const saveNote = async (): Promise<void> => {
    if (!noteDraft || noteSaving) return
    const name = noteDraft.name.trim()
    if (!name) {
      pushToast({ kind: 'error', title: '请填写笔记名' })
      return
    }
    setNoteSaving(true)
    try {
      const res = await api.kbSaveNote(name, noteDraft.content)
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
    const res = await api.kbDeleteNote(doc.name)
    if (res.ok) {
      pushToast({ kind: 'success', title: '笔记已删除' })
      setActive(null)
      void runSearch()
    } else {
      pushToast({ kind: 'error', title: '删除失败', body: res.error })
    }
  }

  useEffect(() => {
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

  return (
    <div className="flex h-full min-w-0 animate-fade-in bg-ink-900 text-mist-100">
      {/* 左列：检索与列表 */}
      <div className="flex w-[420px] shrink-0 flex-col border-r border-ink-750">
        <div className="space-y-2.5 border-b border-ink-750 px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {LIBS.map((l) => (
              <button
                key={l.id}
                onClick={() => setLib(l.id)}
                title={l.desc}
                className={clsx(
                  'chip border transition-colors',
                  lib === l.id ? 'border-leaf-dim/50 bg-leaf-dim/15 text-leaf-soft' : 'border-ink-750 text-mist-400 hover:text-mist-100'
                )}
              >
                {l.icon} {l.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="全文检索：中文/英文关键词混排…"
              className="field w-full pl-8"
            />
            {loading && <Loader2 size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-mist-400" />}
          </div>
          <div className="flex items-center gap-2 text-[10.5px] text-mist-400">
            <span>
              {lib === 'company'
                ? `${companyList.length} 条${isSearch ? '命中' : '文档'}${companyMs ? ` · ${companyMs}ms` : ''}`
                : `${isSearch ? `${list.length} 条命中` : `${list.length} 篇文档`} · 库内共 ${totalDocs} 篇 · ${result?.elapsedMs ?? 0}ms`}
            </span>
            {lib === 'notes' && (
              <button onClick={startNewNote} className="btn-outline px-1.5 py-0.5 text-[10px]" title="新建笔记（写入 .trellis/notes/，立即进入五库检索）">
                <Plus size={10} /> 新建笔记
              </button>
            )}
            <button onClick={() => void runSearch()} className="btn-ghost ml-auto justify-center px-1.5" title="重建检索">
              <RefreshCw size={11} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.map(({ doc, hit }) => (
            <button
              key={doc.id}
              onClick={() => void openDoc(doc)}
              className={clsx(
                'mb-1.5 w-full rounded-lg border px-3 py-2 text-left transition-colors',
                active?.id === doc.id ? 'border-leaf-dim/40 bg-leaf-dim/10' : 'border-transparent hover:border-ink-750 hover:bg-ink-850'
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={clsx('chip text-[9.5px]', doc.library === 'requirements' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : doc.library === 'spec' ? 'bg-leaf-dim/15 text-leaf-soft' : doc.library === 'wiki' ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300' : doc.library === 'notes' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' : 'bg-violet-500/15 text-violet-600 dark:text-violet-300')}>
                  {LIB_ICON[doc.library]} {LIB_LABEL[doc.library]}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-mist-100">{doc.title}</span>
                {hit && <span className="shrink-0 font-mono text-[9.5px] text-mist-400">{hit.score.toFixed(1)}</span>}
              </div>
              {hit ? (
                <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-mist-400">{highlight(hit.snippet)}</div>
              ) : (
                <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-mist-400">
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
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-mist-400">公司库（WeKnora）</span>
                  <span className="h-px flex-1 bg-ink-750" />
                </div>
              )}
              {companyList.map((c) => (
                <button
                  key={c.key}
                  onClick={() => void openRemoteDoc({ knowledgeId: c.knowledgeId, title: c.title })}
                  className={clsx(
                    'mb-1.5 w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    remoteDoc?.knowledgeId === c.knowledgeId
                      ? 'border-sky-400/40 bg-sky-500/10'
                      : 'border-transparent hover:border-ink-750 hover:bg-ink-850'
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="chip bg-sky-500/15 text-[9.5px] text-sky-600 dark:text-sky-300">
                      <Cloud size={12} /> 公司
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-mist-100">{c.title}</span>
                    {c.score !== undefined && <span className="shrink-0 font-mono text-[9.5px] text-mist-400">{c.score.toFixed(2)}</span>}
                  </div>
                  {c.snippet ? (
                    <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-mist-400">{c.snippet.replace(/\s+/g, ' ').slice(0, 200)}</div>
                  ) : (
                    <div className="mt-1 truncate font-mono text-[10.5px] text-mist-400">{c.sub}</div>
                  )}
                </button>
              ))}
              {companyLoading && (
                <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-mist-400">
                  <Loader2 size={12} className="animate-spin" /> 正在检索公司库（WeKnora）…
                </div>
              )}
              {companyError && (
                <div className="mx-1 mb-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[10.5px] leading-4 text-amber-700 dark:text-amber-300">
                  公司库不可用：{companyError}
                  {lib === 'all' && '（本地结果不受影响）'}
                </div>
              )}
              {lib === 'company' && !weknoraEnabled && (
                <div className="grid place-items-center gap-2 py-10 text-center text-xs text-mist-400">
                  <Cloud size={20} className="text-mist-400" />
                  未启用公司库联动
                  <button onClick={() => setPage('settings')} className="btn-outline text-[11px]">
                    到设置页接入 WeKnora
                  </button>
                </div>
              )}
            </>
          )}

          {list.length === 0 && !loading && lib !== 'company' && (
            <div className="grid place-items-center gap-2 py-14 text-center text-xs text-mist-400">
              <Library size={20} className="text-mist-400" />
              {isSearch ? '没有匹配的文档——试试更短的关键词' : '该库暂无文档'}
            </div>
          )}
        </div>
      </div>

      {/* 右列：阅读器 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {noteDraft ? (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-ink-750 px-5 py-2.5">
              <span className="chip bg-emerald-500/15 text-[9.5px] text-emerald-400">
                <StickyNote size={12} /> {noteDraft.isNew ? '新建笔记' : '编辑笔记'}
              </span>
              <input
                value={noteDraft.name}
                onChange={(e) => setNoteDraft({ ...noteDraft, name: e.target.value })}
                placeholder="笔记名（支持中英文/数字/空格）"
                className="min-w-0 max-w-[260px] flex-1 rounded-md border border-ink-600 bg-ink-850 px-2 py-1 font-mono text-xs text-mist-100 outline-none focus:border-leaf/60"
                disabled={!noteDraft.isNew}
              />
              <div className="ml-auto flex items-center gap-1.5">
                <button onClick={() => void saveNote()} disabled={noteSaving} className="btn-primary text-[11px]">
                  {noteSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存
                </button>
                <button onClick={() => setNoteDraft(null)} className="btn-ghost justify-center px-2" title="取消">
                  <X size={13} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 p-4">
              <textarea
                value={noteDraft.content}
                onChange={(e) => setNoteDraft({ ...noteDraft, content: e.target.value })}
                spellCheck={false}
                className="h-full w-full resize-none rounded-lg border border-ink-700 bg-ink-900 p-4 font-mono text-[12.5px] leading-6 text-mist-100 outline-none focus:border-leaf/40"
                placeholder="# 标题&#10;&#10;用 Markdown 记录知识，保存后立即进入五库检索与 AI 问答…"
              />
            </div>
          </>
        ) : remoteDoc ? (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-ink-750 px-5 py-2.5">
              <span className="chip bg-sky-500/15 text-[9.5px] text-sky-400">
                <Cloud size={12} /> 公司库
              </span>
              <span className="min-w-0 truncate text-xs font-semibold text-mist-100">{remoteDoc.title}</span>
              <div className="ml-auto flex items-center gap-1.5">
                <button onClick={() => setRemoteDoc(null)} className="btn-ghost justify-center px-2" title="关闭">
                  <X size={13} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mx-auto max-w-[760px]">
                {remoteDoc.fileName && <div className="mb-3 truncate font-mono text-[10.5px] text-mist-400">{remoteDoc.fileName}</div>}
                {remoteDoc.loading && (
                  <div className="flex items-center gap-2 py-8 text-xs text-mist-400">
                    <Loader2 size={14} className="animate-spin" /> 正在从公司库读取正文…
                  </div>
                )}
                {remoteDoc.error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-400">{remoteDoc.error}</div>}
                {remoteDoc.content !== null && (
                  remoteDoc.fileName.endsWith('.md') || remoteDoc.fileName.endsWith('.markdown') ? (
                    <MarkdownView content={remoteDoc.content} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words rounded-lg border border-ink-750 bg-ink-850 p-3 font-mono text-[12px] leading-5 text-mist-100">{remoteDoc.content}</pre>
                  )
                )}
              </div>
            </div>
          </>
        ) : active ? (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-ink-750 px-5 py-2.5">
              <span className={clsx('chip text-[9.5px]', `lib-${active.library}`)}>
                {LIB_ICON[active.library]} {LIB_LABEL[active.library]}
              </span>
              <span className="min-w-0 truncate text-xs font-semibold text-mist-100">{active.title}</span>
              <span className="shrink-0 font-mono text-[10px] text-mist-400">{fmtBytes(active.size)} · {relTime(active.mtime)}</span>
              <div className="ml-auto flex items-center gap-1.5">
                {!active.synthetic && active.library === 'spec' && (
                  <button onClick={() => setPage('spec')} className="btn-ghost text-[11px]">去规范页编辑</button>
                )}
                {!active.synthetic && active.library === 'notes' && (
                  <>
                    <button onClick={() => startEditNote(active)} className="btn-ghost text-[11px]" title="编辑这篇笔记">
                      编辑
                    </button>
                    <button
                      onClick={() => void deleteNote(active)}
                      className="btn-ghost px-2 text-rose-300 hover:text-rose-200"
                      title="删除笔记"
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
                <button onClick={() => void api.revealInExplorer(active.path)} className="btn-ghost justify-center px-2" title="在资源管理器显示">
                  <ExternalLink size={12} />
                </button>
                <button onClick={() => setActive(null)} className="btn-ghost justify-center px-2" title="关闭">
                  <X size={13} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mx-auto max-w-[760px]">
                <div className="mb-3 truncate font-mono text-[10.5px] text-mist-400" title={active.path}>{active.path}</div>
                {docError && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-400">{docError}</div>}
                {active.synthetic && (
                  <div className="rounded-lg border border-ink-750 bg-ink-850 p-4 text-xs leading-6 text-mist-100">
                    这是任务提炼的合成文档（task.json 的描述 / 备注 / 子任务）。原始 JSON：
                    <button onClick={() => openArtifact({ name: 'task.json', path: active.path, kind: 'file', size: active.size, mtime: active.mtime, ext: '.json' }, true)} className="btn-ghost ml-2 text-[11px]">
                      查看 task.json
                    </button>
                  </div>
                )}
                {docContent !== null && (active.path.endsWith('.md') || active.path.endsWith('.markdown') ? (
                  <MarkdownView content={docContent} />
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-lg border border-ink-750 bg-ink-850 p-3 font-mono text-[12px] leading-5 text-mist-100">{docContent}</pre>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="grid h-full place-items-center">
            <div className="max-w-md space-y-3 p-8 text-center">
              <Library size={36} className="mx-auto text-mist-400" />
              <div className="text-sm font-semibold text-mist-100">五库知识库</div>
              <p className="text-xs leading-5 text-mist-400">笔记 · 需求 · 规范 · Wiki · 归档，本地倒排索引，毫秒级检索，AI 问答带来源引用。</p>
              {!aiEnabled && (
                <button onClick={() => setPage('settings')} className="btn-ghost mx-auto text-[11px]">
                  <Sparkles size={12} /> 到设置页接入 AI 模型（baseUrl 自定义）
                </button>
              )}
              <button onClick={() => setPage('gateway')} className="btn-outline mx-auto text-[11px]" title="到 MCP 网关查看与配置本地 MCP 服务">
                <BrainCircuit size={12} /> 前往 MCP 知识网关
              </button>
            </div>
          </div>
        )}

        {/* AI 问答条 */}
        {aiEnabled && (
          <div className="shrink-0 border-t border-ink-750 bg-ink-850/40 px-4 py-2.5">
            {qaHistory.length > 0 && (
              <div className="mx-auto mb-2 max-w-3xl">
                <button
                  onClick={() => setShowHistory((v) => !v)}
                  className="flex w-full items-center gap-1.5 text-[10.5px] text-mist-400 hover:text-mist-200"
                >
                  <History size={11} /> 问答历史（{qaHistory.length}）
                  <span className="flex-1" />
                  <span className="text-mist-500">{showHistory ? '收起' : '展开'}</span>
                  {!showHistory && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void api.kbQaClear().then(() => setQaHistory([]))
                      }}
                      className="ml-2 text-mist-500 hover:text-rose-300"
                      title="清空问答历史"
                    >
                      清空
                    </button>
                  )}
                </button>
                {showHistory && (
                  <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
                    {qaHistory.map((h) => (
                      <button
                        key={h.id}
                        onClick={() => {
                          setAiQuestion(h.question)
                          setAiAnswer(h.answer)
                          setAiSources([])
                          setAiRemoteSources([])
                        }}
                        className="block w-full truncate rounded-md border border-ink-750/70 bg-ink-850/60 px-2.5 py-1.5 text-left text-[11px] text-mist-300 hover:border-ink-650 hover:text-mist-100"
                        title={h.question}
                      >
                        <span className="text-mist-500">{relTime(h.createdAt)}</span> · {h.question}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {aiAnswer && (
              <div className="mx-auto mb-2.5 max-w-3xl">
                <div className="rounded-lg border border-leaf-dim/30 bg-leaf-dim/5 p-3">
                  <MarkdownView content={aiAnswer} />
                  {aiSources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1 border-t border-ink-750/60 pt-2">
                      {aiSources.map((s) => (
                        <button key={s.id} onClick={() => void openDoc(s)} className="chip bg-ink-850 text-[9.5px] text-mist-400 hover:text-mist-100 border border-ink-750">
                          {s.title}
                        </button>
                      ))}
                    </div>
                  )}
                  {aiRemoteSources.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {aiRemoteSources.map((h, i) => (
                        <button key={`${h.knowledgeId}-${i}`} onClick={() => void openRemoteDoc({ knowledgeId: h.knowledgeId, title: h.title })} className="chip bg-sky-500/10 text-[9.5px] text-sky-600 dark:text-sky-300 hover:bg-sky-500/20">
                          <Cloud size={10} /> {h.title || h.filename}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="mx-auto flex max-w-3xl items-center gap-2">
              <Sparkles size={13} className="shrink-0 text-leaf-soft" />
              <input
                value={aiQuestion}
                onChange={(e) => setAiQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void aiAsk()
                }}
                placeholder={`向${LIBS.find((l) => l.id === lib)?.label ?? '知识库'}提问…`}
                className="field flex-1"
              />
              <button onClick={() => void aiAsk()} disabled={aiBusy || !aiQuestion.trim()} className="btn-primary disabled:opacity-40">
                {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} 提问
              </button>
            </div>
          </div>
        )}
      </div>
      {/* 打开的产物查看器标签保留在最上层（外部组件渲染） */}
      {viewerTabs.length > 0 && null}
    </div>
  )
}
