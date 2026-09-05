import { useState } from 'react'
import { Moon, Sun, Terminal, FolderOpen, X, Leaf } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'

export function SettingsPage(): JSX.Element {
  const settings = useApp((s) => s.settings)!
  const saveSettings = useApp((s) => s.saveSettings)
  const refresh = useApp((s) => s.refresh)
  const [cliDraft, setCliDraft] = useState(settings.cliCommand)

  return (
    <div className="h-full animate-fade-in overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="mb-1 text-base font-semibold text-mist-50">设置</h1>

        {/* theme */}
        <section className="card px-5 py-4">
          <div className="mb-3 text-xs font-semibold text-mist-200">外观</div>
          <div className="flex gap-2">
            {(
              [
                ['dark', '深色', <Moon size={14} key="d" />],
                ['light', '浅色', <Sun size={14} key="l" />]
              ] as const
            ).map(([v, label, icon]) => (
              <button
                key={v}
                onClick={() => void saveSettings({ theme: v })}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-xs transition-colors',
                  settings.theme === v
                    ? 'border-leaf-dim/50 bg-leaf-dim/10 text-leaf-soft'
                    : 'border-ink-500 text-mist-300 hover:border-ink-400'
                )}
              >
                {icon} {label}
              </button>
            ))}
          </div>
        </section>

        {/* cli */}
        <section className="card px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
            <Terminal size={13} /> Trellis CLI 命令
          </div>
          <p className="mb-3 text-[11px] leading-4 text-mist-500">
            「CLI 终端」页面使用的命令。默认 <code className="rounded bg-ink-750 px-1 font-mono">trellis</code>（需在 PATH 中）；
            也可指定完整路径，如 <code className="rounded bg-ink-750 px-1 font-mono">npx @mindfoldhq/trellis</code>
          </p>
          <div className="flex gap-2">
            <input value={cliDraft} onChange={(e) => setCliDraft(e.target.value)} className="field flex-1 font-mono" />
            <button
              onClick={() => void saveSettings({ cliCommand: cliDraft.trim() || 'trellis' })}
              className="btn-primary"
            >
              保存
            </button>
          </div>
        </section>

        {/* recents */}
        <section className="card px-5 py-4">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
            <FolderOpen size={13} /> 最近项目
          </div>
          {settings.recentProjects.length === 0 && <div className="text-[11px] text-mist-500">暂无记录</div>}
          <div className="space-y-1">
            {settings.recentProjects.map((r) => (
              <div
                key={r}
                className="group flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist-300">{r}</span>
                <button
                  onClick={() =>
                    void saveSettings({ recentProjects: settings.recentProjects.filter((x) => x !== r) })
                  }
                  className="shrink-0 text-mist-600 opacity-0 transition-opacity hover:text-rose-300 group-hover:opacity-100"
                  title="移除记录"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* about */}
        <section className="card px-5 py-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-mist-200">
            <Leaf size={13} className="text-leaf" /> 关于
          </div>
          <div className="grid grid-cols-2 gap-y-1.5 text-[11px] text-mist-400">
            <span>Trellis Panel</span>
            <span className="text-right text-mist-200">v0.1.0（Electron + React）</span>
            <span>数据格式</span>
            <span className="text-right text-mist-200">@mindfoldhq/trellis task.json 标准 Schema</span>
            <span>官方文档</span>
            <button
              onClick={() => api.openExternal('https://docs.trytrellis.app/zh/start/install-and-first-task')}
              className="text-right text-leaf-soft/90 hover:text-leaf-soft"
            >
              docs.trytrellis.app ↗
            </button>
          </div>
          <button onClick={() => void refresh()} className="btn-outline mt-3">
            重新扫描当前项目
          </button>
        </section>
      </div>
    </div>
  )
}
