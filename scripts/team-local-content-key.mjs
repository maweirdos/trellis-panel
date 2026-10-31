import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const nativeScript = fileURLToPath(new URL('../resources/daemon/windows-native.ps1', import.meta.url))
const fail = (reason) => { throw Error(`Local content encryption key ${reason}; existing keys and permissions were not replaced.`) }
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino

// Inspect the lexical path before the launcher's canonical outside-Git guard can resolve links.
function noLinks(target, missing = false) {
  let leaf
  for (let current = resolve(target);; current = dirname(current)) {
    let info
    try { info = lstatSync(current) }
    catch (error) { if (error.code !== 'ENOENT' || !missing) throw error }
    if (info?.isSymbolicLink() || info && current !== target && !info.isDirectory()) fail('path must not contain symlinks, junctions or non-directory ancestors')
    if (current === target) leaf = info
    if (dirname(current) === current) return leaf
  }
}

async function windows(args) {
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) fail('requires the fixed Windows PowerShell adapter')
  const executable = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  return new Promise((done, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: 7000, maxBuffer: 16 * 1024, encoding: 'utf8' }, (error, stdout) => {
      // Never include arbitrary native output or credential bytes in launcher errors.
      try {
        if (error || JSON.parse(stdout.replace(/^\uFEFF/, '').trim()).ok !== true) throw Error()
        done()
      } catch { reject(Error('Local content encryption key Windows ownership/protection verification failed; no existing ACL or key was repaired.')) }
    })
  })
}

async function windowsPrivate(target, directory, checkPrivateAccess = true) {
  // Read-only verification: the fixed native adapter is used only for a newly created directory.
  const script = `
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(target, 'utf8').toString('base64')}'))
  $item = Get-Item -LiteralPath $target -Force
  $directory = $${directory ? 'true' : 'false'}
  if ($item.PSIsContainer -ne $directory) { throw 'Invalid key path type' }
  for ($cursor = $item; $null -ne $cursor;) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path denied' }
    if ($cursor.PSIsContainer) { $cursor = $cursor.Parent } else { $cursor = $cursor.Directory }
  }
  if ($${checkPrivateAccess ? 'true' : 'false'}) {
    $acl = Get-Acl -LiteralPath $target
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Private owner ACL required' }
    if ($directory -and (-not $acl.AreAccessRulesProtected -or $rules[0].InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None)) { throw 'Protected inheritable directory ACL required' }
  }
  [Console]::Out.WriteLine('{"ok":true}')
} catch { [Console]::Out.WriteLine('{"ok":false}'); exit 1 }
`
  await windows(['-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
}

async function privatePath(target, directory) {
  const before = noLinks(target)
  if (!before || (directory ? !before.isDirectory() : !before.isFile())) fail('path has the wrong type')
  if (!directory && before.nlink !== 1) fail('file must not have other hard links')
  if (process.platform === 'win32') await windowsPrivate(target, directory)
  else if (before.uid !== process.getuid() || (before.mode & 0o7777) !== (directory ? 0o700 : 0o600)) fail('requires the current uid and private directory/file modes 0700/0600')
  const after = noLinks(target)
  if (!after || !identity(before, after)) fail('path changed during protection verification')
  return after
}

async function validateKey(path) {
  const before = await privatePath(path, false)
  if (before.size < 44 || before.size > 1024) fail('file has an invalid size')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let bytes, decoded
  try {
    const info = fstatSync(fd)
    if (!identity(before, info) || !info.isFile() || info.nlink !== 1 || info.size !== before.size) fail('file changed before reading')
    bytes = readFileSync(fd)
    const raw = bytes.toString('utf8').trim()
    if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) fail('file must contain a canonical 32-byte base64 key')
    decoded = Buffer.from(raw, 'base64')
    if (decoded.length !== 32 || decoded.toString('base64') !== raw) fail('file must contain a canonical 32-byte base64 key')
    const after = noLinks(path), final = fstatSync(fd)
    if (!after || !identity(info, after) || final.size !== info.size || final.mtimeMs !== info.mtimeMs || final.ctimeMs !== info.ctimeMs) fail('file changed while reading')
  } finally { bytes?.fill(0); decoded?.fill(0); closeSync(fd) }
}

async function publishKey(directory, path) {
  const temporary = join(directory, `.content-key-${randomUUID()}.tmp`)
  let owned, fd, material, bytes
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    owned = fstatSync(fd)
    material = randomBytes(32)
    bytes = Buffer.from(material.toString('base64') + '\n', 'utf8')
    writeFileSync(fd, bytes); fsyncSync(fd)
    closeSync(fd); fd = undefined
    await validateKey(temporary)
    await privatePath(directory, true)
    // link is an atomic, exclusive publication; rename could overwrite a pre-existing key.
    linkSync(temporary, path)
  } finally {
    material?.fill(0); bytes?.fill(0)
    if (fd !== undefined) closeSync(fd)
    if (owned) {
      const remaining = noLinks(temporary, true)
      if (remaining && identity(owned, remaining)) unlinkSync(temporary)
    }
  }
  if (process.platform !== 'win32') {
    const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  }
  await validateKey(path)
}

async function assertNoStoredCredentials(data) {
  const path = join(data, 'team.sqlite')
  let database
  const noPendingJournal = () => {
    for (const suffix of ['-wal', '-journal']) {
      const sidecar = noLinks(path + suffix, true)
      if (sidecar && (!sidecar.isFile() || sidecar.size !== 0)) throw Error('Unverified database journal')
    }
  }
  try {
    noPendingJournal()
    const before = noLinks(path, true)
    if (!before) return
    if (!before.isFile()) throw Error('Not a regular database')
    if (process.platform === 'win32') await windowsPrivate(path, false, false)
    // The launcher has already checked Node >=24.12; importing this helper on older
    // Node must still reach that version check rather than fail on a static SQLite import.
    const { DatabaseSync } = await import('node:sqlite')
    noPendingJournal()
    const uri = pathToFileURL(path)
    uri.search = 'mode=ro&immutable=1'
    // Plain readOnly may create WAL/SHM files. Immutable is safe only without pending journals.
    database = new DatabaseSync(uri.href, { readOnly: true, enableExtensions: false })
    database.exec('PRAGMA trusted_schema=OFF')
    const check = database.prepare('PRAGMA quick_check(1)').all()
    if (check.length !== 1 || check[0].quick_check !== 'ok') throw Error('Database integrity unavailable')
    const table = database.prepare("SELECT type FROM sqlite_schema WHERE name='team_content_configs'").get()
    if (table && (table.type !== 'table' || database.prepare('SELECT 1 FROM team_content_configs LIMIT 1').get())) throw Error('Existing credential configuration')
    database.close(); database = undefined
    noPendingJournal()
    const after = noLinks(path)
    if (!identity(before, after) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('Database changed during inspection')
  } catch {
    fail('cannot be generated for an existing or unverifiable credential store. Restore the original external key using TEAM_CONTENT_ENCRYPTION_KEY or TEAM_CONTENT_ENCRYPTION_KEY_FILE')
  } finally { database?.close() }
}

/** Only the local launcher provisions a key; deployment-provided values remain authoritative. */
export async function provisionLocalContentKey(env, outsideGit) {
  if (env.TEAM_DEPLOYMENT_MODE !== 'local' || env.TEAM_CONTENT_ENCRYPTION_KEY !== undefined || env.TEAM_CONTENT_ENCRYPTION_KEY_FILE !== undefined) return env
  if (!env.TEAM_DATA_DIR || !isAbsolute(env.TEAM_DATA_DIR)) fail('requires an absolute external data directory')
  const data = outsideGit(env.TEAM_DATA_DIR)
  if (dirname(data) === data) fail('requires a data directory below the filesystem root')
  const candidate = join(dirname(data), `${basename(data)}-secrets`)
  noLinks(candidate, true)
  const directory = outsideGit(candidate)
  if (!noLinks(directory, true)) await assertNoStoredCredentials(data)
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
  noLinks(directory, true)
  let created = false
  try { mkdirSync(directory, { mode: 0o700 }); created = true }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  if (created && process.platform === 'win32') await windows(['-File', nativeScript, '-Operation', 'secure-directory', '-DirectoryBase64', Buffer.from(directory, 'utf8').toString('base64')])
  await privatePath(directory, true)
  const path = join(directory, 'content-encryption.key')
  // An existing empty or damaged directory is never a reason to generate a replacement key.
  if (created) await publishKey(directory, path)
  else await validateKey(path)
  return { ...env, TEAM_CONTENT_ENCRYPTION_KEY_FILE: path }
}
