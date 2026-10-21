/** Actual built Web, service SQLite/HTTP/OIDC and two Chromium cookie partitions. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createTeamService } from '../../team-service/dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from '../../team-service/test/oidc-fixture.mjs'
const require = createRequire(new URL('../../../package.json', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'trellis-team-web-browser-'))
const evidence = resolve(process.env.TEAM_WEB_TEST_EVIDENCE ?? '../../.trellis/tasks/10-20-wf-team-web-foundation/research/web-browser')
mkdirSync(evidence, { recursive: true })
const origin = `http://127.0.0.1:${await freePort()}`
const identity = await createOidcFixture(origin)
let service
try {
  service = await createTeamService({ dataDir: join(directory, 'store'), publicOrigin: origin, webDir: resolve('dist'), oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true })
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
  const aliceSession = await alice.signIn(), bobSession = await bob.signIn()
  const api = async (account, path, body) => { const reply = await account.api(path, body); assert.equal(reply.status, 200, JSON.stringify(reply.body)); return reply.body.value }
  const team = await api(alice, '/api/teams', { commandId: randomUUID(), name: '产品交付团队' })
  await api(alice, `/api/teams/${team.result.teamId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['member'], active: true, expectedRevision: null })
  const project = await api(alice, '/api/projects', { commandId: randomUUID(), teamId: team.result.teamId, name: '订单协作项目' })
  const other = await api(alice, '/api/projects', { commandId: randomUUID(), teamId: team.result.teamId, name: '独立项目 B' })
  const projectId = project.result.projectId, otherProjectId = other.result.projectId
  for (const id of [projectId, otherProjectId]) await api(alice, `/api/projects/${id}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['developer', 'tester'], active: true, expectedRevision: null })
  const materialId = randomUUID(), privateId = randomUUID()
  const bodyA = '# 订单导出需求\n\n## 使用场景\n\n🙂 普通员工只导出授权范围内的订单。\n\n## 数据字段\n\n| 字段 | 要求 |\n| --- | --- |\n| 订单号 | 必填 |\n| 金额 | 两位小数 |\n\n**不包含手机号。**\n\n![本地原型](C:/private/prototype.png)\n\n<script>window.untrustedExecuted=true</script>\n'
  const publication = (id, title, text, visibility = 'project', expectedVersion = null) => ({ commandId: randomUUID(), materialId: id, projectId, title, kind: 'product-requirement', visibility, text, expectedVersion, source: { kind: 'authored', sourceId: randomUUID(), version: 'test-version-' + (expectedVersion ?? 0) } })
  await api(alice, '/api/materials', publication(materialId, '订单导出 · 需求说明', bodyA))
  await api(alice, '/api/materials', publication(privateId, 'Alice 私人草稿', 'ONLY_ALICE_PRIVATE_BODY', 'personal'))
  for (let index = 0; index < 51; index++) await api(alice, '/api/materials', publication(randomUUID(), `历史资料 ${String(index).padStart(2, '0')}`, '# 已发布的补充资料\n'))
  const pairingResponse = await fetch(origin + '/api/device-pairings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: '研发桌面 · 配对验证', capabilityClaims: ['workflow.read'] }) })
  const pairing = (await pairingResponse.json()).value
  const cookies = (account) => [...account.cookies.get('127.0.0.1')].map(([name, value]) => ({ url: origin, name, value, httpOnly: true, sameSite: 'lax' }))
  const bootstrap = { directory, evidence, origin, issuer: identity.issuer, alice: { cookies: cookies(alice), csrf: alice.csrf }, bob: { cookies: cookies(bob), csrf: bob.csrf }, projectId, otherProjectId, materialId, privateId, bodyA, pairing, aliceUserId: aliceSession.person.userId, bobUserId: bobSession.person.userId }
  writeFileSync(join(directory, 'bootstrap.json'), JSON.stringify(bootstrap))
  const output = await promisify(execFile)(require('electron'), [resolve('test/browser-host.cjs'), join(directory, 'bootstrap.json')], { windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 })
  process.stdout.write(output.stdout); if (output.stderr) process.stderr.write(output.stderr)
  const report = JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'))
  report.oidc = { subjects: identity.observations.logins, authorizationRequests: identity.observations.authorizationRequests }
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  assert.equal(report.status, 'passed')
} catch (error) { writeFileSync(join(evidence, 'failure.json'), JSON.stringify({ message: error.message, stdout: error.stdout, stderr: error.stderr }, null, 2)); throw error }
finally {
  await service?.close(); await identity.close()
  const target = resolve(directory), parent = resolve(tmpdir())
  if (dirname(target) === parent && basename(target).startsWith('trellis-team-web-browser-')) rmSync(target, { recursive: true, force: true })
}
