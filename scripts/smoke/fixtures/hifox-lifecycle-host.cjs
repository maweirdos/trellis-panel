const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } = require('node:fs')
const { isAbsolute, join, relative, sep } = require('node:path')

const fixture = process.env.HIFOX_WORKSPACE_FIXTURE, reportDir = process.env.HIFOX_WORKSPACE_REPORT
if (!fixture || !reportDir || process.env.HIFOX_STORE_DIR !== join(fixture, 'store')) throw Error('Missing isolated lifecycle paths')
const project = join(fixture, 'project')
const rel = relative(fixture, project)
assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'fixture escaped tmpdir')
mkdirSync(join(fixture, 'profile'), { recursive: true })
mkdirSync(join(project, '.trellis', 'scripts'), { recursive: true })
mkdirSync(join(project, '.trellis', 'tasks'), { recursive: true })
writeFileSync(join(project, '.trellis', 'workflow.md'), '# Isolated UI fixture\n')
writeFileSync(join(project, '.trellis', '.current-task'), 'existing-fixture-pointer\n')
app.setPath('userData', join(fixture, 'profile'))
app.disableHardwareAcceleration()
const { registerHifoxIpc, registerHifoxWorkIpc, scanProject, expectedDefaultPrd, ipcInvoke, ipcEvent } = require(join(fixture, 'hifox-ipc.cjs'))
writeFileSync(join(project, '.trellis', 'scripts', 'task.py'), `import datetime, json, pathlib, sys
args = sys.argv[1:]
assert args[0] == 'create' and '--no-start' in args and '--force' not in args and 'start' not in args
root = pathlib.Path.cwd()
def opt(name): return args[args.index(name) + 1]
meta = dict(args[i + 1].split('=', 1) for i, value in enumerate(args) if value == '--meta')
with (root / 'cli.jsonl').open('a', encoding='utf-8') as log: log.write(json.dumps(args) + '\\n')
name = datetime.date.today().strftime('%m-%d') + '-' + opt('--slug')
task = root / '.trellis' / 'tasks' / name
task.mkdir()
(task / 'task.json').write_text(json.dumps({'id': 'local-' + opt('--slug'), 'title': args[1], 'description': opt('--description'), 'status': 'planning', 'meta': meta}), encoding='utf-8')
template = ${JSON.stringify(expectedDefaultPrd('__TITLE__', '__DESCRIPTION__'))}
(task / 'prd.md').write_text(template.replace('__TITLE__', args[1].strip()).replace('__DESCRIPTION__', opt('--description').strip()), encoding='utf-8')
print('Created task: ' + name, file=sys.stderr)
`)
let holdPrepare = null, holdSnapshot = null, holdProjectReply = null, holdStatusReply = null, nativeRoot = project, prepareCalls = 0, transitions = 0, snapshotScans = 0, projectOpens = 0
const statusCalls = []
const register = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => register(channel, async (...args) => {
  if (channel === ipcInvoke.hifoxWork.prepare) { prepareCalls++; if (holdPrepare) await holdPrepare }
  if (channel === ipcInvoke.hifoxWork.status) {
    statusCalls.push(args[1])
    const gate = holdStatusReply
    const result = await listener(...args)
    if (gate) { gate.enter(); await gate.wait }
    return result
  }
  if (channel === ipcInvoke.hifox.transitionTask) transitions++
  return listener(...args)
})
registerHifoxIpc()
registerHifoxWorkIpc({ getProjectRoot: () => nativeRoot, getProjectGeneration: () => 1 })
ipcMain.handle = register
register(ipcInvoke.project.snapshot, async () => { snapshotScans++; if (holdSnapshot) await holdSnapshot; return scanProject(project) })
register(ipcInvoke.project.open, async (event, root) => {
  assert.equal(root, project, 'native opening escaped the controlled project')
  projectOpens++
  const snapshot = scanProject(project)
  event.sender.send(ipcEvent.snapshotUpdated, snapshot)
  if (holdProjectReply) await holdProjectReply
  return { ok: true, snapshot }
})
register(ipcInvoke.settings.get, async () => ({ theme: 'dark', recentProjects: [project] }))
register(ipcInvoke.todo.list, async () => ({ ok: true, todos: [] }))
const checks = [], errors = []
let w, phase = 'startup'
const run = (code) => w.webContents.executeJavaScript(`(async()=>{${code}})()`, true)
const settle = (ms = 45) => new Promise((done) => setTimeout(done, ms))
const wait = async (code, label) => {
  for (let i = 0; i < 240; i++) { if (await run('return ' + code)) return; await settle(30) }
  throw Error('Timeout: ' + label + '; ' + await run('return document.body.innerText.slice(-2600)'))
}
const check = async (name, action) => { phase = name; await action(); checks.push(name); console.log('PASS ' + name) }
const snapshot = () => run('return window.hifoxLifecycle.state().snapshot')
const task = async (id) => (await snapshot()).tasks.find((item) => item.id === id)
const ready = () => wait('!window.hifoxLifecycle.state().busy', 'writes settled')
const click = async (label, scope = 'dialog', twice = false) => {
  await run(`const p=${scope === 'dialog' ? "[...document.querySelectorAll('[role=dialog]')].at(-1)" : `document.querySelector(${JSON.stringify(scope)})`};const b=[...(p?.querySelectorAll('button')??[])].find(e=>e.getClientRects().length&&(e.textContent.trim()===${JSON.stringify(label)}||[...e.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim()===${JSON.stringify(label)}||e.firstChild?.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b||b.matches(':disabled'))throw Error('Unavailable '+${JSON.stringify(label)});b.focus();b.click();${twice ? 'b.click();' : ''}`)
  await settle()
}
const field = async (label, value, scope = 'dialog') => {
  await run(`const p=${scope === 'dialog' ? "[...document.querySelectorAll('[role=dialog]')].at(-1)" : `document.querySelector(${JSON.stringify(scope)})`};const l=[...(p?.querySelectorAll('label')??[])].find(e=>e.textContent.trim()===${JSON.stringify(label)});const e=l?.control??l?.querySelector('input,textarea,select')??p?.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!e||e.matches(':disabled'))throw Error('Unavailable field '+${JSON.stringify(label)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))`)
  await settle()
}
const input = async (selector, value) => {
  await run(`const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))`)
  await settle()
}
const api = async (name, input) => {
  const result = await run(`return window.trellis.hifox[${JSON.stringify(name)}](${JSON.stringify(input)})`)
  assert.equal(result.ok, true, name + ': ' + result.error)
  await run('await window.hifoxLifecycle.bootstrap()'); await settle()
  return result
}
const open = async (id) => { await run(`window.hifoxLifecycle.openTask(${JSON.stringify(id)})`); await wait('document.querySelector(".collab-task-detail")', 'details mounted') }
const close = async () => { await click('关闭详情'); await wait('!window.hifoxLifecycle.state().openTaskId', 'details closed') }
const navigate = async (id) => { await run(`window.hifoxLifecycle.setModule(${JSON.stringify(id)})`); await wait(`document.querySelector('[data-hifox-module]')?.dataset.hifoxModule===${JSON.stringify(id)}`, 'route ' + id) }
const key = async (selector, composing, ctrlKey = false) => {
  await run(`const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing key target');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,isComposing:${composing},ctrlKey:${ctrlKey}}))`)
  await settle()
}
const escape = async () => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await settle() }
const cliCalls = () => existsSync(join(project, 'cli.jsonl')) ? readFileSync(join(project, 'cli.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []
app.whenReady().then(async () => {
  w = new BrowserWindow({ width: 1320, height: 900, show: false, webPreferences: { preload: join(fixture, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  w.webContents.on('console-message', (event) => { if (event.level === 'error' && !event.message.includes('Electron Security Warning')) errors.push(event.message) })
  await w.loadFile(join(fixture, 'index.html'))
  await wait('Boolean(window.hifoxLifecycle?.state().snapshot)', 'bootstrap')
  const owner = (await snapshot()).members[0].id
  let spaceId, personId, crewId, versionId, generalId, codeId
  await check('team opens without a code project; human-only squad is a usable assignment target', async () => {
    assert.equal((await run('return window.hifoxLifecycle.nativeState()')).root, undefined)
    assert.ok(await run(`return document.querySelector('[aria-label=空间为空]')?.innerText.includes('还没有空间')`), 'empty overview lost its content')
    await click('创建空间', '.collab-main'); await wait(`document.querySelector('[data-hifox-module]')?.dataset.hifoxModule==='spaces'`, 'empty overview create entry')
    await navigate('overview'); await click('浏览空间', '.collab-main'); await wait(`document.querySelector('[data-hifox-module]')?.dataset.hifoxModule==='spaces'`, 'empty overview browse entry')
    await api('createSpace', { name: 'Lifecycle space', key: 'LIFE' }); spaceId = (await snapshot()).spaces[0].id
    await api('inviteMember', { name: '人工队长', role: 'member' }); personId = (await snapshot()).members.find((item) => item.name === '人工队长').id
    const space = (await snapshot()).spaces[0]
    await api('setSpaceMembers', { spaceId, memberIds: [...space.memberIds, personId] })
    await api('saveCrew', { spaceId, name: '纯人工小队', captainMemberId: personId, memberRefs: [{ kind: 'member', id: owner }, { kind: 'member', id: personId }], instructions: '协作处理同一任务' })
    crewId = (await snapshot()).crews[0].id
    await api('createIteration', { spaceId, name: 'Lifecycle v1', startDate: '2026-10-25', endDate: '2026-11-08', taskIds: [] }); versionId = (await snapshot()).iterations[0].id
    assert.equal((await snapshot()).agents.length, 0)
  })
  await check('space-name row stays left aligned in light and dark themes', async () => {
    await navigate('spaces')
    for (const theme of ['light', 'dark']) {
      await run(`window.hifoxLifecycle.appearance(${JSON.stringify(theme)},'standard')`); await settle()
      const row = await run(`const button=document.querySelector('[aria-label="可见空间"] tbody td button'),name=button.firstElementChild;return {justify:getComputedStyle(button).justifyContent,left:button.getBoundingClientRect().left,nameLeft:name.getBoundingClientRect().left,text:name.textContent}`)
      assert.equal(row.text, 'Lifecycle space'); assert.notEqual(row.justify, 'center'); assert.ok(Math.abs(row.nameLeft - row.left) <= 1)
    }
  })
  await check('IME does not create or save; repeated create produces one real task', async () => {
    await navigate('triage'); await click('新建任务', '.collab-main')
    await field('标题', '日常交付'); await field('工作内容', 'general'); await field('验收标准', '保留同一任务历史')
    await key('[role=dialog] input[required]', true, true)
    assert.equal((await snapshot()).tasks.length, 0)
    await click('创建任务', 'dialog', true)
    await wait('window.hifoxLifecycle.state().snapshot.tasks.length===1', 'single create')
    generalId = (await snapshot()).tasks[0].id
    await wait('document.querySelector(".collab-task-detail")', 'details')
    await click('编辑标题'); await field('标题', '日常交付 · 已保存')
    await key('.collab-task-detail input', true)
    assert.equal((await task(generalId)).title, '日常交付')
    await key('.collab-task-detail input', false); await ready()
    assert.equal((await task(generalId)).title, '日常交付 · 已保存')
  })
  await check('new-task drafts survive X, Escape and navigation; discard, creation context and owner changes are isolated', async () => {
    await close(); await navigate('triage'); await click('新建任务', '.collab-main')
    assert.equal(await run(`return document.querySelector('[role=dialog] input[required]').value`), '', 'successful creation retained its draft')
    await field('标题', '新建草稿唯一内容'); await field('描述', '未提交的私有草稿正文'); await field('工作内容', 'general'); await field('验收标准', '草稿恢复标准')
    await click('关闭新建任务'); await click('新建任务', '.collab-main')
    assert.equal(await run(`return document.querySelector('[role=dialog] input[required]').value`), '新建草稿唯一内容')
    await escape(); await wait('!document.querySelector("[role=dialog]")', 'new-task Escape')
    await click('新建任务', '.collab-main'); await navigate('members'); await navigate('triage'); await click('新建任务', '.collab-main')
    assert.equal(await run(`return document.querySelector('[role=dialog] input[required]').value`), '新建草稿唯一内容')
    assert.equal(await run(`return [...document.querySelectorAll('[role=dialog] label')].find(e=>e.textContent==='工作内容').control.value`), 'general')
    assert.equal(await run(`return Object.values(localStorage).some(value=>value.includes('未提交的私有草稿正文'))`), false)
    await navigate('tasks'); await click('新建任务', '.collab-main')
    assert.equal(await run(`return document.querySelector('[role=dialog] input[required]').value`), '', 'another creation context adopted the draft')
    await click('关闭新建任务'); await navigate('triage'); await click('新建任务', '.collab-main')
    assert.equal(await run(`return document.querySelector('[role=dialog] input[required]').value`), '新建草稿唯一内容')
    await click('放弃草稿'); await click('新建任务', '.collab-main')
    assert.equal(await run(`return document.querySelector('[role=dialog] input[required]').value`), '')
    await field('标题', '不得跨身份恢复')
    const context = await run('return window.hifoxLifecycle.state().workspaceContext')
    await run(`window.hifoxLifecycle.context(${JSON.stringify({ ...context, actorId: personId })});window.hifoxLifecycle.context(${JSON.stringify(context)})`)
    await settle(); assert.equal(await run(`return document.querySelector('[role=dialog] input[required]').value`), '', 'batched actor A-B-A revived a draft')
    await field('标题', '不得跨 epoch 恢复')
    await run(`window.hifoxLifecycle.context(${JSON.stringify({ ...context, epoch: 'retired-fixture-epoch' })});window.hifoxLifecycle.context(${JSON.stringify(context)})`)
    await settle(); assert.equal(await run(`return document.querySelector('[role=dialog] input[required]').value`), '', 'batched epoch A-B-A revived a draft')
    await click('关闭新建任务'); await open(generalId)
  })
  await check('title/description drafts restore after close and navigation; changed base requires explicit review', async () => {
    await click('编辑标题'); await field('标题', '日常交付 · 已保存草稿'); await click('编辑描述'); await field('任务描述', '保留的描述草稿')
    await close(); await navigate('members'); await open(generalId)
    assert.equal(await run(`return document.querySelector('.collab-task-detail input').value`), '日常交付 · 已保存草稿')
    assert.equal(await run(`return document.querySelector('textarea[aria-label="任务描述"]').value`), '保留的描述草稿')
    await api('updateTask', { id: generalId, patch: { title: '他人修改的标题', description: '他人修改的描述' } })
    assert.equal(await run(`return [...document.querySelectorAll('.collab-task-detail button')].find(e=>e.textContent==='保存标题').disabled`), true)
    assert.equal(await run(`return [...document.querySelectorAll('.collab-task-detail button')].find(e=>e.textContent==='保存描述').disabled`), true)
    assert.equal((await task(generalId)).title, '他人修改的标题')
    await run(`document.querySelectorAll('.collab-task-detail .collab-inline-error button').forEach(e=>e.click())`); await settle()
    await click('保存标题'); await ready(); await click('保存描述'); await ready()
    assert.equal((await task(generalId)).title, '日常交付 · 已保存草稿'); assert.equal((await task(generalId)).description, '保留的描述草稿')
    await close(); await open(generalId)
    assert.equal(await run(`return Boolean(document.querySelector('.collab-task-detail input'))`), false, 'successful save retained an editing draft')
    await click('编辑标题'); await field('标题', '放弃的标题'); await click('取消'); await close(); await open(generalId)
    assert.equal(await run(`return Boolean(document.querySelector('.collab-task-detail input'))`), false, 'explicit title cancel retained the edit')
  })
  await check('accept-and-arrange is atomic; real human squad uses captain; manager can reassign', async () => {
    await click('更多流程操作'); await click('请补充', '.my-root'); await field('需要补充的内容', '明确放弃的交接草稿'); await click('放弃草稿')
    await click('更多流程操作'); await click('请补充', '.my-root')
    assert.equal(await run(`return [...document.querySelectorAll('[role=dialog]')].at(-1).querySelector('textarea').value`), '', 'explicit workflow discard retained the body')
    await click('关闭交接')
    await click('接纳并安排'); await field('分配给', 'crew:' + crewId)
    await field('版本（选填）', versionId)
    assert.equal(await run(`return [...document.querySelectorAll('[role=dialog]')].at(-1).querySelector('select').value`), 'crew:' + crewId)
    await click('确认安排', 'dialog', true); await ready()
    const arranged = await task(generalId)
    assert.equal(arranged.triagePending, undefined); assert.equal(arranged.workflow.stage, 'developing')
    assert.equal(arranged.workflow.handlerId, personId); assert.equal(arranged.executor.id, crewId)
    assert.deepEqual(arranged.iterationIds, [versionId]); assert.deepEqual(arranged.workflow.history.map((event) => event.action), ['arrange'])
    assert.equal(await run(`return [...document.querySelectorAll('.collab-task-workflow button')].some(e=>e.textContent.trim()==='提交交付成果')`), false, 'non-handler acquired workflow actions')
    await click('更多流程操作'); await click('转交', '.my-root')
    await field('分配给', 'member:' + owner); await click('确认转交'); await ready()
    assert.equal((await task(generalId)).workflow.handlerId, owner)
  })
  await check('drafts survive polling, expansion and tab changes; comments respect IME', async () => {
    await click('编辑描述'); await field('任务描述', '未提交的描述')
    const before = await task(generalId)
    await run('await window.hifoxLifecycle.bootstrap()'); await click('展开详情')
    assert.equal(await run(`return document.querySelector('textarea[aria-label="任务描述"]').value`), '未提交的描述')
    await click('讨论'); await field('发表评论', '未提交的讨论'); await key('section[aria-label="任务讨论"] textarea', true, true)
    assert.equal((await snapshot()).comments.length, 0)
    await click('详情'); await click('讨论')
    assert.equal(await run(`return document.querySelector('section[aria-label="任务讨论"] textarea').value`), '未提交的讨论')
    await click('发送评论'); await ready()
    assert.equal((await snapshot()).comments.length, 1)
    await click('详情'); assert.equal((await task(generalId)).description, before.description)
    await click('保存描述'); await ready()
  })
  await check('general work submits and accepts without creating Trellis; version scope/history remain', async () => {
    await click('提交交付成果'); await field('产出链接或交付说明', '保留交付弹窗草稿'); await escape(); await click('提交交付成果')
    assert.equal(await run(`return [...document.querySelectorAll('[role=dialog]')].at(-1).querySelector('textarea').value`), '保留交付弹窗草稿')
    await click('关闭交接'); await close(); await navigate('tasks'); await open(generalId); await click('提交交付成果')
    assert.equal(await run(`return [...document.querySelectorAll('[role=dialog]')].at(-1).querySelector('textarea').value`), '保留交付弹窗草稿')
    await api('updateTask', { id: generalId, patch: { description: '交接前基础内容已更新' } })
    assert.equal(await run(`return [...document.querySelectorAll('[role=dialog]')].at(-1).querySelector('footer .my-button-primary').disabled`), true)
    await click('已核对，继续编辑'); await field('产出链接或交付说明', '本地验收记录已整理'); await field('下一位处理人', owner); await click('提交交付成果'); await ready()
    await click('验收通过'); await click('验收通过'); await ready()
    const done = await task(generalId)
    assert.equal(done.workflow.stage, 'done'); assert.ok(done.completedAt)
    assert.deepEqual(done.iterationIds, [versionId]); assert.deepEqual(done.workflow.history.map((event) => event.action), ['arrange', 'reassign', 'submit_delivery', 'accept_delivery'])
    assert.equal(cliCalls().length, 0); assert.deepEqual(readdirSync(join(project, '.trellis', 'tasks')), [])
    await close()
  })
  await check('accepted unversioned tasks remain discoverable and accepting cannot repeat', async () => {
    const made = await api('createTask', { spaceId, title: '接受但未排版本', creatorId: owner, triagePending: true, workKind: 'general', acceptanceCriteria: ['保留入口'] })
    await open(made.taskId); await click('先接纳', 'dialog', true); await ready(); await close()
    await navigate('triage'); await click('已接受 · 未排版本', '.collab-main')
    assert.ok((await run('return document.querySelector(".collab-main").innerText')).includes('接受但未排版本'))
    assert.equal((await task(made.taskId)).workflow.history.length, 1)
  })
  await check('triage/version filters are local; generic saved views preserve global filters and tab state', async () => {
    await api('createIteration', { spaceId, name: 'Lifecycle v2', startDate: '2026-11-09', endDate: '2026-11-22', taskIds: [] })
    const secondVersion = (await snapshot()).iterations.find((item) => item.name === 'Lifecycle v2').id
    await api('createTask', { spaceId, title: '待分拣筛选隔离', creatorId: owner, workKind: 'general', triagePending: true })
    await api('createTask', { spaceId, title: '版本二独立范围', creatorId: owner, workKind: 'general', iterationIds: [secondVersion] })
    await navigate('tasks'); await click('筛选', '.collab-main'); await click('Lifecycle v1', '.my-menu'); await escape()
    assert.equal(await run('return window.hifoxLifecycle.state().taskFilter.iterationId'), versionId)
    await click('未规划', '.collab-main'); await click('存为视图', '.collab-main'); await input('input[placeholder="视图名称，如：我的紧急项"]', '保留页签的视图'); await click('保存视图', '.my-menu'); await ready()
    const saved = (await snapshot()).views.find((item) => item.name === '保留页签的视图')
    assert.equal(saved.filter.iterationId, versionId)
    assert.deepEqual(saved.filter.statusIds, (await snapshot()).taskStatuses.filter((item) => item.spaceId === spaceId && item.category === 'backlog').map((item) => item.id))
    await api('saveView', { spaceId, name: '全局版本负责人视图', filter: { iterationId: versionId }, groupBy: 'assignee' })
    const grouped = (await snapshot()).views.find((item) => item.name === '全局版本负责人视图')
    await run(`window.hifoxLifecycle.state().applySavedView(${JSON.stringify(grouped.id)})`); await navigate('board')
    await click('显示', '.collab-main')
    assert.ok(await run(`return [...document.querySelectorAll('.my-menu [data-selected=true]')].some(e=>e.textContent.trim()==='负责人')`), 'generic space ignored saved grouping')
    await escape(); await navigate('triage')
    assert.ok((await run('return document.querySelector(".collab-main").innerText')).includes('待分拣筛选隔离'), 'global version hid pending triage')
    assert.equal(await run(`return [...document.querySelectorAll('.collab-main button')].find(e=>e.textContent.trim()==='存为视图').disabled`), true)
    await click('显示', '.collab-main')
    assert.ok(await run(`return [...document.querySelectorAll('.my-menu [data-selected=true]')].some(e=>e.textContent.trim()==='状态')`), 'triage inherited global saved grouping')
    await escape(); await click('筛选', '.collab-main'); await input('input[placeholder="搜索任务编号或标题"]', '接受但未排版本'); await escape(); await click('已接受 · 未排版本', '.collab-main')
    assert.ok((await run('return document.querySelector(".collab-main").innerText')).includes('接受但未排版本'))
    assert.equal(await run('return window.hifoxLifecycle.state().taskFilter.keyword'), undefined)
    assert.equal(await run('return window.hifoxLifecycle.state().activeViewId'), grouped.id)
    await navigate('iterations')
    await run(`const e=[...document.querySelectorAll('.collab-main button[aria-pressed]')].find(e=>e.querySelector('span')?.textContent==='Lifecycle v2');if(!e)throw Error('Version selector absent');e.click()`)
    await wait(`document.querySelector('section[aria-label="版本 Lifecycle v2"]')`, 'v2 scope')
    assert.ok((await run('return document.querySelector(".collab-main").innerText')).includes('版本二独立范围'), 'global v1 filter intersected v2')
    assert.equal(await run(`return [...document.querySelectorAll('.collab-main button')].find(e=>e.textContent.trim()==='存为视图').disabled`), true)
    await click('显示', '.collab-main')
    assert.ok(await run(`return [...document.querySelectorAll('.my-menu [data-selected=true]')].some(e=>e.textContent.trim()==='状态')`), 'version inherited global saved grouping')
    await escape(); await click('筛选', '.collab-main'); await input('input[placeholder="搜索任务编号或标题"]', '局部无匹配'); await escape()
    assert.ok(!(await run('return document.querySelector(".collab-main").innerText')).includes('版本二独立范围'))
    assert.equal(await run('return window.hifoxLifecycle.state().taskFilter.keyword'), undefined)
    await navigate('board')
    assert.equal(await run(`return [...document.querySelectorAll('.collab-main button')].find(e=>e.textContent.trim()==='存为视图').disabled`), false)
    assert.equal(await run('return window.hifoxLifecycle.state().taskFilter.iterationId'), versionId)
    await click('筛选', '.collab-main'); await click('清除筛选', '.my-menu'); await escape()
    assert.equal(await run('return window.hifoxLifecycle.state().taskFilter.iterationId'), undefined)
  })
  await check('direct development uses an isolated --no-start project; late prepare cannot navigate from a hidden tab', async () => {
    const made = await api('createTask', { spaceId, title: '代码开发回归', creatorId: owner, triagePending: true, workKind: 'code', acceptanceCriteria: ['保留开发计划', '逐项验证'] })
    codeId = made.taskId; const beforeAccepted = statusCalls.length; await open(codeId)
    assert.equal(statusCalls.length, beforeAccepted, 'accepted task issued premature binding queries')
    await click('接纳并安排'); await field('分配给', 'member:' + owner); await field('下一步', 'dev_ready'); await field('版本（选填）', versionId); await click('确认安排'); await ready()
    const originalChooser = dialog.showOpenDialog
    nativeRoot = null; dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    try {
      await click('开始处理')
      await wait(`!([...document.querySelectorAll('.collab-task-workflow button')].find(e=>e.textContent.trim()==='开始处理')?.disabled)`, 'cancelled preparation settled')
      assert.equal(await run(`return document.querySelector('.collab-task-workflow [role=alert]')?.textContent??null`), null, 'cancel was presented as an error')
      assert.equal((await task(codeId)).workflow.stage, 'dev_ready'); assert.equal(cliCalls().length, 0)
    } finally { nativeRoot = project; dialog.showOpenDialog = originalChooser }
    await run('await window.hifoxLifecycle.refreshNative()')
    assert.deepEqual((await run('return window.hifoxLifecycle.nativeState()')).tasks, [], 'native project must start without the prepared task')
    let release; holdPrepare = new Promise((done) => { release = done })
    const originalCalls = prepareCalls, originalTransitions = transitions
    await click('开始处理', 'dialog', true)
    await wait('true', 'click returned'); assert.equal(prepareCalls, originalCalls + 1, 'duplicate preparation admitted')
    await click('讨论'); release(); holdPrepare = null
    for (let i = 0; i < 160 && cliCalls().length === 0; i++) await settle(30)
    await settle(250)
    assert.equal(cliCalls().length, 1); assert.equal(transitions, originalTransitions, 'hidden prepare advanced workflow')
    assert.equal((await task(codeId)).workflow.stage, 'dev_ready')
    assert.equal((await run('return window.hifoxLifecycle.nativeState()')).openTaskDir, null)
    assert.ok(cliCalls()[0].includes('--no-start')); assert.ok(!cliCalls()[0].includes('--force'))
    assert.equal(readFileSync(join(project, '.trellis', '.current-task'), 'utf8'), 'existing-fixture-pointer\n')
    await click('详情')
    await wait(`!([...document.querySelectorAll('.collab-task-workflow button')].find(e=>e.textContent.trim()==='开始处理')?.disabled)`, 'prepare control recovered')
    await click('开始处理'); await wait('window.hifoxLifecycle.nativeState().taskExpandOrigin!==null', 'native task reader routing')
    const native = await run('return window.hifoxLifecycle.nativeState()')
    assert.equal(native.root, project); assert.equal(native.taskExpandOrigin.fromPage, 'hifox')
    assert.ok(native.tasks.includes(native.taskExpandOrigin.taskDir)); assert.ok(snapshotScans >= 2, 'production refresh did not rescan the temporary project')
    assert.equal((await task(codeId)).workflow.stage, 'planning'); assert.equal(cliCalls().length, 1)
    await run(`window.hifoxLifecycle.openTask(${JSON.stringify(codeId)})`)
  })
  await check('committed binding status reports missing/corrupt/material changes and rejects late replies after reassignment', async () => {
    await wait('document.querySelector(".collab-local-task")', 'initial planned binding')
    const prepared = await run(`return window.trellis.hifoxWork.status({workspaceKey:window.hifoxLifecycle.state().workspaceContext.key,taskId:${JSON.stringify(codeId)}})`)
    assert.ok(prepared.ok && prepared.prepared)
    const directory = join(fixture, 'profile', 'hifox-work', 'bindings')
    const bindingFile = join(directory, readdirSync(directory)[0]), backup = join(fixture, 'held-binding.json')
    for (const path of [bindingFile, backup]) { const rel = relative(fixture, path); assert.ok(rel && rel !== '..' && !isAbsolute(rel) && !rel.startsWith('..' + sep), 'binding fixture escaped its root') }
    renameSync(bindingFile, backup)
    try {
      await api('updateTask', { id: codeId, patch: { priority: 'high' } })
      await wait(`document.querySelector('[aria-label="本机任务绑定"][role=alert]')?.textContent.includes('未找到原本机任务绑定')`, 'missing expected binding')
      assert.equal(await run('return Boolean(document.querySelector(".collab-local-task"))'), false)
    } finally { renameSync(backup, bindingFile) }
    await click('重新核对'); await wait('document.querySelector(".collab-local-task")', 'restored binding')
    const savedBinding = readFileSync(bindingFile)
    writeFileSync(bindingFile, '{"broken"')
    try {
      await api('updateTask', { id: codeId, patch: { priority: 'medium' } })
      await wait(`document.querySelector('[aria-label="本机任务绑定"][role=alert]')`, 'corrupt binding error')
      assert.equal(await run('return Boolean(document.querySelector(".collab-local-task"))'), false)
      assert.equal(readFileSync(bindingFile, 'utf8'), '{"broken"', 'status overwrote corrupt evidence')
    } finally { writeFileSync(bindingFile, savedBinding) }
    await click('重新核对'); await wait('document.querySelector(".collab-local-task")', 'binding retry recovered')
    const originalDescription = (await task(codeId)).description ?? ''
    const prd = join(project, prepared.local.relativeDir, 'prd.md'), originalPrd = readFileSync(prd, 'utf8')
    await api('updateTask', { id: codeId, patch: { description: '已提交的需求材料变更' } })
    await wait(`document.querySelector('[aria-label="本机任务绑定"][role=status]')?.textContent.includes('任务材料已更新')`, 'material revision warning')
    assert.equal(await run('return Boolean(document.querySelector(".collab-local-task"))'), false, 'stale material kept an ordinary binding link')
    assert.equal(readFileSync(prd, 'utf8'), originalPrd, 'status rewrote native material')
    await click('审阅材料'); await wait('window.hifoxLifecycle.nativeState().taskExpandOrigin!==null&&window.hifoxLifecycle.state().openTaskId===null', 'real material review reader routing')
    await run('window.hifoxLifecycle.page("hifox")'); await open(codeId)
    await api('updateTask', { id: codeId, patch: { description: originalDescription } })
    await wait('document.querySelector(".collab-local-task")', 'material restoration verified')
    let enter, release
    const entered = new Promise((done) => { enter = done }), waitReply = new Promise((done) => { release = done })
    holdStatusReply = { enter, wait: waitReply }
    await api('updateTask', { id: codeId, patch: { priority: 'low' } }); await entered
    await api('transitionTask', { taskId: codeId, action: 'reassign', assigneeId: personId, expectedStage: 'planning', expectedUpdatedAt: (await task(codeId)).updatedAt })
    const afterTransferCalls = statusCalls.length
    release(); holdStatusReply = null; await settle(150)
    assert.equal(await run('return Boolean(document.querySelector(".collab-local-task"))'), false, 'late status revived the old handler link')
    assert.equal(await run('return Boolean(document.querySelector("[aria-label=本机任务绑定]"))'), false)
    assert.equal(statusCalls.length, afterTransferCalls, 'old handler continued querying the binding')
    await api('transitionTask', { taskId: codeId, action: 'reassign', assigneeId: owner, expectedStage: 'planning', expectedUpdatedAt: (await task(codeId)).updatedAt })
    await wait('document.querySelector(".collab-local-task")', 'current handler binding restored')
    assert.equal(cliCalls().length, 1)
  })
  await check('native opening fences actor/epoch/navigation A-B-A and accepts its own early project snapshot broadcast', async () => {
    const prepared = await run(`return window.trellis.hifoxWork.status({workspaceKey:window.hifoxLifecycle.state().workspaceContext.key,taskId:${JSON.stringify(codeId)}})`)
    assert.equal(prepared.ok, true); assert.equal(prepared.prepared, true)
    const local = prepared.local
    const context = await run('return window.hifoxLifecycle.state().workspaceContext')
    for (const kind of ['actor', 'epoch', 'navigation']) {
      await run('window.hifoxLifecycle.clearNative();await window.hifoxLifecycle.refreshNative();window.hifoxLifecycle.page("hifox")'); await open(codeId)
      const priorScans = snapshotScans
      let release; holdSnapshot = new Promise((done) => { release = done })
      await run(`window.nativeAttempt=window.hifoxLifecycle.openNative(${JSON.stringify(codeId)},${JSON.stringify(local)}).then(()=>({ok:true}),error=>({ok:false,error:String(error)}))`)
      for (let i = 0; i < 100 && snapshotScans === priorScans; i++) await settle(15)
      assert.ok(snapshotScans > priorScans, 'native opening never reached actual refresh')
      if (kind === 'navigation') await run('window.hifoxLifecycle.page("settings");window.hifoxLifecycle.page("hifox")')
      else await run(`window.hifoxLifecycle.context(${JSON.stringify(kind === 'actor' ? { ...context, actorId: personId } : { ...context, epoch: 'superseded-native-epoch' })});window.hifoxLifecycle.context(${JSON.stringify(context)})`)
      release(); holdSnapshot = null
      const reply = await run('return window.nativeAttempt'); assert.equal(reply.ok, true, reply.error)
      assert.equal((await run('return window.hifoxLifecycle.nativeState()')).openTaskDir, null, kind + ' A-B-A revived native navigation')
      assert.equal(await run('return window.hifoxLifecycle.state().localWorkOpening'), null)
    }
    await run('window.hifoxLifecycle.clearNative();window.hifoxLifecycle.page("hifox")'); await open(codeId)
    let release; holdProjectReply = new Promise((done) => { release = done })
    const beforeOpens = projectOpens
    await run(`window.nativeAttempt=window.hifoxLifecycle.openNative(${JSON.stringify(codeId)},${JSON.stringify(local)}).then(()=>({ok:true}),error=>({ok:false,error:String(error)}))`)
    await wait(`window.hifoxLifecycle.nativeState().root===${JSON.stringify(project)}`, 'early snapshot broadcast')
    assert.equal(projectOpens, beforeOpens + 1)
    assert.equal((await run('return window.hifoxLifecycle.nativeState()')).openTaskDir, null, 'reader opened before project acknowledgement')
    release(); holdProjectReply = null
    const reply = await run('return window.nativeAttempt'); assert.equal(reply.ok, true, reply.error)
    const native = await run('return window.hifoxLifecycle.nativeState()')
    assert.equal(native.page, 'hifox'); assert.equal(native.openTaskDir, local.taskDir); assert.equal(native.taskExpandOrigin.fromPage, 'hifox')
    await run('window.hifoxLifecycle.page("hifox")'); await open(codeId)
  })
  await check('testing requires each acceptance criterion; same task retains code history', async () => {
    await click('确认技术方案'); await field('实现方案与检查范围', '沿用本机计划，验证逐项标准'); await click('确认技术方案'); await ready()
    await click('交给测试'); await field('改动说明与检查结果', '隔离检查通过'); await field('下一位处理人', owner); await click('交给测试'); await ready()
    await click('测试通过'); await click('测试通过')
    assert.ok((await run('return [...document.querySelectorAll("[role=dialog]")].at(-1).innerText')).includes('请逐项确认验收标准'))
    assert.equal((await task(codeId)).workflow.stage, 'testing')
    await run(`const d=[...document.querySelectorAll('[role=dialog]')].at(-1);d.querySelectorAll('input[type=checkbox]').forEach(e=>e.click())`); await settle()
    await click('测试通过'); await ready(); await click('验收通过'); await click('验收通过'); await ready()
    const done = await task(codeId)
    assert.deepEqual(done.iterationIds, [versionId]); assert.equal(done.workflow.stage, 'done')
    assert.deepEqual(done.workflow.history.map((event) => event.action), ['arrange', 'begin_development', 'reassign', 'reassign', 'approve_plan', 'submit_test', 'pass_test', 'accept_delivery'])
    assert.deepEqual(done.workflow.history.find((event) => event.action === 'pass_test').checkedCriteria, ['保留开发计划', '逐项验证'])
    await close()
  })
  await check('version close blocks unfinished scope and closes without rollover after completion', async () => {
    const pending = await api('createTask', { spaceId, title: '截版前必须处理', creatorId: owner, workKind: 'general', iterationIds: [versionId] })
    await api('updateIteration', { id: versionId, status: 'active' }); await navigate('iterations'); await click('截版', '.collab-main')
    assert.equal(await run(`return [...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='确认截版').disabled`), true)
    assert.equal((await snapshot()).iterations.length, 2, 'only the two explicitly created versions may exist')
    await click('取消'); await open(pending.taskId); await click('更多流程操作'); await click('不采纳', '.my-root'); await field('不采纳原因', '本版本不再需要此项工作'); await click('不采纳'); await ready(); await close()
    await click('截版', '.collab-main'); await click('确认截版'); await ready()
    const closed = (await snapshot()).iterations.find((item) => item.id === versionId)
    assert.equal(closed.status, 'completed'); assert.equal((await snapshot()).iterations.length, 2, 'closing must not manufacture a rollover version')
    assert.ok(closed.taskIds.includes(codeId) && closed.taskIds.includes(generalId))
  })
  await check('shared detail geometry keeps original native IssuePeek readable in narrow/dark/large UI', async () => {
    const native = scanProject(project); await run(`await window.hifoxLifecycle.refreshNative();window.hifoxLifecycle.nativeIssue(${JSON.stringify(native.tasks[0].dirName)})`)
    await wait('document.querySelector("[aria-label=工作项快速预览]")', 'original native preview')
    for (const theme of ['light', 'dark']) {
      w.setContentSize(760, 650); await run(`window.hifoxLifecycle.appearance(${JSON.stringify(theme)},'large')`); await settle(300)
      const box = await run(`const d=document.querySelector('[aria-label=工作项快速预览]'),b=d.getBoundingClientRect();return {width:b.width,height:b.height,x:b.x,y:b.y,sw:d.scrollWidth,cw:d.clientWidth,header:d.querySelector('input[placeholder=工作项标题]')?.getBoundingClientRect().height,aside:d.querySelector('aside').clientHeight}`)
      assert.ok(box.x >= 0 && box.y >= 0 && box.width <= 760 && box.height <= 650, 'native preview escaped viewport')
      assert.ok(box.sw <= box.cw + 1 && box.header > 0 && box.aside > 0, 'native preview geometry collapsed')
      w.setContentSize(761, 650); await settle(40); w.setContentSize(760, 650); w.webContents.invalidate(); await settle(260)
      await run('await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      writeFileSync(join(reportDir, 'native-preview-' + theme + '.png'), (await w.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
    }
  })
  await check('actual MyApp invalidates a business lease when native B is selected and preserves two-set return semantics', async () => {
    const native = scanProject(project), nativeA = native.tasks[0].dirName, nativeB = 'fixture-native-B'
    mkdirSync(join(project, '.trellis', 'tasks', nativeB))
    writeFileSync(join(project, '.trellis', 'tasks', nativeB, 'task.json'), JSON.stringify({ id: nativeB, title: 'Independent native task B', status: 'planning' }))
    await run('await window.hifoxLifecycle.refreshNative();window.hifoxLifecycle.shell()')
    await wait('document.querySelector(".my-shell-layout")', 'actual MyApp mounted'); await settle(150)
    const switched = await run(`return window.hifoxLifecycle.returnLease(${JSON.stringify(codeId)},${JSON.stringify(nativeA)},${JSON.stringify(nativeB)})`)
    assert.equal(switched.leaseClearedAtSelection, true, 'selecting B retained the business A lease')
    assert.equal(switched.returned.taskDir, nativeB); assert.equal(switched.selected, nativeB)
    await settle(120)
    assert.equal(await run('return window.hifoxLifecycle.state().openTaskId'), null, 'B return reopened the old business task')
    const original = await run(`return window.hifoxLifecycle.returnLease(${JSON.stringify(codeId)},${JSON.stringify(nativeA)},null)`)
    assert.equal(original.returned.taskDir, nativeA)
    await wait(`window.hifoxLifecycle.state().openTaskId===${JSON.stringify(codeId)}`, 'ordinary A lease restored business source')
    assert.equal(await run('return window.hifoxLifecycle.nativeState().openTaskDir'), null)
    assert.equal(await run('return window.hifoxLifecycle.state().workReturn'), null)
    await close()
  })
  assert.deepEqual(errors, [], 'renderer console errors')
  const disk = JSON.parse(readFileSync(join(process.env.HIFOX_STORE_DIR, 'store.json'), 'utf8'))
  assert.deepEqual(JSON.parse(JSON.stringify(await snapshot())), disk)
  writeFileSync(join(reportDir, 'summary.json'), JSON.stringify({ status: 'passed', fixture, project, checks, prepareCalls, statusCalls: statusCalls.length, transitions, snapshotScans, projectOpens, cliCalls: cliCalls().length, rendererErrors: errors, notRun: ['full native reader contents and saved-page restoration', 'remote multi-user authorization', 'real SMTP/GitLab/intranet', 'DPI/screen-reader/physical IME'] }, null, 2))
  console.log('HIFOX_LIFECYCLE_UI_PASSED ' + checks.length)
  w.destroy(); app.quit()
}).catch(async (error) => {
  writeFileSync(join(reportDir, 'failure.json'), JSON.stringify({ phase, error: error.stack, checks, errors, text: w && !w.isDestroyed() ? await run('return document.body.innerText').catch(String) : null }, null, 2))
  if (w && !w.isDestroyed()) { writeFileSync(join(reportDir, 'failure.png'), (await w.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); w.destroy() }
  console.error('HIFOX_LIFECYCLE_UI_FAILED ' + phase + '\n' + error.stack)
  app.exit(1)
})
