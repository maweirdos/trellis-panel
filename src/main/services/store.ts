import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import { WEKNORA_DEFAULTS } from '../../shared/types'
import type { Settings } from '../../shared/types'

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
}

let cache: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function newToken(): string {
  return randomBytes(16).toString('hex')
}

export function getSettings(): Settings {
  if (cache) return cache
  let loaded: Settings
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    loaded = {
      ...DEFAULTS,
      ...parsed,
      jira: { ...DEFAULTS.jira, ...(parsed.jira ?? {}) },
      gitlab: { ...DEFAULTS.gitlab, ...(parsed.gitlab ?? {}) },
      ai: { ...DEFAULTS.ai, ...(parsed.ai ?? {}) },
      weknora: { ...DEFAULTS.weknora, ...(parsed.weknora ?? {}) },
      httpApi: { ...DEFAULTS.httpApi, ...(parsed.httpApi ?? {}) },
      access: { ...DEFAULTS.access, ...(parsed.access ?? {}) },
      proxy: { ...DEFAULTS.proxy, ...(parsed.proxy ?? {}) },
      desktop: { ...DEFAULTS.desktop, ...(parsed.desktop ?? {}) }
    }
  } catch {
    loaded = { ...DEFAULTS }
  }
  // per-install bridge token (deep link / MCP auth)
  if (!loaded.bridgeToken) loaded.bridgeToken = newToken()
  cache = loaded
  persist()
  return cache
}

function persist(): void {
  if (!cache) return
  try {
    const p = settingsPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8')
  } catch {
    // settings persistence is best-effort
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings()
  const next: Settings = {
    ...cur,
    ...patch,
    jira: patch.jira ? { ...cur.jira, ...patch.jira } : cur.jira,
    gitlab: patch.gitlab ? { ...cur.gitlab, ...patch.gitlab } : cur.gitlab,
    ai: patch.ai ? { ...cur.ai, ...patch.ai } : cur.ai,
    weknora: patch.weknora ? { ...cur.weknora, ...patch.weknora } : cur.weknora,
    httpApi: patch.httpApi ? { ...cur.httpApi, ...patch.httpApi } : cur.httpApi,
    access: patch.access ? { ...cur.access, ...patch.access } : cur.access,
    proxy: patch.proxy ? { ...cur.proxy, ...patch.proxy } : cur.proxy,
    desktop: patch.desktop ? { ...cur.desktop, ...patch.desktop } : cur.desktop
  }
  cache = next
  persist()
  return next
}

export function pushRecentProject(root: string): Settings {
  const s = getSettings()
  const next = [root, ...s.recentProjects.filter((r) => r !== root)].slice(0, 10)
  return setSettings({ recentProjects: next })
}

/** Path helpers shared with the MCP stdio shim. */
export function settingsFilePath(): string {
  return settingsPath()
}
