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
  BrainCircuit
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { fmtBytes, relTime } from '../utils/format'
import { MarkdownView } from '../components/MarkdownView'
import type { KbDoc, KbHit, KbLibrary, KbSearchResult } from '../../../shared/types'
import type { JSX } from 'react'

type LibFilter = KbLibrary | 'all'

const LIBS: Array<{ id: LibFilter; label: string; icon: JSX.Element; desc: string }> = [
  { id: 'requirements', label: '需求库', icon: <ScrollText size={14} />, desc: '原始需求文档（活动任务 PRD / task.json 提炼）' },
  { id: 'spec', label: '规范库', icon: <BookOpenText size={14} />, desc: '.trellis/spec 团队规范' },
  { id: 'wiki', label: 'Wiki 库', icon: <FileText size={14} />, desc: 'README / docs / wiki 等仓库文档' },
  { id: 'archive', label: '归档库', icon: <Archive size={14} />, desc: '已归档任务的沉淀经验' },
  { id: 'all', label: '全部', icon: <Library size={14} />, desc: '跨库联合检索' }
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
  const [lib, setLib] = useState<LibFilter>('requirements')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [result, setResult] = useState<KbSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState<KbDoc | null>(null)
  const [docContent, setDocContent] = useState<string | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const searchSeq = useRef(0)

  /* AI 问答 */
  const aiEnabled = useApp((s) => s.settings?.ai.enabled ?? false)
  const [aiQuestion, setAiQuestion] = useState('')
  const [aiAnswer, setAiAnswer] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiSources, setAiSources] = useState<KbDoc[]>([])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const runSearch = useCallback(async () => {
    const seq = ++searchSeq.current
    setLoading(true)
    const res = await api.kbSearch(lib, debounced)
    if (seq !== searchSeq.current) return
    setLoading(false)
    if (res.ok) setResult(res)
    else pushToast({ kind: 'error', title: '检索失败', body: res.error })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, debounced])

  useEffect(() => {
    void runSearch()
  }, [runSearch, snapshot?.meta.root])

  const openDoc = useCallback(async (doc: KbDoc): Promise<void> => {
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

  /* 点击知识库文档时同步检索原文并打开阅读器 */
  const aiAsk = async (): Promise<void> => {
    const q = aiQuestion.trim()
    if (!q || aiBusy) return
    setAiBusy(true)
    setAiAnswer(null)
    setAiSources([])
    try {
      const search = await api.kbSearch(lib === 'all' ? 'all' : lib, q)
      const top = search.ok ? search.hits.slice(0, 6) : []
      let context = ''
      const sources: KbDoc[] = []
      for (const h of top) {
        const res = await api.readTextFile(h.doc.path)
        const content = res.ok && res.content ? res.content.slice(0, 4000) : h.snippet.replace(/[\u0000\u0001]/g, '')
        context += `\n\n--- 来源：${h.doc.title}（${h.doc.path}）---\n${content}`
        sources.push(h.doc)
      }
      const res = await api.aiChat([
        {
          role: 'system',
          content:
            '你是项目知识助手。仅依据提供的知识库上下文回答问题；上下文不足时明确说明并给出建议去哪里补充。用中文回答，引用来源时标注标题。'
        },
        { role: 'user', content: `知识库上下文：\n${context || '（未检索到相关内容）'}\n\n问题：${q}` }
      ])
      if (res.ok && res.content) {
        setAiAnswer(res.content)
        setAiSources(sources)
      } else {
        pushToast({ kind: 'error', title: 'AI 回答失败', body: res.error })
      }
    } finally {
      setAiBusy(false)
    }
  }

  const totalDocs = result?.totalDocs ?? 0
  const isSearch = debounced.length > 0
  const list: Array<{ doc: KbDoc; hit?: KbHit }> = useMemo(() => {
    if (!result) return []
    if (isSearch) return result.hits.map((h) => ({ doc: h.doc, hit: h }))
    return result.docs.map((d) => ({ doc: d }))
  }, [result, isSearch])

  const LIB_ICON: Record<KbLibrary, JSX.Element> = {
    requirements: <ScrollText size={12} />,
    spec: <BookOpenText size={12} />,
    wiki: <FileText size={12} />,
    archive: <Archive size={12} />
  }
  const LIB_LABEL: Record<KbLibrary, string> = {
    requirements: '需求',
    spec: '规范',
    wiki: 'Wiki',
    archive: '归档'
  }

  return (
    <div className="flex h-full min-w-0 animate-fade-in">
      {/* 左列：检索 */}
      <div className="flex w-[420px] shrink-0 flex-col border-r border-ink-700">
        <div className="space-y-2.5 border-b border-ink-700 px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {LIBS.map((l) => (
              <button
                key={l.id}
                onClick={() => setLib(l.id)}
                title={l.desc}
                className={clsx(
                  'chip border transition-colors',
                  lib === l.id ? 'border-leaf-dim/50 bg-leaf-dim/15 text-leaf-soft' : 'border-ink-600 text-mist-400 hover:text-mist-200'
                )}
              >
                {l.icon} {l.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="全文检索：中文/英文关键词混排…"
              className="field w-full pl-8"
            />
            {loading && <Loader2 size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-mist-500" />}
          </div>
          <div className="flex items-center gap-2 text-[10.5px] text-mist-500">
            <span>
              {isSearch ? `${list.length} 条命中` : `${list.length} 篇文档`} · 库内共 {totalDocs} 篇 · {result?.elapsedMs ?? 0}ms
            </span>
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
                active?.id === doc.id ? 'border-leaf-dim/40 bg-leaf-dim/10' : 'border-transparent hover:border-ink-600 hover:bg-ink-750/50'
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={clsx('chip text-[9.5px]', doc.library === 'requirements' ? 'bg-amber-500/15 text-amber-300' : doc.library === 'spec' ? 'bg-leaf-dim/15 text-leaf-soft' : doc.library === 'wiki' ? 'bg-sky-500/15 text-sky-300' : 'bg-violet-500/15 text-violet-300')}>
                  {LIB_ICON[doc.library]} {LIB_LABEL[doc.library]}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-mist-100">{doc.title}</span>
                {hit && <span className="shrink-0 font-mono text-[9.5px] text-mist-600">{hit.score.toFixed(1)}</span>}
              </div>
              {hit ? (
                <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-mist-400">{highlight(hit.snippet)}</div>
              ) : (
                <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-mist-600">
                  <span className="truncate font-mono">{doc.group}/{doc.name}</span>
                  <span className="ml-auto shrink-0">{relTime(doc.mtime)}</span>
                </div>
              )}
            </button>
          ))}
          {list.length === 0 && !loading && (
            <div className="grid place-items-center gap-2 py-14 text-center text-xs text-mist-500">
              <Library size={20} className="text-mist-600" />
              {isSearch ? '没有匹配的文档——试试更短的关键词' : '该库暂无文档'}
            </div>
          )}
        </div>
      </div>

      {/* 右列：阅读器 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 px-5 py-2.5">
              <span className={clsx('chip text-[9.5px]', `lib-${active.library}`)}>
                {LIB_ICON[active.library]} {LIB_LABEL[active.library]}
              </span>
              <span className="min-w-0 truncate text-xs font-semibold text-mist-100">{active.title}</span>
              <span className="shrink-0 font-mono text-[10px] text-mist-600">{fmtBytes(active.size)} · {relTime(active.mtime)}</span>
              <div className="ml-auto flex items-center gap-1.5">
                {!active.synthetic && active.library === 'spec' && (
                  <button onClick={() => useApp.getState().setPage('spec')} className="btn-ghost text-[11px]">去规范页编辑</button>
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
                <div className="mb-3 truncate font-mono text-[10.5px] text-mist-600" title={active.path}>{active.path}</div>
                {docError && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">{docError}</div>}
                {active.synthetic && (
                  <div className="rounded-lg border border-ink-600 bg-ink-800/60 p-4 text-xs leading-6 text-mist-300">
                    这是任务提炼的合成文档（task.json 的描述 / 备注 / 子任务）。原始 JSON：
                    <button onClick={() => useApp.getState().openArtifact({ name: 'task.json', path: active.path, kind: 'file', size: active.size, mtime: active.mtime, ext: '.json' }, true)} className="btn-ghost ml-2 text-[11px]">
                      查看 task.json
                    </button>
                  </div>
                )}
                {docContent !== null && (active.path.endsWith('.md') || active.path.endsWith('.markdown') ? (
                  <MarkdownView content={docContent} />
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[12px] leading-5 text-mist-300">{docContent}</pre>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="grid h-full place-items-center">
            <div className="max-w-md space-y-3 p-8 text-center">
              <Library size={36} className="mx-auto text-mist-600" />
              <div className="text-sm font-semibold text-mist-200">四库知识库</div>
              <p className="text-xs leading-5 text-mist-500">需求 · 规范 · Wiki · 归档，本地倒排索引，毫秒级检索。</p>
              {!aiEnabled && (
                <button onClick={() => useApp.getState().setPage('settings')} className="btn-ghost mx-auto text-[11px]">
                  <Sparkles size={12} /> 到设置页接入 AI 模型（baseUrl 自定义）
                </button>
              )}
              <button onClick={() => useApp.getState().setPage('settings')} className="btn-outline mx-auto text-[11px]" title="本地 stdio MCP 服务器：codex / Claude Code / ZCode 编码时随时 kb_search / kb_read，毫秒级">
                <BrainCircuit size={12} /> 接入 AI 编码工具作为持久记忆大脑（本地 MCP）
              </button>
            </div>
          </div>
        )}

        {/* AI 问答条 */}
        {aiEnabled && (
          <div className="shrink-0 border-t border-ink-700 bg-ink-850/40 px-4 py-2.5">
            {aiAnswer && (
              <div className="mx-auto mb-2.5 max-w-3xl">
                <div className="rounded-lg border border-leaf-dim/30 bg-leaf-dim/5 p-3">
                  <MarkdownView content={aiAnswer} />
                  {aiSources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1 border-t border-ink-700/60 pt-2">
                      {aiSources.map((s) => (
                        <button key={s.id} onClick={() => void openDoc(s)} className="chip bg-ink-750 text-[9.5px] text-mist-400 hover:text-mist-200">
                          {s.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="mx-auto flex max-w-3xl items-center gap-2">
              <Sparkles size={13} className="shrink-0 text-leaf" />
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
