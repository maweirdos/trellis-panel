/** Real roster services and atomic filesystem persistence in an isolated directory. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import tailwindConfig from '../../tailwind.config.js'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'trellis-hifox-roster-'))
const originalStore = process.env.HIFOX_STORE_DIR
const require = createRequire(import.meta.url)
const cases = []
let api
const snapshot = () => api.loadSnapshot()
const agent = (id) => snapshot().agents.find((item) => item.id === id)
const crew = (id) => snapshot().crews.find((item) => item.id === id)
const task = (id) => snapshot().tasks.find((item) => item.id === id)
const last = (data, collection) => data[collection].at(-1)
const disk = () => readFileSync(join(process.env.HIFOX_STORE_DIR, 'store.json'), 'utf8')
const json = (value) => JSON.parse(JSON.stringify(value))
function check(name, run) { run(); cases.push(name); console.log('PASS ' + name) }
function unchanged(run, pattern) {
  const before = json(snapshot()), saved = disk()
  assert.throws(run, pattern)
  assert.deepEqual(json(snapshot()), before, 'rejected mutation changed in-memory data')
  assert.equal(disk(), saved, 'rejected mutation changed persisted data')
}
function newAgent(name, extra = {}) {
  return last(api.saveAgent({ spaceId: 'sp-eng', name, instructions: 'Read context; implement; validate; report risks.', ...extra }), 'agents').id
}
function newCrew(name, captainAgentId, memberRefs = [], extra = {}) {
  return last(api.saveCrew({ spaceId: 'sp-eng', name, captainAgentId, memberRefs, instructions: 'Clarify; divide; validate; summarize.', ...extra }), 'crews').id
}
function editCrew(id, patch = {}) {
  const { captain, members, createdAt: _createdAt, ...current } = crew(id)
  return api.saveCrew({ ...current, ...(captain.kind === 'member' ? { captainMemberId: captain.id } : { captainAgentId: captain.id }), memberRefs: members.map(({ kind, id }) => ({ kind, id })), ...patch })
}

try {
  const bundle = join(temporary, 'services.cjs')
  await build({
    stdin: { contents: "export * from './src/main/services/hifox/agents.ts'; export * from './src/main/services/hifox/core.ts'; export * from './src/main/services/hifox/store.ts'; export * from './src/main/services/hifox/planning.ts'", resolveDir: projectRoot, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent'
  })
  process.env.HIFOX_STORE_DIR = join(temporary, 'data')
  api = require(bundle)
  api.resetDemoSnapshot()
  const localMember = snapshot().spaces.find((item) => item.id === 'sp-eng').memberIds[0]
  const outsider = last(api.inviteMember({ name: 'Outside roster' }), 'members').id
  const captain = newAgent('Roster captain')
  const worker = newAgent('Roster worker')
  const disabled = newAgent('Disabled roster agent', { enabled: false })
  const foreign = newAgent('Foreign roster agent', { spaceId: 'sp-ops' })
  let squad

  check('valid mixed roster includes captain exactly once and persists owner/instructions', () => {
    squad = newCrew('Roster squad', captain, [
      { kind: 'agent', id: captain }, { kind: 'agent', id: worker }, { kind: 'agent', id: worker }, { kind: 'member', id: localMember }
    ], { ownerId: localMember })
    assert.equal(crew(squad).members.length, 3)
    assert.equal(crew(squad).members.filter((ref) => ref.kind === 'agent' && ref.id === captain).length, 1)
    assert.equal(crew(squad).ownerId, localMember)
    assert.equal(crew(squad).instructions, 'Clarify; divide; validate; summarize.')
    assert.equal(JSON.parse(disk()).crews.find((item) => item.id === squad).members.length, 3)
  })
  check('human-only squad needs no Agent and persists its member captain exactly once', () => {
    const result = api.saveCrew({ spaceId: 'sp-eng', name: 'Human-only squad', captainMemberId: localMember, memberRefs: [{ kind: 'member', id: localMember }], instructions: '' })
    const human = result.crews.at(-1)
    assert.deepEqual(human.captain, { kind: 'member', id: localMember, name: snapshot().members.find((member) => member.id === localMember).name })
    assert.deepEqual(human.members, [human.captain])
    assert.equal(JSON.parse(disk()).crews.find((item) => item.id === human.id).captain.kind, 'member')
    unchanged(() => api.saveCrew({ spaceId: 'sp-eng', name: 'Outside captain', captainMemberId: outsider, memberRefs: [] }), /空间成员/)
    unchanged(() => api.saveCrew({ spaceId: 'sp-eng', name: 'Two captains', captainMemberId: localMember, captainAgentId: captain, memberRefs: [] }), /队长/)
  })
  check('invalid captain, foreign members and malformed input reject atomically', () => {
    unchanged(() => newCrew('Disabled captain', disabled), /启用/)
    unchanged(() => newCrew('Foreign captain', foreign), /空间/)
    unchanged(() => newCrew('Foreign member', captain, [{ kind: 'agent', id: foreign }]), /空间/)
    unchanged(() => newCrew('Outside human', captain, [{ kind: 'member', id: outsider }]), /空间成员/)
    unchanged(() => api.saveCrew({ spaceId: 'sp-eng', name: 'Invalid', captainAgentId: captain, memberRefs: [{ kind: 'robot', id: worker }] }), /Invalid option/)
    unchanged(() => api.saveAgent({ spaceId: 'sp-eng', name: 'Invalid', instructions: ' ', runtimeKind: 'unknown' }), /指令|Invalid/)
    unchanged(() => newCrew('Roster squad', captain), /同名/)
    unchanged(() => api.saveAgent({ ...agent(captain), spaceId: 'sp-ops' }), /所属空间/)
    unchanged(() => editCrew(squad, { spaceId: 'sp-ops', captainAgentId: foreign }), /所属空间/)
  })
  check('active captain cannot be disabled or archived before replacement', () => {
    unchanged(() => api.saveAgent({ ...agent(captain), enabled: false }), /更换.*队长/)
    unchanged(() => api.removeAgent({ id: captain }), /更换.*队长/)
  })
  check('roster edit replaces captain, removes humans and updates instructions/owner', () => {
    editCrew(squad, { captainAgentId: worker, memberRefs: [{ kind: 'agent', id: captain }], instructions: 'New coordination rules', ownerId: null })
    assert.equal(crew(squad).captain.id, worker)
    assert.equal(crew(squad).members.length, 2)
    assert.equal(crew(squad).ownerId, undefined)
    assert.equal(crew(squad).instructions, 'New coordination rules')
    api.saveAgent({ ...agent(captain), enabled: false })
    assert.equal(agent(captain).enabled, false)
    api.saveAgent({ ...agent(captain), enabled: true })
  })
  const assigned = api.createTask({ spaceId: 'sp-eng', title: 'Retained Agent task', executor: { kind: 'agent', id: captain, name: 'untrusted' } }).taskId
  const crewTask = api.createTask({ spaceId: 'sp-eng', title: 'Retained squad task', executor: { kind: 'crew', id: squad, name: 'untrusted' } }).taskId
  api.addComment({ taskId: assigned, authorId: localMember, body: 'Keep historical discussion.' })
  const rule = last(api.saveAutomation({ spaceId: 'sp-eng', name: 'Roster automation', trigger: { kind: 'task_created' }, target: { kind: 'agent', id: captain, name: agent(captain).name } }), 'automations').id

  check('Agent rename synchronizes task, squad captain/member and automation references', () => {
    api.saveAgent({ ...agent(captain), name: 'Renamed roster agent' })
    assert.equal(task(assigned).executor.name, 'Renamed roster agent')
    assert.equal(crew(squad).members.find((ref) => ref.id === captain).name, 'Renamed roster agent')
    assert.equal(snapshot().automations.find((item) => item.id === rule).target.name, 'Renamed roster agent')
    api.saveAgent({ ...agent(worker), name: 'Renamed roster captain' })
    assert.equal(crew(squad).captain.name, 'Renamed roster captain')
    editCrew(squad, { name: 'Renamed squad' })
    assert.equal(task(crewTask).executor.name, 'Renamed squad')
  })
  check('exclusive Agent must belong to only one squad; old individual task remains', () => {
    const other = newCrew('Second squad', worker, [{ kind: 'agent', id: captain }])
    unchanged(() => editCrew(squad, { exclusiveAgentIds: [captain] }), /其他小队/)
    editCrew(other, { memberRefs: [] })
    editCrew(squad, { exclusiveAgentIds: [captain] })
    assert.equal(agent(captain).exclusiveCrewId, squad)
    unchanged(() => api.createTask({ spaceId: 'sp-eng', title: 'Forbidden individual assignment', executor: { kind: 'agent', id: captain, name: 'ignored' } }), /专属/)
    assert.equal(task(assigned).executor.id, captain)
    assert.equal(task(assigned).dispatch, undefined)
    assert.equal(snapshot().automations.find((item) => item.id === rule).enabled, false)
    unchanged(() => newCrew('Exclusive member elsewhere', worker, [{ kind: 'agent', id: captain }]), /专属/)
    unchanged(() => editCrew(squad, { exclusiveAgentIds: [worker] }), /队长/)
    unchanged(() => editCrew(squad, { exclusiveAgentIds: [foreign] }), /名册/)
    editCrew(squad, { memberRefs: [] })
    assert.equal(agent(captain).exclusiveCrewId, undefined)
    editCrew(squad, { memberRefs: [{ kind: 'agent', id: captain }] })
  })
  check('disabled/archived Agents retain task/comment/roster records and restore without resetting settings', () => {
    api.saveAgent({ ...agent(captain), enabled: false })
    unchanged(() => api.createTask({ spaceId: 'sp-eng', title: 'Disabled assignment', executor: { kind: 'agent', id: captain, name: 'ignored' } }), /停用/)
    assert.equal(task(assigned).executor.id, captain)
    assert.ok(crew(squad).members.some((ref) => ref.id === captain))
    assert.ok(snapshot().comments.some((comment) => comment.taskId === assigned && comment.body === 'Keep historical discussion.'))
    api.removeAgent({ id: captain })
    assert.equal(agent(captain).archived, true)
    api.saveAgent({ ...agent(captain), enabled: true })
    unchanged(() => api.createTask({ spaceId: 'sp-eng', title: 'Archived assignment', executor: { kind: 'agent', id: captain, name: 'ignored' } }), /归档/)
    api.saveAgent({ ...agent(captain), enabled: false })
    api.saveAgent({ ...agent(captain), archived: false })
    assert.equal(agent(captain).enabled, false)
    assert.equal(agent(captain).instructions, 'Read context; implement; validate; report risks.')
    api.saveAgent({ ...agent(captain), enabled: true })
  })
  check('squad archive retains all history, allows captain archive, then validates restoration', () => {
    api.removeCrew({ id: squad })
    assert.equal(crew(squad).archived, true)
    unchanged(() => api.createTask({ spaceId: 'sp-eng', title: 'Archived squad assignment', executor: { kind: 'crew', id: squad, name: 'ignored' } }), /归档/)
    assert.equal(task(crewTask).executor.id, squad)
    assert.equal(task(crewTask).dispatch, undefined)
    const otherCrew = snapshot().crews.find((item) => item.name === 'Second squad')
    api.removeCrew({ id: otherCrew.id })
    api.removeAgent({ id: worker })
    unchanged(() => editCrew(squad, { archived: false }), /启用/)
    api.saveAgent({ ...agent(worker), archived: false })
    editCrew(squad, { archived: false })
    assert.equal(crew(squad).archived, false)
  })
  check('skill scope, live shared editing and binding removal remain consistent', () => {
    const local = last(api.saveSkill({ spaceId: 'sp-eng', name: 'Roster skill', content: 'Original checks' }), 'skills').id
    const shared = last(api.saveSkill({ name: 'Roster shared skill', content: 'Shared checks' }), 'skills').id
    const other = last(api.saveSkill({ spaceId: 'sp-ops', name: 'Roster skill', content: 'Other checks' }), 'skills').id
    api.saveAgent({ ...agent(captain), skillIds: [local, shared, local] })
    assert.deepEqual(agent(captain).skillIds, [local, shared])
    unchanged(() => api.saveAgent({ ...agent(captain), skillIds: [other] }), /其他空间/)
    unchanged(() => api.saveSkill({ id: local, spaceId: 'sp-ops', name: 'Moved skill', content: 'checks' }), /所属范围/)
    api.saveSkill({ id: local, name: 'Renamed roster skill', content: 'Updated checks' })
    assert.ok(agent(captain).skillIds.includes(local))
    assert.equal(snapshot().skills.find((item) => item.id === local).content, 'Updated checks')
    api.removeSkill({ id: local })
    assert.deepEqual(agent(captain).skillIds, [shared])
  })
  console.log(`Hifox roster smoke: ${cases.length} service scenarios passed; real services + disk, no user data or Runtime.`)
  if (process.argv.includes('--ui')) await verifyRenderer(temporary)
} finally {
  if (originalStore === undefined) delete process.env.HIFOX_STORE_DIR
  else process.env.HIFOX_STORE_DIR = originalStore
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('trellis-hifox-roster-'))
  rmSync(temporary, { recursive: true, force: true })
}

async function rendererChecks() {
  const f = window.rosterFixture
  const passed = []
  const check = (name, condition) => { if (!condition) throw Error(name); passed.push(name) }
  const settle = () => new Promise((done) => setTimeout(done, 35))
  const wait = async (predicate) => {
    for (let count = 0; count < 120; count++) { if (predicate()) return; await settle() }
    throw Error('UI did not settle: ' + document.body.innerText.slice(-1800))
  }
  const dialog = () => document.querySelector('[role="dialog"]')
  const button = (text, root = document) => [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === text || node.getAttribute('aria-label') === text)
  const click = async (text, root = document) => { const node = button(text, root); check('reachable button: ' + text, node && !node.disabled); node.click(); await settle() }
  const card = (name) => [...document.querySelectorAll('section')].find((node) => node.querySelector('h2')?.textContent === name)
  const field = (label) => {
    const node = [...dialog().querySelectorAll('label')].find((node) => node.textContent.trim() === label)
    if (!node?.control) throw Error('Missing labeled control: ' + label)
    return node.control
  }
  const input = async (node, value) => {
    check('form control exists', Boolean(node))
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, value)
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    await settle()
  }
  const save = async () => { await click('保存', dialog()); await wait(() => !dialog() && !f.store.getState().busy) }
  const get = async () => (await window.trellis.hifox.snapshot()).data
  const api = window.trellis.hifox
  const must = (result) => { if (!result.ok) throw Error(result.error); return result.data }
  let data = must(await api.saveAgent({ spaceId: 'sp-eng', name: 'UI Alpha', instructions: 'Alpha stable instructions' }))
  const alpha = data.agents.at(-1).id
  data = must(await api.saveAgent({ spaceId: 'sp-eng', name: 'UI Beta', instructions: 'Beta stable instructions' }))
  const beta = data.agents.at(-1).id
  data = must(await api.saveSkill({ spaceId: 'sp-eng', name: 'UI skill', content: 'UI reusable checks' }))
  const skillId = data.skills.at(-1).id
  data = must(await api.saveCrew({ spaceId: 'sp-eng', name: 'UI squad', captainAgentId: alpha, instructions: 'UI coordination rules', memberRefs: [{ kind: 'agent', id: beta }, { kind: 'member', id: 'm-lin' }] }))
  const squad = data.crews.at(-1).id
  data = must(await api.inviteMember({ name: 'UI Colleague', spaceId: 'sp-eng' }))
  const colleague = data.members.at(-1).id
  f.store.setState({ snapshot: data, currentSpaceId: 'sp-eng' })
  const rejected = await api.saveCrew({ spaceId: 'sp-eng', name: 'Invalid IPC squad', captainAgentId: 'missing', memberRefs: [] })
  check('invalid roster IPC returns a structured failure', rejected.ok === false && rejected.code === 'E_INVALID_ARG')

  f.mount('agents'); await settle()
  await click('编辑', card('UI Alpha'))
  check('Agent editor initializes from the selected record', field('名称').value === 'UI Alpha' && field('工作指令').value === 'Alpha stable instructions')
  const panel = dialog(), content = panel.firstElementChild
  check('editor has real token-scaled padding', parseFloat(getComputedStyle(content).paddingLeft) >= 12)
  await click('取消', dialog())
  await click('新建 Agent')
  check('new Agent editor starts blank after editing', field('名称').value === '' && field('工作指令').value === '')
  await input(field('名称'), 'Discarded draft')
  await click('取消', dialog())
  await click('编辑', card('UI Beta'))
  check('switching Agent does not reuse another draft', field('名称').value === 'UI Beta' && field('工作指令').value === 'Beta stable instructions')
  await input(field('工作指令'), 'Beta updated instructions')
  const skillToggle = [...dialog().querySelectorAll('label')].find((node) => node.textContent.includes('UI skill')).querySelector('input')
  skillToggle.click(); await settle()
  await save()
  check('real renderer/preload/IPC/service save persisted Agent instructions', (await get()).agents.find((item) => item.id === beta).instructions === 'Beta updated instructions')
  check('Agent skill binding persists through the actual checkbox and IPC', (await get()).agents.find((item) => item.id === beta).skillIds.includes(skillId))

  f.mount('skills'); await settle()
  await click('编辑', card('UI skill'))
  check('skill edit loads persisted content', field('技能名称').value === 'UI skill' && field('技能指令').value === 'UI reusable checks')
  await click('取消', dialog())
  await click('新建技能')
  check('new skill editor resets earlier values', field('技能名称').value === '' && field('技能指令').value === '')
  await click('取消', dialog())

  f.mount('crews'); await settle()
  await click('编辑 UI squad', card('UI squad'))
  check('squad editor initializes instructions and captain', field('协作约定（选填）').value === 'UI coordination rules' && field('队长').value === 'agent:' + alpha)
  await input(field('队长'), 'agent:' + beta)
  await input(field('协作约定（选填）'), 'Updated coordination rules')
  await save()
  let savedCrew = (await get()).crews.find((item) => item.id === squad)
  check('squad edit persists new captain, unique roster and instructions', savedCrew.captain.id === beta && savedCrew.members.filter((ref) => ref.id === beta).length === 1 && savedCrew.instructions === 'Updated coordination rules')
  await click('归档 UI squad', card('UI squad'))
  await wait(() => !card('UI squad'))
  const archiveToggle = [...document.querySelectorAll('label')].find((node) => node.textContent.includes('已归档')).querySelector('input')
  archiveToggle.click(); await settle()
  check('archived squad remains reachable for recovery', Boolean(card('UI squad')))
  await click('恢复 UI squad', card('UI squad'))
  await wait(() => !card('UI squad'))
  check('squad recovery traverses the actual IPC route', !(await get()).crews.find((item) => item.id === squad).archived)
  archiveToggle.click(); await settle()
  await click('组建小队')
  await input(field('名称'), 'UI human squad')
  await input(field('队长'), 'member:' + colleague)
  await click('组建', dialog()); await wait(() => !dialog() && !f.store.getState().busy)
  const humanCrew = (await get()).crews.find((item) => item.name === 'UI human squad')
  check('human-only squad saves through native captain selector without Agent configuration', humanCrew.captain.kind === 'member' && humanCrew.captain.id === colleague && humanCrew.members.length === 1 && humanCrew.members[0].id === colleague)

  f.mount('members'); await settle()
  check('colleagues heading remains visible', document.querySelector('h1').textContent === '同事')
  document.querySelector('[aria-label="关于同事"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await wait(() => document.querySelector('[role="tooltip"]')?.textContent.includes('添加不会发送邀请'))
  check('colleagues info icon describes the local roster truthfully', document.querySelector('[role="tooltip"]').textContent.includes('本机同事名册'))
  document.querySelector('[aria-label="编辑 UI Colleague"]').click(); await settle()
  check('colleague editor loads selected colleague', field('姓名').value === 'UI Colleague')
  await input(field('姓名'), 'UI Colleague renamed')
  await save()
  check('colleague rename persists through real IPC', (await get()).members.find((item) => item.id === colleague).name === 'UI Colleague renamed')
  await click('添加同事')
  check('new colleague editor resets earlier name', field('姓名').value === '')
  await click('取消', dialog())

  for (const theme of ['light', 'dark']) {
    f.mount('crews', theme, 'large'); await settle()
    document.querySelector('label input[type="checkbox"]').checked && document.querySelector('label input[type="checkbox"]').click()
    await click('编辑 UI squad', card('UI squad'))
    const modal = dialog().getBoundingClientRect()
    const saveButton = button('保存', dialog()).getBoundingClientRect()
    check(theme + ' modal and save stay in short viewport', modal.left >= 0 && modal.right <= innerWidth + 1 && modal.bottom <= innerHeight + 1 && saveButton.bottom <= innerHeight)
    check(theme + ' modal content can scroll', [...dialog().querySelectorAll('.my-scrollbar')].some((node) => getComputedStyle(node).overflowY === 'auto'))
    await click('取消', dialog())
  }
  check('no service or renderer failures were hidden', window.rosterErrors.length === 0)
  return passed
}

async function verifyRenderer(directory) {
  const absolute = (file) => resolve(projectRoot, file).replaceAll('\\', '/')
  const fixture = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {flushSync} from '${absolute('node_modules/react-dom/index.js')}';
import {useHifox} from '${absolute('src/renderer/src/hifox/store.ts')}';
import {useApp} from '${absolute('src/renderer/src/store/index.ts')}';
import {AgentsPage} from '${absolute('src/renderer/src/hifox/pages/AgentsPage.tsx')}';
import {MembersPage} from '${absolute('src/renderer/src/hifox/pages/MembersPage.tsx')}';
import {CrewsPage} from '${absolute('src/renderer/src/hifox/pages/CrewsPage.tsx')}';
import {SkillsPage} from '${absolute('src/renderer/src/hifox/pages/SkillsPage.tsx')}';
import {DialogHost} from '${absolute('src/renderer/src/components/Dialogs.tsx')}';
window.rosterErrors=[];window.addEventListener('error',event=>window.rosterErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.rosterErrors.push(String(event.reason)));
useApp.subscribe((state,previous)=>state.toasts.filter(toast=>!previous.toasts.some(item=>item.id===toast.id)).forEach(toast=>window.rosterErrors.push(toast)));
const root=createRoot(document.getElementById('root')),pages={agents:AgentsPage,members:MembersPage,crews:CrewsPage,skills:SkillsPage};
window.rosterFixture={store:useHifox,mount:(page,theme='dark',font='standard')=>{flushSync(()=>root.render(null));const Page=pages[page];flushSync(()=>root.render(<div className="my-root flex h-full min-h-0 flex-col p-4" data-my-theme={theme} data-my-font-size={font}><Page/><DialogHost/></div>))}};`
  const entry = join(directory, 'renderer.tsx')
  writeFileSync(entry, fixture)
  await build({
    entryPoints: [entry], outfile: join(directory, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
    nodePaths: [absolute('node_modules')], alias: { '@shared': absolute('src/shared') }, logLevel: 'silent'
  })
  await build({ entryPoints: [absolute('src/preload/index.ts')], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const cssFiles = ['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'my/my-utilities.css', 'styles.css', 'hifox/collaboration.css']
  const css = (await postcss([tailwind(tailwindConfig)]).process(cssFiles.map((file) => readFileSync(absolute('src/renderer/src/' + file), 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  const mainSource = `import {app,BrowserWindow} from 'electron';
import {registerHifoxIpc} from '${absolute('src/main/ipc/hifox.ts')}';
import {resetDemoSnapshot} from '${absolute('src/main/services/hifox/store.ts')}';
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.disableHardwareAcceleration();
process.env.HIFOX_STORE_DIR=${JSON.stringify(join(directory, 'ui-data'))};
app.whenReady().then(async()=>{resetDemoSnapshot();registerHifoxIpc();
const win=new BrowserWindow({show:false,width:960,height:620,webPreferences:{preload:${JSON.stringify(join(directory, 'preload.cjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
const errors=[];win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
const result=await win.webContents.executeJavaScript(${JSON.stringify('(' + rendererChecks.toString() + ')()')});
if(errors.length)throw Error(errors.join('\\n'));if(win.isVisible())throw Error('Fixture must remain hidden');
console.log('PASS hidden Electron: '+result.length+' real renderer/preload/IPC/service interactions and layout assertions');
win.destroy();app.exit(0)}).catch(error=>{console.error(error);app.exit(1)});
setTimeout(()=>{console.error('Hifox UI smoke timed out');app.exit(1)},45000);`
  await build({ stdin: { contents: mainSource, resolveDir: projectRoot, loader: 'ts' }, outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const result = await promisify(execFile)(require('electron'), [join(directory, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 55000, maxBuffer: 1024 * 1024 })
    process.stdout.write(result.stdout)
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout)
    if (error.stderr) process.stderr.write(error.stderr)
    throw error
  }
}
