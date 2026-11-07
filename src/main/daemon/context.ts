import { app } from 'electron'
import { protectedStorage as safeStorage, installProtectedStorage } from './protected-storage'
import { NativeProtection, decodeProtectedCiphertext } from './protection'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { daemonIdentitySchema, type DaemonIdentity, type ProcessOwner } from '../../shared/daemon'
import { processIdentity, protectDirectory } from './native'
import { readBounded, writeAtomic } from './files'
import { DaemonError } from './errors'
import { readLease, reconcileStaleLease, verifiedLease, type DaemonLease } from './lease'
import { z } from 'zod'

export interface DaemonContext {
  identity: DaemonIdentity
  owner: ProcessOwner
  userData: string
  directory: string
  pipeName: string
  protection: NativeProtection
  credential(): string
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function assertExistingDirectory(directory: string): void {
  const entry = lstatSync(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new DaemonError('E_DENIED', 'Historical daemon control requires existing directories without redirection.')
}
/** Private construction detail only; public ordinary callers cannot select the
 * historical purpose or skip their compatibility/admission barriers. */
async function createContextBase(purpose: 'ordinary' | 'historical-control'): Promise<DaemonContext> {
  if (!app.isReady()) throw new DaemonError('E_UNAVAILABLE', 'Daemon context requires Electron readiness.')
  const owner = await processIdentity(process.pid)
  if (!owner) throw new DaemonError('E_UNAVAILABLE', 'The current native process identity is unavailable.')
  const userData = resolve(app.getPath('userData'))
  if (purpose === 'ordinary') mkdirSync(userData, { recursive: true })
  else assertExistingDirectory(userData)
  const canonical = realpathSync(userData)
  const mode = app.isPackaged ? 'production' : 'development'
  const profileId = digest(`${owner.userId}\0${canonical.toLowerCase()}\0${mode}`)
  const directory = join(canonical, 'daemon-v1', mode)
  if (purpose === 'ordinary') mkdirSync(directory, { recursive: true })
  else { assertExistingDirectory(join(canonical, 'daemon-v1')); assertExistingDirectory(directory) }
  if (lstatSync(join(canonical, 'daemon-v1')).isSymbolicLink() || lstatSync(directory).isSymbolicLink()) throw new DaemonError('E_DENIED', 'The daemon state directory cannot be redirected.')
  if (purpose === 'ordinary') {
    await protectDirectory(join(canonical, 'daemon-v1'))
    await protectDirectory(directory)
  }
  const identity = daemonIdentitySchema.parse({ profileId, userId: owner.userId, mode, appVersion: app.getVersion(), installationId: digest(realpathSync(app.getAppPath()).toLowerCase()) })
  const protection = new NativeProtection(directory, canonical, profileId)
  await protection.initialize()
  const context: DaemonContext = {
    identity, owner, userData: canonical, directory, protection, pipeName: `trellis-daemon-v1-${profileId}`,
    credential() {
      const file = join(directory, 'native-credential')
      if (!existsSync(file)) throw new DaemonError('E_UNAVAILABLE', 'The daemon has not created a native bootstrap credential. Start the daemon first.')
      try {
        const ciphertext = decodeProtectedCiphertext(readBounded(file, 8192), 8192)
        try {
          const value = protection.decrypt(ciphertext)
          if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid')
          return value
        } finally { ciphertext.fill(0) }
      } catch { throw new DaemonError('E_DENIED', 'The native daemon credential cannot be decrypted in this Windows profile. Preserve state and repair the installation.') }
    }
  }
  return context
}
export async function createDaemonContext(): Promise<DaemonContext> {
  const context = await createContextBase('ordinary')
  const { directory, protection, userData: canonical } = context
  // A daemon can acquire its lease and then fail before the role host reaches
  // its authenticated run loop. Reconcile that dead owner before preparing
  // the old credential; otherwise the failed credential path can prevent the
  // normal acquireLease stale-owner cleanup and trap every later startup.
  await reconcileStaleLease(context)
  const credentialFile = join(directory, 'native-credential')
  if (existsSync(credentialFile)) {
    const ciphertext = decodeProtectedCiphertext(readBounded(credentialFile, 8192), 8192)
    try {
      // An older live owner cannot consume the shared format. Leave its lease,
      // bootstrap secret and role keys intact for its original controller.
      if (!protection.available() && ciphertext.subarray(0, 3).equals(Buffer.from('v10')) && await verifiedLease(context)) throw new DaemonError('E_VERSION', 'A running daemon still owns the historical protection format. Stop it with its original compatible controller before upgrading; no owner or credential was replaced.')
      await protection.prepare(ciphertext)
    } finally { ciphertext.fill(0) }
    context.credential() // Validate the historical secret before installing readers.
  }
  // Only outer envelopes needed by synchronous native readers are prepared
  // here. Individual provider secrets wait for the daemon state barrier.
  const checkpointFile = join(canonical, 'daemon-v1', 'settings-owner.json')
  const phase = existsSync(checkpointFile) ? z.object({ phase: z.enum(['prepared', 'daemon']) }).passthrough().parse(JSON.parse(readBounded(checkpointFile, 8192))).phase : 'legacy'
  const envelopes = [join(directory, 'protected-settings.json'), ...(phase !== 'daemon' ? [join(directory, 'migration-original.protected.json')] : [])]
  for (const file of envelopes) {
    if (!existsSync(file)) continue
    const stored = z.object({ version: z.literal(1), ciphertext: z.string().max(12 * 1024 * 1024) }).passthrough().parse(JSON.parse(readBounded(file, 16 * 1024 * 1024)))
    const ciphertext = decodeProtectedCiphertext(stored.ciphertext)
    try { await protection.prepare(ciphertext) } finally { ciphertext.fill(0) }
  }
  const releaseFile = join(directory, 'native-cutover.protected')
  if (phase !== 'daemon' && existsSync(releaseFile)) {
    const ciphertext = decodeProtectedCiphertext(readBounded(releaseFile, 16384), 16384)
    try { await protection.prepare(ciphertext) } finally { ciphertext.fill(0) }
  }
  installProtectedStorage(protection)
  return context
}

export interface HistoricalControlContext extends DaemonContext {
  readonly historicalLease: DaemonLease
  /** Read-only file fence remains usable after the original owner releases its lease. */
  assertHistoricalFiles(): void
  /** Synchronous fences used again immediately before submitting explicit stop. */
  assertHistorical(): void
}
/** Read-only compatibility capability. Does not publish a shared key, install
 * protected storage, prepare settings, acquire a lease or change directory ACLs.
 * The returned context is used only by the explicit historical status/stop facade. */
export async function createHistoricalControlContext(): Promise<HistoricalControlContext> {
  const context = await createContextBase('historical-control')
  const lease = await verifiedLease(context)
  if (!lease) throw new DaemonError('E_UNAVAILABLE', 'No verified historical daemon owner is running; inspection did not start or replace one.')
  const file = join(context.directory, 'native-credential')
  const original = readBounded(file, 8192)
  const sharedKey = join(context.directory, 'native-protection-key-v1.json')
  const assertHistoricalFiles = (): void => {
    assertExistingDirectory(context.userData)
    assertExistingDirectory(join(context.userData, 'daemon-v1'))
    assertExistingDirectory(context.directory)
    // NativeProtection reads only these historical role metadata locations.
    // Reject redirected parents before it can read/unwrap any role key.
    for (const role of ['gui', 'daemon']) {
      const directory = join(context.directory, role)
      try { assertExistingDirectory(directory) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    let sharedKeyPresent = true
    try { lstatSync(sharedKey) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') sharedKeyPresent = false; else throw error }
    if (sharedKeyPresent) throw new DaemonError('E_VERSION', 'Shared protection is already present; use the compatible daemon controller rather than historical control.')
    if (readBounded(file, 8192) !== original) throw new DaemonError('E_CONFLICT', 'The captured historical daemon credential changed; no replacement credential was accepted.')
  }
  const assertHistorical = (): void => {
    assertHistoricalFiles()
    if (JSON.stringify(readLease(context)) !== JSON.stringify(lease)) throw new DaemonError('E_CONFLICT', 'The captured historical daemon lease changed; no replacement owner was accepted.')
  }
  const ciphertext = decodeProtectedCiphertext(original, 8192)
  try {
    if (!ciphertext.subarray(0, 3).equals(Buffer.from('v10'))) throw new DaemonError('E_VERSION', 'Historical control requires the existing v10 native credential; no format was changed.')
    assertHistorical()
    await context.protection.prepare(ciphertext)
    assertHistorical()
    context.credential() // Actual authenticated decryption; no rewrapping.
    const current = await verifiedLease(context)
    if (!current || JSON.stringify(current) !== JSON.stringify(lease)) throw new DaemonError('E_CONFLICT', 'The historical owner changed during read-only credential preparation.')
    assertHistorical()
    return { ...context, historicalLease: lease, assertHistoricalFiles, assertHistorical }
  } finally { ciphertext.fill(0) }
}
/** Called only after the daemon role lock and verified lease have been acquired. */
export async function ensureDaemonCredential(context: DaemonContext, assertOwner: () => void): Promise<void> {
  await context.protection.ensure(assertOwner)
  const file = join(context.directory, 'native-credential')
  if (existsSync(file)) {
    const original = readBounded(file, 8192)
    const ciphertext = decodeProtectedCiphertext(original, 8192)
    try {
      await context.protection.prepare(ciphertext)
      assertOwner()
      if (readBounded(file, 8192) !== original) throw new DaemonError('E_CONFLICT', 'The original native credential changed during protection preparation; no replacement was published.')
      const value = context.credential()
      if (ciphertext.subarray(0, 3).equals(Buffer.from('v10'))) {
        const text = safeStorage.encryptString(value).toString('base64')
        assertOwner(); writeAtomic(file, text)
      }
    } finally { ciphertext.fill(0) }
    return
  }
  if (!safeStorage.isEncryptionAvailable()) throw new DaemonError('E_UNAVAILABLE', 'OS credential protection is unavailable; daemon startup is blocked.')
  const credential = randomBytes(32)
  try {
    const text = safeStorage.encryptString(credential.toString('hex')).toString('base64')
    assertOwner(); writeAtomic(file, text)
  } finally { credential.fill(0) }
}
