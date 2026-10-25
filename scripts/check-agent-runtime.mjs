import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const tests = [
  ['compatibility', 'acpx-preparation.mjs'],
  ...Array.from({ length: 4 }, (_, index) => [`protocol-${index + 1}`, 'acpx-runtime.mjs', `--shard=${index + 1}/4`]),
  ['knowledge-core', 'knowledge-core.mjs'], ['knowledge-tools', 'knowledge-mcp.mjs'],
  ['on-demand', 'knowledge-on-demand.mjs'], ['role-context', 'acp-agent-context.mjs'],
  ['connection-timings', 'acp-connection-timings.mjs'], ['search-coverage', 'knowledge-search-ranking.mjs'],
  ['output-replay', 'acp-tool-output.mjs'], ['role-ui', 'acp-agent-context-ui.mjs'],
  ['zcode-translation', 'acp-zcode-translate.mjs'], ['bulk-transport', 'runtime-blobs.mjs'],
  ['conversation-concurrency', 'conversation-concurrency.mjs'],
  ['conversation-admission', 'conversation-admission.mjs'],
  ['conversation-switching', 'conversation-switching.mjs'],
  ['daemon-build-identity', 'daemon-build-identity.mjs'],
  ['daemon-build-manager', 'daemon-build-manager.mjs'],
  ['daemon-build-stop', 'daemon-build-stop.mjs'],
  ['daemon-build-application', 'daemon-build-application.mjs'],
  ['startup-diagnostics', 'daemon-startup-diagnostics.mjs'],
  ['native-launch', 'daemon-native-launch.mjs'],
  ['daemon-tray', 'daemon-tray.mjs'],
  ['daemon-settings-controls', 'daemon-settings-controls.mjs'],
  ['zcode-startup-log', 'zcode-startup.mjs'],
  ['zcode-startup-fs-probe', '../../adapters/zcode-acp/test/startup-fs-probe.mjs'],
  ['managed-node', 'managed-node.mjs'],
  ['managed-node-packaging', 'managed-node-packaging.mjs'],
  ['zcode-installation', 'installation.mjs'],
  ['zcode-upgrade', 'zcode-upgrade.mjs'],
  ['managed-plugin-cache', '../../adapters/zcode-acp/test/managed-plugin-cache.mjs'],
  ['managed-plugin-cache-review', '../../adapters/zcode-acp/test/managed-plugin-cache-review.mjs'],
  ['managed-empty-persistence', '../../adapters/zcode-acp/test/managed-empty-persistence.mjs'],
  ['managed-startup-glue', 'zcode-managed-startup.mjs'],
  ['zcode-connection', '../../adapters/zcode-acp/test/connection-timings.mjs']
]
const selection = process.argv.find(value => value.startsWith('--only='))?.slice('--only='.length)
const selected = selection ? tests.filter(([name]) => name.includes(selection)) : tests
if (!selected.length) throw new Error(`No runtime checks match ${selection}`)
const directory = mkdtempSync(join(tmpdir(), 'trellis-agent-runtime-checks-'))
let next = 0
let failed = 0
async function run([name, file, ...args]) {
  const started = Date.now()
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve('tests/agent-runtime', file), ...args], {
    windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  const collect = bytes => { output = (output + bytes.toString()).slice(-1024 * 1024) }
  child.stdout.on('data', collect); child.stderr.on('data', collect)
  const timer = setTimeout(() => {
    output += '\nRuntime check deadline exceeded.\n'
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
    else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill() } }
  }, 600_000)
  const status = await new Promise(done => {
    child.once('error', error => { collect(Buffer.from(error.message)); done(1) })
    child.once('close', code => done(code === 0 ? 0 : 1))
  })
  clearTimeout(timer)
  writeFileSync(join(directory, `${name}.log`), output)
  if (status !== 0) { failed += 1; console.error(`FAIL ${name}\n${output.slice(-16_000)}`) }
  else console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
}
await Promise.all(Array.from({ length: Math.min(2, selected.length) }, async () => {
  while (next < selected.length) await run(selected[next++])
}))
console.log(`${selected.length - failed}/${selected.length} runtime check groups passed; logs: ${directory}`)
process.exitCode = failed ? 1 : 0
