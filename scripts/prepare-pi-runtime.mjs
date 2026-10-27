/** Ship the unmodified public SDK and its installed production closure outside ASAR for external Node. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparePiTools } from './prepare-pi-tools.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modules = join(root, 'node_modules')
const output = join(root, 'out', 'pi-engine', 'node_modules')
const local = relative(root, output)
if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Pi runtime output is outside the project')
if (!existsSync(join(root, 'out/pi-engine/engine.mjs'))) throw new Error('Build the Pi engine before preparing its dependencies')
const physicalParent = relative(realpathSync(root), realpathSync(dirname(output)))
if (!physicalParent || physicalParent.startsWith('..') || isAbsolute(physicalParent) || existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('Pi runtime output is redirected outside the build directory')
if (existsSync(output)) rmSync(output, { recursive: true })
mkdirSync(output, { recursive: true })
const visited = new Set()
const piNames = new Set()
function locate(name, from) {
  for (let directory = from; ; directory = dirname(directory)) {
    const path = join(directory, 'node_modules', name)
    if (existsSync(join(path, 'package.json'))) return path
    if (directory === root || dirname(directory) === directory) break
  }
  throw new Error(`Missing installed Pi production dependency: ${name}`)
}
function copyPackage(name, from, optional = false) {
  let source
  try { source = locate(name, from) } catch (error) { if (optional) return; throw error }
  if (visited.has(source)) return
  visited.add(source)
  const path = relative(modules, source)
  if (path.startsWith('..') || isAbsolute(path)) throw new Error('Pi dependency resolves outside installed project modules')
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  piNames.add(manifest.name)
  if (name.startsWith('@earendil-works/pi-') && manifest.version !== '1.4.0') throw new Error(`Mixed Pi versions: ${name}@${manifest.version}`)
  const destination = join(output, path)
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source)) {
    if (entry === 'node_modules') continue
    cpSync(join(source, entry), join(destination, entry), { recursive: true, dereference: false })
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) copyPackage(dependency, source, Object.hasOwn(manifest.optionalDependencies ?? {}, dependency))
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) copyPackage(dependency, source, true)
  for (const dependency of Object.keys(manifest.peerDependencies ?? {})) if (!manifest.peerDependenciesMeta?.[dependency]?.optional) copyPackage(dependency, source)
}
copyPackage('@earendil-works/pi-coding-agent', root)
copyPackage('zod', root)
copyPackage('undici', root)
await preparePiTools({ root })
// Shared host dependencies stay in ASAR. Pi-only packages ship once in the external SDK closure.
const hostVisited = new Set(), hostNames = new Set()
function collectHost(name, from, optional = false) {
  let source
  try { source = locate(name, from) } catch (error) { if (optional) return; throw error }
  if (hostVisited.has(source)) return
  hostVisited.add(source)
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  hostNames.add(manifest.name)
  for (const dependency of Object.keys(manifest.dependencies ?? {})) collectHost(dependency, source, Object.hasOwn(manifest.optionalDependencies ?? {}, dependency))
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) collectHost(dependency, source, true)
  for (const dependency of Object.keys(manifest.peerDependencies ?? {})) collectHost(dependency, source, Boolean(manifest.peerDependenciesMeta?.[dependency]?.optional))
}
const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const name of Object.keys(project.dependencies)) if (name !== '@earendil-works/pi-coding-agent') collectHost(name, root)
const exclusions = [...piNames].filter(name => !hostNames.has(name)).sort().map(name => `!**/node_modules/${name}{,/**/*}`)
writeFileSync(join(dirname(output), 'sdk-manifest.json'), JSON.stringify({ version: '1.4.0', packages: visited.size, exclusions }, null, 2))
console.log(`Prepared Pi 1.4.0 external runtime: ${visited.size} production packages`)
