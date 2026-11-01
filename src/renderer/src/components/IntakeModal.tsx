import { useEffect, useId, useRef, useState } from 'react'
import { X, Sparkles, Save, Wand2 } from 'lucide-react'
import { useApp } from '../store'
import { clsx } from 'clsx'
import { Button, Modal } from '../my/ui'
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
  const projectRoot = useApp((s) => s.snapshot?.meta.root ?? null)
  // A draft and its pending result belong to one project, even across close/reopen.
  return <IntakeForm key={projectRoot ?? 'no-project'} open={open} projectRoot={projectRoot} />
}

const SAVE_WAIT_NOTICE_MS = 15_000

function IntakeForm({ open, projectRoot }: { open: boolean; projectRoot: string | null }): JSX.Element | null {
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
  const saveTodo = useApp((s) => s.saveTodo)
  const snapshot = useApp((s) => s.snapshot)
  const setPage = useApp((s) => s.setPage)

  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [priority, setPriority] = useState('P2')
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string } | null>(null)
  const fieldId = useId()
  const draftRevision = useRef(0)
  const session = useRef(0)
  const pending = useRef<{ session: number; revision: number; timer: ReturnType<typeof setTimeout> | null } | null>(null)
  /** 直达 AI 规划（需求直通车）：把当前输入交给规划工作台 */
  const [planSeed, setPlanSeed] = useState<{ title: string; description: string } | null>(null)

  useEffect(() => {
    // Observe every transition, including close/reopen or A→B→A in one render batch.
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.intakeOpen !== previous.intakeOpen || state.snapshot?.meta.root !== previous.snapshot?.meta.root) session.current += 1
    })
    return () => {
      unsubscribe()
      if (pending.current?.timer) clearTimeout(pending.current.timer)
      pending.current = null
    }
  }, [])

  if (!open) return null

  if (planSeed) {
    return (
      <PlanningModal
        seed={planSeed}
        onClose={() => {
          setPlanSeed(null)
          setIntakeOpen(false)
        }}
      />
    )
  }

  const close = (): void => {
    // Closing this view does not cancel a save already accepted by the backend.
    setIntakeOpen(false)
  }

  const edited = (): void => {
    draftRevision.current += 1
    setFeedback(null)
  }

  const createTodo = async (): Promise<void> => {
    if (!title.trim() || pending.current || !projectRoot || useApp.getState().snapshot?.meta.root !== projectRoot) return
    const request = { session: session.current, revision: draftRevision.current, timer: null as ReturnType<typeof setTimeout> | null }
    pending.current = request
    setBusy(true)
    setSlow(false)
    setFeedback(null)
    request.timer = setTimeout(() => {
      if (pending.current === request) setSlow(true)
    }, SAVE_WAIT_NOTICE_MS)
    const ownsView = (): boolean => pending.current === request && session.current === request.session && useApp.getState().intakeOpen && useApp.getState().snapshot?.meta.root === projectRoot
    try {
      const ok = await saveTodo({ title: title.trim(), description: desc.trim(), priority, source: 'manual' })
      if (!ownsView()) {
        if (pending.current === request && useApp.getState().snapshot?.meta.root === projectRoot) {
          setFeedback({ kind: ok ? 'success' : 'error', message: ok ? '此前提交的待办已保存，当前输入已保留。' : '此前保存失败，输入已保留，请重试。' })
        }
        return
      }
      if (!ok) {
        setFeedback({ kind: 'error', message: '保存失败，输入已保留，请重试。' })
        return
      }
      if (draftRevision.current !== request.revision) {
        setFeedback({ kind: 'success', message: '待办已保存，当前修改尚未保存。' })
        return
      }
      setTitle('')
      setDesc('')
      setPriority('P2')
      setIntakeOpen(false)
      setPage('inbox')
    } catch {
      if (pending.current === request && useApp.getState().snapshot?.meta.root === projectRoot) {
        setFeedback({ kind: 'error', message: '保存结果未能确认，输入已保留。请先在待办列表确认结果，再重试。' })
      }
    } finally {
      if (request.timer) clearTimeout(request.timer)
      if (pending.current === request) {
        pending.current = null
        setBusy(false)
        setSlow(false)
      }
    }
  }

  return (
    <Modal open onClose={close} width={520} ariaLabel="新建待办" placement="center">
      <div className="flex max-h-[var(--my-modal-max-height)] flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-my-line px-5 py-3.5">
          <Sparkles size={15} className="text-my-icon-accent" />
          <span className="text-my-md font-semibold text-my-primary">新建待办</span>
          <span className="my-chip border border-my-line-warning bg-my-warning-subtle text-my-warning-text">记录需求，不启动 AI</span>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded-my-md p-1.5 text-my-icon-secondary transition-colors hover:bg-my-layer-transparent-hover hover:text-my-primary"
            title="关闭"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-5">
          <div>
            <label htmlFor={`${fieldId}-title`} className="my-item-title mb-1.5 block">需求标题 *</label>
            <input
              autoFocus
              id={`${fieldId}-title`}
              required
              value={title}
              onChange={(e) => { edited(); setTitle(e.target.value) }}
              placeholder="一句话说清要做什么，如：增加 Jira 状态映射配置"
              className="h-8 w-full rounded-my-md border border-my-line bg-my-surface-1 px-2.5 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
              onKeyDown={(e) => {
                if (e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229 || e.key !== 'Enter') return
                e.preventDefault()
                e.stopPropagation()
                void createTodo()
              }}
            />
          </div>
          <div>
            <label htmlFor={`${fieldId}-description`} className="my-item-title mb-1.5 block">需求描述</label>
            <textarea
              value={desc}
              id={`${fieldId}-description`}
              onChange={(e) => { edited(); setDesc(e.target.value) }}
              rows={6}
              placeholder="背景、验收标准、涉及模块…（AI 认领时可直接读取）"
              className="w-full resize-y rounded-my-md border border-my-line bg-my-surface-1 px-2.5 py-1.5 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
            />
          </div>
          <div>
            <label className="my-item-title mb-1.5 block">优先级</label>
            <div className="flex flex-wrap gap-1.5">
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
                  type="button"
                  aria-pressed={priority === p}
                  onClick={() => { edited(); setPriority(p) }}
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

          <div className="my-item-description rounded-my-md border border-my-line bg-my-layer-1 px-3.5 py-2.5 leading-5">
            创建后待办将保存为本地文档（.trellis/todos/*.md）。Codex / ZCode / Claude Code 可以直接读取该文件进行需求规划并转换为正式任务。
          </div>
          {busy && <div role="status" className="text-my-xs text-my-secondary">
            {slow ? '保存仍在等待结果，可继续编辑或关闭。请在待办列表确认结果后再保存，避免重复。' : '正在保存已提交的内容，可继续编辑或关闭；关闭后保存仍会继续。'}
          </div>}
          {feedback && <div role={feedback.kind === 'error' ? 'alert' : 'status'} className={clsx('text-my-xs', feedback.kind === 'error' ? 'text-my-danger-text' : 'text-my-secondary')}>{feedback.message}</div>}
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-my-line px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" className="shrink-0" disabled={!title.trim() || busy || !snapshot} onClick={() => {
              if (!snapshot || pending.current) return
              if (useKnowledgeRequest.getState().stage({ root: snapshot.meta.root, title: title.trim(), description: desc.trim(), source: { kind: 'manual' } })) close()
            }} title="携带可编辑需求进入现有 Agent；手动选择会话并发送，不创建任务">
              <Sparkles size={12} /> Agent 需求梳理
            </Button>
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => {
                if (!title.trim() || pending.current) return
                setPlanSeed({ title: title.trim(), description: desc.trim() })
              }}
              disabled={!title.trim() || busy || !snapshot}
              title="检索知识库 → AI 生成结构化任务计划（PRD/子任务/分支建议）→ 一键落成 Trellis 任务"
            >
              <Wand2 size={12} /> 兼容：一次规划
            </Button>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="my-item-description min-w-0 flex-1 truncate" title={snapshot?.meta.name}>{snapshot?.meta.name}</span>
            <Button variant="outline" className="shrink-0" onClick={close}>{busy ? '关闭' : '取消'}</Button>
            <Button variant="primary" className="shrink-0" onClick={() => void createTodo()} disabled={!title.trim() || busy || !snapshot}>
              <Save size={12} /> {busy ? '创建中…' : '仅保存待办'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
