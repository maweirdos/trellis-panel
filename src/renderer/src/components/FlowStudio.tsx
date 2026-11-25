import { PageContent } from '../my/layout/PageLayout'
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
import { Button } from '../my/ui'
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
    if (kind === 'phase-start') return <Layers size={12} className="text-my-accent-text" />
    if (kind === 'phase-done') return <CheckCircle2 size={12} className="text-my-success-text" />
    if (kind === 'step-start') return <Circle size={11} className="text-my-info-text" />
    if (kind === 'step-done') return <CheckCircle2 size={11} className="text-my-success-text" />
    if (kind === 'step-error') return <XCircle size={11} className="text-my-danger-text" />
    if (kind === 'gate-pass') return <ShieldCheck size={11} className="text-my-success-text" />
    if (kind === 'gate-fail') return <ShieldCheck size={11} className="text-my-warning-text" />
    return <Clock size={11} className="text-my-tertiary" />
  }

  const events = activeRunId || runStatus === 'running' ? runningEvents : viewedRun ? viewedRun.events : []

  return (
    <div className="flex h-full min-w-0">
      {/* 左列：工作流列表 + 模板 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-my-line">
        <div className="flex items-center gap-1.5 border-b border-my-line px-3 py-2 text-my-xs font-semibold text-my-primary">
          <Wand2 size={13} /> 我的工作流
          <span className="flex-1" />
          <Button variant="ghost" size="sm" className="px-1.5" onClick={() => { setPanel('design'); setSelected(null); }} title="新建：用一句话描述让 AI 设计">
            <Plus size={13} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {flows.length === 0 && (
            <p className="px-2 py-3 text-my-xs leading-5 text-my-tertiary">
              还没有工作流。右侧用一句话描述你的需求，AI 会设计一个；或从下方模板一键安装。
            </p>
          )}
          {flows.map((f) => (
            <div
              key={f.id}
              className={clsx(
                'group mb-0.5 flex cursor-pointer items-center gap-1 rounded-my-lg px-2 py-1.5 text-my-xs transition-colors',
                selected?.id === f.id ? 'bg-my-accent-subtle text-my-primary' : 'text-my-secondary hover:bg-my-layer-1-hover'
              )}
              onClick={() => void openFlow(f.id)}
            >
              <span className="min-w-0 flex-1 truncate" title={f.description}>{f.name}</span>
              <span className="shrink-0 font-mono text-my-2xs text-my-placeholder">{f.phaseCount}段</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void removeFlow(f.id, f.name)
                }}
                className="shrink-0 rounded-my-sm p-0.5 text-my-placeholder opacity-0 hover:text-my-danger-text group-hover:opacity-100"
                title="删除"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}

          <div className="mt-3 border-t border-my-line pt-2">
            <div className="px-2 pb-1.5 text-my-2xs font-semibold uppercase tracking-wide text-my-tertiary">模板库（一键安装）</div>
            {templates.map((t) => {
              const installed = flows.some((f) => f.id === t.id)
              return (
                <button
                  key={t.id}
                  disabled={installed}
                  onClick={() => void installTemplate(t)}
                  className="mb-0.5 flex w-full items-center gap-1 rounded-my-lg px-2 py-1.5 text-left text-my-xs text-my-secondary transition-colors hover:bg-my-layer-1-hover disabled:opacity-40"
                  title={t.description}
                >
                  <Sparkles size={11} className="shrink-0 text-my-accent-text" />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="shrink-0 text-my-2xs text-my-placeholder">{installed ? '已装' : '安装'}</span>
                </button>
              )
            })}
          </div>

          <div className="mt-3 border-t border-my-line pt-2">
            <div className="px-2 pb-1.5 text-my-2xs font-semibold uppercase tracking-wide text-my-tertiary">最近运行</div>
            {history.length === 0 && <p className="px-2 py-1 text-my-2xs text-my-placeholder">暂无运行记录</p>}
            {history.slice(0, 8).map((r) => (
              <button
                key={r.runId}
                onClick={() => openRun(r)}
                className={clsx(
                  'mb-0.5 flex w-full items-center gap-1 rounded-my-lg px-2 py-1 text-left text-my-xs transition-colors hover:bg-my-layer-1-hover',
                  viewedRun?.runId === r.runId ? 'bg-my-layer-1-selected text-my-primary' : 'text-my-secondary'
                )}
              >
                {r.status === 'completed' ? (
                  <CheckCircle2 size={10} className="shrink-0 text-my-success-text" />
                ) : r.status === 'running' ? (
                  <Loader2 size={10} className="shrink-0 animate-spin text-my-info-text" />
                ) : (
                  <XCircle size={10} className="shrink-0 text-my-danger-text" />
                )}
                <span className="min-w-0 flex-1 truncate">{r.flowName}</span>
                <span className="shrink-0 text-my-2xs text-my-placeholder">{relTime(r.startedAt)}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {panel === 'design' && (
          <div className="my-scrollbar min-h-0 flex-1">
            <PageContent variant="centered" className="space-y-4">
              <div>
                <h2 className="flex items-center gap-2 text-my-sm font-semibold text-my-primary">
                  <Wand2 size={15} className="text-my-accent-text" /> 用一句话让 AI 设计工作流
                </h2>
                <p className="my-item-description mt-1 leading-5">
                  描述你想自动完成的事，AI 会设计一个多步骤流程：安排不同的「AI 伙伴」分工（调研、写报告、检查质量），
                  自动调用项目知识库与任务数据，关键产出带质量门禁。保存后可反复运行。
                </p>
              </div>
              {!aiEnabled && (
                <div className="rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-3 text-my-xs text-my-warning-text">
                  应用内 AI 未启用——请先到「设置 → AI 模型」接入模型。
                </div>
              )}
              <div className="rounded-my-xl border border-my-line bg-my-layer-2 p-4">
                <textarea
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  rows={4}
                  placeholder={'例如：\n· 帮我调研项目里所有和「支付」相关的规范和任务，整理成一份给新人看的简报\n· 每周五扫描任务看板，找出停滞的任务并给出处理建议'}
                  className="my-input resize-none p-3 text-my-xs leading-6"
                />
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="primary" onClick={() => void generate()} disabled={generating || !idea.trim()} className="text-my-xs">
                    {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    {generating ? 'AI 设计中…' : '生成工作流'}
                  </Button>
                  <span className="my-item-description">生成约需 10~30 秒，取决于模型速度</span>
                </div>
              </div>

              {draft && (
                <div className="rounded-my-xl border border-my-line-accent-subtle bg-my-layer-2">
                  <div className="flex items-center gap-2 border-b border-my-line px-4 py-2.5">
                    <span className="text-my-xs font-semibold text-my-primary">{draft.name}</span>
                    <span className="my-item-description flex-1 truncate">{draft.description}</span>
                    <Button variant="ghost" size="sm" className="px-1.5 text-my-2xs" onClick={() => setShowJson((v) => !v)} title="查看/编辑 DSL JSON">
                      <FileJson size={11} /> {showJson ? '可视化' : 'JSON'}
                    </Button>
                    <Button variant="primary" size="sm" className="text-my-xs" onClick={() => void saveDraft()} disabled={savingDraft}>
                      {savingDraft ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} 保存
                    </Button>
                  </div>
                  <div className="p-4">
                    {showJson ? (
                      <textarea
                        value={draftJson}
                        onChange={(e) => setDraftJson(e.target.value)}
                        spellCheck={false}
                        rows={16}
                        className="my-input resize-none p-3 font-mono text-my-xs leading-5"
                      />
                    ) : (
                      <FlowVisual def={draft} />
                    )}
                  </div>
                </div>
              )}
            </PageContent>
          </div>
        )}

        {panel === 'detail' && selected && (
          <div className="my-scrollbar min-h-0 flex-1">
            <PageContent variant="centered" className="space-y-4">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" className="text-my-xs" onClick={() => { setSelected(null); setPanel('design') }}>← 返回</Button>
                <h2 className="text-my-sm font-semibold text-my-primary">{selected.name}</h2>
                <span className="flex-1" />
                <Button variant="primary" onClick={() => void run()} disabled={runStatus === 'running'} className="text-my-xs">
                  <Play size={12} /> 运行
                </Button>
              </div>
              <p className="my-item-description">{selected.description}</p>

              {(selected.inputs?.length ?? 0) > 0 && (
                <div className="rounded-my-xl border border-my-line bg-my-layer-2 p-4 space-y-3">
                  <div className="text-my-xs font-semibold text-my-primary">运行前需要你提供：</div>
                  {selected.inputs.map((i) => (
                    <div key={i.name}>
                      <label className="my-item-title mb-1 block">
                        {i.label} {i.required && <span className="text-my-danger-text">*</span>}
                        {i.description && <span className="my-item-description ml-1">—— {i.description}</span>}
                      </label>
                      <input
                        value={runInputs[i.name] ?? ''}
                        onChange={(e) => setRunInputs({ ...runInputs, [i.name]: e.target.value })}
                        placeholder={i.default || ''}
                        className="my-input h-8 px-2 py-0 text-my-sm"
                      />
                    </div>
                  ))}
                </div>
              )}

              <FlowVisual def={selected} />
            </PageContent>
          </div>
        )}

        {panel === 'run' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-my-line px-4 py-2">
              <span className="text-my-xs font-semibold text-my-primary">
                {runStatus === 'running' ? '正在运行' : viewedRun ? `运行回看 · ${viewedRun.flowName}` : '运行结束'}
              </span>
              {runStatus === 'running' && activeRunId && (
                <>
                  <Loader2 size={12} className="animate-spin text-my-info-text" />
                  <Button variant="danger" size="sm" className="ml-auto text-my-xs" onClick={() => void abort()}>
                    <Square size={11} /> 中止
                  </Button>
                </>
              )}
              {runStatus !== 'running' && (
                <Button variant="ghost" size="sm" className="ml-auto text-my-xs" onClick={() => { setSelected(null); setPanel('design'); setViewedRun(null) }}>关闭</Button>
              )}
            </div>

            {runError && (
              <div className="mx-4 mt-3 rounded-my-lg border border-my-line-danger bg-my-danger-subtle p-2.5 text-my-xs text-my-danger-text">{runError}</div>
            )}

            <div className="my-scrollbar min-h-0 flex-1">
              <PageContent variant="centered" className="space-y-1">
                {events.length === 0 && <p className="py-8 text-center text-my-xs text-my-tertiary">等待事件…</p>}
                {events.map((e, i) => {
                  const isPhase = e.kind === 'phase-start' || e.kind === 'phase-done'
                  return (
                    <div
                      key={`${e.runId}-${i}`}
                      className={clsx(
                        'flex items-start gap-2 rounded-my-lg px-2.5 py-1.5 text-my-xs',
                        isPhase ? 'mt-2 bg-my-accent-subtle text-my-primary' : e.kind === 'step-error' ? 'bg-my-danger-subtle text-my-danger-text' : 'text-my-secondary'
                      )}
                    >
                      <span className="mt-0.5 shrink-0">{eventIcon(e.kind)}</span>
                      <div className="min-w-0 flex-1">
                        <span className={clsx(isPhase && 'font-semibold')}>{e.text ?? e.kind}</span>
                        {e.output && (
                          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-my-2xs leading-4 text-my-tertiary">{e.output}</p>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-my-2xs text-my-placeholder">
                        {new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                      </span>
                    </div>
                  )
                })}
                {runStatus === 'running' && (
                  <div ref={eventsEndRef} className="flex items-center gap-2 px-2.5 py-2 text-my-xs text-my-tertiary">
                    <Loader2 size={11} className="animate-spin" /> 工作流执行中…
                  </div>
                )}
                {/* 运行产物（回看模式） */}
                {viewedRun && viewedRun.status === 'completed' && Object.keys(viewedRun.vars).length > 0 && (
                  <div className="mt-4 space-y-3">
                    {Object.entries(viewedRun.vars).map(([k, v]) => (
                      <div key={k} className="rounded-my-xl border border-my-line bg-my-layer-2">
                        <div className="border-b border-my-line px-3 py-2 text-my-xs font-semibold text-my-primary">产物 · {k}</div>
                        <div className="max-h-72 overflow-y-auto px-3 py-2 text-my-xs">
                          <MarkdownView content={v} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </PageContent>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- 工作流可视化（阶段卡片 + 步骤角色） ---------------- */

function stepIcon(step: FlowStep): JSX.Element {
  if (step.kind === 'agent') return <Bot size={12} className="text-my-info-text" />
  if (step.kind === 'tool') return <Wrench size={12} className="text-my-warning-text" />
  return <ShieldCheck size={12} className="text-my-success-text" />
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
        <div key={p.id} className="rounded-my-xl border border-my-line bg-my-layer-2">
          <div className="flex items-center gap-2 border-b border-my-line px-3.5 py-2">
            <span className="grid h-5 w-5 place-items-center rounded-my-md bg-my-accent-subtle text-my-2xs font-semibold text-my-accent-text">{pi + 1}</span>
            <span className="text-my-xs font-semibold text-my-primary">{p.name}</span>
          </div>
          <div className="space-y-1.5 p-3">
            {p.steps.map((s) => (
              <div key={s.id} className="flex items-start gap-2 rounded-my-lg border border-my-line bg-my-surface-1 px-3 py-2">
                <span className="mt-0.5 shrink-0">{stepIcon(s)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-my-xs text-my-primary">{s.name}</span>
                    <span className="my-chip shrink-0 border border-my-line text-my-2xs text-my-tertiary">{KIND_LABEL[s.kind]}</span>
                    {'tools' in s && s.tools?.length ? (
                      <span className="shrink-0 font-mono text-my-2xs text-my-warning-text" title="可调用的查询工具">
                        {s.tools.join('/')}
                      </span>
                    ) : null}
                  </div>
                  {'instruction' in s && (
                    <p className="mt-0.5 line-clamp-2 text-my-2xs leading-4 text-my-tertiary">{s.instruction}</p>
                  )}
                  {'tool' in s && (
                    <p className="mt-0.5 font-mono text-my-2xs text-my-tertiary">
                      {s.tool}({Object.entries(s.args).map(([k, v]) => `${k}=${v}`).join(', ')})
                    </p>
                  )}
                  {s.kind === 'gate' && (
                    <p className="mt-0.5 text-my-2xs text-my-tertiary">
                      检查「{s.check.stepId}」：{s.check.contains ? `需包含「${s.check.contains}」` : ''}
                      {typeof s.check.minLength === 'number' ? `长度≥${s.check.minLength}` : ''}
                      {s.onFail === 'goto' ? '；未通过则反馈重试' : s.onFail === 'abort' ? '；未通过则中止' : '；未通过则继续'}
                    </p>
                  )}
                </div>
                {'saveOutputAs' in s && s.saveOutputAs && (
                  <span className="shrink-0 rounded-my-sm bg-my-layer-3 px-1.5 py-0.5 font-mono text-my-2xs text-my-secondary" title="产出保存为变量，供后续步骤引用">
                    → {s.saveOutputAs}
                  </span>
                )}
              </div>
            ))}
            {p.steps.length === 0 && <p className="px-1 py-2 text-my-2xs text-my-tertiary">（该阶段暂无步骤）</p>}
          </div>
        </div>
      ))}
      {def.hooks?.onStart && (
        <div className="flex items-center gap-2 rounded-my-lg border border-dashed border-my-line px-3 py-2 text-my-2xs text-my-tertiary">
          <History size={11} /> 开始钩子：{def.hooks.onStart}
        </div>
      )}
      {def.hooks?.onComplete?.saveNote && (
        <div className="flex items-center gap-2 rounded-my-lg border border-dashed border-my-line px-3 py-2 text-my-2xs text-my-tertiary">
          <ChevronRight size={11} /> 完成后自动沉淀到「我的笔记」知识库
        </div>
      )}
    </div>
  )
}
