import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import type { GitHistoryCommit, GitHistoryRef } from '@shared/git-readonly'
import { COLORS, ROW_HEIGHT, curve, layoutGraph, visibleEdges } from './graph'

export function HistoryGraph({ commits, refs, head, selected, onSelect }: {
  commits: GitHistoryCommit[]
  refs: GitHistoryRef[]
  head: string | null
  selected: string | null
  onSelect: (hash: string) => void
}): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 12 })
  const graph = useMemo(() => layoutGraph(commits, head), [commits, head])
  const byHash = useMemo(() => {
    const grouped = new Map<string, GitHistoryRef[]>()
    for (const ref of refs) grouped.set(ref.hash, [...(grouped.get(ref.hash) ?? []), ref])
    return grouped
  }, [refs])
  const updateRange = useCallback((): void => {
    const element = viewport.current
    if (!element) return
    const start = Math.max(0, Math.floor(element.scrollTop / ROW_HEIGHT) - 1)
    const end = Math.ceil((element.scrollTop + element.clientHeight) / ROW_HEIGHT) + 1
    setRange((previous) => previous.start === start && previous.end === end ? previous : { start, end })
  }, [])
  useEffect(() => {
    updateRange()
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(updateRange)
    observer.observe(element)
    return () => observer.disconnect()
  }, [updateRange])
  const edges = useMemo(() => visibleEdges(graph, range.start, range.end), [graph, range])
  const graphHeight = commits.length * ROW_HEIGHT + 32
  const top = Math.min(range.start * ROW_HEIGHT, graphHeight)
  const height = Math.min(graphHeight - top, (range.end - range.start) * ROW_HEIGHT)

  return (
    <div ref={viewport} className="my-git-history-scroll my-scrollbar" onScroll={updateRange} role="region" aria-label="提交历史，按提交选择查看详情" tabIndex={0}>
      <div className="my-git-history-content" style={{ gridTemplateColumns: `${graph.width}px minmax(var(--my-space-240), 1fr)` }}>
        <div className="my-git-history-lanes" style={{ height: graphHeight }} aria-hidden="true">
          <svg width={graph.width} height={height} viewBox={`0 ${top} ${graph.width} ${height}`} style={{ top }}>
            {edges.map((edge) => <path key={`${edge.fromHash}:${edge.toHash}`} d={curve(edge.from, edge.to)} fill="none" stroke={edge.color} strokeWidth={1.7} strokeDasharray={edge.pending ? '4 3' : undefined} />)}
            {commits.slice(range.start, range.end).map((commit) => {
              const point = graph.positions.get(commit.hash)
              if (!point) return null
              return <circle key={commit.hash} cx={point.x} cy={point.y} r={selected === commit.hash ? 5 : 4}
                fill={COLORS[point.lane % COLORS.length]} stroke="var(--my-bg-canvas)" strokeWidth={selected === commit.hash ? 1.5 : 1} />
            })}
          </svg>
        </div>
        <ol className="my-git-commit-list">
          {commits.map((commit) => <li key={commit.hash}>
            <button type="button" className={clsx('my-git-commit', selected === commit.hash && 'my-git-selected')}
              aria-pressed={selected === commit.hash} onClick={() => onSelect(commit.hash)}
              aria-label={`${commit.subject}，${commit.hash}，${commit.parents.length ? `父提交 ${commit.parents.join('、')}` : '根提交'}`}>
              <span className="my-git-commit-subject">
                <span className="truncate text-my-sm text-my-primary" title={commit.subject}>{commit.subject || '（无提交说明）'}</span>
                {head === commit.hash && <span className="my-git-ref">HEAD</span>}
                {(byHash.get(commit.hash) ?? []).map((ref) => <span key={ref.fullName} className="my-git-ref" title={ref.fullName}>{ref.kind === 'tag' ? '标签 ' : ref.kind === 'remote' ? '远端 ' : ''}{ref.name}</span>)}
              </span>
              <span className="my-git-commit-meta text-my-xs text-my-tertiary">
                <span className="font-mono">{commit.hash.slice(0, 8)}</span>
                <span className="truncate" title={commit.author}>{commit.author}</span>
                <time dateTime={new Date(commit.timestamp).toISOString()}>{new Date(commit.timestamp).toLocaleString()}</time>
              </span>
            </button>
          </li>)}
        </ol>
      </div>
    </div>
  )
}
