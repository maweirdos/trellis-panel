import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../../package.json', import.meta.url))
const { build } = require('esbuild')
const directory = mkdtempSync(join(tmpdir(), 'trellis-team-web-client-'))
await build({ entryPoints: ['src/client.ts'], outfile: join(directory, 'client.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const client = await import(pathToFileURL(join(directory, 'client.mjs')).href)
const { z } = await import('zod')
const account = '11111111-1111-4111-8111-111111111111', project = '22222222-2222-4222-8222-222222222222'
const storage = new Map()
globalThis.sessionStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
const session = { person: { userId: account }, authentication: 'browser', csrfToken: 'owned-test-csrf-never-persist' }
const response = (value, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status, headers: { 'Content-Type': 'application/json' } })
test('actual browser client transport and command reconciliation', async (t) => {
  const original = globalThis.fetch
  try {
    await t.test('body integrity uses actual UTF8 bytes including emoji, mismatches reject', async () => {
      const body = '# 字段🙂\n'; const hash = await client.digest(body)
      await client.verifyDocument(body, hash, new TextEncoder().encode(body).byteLength)
      await assert.rejects(client.verifyDocument(body, hash, body.length), /不一致/)
      await assert.rejects(client.verifyDocument(body + 'changed', hash, new TextEncoder().encode(body).byteLength), /不一致/)
    })
    await t.test('same-origin CSRF transport validates reply, bounds body and rejects foreign paths', async () => {
      client.setClientSession(session)
      let seen
      globalThis.fetch = async (path, init) => { seen = { path, init }; return response({ actual: true }) }
      assert.deepEqual(await client.request('/api/example', z.object({ actual: z.literal(true) }), { body: { value: 'body' } }), { actual: true })
      assert.equal(seen.init.credentials, 'same-origin'); assert.equal(seen.init.redirect, 'error'); assert.equal(seen.init.headers['X-CSRF-Token'], session.csrfToken)
      await assert.rejects(client.request('https://foreign.invalid/api/example', z.unknown()), /团队接口/)
      globalThis.fetch = async () => new Response('x', { headers: { 'Content-Length': '4000000' } })
      await assert.rejects(client.request('/api/example', z.unknown()), /限额/)
      globalThis.fetch = async () => response({ fake: 'shape' })
      await assert.rejects(client.request('/api/example', z.object({ actual: z.literal(true) })), /接口版本/)
    })
    await t.test('ACK loss keeps UUID and exact request; same in-memory retry gets original receipt', async () => {
      storage.clear(); client.setClientSession(session)
      const prepared = await client.prepareCommand('/api/materials', { text: 'PRIVATE_BODY_NEVER_PERSIST', projectId: project }, z.object({ version: z.number() }), project)
      const persisted = [...storage.values()].join(''); assert.ok(!persisted.includes('PRIVATE_BODY_NEVER_PERSIST')); assert.ok(!persisted.includes(session.csrfToken)); assert.ok(persisted.includes(prepared.entry.commandId))
      let first = true, firstBody
      globalThis.fetch = async (_path, init) => { const body = JSON.parse(init.body); if (first) { first = false; firstBody = body; throw Error('owned response lost after commit') }; assert.deepEqual(body, firstBody); return response({ status: 'duplicate', commandId: body.commandId, result: { version: 1 } }) }
      await assert.rejects(client.sendCommand(prepared), (error) => error.uncertain === true)
      assert.equal(client.pendingCommands(account)[0].state, 'unknown')
      const reply = await client.sendCommand(prepared); assert.equal(reply.commandId, prepared.entry.commandId); assert.equal(reply.status, 'duplicate'); assert.equal(client.pendingCommands(account).length, 0)
    })
    await t.test('account switch and mutated original payload cannot retarget a prepared command', async () => {
      storage.clear(); client.setClientSession(session)
      const prepared = await client.prepareCommand('/api/feedback', { body: 'Exact feedback' }, z.object({ state: z.string() }), project)
      let calls = 0; globalThis.fetch = async () => { calls++; throw Error('must not reach') }
      client.setClientSession({ ...session, person: { userId: project } })
      await assert.rejects(client.sendCommand(prepared), /账号或内容已改变/)
      client.setClientSession(session); prepared.body.body = 'mutated'
      await assert.rejects(client.sendCommand(prepared), /账号或内容已改变/); assert.equal(calls, 0)
      assert.equal(client.pendingCommands(project).length, 0)
    })
    await t.test('missing receipt stays unresolved; exact committed receipt clears only its own reference', async () => {
      storage.clear(); client.setClientSession(session)
      const one = await client.prepareCommand('/api/feedback', { body: 'A' }, z.unknown(), project)
      const two = await client.prepareCommand('/api/feedback', { body: 'B' }, z.unknown(), project)
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, code: 'NOT_FOUND', error: 'No committed receipt at this read point' }), { status: 404 })
      assert.equal(await client.reconcileCommand(one.entry), 'absent'); assert.equal(client.pendingCommands(account).length, 2)
      globalThis.fetch = async () => response({ commandId: one.entry.commandId, kind: 'recordFeedback', status: 'committed', recordedAt: Date.now(), result: {} })
      assert.equal(await client.reconcileCommand(one.entry), 'committed'); assert.equal(client.pendingCommands(account)[0].commandId, two.entry.commandId)
    })
    await t.test('account switch during awaited digest cannot dispatch under the new CSRF session', async () => {
      storage.clear(); client.setClientSession(session)
      const prepared = await client.prepareCommand('/api/materials', { text: 'original owner' }, z.unknown(), project)
      const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
      let release, entered = false; const gate = new Promise((done) => { release = done })
      const old = crypto.subtle.digest; crypto.subtle.digest = async (...args) => { entered = true; await gate; return originalDigest(...args) }
      let calls = 0; globalThis.fetch = async () => { calls++; return response({}) }
      try {
        const sending = client.sendCommand(prepared)
        assert.equal(entered, true); client.setClientSession({ ...session, person: { userId: project }, csrfToken: 'different-account-csrf' }); release()
        await assert.rejects(sending, /账号.*改变/); assert.equal(calls, 0)
      } finally { crypto.subtle.digest = old; client.setClientSession(session) }
    })
    await t.test('local journal failure after committed remote reply remains uncertain with original retry identity', async () => {
      storage.clear(); client.setClientSession(session)
      const prepared = await client.prepareCommand('/api/feedback', { body: 'record once' }, z.object({ saved: z.literal(true) }), project)
      const old = sessionStorage.setItem
      globalThis.fetch = async () => { sessionStorage.setItem = () => { throw Error('owned postcommit storage failure') }; return response({ status: 'committed', commandId: prepared.entry.commandId, result: { saved: true } }) }
      try { await assert.rejects(client.sendCommand(prepared), (error) => error.uncertain === true && error.code === 'LOCAL_RECEIPT_UNAVAILABLE') }
      finally { sessionStorage.setItem = old }
      assert.equal(client.pendingCommands(account)[0].commandId, prepared.entry.commandId)
      globalThis.fetch = async (_path, init) => { assert.equal(JSON.parse(init.body).commandId, prepared.entry.commandId); return response({ status: 'duplicate', commandId: prepared.entry.commandId, result: { saved: true } }) }
      await client.sendCommand(prepared); assert.equal(client.pendingCommands(account).length, 0)
    })
    await t.test('oversized declared response cancels the actual response stream immediately', async () => {
      let cancelled = false
      globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'Content-Length': '4000000' } })
      await assert.rejects(client.request('/api/example', z.unknown()), /限额/)
      assert.equal(cancelled, true)
    })
    await t.test('concurrent sends of one prepared command cannot both pass awaited digest and dispatch', async () => {
      storage.clear(); client.setClientSession(session)
      const prepared = await client.prepareCommand('/api/feedback', { body: 'One precise write' }, z.unknown(), project)
      let release; const gate = new Promise((done) => { release = done }); let calls = 0
      globalThis.fetch = async () => { calls++; await gate; return response({ status: 'committed', commandId: prepared.entry.commandId, result: {} }) }
      const sending = [client.sendCommand(prepared), client.sendCommand(prepared)]; const settled = Promise.allSettled(sending)
      await new Promise((done) => setTimeout(done, 40)); release()
      const results = await settled; assert.equal(calls, 1)
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
      assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'IN_FLIGHT')
    })
    await t.test('late acknowledgement for the previous account stays pinned and cannot complete under the new account', async () => {
      storage.clear(); client.setClientSession(session)
      const prepared = await client.prepareCommand('/api/feedback', { body: 'Original account only' }, z.unknown(), project)
      let release, enter; const gate = new Promise((done) => { release = done }); const entered = new Promise((done) => { enter = done })
      globalThis.fetch = async () => { enter(); await gate; return response({ status: 'committed', commandId: prepared.entry.commandId, result: {} }) }
      const sending = client.sendCommand(prepared); const observed = sending.then(() => null, (error) => error)
      await entered; client.setClientSession({ ...session, person: { userId: project }, csrfToken: 'new-account-csrf' }); release()
      const error = await observed
      assert.equal(error?.code, 'OWNER_CHANGED'); assert.equal(error.uncertain, true)
      assert.equal(client.pendingCommands(account)[0].commandId, prepared.entry.commandId); assert.equal(client.pendingCommands(project).length, 0)
      client.setClientSession(session)
      globalThis.fetch = async () => response({ commandId: prepared.entry.commandId, kind: 'recordFeedback', status: 'committed', recordedAt: Date.now(), result: {} })
      assert.equal(await client.reconcileCommand(prepared.entry), 'committed'); assert.equal(client.pendingCommands(account).length, 0)
    })
    await t.test('reloaded client retains only references and cannot reconstruct or repost a missing body', async () => {
      storage.clear(); client.setClientSession(session)
      const prepared = await client.prepareCommand('/api/feedback', { body: 'PRIVATE_RELOAD_BODY' }, z.unknown(), project)
      const reloaded = await import(pathToFileURL(join(directory, 'client.mjs')).href + '?owned-reload')
      reloaded.setClientSession(session)
      assert.equal(reloaded.pendingCommands(account)[0].commandId, prepared.entry.commandId); assert.equal(reloaded.canRetry(prepared.entry), false)
      let posts = 0
      globalThis.fetch = async (_path, init) => { if (init.method === 'POST') posts++; return new Response(JSON.stringify({ ok: false, code: 'NOT_FOUND', error: 'No receipt yet' }), { status: 404 }) }
      await assert.rejects(reloaded.retryCommand(prepared.entry), (error) => error.code === 'PAYLOAD_UNAVAILABLE')
      assert.equal(await reloaded.reconcileCommand(prepared.entry), 'absent'); assert.equal(reloaded.pendingCommands(account).length, 1); assert.equal(posts, 0)
      assert.equal([...storage.values()].join('').includes('PRIVATE_RELOAD_BODY'), false)
    })
    await t.test('account change while a receipt body streams cannot consume the original command reference', async () => {
      storage.clear(); client.setClientSession(session)
      const prepared = await client.prepareCommand('/api/feedback', { body: 'Original streaming receipt' }, z.unknown(), project)
      let release, enter; const gate = new Promise((done) => { release = done }); const entered = new Promise((done) => { enter = done })
      globalThis.fetch = async () => new Response(new ReadableStream({ async start(controller) { enter(); await gate; controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, value: { status: 'committed', commandId: prepared.entry.commandId, result: {} } }))); controller.close() } }))
      const observed = client.sendCommand(prepared).then(() => null, (error) => error)
      await entered; client.setClientSession({ ...session, person: { userId: project } }); release()
      const error = await observed; assert.equal(error?.code, 'OWNER_CHANGED'); assert.equal(error.uncertain, true)
      assert.equal(client.pendingCommands(account)[0].commandId, prepared.entry.commandId); client.setClientSession(session)
    })
    await t.test('a later authorization refusal cannot erase the unknown outcome of an earlier dispatch', async () => {
      storage.clear(); client.setClientSession(session)
      const prepared = await client.prepareCommand('/api/feedback', { body: 'Original uncertain action' }, z.unknown(), project)
      const persist = sessionStorage.setItem
      globalThis.fetch = async () => { sessionStorage.setItem = () => { throw Error('Owned unknown-label storage failure') }; throw Error('Owned original ACK lost') }
      try { await assert.rejects(client.sendCommand(prepared), (error) => error.uncertain === true) }
      finally { sessionStorage.setItem = persist }
      assert.equal(client.pendingCommands(account)[0].state, 'pending')
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, code: 'FORBIDDEN', error: 'Current membership revoked' }), { status: 403 })
      await assert.rejects(client.sendCommand(prepared), (error) => error.status === 403 && error.uncertain === true)
      assert.equal(client.pendingCommands(account)[0].commandId, prepared.entry.commandId)
      assert.equal(client.pendingCommands(account)[0].state, 'unknown'); assert.equal(client.canRetry(prepared.entry), true)
      globalThis.fetch = async () => response({ commandId: prepared.entry.commandId, kind: 'recordFeedback', status: 'committed', recordedAt: Date.now(), result: {} })
      assert.equal(await client.reconcileCommand(prepared.entry), 'committed')
    })
    await t.test('corrupt or unavailable operation journal rejects before dispatch', async () => {
      const key = [...storage.keys()][0]; storage.set(key, 'corrupt')
      let calls = 0; globalThis.fetch = async () => { calls++; return response({}) }
      await assert.rejects(client.prepareCommand('/api/materials', {}, z.unknown(), project), /无法核对/); assert.equal(calls, 0)
      storage.clear(); const old = sessionStorage.setItem; sessionStorage.setItem = () => { throw Error('denied') }
      await assert.rejects(client.prepareCommand('/api/materials', {}, z.unknown(), project), /无法保留/); sessionStorage.setItem = old; assert.equal(calls, 0)
    })
  } finally { globalThis.fetch = original; rmSync(directory, { recursive: true, force: true }) }
})
