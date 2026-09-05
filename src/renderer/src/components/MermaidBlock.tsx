import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

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
          securityLevel: 'loose',
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

export function MermaidBlock({ chart }: { chart: string }): JSX.Element {
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
        if (alive) setSvg(out)
      } catch (e: any) {
        if (alive) setError(e?.message ?? 'Mermaid 渲染失败')
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
}
