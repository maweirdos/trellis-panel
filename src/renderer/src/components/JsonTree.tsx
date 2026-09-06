import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { JSX } from 'react'

/**
 * 可折叠 JSON 树视图 —— 产物查看器的"图形化优先"模式。
 * expandToken 变化时全量展开（正数）/折叠（0）。
 */

interface JsonNodeProps {
  name: string | null
  value: unknown
  depth: number
  expandToken: number
  comma: boolean
}

const isPlain = (v: unknown): boolean =>
  v === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof v)

function Primitive({ value }: { value: unknown }): JSX.Element {
  if (value === null) return <span className="text-mist-500 italic">null</span>
  if (typeof value === 'string')
    return <span className="break-all text-emerald-300">"{value}"</span>
  if (typeof value === 'number') return <span className="text-sky-300">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="text-orange-300">{String(value)}</span>
  return <span className="text-mist-400">{String(value)}</span>
}

function JsonNode({ name, value, depth, expandToken, comma }: JsonNodeProps): JSX.Element {
  const defaultOpen = depth < 1
  const [open, setOpen] = useState(defaultOpen)

  useEffect(() => {
    if (expandToken > 0) setOpen(true)
    else if (expandToken < 0) setOpen(false)
  }, [expandToken])

  const entries = useMemo<Array<[string, unknown]>>(() => {
    if (Array.isArray(value)) return value.map((v, i) => [String(i), v])
    if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>)
    return []
  }, [value])

  if (isPlain(value)) {
    return (
      <div className="flex items-start gap-1.5 py-px leading-5">
        {name !== null && <span className="shrink-0 text-violet-300">"{name}"</span>}
        {name !== null && <span className="shrink-0 text-mist-600">:</span>}
        <Primitive value={value} />
        {comma && <span className="text-mist-600">,</span>}
      </div>
    )
  }

  const isArray = Array.isArray(value)
  const openBrace = isArray ? '[' : '{'
  const closeBrace = isArray ? ']' : '}'

  return (
    <div className="leading-5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="group flex items-start gap-1.5 rounded px-0.5 py-px text-left hover:bg-ink-750/60"
      >
        <span className="mt-0.5 shrink-0 text-mist-500">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        {name !== null && (
          <>
            <span className="shrink-0 text-violet-300">"{name}"</span>
            <span className="shrink-0 text-mist-600">:</span>
          </>
        )}
        <span className="text-mist-400">{openBrace}</span>
        {!open && (
          <span className="flex items-center gap-1 text-mist-500">
            <span className="rounded bg-ink-700 px-1 text-[10px]">{entries.length} 项</span>
            <span>{closeBrace}</span>
            {comma && <span>,</span>}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-4 border-l border-ink-700/60 pl-2">
          {entries.map(([k, v], i) => (
            <JsonNode
              key={k}
              name={isArray ? null : k}
              value={v}
              depth={depth + 1}
              expandToken={expandToken}
              comma={i < entries.length - 1}
            />
          ))}
          <div className="py-px text-mist-400">{closeBrace}{comma && ','}</div>
        </div>
      )}
    </div>
  )
}

export function JsonTree({ data }: { data: unknown }): JSX.Element {
  const [expandToken, setExpandToken] = useState(0)
  return (
    <div className="font-mono text-[12px]">
      <div className="mb-2 flex gap-1.5">
        <button onClick={() => setExpandToken(1)} className="chip border border-ink-500 text-[10.5px] hover:border-leaf-dim/50">
          展开全部
        </button>
        <button onClick={() => setExpandToken(-1)} className="chip border border-ink-500 text-[10.5px] hover:border-leaf-dim/50">
          折叠全部
        </button>
      </div>
      <div className="rounded-lg border border-ink-700 bg-ink-950 p-3">
        <JsonNode name={null} value={data} depth={0} expandToken={expandToken} comma={false} />
      </div>
    </div>
  )
}
