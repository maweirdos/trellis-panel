import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const acpxDigest = (bytes) => createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')).digest('hex')
export async function matchesAcpxFiles(packageDirectory, files) {
  for (const [file, expected] of Object.entries(files)) {
    if (!/^dist\/[A-Za-z0-9_.-]+$/.test(file)) throw new Error('Invalid managed acpx file path')
    try {
      const bytes = await readFile(join(packageDirectory, file))
      if (expected === null || acpxDigest(bytes) !== expected) return false
    } catch (error) { if (error.code !== 'ENOENT' || expected !== null) return false }
  }
  return true
}

async function readResolvedPackage(request, name) {
  let directory = dirname(request.resolve(name))
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (metadata.name === name) return metadata
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Cannot locate metadata for resolved public package ${name}`)
}

/** Check before build/start, including installs that deliberately skipped scripts. */
export async function checkAcpxCompatibility(root = projectRoot, { requirePatched = true } = {}) {
  const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
  const project = await readJson(join(root, 'package.json'))
  const manifest = await readJson(join(root, 'patches/acpx-compat.json'))
  const request = createRequire(join(root, 'package.json'))
  const packagePath = request.resolve('acpx/package.json')
  const metadata = await readJson(packagePath)
  if (project.dependencies?.acpx !== manifest.version || metadata.version !== manifest.version) {
    throw new Error(`acpx must be pinned and installed at ${manifest.version}; review the compatibility patch before upgrading`)
  }
  const patch = await readFile(join(root, 'patches', manifest.patch))
  // Git/patch-package may normalize CRLF or the final newline on Windows.
  const digest = acpxDigest
  if (digest(patch) !== manifest.patchSha256) throw new Error('acpx compatibility patch checksum mismatch; review and regenerate its manifest')
  if (manifest.upgradeFrom && digest(await readFile(join(root, 'patches', manifest.upgradeFrom.patch))) !== manifest.upgradeFrom.patchSha256) throw new Error('Recognized acpx upgrade patch checksum mismatch')
  const sdk = await readResolvedPackage(createRequire(packagePath), '@agentclientprotocol/sdk')
  if (project.overrides?.acpx?.['@agentclientprotocol/sdk'] !== manifest.sdkVersion || sdk.version !== manifest.sdkVersion) {
    throw new Error(`ACP SDK must be pinned by the acpx override and installed at ${manifest.sdkVersion}; review compatibility before upgrading`)
  }
  if (!requirePatched) return { manifest, packagePath }
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (digest(await readFile(join(dirname(packagePath), file))) !== expected) {
      throw new Error(`acpx compatibility patch is absent or incomplete (${file}); run npm run prepare:acpx`)
    }
  }
  // Resolve only the public runtime entrypoint. The file hashes guard partial patches.
  const runtime = await import(pathToFileURL(request.resolve('acpx/runtime')).href)
  if (runtime.TRELLIS_ACPX_COMPAT_VERSION !== manifest.compatVersion) {
    throw new Error('acpx runtime compatibility version mismatch; run npm run prepare:acpx')
  }
  if (JSON.stringify(runtime.TRELLIS_ACPX_PROCESS_CONTRACT) !== JSON.stringify(manifest.processContract)) throw new Error('acpx native process ownership capability is absent or incompatible')
  return { version: metadata.version, compatVersion: runtime.TRELLIS_ACPX_COMPAT_VERSION }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await checkAcpxCompatibility()
    console.log(`acpx ${result.version} compatibility v${result.compatVersion} verified`)
  } catch (error) {
    console.error(`ACP dependency preparation failed: ${error.message}`)
    process.exitCode = 1
  }
}
