import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const NODE_RELEASE = Object.freeze(JSON.parse(await readFile(join(projectRoot, 'src/main/services/acp/node-runtime-release.json'), 'utf8')))

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

async function validDist(directory, release) {
  try {
    const root = await realpath(directory)
    for (const [file, digest] of [[release.executable, release.sha256], ['LICENSE', release.licenseSha256]]) {
      const path = join(root, file)
      if (await realpath(path) !== path || !(await stat(path)).isFile() || await sha256(path) !== digest) return false
    }
    return true
  } catch { return false }
}

async function download(url, path, expected, maxBytes, fetchImpl) {
  // The release pins both HTTPS URLs and digests; redirects cannot change origin.
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error(`Official Node download failed (${response.status})`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (declaredLength > maxBytes) throw new Error('Official Node download exceeds the size limit')
  const hash = createHash('sha256')
  let length = 0
  const verify = new Transform({
    transform(bytes, _encoding, done) {
      length += bytes.length
      if (length > maxBytes) { done(new Error('Official Node download exceeds the size limit')); return }
      hash.update(bytes)
      done(null, bytes)
    }
  })
  await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(path, { flags: 'wx' }))
  if (hash.digest('hex') !== expected) throw new Error('Official Node download SHA256 mismatch')
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

async function lockOwner(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
}

async function acquireLock(path, timeoutMs) {
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  while (true) {
    let handle
    try {
      handle = await open(path, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
      await handle.close()
      return async () => {
        if ((await lockOwner(path))?.token === token) await rm(path, { force: true })
      }
    } catch (error) {
      if (handle) { await handle.close(); await rm(path, { force: true }); throw error }
      if (error.code !== 'EEXIST') throw error
    }
    const owner = await lockOwner(path)
    // Never steal a live owner's lock, including a slow official download.
    let stale = owner && !alive(owner.pid)
    if (!owner) {
      try { stale = Date.now() - (await stat(path)).mtimeMs > 30_000 } catch { continue }
    }
    if (stale) {
      // Re-read before deleting so a replaced owner is not mistaken for the old one.
      const current = await lockOwner(path)
      if (current?.token === owner?.token) await rm(path, { force: true })
      continue
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Node runtime preparation')
    await new Promise(done => setTimeout(done, 100))
  }
}

/** Only packaging calls this. A verified immutable dist works fully offline. */
export async function prepareNodeRuntime({ root = projectRoot, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch, release = NODE_RELEASE, lockTimeoutMs = 300_000 } = {}) {
  if (platform !== 'win32' || arch !== 'x64' || release.platform !== 'win32' || release.arch !== 'x64') throw new Error('Bundled Node supports only Windows x64')
  if (!/^node-v\d+\.\d+\.\d+-win-x64$/.test(release.directory) || release.executable !== 'node.exe') throw new Error('Invalid managed Node asset path')
  const cache = join(root, 'node_modules', '.cache', 'trellis-node')
  const parent = join(cache, 'dist')
  const directory = join(parent, release.directory)
  await mkdir(parent, { recursive: true })
  const physicalRoot = await realpath(root), physicalParent = await realpath(parent)
  const parentWithin = relative(physicalRoot, physicalParent)
  if (!parentWithin || parentWithin === '..' || parentWithin.startsWith('..' + sep) || resolve(physicalRoot, parentWithin) !== physicalParent) throw new Error('Managed Node cache left its build root')
  const checked = async target => {
    if (await realpath(dirname(target)) !== physicalParent || basename(target) === '..') throw new Error('Managed Node mutation left its dist directory')
    const final = join(physicalParent, basename(target))
    try {
      const entry = await lstat(final)
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(final) !== final) throw new Error('Managed Node mutation target was redirected')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    return final
  }
  const moveDirectory = async (source, destination) => rename(await checked(source), await checked(destination))
  const removeDirectory = async target => rm(await checked(target), { recursive: true, force: true })
  const releaseLock = await acquireLock(join(cache, 'prepare-win-x64.lock'), lockTimeoutMs)
  const staging = join(parent, `.node-stage-${randomUUID()}`)
  let backup
  let published = false
  try {
    if (await validDist(directory, release)) return directory
    await mkdir(staging)
    await Promise.allSettled([
      download(release.url, join(staging, release.executable), release.sha256, 150 * 1024 * 1024, fetchImpl),
      download(release.licenseUrl, join(staging, 'LICENSE'), release.licenseSha256, 1024 * 1024, fetchImpl)
    ]).then(results => {
      const failure = results.find(result => result.status === 'rejected')
      if (failure) throw failure.reason
    })
    if (!await validDist(staging, release)) throw new Error('Prepared Node runtime failed integrity validation')
    // Build beside the destination. Preserve the existing dist until both assets
    // pass, and restore it if the final rename fails (including Windows locks).
    try {
      await stat(directory)
      backup = join(parent, `.node-backup-${randomUUID()}`)
      await moveDirectory(directory, backup)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    try { await moveDirectory(staging, directory); published = true }
    catch (error) {
      if (backup) await moveDirectory(backup, directory)
      throw error
    }
    if (backup) await removeDirectory(backup)
    return directory
  } finally {
    try {
      if (!published) await removeDirectory(staging)
    } finally { await releaseLock() }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
  try {
    const directory = await prepareNodeRuntime({ platform: flag('--platform') ?? process.env.npm_config_platform ?? process.platform, arch: flag('--arch') ?? process.env.npm_config_arch ?? process.arch })
    console.log(`Prepared official Node ${NODE_RELEASE.version} Windows x64: ${directory}`)
  } catch (error) {
    // Do not print response bodies, arbitrary URLs, proxy settings or credentials.
    console.error(`Node runtime preparation failed: ${error.code ?? (error.message?.includes('SHA256') ? 'SHA256 mismatch' : error.message?.includes('only Windows x64') ? 'unsupported platform/architecture' : 'download, cache or integrity check failed')}`)
    process.exitCode = 1
  }
}
