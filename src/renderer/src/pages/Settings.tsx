import { useEffect, useRef, useState } from 'react'
import {
  Moon,
  Sun,
  Terminal,
  FolderOpen,
  X,
  Link2,
  Plug,
  TerminalSquare,
  CheckCircle2,
  Server,
  MonitorSmartphone,
  GitMerge,
  Sparkles,
  BrainCircuit,
  Cloud,
  KeyRound,
  Bot
} from 'lucide-react'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { api, hasIpc } from '../api'
import { clsx } from 'clsx'
import { Button, Checkbox, EmptyState } from '../my/ui'
import { RuntimePanel } from '../acp/RuntimePanel'
import { Select } from '../components/Select'
import { AppearancePreferences } from '../my/AppearancePreferences'
import { BrandMark } from '../my/BrandMark'
import type { JSX } from 'react'
import type { AcpAgentConfig, AcpAgentStatus, KbMcpInstallResult, KbMcpStatus, McpInfo, Settings, WeknoraConfig, WeknoraKbSummary } from '../../../shared/types'
import { WEKNORA_DEFAULTS } from '../../../shared/types'

function JiraStatusMapEditor({ settings }: { settings: Settings }): JSX.Element {
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
            className="my-input flex-1"
          />
          <span className="text-my-tertiary">→</span>
          <select
            value={v}
            onChange={(e) => {
              const next = [...rows]
              next[i] = [k, e.target.value]
              apply(next)
            }}
            className="my-input !w-32"
          >
            <option value="planning">规划中</option>
            <option value="in_progress">进行中</option>
            <option value="review">评审中</option>
            <option value="completed">已完成</option>
          </select>
          <button
            type="button"
            onClick={() => apply(rows.filter((_, j) => j !== i))}
            className="shrink-0 text-my-placeholder hover:text-my-danger-text"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <Button variant="ghost" onClick={() => apply([...rows, ['', 'in_progress']])}>
        + 添加映射（优先于内置规则；未配置的状态按类别自动映射）
      </Button>
    </div>
  )
}

export function SettingsPage(): JSX.Element {
  const settingsView = useMy((state) => state.settingsView)
  const settings = useApp((s) => s.settings)
  // 浏览器预览（?my=1）无 IPC 桥、settings 恒为 null：渲染空态而非在渲染期解引用崩溃（真机 bootstrap 后恒非空）
  if (!settings) return (
    <div className="space-y-4">
      <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
        <AppearancePreferences />
      </section>
      <EmptyState title="设置未加载" description="连接桌面应用后可查看其余设置。" />
    </div>
  )
  return settingsView === 'engines' ? <AcpAgentsSection /> : <SettingsPageBody settings={settings} />
}

function SettingsPageBody({ settings }: { settings: Settings }): JSX.Element {
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
  const [dispatchModel, setDispatchModel] = useState(settings.dispatch?.codexModel ?? '')
  const [quickShortcut, setQuickShortcut] = useState(settings.desktop.quickTodoShortcut)
  const [accessInfo, setAccessInfo] = useState<{
    enabled: boolean
    running: boolean
    port: number | null
    endpoint: string | null
    token: string
  } | null>(null)

  useEffect(() => {
    if (!hasIpc) return
    api.getMcpInfo().then(setMcpInfo)
  }, [settings.httpApi.enabled])

  const refreshAccess = (): void => {
    void api.accessStatus().then(setAccessInfo)
  }

  useEffect(() => {
    if (!hasIpc) return
    refreshAccess()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.access?.enabled, settings.access?.port])

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

  /* ---- 知识库 MCP ---- */
  const [mcpKbStatus, setMcpKbStatus] = useState<KbMcpStatus | null>(null)
  const [mcpKbResult, setMcpKbResult] = useState<KbMcpInstallResult | null>(null)

  useEffect(() => {
    if (!hasIpc) return
    void api.kbMcpStatus().then(setMcpKbStatus)
  }, [])

  const installKbMcp = async (): Promise<void> => {
    const res = await api.kbMcpInstall()
    setMcpKbResult(res)
    setMcpKbStatus(await api.kbMcpStatus())
    if (res.ok) pushToast({ kind: 'success', title: '知识库 MCP 已安装', body: 'AI 工具重启会话后生效' })
    else pushToast({ kind: 'error', title: '安装失败', body: res.error })
  }

  /* ---- AI 模型（baseUrl 自定义） ---- */
  const [ai, setAi] = useState({ ...settings.ai, apiKey: settings.ai.apiKeyEncrypted ? '' : settings.ai.apiKey })
  const [aiTesting, setAiTesting] = useState(false)
  const [aiOk, setAiOk] = useState<string | null>(null)

  const testAi = async (): Promise<void> => {
    setAiTesting(true)
    setAiOk(null)
    const res = await api.aiTest({ ...ai, enabled: true })
    setAiTesting(false)
    if (res.ok) setAiOk(`✓ ${res.model ?? ai.model} 已连通`)
    else {
      setAiOk(null)
      pushToast({ kind: 'error', title: 'AI 连接失败', body: res.error })
    }
  }

  const saveAi = async (): Promise<void> => {
    await saveSettings({ ai: { ...ai, enabled: ai.enabled && !!ai.baseUrl && !!ai.model } })
    pushToast({ kind: 'success', title: 'AI 模型配置已保存' })
  }

  /* ---- WeKnora 公司库联动 ---- */
  const [wk, setWk] = useState<WeknoraConfig>(() => {
    const saved = settings.weknora ?? WEKNORA_DEFAULTS
    return {
      ...WEKNORA_DEFAULTS,
      ...saved,
      apiKey: saved.apiKeyEncrypted ? '' : saved.apiKey,
      mcpToken: saved.mcpTokenEncrypted ? '' : saved.mcpToken
    }
  })
  const [wkTesting, setWkTesting] = useState(false)
  const [wkKbs, setWkKbs] = useState<WeknoraKbSummary[] | null>(null)
  const [wkOk, setWkOk] = useState<string | null>(null)
  const [wkMcpTesting, setWkMcpTesting] = useState(false)
  const [wkMcpOk, setWkMcpOk] = useState<string | null>(null)

  const testWeknora = async (): Promise<void> => {
    setWkTesting(true)
    setWkOk(null)
    const res = await api.weknoraTest({ ...wk, enabled: true })
    setWkTesting(false)
    if (res.ok) {
      setWkKbs(res.kbs ?? [])
      setWkOk(`✓ 连接成功：${res.kbs?.length ?? 0} 个知识库`)
    } else {
      setWkKbs(null)
      pushToast({ kind: 'error', title: 'WeKnora 连接失败', body: res.error })
    }
  }

  const saveWeknora = async (): Promise<void> => {
    const patch: WeknoraConfig = {
      ...wk,
      enabled: wk.enabled && !!wk.baseUrl,
      searchKbIds: wk.searchKbIds.filter(Boolean)
    }
    await saveSettings({ weknora: patch })
    pushToast({ kind: 'success', title: 'WeKnora 配置已保存' })
  }

  const testWeknoraMcp = async (): Promise<void> => {
    setWkMcpTesting(true)
    setWkMcpOk(null)
    const res = await api.weknoraTestMcp(wk.mcpUrl, wk.mcpToken)
    setWkMcpTesting(false)
    if (res.ok) setWkMcpOk('✓ MCP 端点握手成功')
    else pushToast({ kind: 'error', title: 'MCP 端点测试失败', body: res.error })
  }

  /** 远程 MCP 注册片段；令牌未知（已加密保存未重输）时用占位符 */
  const mcpTokenForSnippet = (): string => wk.mcpToken || '<TOKEN>'
  const mcpSnippets = (): { claude: string; codex: string; zcode: string } => {
    const token = mcpTokenForSnippet()
    const url = wk.mcpUrl || '<MCP_URL>'
    return {
      claude: JSON.stringify({ mcpServers: { weknora: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      codex: `# ~/.codex/config.toml\n[mcp_servers.weknora]\nurl = '${url}'\nhttp_headers = { "Authorization" = "Bearer ${token}" }`,
      zcode: `zcode mcp add weknora --url ${url} --header "Authorization: Bearer ${token}"`
    }
  }

  const copySnip = (text: string, title: string): void => {
    void api.copyToClipboard(text)
    pushToast({ kind: 'success', title, body: text.includes('<TOKEN>') ? '令牌为占位符——请先在上方输入端点令牌' : undefined })
  }

  const toggleSearchKb = (id: string): void => {
    setWk((c) => ({
      ...c,
      searchKbIds: c.searchKbIds.includes(id) ? c.searchKbIds.filter((x) => x !== id) : [...c.searchKbIds, id]
    }))
  }

  const toggleMcp = async (on: boolean): Promise<void> => {
    const res = await api.toggleHttpApi(on)
    setMcpInfo(await api.getMcpInfo())
    if (res.ok) pushToast({ kind: 'success', title: on ? 'Web 看板服务已启动' : '已停止' })
    else pushToast({ kind: 'error', title: '启动失败', body: res.error })
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

  /* ---- TPAP 本地接入协议 ---- */
  const toggleAccess = (on: boolean): void => {
    void saveSettings({ access: { ...(settings.access ?? { enabled: false, port: 39580 }), enabled: on, port: settings.access?.port ?? 39580 } }).then(
      () => setTimeout(refreshAccess, 300)
    )
  }

  const rotateAccess = async (): Promise<void> => {
    await api.accessRotateToken()
    refreshAccess()
    pushToast({ kind: 'success', title: 'Token 已重置', body: '外部工具需更新为新的 token' })
  }

  return (
    <div className="my-fade">
      <div className="space-y-4">
        {/* Web 看板 HTTP 服务 */}

        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-my-xs font-semibold text-my-secondary">
            <Server size={13} /> Web 看板服务
          </div>
          <p className="mb-3 text-my-xs leading-5 text-my-tertiary">
            启动本地 HTTP 服务后，可在浏览器打开只读任务看板（每 30 秒自动刷新），
            也可开放给局域网内其他成员查看。
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void toggleMcp(!(mcpInfo?.running ?? false))}
              className={clsx(
                'my-control',
                mcpInfo?.running ? 'bg-my-danger-subtle text-my-danger-text hover:bg-my-danger-subtle-hover' : 'bg-my-accent text-my-on-accent hover:bg-my-accent-hover'
              )}
            >
              {mcpInfo?.running ? '停止服务' : '启动 Web 看板'}
            </button>
            {mcpInfo?.running && (
              <span className="my-chip border border-my-line-success bg-my-success-subtle text-my-success-text">
                <CheckCircle2 size={11} /> 运行中 · 端口 {mcpInfo.port}
              </span>
            )}
            {mcpInfo?.webBoardUrl && (
              <Button
                variant="outline"
                onClick={() => {
                  const url = mcpInfo?.webBoardUrl
                  if (url) api.openExternal(url)
                }}
              >
                打开 Web 看板 ↗
              </Button>
            )}
          </div>
          {mcpInfo?.running && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 pt-1">
                <label className="flex cursor-pointer items-center gap-1.5 text-my-xs text-my-tertiary">
                  <Checkbox
                    checked={settings.httpApi.lanAccess}
                    onChange={(v) => {
                      void saveSettings({ httpApi: { ...settings.httpApi, lanAccess: v } }).then(() => {
                        void api.toggleHttpApi(settings.httpApi.enabled)
                      })
                    }}
                  />
                  允许局域网访问（0.0.0.0 监听）
                </label>
                <label className="ml-3 flex cursor-pointer items-center gap-1.5 text-my-xs text-my-tertiary">
                  <Checkbox
                    checked={settings.httpApi.webBoard}
                    onChange={(v) => void saveSettings({ httpApi: { ...settings.httpApi, webBoard: v } })}
                  />
                  启用 Web 看板页
                </label>
              </div>
            </div>
          )}
        </section>

        {/* TPAP 本地接入协议 */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-my-xs font-semibold text-my-secondary">
            <KeyRound size={13} /> 本地接入协议（TPAP）
          </div>
          <p className="mb-3 text-my-xs leading-5 text-my-tertiary">
            供外部 AI 工具经 <code className="font-mono">127.0.0.1</code> 读取任务状态、检索知识与调用网关工具。
            恒定仅绑定本机环回，凭 Bearer token 鉴权；变更类操作需显式 confirm，支持幂等重试。
            默认关闭。协议详见 <code className="font-mono">docs/access-protocol.md</code>。
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => toggleAccess(!(settings.access?.enabled ?? false))}
              className={clsx(
                'my-control',
                settings.access?.enabled ? 'bg-my-danger-subtle text-my-danger-text hover:bg-my-danger-subtle-hover' : 'bg-my-accent text-my-on-accent hover:bg-my-accent-hover'
              )}
            >
              {settings.access?.enabled ? '停止接入服务' : '启动接入服务'}
            </button>
            {accessInfo?.running && (
              <span className="my-chip border border-my-line-success bg-my-success-subtle text-my-success-text">
                <CheckCircle2 size={11} /> 运行中 · 端口 {accessInfo.port}
              </span>
            )}
          </div>
          {accessInfo?.running && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-my-xs text-my-tertiary">端点</span>
                <code className="truncate rounded-my-sm bg-my-layer-1 px-2 py-0.5 font-mono text-my-xs text-my-secondary">{accessInfo.endpoint}</code>
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => void api.copyToClipboard(`${accessInfo.endpoint}（Authorization: Bearer ${accessInfo.token}）`)}>
                  复制
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-my-xs text-my-tertiary">Token</span>
                <code className="truncate rounded-my-sm bg-my-layer-1 px-2 py-0.5 font-mono text-my-xs text-my-secondary">{accessInfo.token}</code>
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => void api.copyToClipboard(accessInfo.token)}>
                  复制
                </Button>
                <Button variant="ghost" size="sm" className="shrink-0 text-my-warning-text" onClick={() => void rotateAccess()}>
                  重置
                </Button>
              </div>
            </div>
          )}
        </section>

        {/* 网络代理 */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-my-xs font-semibold text-my-secondary">
            <Cloud size={13} /> 网络代理
          </div>
          <p className="mb-3 text-my-xs leading-5 text-my-tertiary">
            统一覆盖应用内 AI（对话/模型目录）与知识库（WeKnora）的出网请求。
            支持 <code className="font-mono">http://</code>、<code className="font-mono">socks5://</code> 形式，
            例如 <code className="font-mono">http://127.0.0.1:7890</code> 或 <code className="font-mono">socks5://127.0.0.1:1080</code>。
          </p>
          <div className="space-y-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-my-xs text-my-secondary">
              <Checkbox
                checked={settings.proxy?.enabled ?? false}
                onChange={(v) =>
                  void saveSettings({
                    proxy: { enabled: v, url: settings.proxy?.url ?? '' }
                  })
                }
              />
              启用出网代理
            </label>
            <div className="flex items-center gap-2">
              <input
                value={settings.proxy?.url ?? ''}
                onChange={(e) => void saveSettings({ proxy: { enabled: settings.proxy?.enabled ?? false, url: e.target.value } })}
                placeholder="http://127.0.0.1:7890"
                className="my-input flex-1 font-mono"
              />
            </div>
          </div>
        </section>

        {/* 桌面 */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-my-xs font-semibold text-my-secondary">
            <MonitorSmartphone size={13} /> 桌面集成
          </div>
          <p className="mb-3 text-my-xs leading-4 text-my-tertiary">
            关闭窗口会最小化到托盘（托盘菜单可退出）。
          </p>
          <div className="space-y-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-my-xs text-my-secondary">
              <Checkbox
                checked={settings.desktop.autoStart}
                onChange={(v) => void saveSettings({ desktop: { ...settings.desktop, autoStart: v } })}
              />
              开机自动启动
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-my-xs text-my-secondary">
              <Checkbox
                checked={settings.desktop.autoUpdate}
                onChange={(v) => void saveSettings({ desktop: { ...settings.desktop, autoUpdate: v } })}
              />
              自动检查更新（GitHub Releases）
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-my-xs text-my-secondary">
              <Checkbox
                checked={settings.desktop.explorerContextMenu ?? false}
                onChange={async (v) => {
                  const res = await api.desktopSetExplorerMenu(v)
                  if (res.ok) {
                    await saveSettings({ desktop: { ...settings.desktop, explorerContextMenu: v } })
                  } else {
                    pushToast({ kind: 'warn', title: '右键集成未启用', body: res.reason ?? '不支持当前环境' })
                  }
                }}
              />
              资源管理器右键"用 Trellis Panel 阅读"（仅打包版 Windows）
            </label>
            <div className="flex items-center gap-2">
              <span className="text-my-xs text-my-secondary">全局唤起快捷键</span>
              <input
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
                onBlur={() => void saveSettings({ desktop: { ...settings.desktop, globalShortcut: shortcut.trim() || 'Alt+Shift+T' } })}
                className="my-input !w-36 font-mono"
                placeholder="Alt+Shift+T"
              />
              <span className="text-my-xs text-my-placeholder">显示 / 隐藏面板，保存后重启生效</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-my-xs text-my-secondary">派单模型（codex worker）</span>
              <input
                value={dispatchModel}
                onChange={(e) => setDispatchModel(e.target.value)}
                onBlur={() => void saveSettings({ dispatch: { codexModel: dispatchModel.trim() } })}
                className="my-input !w-44 font-mono"
                placeholder="留空用 CLI 默认"
              />
              <span className="text-my-xs text-my-placeholder">只读审阅等派单用的 codex 模型；报 400 not supported 时填账号可用的模型</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-my-xs text-my-secondary">速记窗快捷键</span>
              <input
                value={quickShortcut}
                onChange={(e) => setQuickShortcut(e.target.value)}
                onBlur={() =>
                  void saveSettings({ desktop: { ...settings.desktop, quickTodoShortcut: quickShortcut.trim() || 'Alt+N' } })
                }
                className="my-input !w-36 font-mono"
                placeholder="Alt+N"
              />
              <span className="text-my-xs text-my-placeholder">随时呼出 Markdown 速记窗记待办，保存后重启生效</span>
            </div>
          </div>
        </section>

        {/* AI bridge */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-my-xs font-semibold text-my-secondary">
            <Plug size={13} /> AI 工具桥接（codex / zcode / claude）
          </div>
          <p className="mb-3 text-my-xs leading-5 text-my-tertiary">
            ① 安装 <code className="rounded-my-sm bg-my-layer-3 px-1 font-mono">tpanel</code>；
            ② 将上方对应配置复制到 Codex / ZCode / Claude Code；
            ③ 把任务事件 hooks 写入 <code className="rounded-my-sm bg-my-layer-3 px-1 font-mono">.trellis/config.yaml</code>；
            ④ 任意程序可打开 <code className="rounded-my-sm bg-my-layer-3 px-1 font-mono">trellis-panel://open-task?dir=…&amp;t=令牌</code> 跳转任务。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void doInstallTpanel()}>
              <TerminalSquare size={12} /> 安装 / 更新 tpanel 命令
            </Button>
            <Button variant="outline" onClick={() => void doInstallHooks()}>
              <Plug size={12} /> 写入 Trellis 任务 hooks
            </Button>
          </div>
          {hookMsg && <div className="mt-2 text-my-xs text-my-tertiary">{hookMsg}</div>}
        </section>

        {/* Jira */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-my-xs font-semibold text-my-secondary">
            <Link2 size={13} /> Jira 连接
          </div>
          <p className="mb-3 text-my-xs leading-5 text-my-tertiary">
            Jira Server / Data Center（REST v2）。密码经系统凭据加密（DPAPI）存储。
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="col-span-2 space-y-1">
              <span className="text-my-xs text-my-tertiary">服务器地址</span>
              <input
                value={jira.baseUrl}
                onChange={(e) => setJira({ ...jira, baseUrl: e.target.value })}
                placeholder="http://192.168.1.202:8083"
                className="my-input font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-my-xs text-my-tertiary">用户名</span>
              <input value={jira.user} onChange={(e) => setJira({ ...jira, user: e.target.value })} className="my-input" />
            </label>
            <label className="space-y-1">
              <span className="text-my-xs text-my-tertiary">密码 / Token {settings.jira.passwordEncrypted && <span className="text-my-success-text">（已加密保存）</span>}</span>
              <input
                type="password"
                value={jira.password}
                onChange={(e) => setJira({ ...jira, password: e.target.value })}
                placeholder={settings.jira.passwordEncrypted ? '••••••••（输入新值覆盖）' : ''}
                className="my-input"
              />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-my-xs text-my-tertiary">默认 JQL（留空 = assignee = currentUser()）</span>
              <input
                value={jira.jql}
                onChange={(e) => setJira({ ...jira, jql: e.target.value })}
                placeholder="project = XXX AND status != 完成 ORDER BY updated DESC"
                className="my-input font-mono"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void testJira()} disabled={jiraTesting || !jira.baseUrl}>
              {jiraTesting ? '测试中…' : '测试连接'}
            </Button>
            <Button variant="primary" onClick={() => void saveJira()}>保存配置</Button>
            {/* R0：Jira 后台自动回写任务状态已停用（生命周期收归外部工作流），开关一并移除 */}
            {jiraOk && (
              <span className="flex items-center gap-1 text-my-xs text-my-success-text">
                <CheckCircle2 size={12} /> {jiraOk}
              </span>
            )}
          </div>

          <div className="mt-4 border-t border-my-line pt-3">
            <div className="mb-2 text-my-xs font-semibold text-my-secondary">状态映射（Jira 状态名 → Trellis 状态）</div>
            <JiraStatusMapEditor settings={settings} />
          </div>
        </section>

        {/* GitLab connector */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-my-xs font-semibold text-my-secondary">
            <GitMerge size={13} /> GitLab 集成
            <label className="ml-3 flex cursor-pointer items-center gap-1.5 text-my-xs font-normal text-my-tertiary">
              <Checkbox
                checked={gitlab.enabled}
                onChange={(v) => setGitlab({ ...gitlab, enabled: v })}
              />
              启用（任务卡显示 MR / 构建状态）
            </label>
          </div>
          <p className="mb-3 text-my-xs leading-5 text-my-tertiary">
            自建 GitLab（OAuth 密码模式自动换 token）。关联分支的任务会显示 MR 与流水线状态，可一键创建 MR。密码经系统凭据加密（DPAPI）存储。
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="col-span-2 space-y-1">
              <span className="text-my-xs text-my-tertiary">GitLab 地址</span>
              <input
                value={gitlab.baseUrl}
                onChange={(e) => setGitlab({ ...gitlab, baseUrl: e.target.value })}
                placeholder="http://192.168.1.202:8929"
                className="my-input font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-my-xs text-my-tertiary">账号</span>
              <input
                value={gitlab.user}
                onChange={(e) => setGitlab({ ...gitlab, user: e.target.value })}
                placeholder="1786487276@qq.com"
                className="my-input"
              />
            </label>
            <label className="space-y-1">
              <span className="text-my-xs text-my-tertiary">密码 {settings.gitlab.passwordEncrypted && <span className="text-my-success-text">（已加密保存）</span>}</span>
              <input
                type="password"
                value={gitlab.password}
                onChange={(e) => setGitlab({ ...gitlab, password: e.target.value })}
                placeholder={settings.gitlab.passwordEncrypted ? '••••••••（输入新值覆盖）' : ''}
                className="my-input"
              />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-my-xs text-my-tertiary">项目路径（含命名空间，任务分支将在此项目下匹配 MR / 流水线）</span>
              <input
                value={gitlab.project}
                onChange={(e) => setGitlab({ ...gitlab, project: e.target.value })}
                placeholder="huachuang/honsky-lis"
                className="my-input font-mono"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void testGitlab()} disabled={gitlabTesting || !gitlab.baseUrl || !gitlab.user}>
              {gitlabTesting ? '测试中…' : '测试连接'}
            </Button>
            <Button variant="primary" onClick={() => void saveGitlab()}>保存配置</Button>
            {gitlabOk && (
              <span className="flex items-center gap-1 text-my-xs text-my-success-text">
                <CheckCircle2 size={12} /> {gitlabOk}
              </span>
            )}
          </div>
        </section>

        {/* WeKnora 公司库联动 */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-1 flex items-center gap-1.5 text-my-xs font-semibold text-my-secondary">
            <Cloud size={13} /> WeKnora 知识库联动
            <label className="ml-3 flex cursor-pointer items-center gap-1.5 text-my-xs font-normal text-my-tertiary">
              <Checkbox
                checked={wk.enabled}
                onChange={(v) => setWk({ ...wk, enabled: v })}
              />
              启用（知识库联邦检索 · 规划喂料 · 归档沉淀 · spec 同步）
            </label>
          </div>
          <p className="mb-3 text-my-xs leading-5 text-my-tertiary">
            本地四库保持毫秒级不动，WeKnora 作为跨项目知识来源异步追加：规范、历史归档、接口文档。
            API Key 经系统凭据加密（DPAPI）存储；建议在 WeKnora 侧使用限定知识库的 scoped API Key。
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="col-span-2 space-y-1">
              <span className="text-my-xs text-my-tertiary">服务器地址（带不带 /api/v1 均可）</span>
              <input
                value={wk.baseUrl}
                onChange={(e) => setWk({ ...wk, baseUrl: e.target.value })}
                placeholder="http://192.168.1.202:8080"
                className="my-input font-mono"
              />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-my-xs text-my-tertiary">
                API Key（X-API-Key）{settings.weknora?.apiKeyEncrypted && <span className="text-my-success-text">（已加密保存）</span>}
              </span>
              <input
                type="password"
                value={wk.apiKey}
                onChange={(e) => setWk({ ...wk, apiKey: e.target.value })}
                placeholder={settings.weknora?.apiKeyEncrypted ? '••••••••（输入新值覆盖）' : 'sk-…'}
                className="my-input font-mono"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void testWeknora()} disabled={wkTesting || !wk.baseUrl}>
              {wkTesting ? '测试中…' : '测试连接并加载知识库'}
            </Button>
            <Button variant="primary" onClick={() => void saveWeknora()}>保存配置</Button>
            {wkOk && (
              <span className="flex items-center gap-1 text-my-xs text-my-success-text">
                <CheckCircle2 size={12} /> {wkOk}
              </span>
            )}
          </div>

          {/* 库映射 */}
          <div className="mt-4 space-y-2.5 border-t border-my-line pt-3">
            <div className="text-my-xs font-semibold text-my-secondary">
              知识库映射{wkKbs ? `（已加载 ${wkKbs.length} 个）` : '（测试连接后可选择，也可手填 ID）'}
            </div>
            <div className="space-y-1">
              <div className="text-my-xs text-my-tertiary">联邦检索 / AI 规划范围（可多选）</div>
              <div className="flex flex-wrap gap-1.5">
                {(wkKbs ?? []).map((kb) => (
                  <button
                    key={kb.id}
                    type="button"
                    onClick={() => toggleSearchKb(kb.id)}
                    className={clsx(
                      'my-chip border transition-colors',
                      wk.searchKbIds.includes(kb.id)
                        ? 'border-my-line-accent-subtle bg-my-accent-subtle text-my-accent-text'
                        : 'border-my-line text-my-tertiary hover:text-my-secondary'
                    )}
                    title={`${kb.id} · ${kb.knowledgeCount} 篇`}
                  >
                    {wk.searchKbIds.includes(kb.id) ? '✓ ' : ''}{kb.name}
                  </button>
                ))}
                {wk.searchKbIds
                  .filter((id) => !(wkKbs ?? []).some((kb) => kb.id === id))
                  .map((id) => (
                    <button key={id} type="button" onClick={() => toggleSearchKb(id)} className="my-chip border border-my-line-accent-subtle bg-my-accent-subtle font-mono text-my-accent-text" title="列表外的 ID，点击移除">
                      ✓ {id}
                    </button>
                  ))}
                {(wkKbs ?? []).length === 0 && wk.searchKbIds.length === 0 && (
                  <span className="text-my-xs text-my-placeholder">未选择——知识库检索与规划补充将不可用</span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {wkKbs && wkKbs.length > 0 ? (
                <>
                  <label className="space-y-1">
                    <span className="text-my-xs text-my-tertiary">spec 同步目标库（L5）</span>
                    <Select ariaLabel="spec 同步目标库" value={wk.specKbId} onChange={(value) => setWk({ ...wk, specKbId: value })} className="w-full" options={[
                      { value: '', label: '（不同步）' },
                      ...wkKbs.map((kb) => ({ value: kb.id, label: kb.name }))
                    ]} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-my-xs text-my-tertiary">归档沉淀目标库（L4）</span>
                    <Select ariaLabel="归档沉淀目标库" value={wk.archiveKbId} onChange={(value) => setWk({ ...wk, archiveKbId: value })} className="w-full" options={[
                      { value: '', label: '（不沉淀）' },
                      ...wkKbs.map((kb) => ({ value: kb.id, label: kb.name }))
                    ]} />
                  </label>
                </>
              ) : (
                <>
                  <label className="space-y-1">
                    <span className="text-my-xs text-my-tertiary">spec 同步目标库 ID</span>
                    <input value={wk.specKbId} onChange={(e) => setWk({ ...wk, specKbId: e.target.value })} placeholder="kb-…" className="my-input font-mono" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-my-xs text-my-tertiary">归档沉淀目标库 ID</span>
                    <input value={wk.archiveKbId} onChange={(e) => setWk({ ...wk, archiveKbId: e.target.value })} placeholder="kb-…" className="my-input font-mono" />
                  </label>
                </>
              )}
            </div>
            <div className="flex flex-col gap-1.5 pt-1">
              <label className="flex cursor-pointer items-center gap-1.5 text-my-xs text-my-tertiary">
              <Checkbox
                checked={wk.autoPushArchive}
                onChange={(v) => setWk({ ...wk, autoPushArchive: v })}
              />
                归档任务时自动沉淀到知识库（PRD + 交付信息，channel = trellis-panel）
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-my-xs text-my-tertiary">
              <Checkbox
                checked={wk.syncSpec}
                onChange={(v) => setWk({ ...wk, syncSpec: v })}
              />
                .trellis/spec 变更自动同步（10 分钟静默后批量推送，按内容去重更新）
              </label>
            </div>
          </div>

          {/* MCP 端点（L3A：注册 WeKnora 内置 MCP Server 给 AI 编码工具） */}
          <div className="mt-4 space-y-2.5 border-t border-my-line pt-3">
            <div className="text-my-xs font-semibold text-my-secondary">MCP 端点（AI 编码工具直连知识库）</div>
            <p className="text-my-xs leading-4 text-my-placeholder">
              WeKnora「设置 → 发布与集成 → MCP Server」创建端点后填入。远程注册条目放在各工具的用户级配置，
              不写入随仓库共享的 .mcp.json（避免端点令牌进 git）。
            </p>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="col-span-2 space-y-1">
                <span className="text-my-xs text-my-tertiary">端点 URL（Streamable HTTP）</span>
                <input
                  value={wk.mcpUrl}
                  onChange={(e) => setWk({ ...wk, mcpUrl: e.target.value })}
                  placeholder="https://weknora.internal:8080/mcp/ep-xxxx"
                  className="my-input font-mono"
                />
              </label>
              <label className="col-span-2 space-y-1">
                <span className="text-my-xs text-my-tertiary">
                  端点令牌{settings.weknora?.mcpTokenEncrypted && <span className="text-my-success-text">（已加密保存）</span>}
                </span>
                <input
                  type="password"
                  value={wk.mcpToken}
                  onChange={(e) => setWk({ ...wk, mcpToken: e.target.value })}
                  placeholder={settings.weknora?.mcpTokenEncrypted ? '••••••••（输入新值覆盖）' : ''}
                  className="my-input font-mono"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => void testWeknoraMcp()} disabled={wkMcpTesting || !wk.mcpUrl}>
                {wkMcpTesting ? '握手中…' : '测试端点'}
              </Button>
              {wkMcpOk && <span className="flex items-center gap-1 text-my-xs text-my-success-text"><CheckCircle2 size={12} /> {wkMcpOk}</span>}
              <span className="h-4 w-px bg-my-line" />
              <Button variant="ghost" className="text-my-xs" onClick={() => copySnip(mcpSnippets().claude, 'Claude .mcp.json 条目已复制')}>复制 Claude JSON</Button>
              <Button variant="ghost" className="text-my-xs" onClick={() => copySnip(mcpSnippets().codex, 'Codex TOML 已复制')}>复制 Codex TOML</Button>
              <Button variant="ghost" className="text-my-xs" onClick={() => copySnip(mcpSnippets().zcode, 'ZCode 命令已复制')}>复制 ZCode 命令</Button>
            </div>
          </div>
        </section>

        {/* theme + cli */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-3 text-my-xs font-semibold text-my-secondary">外观与 CLI</div>
          <div className="mb-3 flex gap-2">
            {(
              [
                ['dark', '深色', <Moon size={14} key="d" />],
                ['light', '浅色', <Sun size={14} key="l" />]
              ] as const
            ).map(([v, label, icon]) => (
              <button
                key={v}
                type="button"
                onClick={() => void saveSettings({ theme: v })}
                className={clsx(
                  'flex items-center gap-2 rounded-my-lg border px-4 py-2 text-my-xs transition-colors',
                  settings.theme === v
                    ? 'border-my-line-accent bg-my-accent-subtle text-my-accent-text'
                    : 'border-my-line-strong text-my-secondary hover:border-my-line-strong-1'
                )}
              >
                {icon} {label}
              </button>
            ))}
          </div>
          <AppearancePreferences />
          <div className="flex gap-2">
            <input value={cliDraft} onChange={(e) => setCliDraft(e.target.value)} className="my-input flex-1 font-mono" />
            <Button
              variant="primary"
              onClick={() => void saveSettings({ cliCommand: cliDraft.trim() || 'trellis' })}
            >
              <Terminal size={12} /> 保存 CLI 命令
            </Button>
          </div>
        </section>

        {/* recents */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-3 flex items-center gap-1.5 text-my-xs font-semibold text-my-secondary">
            <FolderOpen size={13} /> 最近项目
          </div>
          {settings.recentProjects.length === 0 && <div className="text-my-xs text-my-tertiary">暂无记录</div>}
          <div className="space-y-1">
            {settings.recentProjects.map((r) => (
              <div key={r} className="group flex items-center gap-2 rounded-my-lg border border-my-line bg-my-layer-1 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary">{r}</span>
                <button
                  type="button"
                  onClick={() => void saveSettings({ recentProjects: settings.recentProjects.filter((x) => x !== r) })}
                  className="shrink-0 text-my-placeholder opacity-0 transition-opacity hover:text-my-danger-text group-hover:opacity-100"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* AI 模型（baseUrl 自定义） */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-2 flex items-center gap-2 text-my-xs font-semibold text-my-secondary">
            <Sparkles size={13} className="text-my-icon-accent" /> 应用内 AI（OpenAI 兼容 · baseUrl 自定义模型）
          </div>
          <div className="space-y-2.5">
            <label className="flex items-center gap-2 text-my-sm text-my-secondary">
              <Checkbox
                checked={ai.enabled}
                onChange={(v) => setAi((c) => ({ ...c, enabled: v }))}
              />
              知识库问答 · PRD 草稿 · 任务摘要 · 任务规划
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-my-xs text-my-tertiary">Base URL —— 填到 /v1 即可；# 结尾 = 原样使用</span>
                <input
                  value={ai.baseUrl}
                  onChange={(e) => setAi((c) => ({ ...c, baseUrl: e.target.value }))}
                  placeholder="http://localhost:11434/v1"
                  className="my-input font-mono text-my-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-my-xs text-my-tertiary">模型名</span>
                <input
                  value={ai.model}
                  onChange={(e) => setAi((c) => ({ ...c, model: e.target.value }))}
                  placeholder="qwen3-coder / gpt-4o-mini / deepseek-chat…"
                  className="my-input font-mono text-my-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-my-xs text-my-tertiary">
                  API Key {settings.ai.apiKeyEncrypted && <span className="text-my-success-text">（已加密保存）</span>}
                </span>
                <input
                  type="password"
                  value={ai.apiKey}
                  onChange={(e) => setAi((c) => ({ ...c, apiKey: e.target.value }))}
                  placeholder="本地服务可留空"
                  className="my-input font-mono text-my-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-my-xs text-my-tertiary">Temperature（{ai.temperature}）</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={ai.temperature}
                  onChange={(e) => setAi((c) => ({ ...c, temperature: Number(e.target.value) }))}
                  className="w-full"
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => void saveAi()}>保存配置</Button>
              <Button variant="outline" onClick={() => void testAi()} disabled={aiTesting || !ai.baseUrl || !ai.model}>
                {aiTesting ? '测试中…' : '测试连接'}
              </Button>
              {aiOk && <span className="text-my-xs text-my-success-text">{aiOk}</span>}
            </div>
            <div className="text-my-xs text-my-placeholder">
              兼容 OpenAI 协议端点（Ollama / LM Studio / 云端）。密钥经 DPAPI 加密存储。
            </div>
          </div>
        </section>

        {/* 知识库 MCP（AI 记忆大脑） */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-2 flex items-center gap-2 text-my-xs font-semibold text-my-secondary">
            <BrainCircuit size={13} className="text-my-icon-accent" /> 知识库 MCP —— AI 编码工具的持久记忆大脑
          </div>
          <div className="space-y-2.5">
            <div className="text-my-sm leading-5 text-my-tertiary">
              本地 stdio MCP 服务器暴露四库给编码工具——进程内检索，毫秒级响应。工具：<code>kb_search</code> · <code>kb_read</code> · <code>kb_context</code>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void installKbMcp()}>
                <Server size={12} /> 安装并注册
              </Button>
              {mcpKbStatus?.installed && (
                <span className="text-my-xs text-my-success-text">
                  ✓ 服务器已就绪{mcpKbStatus.claudeConfigured ? ' · 本项目 .mcp.json 已配置' : ' · 本项目尚未配置'}
                </span>
              )}
            </div>
            {mcpKbResult && (
              <div className="space-y-1.5 rounded-my-lg border border-my-line bg-my-layer-1 p-3 text-my-xs leading-5 text-my-secondary">
                <div>
                  <code className="font-mono text-my-xs">{mcpKbResult.scriptPath}</code>
                </div>
                <div>
                  {mcpKbResult.claudeMcpJson ? (
                    <span className="text-my-success-text">✓ .mcp.json</span>
                  ) : (
                    <span className="text-my-warning-text">.mcp.json 未写入——用下方通用配置</span>
                  )}
                  <span className="mx-2 text-my-placeholder">·</span>
                  {mcpKbResult.codexWritten ? (
                    <span className="text-my-success-text">✓ ~/.codex/config.toml</span>
                  ) : (
                    <span className="text-my-warning-text">Codex 待手动配置</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button variant="ghost" className="text-my-xs" onClick={() => { void api.copyToClipboard(mcpKbResult.codexSnippet); pushToast({ kind: 'success', title: 'Codex TOML 已复制' }) }}>
                    复制 Codex TOML
                  </Button>
                  <Button variant="ghost" className="text-my-xs" onClick={() => { void api.copyToClipboard(mcpKbResult.zcodeCommand); pushToast({ kind: 'success', title: 'ZCode 命令已复制' }) }}>
                    复制 ZCode 命令
                  </Button>
                  <Button variant="ghost" className="text-my-xs" onClick={() => { void api.copyToClipboard(mcpKbResult.genericSnippet); pushToast({ kind: 'success', title: '通用 JSON 已复制' }) }}>
                    复制通用 mcpServers JSON
                  </Button>
                </div>
              </div>
            )}
            <div className="text-my-xs text-my-placeholder">
              <code>.mcp.json</code> 随仓库提交，团队共享。
            </div>
          </div>
        </section>

        {/* about */}
        <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
          <div className="mb-2 flex items-center gap-2 text-my-xs font-semibold text-my-secondary">
            <BrandMark size={16} className="text-my-primary" /> 关于
          </div>
          <div className="grid grid-cols-2 gap-y-1.5 text-my-xs text-my-tertiary">
            <span>Trellis Panel</span>
            <span className="text-right text-my-secondary">v0.3.0（Electron + React）</span>
            <span>数据格式</span>
            <span className="text-right text-my-secondary">@mindfoldhq/trellis task.json 标准 Schema</span>
            <span>官方文档</span>
            <button
              type="button"
              onClick={() => api.openExternal('https://docs.trytrellis.app/zh/start/install-and-first-task')}
              className="text-right text-my-accent-text hover:text-my-accent-text-secondary"
            >
              docs.trytrellis.app ↗
            </button>
          </div>
          <Button variant="outline" className="mt-3" onClick={() => void refresh()}>
            重新扫描当前项目
          </Button>
        </section>
      </div>
    </div>
  )
}


/* ---------------- ACP runtime setup and user-managed launch commands ---------------- */

function AcpAgentsSection(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const saveSettings = useApp((state) => state.saveSettings)
  const [agents, setAgents] = useState<AcpAgentStatus[]>([])
  const [rows, setRows] = useState<AcpAgentConfig[]>(() => settings?.acp?.agents ?? [])
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const live = useRef(true)
  const lock = useRef(false)
  const isCurrent = (): boolean => live.current
  useEffect(() => {
    live.current = true
    if (hasIpc) void api.acpAgents().then((response) => {
      if (!live.current) return
      if (response.ok && response.agents) setAgents(response.agents)
      else setMessage(response.error ?? 'Runtime 列表加载失败')
    }).catch((error: unknown) => { if (live.current) setMessage(error instanceof Error ? error.message : 'Runtime 列表加载失败') })
    return () => { live.current = false }
  }, [])
  const persist = async (): Promise<void> => {
    if (lock.current || !live.current) return
    if (rows.some((row) => !row.name.trim() || (!row.command.trim() && !row.executable))) { setMessage('请填写每个自定义 Runtime 的名称和启动命令。'); return }
    lock.current = true; setPending(true); setMessage('')
    try {
      await saveSettings({ acp: { ...useApp.getState().settings?.acp, agents: rows } })
      if (!live.current) return
      const response = await api.acpRuntimeRefresh()
      if (!live.current) return
      if (response.agents) setAgents(response.agents)
      setMessage(response.ok ? '自定义命令已保存并重新探测。不会自动开始会话。' : response.error ?? '已保存，但重新探测失败。')
    } catch (error) { if (live.current) setMessage(error instanceof Error ? error.message : '保存失败，请重试') }
    finally { lock.current = false; if (live.current) setPending(false) }
  }
  return <section className="space-y-4 rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4">
    <div className="flex items-center gap-2 text-my-xs font-semibold text-my-secondary"><Bot size={13} /> ACP Runtime</div>
    <RuntimePanel agents={agents} onChange={setAgents} isCurrent={isCurrent} />
    <details className="border-t border-my-line pt-3">
      <summary className="cursor-pointer text-my-xs font-medium text-my-secondary">自定义启动命令与原有配置</summary>
      <p className="my-3 text-my-2xs leading-relaxed text-my-tertiary">适用于自行安装的 ACP v1 程序。内置 Codex / Claude 使用上方固定版本安装路径。自定义命令由本机管理；保存不会下载或执行。原有覆盖配置保持保留。</p>
      <div className="space-y-3">{rows.map((row) => <div key={row.id} className="space-y-2 rounded-my-md border border-my-line p-3">
        <div className="flex flex-wrap items-center gap-2"><Checkbox checked={row.enabled} onChange={(enabled) => setRows((previous) => previous.map((item) => item.id === row.id ? { ...item, enabled } : item))} /><input aria-label="Runtime 名称" className="my-input min-w-0 flex-1" value={row.name} disabled={pending} onChange={(event) => setRows((previous) => previous.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} /><Button size="sm" variant="ghost" disabled={pending} className="text-my-danger-text" onClick={() => setRows((previous) => previous.filter((item) => item.id !== row.id))}>移除此配置</Button></div>
        <input aria-label="Runtime 启动命令" className="my-input w-full font-mono text-my-xs" value={row.executable ? [row.executable, ...(row.args ?? [])].join(' ') : row.command} disabled={pending || Boolean(row.executable)} placeholder='如 "C:\Tools\my-agent.cmd" --acp' onChange={(event) => setRows((previous) => previous.map((item) => item.id === row.id ? { ...item, command: event.target.value } : item))} />
        {row.executable && <p className="text-my-2xs text-my-tertiary">此项使用结构化 executable / args 配置，保留原始参数边界。</p>}
      </div>)}</div>
      <div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={() => setRows((previous) => [...previous, { id: `custom-${Date.now()}`, name: '', command: '', enabled: true }])}>添加自定义 Runtime</Button><Button size="sm" variant="primary" disabled={pending || !hasIpc} onClick={() => void persist()}>{pending ? '保存并检测中…' : '保存命令配置'}</Button></div>
    </details>
    {message && <p role="status" className="break-words text-my-xs text-my-secondary">{message}</p>}
  </section>
}
