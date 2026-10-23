/** Read-only client metadata. Native advertised IDs/current state remain authoritative. */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import { createHash } from 'crypto'
import { z } from 'zod'
import type { AcpModelCatalogMetadata, AcpSessionRecord } from '../../../shared/types'

const MAX_METADATA_BYTES = 2 * 1024 * 1024
const text = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/)
const appState = z.object({
  mode: z.enum(['direct', 'proxy']), attached: z.boolean(), proxy_route: text.optional(),
  stack: z.object({ enabled: z.boolean(), members: z.array(text).max(128), keys: z.record(text, text).refine((value) => Object.keys(value).length <= 128) })
})
const liveState = z.object({ version: z.literal(1), apps: z.record(z.string(), z.unknown()) })
const catalog = z.object({ models: z.array(z.object({ slug: text, display_name: text.optional() })).max(512) })
const claudeSettings = z.object({ env: z.record(z.string(), z.unknown()).optional(), model: text.optional(), availableModels: z.never().optional(), modelOverrides: z.never().optional() })
const MODEL_ENV = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'] as const
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_MODEL_CONFIG', 'ANTHROPIC_BASE_URL', ...MODEL_ENV] as const

type App = 'codex' | 'claude'
type Mapping = NonNullable<AcpModelCatalogMetadata['mappings']>[number]
interface Snapshot {
  app?: App
  source: AcpModelCatalogMetadata['source']
  known: boolean
  revision?: string
  catalogPath?: string
  state?: z.infer<typeof appState>
  selectors: Map<string, string>
  aliases: Map<string, string>
}

/** Missing is distinct from unreadable/unsupported; never return file bodies to IPC/logs. */
function readBounded(path: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) throw new Error('Unsupported metadata')
    // A bounded read also fences growth between stat and read.
    const buffer = Buffer.alloc(Math.min(MAX_METADATA_BYTES + 1, stat.size + 1))
    const bytes = readInto(fd, buffer)
    if (bytes > MAX_METADATA_BYTES || bytes > stat.size) throw new Error('Metadata changed during read')
    return buffer.subarray(0, bytes).toString('utf8')
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return undefined
    throw new Error('Metadata unavailable')
  } finally { if (fd !== undefined) closeSync(fd) }
}

// Kept separate to make the bounded IO contract explicit; no unbounded readFile on configs.
function readInto(fd: number, buffer: Buffer): number {
  let size = 0
  while (size < buffer.length) {
    const count = readSync(fd, buffer, size, buffer.length - size, null)
    if (!count) break
    size += count
  }
  return size
}

/** Native trust/ancestor settings are deliberately not reimplemented here. */
function hasOtherProjectConfig(cwd: string, app: App, configHome: string): boolean {
  let directory = resolve(cwd)
  for (let depth = 0; depth < 32; depth += 1) {
    const home = join(directory, app === 'codex' ? '.codex' : '.claude')
    if (resolve(home) !== resolve(configHome) && (app === 'codex' || directory !== resolve(cwd))) {
      if (existsSync(join(home, app === 'codex' ? 'config.toml' : 'settings.json')) || (app === 'claude' && existsSync(join(home, 'settings.local.json')))) return true
    }
    if (existsSync(join(directory, '.git'))) return false
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
  return true
}

/** Only root scalar keys needed for provenance. Unsupported TOML syntax stays unknown. */
function codexScalars(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    if (/^\s*\[/.test(line)) break
    // Contents of an unrelated multiline value can look exactly like root keys.
    if (line.includes('"""') || line.includes("'''")) throw new Error('Unsupported multiline value')
    if (/^\s*["'](?:model_catalog_json|model_provider|model|profile)["']\s*=/.test(line)) throw new Error('Unsupported quoted key')
    const key = /^\s*(model_catalog_json|model_provider|model|profile)\s*=/.exec(line)?.[1]
    if (!key) continue
    if (key in result) throw new Error('Ambiguous configuration')
    const value = /^\s*\w+\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line)?.[1]
    if (!value) throw new Error('Unsupported scalar')
    result[key] = text.parse(value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1))
  }
  if (result.profile) throw new Error('Profile precedence unavailable')
  return result
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 16) }

function selectorMapping(app: App, id: string, state: Snapshot['state']): Mapping | undefined {
  if (!state || !state.attached || state.mode !== 'proxy' || !state.stack.enabled) return undefined
  const matches = Object.entries(state.stack.keys).flatMap(([key, providerId]) => {
    const prefix = app === 'codex' ? `ccs-${key}/` : `ccs-claude-${key}--`
    return state.stack.members.includes(providerId) && id.startsWith(prefix) && id.length > prefix.length
      ? [{ modelId: id, providerKey: key, providerId, configuredModel: id.slice(prefix.length) }] : []
  })
  // The suffix describes the configured client selector, never the final answering upstream.
  return matches.length === 1 ? matches[0] : undefined
}

export interface ModelMetadataContextInput {
  agentId: string
  launchKind?: string
  cwd: string
  env?: Array<{ key: string; value: string }>
  args?: Array<{ name: string; value: string }>
}

export class ModelMetadataContext {
  private baseline?: Snapshot
  private baselineGeneration?: string
  private latest?: Snapshot
  private readonly env: Record<string, string | undefined>
  private readonly input: { agentId: string; launchKind?: string; cwd: string; hasArgumentOverrides: boolean }
  constructor(input: ModelMetadataContextInput) {
    this.input = { agentId: input.agentId, launchKind: input.launchKind, cwd: input.cwd, hasArgumentOverrides: input.args?.some(({ name }) => Boolean(name.trim())) === true }
    // Follow the actual child overlay, without retaining unrelated variables/credentials.
    const role = Object.fromEntries((input.env ?? []).filter(({ key }) => ENV_KEYS.some((allowed) => allowed === key)).map(({ key, value }) => [key, value]))
    this.env = Object.fromEntries(ENV_KEYS.map((key) => [key, role[key] ?? process.env[key]]))
  }

  private read(): Snapshot {
    const app = this.input.agentId === 'codex' || this.input.agentId === 'claude' ? this.input.agentId : undefined
    const snapshot: Snapshot = { app, source: app === 'codex' ? 'codex-config' : app === 'claude' ? 'claude-settings' : 'engine', known: !app, selectors: new Map(), aliases: new Map() }
    if (!app) return snapshot
    // A custom command or role CLI settings can have a different config hierarchy.
    if (this.input.launchKind !== 'managed' || this.input.hasArgumentOverrides) return snapshot
    try {
      const home = (process.platform === 'win32' ? this.env.USERPROFILE : this.env.HOME) || homedir()
      if (!isAbsolute(home)) return snapshot
      const stateBody = readBounded(join(home, '.cc-switch', 'live-state.json'))
      const appData = stateBody === undefined ? undefined : liveState.parse(JSON.parse(stateBody)).apps[app]
      const state = appData === undefined ? undefined : appState.parse(appData)
      const safe: unknown[] = [state ?? null]
      if (app === 'codex') {
        const configHome = this.env.CODEX_HOME || join(home, '.codex')
        if (!isAbsolute(configHome)) return snapshot
        // Project trust/profiles/CLI overrides are native concerns, not a second TOML evaluator.
        if (hasOtherProjectConfig(this.input.cwd, app, configHome)) return snapshot
        const body = readBounded(join(configHome, 'config.toml'))
        const config = codexScalars(body ?? '')
        safe.push(config)
        if (config.model_catalog_json) {
          const path = resolve(configHome, config.model_catalog_json)
          // Only the referenced generated client catalog is supported; never models_cache/auth/DB.
          if (!/(?:^|[/\\])cc-switch-model-catalog\.json$/i.test(path)) return snapshot
          const data = readBounded(path)
          if (data === undefined) return snapshot
          const entries = catalog.parse(JSON.parse(data)).models
          if (new Set(entries.map(({ slug }) => slug)).size !== entries.length) return snapshot
          snapshot.catalogPath = process.platform === 'win32' ? path.toLowerCase() : path
          for (const entry of entries) snapshot.selectors.set(entry.slug, entry.display_name ?? entry.slug)
          safe.push(entries)
        }
      } else {
        const configHome = this.env.CLAUDE_CONFIG_DIR || join(home, '.claude')
        if (!isAbsolute(configHome) || this.env.CLAUDE_MODEL_CONFIG || hasOtherProjectConfig(this.input.cwd, app, configHome)) return snapshot
        const settingsEnv: Record<string, string> = {}
        for (const path of [join(configHome, 'settings.json'), join(this.input.cwd, '.claude', 'settings.json'), join(this.input.cwd, '.claude', 'settings.local.json')]) {
          const body = readBounded(path)
          const parsed = claudeSettings.parse(body === undefined ? {} : JSON.parse(body))
          for (const key of [...MODEL_ENV, 'ANTHROPIC_BASE_URL']) {
            const value = parsed.env?.[key]
            if (value !== undefined) settingsEnv[key] = text.parse(value)
          }
          safe.push({ model: parsed.model, env: Object.fromEntries([...MODEL_ENV, 'ANTHROPIC_BASE_URL'].map((key) => [key, parsed.env?.[key]])) })
        }
        for (const key of [...MODEL_ENV, 'ANTHROPIC_BASE_URL']) {
          if (this.env[key] !== undefined) settingsEnv[key] = text.parse(this.env[key])
        }
        for (const key of MODEL_ENV) if (settingsEnv[key]) snapshot.selectors.set(settingsEnv[key], settingsEnv[key])
        for (const [alias, key] of [['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']]) {
          if (settingsEnv[key]) snapshot.aliases.set(alias, settingsEnv[key])
        }
        // The endpoint is used only for a private revision; it is never projected.
        safe.push(settingsEnv)
      }
      snapshot.state = state
      snapshot.known = true
      snapshot.revision = digest(safe)
    } catch { /* Optional metadata cannot change native discovery or expose config/parser errors. */ }
    return snapshot
  }

  /** Called at the actual owned process spawn, never on a mere catalog read. */
  capture(generation: string | undefined): void { this.baselineGeneration = generation; this.baseline = this.latest = this.read() }

  project(meta: AcpSessionRecord, refresh = false): void {
    if (!meta.connectionGeneration) { delete meta.modelCatalog; return }
    if (refresh || !this.latest) this.latest = this.read()
    const latest = this.latest
    const baseline = this.baselineGeneration === meta.connectionGeneration ? this.baseline : undefined
    const changed = Boolean(baseline?.known && latest.known && baseline.revision !== latest.revision)
    const models = meta.models ?? []
    const missing = latest.app === 'codex' && latest.known && [...latest.selectors.keys()].some((id) => selectorMapping('codex', id, latest.state) && !models.some(({ modelId }) => modelId === id))
    const mappings = models.flatMap<Mapping>(({ modelId }) => {
      const selector = baseline?.aliases.get(modelId) ?? modelId
      const label = baseline?.selectors.get(selector)
      const mapping = label && baseline?.app ? selectorMapping(baseline.app, selector, baseline.state) : undefined
      if (mapping) return [{ ...mapping, modelId, configuredSelector: selector, configuredLabel: label }]
      return baseline?.known && selector !== modelId ? [{ modelId, configuredSelector: selector, configuredModel: selector }] : []
    })
    meta.modelCatalog = {
      connectionGeneration: meta.connectionGeneration, source: latest.source,
      freshness: changed ? 'changed' : baseline?.known && latest.known ? 'unchanged' : 'unknown',
      reloadRequired: changed,
      currentAvailable: meta.currentModelId ? models.some(({ modelId }) => modelId === meta.currentModelId) : undefined,
      issue: changed ? 'catalog-changed' : !latest.known ? 'configuration-unknown' : missing ? 'catalog-not-advertised' : undefined,
      provenance: latest.app && baseline?.state ? { app: latest.app, transportMode: baseline.state.mode, attached: baseline.state.attached, aggregateEnabled: baseline.state.stack.enabled } : undefined,
      mappings: mappings.length ? mappings : undefined
    }
  }

  /** A stale list is still the engine's list; reject known removed/incompatible aliases explicitly. */
  selectionProblem(id: string): string | undefined {
    const latest = this.latest
    const baseline = this.baseline
    const app = latest?.app
    if (!latest?.known || !baseline?.known || !app || baseline.revision === latest.revision) return undefined
    const prefix = app === 'codex' ? 'ccs-' : 'ccs-claude-'
    if (!id.startsWith(prefix)) return undefined
    // Initial disagreement is not evidence that an advertised native choice is invalid.
    // Removing/changing the reference does not establish removal from the original catalog.
    if (app === 'codex' && baseline.catalogPath && baseline.catalogPath === latest.catalogPath && baseline.selectors.has(id) && !latest.selectors.has(id)) return '该聚合模型已从 CC Switch 目录移除；请重新加载引擎目录后再选择。'
    if (selectorMapping(app, id, baseline.state) && latest.state && !selectorMapping(app, id, latest.state)) {
      const keys = Object.keys(latest.state.stack.keys).filter((key) => id.startsWith(app === 'codex' ? `ccs-${key}/` : `ccs-claude-${key}--`))
      if (keys.length > 1) return undefined
      return 'CC Switch 应用配置已变化，原聚合模型不再匹配；请重新加载引擎目录后再选择。'
    }
    return undefined
  }
}
