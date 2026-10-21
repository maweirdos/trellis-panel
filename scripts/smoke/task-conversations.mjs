/** Real source adapters + isolated control.sqlite; launch ports record arguments only. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createFixture, database } from './fixtures/task-conversations-data.mjs'
import { exercise } from './fixtures/task-conversations-scenarios.mjs'
import { exerciseIntegrity } from './fixtures/task-conversations-integrity.mjs'
import { exercisePackageCache, exercisePackageBroker } from './fixtures/task-conversations-package-cache.mjs'
import { exerciseCodexRoles } from './fixtures/task-conversations-codex-roles.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const directory = mkdtempSync(join(tmpdir(), 'trellis-task-conversations-'))
try {
  const bundle = join(directory, 'service.cjs')
  await build({ entryPoints: ['src/main/services/task-conversations/index.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const { TaskConversationsService: Service } = createRequire(import.meta.url)(bundle)
  const windowsBundle = join(directory, 'windows.cjs')
  await build({ entryPoints: ['src/main/services/task-conversations/lib/windows-launch.ts'], outfile: windowsBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const { claudeTerminalInvocation } = createRequire(import.meta.url)(windowsBundle)
  const packageBundle = join(directory, 'codex-package.cjs')
  await build({ entryPoints: ['src/main/services/task-conversations/lib/codex-package.ts'], outfile: packageBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const { codexPackageProbeInvocation, codexPackageLaunchInvocation, CODEX_PACKAGE_FAMILY } = createRequire(import.meta.url)(packageBundle)
  const cacheBundle = join(directory, 'codex-package-cache.cjs')
  await build({ entryPoints: ['src/main/services/task-conversations/lib/codex-package-cache.ts'], outfile: cacheBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const brokerBundle = join(directory, 'codex-package-broker.cjs')
  await build({ entryPoints: ['src/main/services/task-conversations/lib/codex-package.ts'], outfile: brokerBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{
    name: 'record-native-package-exec', setup(builder) {
      builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'package-exec', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `import {promisify} from 'node:util';
        export const execFile=Object.assign(function(){throw Error('Use the injected async fixture')},{
          [promisify.custom]:async(file,args,options)=>globalThis.__taskConversationsPackageExecute(file,args,options)
        });` }))
    }
  }] })
  let checks = await exercise(Service, createFixture(join(directory, 'main')))
  checks += await exerciseIntegrity(Service, join(directory, 'integrity'))
  checks += await exerciseCodexRoles(Service, join(directory, 'codex-roles'))
  checks += await exercisePackageCache(createRequire(import.meta.url)(cacheBundle))
  checks += await exercisePackageBroker(createRequire(import.meta.url)(brokerBundle))
  const invocation = claudeTerminalInvocation({ kind: 'terminal', source: 'claude-code', executable: "C:\\Claude's app\\claude.exe", args: ['--resume', '11111111-2222-3333-4444-555555555555'], cwd: "D:\\工程 '$() ` workspace" })
  assert.deepEqual(invocation.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']); checks++
  const command = Buffer.from(invocation.args[4], 'base64').toString('utf16le')
  assert.equal(command, "$ErrorActionPreference='Stop'; Start-Process -FilePath 'C:\\Claude''s app\\claude.exe' -WorkingDirectory 'D:\\工程 ''$() ` workspace' -ArgumentList @('--resume','11111111-2222-3333-4444-555555555555') -WindowStyle Normal -PassThru | Out-Null"); checks++
  assert.throws(() => claudeTerminalInvocation({ kind: 'terminal', source: 'claude-code', executable: 'C:\\claude.exe', cwd: 'C:\\project', args: ['--resume', 'new; send prompt'] })); checks++
  const decodeInvocation = call => Buffer.from(call.args[4], 'base64').toString('utf16le')
  const packageProbe = decodeInvocation(codexPackageProbeInvocation())
  assert.ok(packageProbe.includes('::QueryUriSupportAsync(') && packageProbe.includes('Get-AuthenticodeSignature') && packageProbe.includes('Get-AppxPackage -Name OpenAI.Codex')); checks++
  assert.ok(!packageProbe.includes('::LaunchUriAsync(') && !packageProbe.includes('Start-Process') && !/Set-Item|New-Item/.test(packageProbe), 'capability probe cannot activate clients or write registration'); checks++
  const packageTarget = { kind: 'packaged-protocol', source: 'codex', cwd: 'C:\\project', packageFamilyName: CODEX_PACKAGE_FAMILY, url: 'codex://threads/11111111-2222-3333-4444-555555555555' }
  const packageLaunch = decodeInvocation(codexPackageLaunchInvocation(packageTarget))
  assert.ok(packageLaunch.includes("::LaunchUriAsync([Uri]'" + packageTarget.url + "',$taskOptions)")); checks++
  assert.ok(packageLaunch.includes("TargetApplicationPackageFamilyName='" + CODEX_PACKAGE_FAMILY + "'")); checks++
  assert.throws(() => codexPackageLaunchInvocation({ ...packageTarget, url: 'codex://threads/new' })); checks++
  assert.throws(() => codexPackageLaunchInvocation({ ...packageTarget, url: packageTarget.url + '?prompt=send' })); checks++
  assert.throws(() => codexPackageLaunchInvocation({ ...packageTarget, packageFamilyName: 'arbitrary.package' })); checks++
  const f = createFixture(join(directory, 'edge'))
  const service = new Service(f.options)
  try {
    const candidates = await service.discover(f.root)
    const candidate = candidates.items.find(item => item.source === 'codex')
    const snapshot = await service.bind(f.root, 'task-a', candidate.id)
    const binding = snapshot.bindings[0]
    const { DatabaseSync } = await import('node:sqlite')
    const lock = new DatabaseSync(f.codexFile)
    lock.exec('BEGIN EXCLUSIVE')
    const before = Date.now()
    const busy = await service.discover(f.root)
    assert.ok(Date.now() - before < 1000, 'native lock wait is bounded'); checks++
    assert.equal(busy.sources.find(source => source.source === 'codex').available, false); checks++
    assert.ok(busy.sources.find(source => source.source === 'claude-code').available); checks++
    lock.exec('ROLLBACK'); lock.close()
    database(f.codexFile, null, db => db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(f.foreign, candidate.sessionId))
    await assert.rejects(() => service.open(f.root, 'task-a', binding.id), error => error.code === 'E_NOT_FOUND'); checks++
    assert.equal(f.calls.length, 0); checks++
    // A filename cannot confer history identity or ownership.
    appendFileSync(f.claudeFile, JSON.stringify({ type: 'system', sessionId: f.claudeId, cwd: f.foreign }) + '\n')
    assert.ok(!(await service.discover(f.root)).items.some(item => item.source === 'claude-code')); checks++
    const file = join(f.roots.codex, 'state_6.sqlite')
    database(file, 'CREATE TABLE threads(unsupported TEXT)')
    const schema = await service.discover(f.root)
    assert.ok(!schema.sources.find(source => source.source === 'codex').available); checks++
    assert.ok(schema.sources.find(source => source.source === 'zcode').available); checks++
    // Schema detection supports a genuine millisecond-only index without guessing seconds.
    database(file, 'DROP TABLE threads; CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,title TEXT,updated_at_ms INTEGER)', db => {
      db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(f.codexId, f.root, 'Milliseconds schema', 1800000000123)
    })
    assert.equal((await service.discover(f.root)).items.find(item => item.sessionId === f.codexId).updatedAt, 1800000000123); checks++
    const empty = await service.discover(f.foreign)
    assert.ok(empty.sources.every(source => source.available)); checks++
    assert.equal(empty.items.filter(item => item.source === 'zcode').length, 0); checks++
  } finally { service.close() }
  const future = createFixture(join(directory, 'future'))
  const runtime = join(future.root, '.trellis', '.panel', 'runtime')
  mkdirSync(runtime, { recursive: true })
  const control = join(runtime, 'control.sqlite')
  database(control, "CREATE TABLE task_conversation_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO task_conversation_meta VALUES('schemaVersion','99')")
  const newer = new Service(future.options)
  await assert.rejects(() => newer.list(future.root), error => error.code === 'E_UNAVAILABLE'); checks++
  newer.close()
  database(control, null, db => { assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='task_conversation_links'").get(), undefined); checks++ })
  console.log(JSON.stringify({ ok: true, checks, scope: 'real source fixtures and control store; injected launch, no real apps opened' }))
  if (process.argv.includes('--local')) {
    const electron = createRequire(import.meta.url)('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    if (process.argv.includes('--cache-probe')) env.TASK_CONVERSATIONS_CACHE_DIAGNOSTIC = '1'
    const rootArgument = process.argv.find(arg => arg.startsWith('--local-root='))?.slice('--local-root='.length) || '.'
    const expectedSession = process.argv.find(arg => arg.startsWith('--expect-session='))?.slice('--expect-session='.length) || ''
    const result = await promisify(execFile)(electron, [resolve('scripts/smoke/fixtures/task-conversations-native-host.cjs'), bundle, resolve(rootArgument), expectedSession], {
      windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024,
      env
    })
    console.log(result.stdout.split('\n').filter(line => line.startsWith('TASK_CONVERSATIONS_NATIVE ')).join('\n'))
  }
} finally {
  const suffix = relative(tmpdir(), directory)
  if (!suffix || isAbsolute(suffix) || suffix.startsWith('..')) throw new Error('Unexpected fixture cleanup path')
  rmSync(directory, { recursive: true, force: true })
}
