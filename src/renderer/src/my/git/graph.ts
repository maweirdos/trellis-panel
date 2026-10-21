/**
 * Adapted from oil-git src/graph.ts, commit 9e6abfabe63503b5122b1762a8902ecefe9473fc.
 * Copyright (c) 2026 Zhihuang Lin (oil-oil), MIT.
 * Source: https://github.com/oil-oil/oil-git
 * License: resources/licenses/oil-git.txt in this distribution.
 */
import type { GitHistoryCommit } from '@shared/git-readonly'

// Kept in sync with the history row's canonical --my-space-56 metric.
export const ROW_HEIGHT = 56
export const COLORS = [
  'var(--my-label-indigo-text)', 'var(--my-label-purple-text)',
  'var(--my-label-orange-text)', 'var(--my-label-emerald-text)',
  'var(--my-label-pink-text)', 'var(--my-label-yellow-text)'
]
export type GraphPoint = { x: number; y: number; lane: number; index: number }
export type GraphEdge = {
  from: GraphPoint
  to: GraphPoint
  fromHash: string
  toHash: string
  pending: boolean
  color: string
}
type EdgeIndex = { groups: GraphEdge[][]; maxEnd: Int32Array; base: number }
export type CommitGraph = {
  positions: Map<string, GraphPoint>
  edges: GraphEdge[]
  edgeIndex: EdgeIndex
  width: number
}

function indexEdges(edges: GraphEdge[], count: number): EdgeIndex {
  let base = 1
  while (base < count) base *= 2
  const groups: GraphEdge[][] = Array.from({ length: count }, () => [])
  const maxEnd = new Int32Array(base * 2).fill(-1)
  for (const edge of edges) {
    groups[edge.from.index]?.push(edge)
    const leaf = base + edge.from.index
    maxEnd[leaf] = Math.max(maxEnd[leaf], edge.to.index)
  }
  for (let i = base - 1; i > 0; i--) {
    maxEnd[i] = Math.max(maxEnd[i * 2], maxEnd[i * 2 + 1])
  }
  return { groups, maxEnd, base }
}

export function layoutGraph(commits: readonly Pick<GitHistoryCommit, 'hash' | 'parents'>[], head: string | null): CommitGraph {
  const lanes: (string | null)[] = head ? [head] : []
  const positions = new Map<string, GraphPoint>()
  let max = 0
  const reserve = (hash: string): number => {
    let lane = lanes.indexOf(hash)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) lane = lanes.length
      lanes[lane] = hash
    }
    return lane
  }
  for (const [index, commit] of commits.entries()) {
    const lane = reserve(commit.hash)
    max = Math.max(max, lane)
    positions.set(commit.hash, { x: 24 + lane * 24, y: index * ROW_HEIGHT + ROW_HEIGHT / 2, lane, index })
    lanes[lane] = null
    commit.parents.forEach((parent, i) => {
      if (lanes.includes(parent)) return
      if (i === 0 && lanes[lane] === null) lanes[lane] = parent
      else reserve(parent)
    })
  }
  const continuations = new Map<string, GraphPoint>()
  lanes.forEach((hash, lane) => {
    if (!hash) return
    continuations.set(hash, { x: 24 + lane * 24, y: commits.length * ROW_HEIGHT + 16, index: commits.length, lane })
    max = Math.max(max, lane)
  })
  const edges: GraphEdge[] = []
  for (const commit of commits) {
    const from = positions.get(commit.hash)
    if (!from) continue
    for (const hash of commit.parents) {
      edges.push({
        from,
        to: positions.get(hash) ?? continuations.get(hash) ?? { ...from, y: commits.length * ROW_HEIGHT + 16, index: commits.length },
        fromHash: commit.hash, toHash: hash, pending: !positions.has(hash),
        color: COLORS[from.lane % COLORS.length]
      })
    }
  }
  return { positions, edges, edgeIndex: indexEdges(edges, commits.length), width: Math.max(72, (max + 1) * 24 + 24) }
}

/** Half-open row range; retains long edges whose endpoints are both offscreen. */
export function visibleEdges(graph: CommitGraph, start: number, end: number): GraphEdge[] {
  if (end <= start) return []
  const { groups, maxEnd, base } = graph.edgeIndex
  const found: GraphEdge[] = []
  const visit = (node: number, lo: number, hi: number): void => {
    if (lo >= end || maxEnd[node] < start) return
    if (hi - lo === 1) {
      for (const edge of groups[lo] ?? []) {
        if (edge.to.index >= start) found.push(edge)
      }
      return
    }
    const mid = (lo + hi) / 2
    visit(node * 2, lo, mid)
    visit(node * 2 + 1, mid, hi)
  }
  visit(1, 0, base)
  return found
}

export function curve(from: Pick<GraphPoint, 'x' | 'y'>, to: Pick<GraphPoint, 'x' | 'y'>): string {
  const bend = Math.min((to.y - from.y) * 0.45, 38)
  return `M${from.x} ${from.y} C${from.x} ${from.y + bend},${to.x} ${to.y - bend},${to.x} ${to.y}`
}
