import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { managedZcodeLaunch } from '../../adapters/zcode-acp/src/managed-startup.mjs'

const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-zcode-upgrade-')))
try {
  const root = join(directory, '官方 ZCode installation'), cache = join(directory, 'cache')
  mkdirSync(join(root, 'resources', 'glm'), { recursive: true }); mkdirSync(cache)
  const cli = join(root, 'resources', 'glm', 'zcode.cjs')
  const shape = version => `if(module.__trellisManagedCache)throw Error('stale patch applied');process.stdout.write(JSON.stringify({version:${JSON.stringify(version)},argv:process.argv.slice(1),cwd:process.cwd(),entry:__filename,main:require.main===module}));`
  writeFileSync(cli, shape('simulated-old'))
  writeFileSync(join(cache, 'managed-zcode-ready.json'), JSON.stringify({ version: 1, status: 'prepared', nativeSha256: '97490d0f06a7a225d54d47817acf4b4859cdb268b59f2490caaeda982bef063a' }))
  const modulePath = join(directory, 'installation.cjs')
  await build({ entryPoints: ['src/main/services/acp/zcode-installation.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'cjs' })
  const installation = createRequire(import.meta.url)(modulePath)
  const originalEntry = installation.resolveZcodeInstallation(root).cliPath
  for (const version of ['simulated-old', 'simulated-upgraded', 'simulated-rollback']) {
    writeFileSync(cli, shape(version))
    assert.equal(installation.resolveZcodeOverride(root), originalEntry, 'Saved installation directory needs no reselection after an in-place update')
    const launch = managedZcodeLaunch(process.execPath, originalEntry, ['app-server', '--stdio', '--cwd', directory], cache)
    const env = { ...process.env, TRELLIS_ZCODE_STARTUP_CACHE_DIR: cache, TRELLIS_ZCODE_CLI_SHA256: '97490d0f06a7a225d54d47817acf4b4859cdb268b59f2490caaeda982bef063a' }
    delete env.ELECTRON_RUN_AS_NODE
    const { stdout } = await promisify(execFile)(launch.command, launch.args, { cwd: directory, env, windowsHide: true, timeout: 10000 })
    const result = JSON.parse(stdout)
    assert.equal(result.version, version)
    assert.deepEqual(result.argv, [originalEntry, 'app-server', '--stdio', '--cwd', directory])
    assert.equal(result.cwd, directory); assert.equal(result.entry, originalEntry); assert.equal(result.main, true)
    assert.equal(readFileSync(cli, 'utf8'), shape(version), 'Managed launch never replaces the vendor file')
  }
  console.log('PASS controlled in-place upgrade/rollback uses current official bytes, preserves directory/argv/workspace, ignores stale cache markers and rejects ENV hash overrides')
} finally {
  assert.ok(directory.startsWith(join(realpathSync.native(tmpdir()), 'trellis-zcode-upgrade-')))
  rmSync(directory, { recursive: true, force: true })
}
