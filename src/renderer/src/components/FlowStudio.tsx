import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Sparkles,
  Loader2,
  Play,
  Square,
  Trash2,
  Save,
  Plus,
  Wand2,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Circle,
  Clock,
  Layers,
  Bot,
  Wrench,
  ShieldCheck,
  History,
  FileJson
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { relTime } from '../utils/format'
import { MarkdownView } from './MarkdownView'
import { confirmDialog } from './Dialogs'
import type { FlowDef, FlowRunEvent, FlowRunRecord, FlowStep, FlowSummary } from '../../../shared/types'
import type { JSX } from 'react'

/**
 * AI 工作流工作室（定制中心 → AI 工作流）：
 * 自然语言 → AI 生成工作流（阶段/子代理/工具/门禁）→ 保存 → 一键运行 → 实时进度 → 历史回看。
 * 全程无代码：生成的 DSL 有可视化预览，运行有阶段故事线。
 */

type Panel = 'design' | 'detail' | 'run'

export function FlowStudio(): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const aiEnabled = useApp((s) => s.settings?.ai.enabled ?? false)
  const snapshot = useApp((s) => s.snapshot)

  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [templates, setTemplates] = useState<FlowDef[]>([])
  const [selected, setSelected] = useState<FlowDef | null>(null)
  const [panel, setPanel] = useState<Panel>('design')
  const [history, setHistory] = useState<FlowRunRecord[]>([])

  /* 设计器状态 */
  const [idea, setIdea] = useState('')
  const [generating, setGenerating] = useState(false)
  const [draft, setDraft] = useState<FlowDef | null>(null)
  const [draftJson, setDraftJson] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)

  /* 运行状态 */
  const [runInputs, setRunInputs] = useState<Record<string, string>>({})
  const [runningEvents, setRunningEvents] = useState<FlowRunEvent[]>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'completed' | 'error' | 'aborted'>('idle')
  const [runError, setRunError] = useState<string | null>(null)
  const [viewedRun, setViewedRun] = useState<FlowRunRecord | null>(null)
  const eventsEndRef = useRef<HTMLDivElement>(null)

  const refreshFlows = useCallback(async (): Promise<void> => {
    const res = await api.flowList()
    if (res.ok && res.flows) setFlows(res.flows)
  }, [])

  const refreshHistory = useCallback(async (): Promise<void> => {
    const res = await api.flowRuns(15)
    if (res.ok && res.runs) setHistory(res.runs)
  }, [])

  useEffect(() => {
    void refreshFlows()
    void api.flowTemplates().then((r) => {
      if (r.ok && r.templates) setTemplates(r.templates)
    })
    void refreshHistory()
  }, [refreshFlows, refreshHistory, snapshot?.meta.root])

  /* 事件订阅 */
  useEffect(() => {
    const offOutput = api.onFlowOutput((e) => {
      setRunningEvents((cur) => (e.runId === activeRunIdRef.current ? [...cur, e] : cur))
    })
    const offDone = api.onFlowDone((e) => {
      if (e.runId !== activeRunIdRef.current) return
      setRunStatus(e.status === 'completed' ? 'completed' : e.status === 'aborted' ? 'aborted' : 'error')
      setRunError(e.error ?? null)
      setActiveRunId(null)
      void refreshHistory()
    })
    return () => {
      offOutput()
      offDone()
    }
  }, [refreshHistory])

  const activeRunIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeRunIdRef.current = activeRunId
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeRunId, runningEvents.length])

  /* AI 生成 */
  const generate = async (): Promise<void> => {
    const desc = idea.trim()
    if (!desc || generating) return
    setGenerating(true)
    setDraft(null)
    try {
      const res = await api.flowGenerate(desc)
      if (res.ok && res.def) {
        setDraft(res.def)
        setDraftJson(JSON.stringify(res.def, null, 2))
        pushToast({ kind: 'success', title: '工作流已生成', body: '检查预览后保存，即可运行' })
      } else {
        pushToast({ kind: 'error', title: '生成失败', body: res.error })
      }
    } finally {
      setGenerating(false)
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    let def = draft
    if (showJson) {
      try {
        def = JSON.parse(draftJson) as FlowDef
      } catch {
        pushToast({ kind: 'error', title: 'JSON 无效', body: '请检查语法后重试' })
        return
      }
    }
    setSavingDraft(true)
    try {
      const res = await api.flowSave(def)
      if (res.ok) {
        pushToast({ kind: 'success', title: '已保存', body: `${def.name}（.trellis/flows/${def.id}.flow.json）` })
        setDraft(null)
        void refreshFlows()
      } else {
        pushToast({ kind: 'error', title: '保存失败', body: res.error })
      }
    } finally {
      setSavingDraft(false)
    }
  }

  const installTemplate = async (def: FlowDef): Promise<void> => {
    const res = await api.flowInstallTemplate(def)
    if (res.ok) {
      pushToast({ kind: 'success', title: `模板「${def.name}」已安装` })
      void refreshFlows()
    } else {
      pushToast({ kind: 'error', title: '安装失败', body: res.error })
    }
  }

  const openFlow = async (id: string): Promise<void> => {
    const res = await api.flowRead(id)
    if (res.ok && res.def) {
      setSelected(res.def)
      setRunInputs({})
      setPanel('detail')
    } else {
      pushToast({ kind: 'error', title: '读取失败', body: res.error })
    }
  }

  const removeFlow = async (id: string, name: string): Promise<void> => {
    const ok = await confirmDialog({ title: `删除工作流「${name}」？`, message: '删除后不可恢复（.trellis/flows/ 下的文件）。', danger: true })
    if (!ok) return
    const res = await api.flowDelete(id)
    if (res.ok) {
      if (selected?.id === id) {
        setSelected(null)
        setPanel('design')
      }
      void refreshFlows()
    } else {
      pushToast({ kind: 'error', title: '删除失败', body: res.error })
    }
  }

  const run = async (): Promise<void> => {
    if (!selected || runStatus === 'running') return
    const missing = selected.inputs.filter((i) => i.required && !String(runInputs[i.name] ?? '').trim())
    if (missing.length > 0) {
      pushToast({ kind: 'error', title: '缺少必填输入', body: missing.map((m) => m.label).join('、') })
      return
    }
    const defaults: Record<string, string> = {}
    for (const i of selected.inputs) defaults[i.name] = String(runInputs[i.name] ?? i.default ?? '')
    const res = await api.flowRun(selected.id, defaults)
    if (res.ok && res.runId) {
      setActiveRunId(res.runId)
      activeRunIdRef.current = res.runId
      setRunningEvents([])
      setRunStatus('running')
      setRunError(null)
      setViewedRun(null)
      setPanel('run')
    } else {
      pushToast({ kind: 'error', title: '启动失败', body: res.error })
    }
  }

  const abort = async (): Promise<void> => {
    if (!activeRunId) return
    await api.flowAbort(activeRunId)
  }

  const openRun = (rec: FlowRunRecord): void => {
    if (runStatus === 'running') return
    setViewedRun(rec)
    setPanel('run')
  }

  const eventIcon = (kind: FlowRunEvent['kind']): JSX.Element => {
    if (kind === 'phase-start') return <Layers size={12} className="text-leaf-soft" />
    if (kind === 'phase-done') return <CheckCircle2 size={12} className="text-emerald-400" />
    if (kind === 'step-start') return <Circle size={11} className="text-sky-400" />
    if (kind === 'step-done') return <CheckCircle2 size={11} className="text-emerald-400" />
    if (kind === 'step-error') return <XCircle size={11} className="text-rose-400" />
    if (kind === 'gate-pass') return <ShieldCheck size={11} className="text-emerald-400" />
    if (kind === 'gate-fail') return <ShieldCheck size={11} className="text-amber-400" />
    return <Clock size={11} className="text-mist-500" />
  }

  const events = activeRunId || runStatus === 'running' ? runningEvents : viewedRun ? viewedRun.events : []

  return (
    <div className="flex h-full min-w-0">
      {/* 左列：工作流列表 + 模板 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-ink-750">
        <div className="flex items-center gap-1.5 border-b border-ink-750 px-3 py-2 text-xs font-semibold text-mist-200">
          <Wand2 size={13} /> 我的工作流
          <span className="flex-1" />
          <button onClick={() => { setPanel('design'); setSelected(null); }} className="btn-ghost p-1" title="新建：用一句话描述让 AI 设计">
            <Plus size={13} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {flows.length === 0 && (
            <p className="px-2 py-3 text-[11px] leading-5 text-mist-500">
              还没有工作流。右侧用一句话描述你的需求，AI 会设计一个；或从下方模板一键安装。
            </p>
          )}
          {flows.map((f) => (
            <div
              key={f.id}
              className={clsx(
                'group mb-0.5 flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors',
                selected?.id === f.id ? 'bg-leaf/10 text-mist-100' : 'text-mist-400 hover:bg-ink-800/60'
              )}
              onClick={() => void openFlow(f.id)}
            >
              <span className="min-w-0 flex-1 truncate" title={f.description}>{f.name}</span>
              <span className="shrink-0 font-mono text-[9px] text-mist-600">{f.phaseCount}段</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void removeFlow(f.id, f.name)
                }}
                className="shrink-0 rounded p-0.5 text-mist-600 opacity-0 hover:text-rose-300 group-hover:opacity-100"
                title="删除"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}

          <div className="mt-3 border-t border-ink-750 pt-2">
            <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-mist-500">模板库（一键安装）</div>
            {templates.map((t) => {
              const installed = flows.some((f) => f.id === t.id)
              return (
                <button
                  key={t.id}
                  disabled={installed}
                  onClick={() => void installTemplate(t)}
                  className="mb-0.5 flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-xs text-mist-400 transition-colors hover:bg-ink-800/60 disabled:opacity-40"
                  title={t.description}
                >
                  <Sparkles size={11} className="shrink-0 text-leaf-soft" />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="shrink-0 text-[9px] text-mist-600">{installed ? '已装' : '安装'}</span>
                </button>
              )
            })}
          </div>

          <div className="mt-3 border-t border-ink-750 pt-2">
            <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-mist-500">最近运行</div>
            {history.length === 0 && <p className="px-2 py-1 text-[10.5px] text-mist-600">暂无运行记录</p>}
            {history.slice(0, 8).map((r) => (
              <button
                key={r.runId}
                onClick={() => openRun(r)}
                className={clsx(
                  'mb-0.5 flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-[11px] transition-colors hover:bg-ink-800/60',
                  viewedRun?.runId === r.runId ? 'bg-ink-800/80 text-mist-100' : 'text-mist-400'
                )}
              >
                {r.status === 'completed' ? (
                  <CheckCircle2 size={10} className="shrink-0 text-emerald-400" />
                ) : r.status === 'running' ? (
                  <Loader2 size={10} className="shrink-0 animate-spin text-sky-400" />
                ) : (
                  <XCircle size={10} className="shrink-0 text-rose-400" />
                )}
                <span className="min-w-0 flex-1 truncate">{r.flowName}</span>
                <span className="shrink-0 text-[9px] text-mist-600">{relTime(r.startedAt)}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {panel === 'design' && (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <div className="mx-auto max-w-2xl space-y-4">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-mist-100">
                  <Wand2 size={15} className="text-leaf-soft" /> 用一句话让 AI 设计工作流
                </h2>
                <p className="mt-1 text-xs leading-5 text-mist-400">
                  描述你想自动完成的事，AI 会设计一个多步骤流程：安排不同的「AI 伙伴」分工（调研、写报告、检查质量），
                  自动调用项目知识库与任务数据，关键产出带质量门禁。保存后可反复运行。
                </p>
              </div>
              {!aiEnabled && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                  应用内 AI 未启用——请先到「设置 → AI 模型」接入模型。
                </div>
              )}
              <div className="rounded-xl border border-ink-750 bg-ink-850 p-4">
                <textarea
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  rows={4}
                  placeholder={'例如：\n· 帮我调研项目里所有和「支付」相关的规范和任务，整理成一份给新人看的简报\n· 每周五扫描任务看板，找出停滞的任务并给出处理建议'}
                  className="w-full resize-none rounded-lg border border-ink-600 bg-ink-900 p-3 text-xs leading-6 text-mist-100 outline-none placeholder:text-mist-600 focus:border-leaf/50"
                />
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => void generate()} disabled={generating || !idea.trim()} className="btn-primary text-xs">
                    {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    {generating ? 'AI 设计中…' : '生成工作流'}
                  </button>
                  <span className="text-[10.5px] text-mist-500">生成约需 10~30 秒，取决于模型速度</span>
                </div>
              </div>

              {draft && (
                <div className="rounded-xl border border-leaf-dim/40 bg-ink-850">
                  <div className="flex items-center gap-2 border-b border-ink-750 px-4 py-2.5">
                    <span className="text-xs font-semibold text-mist-100">{draft.name}</span>
                    <span className="flex-1 truncate text-[10.5px] text-mist-400">{draft.description}</span>
                    <button onClick={() => setShowJson((v) => !v)} className="btn-ghost px-1.5 text-[10px]" title="查看/编辑 DSL JSON">
                      <FileJson size={11} /> {showJson ? '可视化' : 'JSON'}
                    </button>
                    <button onClick={() => void saveDraft()} disabled={savingDraft} className="btn-primary text-[11px]">
                      {savingDraft ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} 保存
                    </button>
                  </div>
                  <div className="p-4">
                    {showJson ? (
                      <textarea
                        value={draftJson}
                        onChange={(e) => setDraftJson(e.target.value)}
                        spellCheck={false}
                        rows={16}
                        className="w-full resize-none rounded-lg border border-ink-700 bg-ink-900 p-3 font-mono text-[11px] leading-5 text-mist-200 outline-none focus:border-leaf/40"
                      />
                    ) : (
                      <FlowVisual def={draft} />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {panel === 'detail' && selected && (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <div className="mx-auto max-w-2xl space-y-4">
              <div className="flex items-center gap-2">
                <button onClick={() => { setSelected(null); setPanel('design') }} className="btn-ghost text-[11px]">← 返回</button>
                <h2 className="text-sm font-semibold text-mist-100">{selected.name}</h2>
                <span className="flex-1" />
                <button onClick={() => void run()} disabled={runStatus === 'running'} className="btn-primary text-xs">
                  <Play size={12} /> 运行
                </button>
              </div>
              <p className="text-xs text-mist-400">{selected.description}</p>

              {(selected.inputs?.length ?? 0) > 0 && (
                <div className="rounded-xl border border-ink-750 bg-ink-850 p-4 space-y-3">
                  <div className="text-xs font-semibold text-mist-200">运行前需要你提供：</div>
                  {selected.inputs.map((i) => (
                    <div key={i.name}>
                      <label className="mb-1 block text-[11px] text-mist-300">
                        {i.label} {i.required && <span className="text-rose-400">*</span>}
                        {i.description && <span className="ml-1 text-mist-500">—— {i.description}</span>}
                      </label>
                      <input
                        value={runInputs[i.name] ?? ''}
                        onChange={(e) => setRunInputs({ ...runInputs, [i.name]: e.target.value })}
                        placeholder={i.default || ''}
                        className="field w-full"
                      />
                    </div>
                  ))}
                </div>
              )}

              <FlowVisual def={selected} />
            </div>
          </div>
        )}

        {panel === 'run' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-ink-750 px-4 py-2">
              <span className="text-xs font-semibold text-mist-100">
                {runStatus === 'running' ? '正在运行' : viewedRun ? `运行回看 · ${viewedRun.flowName}` : '运行结束'}
              </span>
              {runStatus === 'running' && activeRunId && (
                <>
                  <Loader2 size={12} className="animate-spin text-sky-400" />
                  <button onClick={() => void abort()} className="btn ml-auto bg-rose-500/15 text-[11px] text-rose-300 hover:bg-rose-500/25">
                    <Square size={11} /> 中止
                  </button>
                </>
              )}
              {runStatus !== 'running' && (
                <button onClick={() => { setSelected(null); setPanel('design'); setViewedRun(null) }} className="btn-ghost ml-auto text-[11px]">关闭</button>
              )}
            </div>

            {runError && (
              <div className="mx-4 mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">{runError}</div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <div className="mx-auto max-w-2xl space-y-1">
                {events.length === 0 && <p className="py-8 text-center text-xs text-mist-500">等待事件…</p>}
                {events.map((e, i) => {
                  const isPhase = e.kind === 'phase-start' || e.kind === 'phase-done'
                  return (
                    <div
                      key={`${e.runId}-${i}`}
                      className={clsx(
                        'flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-xs',
                        isPhase ? 'mt-2 bg-leaf-dim/10 text-mist-100' : e.kind === 'step-error' ? 'bg-rose-500/5 text-rose-300' : 'text-mist-300'
                      )}
                    >
                      <span className="mt-0.5 shrink-0">{eventIcon(e.kind)}</span>
                      <div className="min-w-0 flex-1">
                        <span className={clsx(isPhase && 'font-semibold')}>{e.text ?? e.kind}</span>
                        {e.output && (
                          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[10.5px] leading-4 text-mist-500">{e.output}</p>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-[9px] text-mist-600">
                        {new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                      </span>
                    </div>
                  )
                })}
                {runStatus === 'running' && (
                  <div ref={eventsEndRef} className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-mist-500">
                    <Loader2 size={11} className="animate-spin" /> 工作流执行中…
                  </div>
                )}
                {/* 运行产物（回看模式） */}
                {viewedRun && viewedRun.status === 'completed' && Object.keys(viewedRun.vars).length > 0 && (
                  <div className="mt-4 space-y-3">
                    {Object.entries(viewedRun.vars).map(([k, v]) => (
                      <div key={k} className="rounded-xl border border-ink-750 bg-ink-850">
                        <div className="border-b border-ink-750 px-3 py-2 text-[11px] font-semibold text-mist-200">产物 · {k}</div>
                        <div className="max-h-72 overflow-y-auto px-3 py-2 text-xs">
                          <MarkdownView content={v} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- 工作流可视化（阶段卡片 + 步骤角色） ---------------- */

function stepIcon(step: FlowStep): JSX.Element {
  if (step.kind === 'agent') return <Bot size={12} className="text-sky-400" />
  if (step.kind === 'tool') return <Wrench size={12} className="text-amber-400" />
  return <ShieldCheck size={12} className="text-emerald-400" />
}

const KIND_LABEL: Record<FlowStep['kind'], string> = {
  agent: 'AI 伙伴',
  tool: '数据查询',
  gate: '质量门禁'
}

function FlowVisual({ def }: { def: FlowDef }): JSX.Element {
  return (
    <div className="space-y-3">
      {def.phases.map((p, pi) => (
        <div key={p.id} className="rounded-xl border border-ink-750 bg-ink-850/60">
          <div className="flex items-center gap-2 border-b border-ink-750 px-3.5 py-2">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-leaf-dim/20 text-[10px] font-semibold text-leaf-soft">{pi + 1}</span>
            <span className="text-xs font-semibold text-mist-100">{p.name}</span>
          </div>
          <div className="space-y-1.5 p-3">
            {p.steps.map((s) => (
              <div key={s.id} className="flex items-start gap-2 rounded-lg border border-ink-750/70 bg-ink-900 px-3 py-2">
                <span className="mt-0.5 shrink-0">{stepIcon(s)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-mist-100">{s.name}</span>
                    <span className="chip shrink-0 border border-ink-700 text-[9px] text-mist-500">{KIND_LABEL[s.kind]}</span>
                    {'tools' in s && s.tools?.length ? (
                      <span className="shrink-0 font-mono text-[9px] text-amber-500/80" title="可调用的查询工具">
                        {s.tools.join('/')}
                      </span>
                    ) : null}
                  </div>
                  {'instruction' in s && (
                    <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-mist-500">{s.instruction}</p>
                  )}
                  {'tool' in s && (
                    <p className="mt-0.5 font-mono text-[10px] text-mist-500">
                      {s.tool}({Object.entries(s.args).map(([k, v]) => `${k}=${v}`).join(', ')})
                    </p>
                  )}
                  {s.kind === 'gate' && (
                    <p className="mt-0.5 text-[10.5px] text-mist-500">
                      检查「{s.check.stepId}」：{s.check.contains ? `需包含「${s.check.contains}」` : ''}
                      {typeof s.check.minLength === 'number' ? `长度≥${s.check.minLength}` : ''}
                      {s.onFail === 'goto' ? '；未通过则反馈重试' : s.onFail === 'abort' ? '；未通过则中止' : '；未通过则继续'}
                    </p>
                  )}
                </div>
                {'saveOutputAs' in s && s.saveOutputAs && (
                  <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[9px] text-mist-400" title="产出保存为变量，供后续步骤引用">
                    → {s.saveOutputAs}
                  </span>
                )}
              </div>
            ))}
            {p.steps.length === 0 && <p className="px-1 py-2 text-[10.5px] text-mist-500">（该阶段暂无步骤）</p>}
          </div>
        </div>
      ))}
      {def.hooks?.onStart && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-ink-750 px-3 py-2 text-[10.5px] text-mist-500">
          <History size={11} /> 开始钩子：{def.hooks.onStart}
        </div>
      )}
      {def.hooks?.onComplete?.saveNote && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-ink-750 px-3 py-2 text-[10.5px] text-mist-500">
          <ChevronRight size={11} /> 完成后自动沉淀到「我的笔记」知识库
        </div>
      )}
    </div>
  )
}
