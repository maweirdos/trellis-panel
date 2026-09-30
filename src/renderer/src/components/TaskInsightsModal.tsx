import { useEffect, useMemo, useState } from 'react'
import { Loader2, ScanSearch, X } from 'lucide-react'
import type { ContextExpectEntry, TaskInfo } from '../../../shared/types'
import { api } from '../api'
import { useApp } from '../store'

/**
 * T2：任务透视（06 v2 §3 v2 降级版）——只报事实与预期，不做执行位置推断。
 * ① 文件事实：存在性徽标；② 流程参考：workflow.md 标签块静态投影（规则预览，
 * 选块看原文，零脚本执行；解析失败降级为原文）；③ 上下文预期：jsonl 引用
 * 清单按默认上限估算预期注入行为（≠模型实际读取或遵守）。
 */

interface WorkflowBlock {
  status: string
  lines: string[]
}

interface WorkflowView {
  /** 每轮注入的面包屑块（规则预览的展示对象） */
  blocks: WorkflowBlock[]
  /** 正文 Phase Index 下的阶段小节（流程参考） */
  phases: string[]
}

/**
 * 行级解析：块定界行必须整行恰为 [workflow-state:X] / [/workflow-state:X]
 * （与 Studio 校验器同一口径；避免误吃文档开头状态映射表里的引用）。
 */
function parseWorkflowView(raw: string): WorkflowView {
  const blocks: WorkflowBlock[] = []
  let cur: WorkflowBlock | null = null
  let inPhaseIndex = false
  const phases: string[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    const open = /^\[workflow-state:([\w-]+)\]$/.exec(t)
    const close = /^\[\/workflow-state:([\w-]+)\]$/.exec(t)
    if (open && !cur) {
      cur = { status: open[1], lines: [] }
      continue
    }
    if (close && cur && cur.status === close[1]) {
      blocks.push(cur)
      cur = null
      continue
    }
    if (cur) {
      cur.lines.push(line)
      continue
    }
    if (/^##\s+Phase Index\s*$/.test(t)) {
      inPhaseIndex = true
      continue
    }
    if (/^##\s+/.test(t)) {
      inPhaseIndex = false
      continue
    }
    if (inPhaseIndex) {
      const h = /^###\s+(.+)$/.exec(t)?.[1]?.trim()
      if (h) phases.push(h)
    }
  }
  return { blocks, phases }
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

export function TaskInsightsModal({ task, onClose }: { task: TaskInfo; onClose: () => void }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const root = useApp((s) => s.snapshot?.meta.root ?? '')
  const hasWorkflow = useApp((s) => s.snapshot?.meta.hasWorkflow ?? false)

  const [wfRaw, setWfRaw] = useState<string | null>(null)
  const [wfLoading, setWfLoading] = useState(true)
  const [activeState, setActiveState] = useState<string | null>(null)
  const [expect, setExpect] = useState<
    | { ok: true; implement: { present: boolean; totalBytes: number; entries: ContextExpectEntry[] }; check: { present: boolean; totalBytes: number; entries: ContextExpectEntry[] }; caps: { perFile: number; total: number } }
    | { ok: false; error: string }
    | null
  >(null)

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

  const view = useMemo(() => (wfRaw ? parseWorkflowView(wfRaw) : { blocks: [], phases: [] }), [wfRaw])
  const blocks = view.blocks
  const active = blocks.find((b) => b.status === activeState) ?? null

  const facts: Array<{ label: string; ok: boolean }> = [
    { label: 'prd.md', ok: task.artifacts.some((a) => a.name === 'prd.md') },
    { label: 'design.md', ok: task.artifacts.some((a) => a.name === 'design.md') },
    { label: 'implement.md', ok: task.artifacts.some((a) => a.name === 'implement.md') },
    { label: 'implement.jsonl', ok: task.artifacts.some((a) => a.name === 'implement.jsonl') },
    { label: 'check.jsonl', ok: task.artifacts.some((a) => a.name === 'check.jsonl') },
    { label: 'research/', ok: task.artifacts.some((a) => a.name === 'research') }
  ]

  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center bg-ink-950/60 p-6 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <ScanSearch size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">任务透视</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-500">
            {task.record?.title ?? task.dirName} · 只报事实与预期，不推断执行位置
          </span>
          <button onClick={onClose} className="btn-ghost justify-center px-1.5">
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {/* ① 文件事实 */}
          <section>
            <div className="mb-1.5 text-[11px] font-semibold text-mist-300">文件事实</div>
            <div className="flex flex-wrap gap-1.5">
              {task.parseError && <FactChip label="task.json" ok={false} warn />}
              {facts.map((f) => (
                <FactChip key={f.label} label={f.label} ok={f.ok} />
              ))}
              {task.archived && <span className="chip bg-ink-750 text-mist-400">位于归档目录</span>}
            </div>
          </section>

          {/* ② 流程参考（规则预览） */}
          <section>
            <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-mist-300">
              流程参考
              <span className="font-normal text-[10px] text-mist-600">workflow.md 静态投影 · 点击状态看原文</span>
            </div>
            {wfLoading ? (
              <div className="flex h-16 items-center justify-center text-mist-500">
                <Loader2 size={14} className="animate-spin" />
              </div>
            ) : !hasWorkflow ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-300/90">
                未找到 .trellis/workflow.md——该项目工作流缺失或被深度定制，流程参考不可用。
              </div>
            ) : blocks.length === 0 && view.phases.length === 0 ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-300/90">
                workflow.md 中未解析到 [workflow-state] 标签块与 Phase Index（可能被深度定制）。流程参考不可用。
              </div>
            ) : (
              <>
                {view.phases.length > 0 && (
                  <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10.5px] text-mist-300">
                    <span className="text-mist-500">阶段：</span>
                    {view.phases.map((ph, i) => (
                      <span key={ph} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-mist-600">→</span>}
                        <span className="rounded bg-ink-750 px-1.5 py-0.5">{ph}</span>
                      </span>
                    ))}
                  </div>
                )}
                {blocks.length > 0 && (
                  <>
                    <div className="mb-1 text-[10px] text-mist-500">每轮提示词（按状态选块预览 = AI 在该状态每轮收到的规则文本）：</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {blocks.map((b) => (
                        <button
                          key={b.status}
                          onClick={() => setActiveState(activeState === b.status ? null : b.status)}
                          className={`rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors ${
                            activeState === b.status ? 'border-leaf-dim/60 bg-leaf-dim/15 text-leaf-soft' : 'border-ink-600 text-mist-300 hover:bg-ink-750'
                          }`}
                          title={`${b.lines.length} 行提示词`}
                        >
                          {b.status}
                        </button>
                      ))}
                    </div>
                    {active && (
                      <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[10.5px] leading-4 text-mist-300">
                        {active.lines.join('\n').trim()}
                      </pre>
                    )}
                  </>
                )}
                <div className="mt-1.5 text-[10px] text-mist-600">
                  静态参考：任务实际阶段以 task.json 为准（状态字段不区分执行/检查等细分步骤）；块内文本即面包屑注入原文。
                </div>
              </>
            )}
          </section>

          {/* ③ 上下文预期 */}
          <section>
            <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-mist-300">
              上下文预期
              <span className="font-normal text-[10px] text-mist-600">预期注入行为 ≠ 模型实际读取或遵守</span>
            </div>
            {!expect ? (
              <div className="flex h-12 items-center justify-center text-mist-500">
                <Loader2 size={14} className="animate-spin" />
              </div>
            ) : !expect.ok ? (
              <div className="text-[11px] text-rose-300">{expect.error}</div>
            ) : (
              <div className="space-y-3">
                <JsonlTable title="implement.jsonl（喂给实现子代理）" data={expect.implement} caps={expect.caps} />
                <JsonlTable title="check.jsonl（喂给检查子代理）" data={expect.check} caps={expect.caps} />
                <div className="text-[10px] leading-4 text-mist-600">
                  按默认上限估算（单文件 {kb(expect.caps.perFile)} 截断但保留路径供代理续读；累计 {kb(expect.caps.total)} 超出后其余条目降级为索引行）。
                  channel worker 走另一套上限，本表仅覆盖 hook 注入链。
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
