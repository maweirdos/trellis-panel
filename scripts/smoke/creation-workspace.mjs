/** Run: node scripts/smoke/creation-workspace.mjs [--unit-only] [--keep-temp].
 * Production React components with an explicit in-memory API/model test adapter.
 * Native IPC, disk persistence, remote services and configured model behavior are separate checks.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = realpathSync.native(fileURLToPath(new URL('../../', import.meta.url)))
const require = createRequire(import.meta.url)
const prefix = 'trellis-creation-workspace-'
const tempRoot = realpathSync.native(tmpdir())
const directory = realpathSync.native(mkdtempSync(join(tempRoot, prefix)))
const keepTemp = process.argv.includes('--keep-temp')
const unitOnly = process.argv.includes('--unit-only')
for (const argument of process.argv.slice(2)) assert.ok(['--keep-temp', '--unit-only'].includes(argument), `Unknown argument: ${argument}`)
let server
let completed = false

function ownedDirectory() {
  const resolved = realpathSync.native(directory)
  assert.equal(dirname(resolved), tempRoot, 'cleanup may only touch the newly allocated TEMP child')
  assert.ok(basename(resolved).startsWith(prefix), 'TEMP child must have the runner-owned prefix')
  return resolved
}

function checkCreationState(state, schemas) {
  let checks = 0
  const check = (name, action) => { action(); checks++; console.log(`PASS pure: ${name}`) }
  const digest = 'a'.repeat(64)
  const creationId = randomUUID(), draftId = randomUUID(), publishedId = randomUUID()
  const scenario = { id: 'scenario-one', title: '保存', preconditions: ['已经打开'], steps: ['按下保存'], expectedResult: '正文已保存' }
  const summary = schemas.creationSummarySchema.parse({ creationId, projectId: 'fixture-project', ownerId: 'person-one', title: '草稿', kind: 'document', home: 'personal', spaceId: null, revision: 2, latestPublished: null, adoptions: [], canEdit: true, canReview: true, canManageReview: true, createdAt: 1, updatedAt: 2 })
  const view = schemas.creationViewSchema.parse({ summary, selected: { revisionId: draftId, number: null, title: '草稿', body: '正文', bodyDigest: digest, scenarios: [scenario], published: false }, revisions: [], comments: [], commentOffset: 0, nextCommentOffset: null, privateNotes: '仅拥有者', draft: { revisionId: draftId, serial: 2, bodyDigest: digest, updatedAt: 2 } })
  const draft = state.draftFromView(view)
  assert.ok(draft)

  check('draft ownership follows the selected draft identity and does not alias scenarios', () => {
    assert.equal(draft.baseRevisionId, draftId)
    assert.equal(draft.baseSerial, 2)
    assert.equal(draft.dirty, false)
    assert.equal(state.draftFromView({ ...view, selected: { ...view.selected, revisionId: publishedId, published: true } }), null)
    assert.equal(state.draftFromView({ ...view, selected: { ...view.selected, revisionId: randomUUID() } }), null)
    assert.equal(state.draftFromView({ ...view, draft: undefined }), null)
    const copy = state.draftFromView(view)
    copy.scenarios[0].steps.push('另一项操作')
    assert.deepEqual(view.selected.scenarios[0].steps, ['按下保存'])
    assert.equal(state.draftFromView({ ...view, privateNotes: undefined }).privateNotes, undefined)
  })
  check('unsaved drafts stay separate across workspace, actor, epoch and creation keys', () => {
    const key = (workspace, actor, epoch, id = creationId) => `${JSON.stringify([workspace, actor, epoch])}:${id}`
    const own = key('workspace-a', 'person-one', 'epoch-a')
    const dirty = { ...draft, dirty: true }
    state.retainDraft(own, dirty)
    assert.equal(state.readRetainedDraft(own).body, '正文')
    for (const foreign of [key('workspace-b', 'person-one', 'epoch-a'), key('workspace-a', 'person-two', 'epoch-a'), key('workspace-a', 'person-one', 'epoch-b'), key('workspace-a', 'person-one', 'epoch-a', randomUUID())]) assert.equal(state.readRetainedDraft(foreign), undefined)
    state.retainDraft(own, { ...dirty, body: '保留修改' })
    assert.equal(state.readRetainedDraft(own).body, '保留修改')
    state.retainDraft(own, draft)
    assert.equal(state.readRetainedDraft(own), undefined)
  })
  check('retained input is bounded and updating an entry preserves its recency', () => {
    const keys = Array.from({ length: 24 }, () => randomUUID())
    for (const key of keys) state.retainDraft(key, { ...draft, dirty: true })
    state.retainDraft(keys[0], { ...draft, body: '最近修改', dirty: true })
    state.retainDraft(randomUUID(), { ...draft, dirty: true })
    assert.equal(state.readRetainedDraft(keys[1]), undefined)
    assert.equal(state.readRetainedDraft(keys[0]).body, '最近修改')
    for (const key of keys) state.retainDraft(key, draft)
  })
  check('only exact persisted content clears dirty state, including scenarios and private notes', () => {
    assert.equal(state.sameDraftContents(draft, { ...draft, dirty: true, baseSerial: 99, baseRevisionId: randomUUID() }), true)
    for (const patch of [{ title: '新标题' }, { body: '新正文' }, { privateNotes: undefined }, { scenarios: [{ ...scenario, expectedResult: '另一个结果' }] }]) assert.equal(state.sameDraftContents(draft, { ...draft, ...patch }), false)
  })
  check('paging merges updated identities without duplicate comments or input mutation', () => {
    const comment = schemas.creationCommentSchema.parse({ commentId: randomUUID(), revisionId: publishedId, authorId: 'person-one', private: false, target: { kind: 'general' }, body: '意见', severity: 'required', status: 'open', finalRule: null, reviewedRevisionId: null, dispositionBy: null, dispositionAt: null, reviewSerial: 1, replies: [], createdAt: 1 })
    const second = { ...comment, commentId: randomUUID(), body: '第二条' }
    const confirmed = { ...comment, status: 'confirmed', finalRule: '人工作业规则', reviewedRevisionId: publishedId }
    assert.deepEqual(state.mergeComments([comment], [confirmed, second]), [confirmed, second])
    assert.equal(comment.status, 'open')
    const updated = { ...summary, title: '当前标题', revision: 3 }
    const other = { ...summary, creationId: randomUUID() }
    assert.deepEqual(state.mergeSummaries([summary], [updated, other]), [updated, other])
    assert.equal(summary.title, '草稿')
  })
  check('UTF-8 byte limits and required scenario fields enforce the save boundary', () => {
    const bound = schemas.CREATION_MAX_BODY_BYTES
    const body = '界'.repeat(Math.floor(bound / 3)) + 'a'.repeat(bound % 3)
    assert.equal(state.validateDraft({ title: '正文', body, scenarios: [] }), null)
    assert.match(state.validateDraft({ title: '正文', body: body + 'a', scenarios: [] }), /256 KiB/)
    assert.equal(state.validateDraft({ ...draft, scenarios: [{ ...scenario, preconditions: ['', '  '] }] }), null)
    for (const patch of [{ title: ' ' }, { title: 'a'.repeat(201) }, { scenarios: [{ ...scenario, steps: [] }] }, { scenarios: [{ ...scenario, expectedResult: '' }] }, { scenarios: Array.from({ length: 41 }, () => scenario) }]) assert.ok(state.validateDraft({ ...draft, ...patch }))
  })
  return checks
}

try {
  ownedDirectory()
  await build({
    stdin: { contents: "export * from './src/renderer/src/creations/creation-state'; export { creationSummarySchema, creationViewSchema, creationCommentSchema, CREATION_MAX_BODY_BYTES } from './src/shared/creations'", resolveDir: repo, loader: 'ts' },
    outfile: join(directory, 'creation-state.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', tsconfig: join(repo, 'tsconfig.web.json'), logLevel: 'silent'
  })
  const state = require(join(directory, 'creation-state.cjs'))
  const pureChecks = checkCreationState(state, state)
  if (!unitOnly) {
    const [{ createServer }, { default: react }] = await Promise.all([import('vite'), import('@vitejs/plugin-react')])
    const browserRoot = repo.replaceAll('\\', '/')
    writeFileSync(join(directory, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${browserRoot}/scripts/smoke/fixtures/creation-workspace-ui.jsx"></script></body></html>`)
    server = await createServer({
      root: directory, configFile: false, cacheDir: join(directory, '.vite'), logLevel: 'error', plugins: [react()],
      resolve: { alias: [{ find: '@shared', replacement: join(repo, 'src/shared') }, { find: 'react-dom', replacement: join(repo, 'node_modules/react-dom') }, { find: 'react', replacement: join(repo, 'node_modules/react') }] },
      css: { postcss: repo }, server: { host: '127.0.0.1', port: 0, fs: { allow: [directory, repo] } }
    })
    await server.listen()
    const address = server.httpServer.address()
    assert.ok(address && typeof address !== 'string')
    const env = { ...process.env, CREATION_WORKSPACE_FIXTURE: directory, CREATION_WORKSPACE_URL: `http://127.0.0.1:${address.port}`, HIFOX_STORE_DIR: join(directory, 'unused-hifox-store') }
    delete env.ELECTRON_RUN_AS_NODE
    await new Promise((done, reject) => {
      const child = spawn(require('electron'), [join(repo, 'scripts/smoke/fixtures/creation-workspace-host.cjs'), '--no-sandbox'], { env, cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Creation workspace component check exceeded 120 seconds')) }, 120_000)
      let stdout = '', stderr = ''
      child.stdout.on('data', (bytes) => { stdout += String(bytes); process.stdout.write(bytes) })
      child.stderr.on('data', (bytes) => { stderr += String(bytes) })
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code) => {
        clearTimeout(timeout)
        if (code === 0 && stdout.includes('CREATION_WORKSPACE_UI_PASSED')) done()
        else reject(new Error(`Creation workspace component check exited ${code}\n${stderr}`))
      })
    })
  }
  completed = true
  console.log(`Creation workspace smoke passed: ${pureChecks} pure state checks${unitOnly ? '' : ', 11 component regression groups'}.`)
} finally {
  await server?.close()
  if (completed && !keepTemp) rmSync(ownedDirectory(), { recursive: true, force: true })
  else console.log(`Creation workspace fixture/evidence: ${directory}`)
}
