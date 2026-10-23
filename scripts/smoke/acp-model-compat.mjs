/** Isolated metadata + actual app facade/public acpx. Never reads real configs or calls providers. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { checkAcpxCompatibility } from '../check-acpx-compat.mjs'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

await checkAcpxCompatibility()
const temporary = mkdtempSync(join(tmpdir(), 'trellis-model-compat-'))
const home = join(temporary, 'home'), root = join(temporary, 'workspace')
mkdirSync(root, { recursive: true })
mkdirSync(join(root, '.git'))
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
const statePath = join(home, '.cc-switch', 'live-state.json')
const catalogPath = join(home, '.codex', 'cc-switch-model-catalog.json')
const codexConfig = join(home, '.codex', 'config.toml')
const claudeConfig = join(home, '.claude', 'settings.json')
const codexIds = ['official/Case.[1M]', 'ccs-A/Shared.Model[1M]', 'ccs-B/Shared.Model[1M]']
const claudeIds = ['opus', 'ccs-claude-A--Shared.Model[1M]', 'ccs-claude-B--Shared.Model[1M]']
const app = (prefix) => ({ mode: 'proxy', attached: true, proxy_route: `${prefix}-route`, stack: { enabled: true, members: [`${prefix}-a`, `${prefix}-b`], keys: { A: `${prefix}-a`, B: `${prefix}-b` } } })
const originalState = { version: 1, apps: { codex: app('codex'), claude: app('claude') } }
const writeCatalog = (ids = codexIds) => write(catalogPath, { models: ids.map((slug) => ({ slug, display_name: 'Configured name' })) })
const resetFiles = () => {
  write(statePath, originalState)
  writeCatalog()
  write(codexConfig, 'model_catalog_json = "cc-switch-model-catalog.json"\nmodel = "official/Case.[1M]"\n')
  write(claudeConfig, { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: claudeIds[1], ANTHROPIC_DEFAULT_SONNET_MODEL: claudeIds[2], ANTHROPIC_AUTH_TOKEN: 'DO-NOT-PROJECT-SECRET' } })
}
resetFiles()
const env = [{ key: 'HOME', value: home }, { key: 'USERPROFILE', value: home }, { key: 'CODEX_HOME', value: join(home, '.codex') }, { key: 'CLAUDE_CONFIG_DIR', value: join(home, '.claude') }]
const options = (agentId, overrides = {}) => ({ agentId, launchKind: 'managed', cwd: root, env, ...overrides })
const meta = (ids, current = ids[0], generation = 'generation-1') => ({ sessionId: 'fixture', projectRoot: root, agentId: 'fixture', agentName: 'Fixture', status: 'ready', startedAt: 1, events: [], connectionGeneration: generation, currentModelId: current, models: ids.map((modelId) => ({ modelId, name: 'Shared' })) })
const wait = async (predicate, label) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { const result = predicate(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 20)) }
  throw new Error(`Timeout: ${label}`)
}
let acp
const previousData = process.env.TPAP_SMOKE_DIR
const previousWorker = process.env.TRELLIS_ACP_HISTORY_WORKER_FILE
try {
  await build({ entryPoints: ['src/main/services/acp/cc-switch-models.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(temporary, 'metadata.mjs') })
  const { ModelMetadataContext } = await import(pathToFileURL(join(temporary, 'metadata.mjs')).href)
  const codex = new ModelMetadataContext(options('codex')); codex.capture('generation-1')
  const value = meta(codexIds, 'removed/current')
  codex.project(value, true)
  assert.equal(value.currentModelId, 'removed/current'); assert.equal(value.modelCatalog.currentAvailable, false)
  assert.deepEqual(value.models.map(({ modelId }) => modelId), codexIds)
  assert.equal(value.modelCatalog.mappings[0].providerId, 'codex-a')
  assert.equal(value.modelCatalog.mappings[0].configuredModel, 'Shared.Model[1M]')
  const claude = new ModelMetadataContext(options('claude')); claude.capture('generation-1')
  const c = meta(claudeIds); claude.project(c, true)
  assert.equal(c.modelCatalog.mappings.find(({ modelId }) => modelId === claudeIds[1]).providerId, 'claude-a')
  assert.equal(c.modelCatalog.mappings.find(({ modelId }) => modelId === 'opus').configuredSelector, claudeIds[1])
  assert.equal(JSON.stringify(c).includes('DO-NOT-PROJECT-SECRET'), false)
  write(claudeConfig, { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: claudeIds[1], ANTHROPIC_DEFAULT_SONNET_MODEL: claudeIds[2], ANTHROPIC_AUTH_TOKEN: 'CHANGED-UNRELATED-SECRET' } })
  claude.project(c, true); assert.equal(c.modelCatalog.freshness, 'unchanged', 'Credential-only changes are not catalog revisions')
  const wrong = meta([codexIds[1]]); claude.project(wrong, true)
  assert.equal(wrong.modelCatalog.mappings, undefined, 'Wrong app aliases never acquire a provider')
  const zcode = new ModelMetadataContext(options('zcode')); zcode.capture('generation-1')
  const z = meta(['Provider-A/Same.Model[1M]', 'Provider-B/Same.Model[1M]'], 'Provider-X/Missing')
  zcode.project(z, true); assert.equal(z.modelCatalog.source, 'engine'); assert.equal(z.modelCatalog.mappings, undefined)
  assert.deepEqual(z.models.map(({ modelId }) => modelId), ['Provider-A/Same.Model[1M]', 'Provider-B/Same.Model[1M]'])
  console.log('PASS per-app aggregate provenance, exact case/punctuation/[1M], ZCode isolation and unavailable current ID')

  const otherState = structuredClone(originalState); otherState.apps.claude.stack.enabled = false; write(statePath, otherState)
  codex.project(value, true); assert.equal(value.modelCatalog.freshness, 'unchanged', 'Other app configuration cannot stale Codex')
  write(statePath, { ...otherState, apps: { ...otherState.apps, claude: { unsupported: 'other app schema' } } })
  codex.project(value, true); assert.equal(value.modelCatalog.freshness, 'unchanged', 'Other app schema cannot invalidate Codex metadata')
  writeCatalog([codexIds[0], codexIds[2]])
  codex.project(value, true); assert.equal(value.modelCatalog.freshness, 'changed'); assert.equal(value.modelCatalog.reloadRequired, true)
  assert.match(codex.selectionProblem(codexIds[1]), /目录/)
  assert.equal(value.currentModelId, 'removed/current'); assert.equal(value.models.length, 3)
  const drift = meta(codexIds, codexIds[1], 'generation-2'); codex.project(drift)
  assert.equal(drift.modelCatalog.freshness, 'unknown'); assert.equal(drift.modelCatalog.mappings, undefined)
  codex.capture('generation-2'); codex.project(drift); assert.equal(drift.modelCatalog.freshness, 'unchanged')
  const disabled = structuredClone(originalState); disabled.apps.codex.stack.enabled = false; write(statePath, disabled)
  codex.project(drift, true); assert.match(codex.selectionProblem(codexIds[2]), /不再匹配/)
  console.log('PASS semantic catalog revision/removal, mode incompatibility and generation fences; no silent current switch')

  resetFiles()
  for (const mode of ['direct', 'routing']) {
    const direct = structuredClone(originalState)
    direct.apps.codex.stack.enabled = false
    if (mode === 'direct') { direct.apps.codex.mode = 'direct'; direct.apps.codex.attached = false }
    write(statePath, direct)
    const context = new ModelMetadataContext(options('codex')); context.capture('generation-1')
    const m = meta([codexIds[0]]); context.project(m, true)
    assert.equal(m.modelCatalog.provenance.transportMode, mode === 'direct' ? 'direct' : 'proxy')
    assert.equal(m.modelCatalog.mappings, undefined, 'Unprefixed selector is not an asserted upstream')
    assert.equal(m.currentModelId, codexIds[0])
  }
  resetFiles()
  const override = new ModelMetadataContext(options('claude', { env: [...env, { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: claudeIds[2] }, { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: claudeIds[2] }] }))
  override.capture('generation-1'); const role = meta(claudeIds); override.project(role)
  assert.deepEqual(role.modelCatalog.mappings.map(({ configuredSelector }) => configuredSelector), [claudeIds[2], claudeIds[2]], 'Role env overlay wins over settings slots')
  for (const input of [options('codex', { launchKind: 'custom' }), options('codex', { args: [{ name: '--config', value: 'model=other' }] })]) {
    const context = new ModelMetadataContext(input); context.capture('generation-1'); const m = meta(codexIds); context.project(m)
    assert.equal(m.modelCatalog.freshness, 'unknown'); assert.equal(m.modelCatalog.mappings, undefined)
  }
  write(statePath, { ...originalState, version: 99 })
  const unknown = new ModelMetadataContext(options('codex')); unknown.capture('generation-1'); const u = meta(codexIds); unknown.project(u)
  assert.equal(u.modelCatalog.issue, 'configuration-unknown'); assert.deepEqual(u.models, meta(codexIds).models)
  resetFiles(); write(codexConfig, 'model_catalog_json = ["unsupported"]\n')
  unknown.capture('generation-1'); unknown.project(u, true); assert.equal(u.modelCatalog.freshness, 'unknown')
  resetFiles(); write(join(home, '.codex', 'models_cache.json'), { models: [{ slug: 'UNRELATED-CACHE-MODEL' }] })
  const absent = new ModelMetadataContext(options('codex')); absent.capture('generation-1'); const a = meta([codexIds[0]]); absent.project(a)
  assert.equal(a.modelCatalog.issue, 'catalog-not-advertised'); assert.equal(a.models.length, 1)
  assert.equal(absent.selectionProblem('ccs-New/Advertised.Native[1M]'), undefined, 'Initial metadata disagreement must not override native advertised choices')
  console.log('PASS direct/routing fixtures, role environment, unknown version/config/CLI precedence, no cache union')

  for (const delimiter of ['"""', "'''"]) {
    resetFiles()
    write(codexConfig, `instructions = ${delimiter}\nmodel_catalog_json = "cc-switch-model-catalog.json"\n${delimiter}\nmodel = "official/Case.[1M]"\n`)
    const context = new ModelMetadataContext(options('codex')); context.capture('generation-1')
    const m = meta(codexIds); context.project(m, true)
    assert.equal(m.modelCatalog.freshness, 'unknown', 'TOML multiline string content is not root configuration')
    assert.equal(m.modelCatalog.mappings, undefined)
  }
  resetFiles()
  const sourceChange = new ModelMetadataContext(options('codex')); sourceChange.capture('generation-1')
  for (const reference of [undefined, 'other/cc-switch-model-catalog.json']) {
    if (reference) write(join(home, '.codex', reference), { models: [{ slug: codexIds[0] }] })
    write(codexConfig, `${reference ? `model_catalog_json = "${reference}"\n` : ''}model = "official/Case.[1M]"\n`)
    const m = meta(codexIds); sourceChange.project(m, true)
    assert.equal(m.modelCatalog.reloadRequired, true)
    assert.equal(sourceChange.selectionProblem(codexIds[1]), undefined, 'Changing a catalog source does not prove an advertised alias was removed')
    assert.deepEqual(m.models.map(({ modelId }) => modelId), codexIds)
  }
  resetFiles()
  console.log('PASS unsupported multiline TOML and changed catalog sources cannot overrule native candidates')

  await build({ stdin: { contents: "import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {SessionDetails} from './src/renderer/src/acp/SessionDetails'; export const render=(session)=>renderToStaticMarkup(createElement(SessionDetails,{session,isCurrent:()=>true,onUpdated:()=>{}}));", resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', outfile: join(temporary, 'details.mjs'),
    banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" },
    alias: { '@shared': resolve('src/shared') }, loader: { '.svg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'details-unused-boundaries', setup(builder) {
      builder.onResolve({ filter: /^\.\.\/api$|^\.\/RunActivity$/ }, ({ path }) => ({ path, namespace: 'details' }))
      builder.onLoad({ filter: /.*/, namespace: 'details' }, ({ path }) => ({ contents: path.endsWith('RunActivity') ? 'export const RunActivity=()=>null;' : 'export const api={};', loader: 'js' }))
    } }] })
  const { render } = await import(pathToFileURL(join(temporary, 'details.mjs')).href)
  const unavailableView = render(value)
  assert.match(unavailableView, /removed\/current（当前模型不在候选中）/)
  assert.equal(unavailableView.includes('>请选择<'), false, 'Missing current ID stays visible on the real Select trigger')
  assert.match(render({ ...value, modelCatalog: { ...value.modelCatalog, reloadRequired: true } }), /引擎进程重新加载/)
  assert.equal(render({ ...value, modelCatalog: { ...value.modelCatalog, connectionGeneration: 'foreign-generation', reloadRequired: true } }).includes('引擎进程重新加载'), false)
  console.log('PASS real SessionDetails/Select rendering preserves unlisted current model and ignores stale-generation diagnostics')

  process.env.TPAP_SMOKE_DIR = temporary
  await prepareAcpHistoryWorker(temporary)
  const control = join(temporary, 'peer.json'), journalPath = join(temporary, 'wire.jsonl')
  const fixtureAgents = ['codex', 'claude', 'zcode'].map((id) => ({ id, name: `Owned ${id} model fixture`, command: 'owned model peer', enabled: true, available: true, launchKind: 'managed', executable: process.execPath, args: [resolve('scripts/smoke/fixtures/acp-model-compat-peer.mjs'), control, journalPath, id] }))
  const runtimeUrl = pathToFileURL(createRequire(import.meta.url).resolve('acpx/runtime')).href
  await build({ stdin: { contents: "export * from './src/main/services/acp';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm',
    banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, outfile: join(temporary, 'facade.mjs'),
    plugins: [{ name: 'owned-model-boundaries', setup(builder) {
      builder.onResolve({ filter: /^\.\/acp\/setup$/ }, () => ({ path: 'setup', namespace: 'models' }))
      builder.onResolve({ filter: /^\.\/runtime-host$/ }, () => ({ path: 'host', namespace: 'models' }))
      builder.onResolve({ filter: /^\.\/daemon-client\/acp$/ }, () => ({ path: 'daemon', namespace: 'models' }))
      builder.onLoad({ filter: /.*/, namespace: 'models' }, ({ path }) => ({ loader: 'js', contents: path === 'host' ? 'export const assertRuntimeExecutionHost=()=>{};' : path === 'daemon' ? 'export const emitTrellisTimeline=()=>{};' : `export const listAcpAgents=async()=>({ok:true,agents:${JSON.stringify(fixtureAgents)}}); export const launchArgv=async(config)=>[config.executable,...config.args]; export const NATIVE_TOOLS_DIAGNOSTIC='Owned model fixture'; export const setupAcpRuntime=()=>{}; export const pickAcpNode=()=>{}; export const pickAcpRuntimePath=()=>{};` }))
      builder.onResolve({ filter: /^acpx\/runtime$/ }, () => ({ path: runtimeUrl, external: true }))
    } }] })
  acp = await import(pathToFileURL(join(temporary, 'facade.mjs')).href)
  const state = { current: 'not-in-candidates', legacy: 'wrong-legacy-current', models: codexIds.map((modelId) => ({ modelId, name: 'Same model' })) }
  write(control, state)
  const profile = { id: 'models', name: 'Models', description: '', instructions: '', runtimeId: 'codex', cwd: root, maxTurnMinutes: 30, env }
  assert.equal(acp.saveAcpProfile(root, profile).ok, true)
  const create = await acp.newAcpSession(root, { agentId: 'codex', profileId: profile.id }); assert.equal(create.ok, true)
  const current = () => acp.listAcpSessions(root).sessions.find(({ sessionId }) => sessionId === create.sessionId)
  await wait(() => current()?.status === 'ready', 'ready')
  assert.equal(current().currentModelId, 'not-in-candidates'); assert.equal(current().modelCatalog.currentAvailable, false)
  assert.equal(new Set(current().models.map(({ name }) => name)).size, 3, 'Duplicate runtime labels are disambiguated with exact IDs')
  for (const id of codexIds) {
    const change = await acp.configureAcpSession(root, create.sessionId, { kind: 'model', id })
    assert.equal(change.ok, true, change.error); assert.equal(current().currentModelId, id)
  }
  const calls = () => existsSync(journalPath) ? readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse) : []
  assert.deepEqual(calls().filter(({ method }) => method === 'session/set_config_option').map(({ value }) => value), codexIds)
  const configuredSource = readFileSync(codexConfig, 'utf8')
  write(codexConfig, 'model = "official/Case.[1M]"\n')
  const sourceAccepted = await acp.configureAcpSession(root, create.sessionId, { kind: 'model', id: codexIds[1] })
  assert.equal(sourceAccepted.ok, true, sourceAccepted.error)
  assert.equal(current().currentModelId, codexIds[1]); assert.equal(calls().at(-1).value, codexIds[1])
  assert.equal(current().modelCatalog.reloadRequired, true)
  write(codexConfig, configuredSource)
  const before = current().currentModelId
  write(control, { ...JSON.parse(readFileSync(control, 'utf8')), reject: codexIds[1] })
  assert.equal((await acp.configureAcpSession(root, create.sessionId, { kind: 'config', id: 'native.model', value: codexIds[1] })).ok, false)
  assert.equal(current().currentModelId, before)
  assert.equal((await acp.configureAcpSession(root, create.sessionId, { kind: 'model', id: claudeIds[1] })).ok, false)
  writeCatalog([codexIds[0], codexIds[2]])
  const count = calls().length
  assert.equal((await acp.configureAcpSession(root, create.sessionId, { kind: 'model', id: codexIds[1] })).code, 'E_CONFLICT')
  assert.equal(calls().length, count, 'Removed alias rejected before native dispatch')
  assert.equal(current().modelCatalog.reloadRequired, true); assert.equal(current().currentModelId, before)
  assert.equal(calls().some(({ method }) => method === 'session/prompt'), false)
  console.log('PASS actual facade/public acpx exact model acknowledgements, categorized authority, duplicate labels, rejected selection and zero-dispatch removed alias')
  assert.equal((await acp.killAcpSession(root, create.sessionId)).ok, true)
  resetFiles()
  for (const [agentId, ids] of [['claude', claudeIds], ['zcode', ['Provider-A/Same.Model[1M]', 'Provider-B/Same.Model[1M]']]]) {
    write(control, { current: ids[0], models: ids.map((modelId) => ({ modelId, name: 'Same' })) })
    const profileId = `models-${agentId}`
    assert.equal(acp.saveAcpProfile(root, { ...profile, id: profileId, runtimeId: agentId }).ok, true)
    const created = await acp.newAcpSession(root, { agentId, profileId }); assert.equal(created.ok, true)
    const selected = () => acp.listAcpSessions(root).sessions.find(({ sessionId }) => sessionId === created.sessionId)
    await wait(() => selected()?.status === 'ready', `${agentId} ready`)
    const offset = calls().length
    for (const id of ids) {
      const result = await acp.configureAcpSession(root, created.sessionId, { kind: 'config', id: 'native.model', value: id })
      assert.equal(result.ok, true, result.error); assert.equal(selected().currentModelId, id)
    }
    assert.deepEqual(calls().slice(offset).filter(({ method }) => method === 'session/set_config_option').map(({ value }) => value), ids)
    if (agentId === 'zcode') {
      write(control, { ...JSON.parse(readFileSync(control, 'utf8')), delay: 500 })
      const before = calls().filter(({ method }) => method === 'session/set_config_option').length
      const pending = acp.configureAcpSession(root, created.sessionId, { kind: 'model', id: ids[0] })
      await wait(() => calls().filter(({ method }) => method === 'session/set_config_option').length > before, 'delayed config reached peer')
      assert.equal((await acp.killAcpSession(root, created.sessionId)).ok, true)
      assert.equal((await pending).ok, false, 'A stopped connection cannot acknowledge a late model change')
      assert.equal(selected().status, 'closed')
    } else assert.equal((await acp.killAcpSession(root, created.sessionId)).ok, true)
  }
  console.log('PASS Claude and provider-qualified ZCode exact advertised selectors round-trip on public acpx; stopped generation cannot revive')
} finally {
  if (acp) await acp.shutdownAcp()
  if (previousData === undefined) delete process.env.TPAP_SMOKE_DIR; else process.env.TPAP_SMOKE_DIR = previousData
  if (previousWorker === undefined) delete process.env.TRELLIS_ACP_HISTORY_WORKER_FILE; else process.env.TRELLIS_ACP_HISTORY_WORKER_FILE = previousWorker
  if (resolve(temporary).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) rmSync(temporary, { recursive: true, force: true })
}
