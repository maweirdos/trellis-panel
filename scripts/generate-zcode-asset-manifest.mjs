/** Maintainer generation for an explicitly supported installed artifact only. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { CLI_SHA256, inspectCompatibility } = require('../adapters/zcode-acp/src/managed-cache-compat.cjs')
const { loadMain } = require('../adapters/zcode-acp/src/managed-zcode-launch.cjs')
const index = process.argv.indexOf('--zcode-bin')
assert.ok(index >= 0 && isAbsolute(process.argv[index + 1] ?? ''), 'Pass an explicit installed CLI path')
const original = realpathSync.native(process.argv[index + 1])
const bytes = readFileSync(original)
assert.ok(inspectCompatibility(bytes).supported, 'Unreviewed native artifacts cannot generate the shipped digest table')
const source = bytes.toString('utf8')
const entry = 'bQe();mSc();async function mSc'
assert.equal(source.split(entry).length, 2)
const previousArgv = process.argv
process.argv = [process.execPath, original]
let native
try { native = loadMain(original, source.replace(entry, 'bQe();hEt();module.exports=Roc();async function mSc')) }
finally { process.argv = previousArgv }
assert.equal(native?.kind, 'filesystem')
const resources = dirname(dirname(original))
const plugins = native.plugins.map(plugin => {
  const rootRelative = relative(resources, plugin.rootPath).replaceAll('\\', '/')
  assert.ok(rootRelative && !rootRelative.startsWith('..') && !isAbsolute(rootRelative))
  return { name: plugin.definition.name, version: plugin.definition.version, rootRelative,
    files: plugin.files.map(file => ({ path: file.path, mode: file.mode, sha256: file.sha256, size: statSync(file.sourcePath).size })) }
})
const manifest = { version: 1, cliSha256: CLI_SHA256, plugins }
const output = join(project, 'adapters', 'zcode-acp', 'src', 'managed-plugin-assets.json')
writeFileSync(output, JSON.stringify(manifest) + '\n')
console.log(JSON.stringify({ plugins: plugins.length, files: plugins.reduce((sum, plugin) => sum + plugin.files.length, 0), bytes: statSync(output).size }))
