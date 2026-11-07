import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'
import { z } from 'zod'
import { executionCodeSourceSchema, type ExecutionArtifactRef, type ExecutionCodeSource } from '../../../../shared/team-execution-artifacts'
import { taskInputCanonical } from '../../../../shared/team-task-inputs'
import { assertGitReadSafety } from '../../devtools-git'
import { checkedGit, readGit, readGitWorkingTreeContent } from '../../git-readonly-reader'
import { resolveWorkcopy, assertWorkcopyObservation } from '../../workcopy-use/identity'
import { workcopyObservationSchema, type WorkcopyObservation } from '../../../../shared/workcopy-use'

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
type Owned = { assertOwned(): void | Promise<void> }
const fold = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
function reject(message: string): never { throw new Error(message) }
async function safeRoot(input: string): Promise<{ root: string; identity: string }> {
  if (!isAbsolute(input) || input.includes('\0')) reject('An explicitly owned absolute directory is required')
  const root = resolve(input), physical = await realpath(root)
  if (fold(root) !== fold(physical)) reject('Redirected directories are unsupported')
  let current = parse(root).root
  for (const part of relative(current, root).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject('Linked or redirected directories are unsupported')
  }
  const stat = await lstat(root)
  return { root, identity: `${fold(physical)}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}` }
}
function pathIn(root: string, path: string): string {
  if (!path || path.length > 4096 || path.includes('\0') || path.includes('\\') || isAbsolute(path) || win32.isAbsolute(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes(':'))) reject('Select a regular relative file inside the owned directory')
  return resolve(root, path)
}
async function safeFile(root: string, path: string): Promise<string> {
  const target = pathIn(root, path)
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory()) || (current === target && (!stat.isFile() || stat.nlink !== 1))) reject('Selected files must be regular files without links')
  }
  return target
}
async function captureSelectedBytes(input: Owned & { root: string; relativePath: string; expectedDigest?: string }): Promise<{ bytes: Buffer; bodyDigest: string; byteLength: number }> {
  input = { ...input, assertOwned: input.assertOwned.bind(input) }
  await input.assertOwned()
  const original = await safeRoot(input.root), target = await safeFile(original.root, input.relativePath), before = await lstat(target)
  const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  let bytes: Buffer
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 1024 * 1024) reject('Selected file changed or exceeds one MiB')
    bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await handle.stat()
    if (length !== stat.size || after.nlink !== 1 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) reject('Selected file changed during capture')
    bytes = bytes.subarray(0, length)
  } finally { await handle.close() }
  const bodyDigest = hash(bytes)
  await input.assertOwned()
  if ((await safeRoot(input.root)).identity !== original.identity || await safeFile(original.root, input.relativePath) !== target) reject('Selected directory changed during capture')
  const after = await lstat(target)
  if (after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    || input.expectedDigest !== undefined && bodyDigest !== input.expectedDigest) reject('Selected file no longer matches the reviewed revision')
  return { bytes, bodyDigest, byteLength: bytes.length }
}

export async function captureSelectedFile(input: Owned & { root: string; relativePath: string; expectedDigest?: string }): Promise<{ text: string; bodyDigest: string; byteLength: number }> {
  const value = await captureSelectedBytes(input)
  return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value.bytes), bodyDigest: value.bodyDigest, byteLength: value.byteLength }
}

async function controlText(path: string): Promise<string> {
  await safeRoot(dirname(path))
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8192) reject('Git control reference is not a bounded single-link regular file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || stat.size !== before.size) reject('Git control reference changed')
    const bytes = Buffer.alloc(8193), read = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat()
    const pathAfter = await lstat(path)
    if (read.bytesRead !== before.size || after.size !== before.size || after.nlink !== 1 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) reject('Git control reference changed while reading')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, read.bytesRead)).trim()
  } finally { await handle.close() }
}

async function gitControl(root: string, expected?: WorkcopyObservation): Promise<{ directory: string; common: string; revision: string }> {
  const original = resolveWorkcopy(root)
  assertWorkcopyObservation(original, expected)
  if (!original.repoRoot || fold(original.repoRoot) !== fold(root) || !original.worktreeGitDir || !original.gitCommonDir) reject('The selected root is not the actual Git workcopy root')
  const directory = (await safeRoot(original.worktreeGitDir)).root, common = (await safeRoot(original.gitCommonDir)).root
  const marker = await lstat(join(root, '.git'))
  const references: string[] = []
  if (marker.isSymbolicLink()) reject('Linked Git control files are unsupported')
  if (marker.isFile()) {
    const pointer = await controlText(join(root, '.git')), match = /^gitdir: (.+)$/.exec(pointer)
    if (!match || fold(resolve(root, match[1])) !== fold(directory) || fold(dirname(directory)) !== fold(join(common, 'worktrees'))) reject('Worktree control directory is outside its actual shared Git registry')
    const backlink = await controlText(join(directory, 'gitdir')), commonRef = await controlText(join(directory, 'commondir'))
    if (fold(resolve(directory, backlink)) !== fold(join(root, '.git')) || fold(resolve(directory, commonRef)) !== fold(common)) reject('Worktree control references do not point back to the selected directory')
    references.push(pointer, backlink, commonRef)
  } else if (!marker.isDirectory() || fold(directory) !== fold(join(root, '.git')) || fold(common) !== fold(directory)) reject('Unrecognized redirected Git control roots')
  assertWorkcopyObservation(resolveWorkcopy(root), original)
  return { directory, common, revision: hash(taskInputCanonical({ identity: original, references })) }
}

function statusFacts(raw: string): { staged: boolean; blocked: boolean } {
  const records = raw.split('\0')
  let staged = false, blocked = false
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (!/^[ MADRCUT?!]{2} /.test(record)) reject('Unsupported Git status cannot establish code availability')
    const pair = record.slice(0, 2)
    blocked ||= pair === '??' || pair.includes('U') || pair === 'AA' || pair === 'DD'
    staged ||= pair[0] !== ' ' && pair[0] !== '?' && pair[0] !== '!'
    if (pair.includes('R') || pair.includes('C')) index += 1
  }
  return { staged, blocked }
}

async function gitSnapshot(root: string, assertOwned: Owned['assertOwned'], expected?: WorkcopyObservation): Promise<{ revision: string; head: string; clean: boolean; diff: string }> {
  await assertOwned()
  if (Object.keys(process.env).some(key => /^GIT_(?:GRAFT_FILE|SHALLOW_FILE)$/i.test(key) && process.env[key])) reject('External Git history overrides cannot establish a handoff')
  const control = await gitControl(root, expected)
  for (const path of [join(control.common, 'config'), join(control.directory, 'index'), join(control.directory, 'HEAD'), join(control.common, 'objects'), join(control.common, 'objects/info'), join(control.common, 'refs')]) {
    try { if ((await lstat(path)).isSymbolicLink()) reject('Linked Git metadata is unsupported') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const path of [join(control.common, 'objects/info/alternates'), join(control.common, 'info/grafts'), ...['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].map(name => join(control.directory, name))]) {
    try { await lstat(path); reject('External object stores, rewritten ancestry or an unfinished Git operation cannot establish a handoff') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await assertGitReadSafety(root)
  const entries = (await checkedGit(root, ['ls-files', '--stage', '-z'])).out
  if (entries.split('\0').some(entry => /^(120000|160000) /.test(entry))) reject('Linked files and submodules require a separately supported source')
  const status = (await checkedGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])).out
  const originalStatus = statusFacts(status)
  if (originalStatus.blocked) reject('Untracked or conflicted files must be explicitly delivered before code handoff')
  const head = oid.parse((await checkedGit(root, ['rev-parse', '--verify', 'HEAD'])).out.trim())
  // Physical hashes bound stability; the separate zero-stat index below proves content differences.
  const paths = entries.split('\0').filter(Boolean).map(entry => entry.slice(entry.indexOf('\t') + 1))
  if (paths.length > 2048) reject('Repository file count exceeds the bounded handoff verifier')
  const files: string[] = []
  let total = 0
  for (const path of [...new Set(paths)]) {
    try {
      const value = await captureSelectedBytes({ root, relativePath: path, assertOwned })
      total += value.byteLength
      if (total > 16 * 1024 * 1024) reject('Repository bytes exceed the bounded handoff verifier')
      files.push(`${path}:${value.bodyDigest}`)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files.push(`${path}:missing`); else throw error }
  }
  const flags = (await checkedGit(root, ['ls-files', '-v', '-z'])).out
  if (flags.split('\0').some(entry => entry && (entry[0] !== 'H' && entry[0] !== 'R'))) reject('Sparse or hidden index changes cannot establish code availability')
  await assertOwned()
  await assertGitReadSafety(root)
  const content = await readGitWorkingTreeContent(root, entries, head), diff = content.diff
  const actualStatus = statusFacts(content.status)
  if (actualStatus.blocked) reject('Untracked or conflicted files changed during actual content verification')
  if ((await gitControl(root, expected)).revision !== control.revision) reject('Git workcopy control roots changed during observation')
  // Unstaged status can report a stat/size change that built-in normalization proves equivalent.
  return { revision: hash(taskInputCanonical({ control: control.revision, head, entries, status, contentStatus: content.status, diff, files })), head,
    clean: !originalStatus.staged && !actualStatus.staged && diff.length === 0, diff }
}

export async function captureGitPatch(input: Owned & { root: string; repositoryId: string; base: string; expectedDigest?: string; expectedWorkcopy?: WorkcopyObservation }): Promise<{ text: string; bodyDigest: string; byteLength: number }> {
  input = { ...input, expectedWorkcopy: input.expectedWorkcopy ? workcopyObservationSchema.parse(input.expectedWorkcopy) : undefined, assertOwned: input.assertOwned.bind(input) }
  oid.parse(input.base)
  await input.assertOwned()
  const root = await safeRoot(input.root), before = await gitSnapshot(root.root, input.assertOwned, input.expectedWorkcopy)
  if (before.head !== input.base || !before.diff || before.diff.includes('\uFFFD')) reject('A selected patch must describe actual supported changes against the current base commit')
  if (input.expectedDigest !== undefined && hash(before.diff) !== input.expectedDigest) reject('Patch changed after preview')
  await input.assertOwned()
  const after = await gitSnapshot(root.root, input.assertOwned, input.expectedWorkcopy)
  if (before.revision !== after.revision || (await safeRoot(input.root)).identity !== root.identity) reject('Code changed after patch preview')
  return { text: before.diff, bodyDigest: hash(before.diff), byteLength: Buffer.byteLength(before.diff) }
}

export async function verifyHandoffSource(input: Owned & { root?: string; source: ExecutionCodeSource; role?: 'source' | 'receiver'; requiredCode?: boolean; expectedWorkcopy?: WorkcopyObservation;
  readArtifact(ref: ExecutionArtifactRef): Promise<{ text: string; bodyDigest: string }>;
  targetPaths?: Record<string, string> }): Promise<{ verification: 'native-read'; availability: 'available'; application: 'not-required' | 'available-not-applied' | 'applied'; ready: boolean; sourceDigest: string; observedAt: number }> {
  input = { ...input, source: executionCodeSourceSchema.parse(input.source), targetPaths: input.targetPaths ? { ...input.targetPaths } : undefined,
    expectedWorkcopy: input.expectedWorkcopy ? workcopyObservationSchema.parse(input.expectedWorkcopy) : undefined,
    assertOwned: input.assertOwned.bind(input), readArtifact: input.readArtifact.bind(input) }
  const source = input.source, sourceDigest = hash(taskInputCanonical(source))
  await input.assertOwned()
  const result = (application: 'not-required' | 'available-not-applied' | 'applied') => ({ verification: 'native-read' as const, availability: 'available' as const, application, ready: application !== 'available-not-applied', sourceDigest, observedAt: Date.now() })
  if (source.kind === 'none') {
    if (input.requiredCode) reject('Required selected code is missing; a no-code declaration cannot establish workcopy readiness')
    return result('not-required')
  }
  const read = async (ref: ExecutionArtifactRef): Promise<string> => {
    const value = await input.readArtifact({ ...ref })
    await input.assertOwned()
    if (value.bodyDigest !== ref.bodyDigest || hash(value.text) !== ref.bodyDigest || Buffer.byteLength(value.text) > 1024 * 1024) reject('Selected source bytes are missing or changed')
    return value.text
  }
  if (source.kind === 'selected-files') {
    let applied = true
    const selected: { path: string; digest: string }[] = []
    for (const ref of source.files) {
      await read(ref)
      const path = input.targetPaths?.[ref.versionId]
      if (!input.root || !path) { applied = false; continue }
      await captureSelectedFile({ root: input.root, relativePath: path, expectedDigest: ref.bodyDigest, assertOwned: input.assertOwned })
      selected.push({ path, digest: ref.bodyDigest })
    }
    await input.assertOwned()
    for (const file of selected) if (input.root) await captureSelectedFile({ root: input.root, relativePath: file.path, expectedDigest: file.digest, assertOwned: input.assertOwned })
    return result(applied ? 'applied' : 'available-not-applied')
  }
  if (!input.root) reject('Select an owned repository to verify Git code')
  const root = await safeRoot(input.root), before = await gitSnapshot(root.root, input.assertOwned, input.expectedWorkcopy)
  await checkedGit(root.root, ['cat-file', '-e', `${source.base}^{commit}`])
  let application: 'available-not-applied' | 'applied'
  if (source.kind === 'git-commit') {
    await checkedGit(root.root, ['cat-file', '-e', `${source.commit}^{commit}`])
    await checkedGit(root.root, ['merge-base', '--is-ancestor', source.base, source.commit])
    const objects = (await checkedGit(root.root, ['rev-list', '--objects', '--missing=print', source.commit, source.base, '--'])).out
    if (objects.split('\n').some(line => line.startsWith('?'))) reject('Required code objects are missing locally')
    if (!before.clean) reject('Unpublished working changes are outside the fixed commit')
    application = before.head === source.commit ? 'applied' : 'available-not-applied'
    if (input.role === 'source' && application !== 'applied') reject('The selected source commit is not the actual clean source tree')
  } else {
    const patch = await read(source.patch)
    if ((await safeRoot(input.root)).identity !== root.identity) reject('Selected directory changed while reading the patch')
    if (Buffer.byteLength(patch) > 128 * 1024 || !patch.startsWith('diff --git ')) reject('Only a bounded Git patch is supported')
    if (input.role === 'source') {
      if (before.head !== source.base || before.diff !== patch) reject('Actual source changes differ from the selected patch')
      application = 'applied'
    } else {
      if (before.head !== source.base || !before.clean && before.diff !== patch) reject('Receiver must expose the exact clean base or the exact already applied patch')
      const applied = !before.clean && before.diff === patch
      const checked = await readGit(root.root, ['apply', '--check', ...(applied ? ['--reverse'] : []), '--whitespace=nowarn', '-'], { stdin: patch, maxBytes: 32768 })
      if (checked.code !== 0) reject('Selected patch cannot be applied to the actual receiver tree')
      application = applied ? 'applied' : 'available-not-applied'
    }
  }
  await input.assertOwned()
  const after = await gitSnapshot(root.root, input.assertOwned, input.expectedWorkcopy)
  if (before.revision !== after.revision || (await safeRoot(input.root)).identity !== root.identity) reject('Code source changed during verification')
  return result(application)
}
