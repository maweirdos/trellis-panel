import { useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { CircleAlert, Maximize2, RefreshCw } from 'lucide-react'
import { useApp } from '../store'
import { ArtifactReader } from './ArtifactReader'
import { DocumentDiffPanel } from './DocumentDiffPanel'
import { ReaderNoticeStrip, ReaderVersionBar } from './ReaderVersionBar'
import { useDocumentReader } from './use-document-reader'

/**
 * DocumentReader（S0 G2 第三片，design §6.1）：三入口共享的文档阅读容器——
 * useDocumentReader（加载/错误/版本契约）+ ArtifactReader（正文呈现）+
 * ReaderVersionBar（非模态版本提示）+ 统一单列对比面板 + 锚点恢复。
 *
 * - Tasks 工作区与 TaskDetail 预览直接挂本组件（full / compact 两形态）；
 *   ArtifactViewer 复用同一 hook 与版本条，但保留自己的专项正文渲染。
 * - 「阅读新版」按稳定标题锚点 + 段内偏移恢复滚动；锚点消失回退最近存活
 *   章节并给一次性提示（AC2 / design §6.2）。
 * - pendingUpdate 只出提示，不碰正文与选区。
 */

export interface DocumentReaderProps {
  workspaceId: string
  taskRef?: string
  relativePath: string | null
  /** compact = 快速预览窄形态（隐藏宽度偏好等次要工具）。 */
  variant?: 'full' | 'compact'
  /** 「展开为完整工作区」入口（TaskDetail 提供）。 */
  onExpand?: () => void
  expandLabel?: string
  /** 头部右侧附加动作（宿主既有按钮，零回归保留）。 */
  headerExtra?: ReactNode
}

export function DocumentReader({
  workspaceId,
  taskRef,
  relativePath,
  variant = 'full',
  onExpand,
  expandLabel = '展开为完整工作区'
}: DocumentReaderProps): JSX.Element {
  const reader = useDocumentReader({ workspaceId, taskRef, relativePath })
  const widthPref = useApp((s) => s.readerWidthPref)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const diffTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [anchorNotice, setAnchorNotice] = useState<string | null>(null)

  const session = reader.session
  const displayedRevision = session?.displayed?.revision ?? reader.doc?.revision ?? null
  const baseRevision = session?.base?.revision ?? null
  const latestRevision = session?.latest?.revision ?? null

  const onReadNew = async (trigger: HTMLButtonElement | null): Promise<void> => {
    if (trigger !== null) diffTriggerRef.current = trigger
    const result = await reader.applyNewVersionAnchored(rootRef.current)
    if (result !== null && result.fallback) {
      setAnchorNotice('原章节已不存在，已定位到最近的存活章节（或按原位置截断恢复）')
    }
  }

  const openDiffFrom = (mode: 'pending' | 'git-latest-commit', el: HTMLButtonElement | null): void => {
    if (el !== null) diffTriggerRef.current = el
    reader.openDiff(mode)
  }

  if (relativePath === null) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="-mt-16 max-w-md rounded-lg border border-ink-200 bg-ink-50/60 p-5 text-center dark:border-ink-700 dark:bg-ink-850/40">
          <CircleAlert size={22} className="mx-auto text-mist-400" />
          <p className="mt-2 text-[12.5px] text-mist-500">
            该文件在当前项目根之外，共享阅读器无法读取；可在文件查看器中查看。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="mx-auto flex min-h-full w-full flex-col" style={{ maxWidth: `${widthPref}px` }}>
      <ReaderVersionBar
        displayedRevision={displayedRevision}
        baseRevision={baseRevision}
        latestRevision={latestRevision}
        pending={reader.pendingUpdate}
        onReadNew={(trigger) => void onReadNew(trigger)}
        onComparePending={(trigger) => openDiffFrom('pending', trigger)}
        onCompareGit={(trigger) => openDiffFrom('git-latest-commit', trigger)}
        onRebase={() => reader.rebaseToCurrent()}
        showWidthPref={variant === 'full'}
        extra={
          onExpand !== undefined ? (
            <button
              type="button"
              onClick={onExpand}
              className="chip shrink-0 border border-leaf-dim/40 text-[10.5px] text-leaf-soft transition-colors hover:bg-leaf-dim/10"
              title={expandLabel}
            >
              <Maximize2 size={11} className="mr-1 inline align-[-1px]" />
              {expandLabel}
            </button>
          ) : undefined
        }
      />

      <ReaderNoticeStrip
        requestError={reader.requestError}
        unreadableNotice={reader.unreadableNotice}
        anchorNotice={anchorNotice}
        onDismissAnchor={() => setAnchorNotice(null)}
        onRetry={() => reader.reload()}
      />

      {/* 正文 / 对比面板 */}
      {reader.diff !== null ? (
        <div className="min-h-0 flex-1 pt-3">
          <DocumentDiffPanel
            state={reader.diff}
            displayedRevision={displayedRevision}
            latestRevision={latestRevision}
            onClose={() => {
              reader.closeDiff()
            }}
            returnFocusRef={diffTriggerRef}
          />
        </div>
      ) : reader.loading ? (
        <div className="flex items-center gap-2 py-10 text-[12.5px] text-mist-400">
          <RefreshCw size={13} className="animate-spin" /> 正在加载文档…
        </div>
      ) : (
        <div className="min-h-0 flex-1 pt-3">
          <ArtifactReader
            relativePath={relativePath}
            rawText={reader.displayedText}
            parsed={reader.displayedParsed}
            diagnostics={reader.diagnostics}
            maxWidthPx={widthPref}
          />
        </div>
      )}
    </div>
  )
}
