import type { JSX, ReactNode } from 'react'
import { ArrowUpDown, CircleAlert, GitCompareArrows, RefreshCw, RotateCcw } from 'lucide-react'
import { clsx } from 'clsx'
import { useApp } from '../store'
import { READER_WIDTH_PREFS } from './reader-prefs'

/**
 * ReaderVersionBar（S0 G2 第三片）：三入口共用的版本工具条与「发现新版本」
 * 非模态提示（DocumentReader 与 ArtifactViewer 都挂本条，不各写一套）。
 *
 * 语义红线：
 * - pendingUpdate 只出提示——正文/选区不动（AC2 连续保存不重置阅读）；
 * - 「查看变化」说清比较基准（当前展示版 → 最新候选，会话内含未提交草稿）；
 * - 「与最近提交比较」独立入口，无 Git 基线由对比面板诊断如实降级。
 */

const shortRev = (rev: string | null): string => (rev === null ? '—' : rev.slice(0, 8))

export interface ReaderVersionBarProps {
  displayedRevision: string | null
  baseRevision: string | null
  latestRevision: string | null
  pending: boolean
  /** 「阅读新版」（含锚点恢复），trigger 用于焦点归还。 */
  onReadNew: (trigger: HTMLButtonElement | null) => void
  onComparePending: (trigger: HTMLButtonElement | null) => void
  onCompareGit: (trigger: HTMLButtonElement | null) => void
  onRebase: () => void
  /** 完整形态显示宽度偏好三档（查看器等宿主隐藏）。 */
  showWidthPref?: boolean
  /** 右侧附加内容（展开入口等）。 */
  extra?: ReactNode
}

export function ReaderVersionBar({
  displayedRevision,
  baseRevision,
  latestRevision,
  pending,
  onReadNew,
  onComparePending,
  onCompareGit,
  onRebase,
  showWidthPref = true,
  extra
}: ReaderVersionBarProps): JSX.Element {
  const widthPref = useApp((s) => s.readerWidthPref)
  const setWidthPref = useApp((s) => s.setReaderWidthPref)

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-ink-100 pb-2 dark:border-ink-700/60">
        <span
          className="shrink-0 font-mono text-[11px] text-mist-400"
          title={`展示版 ${displayedRevision ?? '—'} · 本次打开基线 ${baseRevision ?? '—'}`}
        >
          版本 {shortRev(displayedRevision)}
          {baseRevision !== null && displayedRevision !== null && baseRevision !== displayedRevision && (
            <span className="ml-1 text-mist-500">（本次打开 {shortRev(baseRevision)}）</span>
          )}
        </span>
        <button
          type="button"
          onClick={(e) => onCompareGit(e.currentTarget)}
          disabled={displayedRevision === null}
          className="chip shrink-0 border border-ink-200 text-[10.5px] text-mist-500 transition-colors hover:border-sky-200 hover:text-sky-700 disabled:opacity-40 dark:border-ink-600"
          title="比较基准：最近提交（HEAD） → 当前展示版本；无 Git 基线会如实说明"
        >
          <GitCompareArrows size={11} className="mr-1 inline align-[-1px]" />
          与最近提交比较
        </button>
        {showWidthPref && (
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="阅读宽度偏好">
            <ArrowUpDown size={11} className="text-mist-400" />
            {READER_WIDTH_PREFS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWidthPref(w)}
                className={clsx(
                  'rounded px-1.5 text-[10.5px] transition-colors',
                  widthPref === w
                    ? 'bg-sky-50 font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'
                    : 'text-mist-400 hover:text-mist-600 dark:hover:text-mist-200'
                )}
                title={`阅读最大宽度 ${w}px（实际不超过容器）`}
              >
                {w}
              </button>
            ))}
          </div>
        )}
        {extra !== undefined && <div className="ml-auto flex shrink-0 items-center gap-1">{extra}</div>}
      </div>

      {pending && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-1.5 dark:border-amber-500/30 dark:bg-amber-500/10">
          <span className="text-[12px] text-amber-700 dark:text-amber-300">发现新版本</span>
          <span className="font-mono text-[10.5px] text-amber-600/80 dark:text-amber-400/70">
            {shortRev(displayedRevision)} → {shortRev(latestRevision)}
          </span>
          <button
            type="button"
            onClick={(e) => onComparePending(e.currentTarget)}
            className="btn-ghost px-2 py-0.5 text-[11px]"
            title="比较基准：当前展示版本 → 最新候选（会话内比较，含未提交草稿）"
          >
            查看变化
          </button>
          <button type="button" onClick={(e) => onReadNew(e.currentTarget)} className="btn-primary px-2 py-0.5 text-[11px]">
            阅读新版
          </button>
          <button
            type="button"
            onClick={onRebase}
            className="btn-ghost px-1.5 py-0.5 text-[10.5px] text-mist-400"
            title="以当前展示版作为新的「本次打开」基线（此后的会话比较以它为基准）"
          >
            <RotateCcw size={10} className="mr-0.5 inline align-[-1px]" />
            以当前为本次基线
          </button>
        </div>
      )}
    </>
  )
}

/** 读取失败/不可读提示条（保留旧版时的诚实说明；三入口共用）。 */
export function ReaderNoticeStrip({
  requestError,
  unreadableNotice,
  anchorNotice,
  onDismissAnchor,
  onRetry
}: {
  requestError: string | null
  unreadableNotice: string | null
  anchorNotice: string | null
  onDismissAnchor: () => void
  onRetry: () => void
}): JSX.Element | null {
  if (requestError === null && unreadableNotice === null && anchorNotice === null) return null
  return (
    <>
      {requestError !== null && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-rose-300/70 bg-rose-50/80 px-3 py-1.5 text-[12px] text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          <CircleAlert size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">读取失败：{requestError}（已保留当前展示内容）</span>
          <button type="button" onClick={onRetry} className="btn-ghost px-1.5 py-0.5 text-[11px]">
            <RefreshCw size={10} className="mr-1 inline align-[-1px]" />
            重试
          </button>
        </div>
      )}
      {unreadableNotice !== null && (
        <div className="mt-2 rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-1.5 text-[12px] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {unreadableNotice}
        </div>
      )}
      {anchorNotice !== null && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50/80 px-3 py-1.5 text-[12px] text-mist-500 dark:border-ink-700 dark:bg-ink-850/50">
          <span className="min-w-0 flex-1">{anchorNotice}</span>
          <button type="button" onClick={onDismissAnchor} className="btn-ghost px-1.5 py-0.5 text-[10.5px]">
            知道了
          </button>
        </div>
      )}
    </>
  )
}
