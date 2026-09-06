import { useEffect, useState } from 'react'
import { X, Sparkles, Zap, ArrowRight, ArrowLeft, Terminal } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'

/**
 * 需求 Intake 向导（视觉化两步）：
 * 1️⃣ 写需求（标题 / 描述 / 优先级）
 * 2️⃣ 选择执行 AI（检测本机已安装的 codex / claude）
 * 提交后：任务落盘 → AI 在面板后台非交互执行（codex exec / claude -p）→
 * 进度流实时回「AI 工作台」；AI 建的文件由 watcher 自动刷进看板/收件箱。
 */
export function IntakeModal(): JSX.Element | null {
  const open = useApp((s) => s.intakeOpen)
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
  const pushToast = useApp((s) => s.pushToast)
  const snapshot = useApp((s) => s.snapshot)

  const [step, setStep] = useState<1 | 2>(1)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [priority, setPriority] = useState('P2')
  const [busy, setBusy] = useState(false)
  const [detected, setDetected] = useState<{ codex: boolean; claude: boolean } | null>(null)

  useEffect(() => {
    if (open && step === 2 && !detected) {
      void api.aiDetect().then(setDetected)
    }
  }, [open, step, detected])

  if (!open) return null

  const close = (): void => {
    setIntakeOpen(false)
    setStep(1)
    setTitle('')
    setDesc('')
    setPriority('P2')
    setDetected(null)
  }

  const closeOnBackdrop = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) close()
  }

  const buildPrompt = (dirName: string): string =>
    [
      `请处理以下新需求（已创建 Trellis 任务 ${dirName}）：`,
      ``,
      `## 标题`,
      title.trim(),
      ``,
      desc.trim() ? `## 描述\n${desc.trim()}` : '',
      ``,
      `## 要求`,
      `1. 先阅读 .trellis/workflow.md 与 .trellis/spec/ 下相关规范`,
      `2. 如需拆分子任务，在 task.json 中用 parent 字段挂到本任务下`,
      `3. 按规范完成实现与测试`,
      `4. 完成后把任务状态更新为对应阶段`
    ]
      .filter(Boolean)
      .join('\n')

  const launch = async (app: 'codex' | 'claude'): Promise<void> => {
    if (!title.trim() || busy) return
    setBusy(true)
    const created = await api.createTask({ title: title.trim(), description: desc.trim(), priority })
    if (!created.ok || !created.dirName) {
      setBusy(false)
      pushToast({ kind: 'error', title: '创建任务失败', body: created.error })
      return
    }
    const res = await api.aiLaunchRun({
      app,
      prompt: buildPrompt(created.dirName),
      label: title.trim(),
      taskDir: created.dirName
    })
    setBusy(false)
    if (res.ok && res.run) {
      useApp.getState().aiAddRun(res.run)
      pushToast({
        kind: 'success',
        title: `${app} 已在后台开始执行`,
        body: `${created.dirName} · 进度见 AI 工作台，完成后任务进收件箱`
      })
      close()
      useApp.setState({ page: 'ai' })
    } else {
      // AI 启动失败也保留任务，提示用户从任务详情重试
      pushToast({ kind: 'warn', title: `任务已创建，但 ${app} 启动失败`, body: res.error })
      close()
    }
  }

  const AI_CHOICES: Array<{ id: 'codex' | 'claude'; label: string; desc: string; accent: string }> = [
    { id: 'codex', label: 'Codex', desc: 'codex exec 非交互 · 工作区自动模式', accent: 'hover:border-sky-400/50 hover:bg-sky-500/10' },
    { id: 'claude', label: 'Claude', desc: 'claude -p 非交互 · 自动接受编辑', accent: 'hover:border-violet-400/50 hover:bg-violet-500/10' }
  ]

  return (
    <div className="absolute inset-0 z-50 grid animate-fade-in place-items-center bg-black/50 backdrop-blur-sm" onClick={closeOnBackdrop}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85%] w-[520px] flex-col overflow-hidden rounded-2xl border border-ink-600 bg-ink-850 shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center gap-2 border-b border-ink-700 px-5 py-3.5">
          <Sparkles size={15} className="text-leaf" />
          <span className="text-sm font-semibold text-mist-50">发起需求</span>
          {/* step indicator */}
          <div className="ml-3 flex items-center gap-1.5">
            {[1, 2].map((n) => (
              <span
                key={n}
                className={clsx(
                  'h-1.5 rounded-full transition-all',
                  step === n ? 'w-6 bg-leaf' : 'w-1.5 bg-ink-600'
                )}
              />
            ))}
          </div>
          <button onClick={close} className="btn-ghost ml-auto px-1.5 py-1" title="关闭">
            <X size={15} />
          </button>
        </div>

        {step === 1 ? (
          <div className="flex-1 space-y-3.5 overflow-y-auto p-5">
            <div>
              <label className="mb-1.5 block text-[11px] text-mist-400">需求标题 *</label>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="一句话说清要做什么，如：Jira 同步增加状态映射配置"
                className="field"
                onKeyDown={(e) => e.key === 'Enter' && title.trim() && setStep(2)}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] text-mist-400">需求描述</label>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={5}
                placeholder="背景、验收标准、涉及模块…（会作为任务描述注入 AI 上下文）"
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
                ).map(([p, label, cls]) => (
                  <button
                    key={p}
                    onClick={() => setPriority(p)}
                    className={clsx(cls, priority === p && 'ring-2 ring-leaf-dim/60')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5">
            <div className="mb-3 rounded-lg border border-ink-700 bg-ink-800/60 px-3.5 py-2.5">
              <div className="truncate text-xs font-medium text-mist-100">{title}</div>
              {desc && <div className="mt-1 line-clamp-2 text-[11px] text-mist-500">{desc}</div>}
            </div>
            <label className="mb-2 block text-[11px] text-mist-400">选择执行 AI（面板后台运行，进度实时可见）</label>
            <div className="space-y-2">
              {AI_CHOICES.map((a) => {
                const available = detected?.[a.id] ?? false
                const unknown = detected === null
                return (
                  <button
                    key={a.id}
                    disabled={busy || (!unknown && !available)}
                    onClick={() => void launch(a.id)}
                    className={clsx(
                      'flex w-full items-center gap-3 rounded-xl border border-ink-600 bg-ink-800 px-4 py-3 text-left transition-all',
                      available || unknown ? a.accent : 'cursor-not-allowed opacity-40',
                      busy && 'opacity-60'
                    )}
                  >
                    <Zap size={16} className="shrink-0 text-leaf" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-mist-100">{a.label}</div>
                      <div className="text-[10.5px] text-mist-500">{a.desc}</div>
                    </div>
                    {busy ? (
                      <span className="text-[11px] text-mist-400">启动中…</span>
                    ) : unknown ? (
                      <span className="text-[11px] text-mist-600">检测中…</span>
                    ) : available ? (
                      <ArrowRight size={14} className="shrink-0 text-mist-500" />
                    ) : (
                      <span className="chip border border-ink-500 text-[10px] text-mist-600">未安装</span>
                    )}
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-4 text-mist-600">
              <Terminal size={11} className="mt-0.5 shrink-0" />
              执行在面板后台进行：输出流回 AI 工作台，AI 落盘的任务/子任务自动进入看板与收件箱。
            </div>
          </div>
        )}

        {/* footer */}
        <div className="flex items-center gap-2 border-t border-ink-700 px-5 py-3">
          {step === 2 && (
            <button onClick={() => setStep(1)} className="btn-outline">
              <ArrowLeft size={12} /> 上一步
            </button>
          )}
          <span className="ml-auto text-[10.5px] text-mist-600">{snapshot?.meta.name}</span>
          {step === 1 && (
            <button onClick={() => setStep(2)} disabled={!title.trim()} className="btn-primary disabled:opacity-50">
              下一步：选 AI <ArrowRight size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
