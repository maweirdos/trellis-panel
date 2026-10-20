import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createRuntimeHarness, freePort, until } from './fixtures/app-runtime-harness.mjs'

const fixture = await createRuntimeHarness()
const { runtime, project, api } = fixture
const sockets = new Set()
const trickle = createServer(socket => {
  sockets.add(socket)
  socket.once('data', () => {
    socket.write('HTTP/1.1 200 OK\r\nX-Slow: ')
    const timer = setInterval(() => socket.write('x'), 75)
    socket.once('close', () => clearInterval(timer))
  })
  socket.once('close', () => sockets.delete(socket))
})
try {
  await new Promise(done => trickle.listen(0, '127.0.0.1', done))
  const cancellation = new AbortController()
  const startedAt = Date.now()
  const watchdog = setTimeout(() => cancellation.abort(), 4500)
  const ready = await api.probeOnce({ kind: 'http', url: `http://127.0.0.1:${trickle.address().port}`, timeoutMs: 10000 }, cancellation.signal)
  clearTimeout(watchdog)
  assert.equal(ready, false)
  assert(Date.now() - startedAt < 3000, 'trickled headers must not extend the per-attempt deadline')
  console.log('PASS HTTP readiness has an absolute attempt deadline despite ongoing header bytes')

  const port = await freePort()
  writeFileSync(join(project, 'readiness.cjs'), `const http=require('node:http');const server=http.createServer((req,res)=>{res.end('ok');if(req.url==='/close')server.close()});server.listen(${port},'127.0.0.1');setInterval(()=>{},1000);`)
  const saved = await runtime.save(project, { config: { id: 'readiness', name: 'Readiness', cwd: '.', launch: { kind: 'argv', executable: process.execPath, args: ['readiness.cjs'] }, ports: [{ port }], readiness: { kind: 'http', url: `http://127.0.0.1:${port}`, timeoutMs: 10000 }, stopTimeoutMs: 15000 } })
  assert.equal(saved.ok, true, saved.error)
  assert.equal((await runtime.start(project, 'readiness', { confirm: async () => true })).ok, true)
  await until(async () => (await runtime.get(project, 'readiness')).app.readiness.state === 'ready')
  await (await fetch(`http://127.0.0.1:${port}/close`)).text()
  await until(async () => (await runtime.get(project, 'readiness')).app.readiness.state === 'unhealthy')
  const observed = (await runtime.get(project, 'readiness')).app
  assert.equal(observed.processState, 'running', 'failed probe must not invent a process exit')
  assert.equal(observed.ports[0].state, 'available')
  assert.equal((await runtime.stop(project, 'readiness')).ok, true)
  console.log('PASS live process whose HTTP listener closes becomes unhealthy instead of retaining stale ready state')
} finally {
  for (const socket of sockets) socket.destroy()
  await new Promise(done => trickle.close(done))
  await fixture.close()
}
