/** Real reader/material/worker integration; no native OS acceptance is inferred. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, unlinkSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tpanel-reading-windows-')))
const root = join(directory, 'project'), otherRoot = join(directory, 'other')
const task = '.trellis/tasks/demo', path = `${task}/prd.md`
mkdirSync(join(root, task), { recursive: true }); mkdirSync(otherRoot)
writeFileSync(join(root, task, 'task.json'), JSON.stringify({ id: 'stable-task', title: 'reader test' }))
const abs = (file) => resolve(file).replace(/\\/g, '/')
const entry = join(directory, 'entry.ts'), bundle = join(directory, 'bundle.mjs'), worker = join(directory, 'diff-worker.cjs')
writeFileSync(entry, [
  `export * from '${abs('src/main/services/document-views.ts')}'`,
  `export * from '${abs('src/main/services/document-window-placement.ts')}'`,
  `export * from '${abs('src/main/services/documents/index.ts')}'`,
  `export { WorkflowMaterialStore } from '${abs('src/main/services/workflow-runtime/materials.ts')}'`
].join('\n'))
let checks = 0, m
const check = (name, condition) => { assert.ok(condition, name); console.log(`PASS ${name}`); checks++ }
try {
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } })
  await build({ entryPoints: ['src/main/services/documents/diff-worker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  process.env.TRELLIS_DIFF_WORKER_FILE = worker
  m = await import(pathToFileURL(bundle).href)
  const authority = { projectRoot: root, generation: 1 }
  const service = new m.DocumentViewService(() => authority)
  const scope = { workspaceId: 'untrusted-presentation-namespace', taskRef: 'foreign-cache-key' }
  const read = async (file = path) => { const result = await m.readDocument(root, scope, { relativePath: file, requestId: crypto.randomUUID() }); assert.equal(result.ok, true); return service.captureRead(root, result) }
  writeFileSync(join(root, path), '\uFEFF# Original A\r\n\r\nOld selected text.\r\n')
  const a = await read()
  check('main verified BOM/CRLF read gets a fixed immutable version', Boolean(a.fixedVersion) && a.rawText.includes('\r\n'))
  const aToken = a.fixedVersion.token
  const owner = m.readerMaterialOwner(root, path)
  check('actual root/task resolve owner; renderer cache namespaces are not identity', owner.workspaceId !== scope.workspaceId && owner.taskRef !== scope.taskRef && owner.taskRef !== null)
  const metadataPath = join(root, '.trellis/.panel/runtime/reader-versions', `${aToken}.json`)
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  check('metadata stores a material reference and no duplicate body', metadata.materialRef.startsWith('wm-') && metadata.owner.taskRef === owner.taskRef && !JSON.stringify(metadata).includes('Old selected text.'))
  try {
    writeFileSync(metadataPath,JSON.stringify({...metadata,version:{...metadata.version,kind:'design'}}))
    await assert.rejects(()=>new m.DocumentViewService(()=>authority).readFixed(root,aToken,scope))
    checks++;console.log('PASS tampered fixed metadata kind cannot change the immutable source descriptor')
    writeFileSync(metadataPath,JSON.stringify({...metadata,source:{...metadata.source,canonicalPath:join(otherRoot,'foreign.md')}}))
    await assert.rejects(()=>new m.DocumentViewService(()=>authority).readFixed(root,aToken,scope))
    checks++;console.log('PASS tampered historical canonical source outside root is rejected before content return')
  } finally { writeFileSync(metadataPath,JSON.stringify(metadata)) }
  const recordsDir=dirname(metadataPath),recordsBackup=recordsDir+'-owned-review-backup'
  assert.ok([recordsDir,recordsBackup].every(p=>resolve(p).startsWith(resolve(directory)+sep)))
  renameSync(recordsDir,recordsBackup)
  try {
    symlinkSync(otherRoot,recordsDir,process.platform==='win32'?'junction':'dir')
    await assert.rejects(()=>new m.DocumentViewService(()=>authority).readFixed(root,aToken,scope))
    checks++;console.log('PASS fixed metadata directory junction cannot redirect an uncached version read')
  } finally { if(existsSync(recordsDir))unlinkSync(recordsDir);renameSync(recordsBackup,recordsDir) }
  writeFileSync(join(root, path), '# New B\n\nChanged by agent.\n'); m.invalidateDocument(join(root, path))
  const b = await read()
  check('new read captures B without altering A token', Boolean(b.fixedVersion) && b.fixedVersion.token !== aToken)
  const fixed = await service.readFixed(root, aToken, { workspaceId: 'native-view' })
  check('opening displayed A after disk B resolves exact A bytes', fixed.rawText === a.rawText && fixed.source.workspaceId === 'native-view' && fixed.fixedVersion.digest === a.fixedVersion.digest)
  const restart = new m.DocumentViewService(() => authority)
  check('fixed A survives service restart through immutable store metadata', (await restart.readFixed(root, aToken, scope)).rawText === a.rawText)
  await assert.rejects(() => restart.readFixed(otherRoot, aToken, scope)); checks++; console.log('PASS token cannot resolve in another project')
  const first = service.createView(root, aToken, { sessionId: 'original-session', taskDir: 'demo' })
  const second = service.createView(root, b.fixedVersion.token, null)
  service.attachView(first.id, 101); service.attachView(second.id, 102)
  const bootA = await service.bootstrap(101, true), bootB = await service.bootstrap(102, false)
  check('independent native view bootstrap retains exact source, version, pin and origin', bootA.ok && bootB.ok && bootA.document.rawText === a.rawText && bootB.document.rawText === b.rawText && bootA.origin.sessionId === 'original-session' && bootA.pinned && !bootB.pinned && bootA.document.source.workspaceId !== bootB.document.source.workspaceId)
  service.closeView(first.id)
  check('closing one native view leaves other owner available', !(await service.bootstrap(101, false)).ok && (await service.bootstrap(102, false)).ok)
  authority.projectRoot = otherRoot; authority.generation++
  const retained = await service.bootstrap(102, true)
  check('project switch retains original fixed bytes and marks live source inactive', retained.ok && !retained.sourceActive && retained.document.rawText === b.rawText && service.rootForSender(102) === root)
  const blocked = await service.capturePath(root, path)
  check('old pinned window cannot read another project current file', !blocked.ok && blocked.code === 'E_CONFLICT')
  unlinkSync(join(root, path))
  const comparison = await service.compare(root, { left: aToken, right: b.fixedVersion.token, requestId: 'selected-versions' })
  check('bounded real worker compares two selected immutable versions after source deletion', comparison.outcome.ok && comparison.outcome.diff !== null && !comparison.outcome.diff.identical && comparison.left.token === aToken && comparison.right.token === b.fixedVersion.token)
  authority.projectRoot = root; authority.generation++
  const designPath = `${task}/design.md`; writeFileSync(join(root, designPath), '# Design\nArchitecture\n')
  const design = await read(designPath)
  const pair = await service.compare(root, { left: b.fixedVersion.token, right: design.fixedVersion.token, requestId: 'cross-material' })
  check('PRD and design compare with distinct explicit material identities', pair.left.kind === 'trellis-prd' && pair.right.kind === 'design' && pair.outcome.ok && pair.outcome.diff !== null)
  const catalog = await service.catalog(root, aToken)
  check('catalog keeps source versions separate and suggests principal task documents', catalog.versions.length === 3 && catalog.candidates.length === 3 && catalog.candidates.some((x) => x.relativePath === designPath))
  const specPath = '.trellis/spec/reader.md'; mkdirSync(dirname(join(root, specPath)), { recursive: true }); writeFileSync(join(root, specPath), '# Spec\n')
  const spec = await read(specPath)
  check('project-level spec snapshot has nullable taskRef with no invented task/run', spec.fixedVersion?.kind === 'spec' && m.readerMaterialOwner(root, specPath).taskRef === null)
  const missing = await service.capturePath(root, `${task}/missing.md`)
  check('missing material reports failure rather than an empty fixed success', !missing.ok)
  const traversal = await service.capturePath(root, '../outside.md')
  check('current material capture rejects path escape', !traversal.ok)
  const linked = join(root, 'linked')
  symlinkSync(otherRoot, linked, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(otherRoot, 'external.md'), 'foreign body')
  check('main read rejects symlink/junction escape', !(await service.capturePath(root, 'linked/external.md')).ok)
  const customStore = new m.WorkflowMaterialStore({ directory: join(directory, 'shared-materials') })
  const actualOwner = { projectId: 'actual-project', repositoryId: 'actual-repository', workspaceId: 'actual-workspace', taskRef: null }
  const adapted = new m.DocumentViewService(() => authority, { resolveOwner: () => actualOwner, storeForRoot: () => customStore })
  const originalSpec = await m.readDocument(root, scope, { relativePath: specPath, requestId: 'main-source-adapter' })
  const adaptedRead = await adapted.captureRead(root, originalSpec)
  const adaptedMetadata = JSON.parse(readFileSync(join(root, '.trellis/.panel/runtime/reader-versions', `${adaptedRead.fixedVersion.token}.json`), 'utf8'))
  check('injected workflow owner/store replace private fallback without trusting renderer namespaces', adaptedMetadata.owner.projectId === 'actual-project' && (await customStore.readVersion(actualOwner, adaptedMetadata.materialRef)).text === originalSpec.rawText)
  const storedA = await customStore.readVersion(actualOwner, adaptedMetadata.materialRef)
  writeFileSync(join(root, specPath), '# Spec B after workflow capture\n')
  const registered = await adapted.registerMaterial(root, storedA)
  check('trusted workflow graph artifact registers exact stored A after source B without rereading disk', registered.token === adaptedRead.fixedVersion.token && (await adapted.readFixed(root, registered.token, scope)).rawText === originalSpec.rawText)
  await assert.rejects(() => adapted.registerMaterial(root, { ...storedA, bodyDigest: '0'.repeat(64) })); checks++; console.log('PASS graph adapter rejects inconsistent material digest')
  const tiny = new m.DocumentViewService(() => authority, { storeForRoot: () => new m.WorkflowMaterialStore({ directory: join(directory, 'tiny-store'), maxSourceBytes: 1 }) })
  const failedSnapshot = await tiny.captureRead(root, originalSpec)
  check('snapshot quota failure preserves readable body and exposes honest unavailable capability', failedSnapshot.rawText === originalSpec.rawText && !failedSnapshot.fixedVersion && Boolean(failedSnapshot.fixedVersionError))
  const screen = { x: -1920, y: -300, width: 1920, height: 1080 }
  const bounds = m.readerWindowBounds(screen, { x: -1800, y: -250, width: 1400, height: 900 })
  check('secondary negative-coordinate display uses DIP bounds', bounds.x < 0 && bounds.y >= -292 && bounds.width === 1000 && bounds.x + bounds.width <= -8)
  const restored = m.readerWindowBounds({ x: 0, y: 0, width: 800, height: 600 }, bounds, { x: -2000, y: -900, width: 2000, height: 1800 })
  check('display removal/resize clamps retained geometry into available work area', restored.x === 8 && restored.y === 8 && restored.width === 784 && restored.height === 584)
  console.log(`Reading windows integration: ${checks} checks passed; native OS gates not exercised`)
} finally {
  m?.stopDiffWorker()
  rmSync(directory, { recursive: true, force: true })
}
