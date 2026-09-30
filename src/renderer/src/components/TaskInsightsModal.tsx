import { useEffect, useMemo, useState } from 'react'
import { Loader2, ScanSearch, X } from 'lucide-react'
import type { ContextExpectEntry, TaskInfo } from '../../../shared/types'
import { api } from '../api'
import { useApp } from '../store'
import { MarkdownView } from './MarkdownView'
import { clsx } from 'clsx'

/**
 * 任务透视 v2（架构图形态，2026-09-30 按用户反馈重做）：
 * workflow.md 架构投影为 SVG 阶段管线（复用架构图页的 arch-* 视觉语言），
 * 任务状态点亮所处阶段；点击节点 = 该阶段原文 + 这一阶段注入了什么。
 * 纪律不变：只报事实与预期，不推断执行位置；规则预览纯静态零执行。
 */

interface WfSection {
  title: string
  body: string
}

interface PhaseDef {
  id: string
  title: string
  sub: string
  match: string[]
  /** 映射的 workflow-state 块（面包屑预览用） */
  block: string | null
  /** 任务状态 → 该阶段是否点亮 */
  statuses: string[]
  /** 该阶段涉及的产物 */
  arts: string[]
  /** 该阶段注入了什么（人话） */
  inject: string[]
}

const PHASES: PhaseDef[] = [
  {
    id: 'triage',
    title: '请求分诊',
    sub: 'no_task · 分类请求',
    match: ['Request Triage'],
    block: 'no_task',
    statuses: ['no_task'],
    arts: [],
    inject: ['启动注入：AGENTS.md / 会话启动钩子（身份、git 状态、活跃任务）', '每轮面包屑：workflow-state「no_task」块']
  },
  {
    id: 'artifacts',
    title: '规划素材',
    sub: 'prd 素材与调研',
    match: ['Planning Artifacts'],
    block: 'planning',
    statuses: ['planning'],
    arts: ['prd.md'],
    inject: ['每轮面包屑：workflow-state「planning」块', '技能：trellis-brainstorm 按意图自动触发']
  },
  {
    id: 'p1',
    title: 'Phase 1 · 规划',
    sub: '产出 prd.md',
    match: ['Phase 1'],
    block: 'planning',
    statuses: ['planning'],
    arts: ['prd.md'],
    inject: ['每轮面包屑：workflow-state「planning」块', '产出：prd.md（task.py create 官方流程）']
  },
  {
    id: 'p2',
    title: 'Phase 2 · 执行',
    sub: 'implement.jsonl 注入',
    match: ['Phase 2'],
    block: 'in_progress',
    statuses: ['in_progress'],
    arts: ['design.md', 'implement.md', 'implement.jsonl'],
    inject: ['每轮面包屑：workflow-state「in_progress」块', 'implement.jsonl → 注入实现子代理（单文件超 32KB 截断留路径）', '技能：trellis-before-dev 按意图自动触发']
  },
  {
    id: 'p3',
    title: 'Phase 3 · 收尾',
    sub: 'check.jsonl · 归档',
    match: ['Phase 3'],
    block: 'in_progress',
    statuses: ['in_progress'],
    arts: ['check.jsonl'],
    inject: ['每轮面包屑：workflow-state「in_progress」块', 'check.jsonl → 注入检查子代理', '收尾：task.py archive 官方流程（面板不代归档）']
  }
]

/** 按 `### 标题` 切小节（精确匹配标题包含 match 关键词的小节） */
function extractSections(raw: string): WfSection[] {
  const out: WfSection[] = []
  let cur: WfSection | null = null
  for (const line of raw.split('\n')) {
    const h = /^###\s+(.+)$/.exec(line.trim())
    if (h) {
      if (cur) out.push(cur)
      cur = { title: h[1].trim(), body: '' }
      continue
    }
    if (cur) cur.body += line + '\n'
  }
  if (cur) out.push(cur)
  return out
}

interface ExpectData {
  ok: true
  implement: { present: boolean; totalBytes: number; entries: ContextExpectEntry[] }
  check: { present: boolean; totalBytes: number; entries: ContextExpectEntry[] }
  caps: { perFile: number; total: number }
}

const VERDICT: Record<string, { label: string; cls: string }> = {
  full: { label: '完整内联', cls: 'bg-leaf/10 text-leaf-soft' },
  truncate: { label: '预期截断', cls: 'bg-amber-500/10 text-amber-300' },
  index: { label: '降级为索引行', cls: 'bg-amber-500/10 text-amber-300' },
  missing: { label: '文件缺失', cls: 'bg-rose-500/10 text-rose-300' }
}

function kb(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`
}

function JsonlTable({ title, data, caps }: { title: string; data: { present: boolean; totalBytes: number; entries: ContextExpectEntry[] }; caps: { perFile: number; total: number } }): JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-mist-300">
        {title}
        {data.present ? (
          <span className="font-mono text-[10px] text-mist-500">
            {kb(data.totalBytes)} / {kb(caps.total)}（{(data.totalBytes / caps.total * 100).toFixed(0)}%）
          </span>
        ) : (
          <span className="chip bg-ink-750 text-mist-500">未找到</span>
        )}
      </div>
      {data.present && data.entries.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-ink-700">
          <table className="w-full text-left text-[11px]">
            <tbody>
              {data.entries.map((e, i) => (
                <tr key={i} className={i % 2 ? 'bg-ink-850/40' : ''}>
                  <td className="max-w-[280px] truncate px-2.5 py-1.5 font-mono text-[10.5px] text-mist-300" title={`${e.file}${e.reason ? ` — ${e.reason}` : ''}`}>
                    {e.file}
                  </td>
                  <td className="w-20 px-2 py-1.5 font-mono text-[10px] text-mist-500">{e.exists ? kb(e.size) : '—'}</td>
                  <td className="w-28 px-2.5 py-1.5">
                    <span className={`chip ${VERDICT[e.verdict]?.cls ?? ''}`}>{VERDICT[e.verdict]?.label ?? e.verdict}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function FactChip({ label, ok, warn }: { label: string; ok: boolean; warn?: boolean }): JSX.Element {
  return (
    <span
      className={`chip ${warn ? 'bg-rose-500/10 text-rose-300' : ok ? 'bg-leaf/10 text-leaf-soft' : 'bg-ink-750 text-mist-500'}`}
      title={warn ? '无法读取' : ok ? '已找到' : '未找到（轻量任务可合法缺失）'}
    >
      {label} {warn ? '无法读取' : ok ? '已找到' : '未找到'}
    </span>
  )
}

const NODE_W = 172
const NODE_H = 62
const NODE_GAP = 22

export function TaskInsightsModal({ task, onClose }: { task: TaskInfo; onClose: () => void }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const root = useApp((s) => s.snapshot?.meta.root ?? '')
  const hasWorkflow = useApp((s) => s.snapshot?.meta.hasWorkflow ?? false)

  const [wfRaw, setWfRaw] = useState<string | null>(null)
  const [wfLoading, setWfLoading] = useState(true)
  const [selected, setSelected] = useState<string>('p1')
  const [detailTab, setDetailTab] = useState<'doc' | 'inject'>('inject')
  const [expect, setExpect] = useState<ExpectData | { ok: false; error: string } | null>(null)

  useEffect(() => {
    let alive = true
    if (!hasWorkflow) {
      setWfLoading(false)
      return
    }
    void api.readTextFile(`${root}/.trellis/workflow.md`).then((res) => {
      if (!alive) return
      setWfLoading(false)
      setWfRaw(res.ok && res.content !== undefined ? res.content : null)
    })
    void api.taskContextExpect(task.dirName).then((res) => {
      if (alive) setExpect(res)
    })
    return () => {
      alive = false
    }
  }, [task.dirName, root, hasWorkflow])

  const sections = useMemo(() => (wfRaw ? extractSections(wfRaw) : []), [wfRaw])
  const blocks = useMemo(() => {
    if (!wfRaw) return new Map<string, string>()
    const map = new Map<string, string>()
    let cur: { status: string; lines: string[] } | null = null
    for (const line of wfRaw.split('\n')) {
      const t = line.trim()
      const open = /^\[workflow-state:([\w-]+)\]$/.exec(t)
      const close = /^\[\/workflow-state:([\w-]+)\]$/.exec(t)
      if (open && !cur) {
        cur = { status: open[1], lines: [] }
        continue
      }
      if (close && cur && cur.status === close[1]) {
        map.set(cur.status, cur.lines.join('\n').trim())
        cur = null
        continue
      }
      if (cur) cur.lines.push(line)
    }
    return map
  }, [wfRaw])

  const status = (task.record?.status ?? '').toLowerCase()
  const statusLabel = task.record?.status ?? '未知'
  const activeIds = new Set(PHASES.filter((p) => p.statuses.includes(status)).map((p) => p.id))
  const phase = PHASES.find((p) => p.id === selected) ?? PHASES[2]
  const section = sections.find((s) => phase.match.some((m) => s.title.includes(m)))
  const blockText = phase.block ? blocks.get(phase.block) : undefined

  const hasArt = (name: string): boolean => task.artifacts.some((a) => a.name === name || a.name.startsWith(`${name}/`))

  // SVG 布局
  const W = PHASES.length * (NODE_W + NODE_GAP) - NODE_GAP + 30
  const H = NODE_H + 86

  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center bg-ink-950/60 p-6 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <ScanSearch size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">任务透视</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-500">
            {task.record?.title ?? task.dirName} · 工作流架构 × 本任务事实 · 只报事实不推断
          </span>
          <button onClick={onClose} className="btn-ghost justify-center px-1.5">
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* ① 工作流架构图（复用架构图页的视觉语言） */}
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-mist-300">
            工作流管线
            <span className="font-normal text-[10px] text-mist-600">
              绿点 = 当前记录阶段（{statusLabel}）所在 · 点击节点看该阶段原文与注入
            </span>
          </div>
          {wfLoading ? (
            <div className="flex h-40 items-center justify-center text-mist-500">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : !hasWorkflow || !wfRaw ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-300/90">
              未找到 .trellis/workflow.md——工作流管线不可用（该项目未初始化或被深度定制）。
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-ink-700 bg-ink-950/60 p-2">
              <svg viewBox={`0 0 ${W} ${H}`} className="arch-svg w-full" style={{ minWidth: W }}>
                <defs>
                  <marker id="ins-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 1 2 L 7 5 L 1 8 Z" className="arch-marker-dashed" />
                  </marker>
                </defs>
                {/* 连线 */}
                {PHASES.slice(0, -1).map((p, i) => {
                  const x1 = 15 + i * (NODE_W + NODE_GAP) + NODE_W
                  const x2 = 15 + (i + 1) * (NODE_W + NODE_GAP)
                  const y = 42 + NODE_H / 2
                  const on = activeIds.has(p.id) && activeIds.has(PHASES[i + 1].id)
                  return (
                    <path
                      key={p.id}
                      d={`M ${x1} ${y} L ${x2 - 4} ${y}`}
                      fill="none"
                      className={clsx('arch-edge-path', on && 'arch-edge-active')}
                      markerEnd="url(#ins-arrow)"
                    />
                  )
                })}
                {/* 节点 */}
                {PHASES.map((p, i) => {
                  const x = 15 + i * (NODE_W + NODE_GAP)
                  const active = activeIds.has(p.id)
                  const artsState = p.arts.length === 0 ? 'na' : p.arts.every(hasArt) ? 'all' : p.arts.some(hasArt) ? 'some' : 'none'
                  return (
                    <g
                      key={p.id}
                      transform={`translate(${x},42)`}
                      onClick={() => {
                        setSelected(p.id)
                        setDetailTab('inject')
                      }}
                      className={clsx('arch-node cursor-pointer', active && 'arch-node-live')}
                    >
                      <rect width={NODE_W} height={NODE_H} rx={10} className="arch-node-state" />
                      <text x={12} y={24} className="arch-node-title">
                        {p.title}
                        {active && ' ●'}
                      </text>
                      <text x={12} y={44} className="arch-node-sub">
                        {p.sub}
                      </text>
                      {p.arts.length > 0 && (
                        <circle
                          cx={NODE_W - 14}
                          cy={14}
                          r={5}
                          className={artsState === 'all' ? 'fill-emerald-500' : artsState === 'some' ? 'fill-amber-400' : 'fill-ink-600'}
                        />
                      )}
                      {/* 产物名提示 */}
                      {p.arts.length > 0 && (
                        <text x={NODE_W - 24} y={18} textAnchor="end" className="arch-edge-label">
                          {artsState === 'all' ? '材料齐' : artsState === 'some' ? '部分材料' : '材料缺'}
                        </text>
                      )}
                    </g>
                  )
                })}
                <text x={15} y={H - 8} className="arch-lane">
                  阶段顺序为 workflow.md 的静态投影；任务实际阶段以 task.json 为准（不推断执行位置）
                </text>
              </svg>
            </div>
          )}

          {/* ② 选中阶段详情 */}
          {!wfLoading && wfRaw && (
            <div className="mt-3 rounded-xl border border-ink-700 bg-ink-850/40">
              <div className="flex items-center gap-2 border-b border-ink-700/60 px-3 py-2">
                <span className="text-[11px] font-semibold text-mist-200">
                  {phase.title}
                </span>
                <div className="ml-auto flex gap-1">
                  {(
                    [
                      ['inject', '这一阶段注入了什么'],
                      ['doc', 'workflow.md 原文']
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setDetailTab(id)}
                      className={clsx(
                        'rounded px-2 py-0.5 text-[10.5px] transition-colors',
                        detailTab === id ? 'bg-leaf-dim/20 font-semibold text-leaf-soft' : 'text-mist-500 hover:text-mist-200'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto p-3">
                {detailTab === 'inject' ? (
                  <div className="space-y-2">
                    <ul className="space-y-1">
                      {phase.inject.map((t) => (
                        <li key={t} className="flex items-start gap-1.5 text-[11px] leading-5 text-mist-300">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-leaf" />
                          {t}
                        </li>
                      ))}
                    </ul>
                    {/* 本任务产物事实 */}
                    {phase.arts.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 border-t border-ink-700/60 pt-2">
                        {phase.arts.map((a) => (
                          <FactChip key={a} label={a} ok={hasArt(a)} />
                        ))}
                      </div>
                    )}
                    {/* jsonl 预期表 */}
                    {expect?.ok && phase.id === 'p2' && (
                      <JsonlTable title="implement.jsonl（喂给实现子代理）" data={expect.implement} caps={expect.caps} />
                    )}
                    {expect?.ok && phase.id === 'p3' && (
                      <JsonlTable title="check.jsonl（喂给检查子代理）" data={expect.check} caps={expect.caps} />
                    )}
                    {/* 面包屑原文 */}
                    {phase.block && blockText && (
                      <details className="rounded-lg border border-ink-700 bg-ink-950">
                        <summary className="cursor-pointer px-2.5 py-1.5 text-[10.5px] text-mist-400">
                          每轮提示词原文（workflow-state「{phase.block}」块）
                        </summary>
                        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap px-2.5 pb-2 font-mono text-[10.5px] leading-4 text-mist-300">
                          {blockText}
                        </pre>
                      </details>
                    )}
                    <div className="text-[10px] text-mist-600">
                      注入预期 ≠ 模型实际读取或遵守；channel worker 走另一套上限，此处仅覆盖 hook 注入链。
                    </div>
                  </div>
                ) : section ? (
                  <div className="prose-sm max-h-56 overflow-y-auto rounded-lg border border-ink-700 bg-ink-950 p-3">
                    <div className="mb-1 font-mono text-[10px] text-mist-500">### {section.title}</div>
                    <MarkdownView content={section.body} />
                  </div>
                ) : (
                  <div className="text-[11px] text-amber-300/90">
                    workflow.md 中未找到「{phase.match.join('/')}」小节——该阶段说明不可用（工作流可能被定制）。
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ③ 文件事实（紧凑条） */}
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-mist-300">
              文件事实
              {task.archived && <span className="chip bg-ink-750 text-mist-400">位于归档目录</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {task.parseError && <FactChip label="task.json" ok={false} warn />}
              {['prd.md', 'design.md', 'implement.md', 'implement.jsonl', 'check.jsonl', 'research/'].map((name) => (
                <FactChip key={name} label={name} ok={task.artifacts.some((a) => a.name === name || a.name.startsWith(`${name.slice(0, -1)}`))} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
