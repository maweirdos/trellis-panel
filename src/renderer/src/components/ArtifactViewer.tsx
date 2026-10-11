import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { X, FileText, Copy, FileWarning, Code2, BookOpen, Pin, PinOff } from 'lucide-react'
import { api } from '../api'
import { useApp } from '../store'
import { clsx } from 'clsx'
import { JsonTree } from './JsonTree'
import { CodeView } from './CodeView'
import { fmtBytes } from '../utils/format'
import { ArtifactReader } from '../reader/ArtifactReader'
import { DocumentDiffPanel } from '../reader/DocumentDiffPanel'
import { ReaderNoticeStrip, ReaderVersionBar } from '../reader/ReaderVersionBar'
import { relativePathUnderRoot } from '../reader/reader-paths'
import { useDocumentReader } from '../reader/use-document-reader'
import { useEscLayer } from '../utils/use-esc-layer'
import type { FileEntry } from '../../../shared/types'

/**
 * 产物查看器（图形化优先）：
 * - 多标签页（VS Code 模型：预览标签复用、可固定）
 * - S0 G2 第三片：装载/错误/版本契约统一走 useDocumentReader（documentRead +
 *   阅读会话 + 定向变更信号），与 Tasks / TaskDetail 同一套，不另写一份。
 * - 正文专项渲染保留（零回归）：.json → 可折叠 JSON 树、.jsonl → 记录流卡片、
 *   代码/配置 → 语法高亮；markdown / task.json / 上下文清单走共享 ArtifactReader。
 * - 源码视图（graphic/raw）由查看器自己的按钮控制（ArtifactReader 隐藏内置切换）。
 */

const JSONL_CAP = 300

/* ---------------- JSONL record stream ---------------- */

function JsonlRecord({ line, idx }: { line: string; idx: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const parsed = useMemo<unknown>(() => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  }, [line])

  const chips = useMemo<Array<[string, string]>>(() => {
    if (!parsed || typeof parsed !== 'object') return []
    const out: Array<[string, string]> = []
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>).slice(0, 5)) {
      if (v !== null && !['object'].includes(typeof v)) out.push([k, String(v)])
    }
    return out
  }, [parsed])

  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className={clsx(
        'w-full rounded-lg border px-3 py-2 text-left transition-colors',
        open ? 'border-leaf-dim/40 bg-ink-850' : 'border-ink-700 bg-ink-850/50 hover:border-ink-500'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded bg-ink-750 px-1.5 font-mono text-[10px] text-mist-400">#{idx + 1}</span>
        {parsed === undefined ? (
          <span className="text-[11px] text-rose-300">JSON 解析失败（原文见源码视图）</span>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {chips.map(([k, v]) => (
              <span key={k} className="truncate font-mono text-[10.5px] text-mist-400">
                <span className="text-violet-300/80">{k}</span>={v}
              </span>
            ))}
          </div>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-mist-600">{open ? '收起' : '展开'}</span>
      </div>
      {open && parsed !== undefined && (
        <div className="mt-2">
          <JsonTree data={parsed} />
        </div>
      )}
    </button>
  )
}

function JsonlView({ content }: { content: string }): JSX.Element {
  const lines = useMemo(() => content.split('\n').filter((l) => l.trim().length > 0), [content])
  const shown = lines.slice(0, JSONL_CAP)
  return (
    <div className="space-y-1.5">
      {lines.length > JSONL_CAP && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
          共 {lines.length} 行，仅展示前 {JSONL_CAP} 行
        </div>
      )}
      {shown.map((l, i) => (
        <JsonlRecord key={i} line={l} idx={i} />
      ))}
      {lines.length === 0 && <div className="py-6 text-center text-xs text-mist-500">空文件</div>}
    </div>
  )
}

/* ---------------- 内容装载（共享 reader 契约） ---------------- */

export type ArtifactMode = 'graphic' | 'raw'

function ViewerBody({
  file,
  mode,
  relativePath
}: {
  file: FileEntry
  mode: ArtifactMode
  relativePath: string | null
}): JSX.Element {
  const projectRoot = useApp((s) => s.snapshot?.meta.root ?? '')
  const widthPref = useApp((s) => s.readerWidthPref)
  const reader = useDocumentReader({
    workspaceId: projectRoot,
    relativePath,
    absolutePath: file.path
  })

  const content = reader.displayedText
  const isMd = /\.(md|markdown)$/i.test(file.ext || file.name)
  const isJson = /\.json$/i.test(file.name)
  const isJsonl = /\.jsonl$/i.test(file.name)
  const parsedJson = useMemo<unknown>(() => {
    if (!isJson || !content) return undefined
    try {
      return JSON.parse(content)
    } catch {
      return undefined
    }
  }, [isJson, content])

  const session = reader.session
  const displayedRevision = session?.displayed?.revision ?? reader.doc?.revision ?? null
  const baseRevision = session?.base?.revision ?? null
  const latestRevision = session?.latest?.revision ?? null
  const diffTriggerRef = useRef<HTMLButtonElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const openDiffFrom = (m: 'pending' | 'git-latest-commit', el: HTMLButtonElement | null): void => {
    if (el !== null) diffTriggerRef.current = el
    reader.openDiff(m)
  }

  if (reader.loading) return <div className="p-6 text-xs text-mist-500">加载中…</div>
  if (reader.requestError !== null && content === null)
    return (
      <div className="flex items-center gap-2 p-6 text-xs text-rose-300">
        <FileWarning size={14} /> {reader.requestError}
      </div>
    )

  // 共享正文（markdown / task.json 卡片 / 上下文清单）：走 ArtifactReader，
  // 隐藏其内置 渲染/原文 切换（查看器头部已有同职责按钮）
  const useSharedReader = isMd || reader.displayedParsed?.kind === 'task-json' || reader.displayedParsed?.kind === 'context-manifest'

  return (
    <div ref={bodyRef} className="mx-auto w-full px-8 py-6" style={useSharedReader ? { maxWidth: `${widthPref}px` } : undefined}>
      {reader.legacy ? (
        <p className="mb-2 text-[11.5px] text-mist-400">
          该文件不在当前项目内：使用普通读取打开，不提供版本比较与变更提示。
        </p>
      ) : (
        <ReaderVersionBar
          displayedRevision={displayedRevision}
          baseRevision={baseRevision}
          latestRevision={latestRevision}
          pending={reader.pendingUpdate}
          onReadNew={(trigger) => {
            if (trigger !== null) diffTriggerRef.current = trigger
            void reader.applyNewVersionAnchored(bodyRef.current)
          }}
          onComparePending={(trigger) => openDiffFrom('pending', trigger)}
          onCompareGit={(trigger) => openDiffFrom('git-latest-commit', trigger)}
          onRebase={() => reader.rebaseToCurrent()}
          showWidthPref={false}
        />
      )}
      <ReaderNoticeStrip
        requestError={reader.requestError}
        unreadableNotice={reader.unreadableNotice}
        anchorNotice={null}
        onDismissAnchor={() => undefined}
        onRetry={() => reader.reload()}
      />
      {reader.diff !== null ? (
        <div className="pt-3">
          <DocumentDiffPanel
            state={reader.diff}
            displayedRevision={displayedRevision}
            latestRevision={latestRevision}
            onClose={() => reader.closeDiff()}
            returnFocusRef={diffTriggerRef}
          />
        </div>
      ) : mode === 'raw' ? (
        <div className="mx-auto max-w-5xl pt-3">
          <CodeView content={content ?? ''} ext={isMd ? '.txt' : file.ext} />
        </div>
      ) : useSharedReader ? (
        <div className="pt-3">
          <ArtifactReader
            relativePath={relativePath ?? file.name}
            rawText={content}
            parsed={reader.displayedParsed}
            diagnostics={reader.diagnostics}
            maxWidthPx={widthPref}
            hideViewToggle
          />
        </div>
      ) : (
        <div className="mx-auto max-w-5xl pt-3">
          {isJson &&
            (parsedJson !== undefined ? (
              <JsonTree data={parsedJson} />
            ) : (
              <>
                <div className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
                  JSON 解析失败，展示源码
                </div>
                <CodeView content={content ?? ''} ext={file.ext} />
              </>
            ))}
          {isJsonl && <JsonlView content={content ?? ''} />}
          {!isJson && !isJsonl && <CodeView content={content ?? ''} ext={file.ext} />}
        </div>
      )}
    </div>
  )
}

/* ---------------- viewer shell ---------------- */

export function ArtifactViewer({ projectName }: { projectName: string }): JSX.Element | null {
  const tabs = useApp((s) => s.viewerTabs)
  const active = useApp((s) => s.viewerActive)
  const closeArtifact = useApp((s) => s.closeArtifact)
  const pinArtifact = useApp((s) => s.pinArtifact)
  const setViewerActive = useApp((s) => s.setViewerActive)
  const projectRoot = useApp((s) => s.snapshot?.meta.root ?? '')
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<ArtifactMode>('graphic')

  const activeTab = tabs.find((t) => t.file.path === active) ?? null
  const file = activeTab?.file
  const relativePath = file !== undefined ? relativePathUnderRoot(projectRoot, file.path) : null

  // reset to graphic view when switching files
  useEffect(() => {
    setMode('graphic')
  }, [active])

  // keep a copy of the active content for the copy button (loaded separately, cheap)
  const [contentForCopy, setContentForCopy] = useState('')
  useEffect(() => {
    if (!file) return
    let alive = true
    api.readTextFile(file.path).then((res) => {
      if (alive) setContentForCopy(res.ok ? res.content ?? '' : '')
    })
    return () => {
      alive = false
    }
  }, [file])

  // S0 G2 第三片：Esc 关闭标签走全局 Esc 层（overlay），每次只关一层
  useEscLayer(activeTab !== null, {
    kind: 'overlay',
    id: 'artifact-viewer',
    onClose: () => {
      if (activeTab) closeArtifact(activeTab.file.path)
    }
  })

  if (tabs.length === 0 || !file || !activeTab) return null

  const hasGraphic = /\.(md|markdown|json|jsonl|ya?ml|toml|py|ts|tsx|js|mjs|cjs|sh|ps1|cmd|bat|log|sql|css|html|ini|cfg|env|txt)$/i.test(file.name)

  const copy = async (): Promise<void> => {
    await api.copyToClipboard(contentForCopy)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="absolute inset-0 z-40 flex animate-fade-in flex-col bg-ink-900">
      {/* tab strip */}
      <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-ink-700 bg-ink-850">
        {tabs.map((t) => (
          <div
            key={t.file.path}
            onClick={() => setViewerActive(t.file.path)}
            onDoubleClick={() => pinArtifact(t.file.path, !t.pinned)}
            onAuxClick={(e) => {
              if (e.button === 1) closeArtifact(t.file.path)
            }}
            className={clsx(
              'group flex cursor-pointer items-center gap-1.5 border-r border-ink-700 px-3 py-2 text-[11.5px] transition-colors',
              t.file.path === active ? 'bg-ink-900 text-mist-100' : 'text-mist-400 hover:bg-ink-750/60 hover:text-mist-200'
            )}
          >
            <FileText size={11} className={clsx('shrink-0', t.file.path === active ? 'text-leaf' : 'text-mist-600')} />
            <span className={clsx('max-w-[160px] truncate', !t.pinned && 'italic')}>{t.file.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                pinArtifact(t.file.path, !t.pinned)
              }}
              className={clsx('shrink-0 rounded p-0.5 transition-opacity', t.pinned ? 'text-leaf' : 'text-mist-600 opacity-0 hover:text-mist-200 group-hover:opacity-100')}
              title={t.pinned ? '取消固定（预览标签）' : '固定标签'}
            >
              {t.pinned ? <Pin size={10} /> : <PinOff size={10} />}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeArtifact(t.file.path)
              }}
              className="shrink-0 rounded p-0.5 text-mist-600 hover:text-rose-300"
              title="关闭标签"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-850 px-4 py-2">
        <FileText size={14} className="shrink-0 text-leaf" />
        <div className="min-w-0">
          <div className="truncate font-mono text-[10px] text-mist-500" title={file.path}>
            {projectName} / 产物 · {fmtBytes(file.size)}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {hasGraphic && (
            <button
              onClick={() => pinArtifact(file.path, !activeTab.pinned)}
              className="btn-outline"
              title={activeTab.pinned ? '取消固定' : '固定标签（固定后不被预览替换）'}
            >
              {activeTab.pinned ? <Pin size={12} className="text-leaf" /> : <PinOff size={12} />}
            </button>
          )}
          {hasGraphic && (
            <button
              onClick={() => setMode((m) => (m === 'graphic' ? 'raw' : 'graphic'))}
              className={clsx('btn-outline', mode === 'raw' && 'border-leaf-dim/50 text-leaf-soft')}
              title="切换 图形化 / 源码 视图"
            >
              {mode === 'graphic' ? <Code2 size={12} /> : <BookOpen size={12} />}
              {mode === 'graphic' ? '源码视图' : '图形视图'}
            </button>
          )}
          <button onClick={() => void copy()} className="btn-outline">
            <Copy size={12} /> {copied ? '已复制' : '复制'}
          </button>
          <button onClick={() => closeArtifact(file.path)} className="btn-ghost px-2 py-1.5" title="关闭 (Esc)">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <ViewerBody key={file.path} file={file} mode={mode} relativePath={relativePath} />
      </div>
    </div>
  )
}
