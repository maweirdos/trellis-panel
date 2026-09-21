import React, { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import DOMPurify from 'dompurify'
import { errorText } from '../../../shared/errors'

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
let initialized = false

function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      if (!initialized) {
        m.default.initialize({
          startOnLoad: false,
          // strict：标签中的 HTML 被转义、禁用 click 回调（TPD-005）。
          // 渲染产物仍会过一遍 DOMPurify 再注入，双保险。
          securityLevel: 'strict',
          theme: isDark() ? 'dark' : 'neutral',
          fontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif'
        })
        initialized = true
      }
      return m.default
    })
  }
  return mermaidPromise
}

/** mermaid 渲染出的 SVG 注入 innerHTML 前必须消毒：图表源码可能来自外部文档/AI 输出 */
function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_ATTR: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'foreignObject'],
    FORBID_ATTR: ['srcset']
  })
}

export const MermaidBlock = React.memo(function MermaidBlock({ chart }: { chart: string }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const mermaid = await getMermaid()
        const id = `mermaid-${Date.now()}-${seq.current++}`
        const { svg: out } = await mermaid.render(id, chart)
        if (alive) setSvg(sanitizeSvg(out))
      } catch (e) {
        if (alive) setError(errorText(e, 'Mermaid 渲染失败'))
      }
    })()
    return () => {
      alive = false
    }
  }, [chart])

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
        <div className="mb-1 text-[11px] text-rose-300">Mermaid 语法错误</div>
        <pre className="overflow-x-auto font-mono text-[11px] text-mist-400">{chart}</pre>
      </div>
    )
  }
  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-ink-600 bg-ink-950/60 p-3 text-center [&_svg]:mx-auto [&_svg]:max-w-full">
      {svg === null ? (
        <div className="py-4 text-xs text-mist-500">Mermaid 渲染中…</div>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </div>
  )
})
