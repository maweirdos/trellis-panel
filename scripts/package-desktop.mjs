import builder from 'electron-builder'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareTeamTrellisBundle } from './prepare-team-trellis.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = JSON.parse(readFileSync(join(root, 'out/pi-engine/sdk-manifest.json'), 'utf8'))
function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || !isAbsolute(value)) throw new Error(`${name} requires an absolute path`)
  return resolve(value)
}
const output = option('--output'), prepackaged = option('--prepackaged')
if (sdk.version !== '1.4.0' || !Array.isArray(sdk.exclusions) || sdk.exclusions.some(pattern => typeof pattern !== 'string' || !/^!\*\*\/node_modules\/[\w@/.-]+\{,\/\*\*\/\*\}$/.test(pattern))) throw new Error('Pi packaging inventory is invalid; prepare the pinned runtime first')
prepareTeamTrellisBundle()
await builder.build({ projectDir: root,
  targets: builder.Platform.WINDOWS.createTarget(process.argv.includes('--dir') ? 'dir' : undefined, builder.Arch.x64),
  ...(prepackaged ? { prepackaged } : {}), publish: 'never',
  // Builder loads electron-builder.yml itself. Re-supplying its resource arrays
  // concatenates them and races two copies/signers on the same Node executable.
  config: { ...(output ? { directories: { output } } : {}), files: sdk.exclusions } })
