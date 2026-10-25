import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

if (process.platform !== 'win32') { console.log('SKIP Windows native launch'); process.exit(0) }
const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-daemon-native-launch-')))
const output = join(directory, 'peer.json')
const peer = join(directory, '启动 peer.mjs')
const pause = ms => new Promise(done => setTimeout(done, ms))
let pid
const alive = () => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
async function until(test) { const deadline = Date.now() + 15000; while (!test()) { assert.ok(Date.now() < deadline, 'Native launch peer deadline'); await pause(25) } }
try {
  writeFileSync(peer, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(output)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));setTimeout(()=>{},4000);`)
  const file = join(directory, 'launch.cjs')
  await build({ entryPoints: ['src/main/daemon/launch.ts'], outfile: file, bundle: true, platform: 'node', format: 'cjs', plugins: [{ name: 'actual-owned-native-resource', setup(builder) {
    builder.onResolve({ filter: /^\.\/native$/ }, () => ({ path: 'native', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const nativeResource=name=>${JSON.stringify(resolve('resources/daemon'))}+'/'+name;export const powershellPath=()=>${JSON.stringify(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'))};` }))
  } }] })
  const api = createRequire(import.meta.url)(file)
  const args = [peer, '--trellis-role=daemon', '--trellis-user-data-base64=' + Buffer.from(directory).toString('base64')]
  const result = await api.launchDaemonProcess(args, process.env)
  pid = result.pid
  await until(() => existsSync(output))
  const observed = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(observed.pid, pid)
  assert.deepEqual(observed.args, args.slice(1), 'Spaces and Unicode preserve exact argument boundaries')
  assert.equal(alive(), true, 'Helper output pipes close while the independent peer still runs')
  await assert.rejects(api.launchDaemonProcess([peer, '--trellis-role=gui', args[2]], process.env), error => error.code === 'E_INVALID_ARG')
  await until(() => !alive())
  console.log('PASS actual Windows CreateProcess: no inherited control pipes, exact Unicode/spaced argv, independent owned peer exit')
} finally {
  if (pid) await until(() => !alive())
  assert.ok(directory.startsWith(join(realpathSync.native(tmpdir()), 'trellis-daemon-native-launch-')))
  rmSync(directory, { recursive: true, force: true })
}
