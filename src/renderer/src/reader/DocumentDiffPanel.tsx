import { useEffect, useId, useRef } from 'react'
import type { JSX, RefObject } from 'react'
import { X, GitCommitHorizontal, ArrowRight, Loader2, CircleAlert, Info } from 'lucide-react'
import { clsx } from 'clsx'
import type {
  DocumentDiffDiagnostic,
  DocumentDiffResult
} from '../../../shared/documents'
import { useEscLayer } from '../utils/use-esc-layer'
import type { ReaderDiffState } from './use-document-reader'

/**
 * DocumentDiffPanel（S0 G2 第三片，design §6.2）：统一单列 diff 呈现。
 * 语义红线：
 * - 只渲染纯文本行（DocumentDiffLine.text 为 worker 剥离控制字符后的文本，
 *   本组件以文本节点呈现，绝不 innerHTML/HTML 注入）；
 * - 红/绿只用左边线 + 行号着色表达，不整行重底色（正文可选择）；
 * - 基准文案必须说清比较对象（本次打开版本 / 最新候选 / 最近提交）。
 * 打开期间登记 Esc 层（overlay），每次只关一层；关闭后焦点回到触发按钮。
 */

const shortRev = (rev: string | null): string => (rev === null ? '—' : rev.slice(0, 8))

function DiffDiagnostics({ diagnostics }: { diagnostics: DocumentDiffDiagnostic[] }): JSX.Element | null {
  if (diagnostics.length === 0) return null
  return (
    <ul className="space-y-1">
      {diagnostics.map((d, i) => {
        const neutral = d.severity === 'neutral'
        const Icon = neutral ? Info : CircleAlert
        return (
          <li key={i} className="flex items-start gap-1.5 text-[12px] leading-5">
            <Icon size={13} className={clsx('mt-1 shrink-0', neutral ? 'text-mist-400' : 'text-amber-500')} />
            <span className="text-mist-500">{d.message}</span>
          </li>
        )
      })}
    </ul>
  )
}

function DiffBody({ result }: { result: DocumentDiffResult }): JSX.Element {
  if (result.identical) {
    return <p className="py-6 text-center text-[12.5px] text-mist-400">两侧内容一致，没有差异行。</p>
  }
  return (
    <div className="space-y-4">
      <p className="text-[11.5px] text-mist-400">
        +{result.stats.added} 行新增 · -{result.stats.removed} 行删除 · 计算耗时 {result.elapsedMs}ms
      </p>
      <div className="overflow-x-auto rounded-lg border border-ink-200 dark:border-ink-700">
        {result.hunks.map((hunk, hi) => (
          <div key={hi} className={clsx('border-ink-100 dark:border-ink-700/60', hi > 0 && 'border-t')}>
            <div className="select-none bg-ink-50 px-3 py-1 font-mono text-[10.5px] text-mist-400 dark:bg-ink-850/70">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, li) => (
              <div
                key={li}
                className={clsx(
                  'flex items-start gap-2 border-l-2 px-3 py-0.5 font-mono text-[11.5px] leading-5',
                  line.type === 'added' && 'border-emerald-400 dark:border-emerald-500',
                  line.type === 'removed' && 'border-rose-400 dark:border-rose-500',
                  line.type === 'context' && 'border-transparent'
                )}
              >
                <span className="w-10 shrink-0 select-none text-right text-mist-400">{line.oldLine ?? ''}</span>
                <span className="w-10 shrink-0 select-none text-right text-mist-400">{line.newLine ?? ''}</span>
                <span
                  className={clsx(
                    'w-3 shrink-0 select-none',
                    line.type === 'added' && 'text-emerald-600 dark:text-emerald-400',
                    line.type === 'removed' && 'text-rose-600 dark:text-rose-400',
                    line.type === 'context' && 'text-mist-400'
                  )}
                >
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                </span>
                <span className="min-w-0 flex-1 break-all whitespace-pre-wrap text-slate-700 dark:text-mist-200">
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export interface DocumentDiffPanelProps {
  state: ReaderDiffState
  /** 展示版/候选 revision（基准文案用）。 */
  displayedRevision: string | null
  latestRevision: string | null
  onClose: () => void
  /** 打开对比的触发按钮（Esc 关闭后焦点归还处）。 */
  returnFocusRef?: RefObject<HTMLElement | null>
}

export function DocumentDiffPanel({
  state,
  displayedRevision,
  latestRevision,
  onClose,
  returnFocusRef
}: DocumentDiffPanelProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  // 实例唯一层 ID：工作区与查看器可能同时各开一个对比面板，互不覆盖
  const escId = useId()
  useEscLayer(true, {
    kind: 'overlay',
    id: `reader-diff:${escId}`,
    onClose,
    returnFocusRef
  })

  useEffect(() => {
    // 打开后焦点落在关闭按钮上：键盘可达 + 关闭后焦点归还锚点
    closeRef.current?.focus()
  }, [])

  const baselineLabel =
    state.mode === 'pending' ? (
      <>
        本次展示版本 <span className="font-mono">{shortRev(displayedRevision)}</span>
        <ArrowRight size={11} className="mx-1 inline align-[-1px]" />
        最新候选 <span className="font-mono">{shortRev(latestRevision)}</span>
        <span className="ml-1 text-mist-400">（会话内比较，含未提交草稿）</span>
      </>
    ) : (
      <>
        <GitCommitHorizontal size={11} className="mr-1 inline align-[-1px]" />
        最近提交（HEAD）
        <ArrowRight size={11} className="mx-1 inline align-[-1px]" />
        本次展示版本 <span className="font-mono">{shortRev(displayedRevision)}</span>
      </>
    )

  return (
    <div
      role="region"
      aria-label="文档版本对比"
      className="flex min-h-0 flex-1 flex-col rounded-lg border border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-900"
    >
      <div className="flex items-center gap-2 border-b border-ink-100 px-3 py-2 dark:border-ink-700/60">
        <span className="min-w-0 flex-1 truncate text-[12px] text-mist-600 dark:text-mist-300">{baselineLabel}</span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-mist-400 transition-colors hover:bg-ink-100 hover:text-mist-700 dark:hover:bg-ink-750 dark:hover:text-mist-100"
          title="关闭对比 (Esc)"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" style={{ scrollbarGutter: 'stable' }}>
        {state.loading ? (
          <div className="flex items-center gap-2 py-8 text-[12.5px] text-mist-400">
            <Loader2 size={14} className="animate-spin" /> 正在计算差异…
          </div>
        ) : state.outcome === null ? (
          <p className="py-6 text-[12.5px] text-mist-400">对比请求失败，请重试或改用原文对比。</p>
        ) : state.outcome.ok ? (
          state.outcome.diff !== null ? (
            <DiffBody result={state.outcome.diff} />
          ) : (
            <DiffDiagnostics diagnostics={state.outcome.diagnostics} />
          )
        ) : (
          <p className="py-6 text-[12.5px] text-rose-500">{state.outcome.error}</p>
        )}
      </div>
    </div>
  )
}
