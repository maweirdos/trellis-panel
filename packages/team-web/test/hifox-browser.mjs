import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createTeamService } from '../../team-service/dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from '../../team-service/test/oidc-fixture.mjs'

const require = createRequire(new URL('../../../package.json', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'trellis-hifox-web-ui-'))
const evidence = resolve(process.env.HIFOX_WEB_TEST_EVIDENCE ?? '../../.shots/hifox-web')
mkdirSync(evidence, { recursive: true })
const origin = `http://127.0.0.1:${await freePort()}`, identity = await createOidcFixture(origin)
let service
try {
  service = await createTeamService({ dataDir: join(directory, 'store'), publicOrigin: origin, webDir: resolve('dist'), oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true })
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
  const aliceSession = await alice.signIn(), bobSession = await bob.signIn()
  const api = async (path, body) => { const reply = await alice.api(path, body); assert.equal(reply.status, 200, JSON.stringify(reply.body)); return reply.body.value }
  const team = await api('/api/teams', { commandId: randomUUID(), name: '浏览器协作团队' })
  await api(`/api/teams/${team.result.teamId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['member'], active: true, expectedRevision: null })
  const project = await api('/api/projects', { commandId: randomUUID(), teamId: team.result.teamId, name: '真实共享项目 A' })
  const other = await api('/api/projects', { commandId: randomUUID(), teamId: team.result.teamId, name: '独立项目 B' })
  const projectId = project.result.projectId
  await api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['developer'], active: true, expectedRevision: null })
  const command = async (operation, input) => {
    const snapshot = await api(`/api/projects/${projectId}/hifox/snapshot`)
    return api(`/api/projects/${projectId}/hifox/commands`, { commandId: randomUUID(), expectedEpoch: snapshot.epoch, expectedRevision: snapshot.revision, operation, input })
  }
  const space = await command('createSpace', { name: '交付空间', key: 'SHIP' }), spaceId = space.result.snapshot.spaces[0].id
  await command('setSpaceMembers', { spaceId, memberIds: [aliceSession.person.userId, bobSession.person.userId] })
  const agent = await command('saveAgent', { spaceId, name: '审阅 Agent', instructions: '只配置职责，等待 Runtime。' })
  await command('saveCrew', { spaceId, name: '交付小队', captainAgentId: agent.result.snapshot.agents[0].id, memberRefs: [{ kind: 'agent', id: agent.result.snapshot.agents[0].id }], exclusiveAgentIds: [] })
  await command('createIteration', { spaceId, name: '网页版版本', startDate: '2026-10-24', endDate: '2026-10-31' })
  const head = await api(`/api/projects/${projectId}/hifox/snapshot`)
  const workspaceHead = { instanceId: head.instanceId, epoch: head.epoch, authorizationRevision: head.authorizationRevision }
  assert.match(workspaceHead.instanceId, /^[0-9a-f-]{36}$/); assert.match(workspaceHead.epoch, /^[0-9a-f-]{36}$/); assert.equal(typeof workspaceHead.authorizationRevision, 'number')
  const cookies = (account) => [...account.cookies.get('127.0.0.1')].map(([name, value]) => ({ url: origin, name, value, httpOnly: true, sameSite: 'lax' }))
  writeFileSync(join(directory, 'bootstrap.json'), JSON.stringify({ directory, evidence, origin, projectId, workspaceHead, otherProjectId: other.result.projectId, aliceCookies: cookies(alice), bobCookies: cookies(bob) }))
  const output = await promisify(execFile)(require('electron'), [resolve('test/hifox-browser-host.cjs'), join(directory, 'bootstrap.json')], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 })
  process.stdout.write(output.stdout); if (output.stderr) process.stderr.write(output.stderr)
  const final = await api(`/api/projects/${projectId}/hifox/snapshot`)
  assert.equal(final.snapshot.tasks.filter((task) => task.title === '双账号真实任务').length, 1)
} catch (error) {
  writeFileSync(join(evidence, 'failure.json'), JSON.stringify({ message: error.message, stdout: error.stdout, stderr: error.stderr }, null, 2)); throw error
} finally {
  await service?.close(); await identity.close()
  const target = resolve(directory)
  if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('trellis-hifox-web-ui-')) rmSync(target, { recursive: true, force: true })
}
