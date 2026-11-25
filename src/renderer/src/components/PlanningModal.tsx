import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  X,
  Wand2,
  Loader2,
  ScrollText,
  BookOpenText,
  FileText,
  Archive,
  CheckCircle2,
  Copy,
  RefreshCw,
  Radio,
  FolderOpen,
  AlertTriangle,
  Library
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { Select } from './Select'
import { Button, Modal } from '../my/ui'
import { projectRootKey } from '../my/navigation'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import type { JiraIssue, PlanResult, TaskPlan } from '../../../shared/types'
import type { JSX } from 'react'

const LIB_ICON: Record<string, JSX.Element> = {
  requirements: <ScrollText size={11} />,
  spec: <BookOpenText size={11} />,
  wiki: <FileText size={11} />,
  archive: <Archive size={11} />
}
const LIB_CLS: Record<string, string> = {
  requirements: 'bg-my-label-yellow text-my-label-yellow-text',
  spec: 'bg-my-accent-subtle text-my-accent-text',
  wiki: 'bg-my-label-indigo text-my-label-indigo-text',
  archive: 'bg-my-label-purple text-my-label-purple-text'
}
const LIB_LABEL: Record<string, string> = {
  requirements: '需求库',
  spec: '规范库',
  wiki: 'Wiki',
  archive: '归档'
}

type Phase = 'input' | 'generating' | 'review' | 'done'

export interface PlanningSeed {
  title: string
  description: string
  jiraKey?: string
  jiraUrl?: string
}

/**
 * 规划工作台：需求/Jira issue → 知识库检索（spec/wiki/需求/归档）
 * → 应用内 AI 生成结构化计划 → 人工评审修订 → 一键落成 Trellis 任务
 * （task.json + prd.md，产物清单如实展示）→ 确定性交接包（只核对与阅读）。
 */
export function PlanningModal({ seed, onClose }: { seed: PlanningSeed; onClose: () => void }): JSX.Element {
  const root = useApp((s) => projectRootKey(s.snapshot?.meta.root))
  return <PlanningSession key={JSON.stringify([root, seed.title, seed.description, seed.jiraKey, seed.jiraUrl])} seed={seed} onClose={onClose} />
}

function PlanningSession({ seed, onClose }: { seed: PlanningSeed; onClose: () => void }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const settings = useApp((s) => s.settings)
  const showTask = useApp((s) => s.showTask)
  const aiEnabled = settings?.ai.enabled ?? false
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const request = useRef(0)
  const pending = useRef(false)
  const alive = useRef(true)
  const closed = useRef(false)
  const copyPending = useRef(false)
  const handoffPending = useRef(false)
  const root = projectRootKey(useApp.getState().snapshot?.meta.root)

  const [phase, setPhase] = useState<Phase>('input')
  const [title, setTitle] = useState(seed.title)
  const [description, setDescription] = useState(seed.description)
  const [result, setResult] = useState<PlanResult | null>(null)
  const [plan, setPlan] = useState<TaskPlan | null>(null)
  const [subtasksText, setSubtasksText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createdDir, setCreatedDir] = useState<string | null>(null)
  const [createdFiles, setCreatedFiles] = useState<string[]>([])
  const [createdWarnings, setCreatedWarnings] = useState<string[]>([])
  const [handoff, setHandoff] = useState<{ text: string; issues: string[] } | null>(null)
  const [handoffLoading, setHandoffLoading] = useState(false)
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [copying, setCopying] = useState(false)
  const [isClosed, setClosed] = useState(false)

  const close = useCallback((): void => {
    closed.current = true
    request.current++
    setClosed(true)
    onClose()
  }, [onClose])

  useLayoutEffect(() => {
    alive.current = interactive
    if (!interactive) {
      pending.current = false
      copyPending.current = false
      handoffPending.current = false
      setCreating(false)
      setCopying(false)
      setHandoffLoading(false)
      setPhase((current) => current === 'generating' ? (plan ? 'review' : 'input') : current)
    }
    return () => { alive.current = false; request.current++ }
  }, [interactive])

  useLayoutEffect(() => useApp.subscribe((state, previous) => {
    // Observe every transition, including a batched A -> B -> A project switch.
    if (projectRootKey(state.snapshot?.meta.root) !== projectRootKey(previous.snapshot?.meta.root)) close()
  }), [close])

  const owns = (ticket: number): boolean => alive.current && !closed.current && canInteract() && request.current === ticket && root === projectRootKey(useApp.getState().snapshot?.meta.root)

  const buildHandoff = async (dir: string, ticket = request.current): Promise<void> => {
    if (handoffPending.current || !owns(ticket)) return
    handoffPending.current = true
    setHandoffLoading(true)
    setHandoffError(null)
    try {
      const hb = await api.taskHandoffBuild(dir, '只核对与阅读，不开始实施', false)
      if (!owns(ticket)) return
      if (hb.ok) setHandoff({ text: hb.text, issues: hb.issues })
      else setHandoffError(hb.error || '交接材料生成失败')
    } catch (cause) {
      if (owns(ticket)) setHandoffError(cause instanceof Error ? cause.message : '交接材料生成失败')
    } finally {
      if (owns(ticket)) { handoffPending.current = false; setHandoffLoading(false) }
    }
  }

  const copy = async (text: string, success: string): Promise<void> => {
    const ticket = request.current
    if (copyPending.current || !owns(ticket)) return
    copyPending.current = true
    setCopying(true)
    setError(null)
    try {
      await api.copyToClipboard(text)
      if (owns(ticket)) pushToast({ kind: 'success', title: success })
    } catch (cause) {
      if (owns(ticket)) setError(cause instanceof Error ? cause.message : '复制失败，请重试')
    } finally {
      if (owns(ticket)) { copyPending.current = false; setCopying(false) }
    }
  }

  const generate = async (): Promise<void> => {
    if (pending.current || !aiEnabled || !owns(request.current)) return
    if (!title.trim()) {
      setError('请填写需求标题')
      return
    }
    setError(null)
    pending.current = true
    const ticket = ++request.current
    const recover = plan ? 'review' : 'input'
    setPhase('generating')
    try {
      const res = await api.aiPlan({
        title: title.trim(),
        description: description.trim(),
        jiraKey: seed.jiraKey,
        jiraUrl: seed.jiraUrl
      })
      if (!owns(ticket)) return
      if (res.ok && res.plan) {
        setResult(res)
        setPlan(res.plan)
        setSubtasksText(res.plan.subtasks.map((s) => s.replace(/^\s*-\s*\[[ xX]\]\s*/, '')).join('\n'))
        setPhase('review')
      } else {
        setError(res.error ?? '生成失败')
        setPhase(recover)
      }
    } catch (cause) {
      if (owns(ticket)) { setError(cause instanceof Error ? cause.message : '生成失败'); setPhase(recover) }
    } finally {
      if (owns(ticket)) pending.current = false
    }
  }

  const create = async (): Promise<void> => {
    if (!plan || pending.current || !owns(request.current)) return
    pending.current = true
    const ticket = ++request.current
    setError(null)
    setCreating(true)
    const subtasks = subtasksText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `- [ ] ${l.replace(/^-\s*/, '')}`)
    try {
      const res = await api.taskCreateFromPlan({
        ...plan,
        subtasks,
        jiraKey: seed.jiraKey,
        jiraUrl: seed.jiraUrl
      })
      if (!owns(ticket)) return
      if (res.ok && res.dirName) {
        setCreatedDir(res.dirName)
        setCreatedFiles(res.files ?? [])
        setCreatedWarnings(res.warnings ?? [])
        setPhase('done')
        await buildHandoff(res.dirName, ticket)
      } else {
        setError(res.error ?? '创建失败')
      }
    } catch (cause) {
      if (owns(ticket)) setError(cause instanceof Error ? cause.message : '创建失败')
    } finally {
      if (owns(ticket)) { pending.current = false; setCreating(false) }
    }
  }

  return (
    <Modal open={!isClosed} onClose={close} width={896} placement="center" ariaLabel="AI 规划工作台">
      <div className="flex max-h-[inherit] flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-my-line px-5 py-3">
          <Wand2 size={15} className="shrink-0 text-my-icon-accent" />
          <span className="text-my-sm font-semibold text-my-primary">AI 规划工作台</span>
          {seed.jiraKey && <span className="my-chip bg-my-label-indigo font-mono text-my-label-indigo-text">⚡ {seed.jiraKey}</span>}
          <Button variant="ghost" className="ml-auto justify-center px-1.5" onClick={close} aria-label="关闭规划工作台" title="关闭">
            <X size={14} />
          </Button>
        </div>

        {!aiEnabled && (
          <div className="flex items-center gap-2 border-b border-my-line-warning bg-my-warning-subtle px-5 py-2.5 text-my-xs text-my-warning-text">
            <AlertTriangle size={13} /> 应用内 AI 未启用——请先到「设置 → 应用内 AI」接入 baseUrl 自定义模型
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { useApp.getState().setPage('settings'); close() }}>去设置</Button>
          </div>
        )}

        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
          {error && <div role="alert" className="mb-3 break-words rounded-my-lg border border-my-line bg-my-layer-1 p-2.5 text-my-xs text-my-danger-text">{error}</div>}
          {/* Step 1: 输入 */}
          {phase === 'input' && (
            <div className="space-y-3">
              <label className="block">
                <span className="my-item-title mb-1 block">需求标题</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className="my-input h-8 px-2 py-0 text-my-sm" placeholder="如：退药审核行内绑定与比对回退" />
              </label>
              <label className="block">
                <span className="my-item-title mb-1 block">需求描述（可编辑）</span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={7} className="my-input resize-y px-2 py-1.5 font-mono text-my-sm" placeholder="Jira 描述或原始需求…" />
              </label>
              <div className="flex items-center gap-2 pt-1">
                <Button variant="primary" disabled={!aiEnabled} onClick={() => void generate()}>
                  <Wand2 size={12} /> 生成计划
                </Button>
                <span className="my-item-description">四库检索 → AI 组织</span>
              </div>
            </div>
          )}

          {/* Step 2: 生成中 */}
          {phase === 'generating' && (
            <div role="status" className="flex items-center gap-2 py-3">
              <Loader2 size={14} className="animate-spin text-my-icon-secondary" />
              <div className="text-my-xs text-my-secondary">正在检索知识库并规划…</div>
            </div>
          )}

          {/* Step 3: 评审 */}
          {(phase === 'review' || phase === 'generating') && plan && (
            <fieldset disabled={creating || phase === 'generating'} className="min-w-0 space-y-4">
              {/* KB 来源 */}
              <div>
                <div className="mb-1.5 flex items-center gap-2 text-my-xs font-semibold uppercase tracking-wide text-my-tertiary">
                  <Library size={11} /> 知识库来源 · {result?.sources.length ?? 0} 篇
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(result?.sources ?? []).map((s) => (
                    <button
                      key={s.path}
                      onClick={() => void api.revealInExplorer(s.path)}
                      title={s.path}
                      className={clsx('my-chip hover:opacity-80', LIB_CLS[s.library] ?? 'bg-my-layer-2 text-my-secondary')}
                    >
                      {LIB_ICON[s.library]} {LIB_LABEL[s.library] ?? s.library} · {s.title.slice(0, 24)}
                    </button>
                  ))}
                  {(result?.sources.length ?? 0) === 0 && <span className="my-item-description">未检索到相关内容——AI 将主要依赖需求原文</span>}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="my-item-title mb-1 block">任务标题</span>
                  <input value={plan.title} onChange={(e) => setPlan({ ...plan, title: e.target.value })} className="my-input h-8 px-2 py-0 text-my-sm" />
                </label>
                <label className="block">
                  <span className="my-item-title mb-1 block">优先级</span>
                  <Select
                    value={plan.priority}
                    onChange={(val) => setPlan({ ...plan, priority: val })}
                    options={['P0', 'P1', 'P2', 'P3']}
                    className="w-full"
                  />
                </label>
                <label className="block">
                  <span className="my-item-title mb-1 block">workflow pin（可选）</span>
                  <Select
                    value={plan.workflow ?? ''}
                    onChange={(val) => setPlan({ ...plan, workflow: val || null })}
                    options={[
                      { value: '', label: '（不指定）' },
                      ...(result?.workflows ?? []).map((w) => ({ value: w, label: w }))
                    ]}
                    className="w-full"
                  />
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="my-item-title mb-1 block">分支建议</span>
                  <input value={plan.branch ?? ''} onChange={(e) => setPlan({ ...plan, branch: e.target.value })} className="my-input h-8 px-2 py-0 font-mono text-my-sm" placeholder="feat/xxx" />
                </label>
                <label className="block">
                  <span className="my-item-title mb-1 block">范围 / 模块（可选）</span>
                  <input value={plan.scope ?? ''} onChange={(e) => setPlan({ ...plan, scope: e.target.value || null })} className="my-input h-8 px-2 py-0 text-my-sm" />
                </label>
              </div>
              <label className="block">
                <span className="my-item-title mb-1 block">PRD 草稿</span>
                <div className="max-h-56 overflow-y-auto rounded-my-lg border border-my-line bg-my-canvas p-3">
                  <MarkdownView content={plan.description} />
                </div>
                <textarea value={plan.description} onChange={(e) => setPlan({ ...plan, description: e.target.value })} rows={3} className="my-input mt-1.5 resize-y px-2 py-1.5 font-mono text-my-xs" title="编辑 PRD 原文" />
              </label>
              <label className="block">
                <span className="my-item-title mb-1 block">子任务（每行一条）</span>
                <textarea value={subtasksText} onChange={(e) => setSubtasksText(e.target.value)} rows={5} className="my-input resize-y px-2 py-1.5 font-mono text-my-sm" />
              </label>
              {(plan.questions.length > 0 || result?.sources.length === 0) && (
                <div className="rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-3">
                  <div className="mb-1 flex items-center gap-1.5 text-my-xs font-semibold text-my-warning-text">
                    <AlertTriangle size={11} /> 开放问题（AI 标注的信息缺口）
                  </div>
                  <ul className="space-y-0.5 text-my-xs leading-5 text-my-warning-text">
                    {plan.questions.map((q, i) => <li key={i}>· {q}</li>)}
                    {(result?.sources.length ?? 0) === 0 && <li>· 知识库无相关命中——考虑先补充 spec / Wiki</li>}
                  </ul>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" aria-label="创建 Trellis 任务" aria-busy={creating} disabled={creating} onClick={() => void create()}>
                  {creating ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} {creating ? '创建中…' : '创建 Trellis 任务'}
                </Button>
                <Button variant="ghost" size="sm" disabled={!aiEnabled || creating || phase === 'generating'} onClick={() => void generate()}>
                  <RefreshCw size={11} /> 重新生成
                </Button>
              </div>
            </fieldset>
          )}

          {/* Step 4: 完成 + 衔接 */}
          {phase === 'done' && createdDir && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-my-xl border border-my-line-accent-subtle bg-my-accent-subtle p-4">
                <CheckCircle2 size={18} className="shrink-0 text-my-icon-accent" />
                <div className="min-w-0">
                  <div className="my-item-title">任务已创建：{createdDir}</div>
                  <div className="my-item-description">
                    已写入：{createdFiles.length > 0 ? createdFiles.join('、') : 'task.json'}
                    {createdFiles.includes('prd.md') ? '（可在任务内直接阅读）' : ''}
                  </div>
                </div>
                <Button variant="outline" className="ml-auto shrink-0" onClick={() => { showTask(createdDir); close() }}>
                  <FolderOpen size={12} /> 打开任务
                </Button>
              </div>
              {createdWarnings.length > 0 && (
                <div className="rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-3 text-my-xs leading-5 text-my-warning-text">
                  <div className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle size={11} /> 部分产物未写入</div>
                  {createdWarnings.map((w, i) => <div key={i}>· {w}</div>)}
                </div>
              )}
              <div>
                <div className="mb-2 text-my-xs font-semibold uppercase tracking-wide text-my-tertiary">交接材料（默认只核对与阅读）</div>
                {handoffLoading ? <div role="status" className="flex items-center gap-2 text-my-xs text-my-secondary"><Loader2 size={12} className="animate-spin" />正在生成交接材料…</div> : handoff ? (
                  <div className="space-y-1.5">
                    {handoff.issues.length > 0 && (
                      <div className="rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-2.5 text-my-2xs leading-4 text-my-warning-text">
                        已知读取问题：{handoff.issues.join('；')}
                      </div>
                    )}
                    <div className="flex items-start gap-2 rounded-my-lg border border-my-line bg-my-layer-1 p-2.5">
                      <pre className="min-h-16 max-h-44 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-all font-mono text-my-2xs leading-4 text-my-secondary">{handoff.text}</pre>
                      <Button variant="ghost" disabled={copying} className="shrink-0 justify-center px-2" onClick={() => void copy(handoff.text, '交接材料已复制')} aria-label="复制完整交接材料" title="复制完整交接材料">
                        <Copy size={12} />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-my-lg border border-my-line bg-my-layer-1 p-2.5 text-my-xs text-my-secondary">
                    <span role="alert" className="min-w-0 flex-1">{handoffError ?? '交接材料暂不可用'}</span>
                    <Button variant="ghost" size="sm" onClick={() => void buildHandoff(createdDir)}>重试</Button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 rounded-my-lg border border-my-line bg-my-layer-1 p-3">
                <Radio size={13} className="shrink-0 text-my-icon-accent" />
                <div className="min-w-0 flex-1 truncate text-my-xs text-my-secondary">
                  <code className="font-mono text-my-2xs">channel create {createdDir}-exec --task {createdDir}</code>
                </div>
                <Button variant="ghost" size="sm" disabled={copying} className="shrink-0" onClick={() => void copy(`trellis channel create ${createdDir}-exec --task ${createdDir} --by panel-ui`, '频道命令已复制')}>
                  <Copy size={11} /> 复制
                </Button>
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => { useApp.getState().setPage('channels'); close() }}>
                  去 AI 频道
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function planningSeedFromIssue(issue: JiraIssue, description: string): PlanningSeed {
  return {
    title: issue.summary,
    description,
    jiraKey: issue.key,
    jiraUrl: issue.url
  }
}
