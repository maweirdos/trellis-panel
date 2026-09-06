import { useEffect, useState } from 'react'
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
  CheckCircle2,
  Server,
  MonitorSmartphone,
  GitMerge
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'
import type { McpInfo } from '../../../shared/types'

function JiraStatusMapEditor(): JSX.Element {
  const settings = useApp((s) => s.settings)!
  const saveSettings = useApp((s) => s.saveSettings)
  const [rows, setRows] = useState<Array<[string, string]>>([])

  useEffect(() => {
    setRows(Object.entries(settings.jira.statusMap ?? {}))
  }, [settings.jira.statusMap])

  const apply = (next: Array<[string, string]>): void => {
    setRows(next)
    const map: Record<string, string> = {}
    for (const [k, v] of next) if (k.trim() && v) map[k.trim()] = v
    void saveSettings({ jira: { ...settings.jira, statusMap: map } })
  }

  return (
    <div className="space-y-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            value={k}
            onChange={(e) => {
              const next = [...rows]
              next[i] = [e.target.value, v]
              setRows(next)
            }}
            onBlur={() => apply(rows)}
            placeholder="Jira 状态名，如 待测试"
            className="field flex-1"
          />
          <span className="text-mist-500">→</span>
          <select
            value={v}
            onChange={(e) => {
              const next = [...rows]
              next[i] = [k, e.target.value]
              apply(next)
            }}
            className="field w-32"
          >
            <option value="planning">规划中</option>
            <option value="in_progress">进行中</option>
            <option value="review">评审中</option>
            <option value="completed">已完成</option>
          </select>
          <button
            onClick={() => apply(rows.filter((_, j) => j !== i))}
            className="shrink-0 text-mist-600 hover:text-rose-300"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button onClick={() => apply([...rows, ['', 'in_progress']])} className="btn-ghost">
        + 添加映射（优先于内置规则；未配置的状态按类别自动映射）
      </button>
    </div>
  )
}

export function SettingsPage(): JSX.Element {
  const settings = useApp((s) => s.settings)!
  const saveSettings = useApp((s) => s.saveSettings)
  const refresh = useApp((s) => s.refresh)
  const pushToast = useApp((s) => s.pushToast)

  const [cliDraft, setCliDraft] = useState(settings.cliCommand)
  const [jira, setJira] = useState({ ...settings.jira, password: settings.jira.passwordEncrypted ? '' : settings.jira.password })
  const [jiraTesting, setJiraTesting] = useState(false)
  const [jiraOk, setJiraOk] = useState<string | null>(null)
  const [hookMsg, setHookMsg] = useState<string | null>(null)
  const [mcpInfo, setMcpInfo] = useState<McpInfo | null>(null)
  const [shortcut, setShortcut] = useState(settings.desktop.globalShortcut)

  useEffect(() => {
    api.getMcpInfo().then(setMcpInfo)
  }, [settings.httpApi.enabled])

  const testJira = async (): Promise<void> => {
    setJiraTesting(true)
    setJiraOk(null)
    const res = await api.jiraTest({ ...jira, enabled: true })
    setJiraTesting(false)
    if (res.ok) setJiraOk(`✓ 连接成功：${res.displayName}`)
    else {
      setJiraOk(null)
      pushToast({ kind: 'error', title: 'Jira 连接失败', body: res.error })
    }
  }

  const saveJira = async (): Promise<void> => {
    await saveSettings({ jira: { ...jira, enabled: !!jira.baseUrl && !!jira.user } })
    pushToast({ kind: 'success', title: 'Jira 配置已保存' })
  }

  const [gitlab, setGitlab] = useState({
    ...settings.gitlab,
    password: settings.gitlab.passwordEncrypted ? '' : settings.gitlab.password
  })
  const [gitlabTesting, setGitlabTesting] = useState(false)
  const [gitlabOk, setGitlabOk] = useState<string | null>(null)

  const testGitlab = async (): Promise<void> => {
    setGitlabTesting(true)
    setGitlabOk(null)
    const res = await api.gitlabTest({ ...gitlab, enabled: true })
    setGitlabTesting(false)
    if (res.ok) setGitlabOk(`✓ ${res.displayName}`)
    else {
      setGitlabOk(null)
      pushToast({ kind: 'error', title: 'GitLab 连接失败', body: res.error })
    }
  }

  const saveGitlab = async (): Promise<void> => {
    await saveSettings({ gitlab: { ...gitlab, enabled: gitlab.enabled && !!gitlab.baseUrl && !!gitlab.user && !!gitlab.project } })
    pushToast({ kind: 'success', title: 'GitLab 配置已保存' })
  }

  const toggleMcp = async (on: boolean): Promise<void> => {
    const res = await api.toggleHttpApi(on)
    setMcpInfo(await api.getMcpInfo())
    if (res.ok) pushToast({ kind: 'success', title: on ? 'MCP / Web 服务已启动' : '已停止' })
    else pushToast({ kind: 'error', title: '启动失败', body: res.error })
  }

  const doInstallTpanel = async (): Promise<void> => {
    const res = await api.installTpanel()
    if (res.ok) pushToast({ kind: 'success', title: 'tpanel 命令已安装', body: `位置：${res.path}（含 MCP 桥接）` })
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

        {/* MCP / HTTP */}
        <section className="card px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
            <Server size={13} /> MCP 服务 & 只读 Web 看板
          </div>
          <p className="mb-3 text-[11px] leading-5 text-mist-500">
            启动本地 MCP 服务后，codex / zcode / claude 可以把面板当作工具服务器：
            AI 能查询任务、读取规范、更新任务状态。同时提供局域网只读 Web 看板。
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void toggleMcp(!(mcpInfo?.running ?? false))}
              className={clsx('btn', mcpInfo?.running ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25' : 'btn-primary')}
            >
              {mcpInfo?.running ? '停止服务' : '启动 MCP / Web 服务'}
            </button>
            {mcpInfo?.running && (
              <span className="chip border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                <CheckCircle2 size={11} /> 运行中 · 端口 {mcpInfo.port}
              </span>
            )}
            {mcpInfo?.webBoardUrl && (
              <button onClick={() => api.openExternal(mcpInfo.webBoardUrl!)} className="btn-outline">
                打开 Web 看板 ↗
              </button>
            )}
          </div>
          {mcpInfo?.running && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-mist-400">MCP 客户端配置（复制到 codex / claude 的 mcpServers 配置）：</div>
              {(['codex', 'claude'] as const).map((k) => (
                <div key={k} className="flex items-center gap-1.5">
                  <span className="chip w-12 shrink-0 justify-center bg-ink-750 font-mono text-mist-300">{k}</span>
                  <code className="min-w-0 flex-1 truncate rounded bg-ink-950 px-2 py-1 font-mono text-[10.5px] text-mist-400">
                    {k === 'codex' ? mcpInfo.codexConfig : mcpInfo.claudeConfig}
                  </code>
                  <button
                    onClick={async () => {
                      await api.copyToClipboard(k === 'codex' ? mcpInfo.codexConfig : mcpInfo.claudeConfig)
                      pushToast({ kind: 'success', title: '配置已复制' })
                    }}
                    className="btn-ghost shrink-0 px-1.5"
                  >
                    复制
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-mist-400">
                  <input
                    type="checkbox"
                    checked={settings.httpApi.lanAccess}
                    onChange={(e) => {
                      void saveSettings({ httpApi: { ...settings.httpApi, lanAccess: e.target.checked } }).then(() => {
                        void api.toggleHttpApi(settings.httpApi.enabled)
                      })
                    }}
                    className="accent-emerald-500"
                  />
                  允许局域网访问（0.0.0.0 监听）
                </label>
                <label className="ml-3 flex cursor-pointer items-center gap-1.5 text-[11px] text-mist-400">
                  <input
                    type="checkbox"
                    checked={settings.httpApi.webBoard}
                    onChange={(e) => void saveSettings({ httpApi: { ...settings.httpApi, webBoard: e.target.checked } })}
                    className="accent-emerald-500"
                  />
                  启用 Web 看板页
                </label>
              </div>
            </div>
          )}
        </section>

        {/* 桌面 */}
        <section className="card px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
            <MonitorSmartphone size={13} /> 桌面集成
          </div>
          <p className="mb-3 text-[11px] leading-4 text-mist-500">
            关闭窗口会最小化到托盘（托盘菜单可退出）。
          </p>
          <div className="space-y-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-mist-300">
              <input
                type="checkbox"
                checked={settings.desktop.autoStart}
                onChange={(e) => void saveSettings({ desktop: { ...settings.desktop, autoStart: e.target.checked } })}
                className="accent-emerald-500"
              />
              开机自动启动
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-mist-300">
              <input
                type="checkbox"
                checked={settings.desktop.autoUpdate}
                onChange={(e) => void saveSettings({ desktop: { ...settings.desktop, autoUpdate: e.target.checked } })}
                className="accent-emerald-500"
              />
              自动检查更新（GitHub Releases）
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-mist-300">全局唤起快捷键</span>
              <input
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
                onBlur={() => void saveSettings({ desktop: { ...settings.desktop, globalShortcut: shortcut.trim() || 'Alt+Shift+T' } })}
                className="field w-36 font-mono"
                placeholder="Alt+Shift+T"
              />
              <span className="text-[10.5px] text-mist-600">显示 / 隐藏面板，保存后重启生效</span>
            </div>
          </div>
        </section>

        {/* AI bridge */}
        <section className="card px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
            <Plug size={13} /> AI 工具桥接（codex / zcode / claude）
          </div>
          <p className="mb-3 text-[11px] leading-5 text-mist-500">
            ① 安装 <code className="rounded bg-ink-750 px-1 font-mono">tpanel</code>（notify / open / task-event / <b>mcp</b>）；
            ② 把任务事件 hooks 写入 <code className="rounded bg-ink-750 px-1 font-mono">.trellis/config.yaml</code>；
            ③ 任意程序打开 <code className="rounded bg-ink-750 px-1 font-mono">trellis-panel://open-task?dir=…&amp;t=令牌</code> 跳转任务。
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void doInstallTpanel()} className="btn-primary">
              <TerminalSquare size={12} /> 安装 / 更新 tpanel 命令
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
            Jira Server / Data Center（REST v2）。密码经系统凭据加密（DPAPI）存储。
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
              <span className="text-[11px] text-mist-400">密码 / Token {settings.jira.passwordEncrypted && <span className="text-emerald-400">（已加密保存）</span>}</span>
              <input
                type="password"
                value={jira.password}
                onChange={(e) => setJira({ ...jira, password: e.target.value })}
                placeholder={settings.jira.passwordEncrypted ? '••••••••（输入新值覆盖）' : ''}
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
            <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-mist-400">
              <input
                type="checkbox"
                checked={jira.autoSync}
                onChange={(e) => {
                  setJira({ ...jira, autoSync: e.target.checked })
                  void saveSettings({ jira: { ...jira, autoSync: e.target.checked, enabled: !!jira.baseUrl && !!jira.user } })
                }}
                className="accent-emerald-500"
              />
              每 10 分钟自动同步关联任务状态
            </label>
            {jiraOk && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-300">
                <CheckCircle2 size={12} /> {jiraOk}
              </span>
            )}
          </div>

          <div className="mt-4 border-t border-ink-700 pt-3">
            <div className="mb-2 text-[11px] font-semibold text-mist-300">状态映射（Jira 状态名 → Trellis 状态）</div>
            <JiraStatusMapEditor />
          </div>
        </section>

        {/* GitLab connector */}
        <section className="card px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
            <GitMerge size={13} /> GitLab 集成
            <label className="ml-3 flex cursor-pointer items-center gap-1.5 text-[11px] font-normal text-mist-400">
              <input
                type="checkbox"
                checked={gitlab.enabled}
                onChange={(e) => setGitlab({ ...gitlab, enabled: e.target.checked })}
                className="accent-emerald-500"
              />
              启用（任务卡显示 MR / 构建状态）
            </label>
          </div>
          <p className="mb-3 text-[11px] leading-5 text-mist-500">
            自建 GitLab（OAuth 密码模式自动换 token）。关联分支的任务会显示 MR 与流水线状态，可一键创建 MR。密码经系统凭据加密（DPAPI）存储。
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="col-span-2 space-y-1">
              <span className="text-[11px] text-mist-400">GitLab 地址</span>
              <input
                value={gitlab.baseUrl}
                onChange={(e) => setGitlab({ ...gitlab, baseUrl: e.target.value })}
                placeholder="http://192.168.1.202:8929"
                className="field font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-mist-400">账号</span>
              <input
                value={gitlab.user}
                onChange={(e) => setGitlab({ ...gitlab, user: e.target.value })}
                placeholder="1786487276@qq.com"
                className="field"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-mist-400">密码 {settings.gitlab.passwordEncrypted && <span className="text-emerald-400">（已加密保存）</span>}</span>
              <input
                type="password"
                value={gitlab.password}
                onChange={(e) => setGitlab({ ...gitlab, password: e.target.value })}
                placeholder={settings.gitlab.passwordEncrypted ? '••••••••（输入新值覆盖）' : ''}
                className="field"
              />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-[11px] text-mist-400">项目路径（含命名空间，任务分支将在此项目下匹配 MR / 流水线）</span>
              <input
                value={gitlab.project}
                onChange={(e) => setGitlab({ ...gitlab, project: e.target.value })}
                placeholder="huachuang/honsky-lis"
                className="field font-mono"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => void testGitlab()} disabled={gitlabTesting || !gitlab.baseUrl || !gitlab.user} className="btn-outline disabled:opacity-50">
              {gitlabTesting ? '测试中…' : '测试连接'}
            </button>
            <button onClick={() => void saveGitlab()} className="btn-primary">保存配置</button>
            {gitlabOk && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-300">
                <CheckCircle2 size={12} /> {gitlabOk}
              </span>
            )}
          </div>
        </section>

        {/* theme + cli */}
        <section className="card px-5 py-4">
          <div className="mb-3 text-xs font-semibold text-mist-200">外观与 CLI</div>
          <div className="mb-3 flex gap-2">
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
          <div className="flex gap-2">
            <input value={cliDraft} onChange={(e) => setCliDraft(e.target.value)} className="field flex-1 font-mono" />
            <button
              onClick={() => void saveSettings({ cliCommand: cliDraft.trim() || 'trellis' })}
              className="btn-primary"
            >
              <Terminal size={12} /> 保存 CLI 命令
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
              <div key={r} className="group flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist-300">{r}</span>
                <button
                  onClick={() => void saveSettings({ recentProjects: settings.recentProjects.filter((x) => x !== r) })}
                  className="shrink-0 text-mist-600 opacity-0 transition-opacity hover:text-rose-300 group-hover:opacity-100"
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
            <span className="text-right text-mist-200">v0.3.0（Electron + React）</span>
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
