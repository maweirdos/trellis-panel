import { protectedStorage as safeStorage } from './protected-storage'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Settings } from '../../shared/types'
import { canonicalWorkflowJson } from '../../shared/workflow'
import { acpRuntimeDefaultsMapSchema } from '../../shared/acp-launch-options'
import { defaultSettings, mergeSettings } from '../services/store'
import { installSettingsPersistence } from '../services/store-port'
import { installIntegrationStatePort } from '../services/integrations/state-port'
import { integrationStateSchema, type IntegrationState } from '../services/integrations/stored-schema'
import { readBounded, writeAtomic } from './files'
import { ProtectedSettingsOwner, readProtectedSettingsProjection } from './settings-owner'
import type { DaemonContext } from './context'
import { DaemonError } from './errors'
import { decodeProtectedCiphertext } from './protection'

const UI_KEYS = ['recentProjects', 'theme', 'desktop'] as const
const uiPreferencesSchema = z.object({
  version: z.literal(1), revision: z.number().int().positive().safe(),
  recentProjects: z.array(z.string().max(4096)).max(10).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  desktop: z.object({ autoStart: z.boolean(), globalShortcut: z.string().max(200), autoUpdate: z.boolean(), quickTodoShortcut: z.string().max(200), explorerContextMenu: z.boolean().optional() }).optional()
}).strict()
const emptyIntegrations = (): IntegrationState => ({ version: 2, connections: [], bindings: [], receipts: [], legacyImports: {} })
const comparable = (value: unknown): string => canonicalWorkflowJson(JSON.parse(JSON.stringify(value ?? null)))

/** Match the existing Settings default field types while retaining extension
 * keys. Provider-specific URL/permission rules stay in their existing adapters. */
function settingsShape(value: unknown): z.ZodType {
  if (typeof value === 'boolean') return z.boolean()
  if (typeof value === 'string') return z.string().max(2 * 1024 * 1024)
  if (typeof value === 'number') return z.number().finite()
  if (Array.isArray(value)) return z.array(value.length ? settingsShape(value[0]) : z.unknown()).max(1000)
  if (value && typeof value === 'object') return z.object(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, settingsShape(child).optional()]))).passthrough()
  return z.unknown()
}
const knownSettingsShape = settingsShape(defaultSettings())
const explicitSettingsShape = z.object({
  theme: z.enum(['dark', 'light']).optional(), recentProjects: z.array(z.string().max(4096)).max(10).optional(),
  jira: z.object({ passwordEncrypted: z.boolean().optional() }).passthrough().optional(),
  gitlab: z.object({ passwordEncrypted: z.boolean().optional() }).passthrough().optional(),
  weknora: z.object({ apiKeyEncrypted: z.boolean().optional(), mcpTokenEncrypted: z.boolean().optional() }).passthrough().optional(),
  ai: z.object({
    apiFormat: z.enum(['openai', 'response', 'anthropic', 'ollama']).optional(), activeProviderId: z.string().optional(), apiKeyEncrypted: z.boolean().optional(),
    providers: z.array(z.object({
      id: z.string(), name: z.string(), group: z.string().optional(), icon: z.string().optional(), enabled: z.boolean(), baseUrl: z.string(), apiFormat: z.enum(['openai', 'response', 'anthropic', 'ollama']), apiKey: z.string(), apiKeyEncrypted: z.boolean().optional(),
      models: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean(), contextWindow: z.string().optional(), tags: z.array(z.string()).optional(), temperature: z.number().finite().optional(), maxTokens: z.number().finite().optional() }).passthrough()).max(1000),
      status: z.enum(['connected', 'untested', 'error', 'disabled']).optional()
    }).passthrough()).max(1000).optional()
  }).passthrough().optional(),
  acp: z.object({
    runtimeDefaults: acpRuntimeDefaultsMapSchema.optional(),
    agents: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(300), command: z.string().max(8192), enabled: z.boolean(), launchKind: z.enum(['managed', 'custom', 'native', 'bundled', 'sdk']).optional(), executable: z.string().max(4096).optional(), args: z.array(z.string().max(8192)).max(100).optional() }).passthrough()).max(100).optional(),
    nodePath: z.string().max(4096).optional(), nativePaths: z.record(z.string(), z.string().max(4096)).optional(),
    zcode: z.object({ enableAutomationTools: z.boolean().optional() }).passthrough().optional()
  }).passthrough().optional()
}).passthrough()

function uiPreferences(context: DaemonContext): z.infer<typeof uiPreferencesSchema> {
  const path = join(context.directory, 'desktop-preferences.json')
  if (!existsSync(path)) return { version: 1, revision: 1 }
  try { return uiPreferencesSchema.parse(JSON.parse(readBounded(path, 256 * 1024))) }
  catch { throw new DaemonError('E_IO', 'Desktop preferences are corrupt or incompatible; the original file was preserved.') }
}
function mergeUi(context: DaemonContext, settings: Settings): Settings {
  const preferences = uiPreferences(context)
  return mergeSettings(settings, {
    ...(preferences.theme === undefined ? {} : { theme: preferences.theme }),
    ...(preferences.desktop === undefined ? {} : { desktop: preferences.desktop }),
    ...(preferences.recentProjects === undefined ? {} : { recentProjects: preferences.recentProjects })
  })
}
function normalizedSettings(raw: Record<string, unknown> | null): Settings {
  if (raw !== null && !knownSettingsShape.safeParse(raw).success) throw new DaemonError('E_INVALID_ARG', 'A known native settings field has an incompatible type; no replacement settings were published.')
  if (raw !== null && !explicitSettingsShape.safeParse(raw).success) throw new DaemonError('E_INVALID_ARG', 'Native runtime overrides or desktop settings violate their structural contract; no settings were published.')
  if (raw !== null) for (const name of ['jira', 'gitlab', 'ai', 'weknora', 'httpApi', 'access', 'proxy', 'desktop', 'dispatch', 'acp']) {
    const value = raw[name]
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new DaemonError('E_IO', 'A native settings section is invalid; preserve the original protected data.')
  }
  // Migration preserves unknown legacy extension keys; individual native adapters
  // still validate their own fields before using them for business operations.
  const settings = mergeSettings(defaultSettings(), (raw ?? {}) as Partial<Settings>)
  if (settings.acp?.runtimeDefaults !== undefined) settings.acp = { ...settings.acp, runtimeDefaults: acpRuntimeDefaultsMapSchema.parse(settings.acp.runtimeDefaults) }
  return settings
}
/** Authenticate existing secret fields and normalize only historical ciphertext.
 * Preparation must load needed legacy keys before these synchronous calls. */
function sealSecret(value: string, encrypted: boolean): string {
  if (!encrypted) return safeStorage.encryptString(value).toString('base64')
  const ciphertext = decodeProtectedCiphertext(value)
  try {
    const plaintext = safeStorage.decryptString(ciphertext)
    return ciphertext.subarray(0, 3).equals(Buffer.from('v10')) ? safeStorage.encryptString(plaintext).toString('base64') : value
  } finally { ciphertext.fill(0) }
}
function sealSettings(settings: Settings): Settings {
  if (!safeStorage.isEncryptionAvailable()) throw new DaemonError('E_UNAVAILABLE', 'OS settings protection is unavailable; no credential change was saved.')
  const result = structuredClone(settings)
  if (result.jira.password) { result.jira.password = sealSecret(result.jira.password, result.jira.passwordEncrypted === true); result.jira.passwordEncrypted = true }
  if (result.gitlab.password) { result.gitlab.password = sealSecret(result.gitlab.password, result.gitlab.passwordEncrypted === true); result.gitlab.passwordEncrypted = true }
  if (result.ai.apiKey) { result.ai.apiKey = sealSecret(result.ai.apiKey, result.ai.apiKeyEncrypted === true); result.ai.apiKeyEncrypted = true }
  if (result.weknora.apiKey) { result.weknora.apiKey = sealSecret(result.weknora.apiKey, result.weknora.apiKeyEncrypted === true); result.weknora.apiKeyEncrypted = true }
  if (result.weknora.mcpToken) { result.weknora.mcpToken = sealSecret(result.weknora.mcpToken, result.weknora.mcpTokenEncrypted === true); result.weknora.mcpTokenEncrypted = true }
  result.ai.providers = result.ai.providers?.map((provider) => provider.apiKey ? { ...provider, apiKey: sealSecret(provider.apiKey, provider.apiKeyEncrypted === true), apiKeyEncrypted: true } : provider)
  return result
}

function encryptedSettingsSecrets(settings: Settings): string[] {
  return [
    ...(settings.jira.password && settings.jira.passwordEncrypted ? [settings.jira.password] : []),
    ...(settings.gitlab.password && settings.gitlab.passwordEncrypted ? [settings.gitlab.password] : []),
    ...(settings.ai.apiKey && settings.ai.apiKeyEncrypted ? [settings.ai.apiKey] : []),
    ...(settings.weknora.apiKey && settings.weknora.apiKeyEncrypted ? [settings.weknora.apiKey] : []),
    ...(settings.weknora.mcpToken && settings.weknora.mcpTokenEncrypted ? [settings.weknora.mcpToken] : []),
    ...(settings.ai.providers ?? []).filter(provider => provider.apiKey && provider.apiKeyEncrypted).map(provider => provider.apiKey)
  ]
}

/** Protected repository adapter: existing services keep their synchronous native interfaces. */
export class DaemonNativeState {
  private prepared = false
  private preparing: Promise<void> | undefined
  constructor(private readonly context: DaemonContext, readonly owner: ProtectedSettingsOwner) {}
  /** Await before initialize/install. No service can observe a half-prepared
   * synchronous credential port. CAS and owner checks fence publication. */
  async prepare(): Promise<void> {
    if (this.prepared) { this.owner.read(); return }
    if (this.preparing) return this.preparing
    this.preparing = (async () => {
      const current = this.owner.read() // Assert the actual protected owner before optional state preparation.
      await this.prepareDingTalk()
      const settings = normalizedSettings(current.snapshot.settings)
      const integrations = current.snapshot.integrations === null ? emptyIntegrations() : integrationStateSchema.parse(current.snapshot.integrations)
      const secrets = [...encryptedSettingsSecrets(settings), ...integrations.connections.flatMap(connection => Object.values(connection.secrets))]
      for (const secret of secrets) {
        const ciphertext = decodeProtectedCiphertext(secret)
        try { await this.context.protection.prepare(ciphertext) } finally { ciphertext.fill(0) }
      }
      const nextSettings = sealSettings(settings)
      // Keep all connection/public revisions, check results and unknown fields.
      // Changing the encryption envelope is not a provider credential edit.
      const connections = integrations.connections.map(connection => ({ ...connection, secrets: Object.fromEntries(Object.entries(connection.secrets).map(([key, value]) => [key, sealSecret(value, true)])) }))
      const original = current.snapshot.integrations
      const nextIntegrations = original === null ? null : { ...original, connections: z.array(z.record(z.string(), z.unknown())).parse(original.connections).map((connection, index) => {
        const normalized = connections[index]
        if (!normalized) throw new DaemonError('E_IO', 'The protected connection identity changed during secret normalization.')
        return { ...connection, secrets: normalized.secrets }
      }) }
      const stored = z.object({ ciphertext: z.string().max(12 * 1024 * 1024) }).passthrough().parse(JSON.parse(readBounded(join(this.context.directory, 'protected-settings.json'), 16 * 1024 * 1024)))
      const outer = decodeProtectedCiphertext(stored.ciphertext)
      let legacyOuter: boolean
      try { legacyOuter = outer.subarray(0, 3).equals(Buffer.from('v10')) } finally { outer.fill(0) }
      if (legacyOuter || comparable(current.snapshot.settings) !== comparable(nextSettings) || comparable(original) !== comparable(nextIntegrations)) {
        this.owner.update(current.revision, snapshot => { snapshot.settings = { ...nextSettings }; snapshot.integrations = nextIntegrations })
      } else if (this.owner.read().revision !== current.revision) throw new DaemonError('E_CONFLICT', 'Protected state changed during secret preparation; retry with its current owner revision.')
      this.prepared = true
    })()
    try { await this.preparing } finally { this.preparing = undefined }
  }
  private async prepareDingTalk(): Promise<void> {
    const file = join(this.context.directory, 'dingtalk-workspace-v1.protected.json')
    if (!existsSync(file)) return
    const original = readBounded(file, 32 * 1024 * 1024)
    const stored = z.object({ version: z.literal(1), ciphertext: z.string().max(32 * 1024 * 1024) }).strict().parse(JSON.parse(original))
    const ciphertext = decodeProtectedCiphertext(stored.ciphertext)
    try {
      // The shared settings/key may already be modern while this independent
      // provider envelope still needs a different historical role's key.
      await this.context.protection.prepare(ciphertext)
      if (!ciphertext.subarray(0, 3).equals(Buffer.from('v10'))) return
      const plaintext = safeStorage.decryptString(ciphertext)
      if (Buffer.byteLength(plaintext, 'utf8') > 16 * 1024 * 1024) throw new DaemonError('E_IO', 'The retained DingTalk state exceeds its protected capacity.')
      z.object({ version: z.literal(1) }).passthrough().parse(JSON.parse(plaintext))
      const text = JSON.stringify({ version: 1, ciphertext: safeStorage.encryptString(plaintext).toString('base64') })
      this.owner.read() // Synchronous owner assertion immediately before publication.
      if (readBounded(file, 32 * 1024 * 1024) !== original) throw new DaemonError('E_CONFLICT', 'The original DingTalk protected envelope changed during key preparation; no replacement was published.')
      writeAtomic(file, text)
    } finally { ciphertext.fill(0) }
  }
  private assertPrepared(): void {
    if (!this.prepared) throw new DaemonError('E_UNAVAILABLE', 'Await native state prepare() before installing or using synchronous settings and credential ports.')
    if (!this.context.protection.available()) throw new DaemonError('E_UNAVAILABLE', 'The prepared native key is no longer available; state access is closed.')
  }
  initialize(): void {
    this.assertPrepared()
    const current = this.owner.read()
    const settings = sealSettings(normalizedSettings(current.snapshot.settings))
    if (!settings.bridgeToken) settings.bridgeToken = randomBytes(16).toString('hex')
    const integrations = current.snapshot.integrations === null ? emptyIntegrations() : integrationStateSchema.parse(current.snapshot.integrations)
    if (comparable(current.snapshot.settings) !== comparable(settings) || current.snapshot.integrations === null) {
      this.owner.update(current.revision, (snapshot) => { snapshot.settings = { ...settings }; if (snapshot.integrations === null) snapshot.integrations = { ...integrations } })
    }
  }
  readSettings(): Settings { this.assertPrepared(); return mergeUi(this.context, normalizedSettings(this.owner.read().snapshot.settings)) }
  readIntegrations(): IntegrationState { this.assertPrepared(); return integrationStateSchema.parse(this.owner.read().snapshot.integrations ?? emptyIntegrations()) }
  // Install separate narrow ports; neither can accidentally be used for the other record shape.
  install(): () => void {
    this.assertPrepared()
    const settings = installSettingsPersistence({ read: () => this.readSettings(), write: (patch) => this.write(patch) })
    try {
      const integrations = installIntegrationStatePort({ read: () => this.readIntegrations(), update: (change) => this.update(change) })
      return () => { integrations(); settings() }
    } catch (error) { settings(); throw error }
  }
  write(patch: Partial<Settings>, _strict = true): Settings {
    this.assertPrepared()
    const current = this.owner.read()
    normalizedSettings({ ...current.snapshot.settings, ...patch })
    const next = sealSettings(normalizedSettings({ ...mergeSettings(mergeUi(this.context, normalizedSettings(current.snapshot.settings)), patch) }))
    this.owner.update(current.revision, (snapshot) => { snapshot.settings = { ...next } })
    return this.readSettings()
  }
  writeCommand(expectedRevision: number, commandId: string, digest: string, patch: Partial<Settings>): { revision: number; replayed: boolean } {
    this.assertPrepared()
    return this.owner.command(expectedRevision, commandId, digest, (snapshot) => {
      normalizedSettings({ ...snapshot.settings, ...patch })
      snapshot.settings = { ...sealSettings(normalizedSettings({ ...mergeSettings(mergeUi(this.context, normalizedSettings(snapshot.settings)), patch) })) }
    })
  }
  update<T>(change: (state: IntegrationState) => T): T {
    this.assertPrepared()
    const current = this.owner.read()
    const state = integrationStateSchema.parse(current.snapshot.integrations ?? emptyIntegrations())
    const result = change(state)
    const validated = integrationStateSchema.parse(state)
    if (Buffer.byteLength(JSON.stringify(validated)) > 2 * 1024 * 1024) throw new DaemonError('E_BUSY', 'Integration configuration exceeds its protected record limit.')
    this.owner.update(current.revision, (snapshot) => { snapshot.integrations = { ...validated } })
    return result
  }
}

/** Prepare only the Settings credentials consumed by synchronous GUI services.
 * This is a read-only admission barrier, including when manual mode leaves the
 * daemon absent. Provider connection secrets and ledgers remain daemon-owned. */
export async function prepareGuiNativeProjection(context: DaemonContext): Promise<void> {
  await context.protection.refresh()
  const current = readProtectedSettingsProjection(context)
  const settings = normalizedSettings(current.snapshot.settings)
  for (const secret of new Set(encryptedSettingsSecrets(settings))) {
    const ciphertext = decodeProtectedCiphertext(secret)
    try {
      await context.protection.prepare(ciphertext)
      // Key availability/header checks alone do not authenticate modern TPD1
      // fields. Always decrypt the actual value before enabling GUI consumers.
      context.protection.decrypt(ciphertext)
    } finally { ciphertext.fill(0) }
  }
  const latest = readProtectedSettingsProjection(context)
  if (latest.revision !== current.revision || comparable(latest.snapshot.settings) !== comparable(current.snapshot.settings)) throw new DaemonError('E_CONFLICT', 'Protected Settings changed while GUI credentials were being prepared; retry the current read-only projection before enabling local consumers.')
}

/** GUI is a reader of runtime/integration state, and sole writer of its separate UI preferences. */
export function installGuiNativeState(context: DaemonContext): () => void {
  if (!context.protection.available()) throw new DaemonError('E_UNAVAILABLE', 'Prepare the shared native key before installing GUI projection readers.')
  const read = (): Settings => mergeUi(context, normalizedSettings(readProtectedSettingsProjection(context).snapshot.settings))
  const settings = installSettingsPersistence({ read, write(patch) {
    const current = read()
    for (const key of Object.keys(patch) as Array<keyof Settings>) {
      if (patch[key] !== undefined && !(UI_KEYS as readonly string[]).includes(key) && comparable(patch[key]) !== comparable(current[key])) {
        throw new DaemonError('E_UNAVAILABLE', 'Runtime settings must be changed through their native daemon command; GUI-only settings cannot overwrite them.')
      }
    }
    const previous = uiPreferences(context)
    const merged = mergeSettings(current, patch)
    const next = uiPreferencesSchema.parse({ version: 1, revision: previous.revision + 1, recentProjects: merged.recentProjects, theme: merged.theme, desktop: merged.desktop })
    writeAtomic(join(context.directory, 'desktop-preferences.json'), JSON.stringify(next))
    return read()
  } })
  try {
    const integrations = installIntegrationStatePort({
      read: () => integrationStateSchema.parse(readProtectedSettingsProjection(context).snapshot.integrations ?? emptyIntegrations()),
      update() { throw new DaemonError('E_UNAVAILABLE', 'Integration changes belong to the daemon owner; the GUI has read-only configuration access.') }
    })
    return () => { integrations(); settings() }
  } catch (error) { settings(); throw error }
}
