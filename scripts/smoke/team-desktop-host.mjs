/** Actual Electron composition timers/quit; team service/OS are explicit fixtures. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-team-host-')))
const r = globalThis.__TEAM_HOST__ = { root: temporary, opened: 0, closed: 0, sent: [], actions: [], connections: [{ connectionId: 'active-a', state: 'active', accessLocked: false }, { connectionId: 'pending-b', state: 'pending', accessLocked: false, nextPollAt: 0 }], rows: [{ commandId: 'queued-a', state: 'queued' }, { commandId: 'unknown-a', state: 'acknowledgement-unknown' }, { commandId: 'dispatched-a', state: 'dispatching' }, { commandId: 'committed-a', state: 'committed' }] }
const mocks = {
  electron: 'export const app={getPath:()=>globalThis.__TEAM_HOST__.root,get isPackaged(){return globalThis.__TEAM_HOST__.packaged===true}};',
  './bridge': 'export const broadcastToWindows=(channel,payload)=>globalThis.__TEAM_HOST__.sent.push({channel,payload});',
  './team-platform': `const r=globalThis.__TEAM_HOST__;const service={connections:async()=>r.connections,pollPairing:async(id)=>{r.actions.push(['poll',id]);r.connections.find(item=>item.connectionId===id).state='expired';return{}},heartbeat:async(id)=>{r.actions.push(['heartbeat',id]);return{}},syncEvents:async(id)=>{r.actions.push(['sync',id]);return r.syncResult??{snapshotRequired:true,page:{items:[]}}},refreshSharedSnapshot:async(id)=>{r.actions.push(['snapshot',id]);return{}},outbox:async(id,input)=>{r.actions.push(['outbox',id,input]);return{items:r.rows,nextCursor:null,hasMore:false}},dispatch:async(id,options)=>{r.actions.push(['dispatch',id,options]);r.rows.find(item=>item.commandId===id).state='committed';return{}},close:async()=>{r.closed++}};export const DesktopTeamService={open:async options=>{r.opened++;r.options=options;return service}};`
}
const checks = [], check = async (name, action) => { await action(); checks.push({ name, status: 'passed' }) }
const wait = async (predicate, label, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return; await new Promise((done) => setTimeout(done, 20)) } throw Error('Timeout: ' + label) }
let host
try {
  await build({ entryPoints: ['src/main/services/team-desktop.ts'], outfile: join(temporary, 'host.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'explicit-team-host-boundaries', setup(builder) { builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'host-fixture' } : null); builder.onLoad({ filter: /.*/, namespace: 'host-fixture' }, (args) => ({ contents: mocks[args.path], loader: 'js' })) } }] })
  host = await import(pathToFileURL(join(temporary, 'host.mjs')).href)
  await check('ordinary application resume does not create a team store without an existing marker', async () => { host.resumeDesktopTeamBackground(); await new Promise((done) => setTimeout(done, 20)); assert.equal(r.opened, 0) })
  await check('actual host restores only never-dispatched queues, heartbeats/polls and authorized metadata catch-up', async () => {
    await host.withDesktopTeamService(async (service) => service.connections())
    assert.equal(r.opened, 1); assert.equal(r.options.dataDir, join(temporary, 'team-platform')); assert.equal(r.options.allowLoopbackHttp, undefined)
    await wait(() => r.actions.some(([kind]) => kind === 'dispatch'), 'actual background tick')
    assert.deepEqual(r.actions.filter(([kind]) => kind === 'dispatch').map(([, id]) => id), ['queued-a'])
    assert.equal(r.actions.find(([kind]) => kind === 'dispatch')[2], undefined, 'No automatic retryUnknown option')
    assert.ok(r.actions.some(([kind]) => kind === 'heartbeat')); assert.ok(r.actions.some(([kind]) => kind === 'poll')); assert.ok(r.actions.some(([kind]) => kind === 'snapshot'))
    assert.ok(r.sent.every(({ payload }) => Object.keys(payload).sort().join(',') === 'connectionId,occurredAt,reason'))
  })
  await check('temporary quit admission closure stops new calls and resumes scheduling after cancellation', async () => {
    host.setDesktopTeamAdmissionClosed(true)
    const count = r.actions.length
    await assert.rejects(host.withDesktopTeamService(async () => true), (error) => error.code === 'SERVICE_CLOSED')
    await new Promise((done) => setTimeout(done, 2100)); assert.equal(r.actions.length, count)
    host.setDesktopTeamAdmissionClosed(false)
    await wait(() => r.actions.length > count, 'schedule restored without new service identity')
    assert.equal(r.opened, 1)
  })
  await check('actual host closes admissions and waits the original in-flight call before closing the writer', async () => {
    await host.withDesktopTeamService(async (service) => {
      const original = service.close
      let failed = false
      service.close = async () => { if (!failed) { failed = true; throw Object.assign(Error('original writer close not confirmed'), { code: 'ACKNOWLEDGEMENT_UNKNOWN' }) } await original() }
    })
    let resume; const gate = new Promise((done) => { resume = done })
    const operation = host.withDesktopTeamService(async () => { await gate; return 'original-result' })
    const close = host.closeDesktopTeamService()
    await new Promise((done) => setTimeout(done, 25)); assert.equal(r.closed, 0)
    await assert.rejects(host.withDesktopTeamService(async () => true), (error) => error.code === 'SERVICE_CLOSED')
    resume(); assert.equal(await operation, 'original-result')
    await assert.rejects(close, (error) => error.code === 'ACKNOWLEDGEMENT_UNKNOWN'); assert.equal(r.closed, 0)
    await host.closeDesktopTeamService(); await host.closeDesktopTeamService()
    assert.equal(r.closed, 1)
  })
  await check('main-only loopback fixture allowance is explicit development-only and cannot downgrade packaged defaults', async () => {
    const original = process.env.TRELLIS_TEAM_ALLOW_LOOPBACK_HTTP
    try {
      for (const [packaged, flag, allowed] of [[false, '1', true], [true, '1', undefined], [false, undefined, undefined]]) {
        r.packaged = packaged
        if (flag === undefined) delete process.env.TRELLIS_TEAM_ALLOW_LOOPBACK_HTTP; else process.env.TRELLIS_TEAM_ALLOW_LOOPBACK_HTTP = flag
        const scoped = await import(pathToFileURL(join(temporary, 'host.mjs')).href + '?fixture=' + String(packaged) + String(flag))
        try { await scoped.withDesktopTeamService(async (service) => service.connections()); assert.equal(r.options.allowLoopbackHttp, allowed) }
        finally { await scoped.closeDesktopTeamService() }
      }
    } finally { r.packaged = false; if (original === undefined) delete process.env.TRELLIS_TEAM_ALLOW_LOOPBACK_HTTP; else process.env.TRELLIS_TEAM_ALLOW_LOOPBACK_HTTP = original }
  })
  await check('ordinary relevant event pages refresh persisted metadata without treating backlog as snapshot completeness', async () => {
    r.connections = [{ connectionId: 'event-active', state: 'active', accessLocked: false }]
    r.syncResult = { snapshotRequired: false, page: { items: [{ eventId: 'actual-service-event-shape-owned-fixture' }], hasMore: true } }
    const scoped = await import(pathToFileURL(join(temporary, 'host.mjs')).href + '?event-refresh')
    try {
      await scoped.withDesktopTeamService(async (service) => service.connections())
      await wait(() => r.actions.some(([kind, owner]) => kind === 'snapshot' && owner === 'event-active'), 'normal event-triggered actual host tick')
      assert.equal(r.actions.filter(([kind, owner]) => kind === 'snapshot' && owner === 'event-active').length, 1)
      assert.equal(r.syncResult.page.hasMore, true)
    } finally { await scoped.closeDesktopTeamService(); delete r.syncResult }
  })
  const report = { status: 'passed', groups: checks.length, scope: 'Actual production host timers/admission/quit with explicit team service fixture; real SQLite/HTTP/protected credential tests owned separately', results: checks }
  const index = process.argv.indexOf('--report'); if (index >= 0) { const path = resolve(process.argv[index + 1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2)) }
  console.log(`PASS team desktop host: ${checks.length} groups`)
} finally {
  if (host) await host.closeDesktopTeamService()
  assert.equal(dirname(realpathSync.native(temporary)), realpathSync.native(tmpdir())); assert.ok(basename(temporary).startsWith('trellis-team-host-'))
  rmSync(temporary, { recursive: true, force: true }); delete globalThis.__TEAM_HOST__
}
