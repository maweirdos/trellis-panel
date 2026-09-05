import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, ChevronDown, FileText } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { fmtBytes } from '../utils/format'
import type { JSX } from 'react'
import type { SpecNode } from '../../../shared/types'

function TreeItem({
  node,
  depth,
  selected,
  onSelect
}: {
  node: SpecNode
  depth: number
  selected: string | null
  onSelect: (n: SpecNode) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(depth < 1)
  const isDir = node.type === 'dir'

  return (
    <div>
      <button
        onClick={() => {
          if (isDir) setExpanded((e) => !e)
          onSelect(node)
        }}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={clsx(
          'flex w-full items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-xs transition-colors',
          selected === node.path
            ? 'bg-leaf-dim/15 font-medium text-leaf-soft'
            : 'text-mist-300 hover:bg-ink-700/50 hover:text-mist-100'
        )}
      >
        {isDir ? (
          expanded ? (
            <ChevronDown size={12} className="shrink-0 text-mist-500" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-mist-500" />
          )
        ) : (
          <FileText size={12} className="shrink-0 text-mist-500" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && expanded && node.children?.map((c) => (
        <TreeItem key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  )
}

function flattenFiles(nodes: SpecNode[]): SpecNode[] {
  const out: SpecNode[] = []
  const walk = (list: SpecNode[]): void => {
    for (const n of list) {
      if (n.type === 'file') out.push(n)
      else if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

export function SpecPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const [selected, setSelected] = useState<SpecNode | null>(null)
  const [state, setState] = useState<{ loading: boolean; content?: string; error?: string }>({ loading: false })

  const files = useMemo(() => flattenFiles(snapshot.spec), [snapshot.spec])

  const load = (n: SpecNode): void => {
    setSelected(n)
    if (n.type !== 'file') return
    setState({ loading: true })
    api.readTextFile(n.path).then((res) => {
      if (res.ok) setState({ loading: false, content: res.content })
      else setState({ loading: false, error: res.error })
    })
  }

  // auto-select the first file on mount / project change
  useEffect(() => {
    if (files.length > 0) load(files[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.meta.root])

  return (
    <div className="flex h-full animate-fade-in">
      <div className="w-72 shrink-0 overflow-y-auto border-r border-ink-700 bg-ink-850/40 p-2">
        <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-mist-500">
          .trellis/spec
        </div>
        {snapshot.spec.length === 0 && (
          <div className="px-2 py-6 text-center text-[11px] text-mist-500">没有规范文档</div>
        )}
        {snapshot.spec.map((n) => (
          <TreeItem key={n.path} node={n} depth={0} selected={selected?.path ?? null} onSelect={load} />
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected?.type === 'file' ? (
          <>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-700 bg-ink-900/90 px-5 py-2.5 backdrop-blur">
              <FileText size={13} className="text-leaf" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mist-300">
                {selected.path.replace(snapshot.meta.root + '\\', '').replace(snapshot.meta.root + '/', '')}
              </span>
              {selected.size !== undefined && <span className="text-[10.5px] text-mist-500">{fmtBytes(selected.size)}</span>}
            </div>
            <div className="mx-auto max-w-3xl px-6 py-5">
              {state.loading && <div className="text-xs text-mist-500">加载中…</div>}
              {state.error && <div className="text-xs text-rose-300">{state.error}</div>}
              {!state.loading && !state.error && (
                /\.(md|markdown)$/i.test(selected.name) ? (
                  <MarkdownView content={state.content ?? ''} />
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-mist-300">
                    {state.content}
                  </pre>
                )
              )}
            </div>
          </>
        ) : (
          <div className="grid h-full place-items-center text-xs text-mist-500">选择左侧文件查看</div>
        )}
      </div>
    </div>
  )
}
