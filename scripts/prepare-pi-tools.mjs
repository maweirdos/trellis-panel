/** Prepare a pinned, verified fd for Windows dev and the external packaged SDK. No runtime download. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PI_FIND_RELEASE = Object.freeze(JSON.parse(await readFile(join(projectRoot, 'src/main/services/pi/engine/find-runtime-release.json'), 'utf8')))

async function valid(directory) {
  try {
    const physical = await realpath(directory)
    if (physical !== directory) return false
    for (const [name, digest] of Object.entries(PI_FIND_RELEASE.files)) {
      const file = join(directory, name)
      if (await realpath(file) !== file || !(await lstat(file)).isFile() || createHash('sha256').update(await readFile(file)).digest('hex') !== digest) return false
    }
    return true
  } catch { return false }
}

async function checkedDirectory(root, path) {
  await mkdir(path, { recursive: true })
  const physical = await realpath(path)
  const part = relative(await realpath(root), physical)
  if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`) || physical !== path) throw new Error('Pi tool destination was redirected outside its build directory')
  for (const name of Object.keys(PI_FIND_RELEASE.files)) {
    try {
      if (!(await lstat(join(path, name))).isFile()) throw new Error('Pi tool destination is not an ordinary file')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return path
}

export async function preparePiTools({ root = projectRoot, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch } = {}) {
  if (platform !== 'win32') return
  if (arch !== PI_FIND_RELEASE.arch) throw new Error('The bundled Pi find runtime requires Windows x64')
  root = await realpath(root)
  const cache = join(root, 'node_modules', '.cache', 'trellis-pi-tools', PI_FIND_RELEASE.directory)
  const output = join(root, 'out', 'pi-engine', 'node_modules', 'trellis-pi-tools')
  if (!await valid(cache)) {
    const staging = await realpath(await mkdtemp(join(tmpdir(), 'trellis-pi-fd-')))
    try {
      const response = await fetchImpl(PI_FIND_RELEASE.url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok || !response.body) throw new Error(`Official fd download failed (HTTP ${response.status})`)
      const chunks = []
      let length = 0
      for await (const chunk of response.body) {
        length += chunk.length
        if (length > 20 * 1024 * 1024) throw new Error('Official fd download exceeds 20 MiB')
        chunks.push(chunk)
      }
      const archive = Buffer.concat(chunks)
      if (createHash('sha256').update(archive).digest('hex') !== PI_FIND_RELEASE.sha256) throw new Error('Official fd download SHA256 mismatch')
      const zip = join(staging, 'fd.zip')
      await writeFile(zip, archive, { flag: 'wx' })
      const systemRoot = process.env.SystemRoot
      if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('Windows SystemRoot is required to extract the fd release')
      const extraction = spawnSync(join(systemRoot, 'System32', 'tar.exe'), ['xf', zip, '-C', staging], { windowsHide: true, timeout: 30_000, stdio: 'pipe' })
      if (extraction.error || extraction.status !== 0) throw new Error('Official fd archive extraction failed')
      const source = join(staging, PI_FIND_RELEASE.directory)
      if (!await valid(source)) throw new Error('Extracted fd assets failed integrity verification')
      await checkedDirectory(root, cache)
      for (const name of Object.keys(PI_FIND_RELEASE.files)) await copyFile(join(source, name), join(cache, name))
    } finally {
      // mkdtemp returns our exact OS TEMP directory; never remove a resolved external target.
      if (await realpath(staging) !== staging) throw new Error('Pi tool staging directory was redirected')
      await rm(staging, { recursive: true, force: true })
    }
  }
  if (!await valid(cache)) throw new Error('Cached fd assets failed integrity verification')
  if (!await valid(output)) {
    await checkedDirectory(root, output)
    for (const name of Object.keys(PI_FIND_RELEASE.files)) await copyFile(join(cache, name), join(output, name))
  }
  if (!await valid(output)) throw new Error('Prepared fd assets failed integrity verification')
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = await preparePiTools()
    if (directory) console.log(`Prepared fd ${PI_FIND_RELEASE.version} for Pi: ${directory}`)
  } catch (error) {
    console.error(`Pi tool preparation failed: ${error.message}`)
    process.exitCode = 1
  }
}
