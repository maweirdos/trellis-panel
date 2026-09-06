import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
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
    statusMap: {},
    autoSync: false
  },
  bridgeToken: '',
  httpApi: { enabled: false, port: 39573, lanAccess: false, webBoard: true },
  mcp: { enabled: false },
  desktop: { autoStart: false, globalShortcut: 'Alt+Shift+T', autoUpdate: false }
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
      httpApi: { ...DEFAULTS.httpApi, ...(parsed.httpApi ?? {}) },
      mcp: { ...DEFAULTS.mcp, ...(parsed.mcp ?? {}) },
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
    httpApi: patch.httpApi ? { ...cur.httpApi, ...patch.httpApi } : cur.httpApi,
    mcp: patch.mcp ? { ...cur.mcp, ...patch.mcp } : cur.mcp,
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
