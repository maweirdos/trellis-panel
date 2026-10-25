import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync as fsRealpath, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { projectRoot } from '../../scripts/prepare-node-runtime.mjs'

const require = createRequire(import.meta.url)
const realpathSync = fsRealpath.native
const { build } = require('esbuild')
const directory = mkdtempSync(join(tmpdir(), 'trellis-installation-'))
const installationModule = join(directory, 'installation.cjs')
await build({ entryPoints: [join(projectRoot, 'src/main/services/acp/zcode-installation.ts')], outfile: installationModule, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' })
const { resolveZcodeInstallation, resolveZcodeOverride } = require(installationModule)

function installation(name, platform = 'win32') {
  const root = join(directory, name)
  const cli = platform === 'darwin' ? join(root, 'Contents/Resources/glm/zcode.cjs') : join(root, 'resources/glm/zcode.cjs')
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(cli, '// official layout fixture; never executed\n')
  return { root, cli }
}
const selected = installation('ZCode 安装目录 with spaces')
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const before = digest(selected.cli)
assert.deepEqual(resolveZcodeInstallation(selected.root, 'win32'), { installationRoot: realpathSync(selected.root), cliPath: realpathSync(selected.cli) })
assert.equal(resolveZcodeOverride(selected.cli), selected.cli)
const executable = join(selected.root, 'ZCode.exe')
writeFileSync(executable, 'explicit executable fixture')
assert.equal(resolveZcodeOverride(executable), executable)
assert.equal(resolveZcodeOverride('relative/zcode.cjs'), undefined)
assert.equal(resolveZcodeOverride(join(directory, 'absent')), undefined)
assert.equal(resolveZcodeOverride(selected.root), realpathSync(selected.cli))
const app = installation('ZCode.app', 'darwin')
assert.equal(resolveZcodeInstallation(app.root, 'darwin').cliPath, realpathSync(app.cli))
console.log('PASS official Windows/macOS layouts, spaces/Unicode and explicit file overrides')

const empty = join(directory, 'empty')
mkdirSync(empty)
const child = join(selected.root, 'resources')
for (const invalid of ['relative', empty, executable, child, directory]) assert.throws(() => resolveZcodeInstallation(invalid), /未保存/)
const emptyEntry = installation('empty-entry')
writeFileSync(emptyEntry.cli, '')
assert.throws(() => resolveZcodeInstallation(emptyEntry.root), /未保存/)
const aliased = join(directory, 'linked-installation')
symlinkSync(selected.root, aliased, process.platform === 'win32' ? 'junction' : 'dir')
assert.equal(resolveZcodeInstallation(aliased).cliPath, realpathSync(selected.cli))
const escaped = join(directory, 'escaped-installation')
mkdirSync(join(escaped, 'resources'), { recursive: true })
symlinkSync(dirname(selected.cli), join(escaped, 'resources/glm'), process.platform === 'win32' ? 'junction' : 'dir')
assert.throws(() => resolveZcodeInstallation(escaped), /未保存/)
console.log('PASS physical root selection; no ancestor search, file selection or escaping entry')

const setupModule = join(directory, 'setup.cjs')
globalThis.__INSTALLATION_TEST__ = {
  settings: { acp: { nodePath: process.execPath, nativePaths: { opencode: 'preserved-native', zcode: 'preserved-zcode' } } },
  dialogs: [], writes: [], prepares: [], runs: [], selection: { canceled: false, filePaths: [selected.root] }
}
const state = globalThis.__INSTALLATION_TEST__
await build({
  entryPoints: [join(projectRoot, 'src/main/services/acp/setup.ts')], outfile: setupModule,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'isolated-installation-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(electron|\.\.\/store|\.\/metadata|\.\/types|\.\/zcode-startup|(?:node:)?child_process)$/ }, args => ({ path: args.path, namespace: 'installation-mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'installation-mock' }, args => {
      const sources = {
        electron: `export const app = { isPackaged:false, getAppPath:()=>${JSON.stringify(projectRoot)} }; export const dialog={showOpenDialog:async options=>{const s=globalThis.__INSTALLATION_TEST__;s.dialogs.push(options);return s.selection}}`,
        '../store': `export const getSettings=()=>globalThis.__INSTALLATION_TEST__.settings; export const setSettings=patch=>{const s=globalThis.__INSTALLATION_TEST__;s.writes.push(patch);s.settings={...s.settings,...patch};return s.settings}`,
        './metadata': `export const acpDataPath=(...parts)=>${JSON.stringify(directory)}+'/'+parts.join('/'); export const writeJson=()=>{throw new Error('unexpected installation')}`,
        './types': `export const errorMessage=error=>error instanceof Error?error.message:String(error); export const objectValue=value=>value&&typeof value==='object'?value:{}`,
        './zcode-startup': `export const prepareBundledZcodeStartup=async(nodePath,cliPath)=>{const s=globalThis.__INSTALLATION_TEST__;s.prepares.push({nodePath,cliPath,saved:s.settings.acp.nativePaths.zcode});if(s.prepareFailure)throw new Error('fixture preparation failure')}`,
        'child_process': `export const execFile=(path,args,options,callback)=>{const s=globalThis.__INSTALLATION_TEST__;s.runs.push({path,args});callback(null,args.includes('--version')?'v24.12.0':'','')}`,
        'node:child_process': `export const execFile=(path,args,options,callback)=>{const s=globalThis.__INSTALLATION_TEST__;s.runs.push({path,args});callback(null,args.includes('--version')?(s.nodeVersion??'v24.12.0'):'','')}`
      }
      return { contents: sources[args.path], loader: 'js' }
    })
  } }]
})

const savedEnv = { PATH: process.env.PATH, Path: process.env.Path, LOCALAPPDATA: process.env.LOCALAPPDATA, TRELLIS_ZCODE_BIN: process.env.TRELLIS_ZCODE_BIN, ZCODE_BIN: process.env.ZCODE_BIN }
try {
  for (const key of Object.keys(savedEnv)) delete process.env[key]
  process.env.PATH = ''
  const setup = require(setupModule)
  for (const invalid of [empty, executable, child, escaped]) {
    state.selection = { canceled: false, filePaths: [invalid] }
    assert.equal((await setup.pickAcpRuntimePath('zcode')).ok, false)
    assert.equal(state.writes.length, 0)
    assert.equal(state.prepares.length, 0)
  }
  assert.deepEqual(state.dialogs[0].properties, ['openDirectory'])
  assert.equal(state.dialogs[0].title, '选择 ZCode 安装目录')
  console.log('PASS invalid directory fails before settings writes or cache preparation')

  state.selection = { canceled: true, filePaths: [] }
  assert.deepEqual(await setup.pickAcpRuntimePath('zcode'), { ok: true, cancelled: true })
  assert.equal(state.writes.length, 0)
  state.selection = { canceled: false, filePaths: [selected.root] }
  const result = await setup.pickAcpRuntimePath('zcode')
  assert.equal(result.ok, true)
  assert.equal(state.writes.length, 1)
  assert.equal(state.settings.acp.nativePaths.zcode, realpathSync(selected.root))
  assert.equal(state.settings.acp.nativePaths.opencode, 'preserved-native')
  assert.deepEqual(state.prepares[0], { nodePath: process.execPath, cliPath: realpathSync(selected.cli), saved: realpathSync(selected.root) })
  assert.equal(result.agents.find(agent => agent.id === 'zcode').available, true)
  const launch = await setup.resolveAcpRuntimeLaunch('zcode')
  assert.equal(launch.argv[0], process.execPath)
  assert.equal(launch.argv.at(-1), realpathSync(selected.cli))
  assert.equal(digest(selected.cli), before)
  console.log('PASS one directory selection saves the validated entry, then silently prepares; installation unchanged')

  state.prepareFailure = true
  assert.equal((await setup.pickAcpRuntimePath('zcode')).ok, true)
  assert.equal(state.settings.acp.nativePaths.zcode, realpathSync(selected.root))
  console.log('PASS startup preparation failure preserves the valid saved installation')

  state.settings.acp.nativePaths.zcode = executable
  assert.equal(setup.resolveZcodeExecutable().path, executable)
  state.settings.acp.nativePaths.zcode = selected.root
  assert.equal(setup.resolveZcodeExecutable().path, realpathSync(selected.cli))
  state.settings.acp.nativePaths.zcode = 'invalid'
  process.env.TRELLIS_ZCODE_BIN = selected.cli
  assert.equal(setup.resolveZcodeExecutable().path, selected.cli)
  console.log('PASS existing explicit file/directory settings and environment overrides remain supported')

  state.selection = { canceled: false, filePaths: [executable] }
  assert.equal((await setup.pickAcpRuntimePath('opencode')).ok, true)
  assert.deepEqual(state.dialogs.at(-1).properties, ['openFile'])
  assert.equal(state.settings.acp.nativePaths.opencode, executable)
  const writes = state.writes.length
  state.nodeVersion = 'v20.0.0'
  assert.equal((await setup.pickAcpNode()).ok, false)
  assert.equal(state.writes.length, writes)
  console.log('PASS native CLI file picker unchanged and invalid optional Node selection never saves')
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete globalThis.__INSTALLATION_TEST__
}

if (process.argv.includes('--installed')) {
  const flag = process.argv.indexOf('--installation-dir')
  const root = flag >= 0 ? process.argv[flag + 1] : join(savedEnv.LOCALAPPDATA ?? '', 'Programs/ZCode')
  const actual = resolveZcodeInstallation(root)
  console.log(`PASS actual installed ZCode directory resolves read-only: ${actual.cliPath}`)
}
