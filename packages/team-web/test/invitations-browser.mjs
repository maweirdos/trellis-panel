import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createTeamService } from '../../team-service/dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from '../../team-service/test/oidc-fixture.mjs'
const require = createRequire(new URL('../../../package.json', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'trellis-invitation-browser-')), origin = `http://127.0.0.1:${await freePort()}`
const identity = await createOidcFixture(origin)
let service
try {
  service = await createTeamService({ dataDir: join(directory, 'store'), publicOrigin: origin, webDir: resolve('dist'), oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true })
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
  await alice.signIn(); const b = await bob.signIn()
  const team = await alice.api('/api/teams', { commandId: randomUUID(), name: '邀请协作团队' }); assert.equal(team.status, 200)
  const project = await alice.api('/api/projects', { commandId: randomUUID(), teamId: team.body.value.result.teamId, name: '邀请验收项目' }); assert.equal(project.status, 200)
  const cookies = (account) => [...account.cookies.get('127.0.0.1')].map(([name, value]) => ({ url: origin, name, value, httpOnly: true, sameSite: 'lax' }))
  writeFileSync(join(directory, 'bootstrap.json'), JSON.stringify({ directory, origin, projectId: project.body.value.result.projectId, bobId: b.person.userId, aliceCookies: cookies(alice), bobCookies: cookies(bob) }))
  const output = await promisify(execFile)(require('electron'), [resolve('test/invitations-browser-host.cjs'), join(directory, 'bootstrap.json')], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 })
  process.stdout.write(output.stdout)
  assert.equal((await bob.api('/api/projects')).body.value.items[0].projectId, project.body.value.result.projectId)
} finally {
  await service?.close(); await identity.close()
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-invitation-browser-')); rmSync(directory, { recursive: true, force: true })
}
