import { protectedStorage as safeStorage } from './protected-storage'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema, type ProcessOwner } from '../../shared/daemon'
import { readBounded, writeAtomic, writeExclusive } from './files'
import { DaemonError } from './errors'
import type { DaemonContext } from './context'
import { processIdentity, sameOwner } from './native'
import { integrationStateSchema, integrationStateV1Schema } from '../services/integrations/stored-schema'

const checkpointSchema = z.object({
  version: z.literal(1), phase: z.enum(['prepared', 'daemon']), commandId: z.string().uuid(),
  legacyOwner: processOwnerSchema, profileId: z.string().length(64),
  sources: z.object({ settings: z.string().length(64).nullable(), integrations: z.string().length(64).nullable() }),
  at: z.number().int().nonnegative()
}).strict()
const settingsCommandSchema = z.object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive().safe(), at: z.number().int().nonnegative().safe() }).strict()
const protectedStateSchema = z.object({ version: z.literal(1), revision: z.number().int().positive().safe(), checkpointCommandId: z.string().uuid(), ciphertext: z.string().max(12 * 1024 * 1024), commands: z.array(settingsCommandSchema).max(500).default([]) }).strict().superRefine((value, context) => {
  if (new Set(value.commands.map((command) => command.id)).size !== value.commands.length || value.commands.some((command) => command.revision > value.revision)) context.addIssue({ code: 'custom', message: 'Protected settings command history is inconsistent' })
})
export interface LegacyDrainPort {
  /** Lifecycle child fences all old admission/CLI writers and validates its actual original owner. */
  assertExclusive(input: { legacyOwner: ProcessOwner; commandId: string }): Promise<{ liveReleased?: true } | void>
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const snapshotSchema = z.object({ settings: z.record(z.string(), z.unknown()).nullable(), integrations: z.record(z.string(), z.unknown()).nullable() }).strict()
export type ProtectedSnapshot = z.infer<typeof snapshotSchema>

function checkpointPath(userData: string): string { return join(userData, 'daemon-v1', 'settings-owner.json') }

/** Read-only native projection for the authorized GUI host; never registered as a renderer RPC. */
export function readProtectedSettingsProjection(context: DaemonContext): { revision: number; snapshot: ProtectedSnapshot } {
  const checkpoint = checkpointSchema.parse(JSON.parse(readBounded(checkpointPath(context.userData), 8192)))
  if (checkpoint.profileId !== context.identity.profileId) throw new DaemonError('E_DENIED', 'Settings belong to a different native profile.')
  if (checkpoint.phase !== 'daemon') throw new DaemonError('E_UNAVAILABLE', 'Settings ownership is still being prepared; reconcile the original migration.')
  const stored = protectedStateSchema.parse(JSON.parse(readBounded(join(context.directory, 'protected-settings.json'), 16 * 1024 * 1024)))
  if (stored.checkpointCommandId !== checkpoint.commandId || !safeStorage.isEncryptionAvailable()) throw new DaemonError('E_DENIED', 'The protected settings projection is locked or has a different checkpoint.')
  try { return { revision: stored.revision, snapshot: snapshotSchema.parse(JSON.parse(safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64')))) } }
  catch { throw new DaemonError('E_DENIED', 'The native settings projection cannot be decrypted; preserve its checkpoint and original data.') }
}
/** Synchronous legacy fence. No daemon cache, network request or ownership claim. */
export function assertLegacySettingsWriter(userData: string): void {
  const path = checkpointPath(userData)
  if (!existsSync(path)) return
  try { checkpointSchema.parse(JSON.parse(readBounded(path, 8192))) }
  catch { throw new DaemonError('E_UNAVAILABLE', 'The daemon settings migration checkpoint cannot be read. Preserve files and repair ownership before editing settings.') }
  throw new DaemonError('E_UNAVAILABLE', 'These settings are fenced by a daemon migration. Use the daemon settings broker from a compatible application; legacy writes are disabled.')
}

/** Native-only repository. No decrypted snapshot or secret accessor is a protocol method. */
export class ProtectedSettingsOwner {
  constructor(private readonly context: DaemonContext, private readonly assertOwner: () => void) {}
  authority(): 'legacy' | 'prepared' | 'daemon' {
    const path = checkpointPath(this.context.userData)
    if (!existsSync(path)) return 'legacy'
    const checkpoint = checkpointSchema.parse(JSON.parse(readBounded(path, 8192)))
    if (checkpoint.profileId !== this.context.identity.profileId) throw new DaemonError('E_DENIED', 'The settings checkpoint belongs to a different profile.')
    return checkpoint.phase
  }
  private protect(value: ProtectedSnapshot, revision: number, checkpointCommandId: string, commands: z.infer<typeof settingsCommandSchema>[] = []): string {
    if (!safeStorage.isEncryptionAvailable()) throw new DaemonError('E_UNAVAILABLE', 'OS protected storage is unavailable. Settings ownership has not been transferred.')
    const ciphertext = safeStorage.encryptString(JSON.stringify(snapshotSchema.parse(value))).toString('base64')
    return JSON.stringify(protectedStateSchema.parse({ version: 1, revision, checkpointCommandId, ciphertext, commands }))
  }
  private file(): string { return join(this.context.directory, 'protected-settings.json') }
  read(): { revision: number; snapshot: ProtectedSnapshot } {
    this.assertOwner()
    return readProtectedSettingsProjection(this.context)
  }
  update(expectedRevision: number, change: (snapshot: ProtectedSnapshot) => void): number {
    const current = this.read()
    if (current.revision !== expectedRevision) throw new DaemonError('E_CONFLICT', 'Protected settings changed; reload the daemon-owned revision.')
    change(current.snapshot)
    const checkpoint = checkpointSchema.parse(JSON.parse(readBounded(checkpointPath(this.context.userData), 8192)))
    const stored = protectedStateSchema.parse(JSON.parse(readBounded(this.file(), 16 * 1024 * 1024)))
    if (stored.revision !== current.revision) throw new DaemonError('E_CONFLICT', 'Protected settings changed during the original native mutation.')
    const text = this.protect(current.snapshot, current.revision + 1, checkpoint.commandId, stored.commands)
    this.assertOwner(); writeAtomic(this.file(), text)
    return current.revision + 1
  }
  /** Settings effect and its idempotency receipt are one protected publication. */
  command(expectedRevision: number, commandId: string, digest: string, change: (snapshot: ProtectedSnapshot) => void): { revision: number; replayed: boolean } {
    z.string().uuid().parse(commandId)
    z.string().regex(/^[a-f0-9]{64}$/).parse(digest)
    const current = this.read()
    const stored = protectedStateSchema.parse(JSON.parse(readBounded(this.file(), 16 * 1024 * 1024)))
    const existing = stored.commands.find((item) => item.id === commandId)
    if (existing) {
      if (existing.digest !== digest) throw new DaemonError('E_CONFLICT', 'This native settings command ID has a different payload.')
      return { revision: existing.revision, replayed: true }
    }
    if (stored.revision !== current.revision || current.revision !== expectedRevision) throw new DaemonError('E_CONFLICT', 'Reload the current protected settings revision before changing it.')
    change(current.snapshot)
    const checkpoint = checkpointSchema.parse(JSON.parse(readBounded(checkpointPath(this.context.userData), 8192)))
    const revision = current.revision + 1
    const commands = [...stored.commands.slice(-499), { id: commandId, digest, revision, at: Date.now() }]
    this.assertOwner()
    writeAtomic(this.file(), this.protect(current.snapshot, revision, checkpoint.commandId, commands))
    return { revision, replayed: false }
  }
  /** Deliberately not exposed over RPC. Lifecycle must supply a real drain port. */
  async migrate(input: { commandId: string; legacyOwner: ProcessOwner }, drain: LegacyDrainPort): Promise<void> {
    this.assertOwner()
    const released = await drain.assertExclusive(input)
    const actual = await processIdentity(input.legacyOwner.pid)
    if (actual && sameOwner(actual, input.legacyOwner) && !released?.liveReleased) throw new DaemonError('E_CONFLICT', 'The original GUI/runtime owner has not released admission and settings writers. Do not transfer settings authority.')
    this.assertOwner()
    const settingsFile = join(this.context.userData, 'settings.json')
    const integrationsFile = join(this.context.userData, 'integrations.json')
    const settings = existsSync(settingsFile) ? readBounded(settingsFile, 2 * 1024 * 1024) : null
    const integrations = existsSync(integrationsFile) ? readBounded(integrationsFile, 2 * 1024 * 1024) : null
    const sources = { settings: settings === null ? null : hash(settings), integrations: integrations === null ? null : hash(integrations) }
    const originalSnapshot = snapshotSchema.parse({ settings: settings === null ? null : JSON.parse(settings), integrations: integrations === null ? null : JSON.parse(integrations) })
    const snapshot = structuredClone(originalSnapshot)
    // Keep unknown settings keys verbatim; an explicit version must be understood before adoption.
    if (snapshot.settings && 'version' in snapshot.settings) throw new DaemonError('E_VERSION', 'Versioned legacy settings require a dedicated migration adapter.')
    if (snapshot.integrations?.version === 1) {
      integrationStateV1Schema.parse(snapshot.integrations)
      snapshot.integrations = { ...snapshot.integrations, version: 2, legacyImports: {} }
    }
    if (snapshot.integrations && snapshot.integrations.version !== 2) throw new DaemonError('E_VERSION', 'This legacy integration state version is unsupported. Preserve it and use a compatible migration adapter.')
    if (snapshot.integrations) integrationStateSchema.parse(snapshot.integrations)
    if (snapshot.settings) for (const key of ['jira', 'gitlab', 'ai', 'weknora', 'proxy', 'dispatch']) {
      const value = snapshot.settings[key]
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new DaemonError('E_INVALID_ARG', 'Legacy settings contain an invalid runtime/integration section. Preserve and repair the original file.')
    }
    const path = checkpointPath(this.context.userData)
    const previous = existsSync(path) ? checkpointSchema.parse(JSON.parse(readBounded(path, 8192))) : null
    if (previous && (previous.commandId !== input.commandId || previous.profileId !== this.context.identity.profileId || JSON.stringify(previous.sources) !== JSON.stringify(sources))) throw new DaemonError('E_CONFLICT', 'A different or changed settings migration is already checkpointed. Reconcile the original command.')
    if (previous?.phase === 'daemon') { this.read(); return }
    const protectedText = this.protect(snapshot, 1, input.commandId)
    const checkpoint = checkpointSchema.parse({ version: 1, phase: 'prepared', ...input, profileId: this.context.identity.profileId, sources, at: previous?.at ?? Date.now() })
    if (previous) writeAtomic(path, JSON.stringify(checkpoint))
    else writeExclusive(path, JSON.stringify(checkpoint)) // One fence across modes sharing the actual same legacy userData.
    const originalFile = join(this.context.directory, 'migration-original.protected.json')
    if (!existsSync(originalFile)) writeExclusive(originalFile, this.protect(originalSnapshot, 1, input.commandId))
    else {
      const original = protectedStateSchema.parse(JSON.parse(readBounded(originalFile, 16 * 1024 * 1024)))
      if (original.checkpointCommandId !== input.commandId || JSON.stringify(snapshotSchema.parse(JSON.parse(safeStorage.decryptString(Buffer.from(original.ciphertext, 'base64'))))) !== JSON.stringify(originalSnapshot)) throw new DaemonError('E_CONFLICT', 'The retained protected original does not match this migration checkpoint.')
    }
    writeAtomic(this.file(), protectedText)
    await drain.assertExclusive(input)
    const after = { settings: existsSync(settingsFile) ? hash(readBounded(settingsFile, 2 * 1024 * 1024)) : null, integrations: existsSync(integrationsFile) ? hash(readBounded(integrationsFile, 2 * 1024 * 1024)) : null }
    if (JSON.stringify(after) !== JSON.stringify(sources)) throw new DaemonError('E_CONFLICT', 'Legacy settings changed during migration; the prepared fence remains in place for reconciliation.')
    this.assertOwner(); writeAtomic(path, JSON.stringify({ ...checkpoint, phase: 'daemon' }))
  }
}
