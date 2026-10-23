import { protectedStorage as safeStorage } from './protected-storage'
import { connectionFields, INTEGRATION_CATALOG, secretPatchSchema } from '../../shared/integrations'
import type { ProtectedSettingsOwner } from './settings-owner'
import { integrationStateSchema } from '../services/integrations/stored-schema'
import { DaemonError } from './errors'

/** Native credential port: decrypted values live only inside an adapter callback. */
export class ProtectedCredentialPort {
  constructor(private readonly settings: ProtectedSettingsOwner) {}
  presence(connectionId: string, connectionRevision: number): string[] {
    const snapshot = this.settings.read().snapshot
    const state = integrationStateSchema.parse(snapshot.integrations)
    const connection = state.connections.find((entry) => entry.id === connectionId && !entry.deleted)
    if (!connection || connection.revision !== connectionRevision) throw new DaemonError('E_CONFLICT', 'Connection identity/revision changed.')
    return Object.keys(connection.secrets).filter((key) => Boolean(connection.secrets[key]))
  }
  withSecrets<T>(connectionId: string, connectionRevision: number, use: (secrets: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
    const snapshot = this.settings.read().snapshot
    const state = integrationStateSchema.parse(snapshot.integrations)
    const connection = state.connections.find((entry) => entry.id === connectionId && !entry.deleted)
    if (!connection || connection.revision !== connectionRevision || !connection.enabled) throw new DaemonError('E_CONFLICT', 'The original enabled connection revision is no longer available.')
    if (!safeStorage.isEncryptionAvailable()) throw new DaemonError('E_UNAVAILABLE', 'Protected provider credentials are locked.')
    const secrets: Record<string, string> = {}
    try { for (const [key, value] of Object.entries(connection.secrets)) secrets[key] = safeStorage.decryptString(Buffer.from(value, 'base64')) }
    catch { throw new DaemonError('E_DENIED', 'Provider credentials cannot be decrypted. Reauthorize this connection without exporting secrets.') }
    return use(Object.freeze(secrets))
  }
  patch(input: { settingsRevision: number; connectionId: string; connectionRevision: number; secrets: Record<string, unknown> }): number {
    if (!safeStorage.isEncryptionAvailable()) throw new DaemonError('E_UNAVAILABLE', 'OS credential protection is unavailable; no secret was changed.')
    return this.settings.update(input.settingsRevision, (snapshot) => {
      const state = integrationStateSchema.parse(snapshot.integrations)
      const connection = state.connections.find((entry) => entry.id === input.connectionId && !entry.deleted)
      if (!connection || connection.revision !== input.connectionRevision) throw new DaemonError('E_CONFLICT', 'Connection changed before credential edit.')
      const manifest = INTEGRATION_CATALOG.find((entry) => entry.id === connection.providerId)
      if (!manifest) throw new DaemonError('E_UNAVAILABLE', 'The credential capability is not registered.')
      const keys = new Set(connectionFields(manifest, connection.config).filter((field) => field.secret).map((field) => field.key))
      // OAuth access/refresh/expiry/issuer/client remains one existing protected bundle.
      if (connection.providerId === 'gitlab' && connection.config.authMethod === 'oauth2') keys.add('oauthTokens')
      for (const [key, raw] of Object.entries(input.secrets)) {
        if (!keys.has(key)) throw new DaemonError('E_DENIED', 'Credential field is not declared for this connection capability.')
        const patch = secretPatchSchema.parse(raw)
        if (patch.op === 'clear') delete connection.secrets[key]
        if (patch.op === 'replace') connection.secrets[key] = safeStorage.encryptString(patch.value).toString('base64')
      }
      connection.revision++; connection.checkedAt = null; connection.check = 'unverified'; connection.detail = ''
      const original = snapshot.integrations?.connections
      if (!snapshot.integrations || !Array.isArray(original)) throw new DaemonError('E_IO', 'The protected connection record has an invalid shape.')
      snapshot.integrations.connections = original.map((raw: unknown) => raw && typeof raw === 'object' && 'id' in raw && raw.id === connection.id
        ? { ...raw, secrets: connection.secrets, revision: connection.revision, checkedAt: null, check: 'unverified', detail: '' }
        : raw)
    })
  }
}
