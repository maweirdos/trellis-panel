import React, { useState, useMemo } from 'react'
import { LayoutTemplate, Copy, Check } from 'lucide-react'
import type { JSX } from 'react'

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
        <span key={match.index} className="text-mist-500/75 select-none font-normal">
          {token}
        </span>
      )
    } else if (/^\[[^\]]+\]$/.test(token)) {
      parts.push(
        <span key={match.index} className="text-leaf-soft font-medium">
          {token}
        </span>
      )
    } else if (/^[□☑✓✗]$/.test(token)) {
      parts.push(
        <span key={match.index} className="text-leaf">
          {token}
        </span>
      )
    } else if (/^[★●▲▼▶◀]$/.test(token)) {
      parts.push(
        <span key={match.index} className="text-amber-400">
          {token}
        </span>
      )
    } else if (token === '||') {
      parts.push(
        <span key={match.index} className="text-mist-400">
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
  const [copied, setCopied] = useState(false)

  const lines = useMemo(() => chart.split('\n'), [chart])

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(chart)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-ink-700 bg-ink-950/60 shadow-sm backdrop-blur-sm">
      {/* 顶栏控制条 */}
      <div className="flex h-8 items-center justify-between border-b border-ink-700/80 bg-ink-850/80 px-3 text-[11px]">
        <div className="flex items-center gap-1.5 font-medium text-mist-200">
          <LayoutTemplate size={13} className="text-leaf" />
          <span>UI 原型草图 · 线框图</span>
          <span className="rounded bg-ink-750 px-1 py-0.2 font-mono text-[9.5px] text-mist-400">Wireframe</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-mist-400 hover:bg-ink-750 hover:text-mist-200 transition-colors cursor-pointer"
            title="复制线框图原文"
          >
            {copied ? <Check size={11} className="text-leaf" /> : <Copy size={11} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>

      {/* 线框图画布主体：消除行高断缝，确保字符连续拼接（使用 div 彻底规避 .md pre 全局注入边框） */}
      <div
        className="m-0 max-w-full overflow-x-auto p-3.5 font-mono select-text transition-all leading-[1.18] text-[11px]"
        style={{
          fontFamily:
            "'Cascadia Code', 'Cascadia Mono', Consolas, 'Fira Code', 'SimSun', 'NSimSun', monospace",
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
