import React, { useMemo } from 'react'
import { LayoutTemplate, Copy, Check } from 'lucide-react'
import type { JSX } from 'react'
import { useCopyFeedback } from '../utils/use-copy-feedback'

/**
 * 高亮 ASCII 线框图中的 UI 语义元素（边框、按钮、复选框、状态圆点等）
 * 注意：仅改变文本色彩，绝不改变字符字体或内边距，确保 100% 保持等宽网格对齐。
 */
function highlightAsciiLine(line: string): React.ReactNode {
  const tokenRegex = /([┌┐└┘├┤│─┬┴╔╗╚╝║╠╣═╬┼+]+|\[[^\]]+\]|[□☑✓✗★●▲▼▶◀]|\|\|)/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (/^[┌┐└┘├┤│─┬┴╔╗╚╝║╠╣═╬┼+]+$/.test(token)) {
      parts.push(
        <span key={match.index} className="text-my-icon-tertiary select-none font-normal">
          {token}
        </span>
      )
    } else if (/^\[[^\]]+\]$/.test(token)) {
      parts.push(
        <span key={match.index} className="text-my-accent-text font-medium">
          {token}
        </span>
      )
    } else if (/^[□☑✓✗]$/.test(token)) {
      parts.push(
        <span key={match.index} className="text-my-accent-text">
          {token}
        </span>
      )
    } else if (/^[★●▲▼▶◀]$/.test(token)) {
      parts.push(
        <span key={match.index} className="text-my-warning-text">
          {token}
        </span>
      )
    } else if (token === '||') {
      parts.push(
        <span key={match.index} className="text-my-tertiary">
          {token}
        </span>
      )
    } else {
      parts.push(token)
    }
    lastIndex = tokenRegex.lastIndex
  }

  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex))
  }

  return parts
}

export const AsciiDiagramBlock = React.memo(function AsciiDiagramBlock({ chart }: { chart: string }): JSX.Element {
  const { status, copy } = useCopyFeedback(chart)

  const lines = useMemo(() => chart.split('\n'), [chart])

  return (
    <div className="my-4 overflow-hidden rounded-my-base border border-my-line bg-my-canvas shadow-xs">
      {/* 顶栏控制条 */}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-1 border-b border-my-line bg-my-layer-2 px-3 text-my-xs">
        <div className="flex flex-wrap items-center gap-1.5 font-medium text-my-secondary">
          <LayoutTemplate size={13} className="text-my-icon-accent" />
          <span>UI 原型草图 · 线框图</span>
          <span className="rounded-my-base bg-my-layer-3 px-1 py-0.5 font-mono text-my-2xs text-my-tertiary">Wireframe</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copy(chart)}
            aria-disabled={status === 'copying'}
            className="flex min-h-6 items-center gap-1 rounded-my-base px-1.5 py-0.5 text-my-2xs text-my-tertiary hover:bg-my-layer-1-hover hover:text-my-secondary transition-colors cursor-pointer"
            title="复制线框图原文"
          >
            {status === 'copied' ? <Check size={11} aria-hidden="true" className="text-my-accent-text" /> : <Copy size={11} aria-hidden="true" />}
            <span>{status === 'copied' ? '已复制' : status === 'copying' ? '正在复制…' : status === 'error' ? '重试复制' : '复制'}</span>
          </button>
        </div>
      </div>
      <div role="status" aria-live="polite" className={status === 'error' ? 'px-3 py-1 text-my-xs text-my-danger-text' : 'sr-only'}>{status === 'error' ? '复制失败，请重试或选择文字复制' : status === 'copied' ? '线框图已复制' : ''}</div>

      {/* 线框图画布主体：消除行高断缝，确保字符连续拼接（使用 div 彻底规避 .md pre 全局注入边框） */}
      <div
        className="m-0 max-w-full overflow-x-auto p-3.5 font-mono select-text transition-all leading-[1.18] text-my-xs text-my-secondary"
        style={{
          fontFamily: 'var(--my-font-diagram)',
          fontVariantLigatures: 'none'
        }}
      >
        {lines.map((line, idx) => (
          <div key={idx} className="whitespace-pre">
            {highlightAsciiLine(line)}
          </div>
        ))}
      </div>
    </div>
  )
})
