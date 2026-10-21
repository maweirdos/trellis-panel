/** Actual production desktop + real team HTTP/OIDC/Web through an offline restart. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, copyFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
const root = resolve('.'), fixture = mkdtempSync(join(tmpdir(), 'trellis-team-connected-'))
const index = process.argv.indexOf('--report-dir')
const evidence = index >= 0 ? resolve(process.argv[index + 1]) : resolve('.trellis/tasks/10-20-wf-team-web-foundation/review/connected-native')
mkdirSync(evidence, { recursive: true })
assert.equal(readdirSync(evidence).length, 0, 'Select a fresh evidence directory; preserve previous failures and passes')
const snapshot = join(fixture, 'application'); mkdirSync(snapshot)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = (directory, prefix) => readdirSync(directory, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name)).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name), `${prefix}/${entry.name}`) : [{ path: `${prefix}/${entry.name}`, sha256: hash(join(directory, entry.name)) }])
const buildManifest = () => [...files(join(root,'out'),'electron/out'),...files(join(root,'packages/team-service/dist'),'team-service/dist'),...files(join(root,'packages/team-web/dist'),'team-web/dist'),...files(join(root,'resources/brand'),'resources/brand')]
const before = buildManifest()
cpSync(join(root, 'out'), join(snapshot, 'out'), { recursive: true }); cpSync(join(root, 'resources/brand'), join(snapshot, 'resources/brand'), { recursive: true })
symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'junction')
const serviceSnapshot = join(snapshot, 'team-service'), webSnapshot = join(snapshot, 'team-web')
mkdirSync(serviceSnapshot)
cpSync(join(root, 'packages/team-service/dist'), join(serviceSnapshot, 'dist'), { recursive: true })
symlinkSync(join(root, 'packages/team-service/node_modules'), join(serviceSnapshot, 'node_modules'), 'junction')
cpSync(join(root, 'packages/team-web/dist'), webSnapshot, { recursive: true })
const frozen = [...files(join(snapshot,'out'),'electron/out'),...files(join(serviceSnapshot,'dist'),'team-service/dist'),...files(webSnapshot,'team-web/dist'),...files(join(snapshot,'resources/brand'),'resources/brand')]
assert.deepEqual(frozen,before,'Compiled output changed during snapshot copy')
assert.deepEqual(buildManifest(),before,'A concurrent build changed the live output during copy')
mkdirSync(join(serviceSnapshot,'test'));mkdirSync(join(snapshot,'harness'))
const harnessPaths=['scripts/smoke/team-collaboration-connected.mjs','scripts/smoke/fixtures/team-collaboration-connected-host.cjs','packages/team-service/test/oidc-fixture.mjs']
const harnessBefore=harnessPaths.map(path=>({path,sha256:hash(join(root,path))}))
copyFileSync(join(root,harnessPaths[0]),join(snapshot,'harness/runner.mjs'))
copyFileSync(join(root,harnessPaths[1]),join(snapshot,'harness/connected-host.cjs'))
copyFileSync(join(root,harnessPaths[2]),join(serviceSnapshot,'test/oidc-fixture.mjs'))
const frozenHarnessFiles=[join(snapshot,'harness/runner.mjs'),join(snapshot,'harness/connected-host.cjs'),join(serviceSnapshot,'test/oidc-fixture.mjs')]
assert.deepEqual(harnessBefore.map(row=>row.sha256),frozenHarnessFiles.map(hash))
assert.deepEqual(harnessBefore,harnessPaths.map(path=>({path,sha256:hash(join(root,path))})))
const reviews=[['review/desktop-ui-review-verification.json','ownedSourceHashes'],['review/selected-publication-alias-verification.json','files'],['review/server-review-verification.json','files'],['review/web-review-verification.json','files']]
const reviewedSourceAlignment=reviews.map(([name,key])=>{const manifest=JSON.parse(readFileSync(join(root,'.trellis/tasks/10-20-wf-team-web-foundation',name),'utf8'));const rows=manifest[key].filter(row=>/^(src\/|packages\/team-(?:service|web)\/src)/.test(row.path.replaceAll('\\','/'))).map(row=>({path:row.path,expected:row.sha256,current:hash(join(root,row.path))}));return{manifest:name,manifestSha256:hash(join(root,'.trellis/tasks/10-20-wf-team-web-foundation',name)),files:rows.map(row=>({...row,matches:row.expected===row.current}))}})
const source = { capturedAt: new Date().toISOString(), snapshotConsistency: 'Complete before/copy/after SHA-256 equality', builds: frozen, harness: harnessBefore, reviewedSourceAlignment, dependencyQualification: 'Already installed reviewed dependencies are readonly junctions; production build and executing native/OIDC harness bytes are copied, not rebuilt during the run', authenticationQualification:'Two synthetic OIDC subjects sign in through actual signed OIDC HTTP code flow; their authenticated test cookies are then injected into isolated Electron Web partitions, not typed through a human browser login' }
writeFileSync(join(evidence, 'connected-source-manifest.json'), JSON.stringify(source, null, 2))
// R2-02 may edit source while this old R2-01 dist remains intentionally frozen.
// Establish executed server/Web bytes from the independently reviewed artifacts,
// rather than asserting live source is still identical to an earlier task.
const reviewedBuildAlignment=['review/server-review-verification.json','review/web-review-verification.json'].flatMap(name=>{const value=JSON.parse(readFileSync(join(root,'.trellis/tasks/10-20-wf-team-web-foundation',name),'utf8'));return value.files.filter(row=>row.path.replaceAll('\\','/').includes('/dist/')).map(row=>{const path=row.path.replaceAll('\\','/').replace(/^packages\//,'');const actual=frozen.find(file=>file.path===path);return{manifest:name,path,expected:row.sha256,actual:actual?.sha256??null,matches:actual?.sha256===row.sha256}})})
source.reviewedBuildAlignment=reviewedBuildAlignment
source.sourceDriftQualification='Current source comparison is diagnostic only while R2-02 edits; executed service/Web bytes must exactly match independent R2-01 reviewed dist hashes. No R2-02 acceptance is implied.'
writeFileSync(join(evidence,'connected-source-manifest.json'),JSON.stringify(source,null,2))
assert.ok(reviewedBuildAlignment.length>=7&&reviewedBuildAlignment.every(row=>row.matches),'Service/Web dist changed from reviewed R2-01 artifacts; coordinate its owner before running')
const { createTeamService } = await import(pathToFileURL(join(serviceSnapshot, 'dist/index.mjs')).href)
const {BrowserAccount,createOidcFixture,freePort}=await import(pathToFileURL(join(serviceSnapshot,'test/oidc-fixture.mjs')).href)
const origin = `http://127.0.0.1:${await freePort()}`, identity = await createOidcFixture(origin)
const refusedProxy = createServer((socket) => socket.destroy())
await new Promise((done) => refusedProxy.listen(0, '127.0.0.1', done))
let server
try {
  server = await createTeamService({ dataDir: join(fixture, 'server'), publicOrigin: origin, webDir: webSnapshot, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true, onlineTtlMs: 1500, pairingTtlMs: 120000 })
  await server.app.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) })
  const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
  const aliceSession = await alice.signIn(), bobSession = await bob.signIn()
  assert.notEqual(aliceSession.person.userId,bobSession.person.userId)
  assert.deepEqual(identity.observations.logins,['alice','bob'])
  assert.ok(identity.observations.authorizationRequests.every(request=>request.challengeMethod==='S256'&&request.hasChallenge&&request.hasState&&request.hasNonce))
  const post = async (account, path, body) => { const reply = await account.api(path, body); assert.equal(reply.status, 200, 'Owned server setup request'); return reply.body.value.result }
  const team = await post(alice, '/api/teams', { commandId: randomUUID(), name: '实际桌面协作验收团队' })
  await post(alice, `/api/teams/${team.teamId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['member'], active: true, expectedRevision: null })
  const project = await post(alice, '/api/projects', { commandId: randomUUID(), teamId: team.teamId, name: '真实共享与离线重启项目' })
  await post(alice, `/api/projects/${project.projectId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['developer', 'tester'], active: true, expectedRevision: null })
  const cookies = (account) => [...(account.cookies.get('127.0.0.1') ?? [])].map(([name, value]) => ({ url: origin, name, value, httpOnly: true, sameSite: 'lax' }))
  const nonce = randomUUID(), title = `完整协作链路 ${nonce.slice(0, 8)}`
  const cfg = { fixture, snapshot, evidence, origin, projectId: project.projectId, aliceUserId: aliceSession.person.userId, bobUserId: bobSession.person.userId, cookies: { alice: cookies(alice), bob: cookies(bob) }, title,
    privateTitle: `离线个人草稿 ${nonce.slice(0, 8)}`, bodyA: `# 订单导出 A\n\n🙂 基线 A：普通员工不能导出手机号。\n\n来源 ${nonce}\n`, bodyB: `# 订单导出 B\n\n基线 B：保留权限规则，金额增加两位小数约束。\n\n来源 ${nonce}\n`, privateBody: `# 离线个人草稿\n\n只属于原设备账号的正文 ${nonce}\n`, quote: '不能导出手机号', productFeedback: `产品意见：金额保留两位小数 ${nonce.slice(0, 8)}`, developerFeedback: `开发离线记录：将在后续明确处理 ${nonce.slice(0, 8)}`, deadProxy: `http://127.0.0.1:${refusedProxy.address().port}` }
  const cfgPath = join(fixture, 'config.json'); writeFileSync(cfgPath, JSON.stringify(cfg))
  const env = { ...process.env, TRELLIS_TEAM_ALLOW_LOOPBACK_HTTP: '1' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.TPANEL_DEBUG_PORT
  const electron = createRequire(import.meta.url)('electron')
  const phases = process.argv.includes('--fixed-reader') ? ['one', 'two', 'reader'] : ['one', 'two']
  const exits=[]
  for (const phase of phases) {
    const result = await promisify(execFile)(electron, [join(snapshot,'harness/connected-host.cjs'), cfgPath, phase], { env, windowsHide: true, timeout: 160000, maxBuffer: 2 * 1024 * 1024 })
    process.stdout.write(result.stdout)
    writeFileSync(join(evidence, `phase-${phase}-host.log`), (result.stdout + '\n' + result.stderr).replace(/td_[A-Za-z0-9_-]{43}/g, '[owned-fixture-candidate]'))
    assert.ok(result.stdout.includes(`TEAM_CONNECTED_${phase.toUpperCase()}_PASSED`), 'Actual app must finish its owned quit protocol')
    const exit=JSON.parse(readFileSync(join(evidence,`phase-${phase}-exit.json`),'utf8'));assert.equal(exit.willQuit,true);assert.equal(exit.teamWorkersExited,true);exits.push({phase,exitCode:0,sentinelObserved:true,...exit})
  }
  const reports = phases.map((phase) => JSON.parse(readFileSync(join(evidence, `phase-${phase}.json`), 'utf8')))
  writeFileSync(join(evidence, 'connected-report.json'), JSON.stringify({ status: 'passed-observed-connected-subset', scope: 'Actual production desktop main/preload/renderer/SQLite/Windows protection, actual signed two-account OIDC/server/Web, native offline queue and process restart', phases: reports, oidcSubjects: identity.observations.logins, processExits:exits, source, qualifications: ['Synthetic owned accounts/project; not company SSO or customer Jira', source.authenticationQualification, 'Original UUIDs and absence of duplicate committed versions are checked; network attempt count is not an exactly-once claim', 'Native safeStorage and Worker constructors are pass-through observed, never replaced by fake encryption/persistence', 'Only isolated desktop proxy is disconnected; actual team server and separate Web browser remain online', 'Server heartbeat TTL1500ms is explicit test configuration, not production liveness performance', 'Original raw AI chat and local repositories are not published', 'Product feedback is recorded only, not claimed applied'], notRun: ['actual AI feedback adoption', 'company TLS/SSO deployment', 'packaged/human/mixed-display acceptance'], retainedFixture: fixture }, null, 2))
  console.log('PASS connected desktop/Web offline restart subset')
} catch (error) {
  writeFileSync(join(evidence, `connected-failure-${Date.now()}.json`), JSON.stringify({ message: error.message, stdout: error.stdout, stderr: error.stderr, fixture }, null, 2))
  if (error.stdout) process.stdout.write(error.stdout); if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  await server?.close(); await identity.close(); await new Promise((done) => refusedProxy.close(done))
  writeFileSync(join(evidence, 'retained-fixture.json'), JSON.stringify({ fixture, reason: 'Actual connected/native evidence retained; no recursive deletion' }, null, 2))
}
