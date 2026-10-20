import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-app-legacy-'))
const project = join(temporary, 'npm project')
const other = join(temporary, 'other')
mkdirSync(project)
mkdirSync(other)
let runtime
try {
  writeFileSync(join(project, 'service.cjs'), `const server=require('node:http').createServer((q,s)=>s.end('fixture'));server.listen(0,'127.0.0.1',()=>console.log('LEGACY_READY'));`)
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'owned-runtime-fixture', version: '1.0.0', scripts: { serve: `"${process.execPath}" service.cjs` } }))
  const entry = join(temporary, 'entry.ts')
  writeFileSync(entry, `export * from ${JSON.stringify(pathToFileURL(resolve('src/main/services/dev-run.ts')).href)};export {appRuntime} from ${JSON.stringify(pathToFileURL(resolve('src/main/services/app-runtime/index.ts')).href)};`)
  await build({ entryPoints: [entry], outfile: join(temporary, 'bundle.cjs'), bundle: true, platform: 'node', format: 'cjs', nodePaths: [resolve('node_modules')], plugins: [{ name: 'owned-legacy-host', setup(builder) {
    builder.onResolve({ filter: /^file:/ }, args => ({ path: fileURLToPath(args.path) }))
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getPath:()=>${JSON.stringify(temporary)},isPackaged:false};export const safeStorage={isEncryptionAvailable:()=>false};`, loader: 'js' }))
  } }] })
  const require = createRequire(import.meta.url)
  const api = require(join(temporary, 'bundle.cjs'))
  runtime = api.appRuntime
  const denied = await api.devRunStart(project, project, 'serve')
  assert.equal(denied.reason, 'APPROVAL_REQUIRED', 'legacy npm cannot bypass launch approval')
  const started = await api.devRunStart(project, project, 'serve', { confirm: async () => true })
  assert.equal(started.ok, true, started.error)
  const deadline = Date.now() + 18000
  let logs = ''
  while (Date.now() < deadline) {
    logs = (await api.devRunGet(project, started.run.id))?.output ?? ''
    if (logs.includes('LEGACY_READY')) break
    await new Promise(done => setTimeout(done, 150))
  }
  assert.match(logs, /LEGACY_READY/, 'real imported npm service produces output')
  const applications = await runtime.list(project)
  assert.equal(applications.ok, true)
  assert.equal(applications.apps.length, 1)
  assert.equal(applications.apps[0].run.id, started.run.id, 'legacy and application APIs share the same live instance')
  const repeated = await api.devRunStart(project, project, 'serve')
  assert.equal(repeated.ok, true)
  assert.equal(repeated.run.id, started.run.id, 'legacy repeated start reuses approved instance')
  assert.equal((await api.devRunStop(other, started.run.id)).ok, false, 'other project cannot stop the owned run')
  assert.equal((await runtime.list(project)).apps[0].processState, 'running')
  assert.deepEqual((await api.devRunList(other)), [], 'legacy list is project-scoped')
  const stopped = await api.devRunStop(project, started.run.id)
  assert.equal(stopped.ok, true, stopped.error)
  assert.equal((await api.devRunGet(project, started.run.id)).state, 'stopped')
  assert.equal((await api.devRunStopAll(project)).stopped, 0, 'stop-all counts only active owned runs')
  console.log('PASS real legacy npm migration: approval, service output, shared instance, repeat start, project-isolated list/stop and verified tree shutdown')
} finally {
  if (runtime) await runtime.shutdown()
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-app-legacy-'))
  rmSync(temporary, { recursive: true, force: true })
}
