import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve, dirname, relative, isAbsolute, sep, basename } from 'node:path'
import { readFile, writeFile, unlink, realpath, mkdtemp, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { checkAcpxCompatibility, matchesAcpxFiles, projectRoot } from './check-acpx-compat.mjs'

export async function prepareAcpx(root = projectRoot) {
  const { manifest, packagePath } = await checkAcpxCompatibility(root, { requirePatched: false })
  const packageDirectory = await realpath(dirname(packagePath)), localRoot = await realpath(join(root, 'node_modules'))
  const packageRelative = relative(localRoot, packageDirectory)
  if (!packageRelative || isAbsolute(packageRelative) || packageRelative === '..' || packageRelative.startsWith(`..${sep}`)) throw new Error('Only this project-owned local acpx installation may be prepared')
  const request = createRequire(join(root, 'package.json'))
  const patchPackage = request('patch-package/package.json')
  if (patchPackage.version !== '8.0.1') throw new Error('Exact patch-package@8.0.1 is required for dependency preparation')
  if (await matchesAcpxFiles(packageDirectory, manifest.files)) return await checkAcpxCompatibility(root)
  const previous = manifest.upgradeFrom && await matchesAcpxFiles(packageDirectory, manifest.upgradeFrom.files)
  if (!previous && !await matchesAcpxFiles(packageDirectory, manifest.pristineFiles)) throw new Error('Installed acpx has unrecognized modifications; original files preserved')
  const snapshot = new Map()
  for (const file of Object.keys(manifest.files)) {
    try { snapshot.set(file, await readFile(join(packageDirectory, file))) }
    catch (error) { if (error.code !== 'ENOENT') throw error; snapshot.set(file, null) }
  }
  const patch = (args) => {
    const result = spawnSync(process.execPath, [request.resolve('patch-package/index.js'), '--error-on-fail', ...args], { cwd: root, stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`patch-package failed (exit ${result.status ?? result.signal})`)
  }
  let temporary
  let patchAlias
  try {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'trellis-acpx-upgrade-')))
    const cache = join(localRoot, '.cache'); await mkdir(cache, { recursive: true })
    const actualCache = await realpath(cache), part = relative(localRoot, actualCache)
    if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('acpx patch cache escaped local node_modules')
    patchAlias = join(actualCache, basename(temporary))
    await symlink(temporary, patchAlias, process.platform === 'win32' ? 'junction' : 'dir')
    const writePatch = async (file) => writeFile(join(temporary, manifest.patch), (await readFile(join(root, 'patches', file), 'utf8')).replace(/\r\n/g, '\n'))
    const patchDirectory = relative(root, patchAlias)
    if (previous) {
      // patch-package compares deleted-file bodies byte-for-byte. Its Windows
      // output may be CRLF even though the verified patch is canonical LF.
      for (const [file, bytes] of snapshot) if (bytes !== null) await writeFile(join(packageDirectory, file), bytes.toString('utf8').replace(/\r\n/g, '\n'))
      await writePatch(manifest.upgradeFrom.patch)
      patch(['--reverse', '--patch-dir', patchDirectory])
      if (!await matchesAcpxFiles(packageDirectory, manifest.pristineFiles)) throw new Error('Recognized acpx reversal did not produce the pinned pristine package')
    }
    await writePatch(manifest.patch)
    patch(['--patch-dir', patchDirectory])
    return await checkAcpxCompatibility(root)
  } catch (error) {
    // Restore only the exact managed dependency bytes verified before this attempt.
    for (const [file, bytes] of snapshot) {
      if (bytes === null) await unlink(join(packageDirectory, file)).catch(failure => { if (failure.code !== 'ENOENT') throw failure })
      else await writeFile(join(packageDirectory, file), bytes)
    }
    throw error
  } finally {
    if (patchAlias) {
      if (await realpath(patchAlias) !== temporary) throw new Error('acpx patch alias changed identity')
      await unlink(patchAlias)
    }
    if (temporary) {
      const part = relative(await realpath(tmpdir()), await realpath(temporary))
      if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('acpx temporary upgrade path escaped OS TEMP')
      await rm(temporary, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await prepareAcpx()
    console.log(`Prepared acpx ${result.version} compatibility v${result.compatVersion}`)
  } catch (error) {
    console.error(`ACP dependency preparation failed: ${error.message}`)
    process.exitCode = 1
  }
}
