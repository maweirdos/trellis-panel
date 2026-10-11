import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { AlertTriangle, CircleAlert, Eye, FileCode2, Info } from 'lucide-react'
import { clsx } from 'clsx'
import type {
  DocumentDiagnostic,
  DocumentParsed,
  DocumentDiagnosticSeverity,
  TaskJsonParsed
} from '../../../shared/documents'
import { MarkdownView } from '../components/MarkdownView'
import { CodeView } from '../components/CodeView'
import { JsonTree } from '../components/JsonTree'
import { ContextManifestView } from './ContextManifestView'
import { headingAnchorsByLine } from './heading-anchors'
import { DEFAULT_READER_WIDTH_PREF } from './reader-prefs'

/**
 * ArtifactReader（S0 G2 基础组件，design §6.1）：三入口共享的文档阅读基础件。
 * 本片以 props 驱动、不接入页面——加载/错误/版本会话编排由下一片挂载时提供。
 *
 * 职责边界：只读观察——markdown（复用 MarkdownView + 稳定标题锚点）、
 * task.json 卡片（复用 JsonTree + 原始 JSON 始终可见）、上下文清单
 * （ContextManifestView，未知用中性色）、原文 CodeView 切换、阅读宽度偏好（max-width）。
 * 不直接读文件/IPC；诊断原样呈现，不猜测语义。
 */

const MARKDOWN_EXTS = new Set(['.md', '.markdown'])

const extOf = (p: string): string => {
  const i = p.lastIndexOf('.')
  return i >= 0 ? p.slice(i).toLowerCase() : ''
}

const SEVERITY_VIEW: Record<DocumentDiagnosticSeverity, { icon: typeof Info; cls: string }> = {
  neutral: { icon: Info, cls: 'text-mist-400' },
  warning: { icon: AlertTriangle, cls: 'text-amber-500' },
  error: { icon: CircleAlert, cls: 'text-rose-500' }
}

function DiagnosticsStrip({ diagnostics }: { diagnostics: DocumentDiagnostic[] }): JSX.Element | null {
  if (diagnostics.length === 0) return null
  return (
    <ul className="space-y-1">
      {diagnostics.map((d, i) => {
        const view = SEVERITY_VIEW[d.severity]
        const Icon = view.icon
        return (
          <li key={i} className="flex items-start gap-1.5 text-[12px] leading-5">
            <Icon size={13} className={clsx('mt-1 shrink-0', view.cls)} />
            <span className="text-mist-500">{d.message}</span>
          </li>
        )
      })}
    </ul>
  )
}

function FieldRow({ label, value }: { label: string; value: string | null }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 py-1">
      <span className="w-20 shrink-0 text-[11px] text-mist-400">{label}</span>
      <span
        className={clsx(
          'min-w-0 break-all text-[12.5px]',
          value === null ? 'italic text-mist-400' : 'text-slate-700 dark:text-mist-200'
        )}
      >
        {value ?? '未知'}
      </span>
    </div>
  )
}

/** task.json 卡片：常见属性 + JsonTree 全量结构（未知字段不隐藏；原文经视图切换始终可见）。 */
function TaskJsonCard({ parsed, rawText }: { parsed: TaskJsonParsed; rawText: string | null }): JSX.Element {
  const full = useMemo<{ ok: boolean; value: unknown }>(() => {
    if (rawText === null) return { ok: false, value: null }
    try {
      return { ok: true, value: JSON.parse(rawText) as unknown }
    } catch {
      // parsed 存在则解析必已成功；防御半写竞态下回退为仅字段视图
      return { ok: false, value: null }
    }
  }, [rawText])

  const f = parsed.fields
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-ink-200 bg-ink-50/50 px-4 py-3 dark:border-ink-700 dark:bg-ink-850/40">
        <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          <FieldRow label="ID" value={f.id} />
          <FieldRow label="名称" value={f.name} />
          <FieldRow label="标题" value={f.title} />
          <FieldRow label="状态" value={f.status} />
          <FieldRow label="优先级" value={f.priority} />
          <FieldRow label="负责人" value={f.assignee} />
          <FieldRow label="创建者" value={f.creator} />
          <FieldRow label="创建时间" value={f.createdAt} />
          <FieldRow label="完成时间" value={f.completedAt} />
        </div>
        <p className="mt-2 text-[11px] text-mist-400">
          状态为任务记录原文，不代表实施/检查已依次完成；未知字段见下方结构树。
        </p>
      </div>
      {full.ok && <JsonTree data={full.value} />}
    </div>
  )
}

function EmptyState({ message }: { message: string }): JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="-mt-24 text-center">
        <FileCode2 size={36} className="mx-auto text-mist-300" />
        <p className="mt-3 text-[13px] text-mist-400">{message}</p>
      </div>
    </div>
  )
}

export interface ArtifactReaderProps {
  /** 相对项目根路径（展示与扩展名推断）。 */
  relativePath: string
  /** 原始文本；null = 未装载（缺失/暂不可读/超限）。 */
  rawText: string | null
  /** 结构化解析结果（documentRead 契约）；null = 不适用或解析失败。 */
  parsed: DocumentParsed | null
  /** documentRead 诊断（缺失/坏行/超限等），原样呈现。 */
  diagnostics: DocumentDiagnostic[]
  /** 阅读最大宽度偏好（680/760/880，store 持久化；缺省 760）。 */
  maxWidthPx?: number
  initialView?: 'rendered' | 'raw'
}

export function ArtifactReader({
  relativePath,
  rawText,
  parsed,
  diagnostics,
  maxWidthPx = DEFAULT_READER_WIDTH_PREF,
  initialView = 'rendered'
}: ArtifactReaderProps): JSX.Element {
  const [view, setView] = useState<'rendered' | 'raw'>(initialView)
  const ext = extOf(relativePath)
  const isMarkdown = MARKDOWN_EXTS.has(ext)
  // 稳定锚点：仅 markdown 且有文本时预计算（memoized，重渲染不重算——react-pitfalls）
  const headingAnchors = useMemo(
    () => (isMarkdown && rawText !== null ? headingAnchorsByLine(rawText) : undefined),
    [isMarkdown, rawText]
  )

  const canToggle = rawText !== null
  const renderedBody = (): JSX.Element => {
    if (parsed?.kind === 'task-json') return <TaskJsonCard parsed={parsed} rawText={rawText} />
    if (parsed?.kind === 'context-manifest') return <ContextManifestView parsed={parsed} />
    if (isMarkdown && rawText !== null) {
      return <MarkdownView content={rawText} headingAnchorsByLine={headingAnchors} />
    }
    if (rawText !== null) return <CodeView content={rawText} ext={ext} />
    return <EmptyState message="文档内容尚未装载（见上方诊断）" />
  }

  return (
    <div className="mx-auto flex min-h-full w-full flex-col" style={{ maxWidth: `${maxWidthPx}px` }}>
      <div className="flex items-center gap-2 border-b border-ink-100 pb-2 dark:border-ink-700/60">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mist-400" title={relativePath}>
          {relativePath}
        </span>
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="视图切换">
          <button
            type="button"
            disabled={!canToggle && view === 'rendered'}
            onClick={() => setView('rendered')}
            className={clsx(
              'chip border text-[10.5px]',
              view === 'rendered'
                ? 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-300'
                : 'border-ink-200 text-mist-500 hover:border-sky-200 dark:border-ink-600'
            )}
          >
            <Eye size={11} className="mr-1 inline align-[-1px]" />
            渲染
          </button>
          <button
            type="button"
            disabled={!canToggle}
            onClick={() => setView('raw')}
            className={clsx(
              'chip border text-[10.5px]',
              view === 'raw'
                ? 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-300'
                : 'border-ink-200 text-mist-500 hover:border-sky-200 dark:border-ink-600'
            )}
          >
            <FileCode2 size={11} className="mr-1 inline align-[-1px]" />
            原文
          </button>
        </div>
      </div>

      <DiagnosticsStrip diagnostics={diagnostics} />

      <div className="min-h-0 flex-1 pt-3">
        {view === 'raw' && canToggle ? <CodeView content={rawText} ext={ext} /> : renderedBody()}
      </div>
    </div>
  )
}
