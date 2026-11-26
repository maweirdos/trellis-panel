import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { DaemonContext } from './context'
import { assertLease, readLease } from './lease'
import { daemonLeaseSchema, type DaemonLease } from './lease-schema'
import { readBounded, writeExclusiveAtomic } from './files'
import { DaemonError } from './errors'

const BUILD_BYTES = 128 * 1024 * 1024
const STAMP_BYTES = 16 * 1024
const buildStampSchema = z.object({
  version: z.literal(1), lease: daemonLeaseSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: z.number().int().nonnegative().safe(),
  idleStopVersion: z.literal(1)
}).strict()
export type DaemonBuild = { sha256: string; modifiedAt: number; capturedAt: number; fingerprint: string }
export type DaemonBuildFreshness = { state: 'current' | 'changed' | 'unknown'; idleStop: boolean; ownerSha256?: string; currentSha256?: string }
const fingerprint = (entry: BigIntStats): string => [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs, entry.birthtimeNs].join(':')
function bundleFile(): string {
  const root = dirname(dirname(__dirname))
  if (['app.asar', 'app.asar.unpacked'].includes(basename(root))) {
    const canonical = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    if (!process.resourcesPath || canonical(dirname(root)) !== canonical(process.resourcesPath)) throw new DaemonError('E_DENIED', 'The daemon bundle is outside its fixed packaged resources directory.')
    // electron-builder marks this exact role bundle unpacked. Stat and hash the
    // same physical file, never an ASAR virtual inode versus an extracted fd.
    return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'daemon-host.js')
  }
  return join(__dirname, 'daemon-host.js')
}
function bundleEntry(): BigIntStats {
  const entry = lstatSync(bundleFile(), { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink()) throw new DaemonError('E_DENIED', 'The daemon output bundle must be a regular file without redirection.')
  if (entry.size > BigInt(BUILD_BYTES)) throw new DaemonError('E_VERSION', 'The daemon output bundle exceeds its build limit.')
  return entry
}
let expectedBuild: DaemonBuild | undefined
/** No TTL or package-version cache: every check stats the actual output. Only
 * unchanged file identity/metadata reuses a hash; rewrites invalidate it. */
function expectedDaemonBuild(): DaemonBuild {
  const entry = bundleEntry()
  if (!expectedBuild || expectedBuild.fingerprint !== fingerprint(entry)) expectedBuild = captureDaemonBuild()
  return { ...expectedBuild }
}

/** Fixed sibling OUTPUT bundle, shared by GUI/control and host composition. */
export function captureDaemonBuild(): DaemonBuild {
  const file = bundleFile()
  const entry = bundleEntry()
  const fd = openSync(file, 'r')
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || fingerprint(before) !== fingerprint(entry)) throw new DaemonError('E_VERSION', 'The daemon output bundle changed identity while opening it.')
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes = 0
    while (true) {
      const size = readSync(fd, buffer, 0, buffer.length, null)
      if (!size) break
      bytes += size
      if (bytes > BUILD_BYTES) throw new DaemonError('E_VERSION', 'The daemon output bundle changed beyond its build limit.')
      hash.update(buffer.subarray(0, size))
    }
    const after = fstatSync(fd, { bigint: true }), current = bundleEntry()
    if (BigInt(bytes) !== before.size || fingerprint(before) !== fingerprint(after) || fingerprint(current) !== fingerprint(after)) throw new DaemonError('E_VERSION', 'The daemon output bundle changed while hashing. Finish the build before attaching.')
    return { sha256: hash.digest('hex'), modifiedAt: Number(after.mtimeMs), capturedAt: Date.now(), fingerprint: fingerprint(after) }
  } finally { closeSync(fd) }
}

function stampFile(context: DaemonContext, lease: DaemonLease): string {
  // Validate before using epoch/nonce in a filename. Keep it outside owner/ so
  // unchanged strict v1 lease acquisition/release can still reconcile old hosts.
  const parsed = daemonLeaseSchema.parse(lease)
  return join(context.directory, `daemon-build-${parsed.epoch}-${parsed.nonce}.json`)
}
function ownerStartedAt(lease: DaemonLease): number {
  // Windows process identity stores UTC DateTime ticks, not Unix milliseconds.
  if (!/^\d{17,19}$/.test(lease.owner.startedAt)) throw new DaemonError('E_VERSION', 'The daemon process creation timestamp cannot prove build freshness.')
  return Number((BigInt(lease.owner.startedAt) - 621355968000000000n) / 10000n)
}
export function publishDaemonBuild(context: DaemonContext, lease: DaemonLease, build: DaemonBuild): void {
  assertLease(context, lease)
  const startedAt = ownerStartedAt(lease)
  // A file replaced after process creation cannot prove which bytes Node loaded.
  if (build.modifiedAt > startedAt || build.capturedAt < startedAt || build.capturedAt > lease.acquiredAt) throw new DaemonError('E_VERSION', 'The daemon bundle changed during owner startup. Preserve its lease and finish the build before starting again.')
  const stamp = buildStampSchema.parse({ version: 1, lease, sha256: build.sha256, capturedAt: build.capturedAt, idleStopVersion: 1 })
  writeExclusiveAtomic(stampFile(context, lease), JSON.stringify(stamp))
}
export function currentDaemonBuild(): DaemonBuild { return expectedDaemonBuild() }
export function daemonBuildFreshness(context: DaemonContext, lease: DaemonLease, expected = expectedDaemonBuild()): DaemonBuildFreshness {
  const checkLease = (): void => {
    if (JSON.stringify(readLease(context)) !== JSON.stringify(lease) || JSON.stringify(lease.identity) !== JSON.stringify(context.identity)) throw new DaemonError('E_CONFLICT', 'Daemon ownership changed during build verification. Reconnect to the original owner.')
  }
  const checkBundle = (): void => {
    if (expected.fingerprint !== fingerprint(bundleEntry())) throw new DaemonError('E_VERSION', 'The daemon output changed during build verification. Finish the build before attaching or submitting work.')
  }
  checkLease()
  let stamp: z.infer<typeof buildStampSchema>
  try { stamp = buildStampSchema.parse(JSON.parse(readBounded(stampFile(context, lease), STAMP_BYTES))) }
  catch (error) {
    checkLease()
    checkBundle()
    if (error instanceof DaemonError && error.code === 'E_DENIED') throw error
    // Even an older bundle mtime is not proof that an unstamped legacy process
    // loaded the current bytes. Never upgrade this uncertainty to readiness.
    return { state: 'unknown', idleStop: false, currentSha256: expected.sha256 }
  }
  checkLease()
  checkBundle()
  if (JSON.stringify(stamp.lease) !== JSON.stringify(lease) || stamp.capturedAt < ownerStartedAt(lease) || stamp.capturedAt > lease.acquiredAt) return { state: 'unknown', idleStop: false, ownerSha256: stamp.sha256, currentSha256: expected.sha256 }
  return { state: stamp.sha256 === expected.sha256 ? 'current' : 'changed', idleStop: true, ownerSha256: stamp.sha256, currentSha256: expected.sha256 }
}
export function requireCurrentDaemonBuild(context: DaemonContext, lease: DaemonLease): void {
  if (daemonBuildFreshness(context, lease).state !== 'current') throw new DaemonError('E_VERSION', 'The running daemon build is outdated or unverified. Background work is preserved. Inspect native daemon status; after work finishes, explicitly run the same installation with --trellis-role=control --trellis-command=stop, then retry startup.')
}
