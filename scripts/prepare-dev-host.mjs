import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Link unchanged runtime files, copying when the filesystem cannot hard-link. */
function copyRuntime(source, target) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) copyRuntime(from, to)
    else if (entry.name.toLowerCase() !== 'electron.exe') {
      // The executable is generated separately; never edit a linked source file.
      try { linkSync(from, to) } catch { copyFileSync(from, to, constants.COPYFILE_FICLONE) }
    }
  }
}

/** Prepare an isolated Windows development host; never rewrite the installed SDK. */
export async function prepareDevHost() {
  const original = require('electron')
  if (process.platform !== 'win32') return original
  if (basename(original).toLowerCase() !== 'electron.exe') {
    throw new Error('The development host must keep electron.exe so app.isPackaged remains false')
  }

  const brand = JSON.parse(readFileSync(join(root, 'resources/brand/identity.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const icon = readFileSync(join(root, 'resources/brand/icon.ico'))
  const binary = readFileSync(original)
  const fingerprint = createHash('sha256')
    .update(binary).update(icon).update(JSON.stringify(brand)).update(pkg.version)
    .update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  const cacheRoot = join(root, 'node_modules/.cache/trellis-panel/electron-host')
  const destination = join(cacheRoot, fingerprint.slice(0, 24))
  const executablePath = join(destination, 'electron.exe')
  const marker = join(destination, 'brand.json')
  if (existsSync(executablePath) && existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).fingerprint === fingerprint) {
    return executablePath
  }

  const { NtExecutable, NtExecutableResource, Resource, Data } = await import('resedit')
  const executable = NtExecutable.from(binary, { ignoreCert: true })
  const resources = NtExecutableResource.from(executable)
  const versions = Resource.VersionInfo.fromEntries(resources.entries)
  if (!versions.length) throw new Error('Electron host has no Windows version resource')
  for (const version of versions) {
    const languages = version.getAllLanguagesForStringValues()
    if (!languages.length) languages.push({ lang: 1033, codepage: 1200 })
    for (const language of languages) {
      version.setStringValues(language, {
        FileDescription: brand.name,
        // Native notifications derive their Start Menu filename from ProductName.
        ProductName: brand.developmentProductName,
        InternalName: 'trellis-panel-dev',
        OriginalFilename: 'electron.exe'
      })
      version.setProductVersion(pkg.version, language.lang)
    }
    version.outputToResourceEntries(resources.entries)
  }
  const icons = Data.IconFile.from(icon).icons.map((entry) => entry.data)
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
  if (!groups.length) throw new Error('Electron host has no Windows icon resource')
  for (const group of groups) Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons)
  resources.outputResource(executable)

  // Publish a complete, content-addressed runtime. Existing/running versions stay intact.
  mkdirSync(cacheRoot, { recursive: true })
  const staging = join(cacheRoot, `${fingerprint.slice(0, 24)}.preparing-${randomUUID()}`)
  copyRuntime(dirname(original), staging)
  writeFileSync(join(staging, 'electron.exe'), Buffer.from(executable.generate()))
  writeFileSync(join(staging, 'brand.json'), JSON.stringify({ fingerprint, name: brand.name, productName: brand.developmentProductName }))
  try {
    renameSync(staging, destination)
  } catch (error) {
    // A concurrent launcher may have published the same immutable runtime first.
    if (!existsSync(marker) || JSON.parse(readFileSync(marker, 'utf8')).fingerprint !== fingerprint) throw error
  }
  return executablePath
}
