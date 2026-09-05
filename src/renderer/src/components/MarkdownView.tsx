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
