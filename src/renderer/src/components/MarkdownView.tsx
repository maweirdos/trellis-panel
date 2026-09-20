import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MermaidBlock } from './MermaidBlock'

/** Heuristic: ASCII 线框图（box-drawing / +--- 风格）加宽展示并保持可横向滚动。 */
function looksLikeAsciiDiagram(text: string): boolean {
  if (text.length < 24 || !text.includes('\n')) return false
  const boxChars = (text.match(/[┌┐└┘├┤│─┬┴╔╗╚╝║╠╣═╬]/g) ?? []).length
  if (boxChars >= 8) return true
  const plusBox = (text.match(/^\s*\+[-=+|]+\+/gm) ?? []).length
  return plusBox >= 2
}

export function MarkdownView({ content }: { content: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table({ children, ...props }) {
            return (
              <div className="my-4 overflow-x-auto rounded-xl border border-ink-700/80 bg-ink-900/50 shadow-sm">
                <table className="min-w-full border-collapse text-[12.5px]" {...props}>
                  {children}
                </table>
              </div>
            )
          },
          thead({ children, ...props }) {
            return (
              <thead className="border-b border-ink-700 bg-ink-800/90 text-mist-100 font-semibold" {...props}>
                {children}
              </thead>
            )
          },
          th({ children, ...props }) {
            return (
              <th
                className="whitespace-nowrap border-r border-ink-700/60 last:border-r-0 px-4 py-2.5 text-left font-semibold tracking-wide text-mist-100 select-none"
                {...props}
              >
                {children}
              </th>
            )
          },
          tr({ children, ...props }) {
            return (
              <tr className="border-b border-ink-800/60 last:border-b-0 transition-colors hover:bg-ink-800/30" {...props}>
                {children}
              </tr>
            )
          },
          td({ children, ...props }) {
            return (
              <td
                className="border-r border-ink-800/50 last:border-r-0 px-4 py-2.5 leading-relaxed text-mist-200 align-top"
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
              return (
                <div className="ascii-diagram">
                  <div className="ascii-diagram-label">ASCII 线框图</div>
                  <pre className="whitespace-pre">{text}</pre>
                </div>
              )
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
}
