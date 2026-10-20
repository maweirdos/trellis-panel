import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createRuntimeHarness, createService, freePort, until } from './fixtures/app-runtime-harness.mjs'

const fixture = await createRuntimeHarness()
const { runtime, project, api } = fixture
const external = createServer()
let recovery
try {
  const port = await freePort()
  createService(project)
  writeFileSync(join(project, '.env'), `RUNTIME_PORT=${port}\nRUNTIME_CHILD=enabled\nRUNTIME_OUTPUT=flood\n`)
  const config = { id: 'tree', name: 'Owned child tree', launch: { kind: 'argv', executable: process.execPath, args: ['service.mjs'] }, envFiles: ['.env'], ports: [{ port }], readiness: { kind: 'tcp', port, timeoutMs: 10000 }, stopTimeoutMs: 15000 }
  assert.equal((await runtime.save(project, { config })).ok, true)
  await new Promise((accept) => external.listen(port, '127.0.0.1', accept))
  const conflict = await runtime.start(project, 'tree', { confirm: async () => true })
  assert.equal(conflict.reason, 'PORT_CONFLICT')
  assert.equal(external.listening, true)
  await new Promise((accept) => external.close(accept))
  const running = await runtime.start(project, 'tree')
  assert.equal(running.ok, true, JSON.stringify(running))
  await until(async () => (await runtime.get(project, 'tree')).app.readiness.state === 'ready')
  await until(async () => {
    const stored = JSON.parse(readFileSync(join(api.runtimeDirectory(), readdirSync(api.runtimeDirectory())[0]), 'utf8'))
    return stored.applications[0].lastRun.identities.length >= 2
  })
  const storedPath = join(api.runtimeDirectory(), readdirSync(api.runtimeDirectory())[0])
  const stored = JSON.parse(readFileSync(storedPath, 'utf8'))
  const identities = stored.applications[0].lastRun.identities
  assert(identities.length >= 2, 'Foreground descendant must be tracked')
  await until(async () => (await runtime.logs(project, 'tree')).outputTruncated)
  const logs = await runtime.logs(project, 'tree')
  assert(Buffer.byteLength(logs.output) <= api.APP_RUNTIME_LIMITS.outputBytes)
  const stopped = await runtime.stop(project, 'tree')
  assert.equal(stopped.ok, true, JSON.stringify(stopped))
  const current = await api.processSnapshot()
  assert(!identities.some((identity) => current.some((row) => api.sameProcess(identity, row))))
  assert.equal(stopped.app.ports[0].state, 'available')
  console.log('PASS external listener preserved; owned foreground root+descendant verified gone; oversized output bounded')

  // A recycled PID with a different creation identity must never become stop authority.
  const live = current.find((row) => row.pid === process.pid)
  assert(live)
  stored.applications[0].lastRun = { ...stored.applications[0].lastRun, state: 'running', pid: process.pid, identities: [{ ...live, createdAt: 'not-the-current-creation-time' }] }
  writeFileSync(storedPath, JSON.stringify(stored))
  recovery = new api.ApplicationRuntime()
  const recovered = await recovery.get(project, 'tree')
  assert.equal(recovered.ok, true)
  assert.equal(recovered.app.processState, 'exited')
  assert.equal((await recovery.stop(project, 'tree')).ok, true)
  assert.equal(process.kill(process.pid, 0), true)
  console.log('PASS stale/reused PID is verified as old identity gone and never killed')
  runtime.closeAdmission()
  assert.equal((await runtime.start(project, 'tree')).reason, 'SHUTTING_DOWN')
  runtime.reopenAdmission()
  assert.equal((await runtime.start(project, 'tree')).ok, true)
  await runtime.shutdown()
  assert.equal(await runtime.hasOwnedApplications(), false)
  console.log('PASS admission gate and verified shutdown across project applications')
} finally { if (external.listening) await new Promise((accept) => external.close(accept)); if (recovery) await recovery.shutdown(); await fixture.close() }
console.log('app-runtime process smoke passed')
