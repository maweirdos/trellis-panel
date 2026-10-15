import { useEffect, useState } from 'react'
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
import { Button } from '../my/ui'
import type { HandoffText, JiraIssue, PlanResult, TaskPlan } from '../../../shared/types'
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

type Phase = 'input' | 'generating' | 'review' | 'creating' | 'done'

export interface PlanningSeed {
  title: string
  description: string
  jiraKey?: string
  jiraUrl?: string
}

/**
 * 规划工作台：需求/Jira issue → 知识库检索（spec/wiki/需求/归档）
 * → 应用内 AI 生成结构化计划 → 人工评审修订 → 一键落成 Trellis 任务
 * → 生成各 AI 工具（codex / Claude Code / ZCode）的启动衔接。
 */
export function PlanningModal({ seed, onClose }: { seed: PlanningSeed; onClose: () => void }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const settings = useApp((s) => s.settings)
  const snapshot = useApp((s) => s.snapshot)
  const showTask = useApp((s) => s.showTask)
  const aiEnabled = settings?.ai.enabled ?? false

  const [phase, setPhase] = useState<Phase>('input')
  const [title, setTitle] = useState(seed.title)
  const [description, setDescription] = useState(seed.description)
  const [result, setResult] = useState<PlanResult | null>(null)
  const [plan, setPlan] = useState<TaskPlan | null>(null)
  const [subtasksText, setSubtasksText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createdDir, setCreatedDir] = useState<string | null>(null)
  const [handoffs, setHandoffs] = useState<HandoffText[]>([])

  const generate = async (): Promise<void> => {
    if (!title.trim()) {
      setError('请填写需求标题')
      return
    }
    setError(null)
    setPhase('generating')
    const res = await api.aiPlan({
      title: title.trim(),
      description: description.trim(),
      jiraKey: seed.jiraKey,
      jiraUrl: seed.jiraUrl
    })
    setResult(res)
    if (res.ok && res.plan) {
      setPlan(res.plan)
      setSubtasksText(res.plan.subtasks.map((s) => s.replace(/^\s*-\s*\[[ xX]\]\s*/, '')).join('\n'))
      setPhase('review')
    } else {
      setError(res.error ?? '生成失败')
      setPhase('input')
    }
  }

  const create = async (): Promise<void> => {
    if (!plan) return
    setCreating(true)
    const subtasks = subtasksText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `- [ ] ${l.replace(/^-\s*/, '')}`)
    const res = await api.taskCreateFromPlan({
      ...plan,
      subtasks,
      jiraKey: seed.jiraKey,
      jiraUrl: seed.jiraUrl
    })
    setCreating(false)
    if (res.ok && res.dirName) {
      setCreatedDir(res.dirName)
      setPhase('done')
      const hs = await api.planHandoff(res.dirName)
      setHandoffs(hs)
    } else {
      setError(res.error ?? '创建失败')
      setPhase('review')
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-my-backdrop p-6 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-my-xl border border-my-line bg-my-layer-2 shadow-[var(--my-shadow-overlay-200)]">
        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-my-line px-5 py-3">
          <Wand2 size={15} className="text-my-icon-accent" />
          <span className="text-my-sm font-semibold text-my-primary">AI 规划工作台</span>
          {seed.jiraKey && <span className="my-chip bg-my-label-indigo font-mono text-my-label-indigo-text">⚡ {seed.jiraKey}</span>}
          <span className="text-my-2xs text-my-tertiary">需求 → 知识库检索 → AI 计划 → Trellis 任务</span>
          <Button variant="ghost" className="ml-auto justify-center px-1.5" onClick={onClose} title="关闭">
            <X size={14} />
          </Button>
        </div>

        {!aiEnabled && (
          <div className="flex items-center gap-2 border-b border-my-line-warning bg-my-warning-subtle px-5 py-2.5 text-my-xs text-my-warning-text">
            <AlertTriangle size={13} /> 应用内 AI 未启用——请先到「设置 → 应用内 AI」接入 baseUrl 自定义模型
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { useApp.getState().setPage('settings'); onClose() }}>去设置</Button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* Step 1: 输入 */}
          {phase === 'input' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-my-xs text-my-secondary">需求标题</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 w-full rounded-my-md border border-my-line bg-my-surface-1 px-2 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent" placeholder="如：退药审核行内绑定与比对回退" />
              </label>
              <label className="block">
                <span className="mb-1 block text-my-xs text-my-secondary">需求描述（可编辑）</span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={7} className="w-full resize-y rounded-my-md border border-my-line bg-my-surface-1 px-2 py-1.5 font-mono text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent" placeholder="Jira 描述或原始需求…" />
              </label>
              {error && <div className="rounded-my-lg border border-my-line-danger bg-my-danger-subtle p-2.5 text-my-xs text-my-danger-text">{error}</div>}
              <div className="flex items-center gap-2 pt-1">
                <Button variant="primary" disabled={!aiEnabled} onClick={() => void generate()}>
                  <Wand2 size={12} /> 生成计划
                </Button>
                <span className="text-my-2xs text-my-placeholder">四库检索 → AI 组织</span>
              </div>
            </div>
          )}

          {/* Step 2: 生成中 */}
          {phase === 'generating' && (
            <div className="grid place-items-center gap-3 py-16 text-center">
              <Loader2 size={26} className="animate-spin text-my-icon-accent" />
              <div className="text-my-xs text-my-secondary">正在检索知识库并规划…</div>
              <div className="text-my-2xs leading-4 text-my-placeholder">
                本地倒排索引检索（毫秒级）→ AI 组织成 PRD 与子任务
              </div>
            </div>
          )}

          {/* Step 3: 评审 */}
          {phase === 'review' && plan && (
            <div className="space-y-4">
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
                  {(result?.sources.length ?? 0) === 0 && <span className="text-my-xs text-my-placeholder">未检索到相关内容——AI 将主要依赖需求原文</span>}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-my-xs text-my-secondary">任务标题</span>
                  <input value={plan.title} onChange={(e) => setPlan({ ...plan, title: e.target.value })} className="h-8 w-full rounded-my-md border border-my-line bg-my-surface-1 px-2 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-my-xs text-my-secondary">优先级</span>
                  <Select
                    value={plan.priority}
                    onChange={(val) => setPlan({ ...plan, priority: val })}
                    options={['P0', 'P1', 'P2', 'P3']}
                    className="w-full"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-my-xs text-my-secondary">workflow pin（可选）</span>
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
                  <span className="mb-1 block text-my-xs text-my-secondary">分支建议</span>
                  <input value={plan.branch ?? ''} onChange={(e) => setPlan({ ...plan, branch: e.target.value })} className="h-8 w-full rounded-my-md border border-my-line bg-my-surface-1 px-2 font-mono text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent" placeholder="feat/xxx" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-my-xs text-my-secondary">范围 / 模块（可选）</span>
                  <input value={plan.scope ?? ''} onChange={(e) => setPlan({ ...plan, scope: e.target.value || null })} className="h-8 w-full rounded-my-md border border-my-line bg-my-surface-1 px-2 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent" />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-my-xs text-my-secondary">PRD 草稿</span>
                <div className="max-h-56 overflow-y-auto rounded-my-lg border border-my-line bg-my-canvas p-3">
                  <MarkdownView content={plan.description} />
                </div>
                <textarea value={plan.description} onChange={(e) => setPlan({ ...plan, description: e.target.value })} rows={3} className="mt-1.5 w-full resize-y rounded-my-md border border-my-line bg-my-surface-1 px-2 py-1.5 font-mono text-my-xs text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent" title="编辑 PRD 原文" />
              </label>
              <label className="block">
                <span className="mb-1 block text-my-xs text-my-secondary">子任务（每行一条）</span>
                <textarea value={subtasksText} onChange={(e) => setSubtasksText(e.target.value)} rows={5} className="w-full resize-y rounded-my-md border border-my-line bg-my-surface-1 px-2 py-1.5 font-mono text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent" />
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
              {error && <div className="rounded-my-lg border border-my-line-danger bg-my-danger-subtle p-2.5 text-my-xs text-my-danger-text">{error}</div>}
              <div className="flex items-center gap-2">
                <Button variant="primary" disabled={creating} onClick={() => void create()}>
                  {creating ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} 创建 Trellis 任务
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void generate()}>
                  <RefreshCw size={11} /> 重新生成
                </Button>
                <span className="ml-auto text-my-2xs text-my-placeholder">.trellis/tasks/</span>
              </div>
            </div>
          )}

          {/* Step 4: 完成 + 衔接 */}
          {phase === 'done' && createdDir && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-my-xl border border-my-line-accent-subtle bg-my-accent-subtle p-4">
                <CheckCircle2 size={18} className="shrink-0 text-my-icon-accent" />
                <div className="min-w-0">
                  <div className="text-my-xs font-semibold text-my-primary">任务已创建：{createdDir}</div>
                  <div className="text-my-2xs text-my-tertiary">PRD 与子任务清单已写入任务目录，AI 工具按 workflow 即可接手</div>
                </div>
                <Button variant="outline" className="ml-auto shrink-0" onClick={() => { showTask(createdDir); onClose() }}>
                  <FolderOpen size={12} /> 打开任务
                </Button>
              </div>
              <div>
                <div className="mb-2 text-my-xs font-semibold uppercase tracking-wide text-my-tertiary">启动衔接</div>
                <div className="space-y-1.5">
                  {handoffs.map((h) => (
                    <div key={h.platform} className="flex items-start gap-2 rounded-my-lg border border-my-line bg-my-layer-1 p-2.5">
                      <span className="my-chip shrink-0 bg-my-accent-subtle text-my-accent-text">{h.platform}</span>
                      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-my-2xs leading-4 text-my-secondary">{h.text.split('\n')[0]}</pre>
                      <Button variant="ghost" className="shrink-0 justify-center px-2" onClick={() => { void api.copyToClipboard(h.text); pushToast({ kind: 'success', title: `${h.platform} 启动词已复制` }) }} title="复制完整启动词">
                        <Copy size={12} />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-my-lg border border-my-line bg-my-layer-1 p-3">
                <Radio size={13} className="shrink-0 text-my-icon-accent" />
                <div className="min-w-0 flex-1 truncate text-my-xs text-my-secondary">
                  <code className="font-mono text-my-2xs">channel create {createdDir}-exec --task {createdDir}</code>
                </div>
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => { void api.copyToClipboard(`trellis channel create ${createdDir}-exec --task ${createdDir} --by panel-ui`); pushToast({ kind: 'success', title: '频道命令已复制' }) }}>
                  <Copy size={11} /> 复制
                </Button>
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => { useApp.getState().setPage('channels'); onClose() }}>
                  去 AI 频道
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
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
