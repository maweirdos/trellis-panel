import { useEffect, useRef, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { api, hasIpc } from '../api'
import { Button, EmptyState, Switch } from '../my/ui'
import { RuntimePanel } from '../acp/RuntimePanel'
import { getRuntimeInventorySnapshot } from '../acp/useRuntimeInventoryRefresh'
import { DaemonSettings } from '../daemon/DaemonSettings'
import { AppearancePreferences, ThemePreferences } from '../my/AppearancePreferences'
import { PreferenceRow, PreferenceSection } from './settings/PreferenceSection'
import { StorageSettings } from './settings/StorageSettings'
import type { SettingsView } from '../my/navigation'
import type { JSX } from 'react'
import type { AcpAgentStatus, McpInfo, Settings } from '../../../shared/types'
import { version as appVersion, license as appLicense } from '../../../../package.json'

export function SettingsPage(): JSX.Element {
  const settingsView = useMy((state) => state.settingsView)
  const theme = useMy((state) => state.theme)
  const setTheme = useMy((state) => state.setTheme)
  const [previewTheme, setPreviewTheme] = useState<Settings['theme']>(theme)
  useEffect(() => {
    if (hasIpc || settingsView !== 'appearance' || previewTheme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setTheme(media.matches ? 'dark' : 'light')
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [settingsView, previewTheme, setTheme])
  const settings = useApp((s) => s.settings)
  if (settingsView === 'engines') return <AcpAgentsSection />
  if (settingsView === 'storage') return <StorageSettings />
  // 浏览器预览（?my=1）无 IPC 桥、settings 恒为 null：渲染空态而非在渲染期解引用崩溃（真机 bootstrap 后恒非空）
  if (!settings) return (
    <div className="preferences-page">
      {settingsView === 'appearance' && <PreferenceSection id="preferences-preview-appearance" title="界面显示">
        <ThemePreferences theme={previewTheme} onChange={(next) => { setPreviewTheme(next); if (next !== 'system') setTheme(next) }} />
        <AppearancePreferences />
      </PreferenceSection>}
      <EmptyState title="设置未加载" description="连接桌面应用后可查看其余设置。" />
    </div>
  )
  return <SettingsPageBody settings={settings} view={settingsView} />
}

function SettingsPageBody({ settings, view }: { settings: Settings; view: SettingsView }): JSX.Element {
  const saveSettings = useApp((s) => s.saveSettings)
  const pushToast = useApp((s) => s.pushToast)

  const [pending, setPending] = useState<Record<string, boolean>>({})
  const actionLocks = useRef(new Set<string>())
  const perform = async (key: string, task: () => Promise<unknown>): Promise<void> => {
    if (actionLocks.current.has(key)) return
    actionLocks.current.add(key)
    setPending((current) => ({ ...current, [key]: true }))
    try { await task() }
    catch (error) { pushToast({ kind: 'error', title: '操作失败', body: error instanceof Error ? error.message : String(error) }) }
    finally {
      actionLocks.current.delete(key)
      setPending((current) => ({ ...current, [key]: false }))
    }
  }

  const [mcpInfo, setMcpInfo] = useState<McpInfo | null>(null)
  const [shortcut, setShortcut] = useState(settings.desktop.globalShortcut)
  const [quickShortcut, setQuickShortcut] = useState(settings.desktop.quickTodoShortcut)
  const [accessInfo, setAccessInfo] = useState<{
    enabled: boolean
    running: boolean
    port: number | null
    endpoint: string | null
    token: string
  } | null>(null)

  useEffect(() => {
    if (!hasIpc || view !== 'network') return
    let current = true
    void api.getMcpInfo().then((info) => { if (current) setMcpInfo(info) }).catch((error: unknown) => { if (current) pushToast({ kind: 'error', title: 'Web 服务状态读取失败', body: String(error) }) })
    return () => { current = false }
  }, [settings.httpApi.enabled, view, pushToast])

  const refreshAccess = (): void => {
    void api.accessStatus().then(setAccessInfo).catch((error: unknown) => pushToast({ kind: 'error', title: 'TPAP 状态读取失败', body: String(error) }))
  }

  useEffect(() => {
    if (!hasIpc || view !== 'network') return
    let current = true
    void api.accessStatus().then((info) => { if (current) setAccessInfo(info) }).catch((error: unknown) => { if (current) pushToast({ kind: 'error', title: 'TPAP 状态读取失败', body: String(error) }) })
    return () => { current = false }
  }, [settings.access?.enabled, settings.access?.port, view, pushToast])

  const copySnip = async (text: string, title: string): Promise<void> => {
    await api.copyToClipboard(text)
    pushToast({ kind: 'success', title })
  }

  const toggleMcp = async (on: boolean): Promise<void> => {
    const res = await api.toggleHttpApi(on)
    setMcpInfo(await api.getMcpInfo())
    if (res.ok) pushToast({ kind: 'success', title: on ? 'Web 看板服务已启动' : '已停止' })
    else pushToast({ kind: 'error', title: 'Web 服务操作失败', body: res.error })
  }

  /* ---- TPAP 本地接入协议 ---- */
  const toggleAccess = async (on: boolean): Promise<void> => {
    await saveSettings({ access: { ...(settings.access ?? { enabled: false, port: 39580 }), enabled: on, port: settings.access?.port ?? 39580 } })
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    setAccessInfo(await api.accessStatus())
  }

  const rotateAccess = async (): Promise<void> => {
    const result = await api.accessRotateToken()
    if (!result.ok) throw new Error('Token 重置失败，请重试')
    refreshAccess()
    pushToast({ kind: 'success', title: 'Token 已重置', body: '外部工具需更新为新的 token' })
  }

  return (
    <div className="preferences-page">
      {view === 'appearance' && <PreferenceSection id="preferences-appearance" title="界面显示">
        <ThemePreferences theme={settings.theme} disabled={pending.theme}
          onChange={(theme) => void perform('theme', () => saveSettings({ theme }))} />
        <AppearancePreferences />
      </PreferenceSection>}

      {view === 'preferences' && <PreferenceSection id="preferences-desktop" title="启动与窗口">
        <PreferenceRow label="开机自动启动" hint="登录系统后自动打开应用。">
          <Switch label="开机自动启动" checked={settings.desktop.autoStart} disabled={pending['desktop-autostart']}
            onChange={(autoStart) => void perform('desktop-autostart', () => saveSettings({ desktop: { ...settings.desktop, autoStart } }))} />
        </PreferenceRow>
        <PreferenceRow label="自动检查更新" hint="发现新版本时提醒。">
          <Switch label="自动检查更新" checked={settings.desktop.autoUpdate} disabled={pending['desktop-updates']}
            onChange={(autoUpdate) => void perform('desktop-updates', () => saveSettings({ desktop: { ...settings.desktop, autoUpdate } }))} />
        </PreferenceRow>
        <PreferenceRow label="资源管理器右键菜单" hint="仅打包版 Windows 支持。">
          <Switch label="资源管理器右键：用 Crux 阅读" checked={settings.desktop.explorerContextMenu ?? false}
            disabled={pending['desktop-explorer']} onChange={(enabled) => void perform('desktop-explorer', async () => {
              const result = await api.desktopSetExplorerMenu(enabled)
              if (result.ok) await saveSettings({ desktop: { ...settings.desktop, explorerContextMenu: enabled } })
              else pushToast({ kind: 'warn', title: '右键集成未启用', body: result.reason ?? '不支持当前环境' })
            })} />
        </PreferenceRow>
      </PreferenceSection>}

      {view === 'preferences' && <PreferenceSection id="preferences-shortcuts" title="键盘快捷键">
        <PreferenceRow label="面板快捷键" htmlFor="preferences-global-shortcut" hint="重启后生效。">
          <input id="preferences-global-shortcut" value={shortcut} disabled={pending['desktop-shortcut']} aria-busy={pending['desktop-shortcut']} onChange={(event) => setShortcut(event.target.value)}
            onBlur={() => void perform('desktop-shortcut', () => saveSettings({ desktop: { ...settings.desktop, globalShortcut: shortcut.trim() || 'Alt+Shift+T' } }))}
            className="my-input font-mono" placeholder="Alt+Shift+T" />
        </PreferenceRow>
        <PreferenceRow label="速记窗快捷键" htmlFor="preferences-quick-shortcut" hint="重启后生效。">
          <input id="preferences-quick-shortcut" value={quickShortcut} disabled={pending['desktop-quick-shortcut']} aria-busy={pending['desktop-quick-shortcut']} onChange={(event) => setQuickShortcut(event.target.value)}
            onBlur={() => void perform('desktop-quick-shortcut', () => saveSettings({ desktop: { ...settings.desktop, quickTodoShortcut: quickShortcut.trim() || 'Alt+N' } }))}
            className="my-input font-mono" placeholder="Alt+N" />
        </PreferenceRow>
      </PreferenceSection>}

      {view === 'daemon' && <DaemonSettings />}

      {view === 'network' && <PreferenceSection id="preferences-services" title="本地服务">
        <PreferenceRow label="Web 看板">
          <span role="status" className="text-my-secondary">{mcpInfo ? mcpInfo.running ? `运行中 · 端口 ${mcpInfo.port}` : '已停止' : '状态未确认'}</span>
          <Button size="sm" variant="outline" disabled={pending.web} aria-label={mcpInfo?.running ? '停止 Web 看板服务' : '启动 Web 看板服务'}
            onClick={() => void perform('web', () => toggleMcp(!(mcpInfo?.running ?? false)))}>
            {pending.web ? '处理中…' : mcpInfo?.running ? '停止' : '启动'}
          </Button>
          {mcpInfo?.webBoardUrl && <Button size="sm" variant="ghost" onClick={() => {
            const url = mcpInfo.webBoardUrl
            if (url) void api.openExternal(url)
          }}>打开看板 ↗</Button>}
          {!mcpInfo && <Button size="sm" variant="ghost" aria-label="刷新 Web 看板状态" disabled={pending['web-status']} onClick={() => void perform('web-status', async () => setMcpInfo(await api.getMcpInfo()))}>刷新状态</Button>}
        </PreferenceRow>
        <PreferenceRow label="局域网访问" hint="启用后监听 0.0.0.0，局域网设备可访问看板。">
          <Switch label="允许局域网访问 Web 看板" checked={settings.httpApi.lanAccess} disabled={pending['web-lan']}
            onChange={(lanAccess) => void perform('web-lan', async () => {
              await saveSettings({ httpApi: { ...settings.httpApi, lanAccess } })
              const result = await api.toggleHttpApi(settings.httpApi.enabled)
              if (!result.ok) throw new Error(result.error ?? 'Web 服务重启失败')
              setMcpInfo(await api.getMcpInfo())
            })} />
        </PreferenceRow>
        <PreferenceRow label="Web 看板页面">
          <Switch label="启用 Web 看板页面" checked={settings.httpApi.webBoard} disabled={pending['web-page']}
            onChange={(webBoard) => void perform('web-page', () => saveSettings({ httpApi: { ...settings.httpApi, webBoard } }))} />
        </PreferenceRow>
        <PreferenceRow label="本地接入协议（TPAP）" hint="仅监听 127.0.0.1，使用 Bearer Token 鉴权。">
          <span role="status" className="text-my-secondary">{accessInfo ? accessInfo.running ? `运行中 · 端口 ${accessInfo.port}` : '已停止' : '状态未确认'}</span>
          <Button size="sm" variant="outline" disabled={pending.access} aria-label={settings.access?.enabled ? '停止 TPAP 接入服务' : '启动 TPAP 接入服务'}
            onClick={() => void perform('access', () => toggleAccess(!(settings.access?.enabled ?? false)))}>
            {pending.access ? '处理中…' : settings.access?.enabled ? '停止' : '启动'}
          </Button>
          <Button size="sm" variant="ghost" aria-label="刷新 TPAP 状态" disabled={pending['access-status']} onClick={() => void perform('access-status', async () => setAccessInfo(await api.accessStatus()))}>刷新状态</Button>
        </PreferenceRow>
        <PreferenceRow label="tpanel 命令" hint="供 Agent 管理已批准的本地应用，并向面板发送任务事件。">
          <Button size="sm" variant="outline" disabled={pending['install-tpanel'] || !hasIpc}
            onClick={() => void perform('install-tpanel', async () => {
              const result = await api.installTpanel()
              if (!result.ok) throw new Error(result.error ?? '安装失败')
              pushToast({ kind: 'success', title: 'tpanel 命令已安装', body: result.path })
            })}>{pending['install-tpanel'] ? '安装中…' : '安装 / 更新'}</Button>
        </PreferenceRow>
        {accessInfo?.running && <>
          <PreferenceRow label="TPAP 端点">
            <code className="min-w-0 flex-1 break-all text-my-xs">{accessInfo.endpoint}</code>
            <Button size="sm" variant="ghost" aria-label="复制 TPAP 端点和鉴权信息" disabled={pending['copy-access-endpoint']}
              onClick={() => void perform('copy-access-endpoint', () => copySnip(`${accessInfo.endpoint}（Authorization: Bearer ${accessInfo.token}）`, 'TPAP 接入信息已复制'))}>复制</Button>
          </PreferenceRow>
          <PreferenceRow label="TPAP Token">
            <code className="min-w-0 flex-1 break-all text-my-xs">{accessInfo.token}</code>
            <Button size="sm" variant="ghost" aria-label="复制 TPAP Token" disabled={pending['copy-access-token']}
              onClick={() => void perform('copy-access-token', () => copySnip(accessInfo.token, 'TPAP Token 已复制'))}>复制</Button>
            <Button size="sm" variant="ghost" aria-label="重置 TPAP Token" disabled={pending['access-token']}
              onClick={() => void perform('access-token', rotateAccess)}>{pending['access-token'] ? '重置中…' : '重置'}</Button>
          </PreferenceRow>
        </>}
      </PreferenceSection>}

      {view === 'network' && <PreferenceSection id="preferences-network" title="网络代理">
        <PreferenceRow label="出网代理" hint="用于应用内 AI 与 WeKnora 请求。">
          <Switch label="启用出网代理" checked={settings.proxy?.enabled ?? false} disabled={pending.proxy}
            onChange={(enabled) => void perform('proxy', () => saveSettings({ proxy: { enabled, url: settings.proxy?.url ?? '' } }))} />
        </PreferenceRow>
        <PreferenceRow label="代理地址" htmlFor="preferences-proxy-url" hint="支持 http:// 和 socks5://。">
          <input id="preferences-proxy-url" value={settings.proxy?.url ?? ''} className="my-input font-mono" placeholder="http://127.0.0.1:7890"
            onChange={(event) => void saveSettings({ proxy: { enabled: settings.proxy?.enabled ?? false, url: event.target.value } }).catch((error: unknown) => pushToast({ kind: 'error', title: '代理地址保存失败', body: String(error) }))} />
        </PreferenceRow>
      </PreferenceSection>}

      {view === 'preferences' && (settings.recentProjects.length === 0 ? <p className="preference-empty">暂无最近项目</p>
        : <PreferenceSection id="preferences-recents" title="最近项目">
          <ul className="preference-recent-projects">{settings.recentProjects.map((path) => <li key={path} className="preference-recent-project">
            <FolderOpen size={18} aria-hidden="true" />
            <div className="preference-recent-project-copy">
              <span className="preference-recent-project-name">{path.split(/[\\/]/).filter(Boolean).pop() || path}</span>
              <span title={path} className="preference-recent-project-path font-mono">{path}</span>
            </div>
            <Button size="sm" variant="ghost" aria-label={`移除最近项目 ${path}`} disabled={pending['recent-projects']}
              onClick={() => void perform('recent-projects', () => saveSettings({ recentProjects: settings.recentProjects.filter((item) => item !== path) }))}><X size={14} aria-hidden="true" /></Button>
          </li>)}</ul>
        </PreferenceSection>)}

      {view === 'about' && <PreferenceSection id="preferences-about" title="关于">
        <PreferenceRow label="Crux"><span className="text-my-secondary">v{appVersion}</span></PreferenceRow>
        <PreferenceRow label="项目仓库"><Button size="sm" variant="ghost" onClick={() => void api.openExternal('https://github.com/maweirdos/trellis-panel')}>maweirdos/trellis-panel ↗</Button></PreferenceRow>
        <PreferenceRow label="问题反馈"><Button size="sm" variant="ghost" onClick={() => void api.openExternal('https://github.com/maweirdos/trellis-panel/issues')}>GitHub Issues ↗</Button></PreferenceRow>
        <PreferenceRow label="开源许可"><span className="text-my-secondary">{appLicense}</span></PreferenceRow>
      </PreferenceSection>}
    </div>
  )
}


/* ---------------- ACP runtime setup ---------------- */

function AcpAgentsSection(): JSX.Element {
  const [agents, setAgents] = useState<AcpAgentStatus[]>(getRuntimeInventorySnapshot)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  return <div className="preferences-page">
    <RuntimePanel agents={agents} onChange={setAgents} isCurrent={() => live.current} autoRefresh
      onConfigureModels={() => useApp.getState().setPage('models')}
      onManageAgents={() => { useMy.getState().requestAgentView('roles'); useApp.getState().setPage('acp') }} />
  </div>
}
