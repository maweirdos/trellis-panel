import { Leaf, FolderOpen, Clock, ArrowRight } from 'lucide-react'
import { useApp } from '../store'

export function Onboarding(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const openError = useApp((s) => s.openError)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const openProjectPath = useApp((s) => s.openProjectPath)

  const recents = settings?.recentProjects ?? []

  return (
    <div className="flex h-full items-center justify-center bg-ink-900 p-8">
      <div className="w-full max-w-xl animate-fade-in">
        <div className="mb-9 text-center">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl border border-leaf-dim/30 bg-leaf-deep/40 shadow-[0_0_44px_-6px] shadow-leaf-dim/40">
            <Leaf size={30} className="text-leaf" strokeWidth={2.2} />
          </div>
          <h1 className="text-xl font-semibold text-mist-50">Trellis Panel</h1>
          <p className="mt-1.5 text-[13px] text-mist-400">
            可视化管理你的 Trellis 工作流 — 任务、规范、工作区与 AI 会话
          </p>
        </div>

        <button
          onClick={pickAndOpen}
          className="btn-primary mx-auto flex px-5 py-2.5 text-[13px] shadow-lg shadow-leaf-dim/20"
        >
          <FolderOpen size={15} /> 打开 Trellis 项目
        </button>

        {openError && (
          <p className="mx-auto mt-3 w-fit rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300">
            {openError}
          </p>
        )}

        {recents.length > 0 && (
          <div className="mt-9">
            <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-mist-400">
              <Clock size={12} /> 最近项目
            </div>
            <div className="space-y-1">
              {recents.slice(0, 5).map((r) => (
                <button
                  key={r}
                  onClick={() => openProjectPath(r)}
                  className="group flex w-full items-center gap-2.5 rounded-lg border border-ink-700 bg-ink-800/70 px-3.5 py-2.5 text-left transition-colors hover:border-leaf-dim/40 hover:bg-ink-800"
                >
                  <FolderOpen size={14} className="shrink-0 text-mist-400 group-hover:text-leaf" />
                  <span className="min-w-0 flex-1 truncate text-xs text-mist-200">{r}</span>
                  <ArrowRight
                    size={13}
                    className="shrink-0 text-mist-500 opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-9 grid grid-cols-3 gap-2.5 text-center text-[11px] leading-4 text-mist-400">
          <div className="card px-3 py-2.5">任务看板<br />状态拖拽 · 产物预览</div>
          <div className="card px-3 py-2.5">规范文档<br />Spec 树 · Markdown 渲染</div>
          <div className="card px-3 py-2.5">实时同步<br />文件监听 · 自动刷新</div>
        </div>

        <p className="mt-6 text-center text-[11px] text-mist-500">
          尚未安装 Trellis？在项目目录运行 <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10.5px] text-leaf-soft/90">npm i -g @mindfoldhq/trellis</code> 后执行 <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10.5px] text-leaf-soft/90">trellis init</code>
        </p>
      </div>
    </div>
  )
}
