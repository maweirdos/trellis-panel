import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { MermaidBlock } from './MermaidBlock'
import { AsciiDiagramBlock } from './AsciiDiagramBlock'

/** Heuristic: ASCII 线框图（box-drawing / +--- 风格）加宽展示并保持可横向滚动。 */
function looksLikeAsciiDiagram(text: string): boolean {
  if (text.length < 24 || !text.includes('\n')) return false
  const boxChars = (text.match(/[┌┐└┘├┤│─┬┴╔╗╚╝║╠╣═╬]/g) ?? []).length
  if (boxChars >= 8) return true
  const plusBox = (text.match(/^\s*\+[-=+|]+\+/gm) ?? []).length
  return plusBox >= 2
}

/**
 * 纵深防御（TPD-005）：当前未启用 rehype-raw，原始 HTML 本就不会渲染；
 * 挂 sanitize 保证未来任何人引入 rehype-raw 或升级管线时默认安全。
 * default schema 放行 code 的 language-* 类，mermaid 代码块路径不受影响。
 */
const REHYPE_PLUGINS = [rehypeSanitize]
const REMARK_PLUGINS = [remarkGfm]

export const MarkdownView = React.memo(function MarkdownView({ content }: { content: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          pre({ children, ...props }) {
            // 当代码块内容是自成一体的块级组件（AsciiDiagramBlock / MermaidBlock）时，直接返回该组件，彻底消除外层多余的 pre 边框与内边距
            const child = React.isValidElement(children)
              ? children
              : Array.isArray(children) && React.isValidElement(children[0])
                ? children[0]
                : null

            if (child) {
              const codeProps = child.props as { className?: string; children?: React.ReactNode }
              const text = String(codeProps?.children ?? '').replace(/\n$/, '')
              const className = codeProps?.className

              if (className?.includes('language-mermaid')) {
                return <MermaidBlock chart={text} />
              }
              if (!className && looksLikeAsciiDiagram(text)) {
                return <AsciiDiagramBlock chart={text} />
              }
            }
            return <pre {...props}>{children}</pre>
          },
          table({ children, ...props }) {
            return (
              <div className="my-4 overflow-x-auto rounded-lg border border-ink-700 bg-ink-900/40 shadow-xs">
                <table className="min-w-full w-max border-collapse text-left text-[12.5px]" {...props}>
                  {children}
                </table>
              </div>
            )
          },
          thead({ children, ...props }) {
            return (
              <thead className="border-b border-ink-700 bg-ink-850/90 text-mist-100 font-semibold" {...props}>
                {children}
              </thead>
            )
          },
          th({ children, ...props }) {
            return (
              <th
                className="border-r border-ink-700 last:border-r-0 px-4 py-2.5 text-left font-semibold tracking-wide text-mist-100 select-none break-keep"
                {...props}
              >
                {children}
              </th>
            )
          },
          tr({ children, ...props }) {
            return (
              <tr className="border-b border-ink-700/70 last:border-b-0 even:bg-ink-850/25 hover:bg-ink-800/40 transition-colors" {...props}>
                {children}
              </tr>
            )
          },
          td({ children, ...props }) {
            return (
              <td
                className="border-r border-ink-700/70 last:border-r-0 px-4 py-2.5 leading-relaxed text-mist-200 align-top break-keep break-words"
                {...props}
              >
                {children}
              </td>
            )
          },
          code({ className, children, ...props }) {
            const text = String(children ?? '').replace(/\n$/, '')
            if (className?.includes('language-mermaid')) {
              return <MermaidBlock chart={text} />
            }
            if (!className && looksLikeAsciiDiagram(text)) {
              return <AsciiDiagramBlock chart={text} />
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
