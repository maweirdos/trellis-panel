import { useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { CircleAlert, Maximize2, RefreshCw } from 'lucide-react'
import { useApp } from '../store'
import { ArtifactReader } from './ArtifactReader'
import { DocumentDiffPanel } from './DocumentDiffPanel'
import { ReaderNoticeStrip, ReaderVersionBar } from './ReaderVersionBar'
import { useDocumentReader } from './use-document-reader'
import type { DocumentReaderController } from './use-document-reader'
import type { ReaderOrigin } from '../../../shared/document-windows'
import { FixedDocumentActions } from './FixedDocumentActions'
import { computeHeadingAnchors } from './heading-anchors'

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
  origin?: ReaderOrigin
  showOutline?: boolean
}

export function DocumentReader({
  workspaceId,
  taskRef,
  relativePath,
  variant = 'full',
  onExpand,
  expandLabel = '展开为完整工作区',
  headerExtra,
  origin
}: DocumentReaderProps): JSX.Element {
  const reader = useDocumentReader({ workspaceId, taskRef, relativePath })
  return <DocumentReaderSurface reader={reader} relativePath={relativePath} variant={variant} onExpand={onExpand} expandLabel={expandLabel} headerExtra={headerExtra} origin={origin} />
}

/** The same renderer/chrome with a host-owned controller; no second load/version engine. */
export function DocumentReaderSurface({
  reader, relativePath, variant = 'full', onExpand, expandLabel = '展开为完整工作区', headerExtra, origin, showOutline = true
}: Pick<DocumentReaderProps, 'relativePath' | 'variant' | 'onExpand' | 'expandLabel' | 'headerExtra' | 'origin' | 'showOutline'> & {
  reader: DocumentReaderController
}): JSX.Element {
  const [widthPref, setWidthPref] = useState(() => useApp.getState().readerWidthPref)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const headings = useMemo(() => computeHeadingAnchors(reader.displayedText ?? ''), [reader.displayedText])
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
        <div className="-mt-16 max-w-md rounded-my-lg border border-my-line bg-my-layer-1 p-5 text-center">
          <CircleAlert size={22} className="mx-auto text-my-icon-secondary" />
          <p className="mt-2 text-my-sm text-my-tertiary">
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
        width={widthPref}
        onWidthChange={setWidthPref}
        extra={
          <>
          {showOutline && <button type="button" className="my-chip text-my-secondary hover:text-my-primary" disabled={headings.length === 0} onClick={() => setOutlineOpen((value) => !value)}>目录</button>}
          <FixedDocumentActions version={reader.doc?.fixedVersion} unavailable={reader.doc?.fixedVersionError} origin={origin} />
          {headerExtra}
          {onExpand !== undefined ? (
            <button
              type="button"
              onClick={onExpand}
              className="my-chip shrink-0 border border-my-line-accent-subtle text-my-accent-text transition-colors hover:bg-my-accent-subtle"
              title={expandLabel}
            >
              <Maximize2 size={11} className="mr-1 inline align-[-1px]" />
              {expandLabel}
            </button>
          ) : null}
          </>
        }
      />

      {outlineOpen && <nav aria-label="阅读器文档目录" className="my-scrollbar max-h-48 overflow-auto border-b border-my-line py-2">{headings.map((heading) => <button key={heading.id} type="button" className="block w-full truncate py-1 text-left text-my-xs text-my-secondary hover:text-my-accent-text" style={{ paddingLeft: `${Math.min(heading.level - 1, 3) * 12}px` }} onClick={() => {
        const target = [...(rootRef.current?.querySelectorAll<HTMLElement>('[id]') ?? [])].find((element) => element.id === heading.id)
        if (target) target.scrollIntoView({ block: 'start' }); else setAnchorNotice('请切回渲染视图后定位章节')
      }}>{heading.text}</button>)}</nav>}

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
      ) : null}
      {reader.loading ? (
        <div className="flex items-center gap-2 py-10 text-my-sm text-my-secondary">
          <RefreshCw size={13} className="animate-spin" /> 正在加载文档…
        </div>
      ) : (
        <div className={reader.diff !== null ? 'hidden' : 'min-h-0 flex-1 pt-3'}>
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
