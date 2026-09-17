import { useState } from 'react'
import { X, Sparkles, Save } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'

/**
 * 待办录入：面板只记录需求。
 * Codex / ZCode / Claude Code 后续通过 MCP 或 tpanel CLI 认领待办。
 */
export function IntakeModal(): JSX.Element | null {
  const open = useApp((s) => s.intakeOpen)
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
  const pushToast = useApp((s) => s.pushToast)
  const snapshot = useApp((s) => s.snapshot)
  const setPage = useApp((s) => s.setPage)

  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [priority, setPriority] = useState('P2')
  const [busy, setBusy] = useState(false)

  if (!open) return null

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
    const res = await api.createTask({ title: title.trim(), description: desc.trim(), priority })
    setBusy(false)
    if (!res.ok || !res.dirName) {
      pushToast({ kind: 'error', title: '待办创建失败', body: res.error })
      return
    }
    pushToast({
      kind: 'success',
      title: '待办已创建',
      body: `${res.dirName} · 等待 Codex / ZCode / Claude Code 认领`
    })
    setIntakeOpen(false)
    setTitle('')
    setDesc('')
    setPriority('P2')
    setPage('inbox')
  }

  return (
    <div className="absolute inset-0 z-50 grid animate-fade-in place-items-center bg-black/50 backdrop-blur-sm" onClick={closeOnBackdrop}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85%] w-[520px] flex-col overflow-hidden rounded-2xl border border-ink-600 bg-ink-850 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-ink-700 px-5 py-3.5">
          <Sparkles size={15} className="text-leaf" />
          <span className="text-sm font-semibold text-mist-50">新建待办</span>
          <span className="chip border border-amber-400/25 bg-amber-500/10 text-[10px] text-amber-300">记录需求，不启动 AI</span>
          <button onClick={close} className="btn-ghost ml-auto px-1.5 py-1" title="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-3.5 overflow-y-auto p-5">
          <div>
            <label className="mb-1.5 block text-[11px] text-mist-400">需求标题 *</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="一句话说清要做什么，如：增加 Jira 状态映射配置"
              className="field"
              onKeyDown={(e) => e.key === 'Enter' && void createTodo()}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] text-mist-400">需求描述</label>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={6}
              placeholder="背景、验收标准、涉及模块…（AI 认领时可直接读取）"
              className="field resize-y"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] text-mist-400">优先级</label>
            <div className="flex gap-1.5">
              {(
                [
                  ['P0', '紧急 P0', 'btn bg-rose-500/15 text-rose-300'],
                  ['P1', '高 P1', 'btn bg-orange-500/15 text-orange-300'],
                  ['P2', '中 P2', 'btn bg-ink-700/70 text-mist-200'],
                  ['P3', '低 P3', 'btn bg-ink-750 text-mist-300']
                ] as const
              ).map(([p, label, buttonClass]) => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={clsx(buttonClass, priority === p && 'ring-2 ring-leaf-dim/60')}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-ink-700 bg-ink-800/60 px-3.5 py-2.5 text-[11px] leading-5 text-mist-500">
            创建后待办会进入待处理任务和看板。已配置 MCP 的 Codex / ZCode / Claude Code 可以查询并认领它，面板不会接管已有 AI 会话。
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-ink-700 px-5 py-3">
          <span className="ml-auto text-[10.5px] text-mist-600">{snapshot?.meta.name}</span>
          <button onClick={close} className="btn-outline" disabled={busy}>取消</button>
          <button onClick={() => void createTodo()} disabled={!title.trim() || busy} className="btn-primary disabled:opacity-50">
            <Save size={12} /> {busy ? '创建中…' : '创建待办'}
          </button>
        </div>
      </div>
    </div>
  )
}
