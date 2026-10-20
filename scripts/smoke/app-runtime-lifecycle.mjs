import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-app-quit-'))
try {
  await build({ entryPoints: ['src/main/services/quit-gate.ts'], outfile: join(temporary, 'quit-gate.cjs'), bundle: true, platform: 'node', format: 'cjs' })
  const require = createRequire(import.meta.url)
  const { createQuitGate } = require(join(temporary, 'quit-gate.cjs'))
  const calls = []
  let confirm = false
  let failed = false
  let pendingStop
  const gate = createQuitGate({
    hasApplications: async () => true,
    confirmApplications: async () => { calls.push('confirm'); return confirm },
    setAdmissionClosed: closed => calls.push(closed ? 'close-admission' : 'open-admission'),
    stopApplications: async () => { calls.push('stop-applications'); if (pendingStop) await pendingStop; if (failed) throw Error('owned cleanup incomplete') },
    stopSessions: async () => calls.push('stop-sessions'),
    finalize: () => calls.push('finalize'),
    quit: () => calls.push('quit'),
    reportError: error => calls.push(error.message)
  })
  let prevented = 0
  const event = { preventDefault: () => { prevented += 1 } }
  gate.beforeQuit(event)
  await gate.whenIdle()
  assert.deepEqual(calls, ['confirm'], 'cancellation leaves every subsystem and admission intact')
  calls.length = 0
  confirm = true
  failed = true
  gate.beforeQuit(event)
  await gate.whenIdle()
  assert.deepEqual(calls, ['confirm', 'close-admission', 'stop-applications', 'open-admission', 'owned cleanup incomplete'], 'failed application cleanup preserves sessions and permits retry')
  calls.length = 0
  failed = false
  let release
  pendingStop = new Promise(done => { release = done })
  gate.beforeQuit(event)
  gate.beforeQuit(event)
  await new Promise(done => setImmediate(done))
  assert.deepEqual(calls, ['confirm', 'close-admission', 'stop-applications'], 'concurrent quit cannot duplicate cleanup or finalize early')
  release()
  await gate.whenIdle()
  assert.deepEqual(calls, ['confirm', 'close-admission', 'stop-applications', 'stop-sessions', 'finalize', 'quit'])
  assert.equal(prevented, 4)
  gate.beforeQuit(event)
  assert.equal(prevented, 4, 'settled reentrant quit is allowed')
  console.log('PASS quit cancellation, cleanup failure/retry, admission, serialization, session drain and reentrant final quit')

  writeFileSync(join(temporary, 'electron.cjs'), `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { createQuitGate } = require('./quit-gate.cjs');
app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))});
app.disableHardwareAcceleration();
const order = []; let confirm = false; let final = false;
const gate = createQuitGate({
  hasApplications: async () => true,
  confirmApplications: async () => { order.push('confirm'); return confirm; },
  setAdmissionClosed: closed => order.push(closed ? 'admission-closed' : 'admission-open'),
  stopApplications: async () => order.push('apps-verified'),
  stopSessions: async () => order.push('sessions-drained'),
  finalize: () => { order.push('finalize'); final = true; },
  quit: () => app.quit(),
  reportError: error => { console.error(error); app.exit(1); }
});
app.on('before-quit', gate.beforeQuit);
app.on('will-quit', () => {
  assert.equal(final, true);
  assert.deepEqual(order, ['confirm', 'confirm', 'admission-closed', 'apps-verified', 'sessions-drained', 'finalize']);
  console.log('PASS actual Electron before-quit cancellation, owned cleanup ordering and final quit');
});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  window.on('close', event => { if (!final) { event.preventDefault(); window.hide(); } });
  window.close();
  assert.equal(window.isDestroyed(), false, 'close-to-tray keeps the application host alive');
  assert.deepEqual(order, []);
  app.quit(); await gate.whenIdle();
  assert.equal(window.isDestroyed(), false, 'cancelled complete exit preserves host');
  assert.equal(final, false);
  confirm = true; app.quit();
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('quit fixture timed out'); app.exit(1); }, 12000).unref();
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(require('electron'), [join(temporary, 'electron.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-app-quit-'))
  rmSync(temporary, { recursive: true, force: true })
}
