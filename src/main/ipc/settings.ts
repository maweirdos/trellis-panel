import { ipcInvoke } from '../../shared/ipc-channels'
import type { AiConfig, GitLabConfig, JiraConfig, WeknoraConfig } from '../../shared/types'
import { getSettings, setSettings } from '../services/store'
import { protectPassword } from '../services/jira'
import { protectGitlabPassword, clearGitlabTokenCache, clearGitlabStatusCache } from '../services/gitlab'
import { protectAiKey } from '../services/ai'
import { protectWeknoraKey, protectWeknoraMcpToken } from '../services/weknora'
import { applyAutoStart, syncWeknoraSpecConfig } from '../state'
import { accessServer } from '../services/access/server'
import { applyChromiumProxy } from '../services/proxy'
import { explorerMenuSupported, setExplorerMenu } from '../services/explorer-menu'
import { handle } from './registry'

export function registerSettingsIpc(): void {
  handle(ipcInvoke.settings.get, () => getSettings())

  handle(ipcInvoke.settings.set, (_e, patch) => {
    const prevJira = getSettings().jira
    let jira = patch.jira as JiraConfig | undefined
    if (jira && typeof jira.password === 'string' && jira.password && !jira.passwordEncrypted && jira.password !== prevJira.password) {
      jira = { ...jira, ...protectPassword(jira.password) }
    }
    const prevGitlab = getSettings().gitlab
    let gitlab = patch.gitlab as GitLabConfig | undefined
    if (gitlab && typeof gitlab.password === 'string' && gitlab.password && !gitlab.passwordEncrypted && gitlab.password !== prevGitlab.password) {
      gitlab = { ...gitlab, ...protectGitlabPassword(gitlab.password) }
    }
    const prevAi = getSettings().ai
    let ai = patch.ai as AiConfig | undefined
    if (ai) {
      if (typeof ai.apiKey === 'string' && ai.apiKey && !ai.apiKeyEncrypted && ai.apiKey !== prevAi.apiKey) {
        ai = { ...ai, ...protectAiKey(ai.apiKey) }
      }
      if (Array.isArray(ai.providers)) {
        ai.providers = ai.providers.map((p) => {
          const prevP = prevAi.providers?.find((x) => x.id === p.id)
          if (p.apiKey && !p.apiKeyEncrypted && p.apiKey !== prevP?.apiKey) {
            const enc = protectAiKey(p.apiKey)
            return { ...p, apiKey: enc.apiKey, apiKeyEncrypted: enc.apiKeyEncrypted }
          }
          return p
        })
      }
    }
    const prevWeknora = getSettings().weknora
    let weknora = patch.weknora as WeknoraConfig | undefined
    if (weknora) {
      if (typeof weknora.apiKey === 'string' && weknora.apiKey && !weknora.apiKeyEncrypted && weknora.apiKey !== prevWeknora.apiKey) {
        weknora = { ...weknora, ...protectWeknoraKey(weknora.apiKey) }
      }
      if (typeof weknora.mcpToken === 'string' && weknora.mcpToken && !weknora.mcpTokenEncrypted && weknora.mcpToken !== prevWeknora.mcpToken) {
        weknora = { ...weknora, ...protectWeknoraMcpToken(weknora.mcpToken) }
      }
      if (!Array.isArray(weknora.searchKbIds)) weknora = { ...weknora, searchKbIds: [] }
    }
    const next = setSettings({ ...patch, jira, gitlab, ai, weknora })
    if (gitlab) {
      clearGitlabTokenCache()
      clearGitlabStatusCache()
    }
    syncWeknoraSpecConfig()
    applyAutoStart()
    // 接入协议开关/端口变化 → 同步启停（始终环回绑定）；代理变化 → 重新应用 Chromium 代理
    void accessServer.syncFromSettings()
    void applyChromiumProxy()
    return next
  })

  /** T1：资源管理器右键"用 Trellis Panel 阅读"（仅打包态 Windows；写 HKCU，幂等可撤销） */
  handle(ipcInvoke.desktop.setExplorerMenu, async (_e, on: boolean) => {
    if (!explorerMenuSupported()) {
      return { ok: false as const, supported: false, reason: '仅打包版 Windows 支持资源管理器右键集成' }
    }
    const ok = await setExplorerMenu(on, getSettings().bridgeToken)
    if (ok) {
      const cur = getSettings()
      setSettings({ ...cur, desktop: { ...cur.desktop, explorerContextMenu: on } })
    }
    return ok ? { ok: true as const, supported: true } : { ok: false as const, supported: true, reason: '注册表写入失败' }
  })
}
