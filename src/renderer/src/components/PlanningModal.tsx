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
import type { HandoffText, JiraIssue, PlanResult, TaskPlan } from '../../../shared/types'
import type { JSX } from 'react'

const LIB_ICON: Record<string, JSX.Element> = {
  requirements: <ScrollText size={11} />,
  spec: <BookOpenText size={11} />,
  wiki: <FileText size={11} />,
  archive: <Archive size={11} />
}
const LIB_CLS: Record<string, string> = {
  requirements: 'bg-amber-500/15 text-amber-300',
  spec: 'bg-leaf-dim/15 text-leaf-soft',
  wiki: 'bg-sky-500/15 text-sky-300',
  archive: 'bg-violet-500/15 text-violet-300'
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-6 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl">
        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 px-5 py-3">
          <Wand2 size={15} className="text-leaf" />
          <span className="text-sm font-semibold text-mist-50">AI 规划工作台</span>
          {seed.jiraKey && <span className="chip bg-blue-500/15 font-mono text-[10.5px] text-blue-300">⚡ {seed.jiraKey}</span>}
          <span className="text-[10.5px] text-mist-500">需求 → 知识库检索 → AI 计划 → Trellis 任务</span>
          <button onClick={onClose} className="btn-ghost ml-auto justify-center px-1.5" title="关闭">
            <X size={14} />
          </button>
        </div>

        {!aiEnabled && (
          <div className="flex items-center gap-2 border-b border-amber-500/25 bg-amber-500/5 px-5 py-2.5 text-[11.5px] text-amber-300">
            <AlertTriangle size={13} /> 应用内 AI 未启用——请先到「设置 → 应用内 AI」接入 baseUrl 自定义模型
            <button onClick={() => { useApp.getState().setPage('settings'); onClose() }} className="btn-ghost ml-auto text-[11px]">去设置</button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* Step 1: 输入 */}
          {phase === 'input' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-[11px] text-mist-400">需求标题</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className="field w-full" placeholder="如：退药审核行内绑定与比对回退" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-mist-400">需求描述 / Jira 原文（可编辑补充）</span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={7} className="field w-full resize-y font-mono text-[12px]" placeholder="粘贴 Jira 描述、原始需求或直接一句话说明目标…" />
              </label>
              {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-[11.5px] text-rose-300">{error}</div>}
              <div className="flex items-center gap-2 pt-1">
                <button onClick={() => void generate()} disabled={!aiEnabled} className="btn-primary disabled:opacity-40">
                  <Wand2 size={12} /> 检索知识库并生成计划
                </button>
                <span className="text-[10.5px] text-mist-600">AI 会先在四库中检索相关 spec / wiki / 历史 PRD 作为上下文</span>
              </div>
            </div>
          )}

          {/* Step 2: 生成中 */}
          {phase === 'generating' && (
            <div className="grid place-items-center gap-3 py-16 text-center">
              <Loader2 size={26} className="animate-spin text-leaf" />
              <div className="text-xs text-mist-300">正在检索知识库并规划…</div>
              <div className="text-[10.5px] leading-4 text-mist-600">
                本地倒排索引检索（毫秒级）→ AI 组织成 PRD 与子任务
              </div>
            </div>
          )}

          {/* Step 3: 评审 */}
          {phase === 'review' && plan && (
            <div className="space-y-4">
              {/* KB 来源 */}
              <div>
                <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-mist-500">
                  <Library size={11} /> 知识库来源（{result?.sources.length ?? 0} 篇 · {result?.contextChars ?? 0} 字符已注入 AI）
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(result?.sources ?? []).map((s) => (
                    <button
                      key={s.path}
                      onClick={() => void api.revealInExplorer(s.path)}
                      title={s.path}
                      className={clsx('chip text-[10px] hover:opacity-80', LIB_CLS[s.library] ?? 'bg-ink-750 text-mist-300')}
                    >
                      {LIB_ICON[s.library]} {LIB_LABEL[s.library] ?? s.library} · {s.title.slice(0, 24)}
                    </button>
                  ))}
                  {(result?.sources.length ?? 0) === 0 && <span className="text-[11px] text-mist-600">未检索到相关内容——AI 将主要依赖需求原文</span>}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-[11px] text-mist-400">任务标题</span>
                  <input value={plan.title} onChange={(e) => setPlan({ ...plan, title: e.target.value })} className="field w-full" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-mist-400">优先级</span>
                  <select value={plan.priority} onChange={(e) => setPlan({ ...plan, priority: e.target.value })} className="field w-full">
                    {['P0', 'P1', 'P2', 'P3'].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-mist-400">workflow pin（可选）</span>
                  <select value={plan.workflow ?? ''} onChange={(e) => setPlan({ ...plan, workflow: e.target.value || null })} className="field w-full">
                    <option value="">（不指定）</option>
                    {(result?.workflows ?? []).map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[11px] text-mist-400">分支建议（创建后可在详情一键建分支）</span>
                  <input value={plan.branch ?? ''} onChange={(e) => setPlan({ ...plan, branch: e.target.value })} className="field w-full font-mono text-[12px]" placeholder="feat/xxx" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-mist-400">范围 / 模块（可选）</span>
                  <input value={plan.scope ?? ''} onChange={(e) => setPlan({ ...plan, scope: e.target.value || null })} className="field w-full" />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-[11px] text-mist-400">PRD 草稿（写入任务目录，AI 按 workflow 消费）</span>
                <div className="max-h-56 overflow-y-auto rounded-lg border border-ink-600 bg-ink-950 p-3">
                  <MarkdownView content={plan.description} />
                </div>
                <textarea value={plan.description} onChange={(e) => setPlan({ ...plan, description: e.target.value })} rows={3} className="field mt-1.5 w-full resize-y font-mono text-[11px]" title="编辑 PRD 原文" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-mist-400">子任务（每行一条，创建后为可勾选清单）</span>
                <textarea value={subtasksText} onChange={(e) => setSubtasksText(e.target.value)} rows={5} className="field w-full resize-y font-mono text-[12px]" />
              </label>
              {(plan.questions.length > 0 || result?.sources.length === 0) && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-300">
                    <AlertTriangle size={11} /> 开放问题（AI 标注的信息缺口）
                  </div>
                  <ul className="space-y-0.5 text-[11.5px] leading-5 text-amber-200/90">
                    {plan.questions.map((q, i) => <li key={i}>· {q}</li>)}
                    {(result?.sources.length ?? 0) === 0 && <li>· 知识库无相关命中——考虑先补充 spec / Wiki</li>}
                  </ul>
                </div>
              )}
              {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-[11.5px] text-rose-300">{error}</div>}
              <div className="flex items-center gap-2">
                <button onClick={() => void create()} disabled={creating} className="btn-primary disabled:opacity-40">
                  {creating ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} 创建 Trellis 任务
                </button>
                <button onClick={() => void generate()} className="btn-ghost text-[11px]">
                  <RefreshCw size={11} /> 重新生成
                </button>
                <span className="ml-auto text-[10.5px] text-mist-600">将写入 .trellis/tasks/（{snapshot?.meta.developer || '当前开发者'}）</span>
              </div>
            </div>
          )}

          {/* Step 4: 完成 + 衔接 */}
          {phase === 'done' && createdDir && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-xl border border-leaf-dim/30 bg-leaf-dim/10 p-4">
                <CheckCircle2 size={18} className="shrink-0 text-leaf" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-mist-100">任务已创建：{createdDir}</div>
                  <div className="text-[10.5px] text-mist-500">PRD 与子任务清单已写入任务目录，AI 工具按 workflow 即可接手</div>
                </div>
                <button onClick={() => { showTask(createdDir); onClose() }} className="btn-outline ml-auto shrink-0">
                  <FolderOpen size={12} /> 打开任务
                </button>
              </div>
              <div>
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-mist-500">
                  无缝衔接 AI 工具 —— 复制启动提示词，到对应工具里粘贴即可开始
                </div>
                <div className="space-y-1.5">
                  {handoffs.map((h) => (
                    <div key={h.platform} className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-850/60 p-2.5">
                      <span className="chip shrink-0 bg-leaf-dim/15 text-[10px] text-leaf-soft">{h.platform}</span>
                      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[10.5px] leading-4 text-mist-400">{h.text.split('\n')[0]}</pre>
                      <button onClick={() => { void api.copyToClipboard(h.text); pushToast({ kind: 'success', title: `${h.platform} 启动词已复制` }) }} className="btn-ghost shrink-0 justify-center px-2" title="复制完整启动词">
                        <Copy size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850/40 p-3">
                <Radio size={13} className="shrink-0 text-leaf" />
                <div className="min-w-0 flex-1 text-[11px] text-mist-400">
                  也可以到「AI 频道」派发 worker 全自动执行：
                  <code className="ml-1 font-mono text-[10.5px]">trellis channel create {createdDir}-exec --task {createdDir} --by panel-ui</code>
                </div>
                <button onClick={() => { void api.copyToClipboard(`trellis channel create ${createdDir}-exec --task ${createdDir} --by panel-ui`); pushToast({ kind: 'success', title: '频道命令已复制' }) }} className="btn-ghost shrink-0 text-[10.5px]">
                  <Copy size={11} /> 复制
                </button>
                <button onClick={() => { useApp.getState().setPage('channels'); onClose() }} className="btn-outline shrink-0 text-[10.5px]">
                  去 AI 频道
                </button>
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
