import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { buildTeamPackages, repositoryRoot } from '../team-local.mjs'

const args = process.argv.slice(2)
if (args.some((arg) => !['--no-build', '--http-only', '--help'].includes(arg))) throw Error('Use --no-build and/or --http-only, or --help.')
if (args.includes('--help')) {
  console.log('Usage: node scripts/smoke/hifox-connected.mjs [--no-build] [--http-only]\nRuns isolated real HTTP/SQLite local-account collaboration and, by default, two hidden Chromium clients.\nHIFOX_CONNECTED_EVIDENCE overrides the .shots/hifox-connected evidence directory. No persistent user service is started.')
  process.exit(0)
}
await buildTeamPackages({ reuse: args.includes('--no-build') })
const directory = await mkdtemp(join(tmpdir(), 'trellis-hifox-connected-'))
const evidence = resolve(process.env.HIFOX_CONNECTED_EVIDENCE ?? join(repositoryRoot, '.shots/hifox-connected'))
await mkdir(evidence, { recursive: true })
const checks = []
const check = async (name, action) => { await action(); checks.push(name); console.log('PASS ' + name) }
const password = randomBytes(24).toString('base64url') + '!'

async function hashes(root, prefix = '') {
  const result = {}
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) Object.assign(result, await hashes(root, name))
    else if (entry.isFile()) result[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex')
    else throw Error('Build output must contain regular files/directories only.')
  }
  return result
}

async function frozenBuild() {
  const result = {}
  for (const name of ['team-service', 'team-web']) {
    const source = join(repositoryRoot, 'packages', name, 'dist'), target = join(directory, 'build', name, 'dist')
    const before = await hashes(source)
    await cp(source, target, { recursive: true })
    assert.deepEqual(await hashes(source), before, name + ' build changed during snapshot; freeze builds before running connected proof')
    assert.deepEqual(await hashes(target), before, name + ' frozen build does not match its source')
    result[name] = before
  }
  await symlink(join(repositoryRoot, 'packages/team-service/node_modules'), join(directory, 'build/team-service/node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  return result
}

async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()))
  return address.port
}

// Cookie jars are deliberately per service and per account; no fixture principal or store writes.
class BrowserAccount {
  cookies = new Map()
  csrf = ''
  constructor(origin) { this.origin = origin }
  async api(path, body, extraHeaders = {}) {
    assert.ok(path.startsWith('/') && !path.startsWith('//'), 'Only service-relative requests are accepted')
    const headers = { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: this.origin, 'X-CSRF-Token': this.csrf }), ...extraHeaders }
    const response = await fetch(this.origin + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(12_000) })
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';'), split = pair.indexOf('=')
      const key = pair.slice(0, split), value = pair.slice(split + 1)
      if (!value || /max-age=0(?:;|$)/i.test(header)) this.cookies.delete(key)
      else this.cookies.set(key, value)
    }
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  async local(operation, username, displayName) {
    const options = await this.ok('/api/auth/options')
    assert.equal(options.oidcLogin, false); assert.equal(options.localLogin, true)
    const reply = await this.ok('/auth/local/' + operation, { username, password, ...(operation === 'register' ? { displayName } : {}) }, { 'X-CSRF-Token': options.csrfToken })
    this.csrf = reply.session.csrfToken
    return reply.session
  }
  async ok(path, body, headers) {
    const reply = await this.api(path, body, headers)
    assert.equal(reply.status, 200, `${path}: ${reply.body.code ?? ''} ${reply.body.error ?? ''}`)
    assert.equal(reply.body.ok, true)
    return reply.body.value
  }
}

let service, otherService
let projectId, teamId, aliceId, bobId, taskId, spaceId, replay, bobCommentCommandId
const origin = `http://127.0.0.1:${await freePort()}`
const config = { dataDir: join(directory, 'service'), publicOrigin: origin, webDir: join(directory, 'build/team-web/dist') }
const alice = new BrowserAccount(origin), bob = new BrowserAccount(origin)
const path = (suffix) => `/api/projects/${projectId}/hifox/${suffix}`
const snapshot = (account = alice) => account.ok(path('snapshot'))
const command = async (account, operation, input) => { const head = await snapshot(account); return account.ok(path('commands'), { commandId: randomUUID(), expectedEpoch: head.epoch, expectedRevision: head.revision, operation, input }) }
let createTeamService
const start = async () => {
  service = await createTeamService(config)
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
}
try {
  const buildHashes = await frozenBuild()
  ;({ createTeamService } = await import(pathToFileURL(join(directory, 'build/team-service/dist/index.mjs')).href))
  await start()
  await check('independent local registration/login, no OIDC, no seeded/admin identities', async () => {
    assert.equal((await alice.ok('/api/auth/options')).selfRegistration, true)
    const a = await alice.local('register', 'connected-alice', 'Alice 联通账号')
    const b = await bob.local('register', 'connected-bob', 'Bob 联通账号')
    aliceId = a.person.userId; bobId = b.person.userId
    assert.notEqual(aliceId, bobId); assert.equal(a.person.isPlatformAdmin, false); assert.equal(b.person.isPlatformAdmin, false)
    assert.equal(a.person.provider, 'local'); assert.equal(b.person.provider, 'local')
    const old = bob.cookies.get('tp_team_session')
    assert.equal((await bob.local('login', 'CONNECTED-BOB')).person.userId, bobId)
    assert.notEqual(bob.cookies.get('tp_team_session'), old)
    assert.equal((await bob.ok('/api/projects')).items.length, 0)
  })

  await check('actual team/project creation, named invitation inspection/acceptance and current ACL', async () => {
    teamId = (await alice.ok('/api/teams', { commandId: randomUUID(), name: '本机联通团队' })).result.teamId
    projectId = (await alice.ok('/api/projects', { commandId: randomUUID(), teamId, name: '本机真实共享项目' })).result.projectId
    assert.equal((await bob.api(path('snapshot'))).status, 403)
    const token = 'ti_' + randomBytes(32).toString('base64url')
    const invitation = (await alice.ok('/api/invitations', { commandId: randomUUID(), teamId, projectId, teamRoles: ['member'], projectRoles: ['developer', 'tester'], recipient: { kind: 'local', username: 'connected-bob' }, token })).result
    const invitePath = `/api/invitations/${invitation.invitationId}`
    assert.equal((await alice.api(invitePath + '/inspect', { token })).status, 403)
    assert.equal((await bob.ok(invitePath + '/inspect', { token })).status, 'pending')
    const input = { commandId: randomUUID(), token, expectedUserId: bobId, expectedTeamId: teamId, expectedProjectId: projectId }
    assert.equal((await bob.api(invitePath + '/accept', { ...input, expectedUserId: aliceId })).status, 403)
    assert.equal((await bob.ok(invitePath + '/accept', input)).status, 'committed')
    assert.equal((await bob.ok(invitePath + '/accept', input)).status, 'duplicate')
    assert.deepEqual((await bob.ok('/api/projects')).items[0].roles, ['developer', 'tester'])
    const initial = await snapshot(bob)
    assert.equal(initial.actor.id, bobId); assert.equal(initial.canManage, false)
    assert.deepEqual(new Set(initial.snapshot.members.map((member) => member.id)), new Set([aliceId, bobId]))
    assert.deepEqual(initial.snapshot.tasks, []); assert.deepEqual(initial.snapshot.spaces, []); assert.deepEqual(initial.snapshot.agents, [])
    assert.equal((await bob.api(path('commands'), { commandId: randomUUID(), expectedEpoch: initial.epoch, expectedRevision: initial.revision, operation: 'createSpace', input: { name: 'Forbidden', key: 'BAD' } })).status, 403)
    const created = await command(alice, 'createSpace', { name: '真实协作空间', key: 'LIVE' })
    spaceId = created.result.snapshot.spaces[0].id
    await command(alice, 'setSpaceMembers', { spaceId, memberIds: [aliceId, bobId] })
  })

  await check('two-client CAS, command replay, real task create/update/comment and server author identity', async () => {
    const head = await snapshot(), revision = head.revision
    const inputs = ['并发任务 A', '并发任务 B'].map((title) => ({ commandId: randomUUID(), expectedEpoch: head.epoch, expectedRevision: revision, operation: 'createTask', input: { spaceId, title, assigneeIds: [bobId], triagePending: false } }))
    const replies = await Promise.all([alice.api(path('commands'), inputs[0]), bob.api(path('commands'), inputs[1])])
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409])
    const winner = replies.findIndex((reply) => reply.status === 200), account = winner ? bob : alice
    replay = { account: winner ? 'bob' : 'alice', body: inputs[winner] }
    taskId = replies[winner].body.value.result.taskId
    assert.equal((await account.ok(path('commands'), replay.body)).status, 'duplicate')
    assert.equal((await account.api(path('commands'), { ...replay.body, input: { ...replay.body.input, title: 'changed intent' } })).status, 409)
    await command(bob, 'updateTask', { id: taskId, patch: { title: '跨账号共享任务', description: '真实 HTTP 与 SQLite 保存的协作内容。' } })
    bobCommentCommandId = (await command(bob, 'addComment', { taskId, body: 'Bob 的真实服务评论', authorId: aliceId })).commandId
    const current = await snapshot(alice)
    assert.equal(current.snapshot.tasks.find((task) => task.id === taskId).title, '跨账号共享任务')
    assert.equal(current.snapshot.comments.find((comment) => comment.taskId === taskId).authorId, bobId)
    const invalid = await bob.api(path('commands'), { commandId: randomUUID(), expectedEpoch: current.epoch, expectedRevision: current.revision, operation: 'updateTask', input: { id: taskId, patch: { statusId: 'foreign-status', title: 'Invalid' } } })
    assert.equal(invalid.status, 400); assert.equal((await snapshot()).revision, current.revision)
  })

  await check('version, Agent and squad persist and synchronize with no Runtime execution claim', async () => {
    await command(bob, 'createIteration', { spaceId, name: '联通验收版本', startDate: '2026-10-24', endDate: '2026-10-31', taskIds: [taskId] })
    const saved = await command(alice, 'saveAgent', { spaceId, name: '联通审阅 Agent', instructions: '配置职责；等待真实 Runtime。' })
    const agent = saved.result.snapshot.agents[0]
    const crew = await command(alice, 'saveCrew', { spaceId, name: '联通交付小队', captainAgentId: agent.id, memberRefs: [{ kind: 'agent', id: agent.id }, { kind: 'member', id: bobId }], exclusiveAgentIds: [] })
    const squad = crew.result.snapshot.crews[0]
    await command(bob, 'updateTask', { id: taskId, patch: { executor: { kind: 'crew', id: squad.id, name: squad.name } } })
    const [a, b] = await Promise.all([snapshot(alice), snapshot(bob)])
    for (const key of ['tasks', 'comments', 'iterations', 'agents', 'crews']) assert.deepEqual(a.snapshot[key], b.snapshot[key], key)
    const task = a.snapshot.tasks.find((item) => item.id === taskId), version = a.snapshot.iterations[0]
    assert.deepEqual(task.iterationIds, [version.id]); assert.deepEqual(version.taskIds, [taskId])
    assert.ok(['queued', 'waiting_runtime'].includes(task.dispatch?.status))
    assert.equal(task.executor.id, squad.id)
  })

  await check('actual long polling sees the other account commit; Origin and CSRF are exact', async () => {
    const before = await snapshot(bob)
    const waiting = bob.api(path(`snapshot?afterRevision=${before.revision}&waitMs=2000`))
    await delay(80)
    await command(alice, 'updateTask', { id: taskId, patch: { priority: 'high' } })
    const changedAt = Date.now(), response = await waiting
    assert.equal(response.status, 200); assert.ok(response.body.value.revision > before.revision)
    assert.equal(response.body.value.snapshot.tasks.find((task) => task.id === taskId).priority, 'high')
    assert.ok(Date.now() - changedAt < 1000)
    assert.equal((await alice.api(path('snapshot'), undefined, { Origin: 'https://foreign.invalid' })).status, 403)
    const body = { commandId: randomUUID(), expectedEpoch: response.body.value.epoch, expectedRevision: response.body.value.revision, operation: 'addComment', input: { taskId, body: 'rejected' } }
    assert.equal((await alice.api(path('commands'), body, { Origin: 'https://foreign.invalid' })).status, 403)
    assert.equal((await alice.api(path('commands'), body, { 'X-CSRF-Token': bob.csrf })).status, 403)
  })

  await check('service-origin and account isolation rejects copied sessions and unrelated project reads', async () => {
    const privateProject = (await alice.ok('/api/projects', { commandId: randomUUID(), teamId, name: '未邀请的私有项目' })).result.projectId
    assert.equal((await bob.api(`/api/projects/${privateProject}/hifox/snapshot`)).status, 403)
    const otherOrigin = `http://127.0.0.1:${await freePort()}`
    otherService = await createTeamService({ dataDir: join(directory, 'other-service'), publicOrigin: otherOrigin })
    await otherService.app.listen({ port: Number(new URL(otherOrigin).port), host: '127.0.0.1' })
    const other = new BrowserAccount(otherOrigin)
    other.cookies = new Map(alice.cookies)
    assert.equal((await other.api('/api/session')).status, 401)
    other.cookies.clear()
    const sameName = await other.local('register', 'connected-alice', '另一服务的 Alice')
    assert.notEqual(sameName.person.userId, aliceId)
    assert.ok([403, 404].includes((await other.api(path('snapshot'))).status))
    await otherService.close(); otherService = undefined
  })

  if (!args.includes('--http-only')) await check('built Web UI: two isolated hidden Chromium logins, task/comment synchronization and screenshots', async () => {
    const require = createRequire(join(repositoryRoot, 'package.json'))
    const bootstrap = join(directory, 'browser.json')
    await writeFile(bootstrap, JSON.stringify({ directory, evidence, origin, projectId, taskId, password, aliceId, bobId }), { mode: 0o600 })
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const output = await promisify(execFile)(require('electron'), [join(repositoryRoot, 'scripts/smoke/fixtures/hifox-connected-host.cjs'), bootstrap], { windowsHide: true, env, timeout: 90_000, maxBuffer: 1024 * 1024 })
    process.stdout.write(output.stdout)
    const final = await snapshot()
    assert.equal(final.snapshot.tasks.filter((task) => task.title === '浏览器创建的共享任务').length, 1)
    assert.equal(final.snapshot.comments.find((comment) => comment.body === '来自 Bob 浏览器的评论').authorId, bobId)
  })

  await check('actual SQLite restart preserves accounts, memberships, task graph and immutable receipt', async () => {
    const before = await snapshot(bob)
    await service.close(); service = undefined
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(join(config.dataDir, 'team.sqlite'), { readOnly: true })
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS total FROM local_credentials').get().total, 2)
      assert.equal(database.prepare('SELECT COUNT(*) AS total FROM people WHERE isPlatformAdmin<>0').get().total, 0)
      assert.ok(database.prepare('PRAGMA user_version').get().user_version >= 7)
      const stored = database.prepare('SELECT snapshotJson FROM hifox_workspaces WHERE projectId=?').get(projectId)
      assert.ok(JSON.parse(stored.snapshotJson).tasks.some((task) => task.id === taskId))
    } finally { database.close() }
    assert.equal((await readFile(join(config.dataDir, 'team.sqlite'))).includes(Buffer.from(password)), false)
    await start()
    const after = await snapshot(bob)
    assert.equal(after.revision, before.revision)
    for (const key of ['tasks', 'comments', 'iterations', 'agents', 'crews']) assert.deepEqual(after.snapshot[key], before.snapshot[key])
    const account = replay.account === 'bob' ? bob : alice
    assert.equal((await account.ok(path('commands'), replay.body)).status, 'duplicate')
    assert.equal((await bob.local('login', 'connected-bob')).person.userId, bobId)
  })

  await check('project revocation interrupts a live wait and rejects old command replay/receipt', async () => {
    const waiting = bob.api(path(`snapshot?afterRevision=${(await snapshot(bob)).revision}&waitMs=2000`))
    await delay(80)
    await alice.ok(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['developer', 'tester'], active: false, expectedRevision: 1 })
    assert.equal((await waiting).status, 403)
    assert.equal((await bob.api(path('snapshot'))).status, 403)
    assert.equal((await bob.api(path('commands'), replay.body)).status, 403)
    assert.equal((await bob.api(`/api/commands/${bobCommentCommandId}`)).status, 403)
    assert.equal((await snapshot()).snapshot.members.some((member) => member.id === bobId), false)
  })
  const report = { checks, buildHashes, browser: !args.includes('--http-only'), boundaries: 'Two accounts and optional two Chromium partitions on one physical host; actual local HTTP/SQLite and built Web. No company GitLab, separate-computer, LAN, installed desktop or Runtime execution acceptance.' }
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`PASS HiFox connected smoke (${checks.length} checks). Evidence: ${evidence}`)
  console.log(report.boundaries)
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ checks, error: error.message, stdout: error.stdout, stderr: error.stderr }, null, 2))
  throw error
} finally {
  try { await otherService?.close() } finally {
    try { await service?.close() } finally {
      const target = await realpath(directory)
      assert.equal(dirname(target), await realpath(tmpdir())); assert.ok(basename(target).startsWith('trellis-hifox-connected-'))
      await rm(target, { recursive: true, force: true })
    }
  }
}
