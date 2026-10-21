import React, { useEffect, useState } from 'react'
import type { JSX } from 'react'
import DOMPurify from 'dompurify'
import { errorText } from '../../../shared/errors'

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
let initialized = false

function isDark(): boolean {
  // 外壳主题事实是 .my-root 上的 data-my-theme（?my=1 预览下 html.dark 不可靠）
  const shellTheme = document.querySelector('.my-root')?.getAttribute('data-my-theme')
  if (shellTheme === 'light' || shellTheme === 'dark') return shellTheme === 'dark'
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
          fontFamily: getComputedStyle(document.querySelector('.my-root') ?? document.documentElement).getPropertyValue('--my-font-sans').trim()
        })
        initialized = true
      }
      return m.default
    })
  }
  return mermaidPromise
}

let globalSeq = 0
let renderQueue = Promise.resolve()

function nextMermaidId(): string {
  return `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${++globalSeq}`
}

async function renderMermaid(mermaid: typeof import('mermaid').default, chart: string): Promise<string> {
  const id = nextMermaidId()
  return new Promise((resolve, reject) => {
    renderQueue = renderQueue.then(async () => {
      try {
        const { svg } = await mermaid.render(id, chart)
        resolve(svg)
      } catch (err) {
        reject(err)
      } finally {
        // Mermaid can leave its error SVG in the body when rendering rejects.
        for (const temporaryId of [`d${id}`, `i${id}`]) {
          const node = document.getElementById(temporaryId)
          if (node?.parentElement === document.body) node.remove()
        }
      }
    })
  })
}

/** mermaid 渲染出的 SVG 注入 innerHTML 前必须消毒：图表源码可能来自外部文档/AI 输出 */
function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignobject', 'foreignObject'],
    ADD_ATTR: ['style', 'dominant-baseline'],
    HTML_INTEGRATION_POINTS: {
      foreignobject: true
    },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['srcset']
  })
}

export const MermaidBlock = React.memo(function MermaidBlock({ chart }: { chart: string }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const mermaid = await getMermaid()
        const out = await renderMermaid(mermaid, chart)
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
      <div className="my-3 rounded-my-md border border-my-line-danger bg-my-danger-subtle p-3">
        <div className="mb-1 text-my-xs text-my-danger-text">Mermaid 语法错误</div>
        <pre className="overflow-x-auto font-mono text-my-xs text-my-secondary">{chart}</pre>
      </div>
    )
  }
  return (
    <div className="my-3 overflow-x-auto rounded-my-md border border-my-line bg-my-canvas p-3 text-center [&_svg]:mx-auto [&_svg]:max-w-full">
      {svg === null ? (
        <div className="py-4 text-my-xs text-my-tertiary">Mermaid 渲染中…</div>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </div>
  )
})
