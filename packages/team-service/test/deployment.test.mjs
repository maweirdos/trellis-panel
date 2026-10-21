/** Install the real built package without dev dependencies and serve actual sockets/static files. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { freePort } from './oidc-fixture.mjs'

test('isolated production-only install loads the actual built worker and reserves API/auth paths from Web fallback', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-production-'))
  const origin = `http://127.0.0.1:${await freePort()}`
  const packageRoot = join(directory, 'service'); mkdirSync(packageRoot)
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(file, join(packageRoot, file))
  cpSync('dist', join(packageRoot, 'dist'), { recursive: true })
  const webDir = join(directory, 'web'); mkdirSync(join(webDir, 'assets'), { recursive: true })
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><body><h1>Owned supplemental Web fixture</h1><script src="/assets/app.js"></script></body></html>')
  writeFileSync(join(webDir, 'assets/app.js'), 'globalThis.ownedWebFixture=true')
  writeFileSync(join(webDir, 'assets/.private'), 'Must not be served')
  writeFileSync(join(packageRoot, 'host.mjs'), `import {createTeamService} from './dist/index.mjs';
const service=await createTeamService(${JSON.stringify({ dataDir: join(directory, 'data'), publicOrigin: origin, oidc: { issuer: 'https://issuer-owned.invalid', clientId: 'owned-production-fixture' }, bootstrapSubject: 'owned-admin', allowLoopbackHttp: true, webDir })});
await service.app.listen({port:${Number(new URL(origin).port)},host:'127.0.0.1'});process.send({ready:true});
process.on('message',async message=>{if(message?.action==='close'){await service.close();process.send({closed:true});process.disconnect()}});`)
  let child
  try {
    const npm = process.env.npm_execpath
    assert.ok(npm && existsSync(npm), 'Run this deployment check through npm test')
    await promisify(execFile)(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: packageRoot, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 })
    assert.equal(existsSync(join(packageRoot, 'node_modules/oidc-provider')), false)
    assert.equal(existsSync(join(packageRoot, 'node_modules/esbuild')), false)
    child = fork(join(packageRoot, 'host.mjs'), [], { cwd: packageRoot, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const output = []; child.stderr.on('data', (chunk) => output.push(chunk.toString()))
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Owned production child did not become ready')), 20000)
      child.once('error', reject); child.once('exit', (code) => reject(Error(`Owned production child exited ${code}: ${output.join('')}`)))
      child.on('message', (message) => { if (message.ready) { clearTimeout(timeout); resolve() } })
    })
    const page = await fetch(origin); assert.equal(page.status, 200); assert.match(await page.text(), /Owned supplemental Web fixture/)
    assert.equal((await fetch(origin + '/ready')).status, 200)
    const asset = await fetch(origin + '/assets/app.js'); assert.equal(asset.status, 200); assert.match(await asset.text(), /ownedWebFixture/)
    assert.equal((await fetch(origin + '/assets/.private')).status, 403)
    assert.equal((await fetch(origin + '/api/session')).status, 401)
    for (const path of ['/api', '/api/unknown', '/auth', '/auth/unknown', '/assets']) {
      const response = await fetch(origin + path); assert.equal(response.status, 404); assert.match(response.headers.get('content-type'), /application\/json/); assert.equal((await response.json()).ok, false)
    }
    const exit = new Promise((resolve, reject) => { child.once('exit', (code) => code === 0 ? resolve() : reject(Error('Owned production child failed during close'))); child.send({ action: 'close' }) })
    await exit; child = null
  } finally {
    if (child && child.exitCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill(); await exited }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-production-')); rmSync(directory, { recursive: true, force: true })
  }
})
