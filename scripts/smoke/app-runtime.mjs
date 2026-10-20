import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntimeHarness, createService, freePort, until } from './fixtures/app-runtime-harness.mjs'

const fixture = await createRuntimeHarness()
const { runtime, project, api } = fixture
let otherRuntime
try {
  const parsed = api.parseEnv("# comment\nexport A=first\nA=last # comment\nB='literal # hash'\nC=\"escaped\\nline\"\nD=$(not-executed)\nE=${literal}\n")
  assert.deepEqual({ ...parsed }, { A: 'last', B: 'literal # hash', C: 'escaped\nline', D: '$(not-executed)', E: '${literal}' })
  for (const malformed of ['SECRET=\"unclosed', 'invalid name=secret', 'SECRET=\"x\" garbage', 'SECRET=x\0y']) assert.throws(() => api.parseEnv(malformed), (error) => !error.message.includes('secret'))
  assert.deepEqual(api.mergeEnvironment({ Path: 'base' }, [{ PATH: 'file' }, { path: 'override' }], true), { path: 'override' })
  assert.deepEqual({ ...api.parseEnv('PASSWORD=abc#def\nCOMMENTED=abc # comment\nEMPTY=# comment') }, { PASSWORD: 'abc#def', COMMENTED: 'abc', EMPTY: '' })
  assert.equal(Object.getOwnPropertyDescriptor(api.mergeEnvironment({}, [api.parseEnv('__proto__=literal')]), '__proto__')?.value, 'literal')
  const redacted = []
  const redactor = api.outputRedactor(['private-秘密-token'], (text) => redacted.push(text))
  const secretBytes = Buffer.from('prefix private-秘密-token suffix')
  for (const byte of secretBytes) redactor.write(Buffer.from([byte]))
  redactor.end()
  assert.equal(redacted.join(''), 'prefix [REDACTED] suffix')
  assert(Buffer.byteLength(api.boundedTail('界'.repeat(200000)).value) <= api.APP_RUNTIME_LIMITS.outputBytes)
  console.log('PASS env grammar, literal parsing, diagnostic secrecy, Windows key precedence, UTF-8 redaction and byte bounds')

  const port = await freePort()
  createService(project)
  writeFileSync(join(project, '.env'), `RUNTIME_PORT=${port}\nFIXTURE_VALUE=first-value\nFIXTURE_OVERRIDE=from-file\n`)
  let saved = await runtime.save(project, { config: { id: 'backend', name: 'Backend', cwd: '.', launch: { kind: 'argv', executable: process.execPath, args: ['service.mjs'] }, envFiles: ['.env'], ports: [{ port }], readiness: { kind: 'http', url: `http://127.0.0.1:${port}`, timeoutMs: 10000 } }, overrides: [{ key: 'FIXTURE_OVERRIDE', action: 'replace', value: 'protected-override-secret' }] })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.deepEqual(saved.app.definition.overrideKeys, ['FIXTURE_OVERRIDE'])
  assert(!JSON.stringify(await runtime.list(project)).includes('protected-override-secret'))
  const files = readdirSync(api.runtimeDirectory())
  const stored = readFileSync(join(api.runtimeDirectory(), files[0]), 'utf8')
  assert(!stored.includes('protected-override-secret'))
  assert(api.runtimeDirectory().endsWith('app-runtimes-dev'))
  assert.equal((await runtime.start(project, 'backend')).reason, 'APPROVAL_REQUIRED')
  assert.equal((await runtime.start(project, 'backend', { confirm: async () => false })).ok, false)
  assert.equal((await runtime.get(project, 'backend')).app.run, null)
  let approvals = 0
  const approve = async (preview) => { approvals += 1; assert(!JSON.stringify(preview).includes('protected-override-secret')); return true }
  const first = await runtime.start(project, 'backend', { expectedRevision: saved.app.definition.revision, confirm: approve })
  assert.equal(first.ok, true, JSON.stringify(first))
  await until(async () => (await runtime.get(project, 'backend')).app.readiness.state === 'ready')
  const response = await (await fetch(`http://127.0.0.1:${port}`)).json()
  assert.equal(response.value, 'first-value')
  assert.equal(response.override, 'protected-override-secret')
  assert.equal(process.env.FIXTURE_VALUE, undefined)
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => runtime.start(project, 'backend')))
  assert(concurrent.every((result) => result.ok && result.app.run.id === first.app.run.id))
  writeFileSync(join(project, '.env'), `RUNTIME_PORT=${port}\nFIXTURE_VALUE=updated-value\nFIXTURE_OVERRIDE=changed-file\n`)
  const restarted = await runtime.restart(project, 'backend')
  assert.equal(restarted.ok, true, JSON.stringify(restarted))
  assert.notEqual(restarted.app.run.id, first.app.run.id)
  await until(async () => (await runtime.get(project, 'backend')).app.readiness.state === 'ready')
  assert.equal((await (await fetch(`http://127.0.0.1:${port}`)).json()).value, 'updated-value')
  assert.equal(approvals, 1)
  assert.equal((await runtime.stop(project, 'backend')).app.processState, 'stopped')
  otherRuntime = new api.ApplicationRuntime()
  const loaded = await otherRuntime.list(project)
  assert.equal(loaded.apps[0].definition.id, 'backend')
  assert.equal(loaded.apps[0].approval, 'approved')
  console.log('PASS protected persistence, first-use/denial approval, single instance, real HTTP readiness, env reload and verified restart')

  saved = await runtime.save(project, { config: { ...saved.app.definition, launch: { kind: 'argv', executable: process.execPath, args: ['service.mjs', '--changed'] } }, expectedRevision: saved.app.definition.revision })
  assert.equal(saved.ok, true)
  assert.equal((await runtime.start(project, 'backend')).reason, 'APPROVAL_REQUIRED')
  const stale = await runtime.save(project, { config: saved.app.definition, expectedRevision: 'old-revision' })
  assert.equal(stale.code, 'E_CONFLICT')
  const scriptPath = join(project, 'service.mjs')
  const scriptBefore = readFileSync(scriptPath, 'utf8')
  const timestamps = statSync(scriptPath)
  const changedDuringApproval = await runtime.start(project, 'backend', { confirm: async () => {
    writeFileSync(scriptPath, scriptBefore.replace('fixture service listening', 'fixture service different'))
    utimesSync(scriptPath, timestamps.atime, timestamps.mtime)
    return true
  } })
  assert.equal(changedDuringApproval.code, 'E_CONFLICT', JSON.stringify(changedDuringApproval))
  assert.notEqual((await runtime.get(project, 'backend')).app.processState, 'running')
  writeFileSync(scriptPath, scriptBefore)
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { 'dev&quoted': 'node service.mjs' } }))
  const imported = await runtime.importNpm(project, project, 'dev&quoted')
  assert.equal(imported.ok, true)
  const customized = await runtime.save(project, { config: { ...imported.app.definition, envFiles: ['.env'], ports: [{ port }] }, expectedRevision: imported.app.definition.revision })
  assert.equal(customized.ok, true)
  const reimported = await runtime.importNpm(project, project, 'dev&quoted')
  assert.equal(reimported.app.definition.revision, customized.app.definition.revision)
  assert.deepEqual(reimported.app.definition.envFiles, ['.env'])
  console.log('PASS content-sensitive script approval despite same timestamp/size; npm import preserves customized definitions')
  writeFileSync(join(project, '.env'), 'TOKEN=\"unclosed-private-value')
  const badEnv = await runtime.start(project, 'backend', { confirm: approve })
  assert.equal(badEnv.ok, false)
  assert(!JSON.stringify(badEnv).includes('unclosed-private-value'))
  process.env.APP_RUNTIME_TEST_ENCRYPTION = 'off'
  const noEncryption = await runtime.save(project, { config: { id: 'unsafe', name: 'Unsafe', launch: { kind: 'argv', executable: process.execPath, args: [] } }, overrides: [{ key: 'TOKEN', action: 'replace', value: 'never-store-plaintext' }] })
  assert.equal(noEncryption.code, 'E_DENIED')
  assert(!(await runtime.list(project)).apps.some((app) => app.definition.id === 'unsafe'))
  const raceConfig = { id: 'creation-race', name: 'Creation race', launch: { kind: 'argv', executable: process.execPath, args: [] } }
  const race = await Promise.all([
    runtime.save(project, { config: raceConfig, overrides: [{ key: 'TOKEN', action: 'replace', value: 'cannot-encrypt' }] }),
    runtime.save(project, { config: raceConfig })
  ])
  assert.equal(race[0].code, 'E_DENIED')
  assert.equal(race[1].ok, true)
  assert((await runtime.list(project)).apps.some((app) => app.definition.id === 'creation-race'))
  delete process.env.APP_RUNTIME_TEST_ENCRYPTION
  assert(!readFileSync(join(api.runtimeDirectory(), files[0]), 'utf8').includes('never-store-plaintext'))
  console.log('PASS changed-config approval, stale-save rejection, malformed-env secret-free errors and encryption fail-closed')
} finally { if (otherRuntime) await otherRuntime.shutdown(); await fixture.close() }
console.log('app-runtime smoke passed')
