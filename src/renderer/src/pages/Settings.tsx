import { useState } from 'react'
import {
  Moon,
  Sun,
  Terminal,
  FolderOpen,
  X,
  Leaf,
  Link2,
  Plug,
  TerminalSquare,
  CheckCircle2
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'

export function SettingsPage(): JSX.Element {
  const settings = useApp((s) => s.settings)!
  const saveSettings = useApp((s) => s.saveSettings)
  const refresh = useApp((s) => s.refresh)
  const pushToast = useApp((s) => s.pushToast)

  const [cliDraft, setCliDraft] = useState(settings.cliCommand)
  const [jira, setJira] = useState({ ...settings.jira })
  const [jiraTesting, setJiraTesting] = useState(false)
  const [jiraOk, setJiraOk] = useState<string | null>(null)
  const [hookMsg, setHookMsg] = useState<string | null>(null)

  const testJira = async (): Promise<void> => {
    setJiraTesting(true)
    setJiraOk(null)
    const res = await api.jiraTest({ ...jira, enabled: true })
    setJiraTesting(false)
    if (res.ok) {
      setJiraOk(`✓ 连接成功：${res.displayName}`)
    } else {
      setJiraOk(null)
      pushToast({ kind: 'error', title: 'Jira 连接失败', body: res.error })
    }
  }

  const saveJira = async (): Promise<void> => {
    await saveSettings({ jira: { ...jira, enabled: !!jira.baseUrl && !!jira.user } })
    pushToast({ kind: 'success', title: 'Jira 配置已保存', body: jira.enabled ? '「Jira 任务」页面已可用' : '已保存（未启用）' })
  }

  const doInstallTpanel = async (): Promise<void> => {
    const res = await api.installTpanel()
    if (res.ok) pushToast({ kind: 'success', title: 'tpanel 命令已安装', body: `位置：${res.path}` })
    else pushToast({ kind: 'error', title: '安装 tpanel 失败', body: res.error })
  }

  const doInstallHooks = async (): Promise<void> => {
    const res = await api.installTrellisHooks()
    setHookMsg(res.message ?? res.error ?? null)
    if (res.ok) pushToast({ kind: 'success', title: 'Trellis hooks 已配置', body: res.message })
    else pushToast({ kind: 'error', title: '写入 hooks 失败', body: res.error })
  }

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
            「CLI 终端」页面使用的命令。默认 <code className="rounded bg-ink-750 px-1 font-mono">trellis</code>（需在 PATH 中）
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

        {/* AI bridge */}
        <section className="card px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
            <Plug size={13} /> AI 工具桥接（codex / zcode / claude）
          </div>
          <p className="mb-3 text-[11px] leading-5 text-mist-500">
            让 AI 工具在任务生命周期中实时调起面板：
            <br />① 安装 <code className="rounded bg-ink-750 px-1 font-mono">tpanel</code> 命令（notify / open / task-event）；
            <br />② 把任务事件 hooks 写入 <code className="rounded bg-ink-750 px-1 font-mono">.trellis/config.yaml</code>，AI 每次创建/开始/完成/归档任务都会推送通知；
            <br />③ 任何程序都可以打开 <code className="rounded bg-ink-750 px-1 font-mono">trellis-panel://open-task?dir=…</code> 直接跳转到对应任务。
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void doInstallTpanel()} className="btn-primary">
              <TerminalSquare size={12} /> 安装 tpanel 命令
            </button>
            <button onClick={() => void doInstallHooks()} className="btn-outline">
              <Plug size={12} /> 写入 Trellis 任务 hooks
            </button>
          </div>
          {hookMsg && <div className="mt-2 text-[11px] text-mist-400">{hookMsg}</div>}
        </section>

        {/* Jira */}
        <section className="card px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
            <Link2 size={13} /> Jira 集成
          </div>
          <p className="mb-3 text-[11px] leading-5 text-mist-500">
            连接 Jira Server / Data Center（REST API v2）。支持把 Jira 待办导入为 Trellis 任务、
            按状态类别双向同步进度、把 Trellis 进度回写为 Jira 评论。
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="col-span-2 space-y-1">
              <span className="text-[11px] text-mist-400">服务器地址</span>
              <input
                value={jira.baseUrl}
                onChange={(e) => setJira({ ...jira, baseUrl: e.target.value })}
                placeholder="http://192.168.1.202:8083"
                className="field font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-mist-400">用户名</span>
              <input value={jira.user} onChange={(e) => setJira({ ...jira, user: e.target.value })} className="field" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-mist-400">密码 / Token</span>
              <input
                type="password"
                value={jira.password}
                onChange={(e) => setJira({ ...jira, password: e.target.value })}
                className="field"
              />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-[11px] text-mist-400">默认 JQL（留空 = assignee = currentUser()）</span>
              <input
                value={jira.jql}
                onChange={(e) => setJira({ ...jira, jql: e.target.value })}
                placeholder="project = XXX AND status != 完成 ORDER BY updated DESC"
                className="field font-mono"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => void testJira()} disabled={jiraTesting || !jira.baseUrl} className="btn-outline disabled:opacity-50">
              {jiraTesting ? '测试中…' : '测试连接'}
            </button>
            <button onClick={() => void saveJira()} className="btn-primary">保存配置</button>
            {jiraOk && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-300">
                <CheckCircle2 size={12} /> {jiraOk}
              </span>
            )}
          </div>
          <p className="mt-2 text-[10.5px] leading-4 text-mist-600">
            注意：凭据保存在本机设置文件（userData/settings.json）中，请勿将设置文件提交到仓库。
          </p>
        </section>

        {/* recents */}
        <section className="card px-5 py-4">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
            <FolderOpen size={13} /> 最近项目
          </div>
          {settings.recentProjects.length === 0 && <div className="text-[11px] text-mist-500">暂无记录</div>}
          <div className="space-y-1">
            {settings.recentProjects.map((r) => (
              <div key={r} className="group flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist-300">{r}</span>
                <button
                  onClick={() => void saveSettings({ recentProjects: settings.recentProjects.filter((x) => x !== r) })}
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
            <span className="text-right text-mist-200">v0.2.0（Electron + React）</span>
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
