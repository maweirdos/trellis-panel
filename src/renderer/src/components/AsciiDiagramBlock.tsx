import React, { useState, useMemo } from 'react'
import { LayoutTemplate, Copy, Check, ZoomIn, ZoomOut, AlignLeft } from 'lucide-react'
import { clsx } from 'clsx'
import type { JSX } from 'react'

/**
 * 计算单个字符在东亚等宽终端/网格环境下的视觉占位宽度（全角 2，半角 1）
 */
function charVisualWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  // ASCII 字符与基本制表符为半角 1 列
  if (code >= 0x20 && code <= 0x7e) return 1
  if (code >= 0x2500 && code <= 0x257f) return 1

  // CJK 中日韩汉字、全角符号、扩展汉字为全角 2 列
  if (code >= 0x4e00 && code <= 0x9fff) return 2
  if (code >= 0x3400 && code <= 0x4dbf) return 2
  if (code >= 0xff01 && code <= 0xff60) return 2

  // 常见东亚 UI 符号、复选框、箭头、图标、Emoji 为全角 2 列
  if (
    (code >= 0x25a0 && code <= 0x25ff) || // 几何图形（□, ▼, etc.）
    (code >= 0x2600 && code <= 0x26ff) || // 符号（☑, ★, etc.）
    (code >= 0x2700 && code <= 0x27bf) || // 装饰符号
    code >= 0x1f300 // 彩色圆点等 Emoji（🟢, 🔵, 🟠, etc.）
  ) {
    return 2
  }

  return code > 0x7f ? 2 : 1
}

/**
 * 计算字符串的东亚视觉列宽
 */
function stringVisualWidth(str: string): number {
  let width = 0
  for (const char of str) {
    width += charVisualWidth(char)
  }
  return width
}

/**
 * 智能对齐线框图右侧尾部边框（解决因中英文混排、不同行字符数不均导致的右侧边框参差不齐问题）
 */
function alignBoxLines(chart: string): string {
  const lines = chart.split('\n')
  const trimmed = lines.map((l) => l.trimEnd())

  // 判断是否为线框闭合行（以线框开头，并以 ┐, ┘, ┤, │, |, || 结尾）
  const isBoxLine = (l: string): boolean =>
    /^[┌└├│+|]/.test(l.trimStart()) && /(\|\||[┐┘┤│|])$/.test(l)

  // 计算所有线框行的最大视觉列宽
  let maxBoxWidth = 0
  for (const line of trimmed) {
    if (isBoxLine(line)) {
      const w = stringVisualWidth(line)
      if (w > maxBoxWidth) maxBoxWidth = w
    }
  }

  if (maxBoxWidth === 0) return chart

  return trimmed
    .map((line) => {
      if (!isBoxLine(line)) return line

      const currentWidth = stringVisualWidth(line)
      const diff = maxBoxWidth - currentWidth
      if (diff <= 0) return line

      const tailMatch = line.match(/(\|\||[┐┘┤│|])$/)
      if (!tailMatch) return line

      const tail = tailMatch[0]
      const body = line.slice(0, line.length - tail.length)

      // 如果主体末尾为水平线 ─、═ 或 -，则补齐水平线使线框闭合连贯
      if (/[─═-]/.test(body.slice(-1))) {
        const fillChar = body.slice(-1)
        return body + fillChar.repeat(diff) + tail
      }

      // 普通内容行补空格，使右侧边框对齐到相同垂直列
      return body + ' '.repeat(diff) + tail
    })
    .join('\n')
}

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
  const [zoom, setZoom] = useState<'sm' | 'base'>('sm')
  const [autoAlign, setAutoAlign] = useState(true)

  // 处理对齐后的文本内容
  const processedChart = useMemo(() => {
    return autoAlign ? alignBoxLines(chart) : chart
  }, [chart, autoAlign])

  const lines = useMemo(() => processedChart.split('\n'), [processedChart])

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(processedChart)
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
            onClick={() => setAutoAlign((a) => !a)}
            className={clsx(
              'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors cursor-pointer',
              autoAlign ? 'bg-leaf-dim/20 text-leaf-soft font-medium' : 'text-mist-400 hover:bg-ink-750 hover:text-mist-200'
            )}
            title={autoAlign ? '已开启尾部线框智能对齐（点击还原为原文）' : '点击开启尾部线框智能对齐'}
          >
            <AlignLeft size={11} />
            <span>{autoAlign ? '尾部对齐' : '原始对齐'}</span>
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => (z === 'sm' ? 'base' : 'sm'))}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-mist-400 hover:bg-ink-750 hover:text-mist-200 transition-colors cursor-pointer"
            title={zoom === 'sm' ? '切换为标准字号' : '切换为紧凑字号'}
          >
            {zoom === 'sm' ? <ZoomIn size={11} /> : <ZoomOut size={11} />}
            <span>{zoom === 'sm' ? '紧凑' : '标准'}</span>
          </button>
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
        className={clsx(
          'm-0 max-w-full overflow-x-auto p-3.5 font-mono select-text transition-all leading-[1.18]',
          zoom === 'sm' ? 'text-[11px]' : 'text-[12.5px]'
        )}
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
