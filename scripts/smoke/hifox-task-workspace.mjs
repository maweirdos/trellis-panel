/** Isolated native preparation regression. All CLI projects, pointers and bindings live under tmpdir. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-hifox-task-workspace-')))
const host = globalThis.__HIFOX_WORK_SMOKE__ = { dataDir: join(root, 'host'), handlers: new Map(), dialog: null }
let m, serial = 0, passed = 0
const check = async (name, action) => { await action(); console.log('PASS ' + name); passed++ }
const gate = () => { let enter, release; const entered = new Promise((done) => { enter = done }), wait = new Promise((done) => { release = done }); return { enter, entered, wait, release } }
const clone = (value) => structuredClone(value)
const read = (path) => readFileSync(path, 'utf8')
const fixturePath = (path) => {
  const absolute = resolve(path), rel = relative(root, absolute)
  assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'fixture operation escaped its temporary root')
  return absolute
}
const removeFixture = (path, options) => rmSync(fixturePath(path), options)
const moveFixture = (from, to) => renameSync(fixturePath(from), fixturePath(to))
const logs = (project) => existsSync(join(project, 'cli.jsonl')) ? read(join(project, 'cli.jsonl')).trim().split('\n').map((line) => JSON.parse(line)) : []
const listTasks = (project) => readdirSync(join(project, '.trellis', 'tasks')).filter((name) => name !== 'archive')

function project(directory) {
  mkdirSync(join(directory, '.trellis', 'tasks'), { recursive: true })
  mkdirSync(join(directory, '.trellis', 'scripts'), { recursive: true })
  writeFileSync(join(directory, '.trellis', 'workflow.md'), '# Isolated fixture workflow\n')
  writeFileSync(join(directory, '.trellis', '.current-task'), 'fixture-existing-task\n')
  // Node interprets the fixture task.py. The production runner still owns argv, no-start and process handling.
  writeFileSync(join(directory, '.trellis', 'scripts', 'task.py'), `
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const argv = process.argv.slice(2), root = process.cwd();
assert.equal(argv[0], 'create'); assert.ok(argv.includes('--no-start')); assert.ok(!argv.includes('--force')); assert.ok(!argv.includes('start'));
const opt = name => argv[argv.indexOf(name) + 1];
const meta = Object.fromEntries(argv.flatMap((arg, i) => arg === '--meta' ? [[argv[i+1].slice(0,argv[i+1].indexOf('=')),argv[i+1].slice(argv[i+1].indexOf('=')+1)]] : []));
fs.appendFileSync(path.join(root, 'cli.jsonl'), JSON.stringify({argv,meta}) + '\\n');
const mode = fs.existsSync(path.join(root,'mode')) ? fs.readFileSync(path.join(root,'mode'),'utf8').trim() : 'normal';
if (mode === 'fail') process.exit(2);
const now = new Date(), prefix = String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
const dirName = prefix+'-'+opt('--slug'), dir = path.join(root,'.trellis','tasks',dirName);
if (fs.existsSync(dir)) process.exit(3);
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir,'task.json'), mode === 'bad-json' ? '{"id":' : JSON.stringify({id:'local-'+opt('--slug'),title:argv[1],status:'planning',meta}));
if (mode === 'partial-fail' || mode === 'bad-json') process.exit(2);
const defaultPrd = ${m.expectedDefaultPrd.toString()};
fs.writeFileSync(path.join(dir,'prd.md'), mode === 'edited-prd' ? '# Developer edited during CLI\\n' : defaultPrd(argv[1],opt('--description')));
console.error('Created task: '+dirName);
`)
  return directory
}

function fixture() {
  const dir = join(root, 'case-' + ++serial), dataDir = join(dir, 'user-data'), code = project(join(dir, 'project'))
  mkdirSync(dataDir, { recursive: true })
  const actor = { id: 'actor-a', name: 'Developer A', role: 'member', avatarHue: 0, joinedAt: new Date().toISOString() }
  const snapshot = m.buildSeedSnapshot()
  snapshot.members = [actor]
  snapshot.spaces = [{ id: 'space-a', key: 'ENG', name: 'Original space', memberIds: [actor.id], multiAssignee: true, taskSeq: 1, createdAt: actor.joinedAt }]
  snapshot.tasks = [{ id: 'ENG-ORIGINAL', spaceId: 'space-a', title: 'Prepare original requirement', description: 'Keep the complete requirement.\n\n验收：原文保留。\n\n设计：现有本地创建器。',
    workKind: 'code', acceptanceCriteria: ['Repeated prepare reuses the task'],
    workflow: { stage: 'dev_ready', handlerId: actor.id, artifacts: [
      { id: 'requirements-1', kind: 'requirements', body: 'Keep task identity', actorId: actor.id, at: actor.joinedAt },
      { id: 'design-1', kind: 'design', body: 'Reuse the native local-task runner.', actorId: actor.id, at: actor.joinedAt }
    ], history: [] },
    priority: 'high', statusId: 'todo', assigneeIds: [actor.id], creatorId: actor.id, labelIds: [], iterationIds: [], followerIds: [], relations: [], createdAt: actor.joinedAt, updatedAt: actor.joinedAt }]
  const context = { key: 'workspace-original', connectionId: randomUUID(), projectId: randomUUID(), actorId: actor.id, projectName: 'Original project', canManage: false, state: 'connected', revision: 1, pendingCount: 0, origin: 'https://owned.fixture.invalid', instanceId: randomUUID(), epoch: randomUUID() }
  const f = { dir, dataDir, code, current: code, generation: 1, snapshot, context, statusHook: null, snapshotHook: null, chooser: null, cli: null, chooseCount: 0 }
  f.query = { workspaceKey: context.key, taskId: snapshot.tasks[0].id }
  f.runCli = (options, input) => m.runTaskCreateCli({ ...options, pythonCommand: process.execPath }, input)
  f.deps = {
    dataDir, getProjectRoot: () => f.current, getProjectGeneration: () => f.generation,
    chooseProjectRoot: async () => { f.chooseCount++; return f.chooser ? f.chooser() : null },
    workspaceStatus: async () => { if (f.statusHook) await f.statusHook(); return clone(f.context) },
    workspaceSnapshot: async () => { if (f.snapshotHook) await f.snapshotHook(); return { context: clone(f.context), snapshot: clone(f.snapshot) } },
    cliRunner: (options, input) => f.cli ? f.cli(options, input) : f.runCli(options, input)
  }
  f.open = () => new m.HifoxTaskWorkspaceService(f.deps)
  f.service = f.open()
  f.prepare = (extra = {}) => f.service.prepare({ ...f.query, ...extra })
  f.status = () => f.service.status(f.query)
  f.bindings = () => readdirSync(join(dataDir, 'hifox-work', 'bindings')).map((name) => join(dataDir, 'hifox-work', 'bindings', name))
  f.prd = (result) => join(result.local.projectRoot, result.local.relativeDir, 'prd.md')
  return f
}

try {
  const bundled = await build({
    stdin: { contents: "export * from './src/main/services/hifox/task-workspace';export {registerHifoxWorkIpc} from './src/main/ipc/hifox-work';export {runTaskCreateCli} from './src/main/services/local-task/cli-runner';export {expectedDefaultPrd} from './src/main/services/local-task/operations';export {buildSeedSnapshot} from './src/shared/hifox-domain/seed';export {ipcInvoke} from './src/shared/ipc-channels'", resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(root, 'service.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', metafile: true,
    plugins: [{ name: 'owned-native-boundary', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'owned-native' }))
      builder.onLoad({ filter: /.*/, namespace: 'owned-native' }, () => ({ contents: `const host=globalThis.__HIFOX_WORK_SMOKE__;export const app={getPath:()=>host.dataDir};export const dialog={showOpenDialog:async()=>host.dialog};export const ipcMain={handle:(name,fn)=>host.handlers.set(name,fn),on(){}};export const safeStorage={isEncryptionAvailable:()=>false};`, loader: 'js' }))
    } }]
  })
  assert.equal(Object.keys(bundled.metafile.inputs).some((path) => /services[\\/](?:acp(?:[\\/.])|native-runtime|workflow-runtime|team-desktop)/.test(path)), false, 'local preparation pulled an execution runtime into its bundle')
  m = await import(pathToFileURL(join(root, 'service.mjs')).href)

  await check('real CLI runner uses --no-start; source materials and original pointer survive preparation', async () => {
    const f = fixture(), before = read(join(f.code, '.trellis', '.current-task'))
    mkdirSync(join(f.code, '.trellis', 'tasks', 'existing-unrelated'))
    writeFileSync(join(f.code, '.trellis', 'tasks', 'existing-unrelated', 'task.json'), JSON.stringify({ id: 'unrelated', status: 'planning', meta: {} }))
    assert.deepEqual(await f.status(), { ok: true, ...f.query, prepared: false, local: null })
    assert.equal(existsSync(join(f.dataDir, 'hifox-work')), false, 'status wrote a binding')
    const result = await f.prepare()
    assert.equal(result.ok, true); assert.equal(result.prepared, true); assert.equal(result.created, true)
    assert.equal(result.local.phase, 'plan'); assert.equal(result.local.projectRoot, f.code)
    const prd = read(f.prd(result))
    for (const text of [f.snapshot.tasks[0].description, 'Keep task identity', 'Repeated prepare reuses the task', 'Reuse the native local-task runner.', f.query.taskId, f.query.workspaceKey]) assert.ok(prd.includes(text), text)
    assert.equal(read(join(f.code, '.trellis', '.current-task')), before)
    assert.ok(listTasks(f.code).includes('existing-unrelated')); assert.equal(listTasks(f.code).length, 2)
    const [call] = logs(f.code); assert.ok(call.argv.includes('--no-start')); assert.ok(!call.argv.includes('--force'))
    assert.equal(call.meta.panel_hifox_task_id, f.query.taskId); assert.equal(call.meta.panel_hifox_workspace_key, f.query.workspaceKey)
    assert.ok(Object.values(call.meta).every((value) => typeof value === 'string'))
    assert.equal(f.snapshot.tasks[0].statusId, 'todo', 'preparation changed business status')
  })

  await check('repeats, independent instances, restart and a failed later business transition reuse one local task', async () => {
    const f = fixture(), first = await f.prepare(); assert.equal(first.ok, true)
    f.snapshot.tasks[0].statusId = 'in-progress'; f.snapshot.tasks[0].updatedAt = new Date(Date.now() + 1000).toISOString(); f.context.revision++
    f.snapshot.tasks[0].workflow.stage = 'planning'
    f.snapshot.tasks[0].workflow.artifacts.push({ id: 'plan-1', kind: 'plan', body: 'Native technical planning opened', actorId: 'actor-a', at: new Date().toISOString() })
    const second = await f.prepare(); assert.equal(second.ok, true); assert.equal(second.reused, true); assert.deepEqual(second.local, first.local)
    f.service = f.open(); const third = await f.prepare(); assert.equal(third.ok, true); assert.deepEqual(third.local, first.local)
    assert.equal(logs(f.code).length, 1); assert.equal(f.bindings().length, 1)
    assert.equal((await f.status()).prepared, true)
  })

  await check('concurrent prepare serializes across service instances and retains each caller authorization', async () => {
    const f = fixture(), held = gate(), other = f.open()
    f.cli = async (options, input) => { held.enter(); await held.wait; return f.runCli(options, input) }
    const first = f.prepare(); await held.entered
    const second = other.prepare(f.query), third = f.prepare()
    held.release()
    const results = await Promise.all([first, second, third]); results.forEach((result) => assert.equal(result.ok, true))
    assert.equal(results.filter((result) => result.created).length, 1); assert.equal(logs(f.code).length, 1); assert.equal(listTasks(f.code).length, 1)
  })

  await check('source and actor mismatch are rejected before snapshot/CLI and cannot expose bound paths', async () => {
    const f = fixture(); const prepared = await f.prepare(); assert.equal(prepared.ok, true)
    const initialLogs = logs(f.code).length
    f.context.key = 'workspace-other'
    const foreign = await f.status(); assert.equal(foreign.reason, 'scope_changed'); assert.equal(foreign.local, undefined)
    f.context.key = f.query.workspaceKey; f.context.actorId = 'actor-other'
    const actor = await f.prepare(); assert.equal(actor.ok, false); assert.equal(actor.local, undefined)
    f.context.actorId = 'actor-a'; f.snapshot.tasks[0].workflow.handlerId = 'actor-other'
    assert.equal((await f.prepare()).reason, 'not_handler')
    f.snapshot.tasks[0].workflow.handlerId = 'actor-a'; f.snapshot.spaces[0].memberIds = []
    assert.equal((await f.status()).reason, 'access_locked'); assert.equal(logs(f.code).length, initialLogs)
  })

  await check('same workspace key cannot reuse a binding under another verified actor', async () => {
    const f = fixture(); assert.equal((await f.prepare()).ok, true)
    f.snapshot.members.push({ ...f.snapshot.members[0], id: 'actor-b' }); f.context.actorId = 'actor-b'
    f.snapshot.spaces[0].memberIds.push('actor-b'); f.snapshot.tasks[0].assigneeIds.push('actor-b')
    f.snapshot.tasks[0].workflow.handlerId = 'actor-b'
    assert.equal((await f.prepare()).reason, 'scope_changed'); assert.equal(logs(f.code).length, 1)
  })

  await check('workflow handler takes precedence over the historical assignee roster', async () => {
    const f = fixture()
    f.snapshot.members.push({ ...f.snapshot.members[0], id: 'actor-b' }); f.snapshot.spaces[0].memberIds.push('actor-b')
    f.snapshot.tasks[0].assigneeIds = ['actor-b']
    assert.equal((await f.prepare()).ok, true, 'the actual workflow handler could not prepare')
    f.context.actorId = 'actor-b'
    const other = await f.prepare(); assert.equal(other.reason, 'not_handler'); assert.equal(other.local, undefined); assert.equal(logs(f.code).length, 1)
  })

  await check('general work and pre-development workflow stages do not manufacture code tasks', async () => {
    const f = fixture(); f.snapshot.tasks[0].workKind = 'general'
    assert.equal((await f.prepare()).reason, 'invalid_input'); assert.equal(logs(f.code).length, 0)
    f.snapshot.tasks[0].workKind = 'code'; f.snapshot.tasks[0].workflow.stage = 'design_review'
    assert.equal((await f.prepare()).reason, 'invalid_input'); assert.equal(logs(f.code).length, 0)
  })

  await check('updated acceptance and workflow source artifacts require review while plan receipts do not', async () => {
    for (const update of [
      (task) => { task.acceptanceCriteria.push('A new acceptance condition') },
      (task) => { task.workflow.artifacts.push({ id: 'requirements-2', kind: 'requirements', body: 'Additional product requirement', actorId: 'actor-a', at: new Date().toISOString() }) },
      (task) => { task.workflow.artifacts.push({ id: 'design-2', kind: 'design', body: 'Updated design approval', actorId: 'actor-a', at: new Date().toISOString() }) }
    ]) {
      const f = fixture(), first = await f.prepare(); assert.equal(first.ok, true); const original = read(f.prd(first))
      update(f.snapshot.tasks[0]); assert.equal((await f.prepare()).reason, 'source_changed'); assert.equal(read(f.prd(first)), original); assert.equal(logs(f.code).length, 1)
    }
  })

  await check('scope and actor changes during snapshot awaits fail before local side effects', async () => {
    for (const change of [(f) => { f.context.key = 'workspace-other' }, (f) => { f.context.actorId = 'actor-other' }]) {
      const f = fixture(), held = gate()
      f.snapshotHook = async () => { f.snapshotHook = null; held.enter(); await held.wait }
      const pending = f.prepare(); await held.entered; change(f); held.release()
      const result = await pending; assert.equal(result.ok, false); assert.equal(result.local, undefined); assert.equal(logs(f.code).length, 0)
    }
  })

  await check('authorization or service epoch changes after snapshot reads reject stale membership', async () => {
    for (const change of [(context) => { context.authorizationRevision = 2 }, (context) => { context.epoch = randomUUID() }]) {
      const f = fixture(); let calls = 0
      f.context.authorizationRevision = 1
      f.statusHook = async () => { if (++calls === 2) change(f.context) }
      const denied = await f.prepare(); assert.equal(denied.reason, 'scope_changed'); assert.equal(denied.local, undefined); assert.equal(logs(f.code).length, 0)
    }
  })

  await check('source switching or handler loss during CLI retains original command and locks completion', async () => {
    for (const change of [(f) => { f.context.key = 'workspace-other' }, (f) => { f.snapshot.tasks[0].workflow.handlerId = 'actor-other' }, (f) => { f.context.state = 'access-revoked' }]) {
      const f = fixture(), held = gate(), originalKey = f.context.key
      f.cli = async (options, input) => { const result = await f.runCli(options, input); held.enter(); await held.wait; return result }
      const pending = f.prepare(); await held.entered; change(f); held.release()
      const denied = await pending; assert.equal(denied.ok, false); assert.equal(denied.local, undefined)
      const directory = listTasks(f.code)[0]; assert.equal(read(join(f.code, '.trellis', 'tasks', directory, 'prd.md')).includes('Source revision (sha256)'), false)
      f.context.key = originalKey; f.context.state = 'connected'; f.snapshot.tasks[0].workflow.handlerId = 'actor-a'; f.cli = null
      assert.equal((await f.prepare()).ok, true); assert.equal(logs(f.code).length, 1)
    }
  })

  await check('revoked/offline remote access locks an existing binding instead of trusting cached roles', async () => {
    const f = fixture(); assert.equal((await f.prepare()).ok, true)
    for (const state of ['offline', 'access-revoked']) { f.context.state = state; const result = await f.prepare(); assert.equal(result.reason, 'access_locked'); assert.equal(result.local, undefined) }
    assert.equal(logs(f.code).length, 1)
  })

  await check('native directory choice supports zero projects; arbitrary renderer roots never become grants', async () => {
    const f = fixture(), other = project(join(f.dir, 'chosen-project'))
    f.current = null; f.chooser = async () => other
    const arbitrary = await f.prepare({ projectRoot: other }); assert.equal(arbitrary.reason, 'project_changed'); assert.equal(f.chooseCount, 0)
    const result = await f.prepare(); assert.equal(result.ok, true); assert.equal(result.local.projectRoot, other); assert.equal(f.chooseCount, 1)
    f.current = f.code; f.generation++
    const repeated = await f.prepare(); assert.equal(repeated.ok, true); assert.equal(repeated.local.projectRoot, other); assert.equal(logs(f.code).length, 0); assert.equal(logs(other).length, 1)
    assert.equal((await f.prepare({ projectRoot: f.code })).reason, 'project_changed')
  })

  await check('chooser scope switch, cancellation and invalid projects leave task creation untouched', async () => {
    const f = fixture(); f.current = null; f.chooser = async () => null
    assert.equal((await f.prepare()).reason, 'cancelled')
    f.chooser = async () => f.dir; assert.equal((await f.prepare()).reason, 'project_invalid')
    f.chooser = async () => { f.context.key = 'workspace-switched'; return f.code }
    assert.equal((await f.prepare()).reason, 'scope_changed'); assert.equal(logs(f.code).length, 0)
  })

  await check('main current-root generation is fenced during initial root admission', async () => {
    const f = fixture(); let snapshots = 0
    f.snapshotHook = async () => { snapshots++; if (snapshots === 3) { f.current = project(join(f.dir, 'switched-project')); f.generation++ } }
    assert.equal((await f.prepare()).reason, 'project_changed'); assert.equal(logs(f.code).length, 0); assert.equal(logs(f.current).length, 0)
  })

  await check('definite CLI failure retries original stable command; unknown outcomes reconcile without duplicate CLI', async () => {
    const f = fixture(); writeFileSync(join(f.code, 'mode'), 'fail')
    assert.equal((await f.prepare()).reason, 'cli_failed')
    writeFileSync(join(f.code, 'mode'), 'normal'); f.service = f.open()
    assert.equal((await f.prepare()).ok, true)
    const calls = logs(f.code); assert.equal(calls.length, 2); assert.equal(calls[0].meta.panel_operation_id, calls[1].meta.panel_operation_id)
    const u = fixture()
    u.cli = async (options, input) => { const result = await u.runCli(options, input); return { ...result, code: null, aborted: true } }
    assert.equal((await u.prepare()).reason, 'outcome_unknown'); u.cli = null; u.service = u.open()
    assert.equal((await u.prepare()).ok, true); assert.equal(logs(u.code).length, 1)
  })

  await check('lost acknowledgement and crash after CLI recover by flattened source identity', async () => {
    const f = fixture()
    f.cli = async (options, input) => { await f.runCli(options, input); throw Error('Owned lost acknowledgement') }
    assert.equal((await f.prepare()).reason, 'outcome_unknown'); f.cli = null
    const [path] = f.bindings(), record = JSON.parse(read(path)); assert.equal(record.stage, 'uncertain')
    record.stage = 'dispatching'; writeFileSync(path, JSON.stringify(record) + '\n'); f.service = f.open()
    const resumed = await f.prepare(); assert.equal(resumed.ok, true); assert.equal(resumed.reused, true); assert.equal(logs(f.code).length, 1)
    // Missing userData mapping still reconciles a real registry record under the verified current root.
    removeFixture(path); f.service = f.open(); const recovered = await f.prepare(); assert.equal(recovered.ok, true); assert.deepEqual(recovered.local, resumed.local); assert.equal(logs(f.code).length, 1)
  })

  await check('unknown creation with no verifiable directory remains visible without another create', async () => {
    const f = fixture(); let calls = 0
    f.cli = async () => { calls++; return { code: null, stdout: '', stderr: 'Owned timeout', aborted: true, failedToStart: false, createdDirName: null } }
    assert.equal((await f.prepare()).reason, 'outcome_unknown'); f.service = f.open()
    assert.equal((await f.prepare()).reason, 'outcome_unknown'); assert.equal((await f.status()).reason, 'outcome_unknown'); assert.equal(calls, 1)
  })

  await check('partial failed CLI resumes the existing skeleton and rejects unreadable partial task metadata', async () => {
    const f = fixture(); writeFileSync(join(f.code, 'mode'), 'partial-fail')
    assert.equal((await f.prepare()).reason, 'cli_failed'); writeFileSync(join(f.code, 'mode'), 'normal')
    const resumed = await f.prepare(); assert.equal(resumed.ok, true); assert.ok(read(f.prd(resumed)).includes(f.query.taskId)); assert.equal(logs(f.code).length, 1)
    const bad = fixture(); writeFileSync(join(bad.code, 'mode'), 'bad-json')
    assert.equal((await bad.prepare()).reason, 'cli_failed'); assert.equal((await bad.prepare()).reason, 'task_conflict'); assert.equal(logs(bad.code).length, 1)
  })

  await check('prepared PRD edits are preserved; source revisions require review instead of overwriting', async () => {
    const f = fixture(), first = await f.prepare(); assert.equal(first.ok, true)
    const edited = read(f.prd(first)) + '\nDeveloper acceptance refinements.\n'; writeFileSync(f.prd(first), edited)
    const reused = await f.prepare(); assert.equal(reused.ok, true); assert.equal(reused.prdModified, true); assert.equal(read(f.prd(first)), edited)
    f.snapshot.tasks[0].description += '\nNew business requirement.'
    const status = await f.status(); assert.equal(status.ok, true); assert.equal(status.reviewRequired, true)
    const conflict = await f.prepare(); assert.equal(conflict.reason, 'source_changed'); assert.equal(conflict.reviewRequired, true); assert.deepEqual(conflict.local, first.local)
    assert.equal(read(f.prd(first)), edited); assert.equal(logs(f.code).length, 1)
  })

  await check('developer edits before first PRD transfer are never adopted as an overwrite baseline', async () => {
    const f = fixture(); writeFileSync(join(f.code, 'mode'), 'edited-prd')
    const result = await f.prepare(); assert.equal(result.reason, 'prd_conflict'); assert.equal(read(f.prd(result)), '# Developer edited during CLI\n')
    f.current = project(join(f.dir, 'another-project')); f.generation++; f.service = f.open()
    assert.equal((await f.prepare()).reason, 'prd_conflict'); assert.equal(logs(f.current).length, 0); assert.equal(logs(f.code).length, 1)
  })

  await check('material changes while CLI awaits keep the original source record and default PRD', async () => {
    const f = fixture(), held = gate()
    f.cli = async (options, input) => { const result = await f.runCli(options, input); held.enter(); await held.wait; return result }
    const pending = f.prepare(); await held.entered; f.snapshot.tasks[0].workflow.artifacts.push({ id: 'design-2', kind: 'design', body: 'A new reviewed design', actorId: 'actor-a', at: new Date().toISOString() }); held.release()
    assert.equal((await pending).reason, 'source_changed'); f.cli = null
    const repeat = await f.prepare(); assert.equal(repeat.reason, 'source_changed'); assert.equal(logs(f.code).length, 1)
    assert.equal(read(f.prd(repeat)).includes('Source revision (sha256)'), false)
  })

  await check('actual task phase and archive movement are read from registry; missing or duplicate tasks never recreate', async () => {
    const f = fixture(), first = await f.prepare(); assert.equal(first.ok, true)
    const file = join(first.local.projectRoot, first.local.relativeDir, 'task.json'), task = JSON.parse(read(file)); task.status = 'in_progress'; writeFileSync(file, JSON.stringify(task))
    assert.equal((await f.status()).local.phase, 'implement')
    const archive = join(f.code, '.trellis', 'tasks', 'archive', '2026-10'); mkdirSync(archive, { recursive: true })
    moveFixture(dirname(file), join(archive, first.local.taskDir))
    const archived = await f.prepare(); assert.equal(archived.ok, true); assert.equal(archived.local.archived, true); assert.equal(archived.local.phase, 'implement')
    removeFixture(join(archive, first.local.taskDir), { recursive: true }); assert.equal((await f.prepare()).reason, 'task_missing'); assert.equal(logs(f.code).length, 1)
    const d = fixture(), prepared = await d.prepare(); assert.equal(prepared.ok, true)
    const duplicate = join(d.code, '.trellis', 'tasks', 'duplicate'); mkdirSync(duplicate)
    writeFileSync(join(duplicate, 'task.json'), read(join(prepared.local.projectRoot, prepared.local.relativeDir, 'task.json')))
    assert.equal((await d.prepare()).reason, 'task_conflict'); assert.equal(logs(d.code).length, 1)
  })

  await check('same business task ID in another workspace gets a distinct mapping and cannot claim original recovery meta', async () => {
    const f = fixture(), first = await f.prepare(); assert.equal(first.ok, true)
    f.context.key = 'workspace-other'; f.query.workspaceKey = f.context.key
    const second = await f.prepare(); assert.equal(second.ok, true); assert.notEqual(second.local.taskId, first.local.taskId); assert.equal(f.bindings().length, 2)
    const file = join(second.local.projectRoot, second.local.relativeDir, 'task.json'), task = JSON.parse(read(file)); task.meta.panel_hifox_workspace_key = 'workspace-original'; writeFileSync(file, JSON.stringify(task))
    assert.equal((await f.prepare()).reason, 'task_conflict'); assert.equal(logs(f.code).length, 2)
  })

  await check('corrupt or blocked userData binding storage fails before CLI and preserves saved bytes', async () => {
    const f = fixture(); mkdirSync(join(f.dataDir, 'hifox-work')); writeFileSync(join(f.dataDir, 'hifox-work', 'bindings'), 'owned blocking file')
    assert.equal((await f.prepare()).reason, 'store_unavailable'); assert.equal(logs(f.code).length, 0)
    const c = fixture(); assert.equal((await c.prepare()).ok, true)
    const [file] = c.bindings(); writeFileSync(file, '{broken-owned-record')
    assert.equal((await c.prepare()).reason, 'store_unavailable'); assert.equal(read(file), '{broken-owned-record'); assert.equal(logs(c.code).length, 1)
  })

  await check('project and task symlink escapes cannot create, write PRD or redirect an existing binding', async () => {
    const f = fixture(), outside = project(join(f.dir, 'outside'))
    removeFixture(join(f.code, '.trellis', 'tasks'), { recursive: true }); symlinkSync(join(outside, '.trellis', 'tasks'), join(f.code, '.trellis', 'tasks'), 'junction')
    assert.equal((await f.prepare({ projectRoot: f.code })).reason, 'project_invalid'); assert.equal(logs(f.code).length, 0)
    const b = fixture(), result = await b.prepare(); assert.equal(result.ok, true)
    const originalDir = dirname(b.prd(result)), outsideDir = join(b.dir, 'outside-task'); moveFixture(originalDir, outsideDir)
    const outsidePrd = join(outsideDir, 'prd.md'); writeFileSync(outsidePrd, 'Owned outside content')
    symlinkSync(outsideDir, originalDir, 'junction')
    assert.equal((await b.prepare()).ok, false); assert.equal(read(outsidePrd), 'Owned outside content'); assert.equal(logs(b.code).length, 1)
  })

  await check('new native IPC registers the declared channels and validates inputs with stable errors', async () => {
    host.handlers.clear(); mkdirSync(host.dataDir, { recursive: true })
    m.registerHifoxWorkIpc({ getProjectRoot: () => null, getProjectGeneration: () => 0 })
    for (const name of [m.ipcInvoke.hifoxWork.status, m.ipcInvoke.hifoxWork.prepare]) {
      assert.equal(typeof host.handlers.get(name), 'function')
      const result = await host.handlers.get(name)({}, { workspaceKey: 'local', taskId: 'x', arbitraryPath: root })
      assert.equal(result.ok, false); assert.equal(result.code, 'E_INVALID_ARG'); assert.equal(result.reason, 'invalid_input')
    }
  })
  console.log(`\n${passed} isolated HiFox task-workspace regression groups passed.`)
} finally {
  delete globalThis.__HIFOX_WORK_SMOKE__
  // Fixture helpers constrain inner removals; final cleanup is the verified mkdtemp root only.
  assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')))
  rmSync(root, { recursive: true, force: true })
}
