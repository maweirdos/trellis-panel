import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { Settings } from '../../shared/types'

const DEFAULTS: Settings = {
  recentProjects: [],
  theme: 'dark',
  cliCommand: 'trellis',
  jira: { enabled: false, baseUrl: '', user: '', password: '', jql: '' }
}

let cache: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): Settings {
  if (cache) return cache
  let loaded: Settings
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    loaded = { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    loaded = { ...DEFAULTS }
  }
  cache = loaded
  return loaded
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  cache = next
  try {
    const p = settingsPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
  } catch {
    // settings persistence is best-effort
  }
  return next
}

export function pushRecentProject(root: string): Settings {
  const s = getSettings()
  const next = [root, ...s.recentProjects.filter((r) => r !== root)].slice(0, 10)
  return setSettings({ recentProjects: next })
}
