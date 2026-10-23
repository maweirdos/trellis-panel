// Real setup.ts with isolated store/electron and owned native peer; no downloads/providers.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ZcodeBackend, lastErrorLogPath } from '../../adapters/zcode-acp/src/zcode-backend.mjs'

const root = mkdtempSync(join(tmpdir(), 'trellis-zcode-launch-'))
const priorEnvironment = { bin: process.env.ZCODE_BIN, trellisBin: process.env.TRELLIS_ZCODE_BIN, options: process.env.NODE_OPTIONS }
const cwd = process.cwd()
try {
  // Bundled settings test: use a custom definition override only for unrelated native probes.
  const defaultSettings = { nodePath: process.execPath, agents: [
    { id: 'opencode', name: 'owned', command: 'fixture', enabled: false },
    { id: 'dsh', name: 'owned', command: 'fixture', enabled: false }
  ] }
  // Expose the isolated settings port from the same bundled module instance.
  await build({ stdin: { contents: `export * from ${JSON.stringify(resolve('src/main/services/acp/setup.ts').replaceAll('\\', '/'))};export { setSettings } from '../store'`, resolveDir: resolve('src/main/services/acp'), loader: 'ts' },
    outfile: join(root, 'ports.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'ports', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      build.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store', namespace: 'fixture' }))
      build.onResolve({ filter: /^\.\/metadata$/ }, () => ({ path: 'metadata', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron'
        ? `export const app={isPackaged:false,getAppPath:()=>${JSON.stringify(cwd)}};export const dialog={}`
        : args.path === 'metadata' ? `import {join} from 'node:path';export const acpDataPath=(...parts)=>join(${JSON.stringify(root)},...parts);export const writeJson=()=>{}`
          : `let settings={};export const getSettings=()=>settings;export const setSettings=(value)=>{settings=value}` }))
    } }] })
  const ports = await import(pathToFileURL(join(root, 'ports.mjs')).href)
  const peer = resolve('scripts/smoke/fixtures/zcode-native-peer.mjs')
  ports.setSettings({ acp: defaultSettings })
  process.env.ZCODE_BIN = join(root, 'missing.cjs')
  process.env.TRELLIS_ZCODE_BIN = peer
  const config = ports.runtimeDefinitions().find(value => value.id === 'zcode')
  const argv = await ports.launchArgv(config)
  assert.equal(argv[0], process.execPath)
  assert.equal(argv[argv.indexOf('--zcode-bin') + 1], peer)
  assert.ok(argv.includes('--experimental-strip-types'))
  process.env.NODE_OPTIONS = '--no-experimental-sqlite'
  await assert.rejects(ports.launchArgv(config), /node:sqlite/)
  if (priorEnvironment.options === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = priorEnvironment.options
  assert.equal(ports.resolveAdapterEntry(), resolve('adapters/zcode-acp/src/index.mjs'))

  if (process.platform === 'win32') {
    const directory = join(root, 'path with spaces')
    mkdirSync(directory)
    const shim = join(directory, 'zcode.cmd')
    writeFileSync(shim, `@"${process.execPath}" "${peer}" %*\r\n`)
    const backend = new ZcodeBackend({ nodePath: process.execPath, zcodeBin: shim, workspacePath: directory, isolatedDir: directory })
    try {
      await backend.waitReady()
      const snapshot = await backend.request('session/create', { workspace: { workspacePath: directory, workspaceKey: directory }, persistence: 'immediate' })
      assert.equal(snapshot.session.sessionId, 'sess_owned_zcode')
    } finally { await backend.killTree() }
  }
  const noReady = join(root, 'never-ready.cjs')
  writeFileSync(noReady, 'setInterval(()=>{},1000)')
  const backend = new ZcodeBackend({ nodePath: process.execPath, zcodeBin: noReady, workspacePath: root, isolatedDir: root })
  try { await assert.rejects(backend.waitReady(), /startup\/storageState ready.*超时/) }
  finally { await backend.killTree() }
  assert.equal(existsSync(lastErrorLogPath(root)), false, 'Standalone backend does not write an uncorrelated global diagnostic')
  console.log('PASS bundled env discovery, SQLite rejection, Windows batch path with spaces, readiness deadline and owned cleanup')
} finally {
  for (const [key, value] of [['ZCODE_BIN', priorEnvironment.bin], ['TRELLIS_ZCODE_BIN', priorEnvironment.trellisBin], ['NODE_OPTIONS', priorEnvironment.options]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
}
