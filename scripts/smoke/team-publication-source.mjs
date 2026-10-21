/** Actual selected-material registry/store and strict resolver; application/native boundary is explicit. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-selected-publication-')))
const root = join(temporary, 'project'), otherRoot = join(temporary, 'other-project')
const relativePath = '.trellis/tasks/selected/prd.md', originalText = '\ufeff# Selected A\n\nOriginal exact requirement 🙂.\n'
const digest = (value) => createHash('sha256').update(value).digest('hex')
const state = globalThis.__SELECTED_PUBLICATION__ = { calls: [], material: null, run: { runId: 'owned-run', revision: 1 }, recovery: { runId: 'owned-retained-run', revision: 3 } }
const results = [], check = async (name, action) => { await action(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`) }
const bundle = join(temporary, 'selected.mjs')
const appFixture = `const r=globalThis.__SELECTED_PUBLICATION__;
export async function getWorkflowApplication(root){r.calls.push({kind:'application',root});return{
readArtifact:async input=>{r.calls.push({kind:'task-run',input});if(Object.keys(input).sort().join(',')!=='ref,run,taskDir'||input.taskDir!=='selected'||input.ref!==r.material.ref||JSON.stringify(input.run)!==JSON.stringify(r.run))throw Object.assign(Error('fixture exact task/run membership rejected'),{code:'NOT_FOUND'});return r.material},
readRecoveryArtifact:async input=>{r.calls.push({kind:'workspace-recovery',input});if(Object.keys(input).sort().join(',')!=='ref,run'||input.ref!==r.material.ref||JSON.stringify(input.run)!==JSON.stringify(r.recovery))throw Object.assign(Error('fixture exact retained run rejected'),{code:'NOT_FOUND'});return r.material}}}`
let api, passed = false
try {
  for (const project of [root, otherRoot]) {
    mkdirSync(join(project, '.trellis/tasks/selected'), { recursive: true })
    writeFileSync(join(project, '.trellis/tasks/selected/task.json'), JSON.stringify({ id: 'original-selected-task', title: 'Owned selection fixture' }))
    writeFileSync(join(project, relativePath), originalText)
  }
  await build({ stdin: { contents: "export * from './src/main/services/document-views';export * from './src/main/services/team-publication-source';export {WorkflowMaterialStore} from './src/main/services/workflow-runtime/materials';export {invalidateDocument,computeRevision} from './src/main/services/documents/controller';", resolveDir: process.cwd(), loader: 'ts' }, outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" }, plugins: [{ name: 'explicit-selected-application-boundary', setup(builder) { builder.onResolve({ filter: /^\.\/workflow-desktop$/ }, () => ({ path: 'workflow-desktop', namespace: 'selected-fixture' })); builder.onLoad({ filter: /.*/, namespace: 'selected-fixture' }, () => ({ contents: appFixture, loader: 'js' })) } }] })
  api = await import(pathToFileURL(bundle).href)
  const authority = { projectRoot: root, generation: 1 }
  const reader = api.configureDocumentViews(() => authority)
  const captured = await reader.capturePath(root, relativePath)
  assert.equal(captured.ok, true)
  const token = captured.version.token
  const recordPath = join(root, '.trellis/.panel/runtime/reader-versions', token + '.json')
  const originalRecord = JSON.parse(readFileSync(recordPath, 'utf8'))
  const cold = () => new api.DocumentViewService(() => authority)
  await check('registered selection publishes original full BOM bytes, owner/ref/digest and unchanged reader presentation', async () => {
    const selected = await reader.selectedMaterial(root, token)
    state.material = selected
    assert.equal(selected.text, originalText)
    assert.equal(selected.bodyDigest, digest(Buffer.from(originalText)))
    assert.equal(selected.byteLength, Buffer.byteLength(originalText))
    assert.deepEqual(selected.owner, originalRecord.owner)
    assert.equal(selected.ref, originalRecord.materialRef)
    assert.equal(selected.material.source.relativePath, relativePath)
    const presentation = await reader.readFixed(root, token, { workspaceId: 'presentation-only', taskRef: 'presentation-only' })
    assert.equal(presentation.rawText, originalText.slice(1))
    assert.equal(presentation.fixedVersion.digest, selected.bodyDigest)
    assert.equal(JSON.stringify(originalRecord).includes('Original exact requirement'), false)
  })
  await check('canonical caller can resolve an original registered short-path spelling without rewriting its rd token or owner', async () => {
    const originalSpelling=join(tmpdir(),basename(temporary),'project')
    assert.equal(realpathSync.native(originalSpelling),root)
    const originalReader=new api.DocumentViewService(()=>({projectRoot:originalSpelling,generation:1}))
    const capturedOriginal=await originalReader.capturePath(originalSpelling,relativePath)
    assert.equal(capturedOriginal.ok,true)
    const originallySelected=await originalReader.selectedMaterial(originalSpelling,capturedOriginal.version.token)
    const canonicalSelected=await cold().selectedMaterial(root,capturedOriginal.version.token)
    assert.equal(canonicalSelected.ref,originallySelected.ref)
    assert.deepEqual(canonicalSelected.owner,originallySelected.owner)
    assert.equal(canonicalSelected.text,originalText)
    assert.equal((await cold().readFixed(root,capturedOriginal.version.token,{workspaceId:'canonical-presentation'})).fixedVersion.token,capturedOriginal.version.token)
  })
  await check('changed task identity and live disk B cannot replace selected A or its original owner', async () => {
    writeFileSync(join(root, '.trellis/tasks/selected/task.json'), JSON.stringify({ id: 'replacement-task', title: 'Different same-name task' }))
    writeFileSync(join(root, relativePath), '# Live B\nA different task and body.\n')
    api.invalidateDocument(join(root, relativePath))
    const b = await reader.capturePath(root, relativePath); assert.equal(b.ok, true)
    const newOwner = await reader.selectedMaterial(root, b.version.token)
    assert.notEqual(newOwner.owner.taskRef, state.material.owner.taskRef)
    const original = await cold().selectedMaterial(root, token)
    assert.equal(original.text, originalText)
    assert.deepEqual(original.owner, state.material.owner)
    assert.equal(original.ref, state.material.ref)
  })
  await check('source deletion and service reopen retain exact original bytes without a current-file fallback', async () => {
    unlinkSync(join(root, relativePath)); unlinkSync(join(root, '.trellis/tasks/selected/task.json'))
    const reopened = await cold().selectedMaterial(root, token)
    assert.equal(reopened.text, originalText)
    assert.deepEqual(reopened.owner, state.material.owner)
    authority.projectRoot = otherRoot; authority.generation++
    assert.equal((await cold().selectedMaterial(root, token)).ref, state.material.ref, 'Explicit retained source is not retargeted by authority changes; IPC grants are separate')
    authority.projectRoot = root; authority.generation++
  })
  await check('a replaced current owner resolver cannot retarget the original registered reader or publication', async () => {
    let calls = 0
    reader.setAdapters({ resolveOwner: () => { calls++; throw Error('Current application owner must not be consulted for a fixed selection') } })
    try {
      const selected = await reader.selectedMaterial(root, token)
      assert.deepEqual(selected.owner, state.material.owner)
      assert.equal(selected.ref, state.material.ref)
      assert.equal(selected.text, originalText)
      const displayed = await reader.readFixed(root, token, { workspaceId: 'unrelated-presentation', taskRef: 'unrelated-task-cache' })
      assert.equal(displayed.rawText, originalText.slice(1))
      assert.equal(displayed.fixedVersion.token, token)
      assert.equal(calls, 0)
    } finally { reader.setAdapters({}) }
  })
  await check('foreign project, copied foreign record and malformed token cannot resolve the registered source', async () => {
    await assert.rejects(cold().selectedMaterial(otherRoot, token))
    const copied = join(otherRoot, '.trellis/.panel/runtime/reader-versions', token + '.json')
    mkdirSync(dirname(copied), { recursive: true }); writeFileSync(copied, JSON.stringify(originalRecord))
    await assert.rejects(cold().selectedMaterial(otherRoot, token))
    await assert.rejects(cold().selectedMaterial(root, 'rd-not-a-fixed-token'))
  })
  await check('cold metadata rejects altered owner, ref, path, kind, digest, byte count and revision', async () => {
    const mutations = [
      { ...originalRecord, owner: { ...originalRecord.owner, taskRef: 'another-task' } },
      { ...originalRecord, materialRef: 'wm-' + 'f'.repeat(64) },
      { ...originalRecord, version: { ...originalRecord.version, relativePath: '.trellis/tasks/selected/design.md' }, source: { ...originalRecord.source, relativePath: '.trellis/tasks/selected/design.md', canonicalPath: join(root, '.trellis/tasks/selected/design.md') } },
      { ...originalRecord, source: { ...originalRecord.source, canonicalPath: join(otherRoot, 'foreign.md') } },
      { ...originalRecord, version: { ...originalRecord.version, kind: 'design' } },
      { ...originalRecord, version: { ...originalRecord.version, digest: '0'.repeat(64) } },
      { ...originalRecord, source: { ...originalRecord.source, sizeBytes: originalRecord.source.sizeBytes + 1 } },
      { ...originalRecord, version: { ...originalRecord.version, revision: 'different-version' } }
    ]
    try { for (const changed of mutations) { writeFileSync(recordPath, JSON.stringify(changed)); await assert.rejects(cold().selectedMaterial(root, token)) } }
    finally { writeFileSync(recordPath, JSON.stringify(originalRecord)) }
    assert.equal((await cold().selectedMaterial(root, token)).text, originalText)
  })
  const storeDirectory = join(root, '.trellis/.panel/runtime/workflow-materials')
  const blob = join(storeDirectory, 'blobs', state.material.bodyDigest + '.blob')
  const metadata = join(storeDirectory, 'refs', state.material.ref + '.json')
  await check('missing or corrupt immutable bytes never substitute a recreated live source', async () => {
    const bytes = readFileSync(blob)
    writeFileSync(join(root, relativePath), '# Current file must never substitute missing immutable A\n')
    try {
      writeFileSync(blob, Buffer.alloc(bytes.length, 65)); await assert.rejects(cold().selectedMaterial(root, token)); await assert.rejects(reader.selectedMaterial(root, token)); await assert.rejects(reader.readFixed(root, token, { workspaceId: 'existing-view' }))
      unlinkSync(blob); await assert.rejects(cold().selectedMaterial(root, token)); await assert.rejects(reader.selectedMaterial(root, token))
    } finally { writeFileSync(blob, bytes) }
    assert.equal((await cold().selectedMaterial(root, token)).text, originalText)
  })
  await check('material-store metadata integrity remains required by publication', async () => {
    const body = readFileSync(metadata), changed = JSON.parse(body.toString('utf8'))
    try { writeFileSync(metadata, JSON.stringify({ ...changed, owner: { ...changed.owner, workspaceId: 'different-workspace' } })); await assert.rejects(cold().selectedMaterial(root, token)) }
    finally { writeFileSync(metadata, body) }
  })
  await check('unsupported published source cannot be registered or disguised as a local fixed material', async () => {
    const store = new api.WorkflowMaterialStore({ directory: storeDirectory })
    const published = await store.captureText({ owner: state.material.owner, source: { kind: 'published', publicationId: 'owned-publication' }, kind: 'other', text: 'An unsupported remote source' })
    await assert.rejects(reader.registerMaterial(root, published), /尚未接入/)
    const normal = process.platform === 'win32' ? realpathSync.native(root).toLowerCase() : realpathSync.native(root)
    const forgedToken = 'rd-' + digest(JSON.stringify([normal, published.ref]))
    const forged = { ...originalRecord, materialRef: published.ref, version: { ...originalRecord.version, token: forgedToken, kind: published.material.kind, digest: published.bodyDigest, revision: api.computeRevision(Buffer.from(published.text)) }, source: { ...originalRecord.source, sizeBytes: published.byteLength } }
    writeFileSync(join(dirname(recordPath), forgedToken + '.json'), JSON.stringify(forged))
    await assert.rejects(cold().selectedMaterial(root, forgedToken))
  })
  await check('fixed-source resolver reads actual registry A without opening a workflow application', async () => {
    const count = state.calls.length
    const material = await api.resolveTeamPublicationSource(root, { kind: 'fixed-document', token })
    assert.equal(material.text, originalText); assert.equal(material.ref, state.material.ref)
    assert.equal(state.calls.length, count)
    await assert.rejects(api.resolveTeamPublicationSource(root, { kind: 'fixed-document', token, text: 'renderer old text' }))
    await assert.rejects(api.resolveTeamPublicationSource(root, { kind: 'fixed-document', token, scope: state.material.owner }))
    assert.equal(state.calls.length, count)
  })
  await check('run resolver preserves strict original task/run/ref and rejects fixture foreign membership', async () => {
    const input = { kind: 'task-run', taskDir: 'selected', run: state.run, ref: state.material.ref }
    assert.equal((await api.resolveTeamPublicationSource(root, input)).ref, state.material.ref)
    assert.deepEqual(state.calls.at(-1).input, { taskDir: input.taskDir, run: input.run, ref: input.ref })
    await assert.rejects(api.resolveTeamPublicationSource(root, { ...input, run: { runId: 'foreign-run', revision: 1 } }), (error) => error.code === 'NOT_FOUND')
    await assert.rejects(api.resolveTeamPublicationSource(root, { ...input, text: originalText }))
  })
  await check('recovery resolver forwards only the exact original run/ref without a guessed task', async () => {
    const input = { kind: 'workspace-recovery', run: state.recovery, ref: state.material.ref }
    assert.equal((await api.resolveTeamPublicationSource(root, input)).ref, state.material.ref)
    assert.deepEqual(state.calls.at(-1).input, { run: state.recovery, ref: state.material.ref })
    await assert.rejects(api.resolveTeamPublicationSource(root, { ...input, run: state.run }), (error) => error.code === 'NOT_FOUND')
    await assert.rejects(api.resolveTeamPublicationSource(root, { ...input, taskDir: 'replacement-task' }))
  })
  await check('an unavailable fixed registry rejects explicitly without opening native/application fallback', async () => {
    const isolated = await import(pathToFileURL(bundle).href + '?empty-reader=' + randomUUID())
    const count = state.calls.length
    await assert.rejects(isolated.resolveTeamPublicationSource(root, { kind: 'fixed-document', token }), (error) => error.code === 'SOURCE_UNSUPPORTED')
    assert.equal(state.calls.length, count)
  })
  const report = { status: 'passed', groups: results.length, scope: 'Actual DocumentViewService/immutable store and source resolver; native/application membership boundary explicitly owned fixture, not server authorization or UI/native acceptance', results }
  const index = process.argv.indexOf('--report')
  if (index >= 0) { const path = resolve(process.argv[index + 1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + '\n') }
  passed = true
  console.log(`Selected publication source: ${results.length} groups passed`)
} finally {
  if (passed) {
    assert.equal(dirname(realpathSync.native(temporary)), realpathSync.native(tmpdir()))
    assert.ok(basename(temporary).startsWith('trellis-selected-publication-'))
    rmSync(temporary, { recursive: true, force: true })
  } else console.error(`Owned failed fixture retained: ${temporary}`)
  delete globalThis.__SELECTED_PUBLICATION__
}
