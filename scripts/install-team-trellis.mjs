import * as fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILES = ['task.py', 'common/io.py', 'common/task_store.py', 'common/task_utils.py', 'common/task_authority.py', 'hooks/linear_sync.py']
const REQUIRED = ['serviceOwnedState', 'normalLocalHooks', 'protectedMetadata', 'rejectLocalArchive', 'readOnlyProbe']
const HEX = /^[a-f0-9]{64}$/
const BACKUPS = '.trellis/.team-trellis-backups'
const LOCK = '.trellis/.team-trellis-install.lock'
const MAX_BYTES = 1024 * 1024
const key = path => process.platform === 'win32' ? path.toLowerCase() : path
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
// Git's baseline blobs use LF; Windows checkouts may use CRLF. Normalize only
// CRLF, preserving BOM, lone CR, spacing, comments and every other UTF-8 byte.
const normalized = bytes => Buffer.from(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/g, '\n'), 'utf8')

function rootPath(input) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) throw new Error('--root must be an absolute engineering directory')
  const lexical = resolve(input), real = fs.realpathSync.native(lexical)
  if (key(real) !== key(lexical) || fs.lstatSync(lexical).isSymbolicLink() || !fs.lstatSync(real).isDirectory()) throw new Error(`Redirected or invalid root: ${lexical}`)
  return real
}
function safePath(root, relative, missingLeaf = false) {
  if (!relative || isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..' || /[\\:\0]/.test(p))) throw new Error('Invalid adapter relative path')
  if (key(rootPath(root)) !== key(root)) throw new Error('Root identity changed')
  let current = root
  for (const [i, part] of relative.split('/').entries()) {
    current = join(current, part)
    let info
    try { info = fs.lstatSync(current) }
    catch (error) { if (error.code === 'ENOENT' && missingLeaf && i === relative.split('/').length - 1) return current; throw error }
    if (info.isSymbolicLink() || key(fs.realpathSync.native(current)) !== key(current)) throw new Error(`Symbolic link/junction is unsupported: ${current}`)
    if (i < relative.split('/').length - 1 && !info.isDirectory()) throw new Error(`Not a directory: ${current}`)
  }
  return current
}
function read(root, relative, allowMissing = false) {
  const path = safePath(root, relative, allowMissing)
  let info
  try { info = fs.lstatSync(path) } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error }
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error(`Adapter file is invalid or exceeds 1 MiB: ${relative}`)
  const bytes = fs.readFileSync(path)
  safePath(root, relative)
  return { bytes, hash: sha(bytes), mode: info.mode & 0o777 }
}
function makeDirectory(root, relative) {
  let prefix = ''
  for (const part of relative.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part
    const path = safePath(root, prefix, true)
    try { fs.mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (!fs.lstatSync(safePath(root, prefix)).isDirectory()) throw new Error(`Not a directory: ${prefix}`)
  }
}
function replace(root, relative, expected, bytes, mode = 0o644) {
  const current = read(root, relative, true)
  if ((current?.hash ?? null) !== expected) throw new Error(`Concurrent modification; not overwritten: ${relative}`)
  const path = safePath(root, relative, true)
  const tmpRelative = `${relative.slice(0, relative.lastIndexOf('/') + 1)}.team-trellis-${randomUUID()}.tmp`
  const tmp = safePath(root, tmpRelative, true)
  const digest = sha(bytes)
  let created = false
  try {
    const fd = fs.openSync(tmp, 'wx', mode); created = true
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if ((read(root, relative, true)?.hash ?? null) !== expected) throw new Error(`Concurrent modification; not overwritten: ${relative}`)
    safePath(root, relative, true); safePath(root, tmpRelative)
    if (expected === null) { fs.linkSync(tmp, path); fs.unlinkSync(tmp) }
    else fs.renameSync(tmp, path)
    if (read(root, relative)?.hash !== digest) throw new Error(`Installed bytes could not be confirmed: ${relative}`)
  } finally {
    // Never remove a path that no longer contains this operation's own bytes.
    if (created) { const remaining = read(root, tmpRelative, true); if (remaining?.hash === digest) fs.unlinkSync(safePath(root, tmpRelative)) }
  }
}
function removeMatching(root, relative, expected) {
  if (read(root, relative, true)?.hash !== expected) throw new Error(`Concurrent modification; not removed: ${relative}`)
  fs.unlinkSync(safePath(root, relative))
}
function validateManifest(value, packaged) {
  if (value?.schemaVersion !== 1 || value.adapterVersion !== 1 || value.normalization !== 'utf8-crlf-to-lf'
    || !/^[a-f0-9]{40}$/.test(value.baselineCommit) || !Array.isArray(value.files) || value.files.length !== FILES.length
    || new Set(value.files.map(f => f.path)).size !== FILES.length || !FILES.every(path => value.files.some(f => f.path === path))) throw new Error('Unsupported team adapter manifest')
  const all = [...value.files, ...(value.dependencies ?? [])]
  if (!Array.isArray(value.dependencies) || value.dependencies.length !== 11 || new Set(all.map(f => f.path)).size !== all.length) throw new Error('Invalid adapter dependency manifest')
  for (const file of all) {
    if (!/^(?:task\.py|common\/[a-z_]+\.py|hooks\/linear_sync\.py)$/.test(file.path)
      || !Array.isArray(file.compatibleSha256) || file.compatibleSha256.some(d => !HEX.test(d))) throw new Error('Invalid adapter file manifest')
  }
  for (const file of value.files) {
    if (file.allowMissing !== (file.path === 'common/task_authority.py') || (packaged && !HEX.test(file.sha256))) throw new Error('Invalid adapter payload manifest')
  }
  return value
}
function dependencies(root, manifest, prefix = '.trellis/scripts/') {
  for (const file of manifest.dependencies) {
    if (!file.compatibleSha256.includes(sha(normalized(read(root, prefix + file.path).bytes)))) throw new Error(`Unknown/custom dependency; no files replaced: ${prefix}${file.path}`)
  }
}
export function readTeamTrellisPayload() {
  const here = rootPath(dirname(fileURLToPath(import.meta.url)))
  const packaged = fs.existsSync(join(here, 'manifest.json'))
  const sourceRoot = packaged ? here : rootPath(resolve(here, '..'))
  const manifestPath = packaged ? 'manifest.json' : 'resources/team-trellis/baseline.json'
  const manifest = validateManifest(JSON.parse(read(sourceRoot, manifestPath).bytes.toString('utf8')), packaged)
  const sources = new Map()
  if (!packaged) dependencies(sourceRoot, manifest)
  for (const entry of manifest.files) {
    const body = normalized(read(sourceRoot, `${packaged ? 'scripts/' : '.trellis/scripts/'}${entry.path}`).bytes)
    if (packaged && sha(body) !== entry.sha256) throw new Error(`Adapter payload hash mismatch: ${entry.path}`)
    entry.sha256 = sha(body)
    sources.set(entry.path, body)
  }
  return { manifest, sources }
}
function inspect(root, bundle) {
  safePath(root, '.trellis/scripts')
  dependencies(root, bundle.manifest)
  return bundle.manifest.files.map(entry => {
    const relative = `.trellis/scripts/${entry.path}`
    const previous = read(root, relative, entry.allowMissing)
    const source = bundle.sources.get(entry.path), currentHash = sha(source)
    const known = previous ? sha(normalized(previous.bytes)) : null
    if ((known === null && !entry.allowMissing) || (known !== null && known !== currentHash && !entry.compatibleSha256.includes(known))) throw new Error(`Unknown/custom script; no files replaced: ${relative}`)
    const bytes = known === currentHash ? previous.bytes
      : previous?.bytes.includes(Buffer.from('\r\n')) ? Buffer.from(source.toString('utf8').replace(/\n/g, '\r\n')) : source
    return { path: entry.path, relative, previous, bytes, installedSha256: sha(bytes), changed: previous?.hash !== sha(bytes) }
  })
}
function python(root, args) {
  return new Promise((done, reject) => {
    const proc = spawn('python', ['-B', ...args], { cwd: root, windowsHide: true, shell: false,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1', FORCE_COLOR: '0' } })
    let output = Buffer.alloc(0), stderr = 0, settled = false, timer
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : done(result) }
    const stop = () => {
      if (process.platform === 'win32' && proc.pid) {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => proc.kill()); killer.unref()
      } else proc.kill('SIGKILL')
      proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); proc.unref()
    }
    proc.stdout.on('data', chunk => {
      if (settled) return
      if (output.length + chunk.length > 8192) { finish(new Error('Python output exceeds 8 KiB')); stop() }
      else output = Buffer.concat([output, chunk])
    })
    proc.stderr.on('data', chunk => { stderr += chunk.length; if (!settled && stderr > 8192) { finish(new Error('Python error output exceeds 8 KiB')); stop() } })
    proc.on('error', () => finish(new Error('Cannot launch python; Python 3.10 or newer is required')))
    proc.on('close', code => {
      if (code !== 0) { finish(new Error(`Python capability check failed (exit ${code})`)); return }
      try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output))) }
      catch { finish(new Error('Python capability response is not bounded UTF-8 JSON')) }
    })
    timer = setTimeout(() => { finish(new Error('Python capability check timed out')); stop() }, 10_000)
  })
}
async function assertInstalled(root) {
  const result = await python(root, [join(root, '.trellis/scripts/task.py'), 'team-capabilities', '--json'])
  if (result?.adapterVersion !== 1 || REQUIRED.some(k => result[k] !== true)) throw new Error('Installed CLI does not provide all team adapter v1 capabilities')
}
function takeLock(root) {
  const body = Buffer.from(JSON.stringify({ token: randomUUID(), pid: process.pid }))
  replace(root, LOCK, null, body, 0o600)
  return () => { if (read(root, LOCK, true)?.hash === sha(body)) removeMatching(root, LOCK, sha(body)) }
}
function backup(root, plan, manifest) {
  const id = randomUUID(), relative = `${BACKUPS}/${id}`
  makeDirectory(root, BACKUPS)
  const directory = safePath(root, relative, true)
  fs.mkdirSync(directory, { mode: 0o700 })
  const record = { schemaVersion: 1, adapterVersion: 1, root, id, state: 'prepared', baselineCommit: manifest.baselineCommit, files: [] }
  for (const entry of plan) {
    if (entry.previous) {
      const path = `original/${entry.path}`
      makeDirectory(directory, dirname(path).split(sep).join('/'))
      replace(directory, path, null, entry.previous.bytes, 0o600)
    }
    record.files.push({ path: entry.path, originalSha256: entry.previous?.hash ?? null, installedSha256: entry.installedSha256,
      mode: entry.previous?.mode ?? 0o644, changed: entry.changed })
  }
  const body = Buffer.from(JSON.stringify(record, null, 2) + '\n')
  replace(directory, 'transaction.json', null, body, 0o600)
  return { directory, record, revision: sha(body) }
}
function saveBackup(saved, state, conflicts = []) {
  saved.record.state = state; saved.record.conflicts = conflicts
  const body = Buffer.from(JSON.stringify(saved.record, null, 2) + '\n')
  replace(saved.directory, 'transaction.json', saved.revision, body, 0o600)
  saved.revision = sha(body)
}
function restore(root, saved, entries) {
  const conflicts = []
  for (const file of [...entries].reverse()) {
    const target = `.trellis/scripts/${file.path}`
    try {
      const current = read(root, target, true)
      if ((current?.hash ?? null) === file.originalSha256) continue
      if (current?.hash !== file.installedSha256) throw new Error('Current bytes no longer match this installation')
      if (file.originalSha256 === null) removeMatching(root, target, file.installedSha256)
      else {
        const original = read(saved.directory, `original/${file.path}`)
        if (original.hash !== file.originalSha256) throw new Error('Original backup hash mismatch')
        replace(root, target, file.installedSha256, original.bytes, file.mode)
      }
    } catch (error) { conflicts.push(`${file.path}: ${error.message}`) }
  }
  return conflicts
}
function readBackup(root, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid backup ID')
  const directory = safePath(root, `${BACKUPS}/${id}`)
  const data = read(directory, 'transaction.json'), record = JSON.parse(data.bytes.toString('utf8'))
  if (record.schemaVersion !== 1 || record.adapterVersion !== 1 || record.id !== id || key(record.root) !== key(root)
    || !Array.isArray(record.files) || record.files.length !== FILES.length || new Set(record.files.map(f => f.path)).size !== FILES.length) throw new Error('Backup does not belong to this root/adapter')
  for (const file of record.files) {
    if (!FILES.includes(file.path) || !HEX.test(file.installedSha256) || (file.originalSha256 !== null && !HEX.test(file.originalSha256))
      || typeof file.changed !== 'boolean' || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error('Invalid backup file identity')
    if (file.originalSha256 !== null && read(directory, `original/${file.path}`).hash !== file.originalSha256) throw new Error(`Backup hash mismatch: ${file.path}`)
  }
  return { directory, record, revision: data.hash }
}

/** Fixed six-file Trellis adapter installer; never mutates tasks, config or specs. */
export async function installTeamTrellis({ root: input, apply = false, rollback = null }) {
  const root = rootPath(input)
  if (rollback !== null) {
    const saved = readBackup(root, rollback), files = saved.record.files.filter(f => f.changed)
    if (!apply) {
      const conflicts = files.filter(file => {
        const current = read(root, `.trellis/scripts/${file.path}`, true)?.hash ?? null
        return current !== file.originalSha256 && current !== file.installedSha256
      }).map(file => `${file.path}: current bytes no longer match this installation`)
      return { ok: !conflicts.length, mode: 'rollback-dry-run', root, backupId: rollback, files: files.map(f => f.path), conflicts }
    }
    const release = takeLock(root)
    try {
      const current = readBackup(root, rollback), conflicts = restore(root, current, current.record.files.filter(f => f.changed))
      saveBackup(current, conflicts.length ? 'rollback-conflict' : 'rolled-back', conflicts)
      return { ok: !conflicts.length, mode: 'rolled-back', root, backupId: rollback, conflicts }
    } finally { release() }
  }
  const bundle = readTeamTrellisPayload()
  const plan = inspect(root, bundle)
  const version = await python(root, ['-c', 'import json,sys; print(json.dumps(list(sys.version_info[:2])))'])
  if (!Array.isArray(version) || version[0] !== 3 || version[1] < 10) throw new Error('Python 3.10 or newer is required')
  const changes = plan.filter(p => p.changed).map(p => p.path)
  if (!apply) return { ok: true, mode: 'dry-run', root, adapterVersion: 1, changes, baselineCommit: bundle.manifest.baselineCommit }
  if (!changes.length) { await assertInstalled(root); return { ok: true, mode: 'already-installed', root, adapterVersion: 1, changes: [] } }
  const release = takeLock(root)
  let saved
  const attempted = []
  try {
    // Repeat the whole compatibility check under the installer lock. User edits
    // still use per-file byte comparisons; the lock never grants overwrite rights.
    const current = inspect(root, bundle)
    saved = backup(root, current, bundle.manifest)
    for (const entry of current.filter(e => e.changed)) {
      attempted.push(saved.record.files.find(f => f.path === entry.path))
      replace(root, entry.relative, entry.previous?.hash ?? null, entry.bytes, entry.previous?.mode ?? 0o644)
    }
    dependencies(root, bundle.manifest)
    for (const entry of current) if (read(root, entry.relative)?.hash !== entry.installedSha256) throw new Error(`Installation changed during verification: ${entry.path}`)
    await assertInstalled(root)
    saveBackup(saved, 'installed')
    return { ok: true, mode: 'applied', root, adapterVersion: 1, changes: current.filter(e => e.changed).map(e => e.path), backupId: saved.record.id, backupDirectory: saved.directory }
  } catch (error) {
    if (saved) {
      const conflicts = restore(root, saved, attempted)
      try { saveBackup(saved, conflicts.length ? 'rollback-conflict' : 'rolled-back', conflicts) } catch (failure) { conflicts.push(`Backup record: ${failure.message}`) }
      throw new Error(`${error.message}; originals retained at ${saved.directory}; ${conflicts.length ? `rollback conflicts (preserved): ${conflicts.join('; ')}` : 'matching installation writes rolled back'}`)
    }
    throw error
  } finally { release() }
}

async function main() {
  let root, apply = false, rollback = null
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && !root && args[i + 1] && !args[i + 1].startsWith('--')) root = args[++i]
    else if (args[i] === '--apply' && !apply) apply = true
    else if (args[i] === '--rollback' && rollback === null && args[i + 1] && !args[i + 1].startsWith('--')) rollback = args[++i]
    else throw new Error('Usage: node scripts/install-team-trellis.mjs --root <absoluteEngineeringRoot> [--apply] [--rollback <backup-id>]')
  }
  const result = await installTeamTrellis({ root, apply, rollback })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.ok) process.exitCode = 1
}
if (process.argv[1] && key(resolve(process.argv[1])) === key(fileURLToPath(import.meta.url))) {
  main().catch(error => { process.stderr.write(`Team Trellis installation refused: ${error.message}\n`); process.exitCode = 1 })
}
