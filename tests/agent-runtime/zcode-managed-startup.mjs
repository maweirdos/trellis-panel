import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { managedZcodeLaunch } from '../../adapters/zcode-acp/src/managed-startup.mjs'

const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-zcode-managed-glue-')))
try {
  const profile = join(directory, 'profile'), project = join(directory, 'application'), native = join(directory, 'official installation')
  mkdirSync(profile); mkdirSync(native); mkdirSync(project)
  const cli = join(native, 'native.cjs'), marker = join(native, 'ran.json')
  writeFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');console.log(JSON.stringify({argv:process.argv.slice(1),file:__filename,dir:__dirname,cwd:process.cwd(),main:require.main===module}));`)
  const cache = join(profile, 'cache')
  const launch = managedZcodeLaunch(process.execPath, cli, ['app-server', '--cwd', directory], cache)
  assert.ok(launch)
  const env = { ...process.env, TRELLIS_ZCODE_STARTUP_CACHE_DIR: cache }
  delete env.ELECTRON_RUN_AS_NODE
  const ran = await promisify(execFile)(launch.command, launch.args, { cwd: directory, env, windowsHide: true, timeout: 10000 })
  const observed = JSON.parse(ran.stdout)
  assert.deepEqual(observed.argv, [cli, 'app-server', '--cwd', directory])
  assert.equal(observed.main, true); assert.equal(observed.file, cli); assert.equal(observed.dir, native); assert.equal(observed.cwd, directory)
  assert.ok(existsSync(marker)); rmSync(marker)
  await assert.rejects(promisify(execFile)(process.execPath, [launch.args[0], '--prepare', cli], { cwd: directory, env, windowsHide: true, timeout: 10000 }), error => {
    assert.equal(error.code, 2); assert.equal(JSON.parse(error.stdout).status, 'unsupported'); return true
  })
  assert.ok(!existsSync(marker), 'Unsupported preparation cannot execute the selected entry')
  assert.equal(managedZcodeLaunch(process.execPath, cli, [], 'relative'), undefined)
  assert.equal(managedZcodeLaunch(process.execPath, cli.replace('.cjs', '.mjs'), [], cache), undefined)

  const fakeLoader = join(project, 'adapters', 'zcode-acp', 'src', 'managed-zcode-launch.cjs')
  mkdirSync(dirname(fakeLoader), { recursive: true })
  const calls = join(directory, 'preparations.jsonl')
  writeFileSync(fakeLoader, `const fs=require('node:fs'),p=require('node:path');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),cache:process.env.TRELLIS_ZCODE_STARTUP_CACHE_DIR})+'\\n');const name=p.basename(process.argv[3]);const status=name.startsWith('unsupported')?'unsupported':name.startsWith('degraded')?'degraded':'prepared';setTimeout(()=>{process.stdout.write(name.startsWith('invalid')?'SECRET-FIXTURE':JSON.stringify({version:1,status,secret:'SECRET-FIXTURE'}));process.exitCode=status==='unsupported'?2:status==='degraded'?1:0},30);`)
  const modulePath = join(directory, 'service.cjs')
  await build({ entryPoints: ['src/main/services/acp/zcode-startup.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'cjs', plugins: [{ name: 'owned-startup-context', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={isPackaged:false,getAppPath:()=>${JSON.stringify(project)},getPath:()=>${JSON.stringify(profile)}};` }))
  } }] })
  const service = createRequire(import.meta.url)(modulePath)
  const first = service.prepareBundledZcodeStartup(process.execPath, cli)
  assert.equal(first, service.prepareBundledZcodeStartup(process.execPath, cli), 'One selected install has one preparation')
  await first
  const statusFile = join(service.zcodeStartupCacheDirectory(), 'preparation-status.json')
  assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).status, 'prepared')
  const firstCalls = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(firstCalls.length, 1)
  assert.deepEqual(firstCalls[0].args, ['--prepare', cli])
  assert.equal(firstCalls[0].cache, service.zcodeStartupCacheDirectory())
  for (const [name, expected] of [['unsupported', 'unsupported'], ['degraded', 'fallback'], ['invalid', 'fallback']]) {
    const input = join(native, name + '.cjs'); writeFileSync(input, '')
    await service.prepareBundledZcodeStartup(process.execPath, input)
    assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).status, expected)
    assert.ok(!readFileSync(statusFile, 'utf8').includes('SECRET-FIXTURE'))
  }
  const beforeRedirect = readFileSync(calls, 'utf8')
  const cachePath = service.zcodeStartupCacheDirectory()
  assert.ok(cachePath.startsWith(directory + sep))
  renameSync(cachePath, cachePath + '.valid')
  symlinkSync(native, cachePath, process.platform === 'win32' ? 'junction' : 'dir')
  await service.prepareBundledZcodeStartup(process.execPath, cli)
  assert.equal(readFileSync(calls, 'utf8'), beforeRedirect)
  assert.ok(!existsSync(join(native, 'preparation-status.json')), 'Cache redirection cannot write into the installation')
  console.log('PASS managed backend glue, official fallback identity, silent preparation coalescing, exit statuses, bounded diagnostics and redirected-cache refusal')
} finally {
  assert.ok(directory.startsWith(join(realpathSync.native(tmpdir()), 'trellis-zcode-managed-glue-')))
  rmSync(directory, { recursive: true, force: true })
}
