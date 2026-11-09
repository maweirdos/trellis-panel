import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { CUTOVER_FILE_LIMITS, CutoverInstallerError, type CutoverFileObservation, type CutoverPhysicalIdentity } from './types'

export function fileDigest(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }
export function pathFailure(message: string): never { throw new CutoverInstallerError('CUTOVER_PATH_CHANGED', message) }
export function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
export function fileStat(path: string): BigIntStats | null {
  try { return lstatSync(path, { bigint: true }) } catch (error) { if (isMissing(error)) return null; throw error }
}
export function physicalIdentity(path: string, stat: BigIntStats): CutoverPhysicalIdentity { return { path, device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeNs) } }
export function sameIdentity(identity: CutoverPhysicalIdentity, stat: BigIntStats): boolean { return identity.device === String(stat.dev) && identity.inode === String(stat.ino) && identity.birthtime === String(stat.birthtimeNs) }
function sameRead(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink }

/** ASCII components exclude Windows short names, streams, device names and normalization aliases. */
export function validateRelativePath(value: string): string {
  const parts = value.split('/')
  if (!value || value.length > 240 || parts.length > CUTOVER_FILE_LIMITS.components || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'A cutover path is not a canonical bounded relative path')
  return value
}
export function within(parent: string, candidate: string): boolean { const path = relative(parent, candidate); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)) }
export function boundedEntries(path: string): string[] {
  const directory = opendirSync(path), names: string[] = []
  try {
    for (;;) { const entry = directory.readSync(); if (!entry) break; names.push(entry.name); if (names.length > CUTOVER_FILE_LIMITS.directoryEntries) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Directory entry inspection budget exceeded') }
  } finally { directory.closeSync() }
  return names
}
function exactEntry(path: string): void {
  if (process.platform !== 'win32') return
  const name = basename(path), entries = boundedEntries(dirname(path))
  if (!entries.includes(name) && entries.some(entry => entry.toLowerCase() === name.toLowerCase())) pathFailure('A Windows path uses a case alias')
  if (!entries.includes(name) && fileStat(path)) pathFailure('A Windows path uses a filesystem alias')
}
export function assertDirectory(identity: CutoverPhysicalIdentity): void {
  const stat = fileStat(identity.path)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(identity, stat) || realpathSync.native(identity.path) !== identity.path) pathFailure('A retained directory was redirected or physically replaced')
  exactEntry(identity.path)
}
export function captureDirectory(path: string): CutoverPhysicalIdentity {
  const stat = fileStat(path)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(path) !== path) pathFailure('Directory must be existing, physical and canonically spelled')
  exactEntry(path)
  return physicalIdentity(path, stat)
}
export function captureDirectoryTree(selected: string): CutoverPhysicalIdentity[] {
  if (!isAbsolute(selected) || resolve(selected) !== selected || selected.includes('\0') || (process.platform === 'win32' && (selected.startsWith('\\\\') || selected.slice(2).includes(':')))) pathFailure('Directory must be an absolute canonical local path')
  if (selected === parse(selected).root) pathFailure('A volume root cannot be an installation scope')
  const paths: string[] = []
  let current = selected
  while (current !== parse(current).root) { paths.unshift(current); current = dirname(current); if (paths.length > CUTOVER_FILE_LIMITS.components) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Directory depth exceeds the installer limit') }
  return paths.map(captureDirectory)
}
export function assertDirectories(identities: readonly CutoverPhysicalIdentity[]): void { for (const identity of identities) assertDirectory(identity) }
export function captureParents(root: string, relativePath: string): CutoverPhysicalIdentity[] {
  validateRelativePath(relativePath)
  const identities: CutoverPhysicalIdentity[] = []
  let current = root
  const parts = relativePath.split('/').slice(0, -1)
  let hasMissing = false
  for (const part of parts) {
    current = join(current, part)
    const stat = fileStat(current)
    if (!stat) { hasMissing = true; continue }
    if (hasMissing) pathFailure('A missing directory has an unexpected descendant')
    identities.push(captureDirectory(current))
  }
  return identities
}
export function targetPath(root: string, relativePath: string): string { validateRelativePath(relativePath); const path = join(root, ...relativePath.split('/')); if (!within(root, path) || root === path) pathFailure('Cutover path escaped its retained workcopy'); return path }
export function assertParents(root: string, relativePath: string, identities: readonly CutoverPhysicalIdentity[]): void {
  const expected = new Map(identities.map(identity => [identity.path, identity]))
  let current = root
  for (const part of relativePath.split('/').slice(0, -1)) {
    current = join(current, part)
    const identity = expected.get(current)
    if (identity) assertDirectory(identity)
    else if (fileStat(current)) pathFailure('An unrecorded directory appeared after staging')
  }
}
export function readRegular(path: string, limit: number = CUTOVER_FILE_LIMITS.fileBytes, allowedLinks = 1n): CutoverFileObservation {
  const before = fileStat(path)
  if (before || fileStat(dirname(path))) exactEntry(path)
  if (!before) return { bytes: null, identity: null, mode: null }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink < 1n || before.nlink > allowedLinks || realpathSync.native(path) !== path) pathFailure('Installer files must be regular and have no unowned link aliases')
  if (before.size > BigInt(limit)) throw new CutoverInstallerError('CUTOVER_LIMIT', 'File exceeds the bounded installer read limit')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameRead(before, fstatSync(fd, { bigint: true }))) pathFailure('A file changed before its bounded read')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count }
    const after = fstatSync(fd, { bigint: true }), current = fileStat(path)
    if (offset !== Number(before.size) || !current || !sameRead(before, after) || !sameRead(before, current)) pathFailure('A file changed during its bounded read')
    return { bytes: bytes.subarray(0, offset), identity: physicalIdentity(path, before), mode: Number(before.mode & 0o777n) }
  } finally { closeSync(fd) }
}
export function assertBytes(observation: CutoverFileObservation, expected: string | null): void {
  if ((observation.bytes === null ? null : fileDigest(observation.bytes)) !== expected) throw new CutoverInstallerError('CUTOVER_FILE_CONFLICT', 'Current bytes differ from the original command precondition')
}
export function syncDirectory(path: string): void {
  // Windows Node cannot open directories for fsync; file fsync/readback remain mandatory.
  if (process.platform === 'win32') return
  const fd = openSync(path, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
export function writeExclusive(path: string, bytes: Uint8Array, mode = 0o600): CutoverPhysicalIdentity {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode)
  try {
    let offset = 0
    while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset, offset); if (!written) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Installer write made no progress'); offset += written }
    fsyncSync(fd)
    return physicalIdentity(path, fstatSync(fd, { bigint: true }))
  } finally { closeSync(fd) }
}
/** Immutable private publication: rename only within a new exclusive directory; link never replaces a destination. */
export function publishPrivate(directory: CutoverPhysicalIdentity, name: string, bytes: Uint8Array): void {
  assertDirectory(directory)
  const scratch = join(directory.path, '.publish-' + randomUUID())
  mkdirSync(scratch, { mode: 0o700 })
  const identity = captureDirectory(scratch), temporary = join(scratch, 'temporary'), prepared = join(scratch, 'prepared')
  writeExclusive(temporary, bytes)
  assertDirectory(directory); assertDirectory(identity)
  renameSync(temporary, prepared)
  assertDirectory(directory); assertDirectory(identity)
  linkSync(prepared, join(directory.path, name))
  assertDirectory(directory); assertDirectory(identity)
  unlinkSync(prepared); rmdirSync(scratch); syncDirectory(directory.path)
}
export function removeOwned(path: string, identity: CutoverPhysicalIdentity, digest: string, allowedLinks = 1n): void {
  const observation = readRegular(path, CUTOVER_FILE_LIMITS.planBytes, allowedLinks)
  if (observation.bytes === null) return
  const stat = fileStat(path)
  if (!stat || !sameIdentity(identity, stat) || fileDigest(observation.bytes) !== digest) pathFailure('Installer-owned temporary bytes changed; they were preserved')
  unlinkSync(path)
}

/** Read a private immutable publication even if a crash retained its one verified prepared alias. */
export function readPrivate(directory: CutoverPhysicalIdentity, name: string, limit: number): CutoverFileObservation {
  assertDirectory(directory)
  const target = join(directory.path, name), observation = readRegular(target, limit, 2n), stat = fileStat(target)
  if (stat?.nlink === 2n) {
    const identity = observation.identity
    if (!identity) pathFailure('Private publication identity is unavailable')
    let aliases = 0
    for (const entry of boundedEntries(directory.path)) {
      if (!/^\.publish-[0-9a-f-]{36}$/.test(entry)) continue
      const scratch = join(directory.path, entry), scratchIdentity = captureDirectory(scratch), prepared = join(scratch, 'prepared')
      const preparedStat = fileStat(prepared)
      if (!preparedStat || !sameIdentity(identity, preparedStat)) continue
      const candidate = readRegular(prepared, limit, 2n)
      if (!candidate.bytes || !observation.bytes || !candidate.bytes.equals(observation.bytes) || boundedEntries(scratch).length !== 1) pathFailure('Private publication alias differs from its original bytes')
      assertDirectory(scratchIdentity); aliases++
    }
    if (aliases !== 1) pathFailure('Private publication has an unowned link alias')
  }
  assertDirectory(directory)
  return observation
}
