import { Leaf, FolderOpen, Clock, ArrowRight } from 'lucide-react'
import { useApp } from '../store'
import { Button } from '../my/ui'

export function Onboarding(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const openError = useApp((s) => s.openError)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const openProjectPath = useApp((s) => s.openProjectPath)

  const recents = settings?.recentProjects ?? []

  return (
    <div className="flex h-full items-center justify-center bg-my-canvas p-8">
      <div className="w-full max-w-xl animate-fade-in">
        <div className="mb-9 text-center">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-my-xl border border-my-line-accent-subtle bg-my-accent-subtle shadow-[0_0_44px_-6px_var(--my-border-accent-subtle)]">
            <Leaf size={30} className="text-my-icon-accent" strokeWidth={2.2} />
          </div>
          <h1 className="text-my-xl font-semibold text-my-primary">Trellis Panel</h1>
          <p className="mt-1.5 text-my-md text-my-secondary">
            可视化管理你的 Trellis 工作流 — 任务、规范、工作区与 AI 会话
          </p>
        </div>

        <div className="flex justify-center">
          <Button variant="primary" size="lg" onClick={pickAndOpen} className="px-5 shadow-[0_8px_24px_-8px_var(--my-border-accent-subtle)]">
            <FolderOpen size={15} /> 打开 Trellis 项目
          </Button>
        </div>

        {openError && (
          <p className="mx-auto mt-3 w-fit rounded-my-md border border-my-line-danger bg-my-danger-subtle px-3 py-1.5 text-my-xs text-my-danger-text">
            {openError}
          </p>
        )}

        {recents.length > 0 && (
          <div className="mt-9">
            <div className="mb-2 flex items-center gap-1.5 px-1 text-my-xs font-medium uppercase tracking-wider text-my-secondary">
              <Clock size={12} /> 最近项目
            </div>
            <div className="space-y-1">
              {recents.slice(0, 5).map((r) => (
                <button
                  key={r}
                  onClick={() => openProjectPath(r)}
                  className="group flex w-full items-center gap-2.5 rounded-my-md border border-my-line bg-my-layer-1 px-3.5 py-2.5 text-left transition-colors hover:border-my-line-accent-subtle hover:bg-my-layer-1-hover"
                >
                  <FolderOpen size={14} className="shrink-0 text-my-icon-secondary group-hover:text-my-icon-accent" />
                  <span className="min-w-0 flex-1 truncate text-my-xs text-my-primary">{r}</span>
                  <ArrowRight
                    size={13}
                    className="shrink-0 text-my-tertiary opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-9 grid grid-cols-3 gap-2.5 text-center text-my-xs leading-4 text-my-secondary">
          <div className="rounded-my-lg border border-my-line bg-my-layer-2 px-3 py-2.5 shadow-[var(--my-shadow-raised-200)]">任务看板<br />状态拖拽 · 产物预览</div>
          <div className="rounded-my-lg border border-my-line bg-my-layer-2 px-3 py-2.5 shadow-[var(--my-shadow-raised-200)]">规范文档<br />Spec 树 · Markdown 渲染</div>
          <div className="rounded-my-lg border border-my-line bg-my-layer-2 px-3 py-2.5 shadow-[var(--my-shadow-raised-200)]">实时同步<br />文件监听 · 自动刷新</div>
        </div>

        <p className="mt-6 text-center text-my-xs text-my-tertiary">
          尚未安装 Trellis？在项目目录运行 <code className="rounded-my-sm bg-my-layer-2 px-1.5 py-0.5 font-mono text-my-2xs text-my-accent-text">npm i -g @mindfoldhq/trellis</code> 后执行 <code className="rounded-my-sm bg-my-layer-2 px-1.5 py-0.5 font-mono text-my-2xs text-my-accent-text">trellis init</code>
        </p>
      </div>
    </div>
  )
}
