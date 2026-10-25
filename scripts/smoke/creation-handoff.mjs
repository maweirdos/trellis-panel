/** Native handoff regression. Only owned TEMP projects run the stub task.py; no network or model. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-creation-handoff-')))
const host = globalThis.__CREATION_HANDOFF__ = { dataDir: join(root, 'creations-data'), active: null }
let m, serial = 0, passed = 0
const check = async (name, run) => { await run(); passed++; console.log('PASS ' + name) }
const digest = (body) => createHash('sha256').update(body, 'utf8').digest('hex')
const read = (path) => readFileSync(path, 'utf8')
const owned = (path) => {
  const absolute = resolve(path), rel = relative(root, absolute)
  assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'fixture escaped TEMP root')
  return absolute
}
const remove = (path) => unlinkSync(owned(path))
const move = (from, to) => renameSync(owned(from), owned(to))
const gate = () => { let enter, release; return { entered: new Promise((done) => { enter = done }), wait: new Promise((done) => { release = done }), enter: () => enter(), release: () => release() } }

function project(directory) {
  mkdirSync(join(directory, '.trellis', 'scripts'), { recursive: true })
  mkdirSync(join(directory, '.trellis', 'tasks'), { recursive: true })
  writeFileSync(join(directory, '.trellis', 'workflow.md'), '# Owned workflow fixture\n')
  writeFileSync(join(directory, '.trellis', '.current-task'), 'existing-owned-pointer\n')
  writeFileSync(join(directory, '.trellis', 'scripts', 'task.py'), `
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const argv=process.argv.slice(2),root=process.cwd(),opt=(name)=>argv[argv.indexOf(name)+1];
assert.equal(argv[0],'create');assert.ok(argv.includes('--no-start'));assert.ok(!argv.includes('--force'));assert.ok(!argv.includes('start'));
const meta=Object.fromEntries(argv.flatMap((arg,i)=>arg==='--meta'?[[argv[i+1].slice(0,argv[i+1].indexOf('=')),argv[i+1].slice(argv[i+1].indexOf('=')+1)]]:[]));
fs.appendFileSync(path.join(root,'cli.jsonl'),JSON.stringify({argv,meta})+'\\n');
const now=new Date(),prefix=String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
const dirName=prefix+'-'+opt('--slug'),dir=path.join(root,'.trellis','tasks',dirName);fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir,'task.json'),JSON.stringify({id:'owned-'+opt('--slug'),status:'planning',meta}));
const defaultPrd=${m.expectedDefaultPrd.toString()};fs.writeFileSync(path.join(dir,'prd.md'),defaultPrd(argv[1],opt('--description')));
console.error('Created task: '+dirName);
`)
  return directory
}

async function fixture({ large = false } = {}) {
  const dir = join(root, 'case-' + ++serial), code = project(join(dir, 'project')), dataDir = join(dir, 'user-data')
  mkdirSync(dataDir, { recursive: true })
  const time = new Date().toISOString()
  const people = ['owner', 'reviewer'].map((id) => ({ id, name: id, role: id === 'owner' ? 'owner' : 'member', avatarHue: 0, joinedAt: time }))
  const taskId = 'ENG-HANDOFF-' + serial
  const task = { id: taskId, spaceId: 'space', title: '导出与盘点🌱', description: large ? '保留完整需求🌱，空数据不可导出。\n'.repeat(1500) : '保留完整需求。', workKind: 'code', acceptanceCriteria: ['空数据时禁用导出'], priority: 'high', assigneeIds: ['owner'], iterationIds: ['v15'], workflow: { stage: 'dev_ready', handlerId: 'owner', artifacts: [{ id: 'design-original', kind: 'design', body: '完整设计材料应按需读取。', actorId: 'owner', at: time }], history: [] } }
  const f = { dir, code, dataDir, context: { key: 'local', state: 'local', connectionId: null, projectId: null, actorId: 'owner', revision: 0, canManage: true, pendingCount: 0, projectName: null }, snapshot: { members: people, spaces: [{ id: 'space', key: 'ENG', name: 'Owned fixture', memberIds: people.map((person) => person.id), multiAssignee: false, taskSeq: 1, createdAt: time }], tasks: [task] }, filesHook: null, referencesHook: null, cliHook: null }
  host.active = f
  f.query = { workspaceKey: 'local', taskId }
  f.creationId = randomUUID()
  f.original = '<!doctype html><html><body><button id="export">导出</button></body></html>'
  f.adoptedBody = f.original.replace('id="export"', 'id="export" disabled')
  f.scenarios = [{ id: 'empty-data', title: '空数据导出🌱', preconditions: ['库存为空'], steps: ['选择门诊药房', '检查导出按钮'], expectedResult: '按钮不可用，保留当前筛选条件' }]
  const service = m.creationService()
  await service.command({ workspaceKey: 'local', command: { action: 'create', commandId: randomUUID(), creationId: f.creationId, expectedRevision: null, title: '冻结原型🌱', kind: 'prototype', home: 'personal', spaceId: null, body: f.original, scenarios: f.scenarios, privateNotes: 'SECRET_PRIVATE_NOTES_' + serial } })
  f.command = async (command) => {
    const view = await service.get({ workspaceKey: 'local', creationId: f.creationId })
    return service.command({ workspaceKey: 'local', command: { commandId: randomUUID(), creationId: f.creationId, expectedRevision: view.summary.revision, ...command } })
  }
  f.r1 = (await f.command({ action: 'publish', spaceId: 'space', reviewerIds: ['reviewer'] })).result.revisionId
  f.context.actorId = 'reviewer'
  f.commentId = (await f.command({ action: 'annotate', revisionId: f.r1, target: { kind: 'web', stableId: 'export', name: '导出', state: 'disabled', context: { fields: [{ name: '药房', value: '门诊药房' }] } }, body: '空数据导出应被禁用', severity: 'required' })).result.commentId
  f.context.actorId = 'owner'
  await f.command({ action: 'saveDraft', body: f.adoptedBody, scenarios: f.scenarios })
  f.r2 = (await f.command({ action: 'publish', spaceId: 'space', reviewerIds: ['reviewer'] })).result.revisionId
  f.context.actorId = 'reviewer'
  await f.command({ action: 'disposition', commentId: f.commentId, status: 'confirmed', finalRule: '空数据时禁用导出，保留药房筛选', reviewRevisionId: f.r2 })
  f.context.actorId = 'owner'
  await f.command({ action: 'adoptForTask', taskId, revisionId: f.r2, confirmedCommentIds: [f.commentId] })
  const draft = await service.get({ workspaceKey: 'local', creationId: f.creationId })
  await f.command({ action: 'annotate', revisionId: draft.draft.revisionId, target: { kind: 'general' }, body: 'SECRET_PRIVATE_COMMENT_' + serial, severity: 'suggestion' })
  f.references = () => m.taskCreationReferences(f.query)
  f.files = (references) => m.taskCreationFiles(f.query, references)
  f.runCli = (options, input) => m.runTaskCreateCli({ ...options, pythonCommand: process.execPath }, input)
  f.deps = { dataDir, getProjectRoot: () => code, getProjectGeneration: () => 1, chooseProjectRoot: async () => { throw Error('Fixture must not open a real chooser') }, workspaceStatus: async () => structuredClone(f.context), workspaceSnapshot: async () => ({ snapshot: structuredClone(f.snapshot), context: structuredClone(f.context) }), creationReferences: async (query) => f.referencesHook ? f.referencesHook(query) : m.taskCreationReferences(query), creationFiles: async (query, references) => f.filesHook ? f.filesHook(query, references) : m.taskCreationFiles(query, references), cliRunner: (options, input) => f.cliHook ? f.cliHook(options, input) : f.runCli(options, input) }
  f.open = () => new m.HifoxTaskWorkspaceService(f.deps)
  f.service = f.open()
  f.prepare = () => f.service.prepare(f.query)
  f.status = () => f.service.status(f.query)
  f.taskDir = () => join(code, '.trellis', 'tasks', readdirSync(join(code, '.trellis', 'tasks'))[0])
  f.prd = () => join(f.taskDir(), 'prd.md')
  f.calls = () => existsSync(join(code, 'cli.jsonl')) ? read(join(code, 'cli.jsonl')).trim().split('\n').map(JSON.parse) : []
  f.binding = () => join(dataDir, 'hifox-work', 'bindings', readdirSync(join(dataDir, 'hifox-work', 'bindings'))[0])
  return f
}

try {
  mkdirSync(host.dataDir, { recursive: true })
  const output = join(root, 'handoff.mjs')
  await build({ stdin: { contents: `export {creationService,closeCreationService,taskCreationReferences,taskCreationFiles} from './src/main/services/creations';export {HifoxTaskWorkspaceService} from './src/main/services/hifox/task-workspace';export {expectedDefaultPrd} from './src/main/services/local-task/operations';export {runTaskCreateCli} from './src/main/services/local-task/cli-runner';`, resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'owned-native-boundaries', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'owned' }))
    builder.onResolve({ filter: /(?:connection-service|team-desktop|\/store|\/ai|\/bridge)$/ }, (args) => {
      if (args.importer.replaceAll('\\', '/').endsWith('/services/creations/index.ts') || (args.path.endsWith('connection-service') && args.importer.replaceAll('\\', '/').endsWith('/hifox/task-workspace.ts'))) return { path: args.path, namespace: 'owned' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'owned' }, ({ path }) => {
      const prefix = 'const host=globalThis.__CREATION_HANDOFF__;'
      if (path === 'electron') return { contents: prefix + 'export const app={getPath:()=>host.dataDir};export const safeStorage={isEncryptionAvailable:()=>false};', loader: 'js' }
      if (path.endsWith('connection-service')) return { contents: prefix + 'export const hifoxWorkspaceStatus=async()=>structuredClone(host.active.context);export const hifoxWorkspaceSnapshot=async()=>({snapshot:structuredClone(host.active.snapshot),context:structuredClone(host.active.context)});', loader: 'js' }
      if (path.endsWith('team-desktop')) return { contents: 'export async function withDesktopTeamService(){throw Error("Fixture cannot call a team service")}', loader: 'js' }
      if (path.endsWith('/store')) return { contents: 'export const getSettings=()=>({ai:{enabled:false,model:"",baseUrl:"",apiKey:""}});', loader: 'js' }
      if (path.endsWith('/ai')) return { contents: 'export async function aiChat(){throw Error("Fixture cannot call a model")}', loader: 'js' }
      if (path.endsWith('/bridge')) return { contents: 'export function broadcastToWindows(){}', loader: 'js' }
      throw Error('Unknown fixture boundary ' + path)
    })
  } }] })
  m = await import(pathToFileURL(output).href)

  await check('adopted HTML, original annotation anchors and immutable scenarios reach one native task', async () => {
    const f = await fixture({ large: true }), originalTask = structuredClone(f.snapshot.tasks[0]), references = await f.references()
    const result = await f.prepare(); assert.equal(result.ok, true); assert.equal(result.created, true)
    const prd = read(f.prd()), [reference] = references
    const htmlPath = `references/${f.creationId}/${f.r2}.html`, reviewPath = `references/${f.creationId}/${f.r2}.review.json`
    assert.ok(Buffer.byteLength(prd, 'utf8') <= 6144); assert.equal(prd.includes('\uFFFD'), false)
    for (const pointer of ['references/source-materials.json', htmlPath, reviewPath]) assert.ok(prd.includes(pointer), pointer)
    assert.equal(read(join(f.taskDir(), htmlPath)), f.adoptedBody)
    const review = JSON.parse(read(join(f.taskDir(), reviewPath)))
    assert.deepEqual(review.scenarios, f.scenarios); assert.deepEqual(review.adoption, reference)
    assert.equal(review.adoption.confirmedRules[0].sourceRevisionId, f.r1); assert.equal(review.adoption.confirmedRules[0].reviewedRevisionId, f.r2)
    assert.equal(review.adoption.confirmedRules[0].target.stableId, 'export'); assert.equal(review.adoption.confirmedRules[0].originalBody, '空数据导出应被禁用')
    const full = JSON.parse(read(join(f.taskDir(), 'references/source-materials.json')))
    assert.equal(full.description, originalTask.description); assert.deepEqual(full.artifacts, originalTask.workflow.artifacts)
    assert.equal(JSON.stringify(full).includes('SECRET_PRIVATE'), false); assert.equal(JSON.stringify(review).includes('SECRET_PRIVATE'), false)
    assert.equal(prd.includes(f.adoptedBody), false); assert.equal(read(join(f.code, '.trellis', '.current-task')), 'existing-owned-pointer\n')
    assert.deepEqual(f.snapshot.tasks[0], originalTask); assert.equal(f.calls().length, 1)
    f.service = f.open(); const repeated = await f.prepare(); assert.equal(repeated.reused, true); assert.deepEqual(repeated.local, result.local); assert.equal(f.calls().length, 1)
    const edited = prd + '\nHuman acceptance edits.\n'; writeFileSync(f.prd(), edited)
    assert.equal((await f.prepare()).prdModified, true); assert.equal(read(f.prd()), edited)
  })

  await check('R3 publication and later comment edits keep R2 handoff frozen; explicit R3 adoption requires review', async () => {
    const f = await fixture(), first = await f.prepare(); assert.equal(first.ok, true)
    const originalReferences = await f.references(), originalPrd = read(f.prd()), originalFiles = await f.files(originalReferences)
    await f.command({ action: 'reply', commentId: f.commentId, body: 'Later discussion must not rewrite adoption' })
    await f.command({ action: 'saveDraft', body: f.original + '<p>R3 only</p>', scenarios: [{ ...f.scenarios[0], expectedResult: 'R3 changed scenario' }] })
    const r3 = (await f.command({ action: 'publish', spaceId: 'space', reviewerIds: ['reviewer'] })).result.revisionId
    assert.deepEqual(await f.references(), originalReferences); assert.deepEqual(await f.files(originalReferences), originalFiles)
    const repeated = await f.prepare(); assert.equal(repeated.ok, true); assert.equal(repeated.reviewRequired, false); assert.deepEqual(repeated.local, first.local)
    f.context.actorId = 'reviewer'
    await f.command({ action: 'disposition', commentId: f.commentId, status: 'confirmed', finalRule: 'R3 rule reviewed by a person', reviewRevisionId: r3 })
    f.context.actorId = 'owner'
    await f.command({ action: 'adoptForTask', taskId: f.query.taskId, revisionId: r3, confirmedCommentIds: [f.commentId] })
    const status = await f.status(); assert.equal(status.ok, true); assert.equal(status.reviewRequired, true)
    const conflict = await f.prepare(); assert.equal(conflict.reason, 'source_changed'); assert.equal(conflict.reviewRequired, true); assert.deepEqual(conflict.local, first.local)
    assert.equal(read(f.prd()), originalPrd); assert.equal(f.calls().length, 1)
    for (const file of originalFiles) assert.equal(read(join(f.taskDir(), file.relativePath)), file.body)
    assert.equal(existsSync(join(f.taskDir(), `references/${f.creationId}/${r3}.html`)), false)
  })

  await check('modified or deleted HTML, frozen reviews and full-source files block prepare and reopen', async () => {
    for (const kind of ['html', 'review.json', 'source-materials.json']) for (const operation of ['edit', 'delete']) {
      const f = await fixture(); assert.equal((await f.prepare()).ok, true)
      const path = kind === 'source-materials.json' ? join(f.taskDir(), 'references', kind) : join(f.taskDir(), 'references', f.creationId, `${f.r2}.${kind}`)
      if (operation === 'edit') writeFileSync(path, 'Owned human edit')
      else remove(path)
      for (const result of [await f.prepare(), await f.status()]) { assert.equal(result.ok, false); assert.equal(result.reason, 'prd_conflict'); assert.equal(result.reviewRequired, true) }
      assert.equal(f.calls().length, 1); assert.equal(operation === 'edit' ? read(path) : existsSync(path), operation === 'edit' ? 'Owned human edit' : false)
    }
  })

  await check('wrong content digests and malformed import paths reject before writing any reference', async () => {
    for (const kind of ['digest', 'path']) {
      const f = await fixture()
      f.filesHook = async (_query, references) => { const files = await f.files(references); if (kind === 'digest') files.at(-1).bodyDigest = '0'.repeat(64); else files.at(-1).relativePath = 'references/../../../escape.txt'; return files }
      const result = await f.prepare(); assert.equal(result.ok, false); assert.equal(result.reason, 'source_changed')
      assert.equal(existsSync(join(f.taskDir(), 'references')), false); assert.equal(read(f.prd()).includes('Source revision (sha256)'), false)
      assert.equal(existsSync(join(f.code, '.trellis', 'escape.txt')), false); assert.equal(f.calls().length, 1)
    }
  })

  await check('replaced references directory cannot redirect imports inside or outside the project', async () => {
    for (const inside of [true, false]) {
      const f = await fixture(), protectedDir = join(inside ? f.code : f.dir, 'protected')
      mkdirSync(protectedDir)
      f.cliHook = async (options, input) => { const result = await f.runCli(options, input); symlinkSync(protectedDir, join(f.taskDir(), 'references'), 'junction'); return result }
      const result = await f.prepare(); assert.equal(result.ok, false); assert.deepEqual(readdirSync(protectedDir), [])
      assert.equal(read(f.prd()).includes('Source revision (sha256)'), false); assert.equal(f.calls().length, 1)
    }
  })

  await check('a prepared reference directory replaced with an in-project junction blocks reopening', async () => {
    const f = await fixture(); assert.equal((await f.prepare()).ok, true)
    const from = join(f.taskDir(), 'references'), to = join(f.code, 'moved-references')
    move(from, to); symlinkSync(to, from, 'junction')
    assert.equal((await f.status()).ok, false); assert.equal((await f.prepare()).ok, false); assert.equal(f.calls().length, 1)
  })

  await check('tampered persisted reference paths cannot replace integrity checks with another project file', async () => {
    const f = await fixture(); assert.equal((await f.prepare()).ok, true)
    const binding = f.binding(), record = JSON.parse(read(binding)), source = join(f.taskDir(), record.referenceFiles[0].relativePath)
    writeFileSync(join(f.code, '.trellis', 'escape.txt'), read(source)); remove(source)
    record.referenceFiles[0].relativePath = 'references/../../../escape.txt'; writeFileSync(binding, JSON.stringify(record))
    assert.equal((await f.status()).ok, false); assert.equal((await f.prepare()).ok, false); assert.equal(f.calls().length, 1)
    assert.equal(digest(read(join(f.code, '.trellis', 'escape.txt'))), record.referenceFiles[0].bodyDigest)
  })

  await check('actor, handler and source adoption changes during import await prevent local material writes', async () => {
    for (const kind of ['actor', 'handler', 'adoption']) {
      const f = await fixture(), held = gate()
      f.filesHook = async (_query, references) => { const files = await f.files(references); held.enter(); await held.wait; return files }
      const pending = f.prepare(); await held.entered
      if (kind === 'actor') f.context.actorId = 'reviewer'
      if (kind === 'handler') f.snapshot.tasks[0].workflow.handlerId = 'reviewer'
      if (kind === 'adoption') await f.command({ action: 'adoptForTask', taskId: f.query.taskId, revisionId: f.r2, confirmedCommentIds: [f.commentId] })
      held.release(); assert.equal((await pending).ok, false)
      assert.equal(existsSync(join(f.taskDir(), 'references')), false); assert.equal(read(f.prd()).includes('Source revision (sha256)'), false); assert.equal(f.calls().length, 1)
    }
  })
  console.log(`creation handoff: ${passed} regression groups passed`)
} catch (error) {
  console.error('Creation handoff regression failed:', error)
  throw error
} finally {
  m?.closeCreationService()
  delete globalThis.__CREATION_HANDOFF__
  const rel = relative(realpathSync.native(tmpdir()), root)
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('trellis-creation-handoff-'))
  rmSync(root, { recursive: true, force: true })
}
