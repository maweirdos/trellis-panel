import { useState } from 'react'
import { X, Sparkles, Save, Wand2 } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { Button } from '../my/ui'
import { PlanningModal } from './PlanningModal'
import { useKnowledgeRequest } from '../knowledge/request-intake'
import type { JSX } from 'react'

/**
 * 待办录入：面板只记录需求。
 * Codex / ZCode / Claude Code 后续通过 MCP 或 tpanel CLI 认领待办；
 * 或直接「AI 规划成任务」——检索知识库 → 结构化计划 → 一键落成 Trellis 任务。
 */
export function IntakeModal(): JSX.Element | null {
  const open = useApp((s) => s.intakeOpen)
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
  const saveTodo = useApp((s) => s.saveTodo)
  const snapshot = useApp((s) => s.snapshot)
  const setPage = useApp((s) => s.setPage)

  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [priority, setPriority] = useState('P2')
  const [busy, setBusy] = useState(false)
  /** 直达 AI 规划（需求直通车）：把当前输入交给规划工作台 */
  const [planSeed, setPlanSeed] = useState<{ title: string; description: string } | null>(null)

  if (!open) return null

  if (planSeed) {
    return (
      <PlanningModal
        seed={planSeed}
        onClose={() => {
          setPlanSeed(null)
          setIntakeOpen(false)
          setTitle('')
          setDesc('')
        }}
      />
    )
  }

  const close = (): void => {
    if (busy) return
    setIntakeOpen(false)
    setTitle('')
    setDesc('')
    setPriority('P2')
  }

  const closeOnBackdrop = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) close()
  }

  const createTodo = async (): Promise<void> => {
    if (!title.trim() || busy) return
    setBusy(true)
    const ok = await saveTodo({
      title: title.trim(),
      description: desc.trim(),
      priority,
      source: 'manual'
    })
    setBusy(false)
    if (!ok) return
    setIntakeOpen(false)
    setTitle('')
    setDesc('')
    setPriority('P2')
    setPage('inbox')
  }

  return (
    <div className="absolute inset-0 z-50 grid animate-fade-in place-items-center bg-my-backdrop backdrop-blur-sm" onClick={closeOnBackdrop}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85%] w-[520px] flex-col overflow-hidden rounded-my-xl border border-my-line bg-my-layer-2 shadow-[var(--my-shadow-overlay-200)]"
      >
        <div className="flex items-center gap-2 border-b border-my-line px-5 py-3.5">
          <Sparkles size={15} className="text-my-icon-accent" />
          <span className="text-my-md font-semibold text-my-primary">新建待办</span>
          <span className="my-chip border border-my-line-warning bg-my-warning-subtle text-my-warning-text">记录需求，不启动 AI</span>
          <button
            onClick={close}
            className="ml-auto rounded-my-md p-1.5 text-my-icon-secondary transition-colors hover:bg-my-layer-transparent-hover hover:text-my-primary"
            title="关闭"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-3.5 overflow-y-auto p-5">
          <div>
            <label className="mb-1.5 block text-my-xs text-my-secondary">需求标题 *</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="一句话说清要做什么，如：增加 Jira 状态映射配置"
              className="h-8 w-full rounded-my-md border border-my-line bg-my-surface-1 px-2.5 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
              onKeyDown={(e) => e.key === 'Enter' && void createTodo()}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-my-xs text-my-secondary">需求描述</label>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={6}
              placeholder="背景、验收标准、涉及模块…（AI 认领时可直接读取）"
              className="w-full resize-y rounded-my-md border border-my-line bg-my-surface-1 px-2.5 py-1.5 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-my-xs text-my-secondary">优先级</label>
            <div className="flex gap-1.5">
              {(
                [
                  ['P0', '紧急 P0', 'bg-my-danger-subtle text-my-danger-text'],
                  ['P1', '高 P1', 'bg-my-warning-subtle text-my-warning-text'],
                  ['P2', '中 P2', 'bg-my-layer-3 text-my-secondary'],
                  ['P3', '低 P3', 'bg-my-layer-3 text-my-tertiary']
                ] as const
              ).map(([p, label, buttonClass]) => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={clsx(
                    'inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-my-md px-2.5 py-1 text-my-xs font-medium transition-colors',
                    buttonClass,
                    priority === p && 'ring-2 ring-my-line-accent'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-my-md border border-my-line bg-my-layer-1 px-3.5 py-2.5 text-my-xs leading-5 text-my-tertiary">
            创建后待办将保存为本地文档（.trellis/todos/*.md）。Codex / ZCode / Claude Code 可以直接读取该文件进行需求规划并转换为正式任务。
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-my-line px-5 py-3">
          <Button variant="primary" disabled={!title.trim() || busy || !snapshot} onClick={() => {
            if (!snapshot) return
            if (useKnowledgeRequest.getState().stage({ root: snapshot.meta.root, title: title.trim(), description: desc.trim(), source: { kind: 'manual' } })) close()
          }} title="携带可编辑需求进入现有 Agent；手动选择会话并发送，不创建任务">
            <Sparkles size={12} /> Agent 需求梳理
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (!title.trim()) return
              setPlanSeed({ title: title.trim(), description: desc.trim() })
            }}
            disabled={!title.trim()}
            title="检索知识库 → AI 生成结构化任务计划（PRD/子任务/分支建议）→ 一键落成 Trellis 任务"
          >
            <Wand2 size={12} /> 兼容：一次规划
          </Button>
          <span className="ml-auto text-my-2xs text-my-tertiary">{snapshot?.meta.name}</span>
          <Button variant="outline" onClick={close} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={() => void createTodo()} disabled={!title.trim() || busy}>
            <Save size={12} /> {busy ? '创建中…' : '仅保存待办'}
          </Button>
        </div>
      </div>
    </div>
  )
}
