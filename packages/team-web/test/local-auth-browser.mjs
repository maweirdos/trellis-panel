import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createTeamService } from '../../team-service/dist/index.mjs'
import { freePort } from '../../team-service/test/oidc-fixture.mjs'
const require = createRequire(new URL('../../../package.json', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'trellis-local-auth-browser-')), origin = `http://127.0.0.1:${await freePort()}`
let service
try {
  service = await createTeamService({ dataDir: join(directory, 'store'), publicOrigin: origin, webDir: resolve('dist') })
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  const setup = await fetch(origin + '/api/device-pairings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: 'First account pending desktop', capabilityClaims: [] }) }).then((response) => response.json())
  assert.equal(setup.ok, true)
  writeFileSync(join(directory, 'bootstrap.json'), JSON.stringify({ directory, origin, pairing: { pairingId: setup.value.pairingId, userCode: setup.value.userCode } }))
  const output = await promisify(execFile)(require('electron'), [resolve('test/local-auth-browser-host.cjs'), join(directory, 'bootstrap.json')], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 })
  process.stdout.write(output.stdout)
} finally { await service?.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-local-auth-browser-')); rmSync(directory, { recursive: true, force: true }) }
