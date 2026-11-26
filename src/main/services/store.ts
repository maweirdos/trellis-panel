import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import { WEKNORA_DEFAULTS } from '../../shared/types'
import type { AcpRuntimeDefaults, Settings } from '../../shared/types'
import { atomicWriteText } from './local-task/prd'
import { assertLegacySettingsWriter } from '../daemon/settings-owner'
import { settingsPersistence } from './store-port'

const DEFAULTS: Settings = {
  recentProjects: [],
  theme: 'dark',
  cliCommand: 'trellis',
  jira: {
    enabled: false,
    baseUrl: '',
    user: '',
    password: '',
    jql: '',
    statusMap: {}
  },
  gitlab: {
    enabled: false,
    baseUrl: '',
    user: '',
    password: '',
    project: ''
  },
  ai: {
    enabled: false,
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: '',
    temperature: 0.3
  },
  weknora: { ...WEKNORA_DEFAULTS },
  bridgeToken: '',
  httpApi: { enabled: false, port: 39573, lanAccess: false, webBoard: true },
  access: { enabled: false, port: 39580 },
  proxy: { enabled: false, url: '' },
  desktop: { autoStart: false, globalShortcut: 'Alt+Shift+T', autoUpdate: false, quickTodoShortcut: 'Alt+N', explorerContextMenu: false }
  ,dispatch: { codexModel: '' }
}

let cache: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function newToken(): string {
  return randomBytes(16).toString('hex')
}

export function getSettings(): Settings {
  const authority = settingsPersistence()
  if (authority) return authority.read()
  if (cache) return cache
  let loaded: Settings
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    loaded = mergeSettings(DEFAULTS, parsed)
  } catch {
    loaded = { ...DEFAULTS }
  }
  // per-install bridge token (deep link / MCP auth)
  if (!loaded.bridgeToken) loaded.bridgeToken = newToken()
  cache = loaded
  persist()
  return cache
}

function persist(strict = false): void {
  if (!cache) return
  // Outside the legacy best-effort catch: a migration fence must never look like a successful save.
  assertLegacySettingsWriter(app.getPath('userData'))
  try {
    const p = settingsPath()
    mkdirSync(dirname(p), { recursive: true })
    if (strict) atomicWriteText(p, JSON.stringify(cache, null, 2))
    else writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8')
  } catch {
    if (strict) throw new Error('设置文件保存失败')
    // settings persistence is best-effort
  }
}

export function setSettings(patch: Partial<Settings>, strict = false): Settings {
  assertLegacyAcpAgentsUnchanged(getSettings(), patch)
  const authority = settingsPersistence()
  if (authority) return authority.write(patch, strict)
  assertLegacySettingsWriter(app.getPath('userData'))
  const cur = getSettings()
  const next = mergeSettings(cur, patch)
  cache = next
  try { persist(strict) } catch (error) { cache = cur; throw error }
  return next
}

/** Legacy custom definitions identify unavailable runtimes and must not be rewritten by settings clients. */
export function assertLegacyAcpAgentsUnchanged(current: Settings, patch: Partial<Settings>): void {
  if (patch.acp && Object.hasOwn(patch.acp, 'agents')
    && JSON.stringify(patch.acp.agents) !== JSON.stringify(current.acp?.agents)) {
    throw new Error('旧自定义执行引擎配置仅供辨认，不能新增、修改或删除')
  }
}

function patchRuntimeDefaults(current: Record<string, AcpRuntimeDefaults> | undefined, patch: Record<string, AcpRuntimeDefaults>): Record<string, AcpRuntimeDefaults> {
  const next = { ...current }
  for (const [id, value] of Object.entries(patch)) {
    if (Object.keys(value).length === 0) delete next[id]
    else next[id] = value
  }
  return next
}

/** Preserve existing extension keys while sharing native default/patch interpretation. */
export function mergeSettings(cur: Settings, patch: Partial<Settings>): Settings {
  return {
    ...cur,
    ...patch,
    jira: patch.jira ? { ...cur.jira, ...patch.jira } : cur.jira,
    gitlab: patch.gitlab ? { ...cur.gitlab, ...patch.gitlab } : cur.gitlab,
    ai: patch.ai ? { ...cur.ai, ...patch.ai } : cur.ai,
    weknora: patch.weknora ? { ...cur.weknora, ...patch.weknora } : cur.weknora,
    httpApi: patch.httpApi ? { ...cur.httpApi, ...patch.httpApi } : cur.httpApi,
    access: patch.access ? { ...cur.access, ...patch.access } : cur.access,
    proxy: patch.proxy ? { ...cur.proxy, ...patch.proxy } : cur.proxy,
    desktop: patch.desktop ? { ...cur.desktop, ...patch.desktop } : cur.desktop,
    dispatch: patch.dispatch ? { ...cur.dispatch, ...patch.dispatch } : cur.dispatch,
    acp: patch.acp ? {
      ...cur.acp,
      ...patch.acp,
      ...(patch.acp.runtimeDefaults ? { runtimeDefaults: patchRuntimeDefaults(cur.acp?.runtimeDefaults, patch.acp.runtimeDefaults) } : {})
    } : cur.acp
  }
}
export function defaultSettings(): Settings { return structuredClone(DEFAULTS) }

export function pushRecentProject(root: string): Settings {
  const s = getSettings()
  const next = [root, ...s.recentProjects.filter((r) => r !== root)].slice(0, 10)
  if (next.length === s.recentProjects.length && next.every((item, index) => item === s.recentProjects[index])) {
    return s
  }
  return setSettings({ recentProjects: next })
}

/** Path helpers shared with the MCP stdio shim. */
export function settingsFilePath(): string {
  return settingsPath()
}
