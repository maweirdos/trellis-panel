/** Real collaboration pages, preload IPC, domain services and disk in isolated Electron. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'tpanel-hifox-ui-')))
const require = createRequire(import.meta.url)
const repo = process.cwd().replaceAll('\\', '/')
let server

async function scenario(win) {
  const evaluate = async (fn, ...args) => {
    const result = await win.webContents.executeJavaScript(`(async()=>{try{return await (${fn.toString()})(...${JSON.stringify(args)})}catch(error){return{__fixtureError:error.message,stack:error.stack}}})()`)
    if (result?.__fixtureError) throw Error(result.__fixtureError + '\n' + result.stack + '\n' + fn.toString() + '\nArguments: ' + JSON.stringify(args))
    return result
  }
  const wait = async (fn, label) => {
    for (let attempt = 0; attempt < 300; attempt++) { if (await fn()) return; await new Promise((done) => setTimeout(done, 30)) }
    throw new Error(`timeout: ${label}; ${await evaluate(() => JSON.stringify({ text: document.body.innerText.slice(-2800), errors: window.__errors, toasts: window.__toasts() }))}`)
  }
  const ready = () => wait(() => evaluate(() => !window.__hifox.getState().busy), 'mutation settled')
  const click = async (text, scope = 'dialog') => evaluate((label, scope) => {
    const root = scope === 'dialog' ? [...document.querySelectorAll('[role=dialog]')].at(-1) : document.querySelector(scope)
    const button = [...(root?.querySelectorAll('button') ?? [])].find((item) => item.getClientRects().length && !item.closest('[hidden]') && (item.textContent.trim() === label || [...item.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim() === label || item.getAttribute('aria-label') === label))
    if (!button || button.disabled || button.closest('fieldset:disabled')) throw new Error(`Unavailable button ${label}`)
    button.focus(); button.click()
  }, text, scope)
  const field = async (label, value, scope = 'dialog') => evaluate((label, value, scope) => {
    const root = scope === 'dialog' ? [...document.querySelectorAll('[role=dialog]')].at(-1) : document.querySelector(scope)
    const item = [...(root?.querySelectorAll('label') ?? [])].find((candidate) => candidate.textContent.trim() === label)
    const control = item?.control ?? [...(root?.querySelectorAll('input,textarea,select') ?? [])].find((control) => control.getAttribute('aria-label') === label)
    if (!control || !control.getClientRects().length || control.closest('[hidden]') || control.disabled || control.closest('fieldset:disabled')) throw new Error(`Unavailable field ${label}`)
    const proto = control.tagName === 'SELECT' ? HTMLSelectElement.prototype : control.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(control, value)
    control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }, label, value, scope)
  const navigate = async (label, module) => {
    if (module === 'board') { await navigate('任务', 'tasks'); await click('布局：看板', '[data-hifox-module]'); return }
    for (const selector of ['.collab-nav-space-toggle[aria-expanded="false"]', '.collab-nav-disclosure[aria-expanded="false"]']) {
      await evaluate((selector) => { const space = document.querySelector(`[data-nav-space="${window.__hifox.getState().currentSpaceId}"]`); space?.querySelectorAll(selector).forEach((button) => button.click()) }, selector)
    }
    await evaluate((id, label) => {
      const spaceId = window.__hifox.getState().currentSpaceId
      const button = [...document.querySelectorAll('[aria-label="协作模块"] [data-hifox-route]')].find((item) => item.dataset.hifoxRoute === id && (!item.dataset.spaceId || item.dataset.spaceId === spaceId))
      if (!button || !button.getClientRects().length) throw Error(`Unavailable navigation ${label} in ${spaceId}: ${JSON.stringify([...document.querySelectorAll('[aria-label="协作模块"] button')].map((item) => ({ route: item.dataset.hifoxRoute, space: item.dataset.spaceId, label: item.getAttribute('aria-label'), expanded: item.getAttribute('aria-expanded'), visible: item.getClientRects().length })))}`)
      button.focus(); button.click()
    }, module, label)
    await wait(() => evaluate((id) => document.querySelector('[data-hifox-module]')?.dataset.hifoxModule === id, module), module)
  }
  const dialog = (label) => wait(() => evaluate((label) => [...document.querySelectorAll('[role=dialog]')].some((item) => item.getAttribute('aria-label') === label), label), label)
  const snapshot = () => evaluate(() => window.__hifox.getState().snapshot)
  const task = async (id) => (await snapshot()).tasks.find((item) => item.id === id)
  const api = async (name, input) => {
    const result = await evaluate(async (name, input) => { const result = await window.trellis.hifox[name](input); if (result.ok) await window.__hifox.getState().bootstrap(); return result }, name, input)
    assert.equal(result.ok, true, result.error)
    return result
  }
  const closeTask = async () => { await click('关闭详情'); await wait(() => evaluate(() => !window.__hifox.getState().openTaskId), 'drawer closed') }
  const details = async () => { await click('详情'); await wait(() => evaluate(() => !document.querySelector('[aria-label="任务详情"]').hidden), 'detail tab') }
  const allocation = async (text) => {
    await evaluate(() => { const root = [...document.querySelectorAll('[role=dialog]')].at(-1); const button = root.querySelector('button[aria-label^="分工："]'); if (!button || button.disabled) throw Error('Unavailable allocation'); button.click() })
    await click(text, '.my-menu')
  }
  const more = async () => evaluate(() => { const root = [...document.querySelectorAll('[role=dialog]')].at(-1); const summary = [...root.querySelectorAll('summary')].find((item) => item.textContent === '更多属性'); if (summary && !summary.parentElement.open) summary.click() })
  const openTask = async (id) => {
    await evaluate((id) => { const row = [...document.querySelectorAll('[data-row-idx]')].find((item) => item.textContent.includes(id)); if (!row) throw Error(`Missing native row ${id}`); row.click() }, id)
    await wait(() => evaluate((id) => window.__hifox.getState().openTaskId === id, id), 'native row opens collaboration task')
  }
  const escape = async () => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await new Promise((done) => setTimeout(done, 80)) }
  const checkpoint = (label) => console.log(`PASS ${label}`)

  await wait(() => evaluate(() => Boolean(window.__hifox?.getState().snapshot)), 'bootstrap')
  await navigate('专项', 'projects')
  await click('新建专项', '[data-hifox-module]'); await dialog('新建专项')
  await field('专项名称', 'Smoke project'); await field('专项目标', 'Deliver collaboration workflow')
  assert.ok(await evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('[role=dialog] fieldset')).paddingLeft) >= 16), 'modal content padding')
  await evaluate(() => [...document.querySelectorAll('[role=dialog] label')].find((item) => item.textContent.trim() === '林晓').querySelector('input').click())
  await click('创建专项'); await ready()
  let data = await snapshot()
  const project = data.projects.find((item) => item.name === 'Smoke project')
  assert.deepEqual(project.ownerIds, ['m-lin'])
  await click('编辑目标', '[aria-label="专项 Smoke project"]'); await dialog('编辑专项')
  await evaluate(() => [...document.querySelectorAll('[role=dialog] label')].find((item) => item.textContent.trim() === '赵启').querySelector('input').click())
  await click('保存专项'); await ready()
  assert.deepEqual((await snapshot()).projects.find((item) => item.id === project.id).ownerIds, ['m-lin', 'm-zhao'])
  checkpoint('project creation and responsibility editing use persisted IPC')

  await navigate('版本', 'iterations')
  const createVersion = async (name, start, end) => {
    await click('新建版本', '[data-hifox-module]'); await dialog('新建版本')
    await field('版本名称', name); await field('交付目标（选填）', `${name} goal`); await field('开始日期', start); await field('结束日期', end)
    await click('创建'); await ready()
    return (await snapshot()).iterations.find((item) => item.name === name)
  }
  const first = await createVersion('Smoke v1', '2030-01-01', '2030-01-14')
  const second = await createVersion('Smoke v2', '2030-01-15', '2030-01-28')
  await navigate('全部任务', 'tasks')
  await click('新建任务', '[data-hifox-module]'); await dialog('新建待分拣任务')
  data = await snapshot()
  const bug = data.taskTypes.find((item) => item.spaceId === 'sp-eng' && item.name === 'Bug')
  const status = (category) => data.taskStatuses.find((item) => item.spaceId === 'sp-eng' && item.category === category).id
  await field('标题', 'Native form creation'); await field('描述', 'Original context'); await field('验收标准', 'Persist all selected properties'); await field('工作内容', 'general'); await field('类型', bug.id); await field('优先级', 'high')
  await more(); await allocation('林晓'); await allocation('赵启'); await allocation('Agent · 前端修复'); await field('专项', project.id)
  await click('创建任务'); await ready()
  const native = (await snapshot()).tasks.find((item) => item.title === 'Native form creation')
  assert.deepEqual(native.assigneeIds, ['m-lin', 'm-zhao']); assert.equal(native.executor.id, 'ag-fe'); assert.equal(native.projectId, project.id); assert.deepEqual(native.iterationIds, []); assert.equal(native.triagePending, true); assert.equal(native.workKind, 'general'); assert.equal(native.dispatch, undefined)
  await closeTask()
  checkpoint('native task form persists type, priority, multiple people, independent executor and defaults unversioned work to triage')

  // Omitted workKind intentionally exercises the supported legacy record/property rail.
  const parentId = (await api('createTask', { spaceId: 'sp-eng', title: 'Smoke parent', description: 'Legacy context', statusId: status('todo'), triagePending: false })).taskId
  await openTask(parentId)
  await field('类型', bug.id); await ready(); await field('优先级', 'high'); await ready(); await allocation('林晓'); await ready(); await allocation('赵启'); await ready(); await allocation('Agent · 前端修复'); await ready(); await field('专项', project.id); await ready(); await field('版本', first.id); await ready()
  let parent = await task(parentId)
  assert.deepEqual(parent.assigneeIds, ['m-lin', 'm-zhao']); assert.equal(parent.executor.id, 'ag-fe'); assert.equal(parent.projectId, project.id); assert.deepEqual(parent.iterationIds, [first.id]); assert.equal(parent.dispatch.status, 'waiting_runtime')
  await click('编辑标题'); await field('标题', 'Smoke parent edited'); await click('保存标题'); await ready()
  await click('编辑描述'); await field('任务描述', 'Acceptance context'); await click('保存描述'); await ready()
  assert.equal((await task(parentId)).description, 'Acceptance context')
  await field('状态', status('in_review')); await ready(); assert.equal((await task(parentId)).dispatch, undefined)
  await field('状态', status('blocked')); await ready(); assert.equal((await task(parentId)).statusId, status('blocked')); assert.equal((await task(parentId)).dispatch, undefined)
  await field('状态', status('done')); await ready(); assert.ok((await task(parentId)).completedAt)
  checkpoint('legacy property rail preserves edit/status/assignment semantics and review/block/done suppress Runtime dispatch')

  await click('讨论'); await field('发表评论', 'Smoke discussion'); await click('发送评论'); await ready()
  const discussion = (await snapshot()).comments.find((item) => item.taskId === parentId && item.body === 'Smoke discussion')
  await click('回复', `[data-comment-id="${discussion.id}"]`)
  await field('发表评论', 'Reply @赵'); await click('@赵启'); await click('发送评论'); await ready()
  const reply = (await snapshot()).comments.find((item) => item.parentId === discussion.id)
  assert.equal(reply.authorId, 'm-lin'); assert.ok(reply.mentions.includes('m-zhao'))
  assert.ok(await evaluate((id) => document.querySelector(`[data-comment-id="${id}"]`).textContent.includes('回复 林晓：Smoke discussion'), reply.id))
  await click('标记解决', `[data-comment-id="${discussion.id}"]`); await ready(); assert.equal((await snapshot()).comments.find((item) => item.id === discussion.id).resolved, true)
  await click('重新打开', `[data-comment-id="${discussion.id}"]`); await ready(); assert.equal(Boolean((await snapshot()).comments.find((item) => item.id === discussion.id).resolved), false)
  await click('回复', `[data-comment-id="${discussion.id}"]`); await click('取消回复')
  checkpoint('discussion tab retains reply context, member mentions, resolve and reopen')

  await details(); await click('新建子任务'); await dialog('新建子任务'); await field('标题', 'Cancelled draft'); await escape()
  assert.equal(await evaluate(() => document.querySelectorAll('[role=dialog]').length), 1, 'Escape closes only nested creation')
  await click('新建子任务'); await dialog('新建子任务')
  assert.equal(await evaluate(() => [...document.querySelectorAll('[role=dialog]')].at(-1).querySelector('input').value), 'Cancelled draft', 'cancel retains user draft')
  await click('放弃草稿'); await click('新建子任务'); await dialog('新建子任务')
  assert.equal(await evaluate(() => [...document.querySelectorAll('[role=dialog]')].at(-1).querySelector('input').value), '', 'explicit discard clears draft')
  await field('标题', 'Smoke child'); await field('工作内容', 'general'); await field('验收标准', 'Child evidence retained'); await more(); await allocation('林晓'); await click('创建任务'); await ready()
  const childId = (await snapshot()).tasks.find((item) => item.title === 'Smoke child').id
  assert.equal((await task(childId)).parentTaskId, parentId); assert.deepEqual((await task(childId)).iterationIds, [first.id])
  assert.equal(await evaluate(() => document.querySelector('[aria-label="任务详情"] h2').textContent), 'Smoke child', 'navigation shows current task content')
  await click(`打开父任务 ${parentId}`)
  await wait(() => evaluate(() => document.querySelector('[aria-label="任务详情"] h2')?.textContent === 'Smoke parent edited'), 'parent navigation')
  await click('添加关联任务'); await field('搜索关联任务', 'ENG-101'); await field('关联类型', 'blocks'); await field('关联任务', 'ENG-101'); await click('添加关联'); await ready()
  assert.ok((await task(parentId)).relations.some((item) => item.taskId === 'ENG-101'))
  await evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((item) => item.textContent.startsWith('ENG-101 ·')).click())
  await wait(() => evaluate(() => window.__hifox.getState().openTaskId === 'ENG-101'), 'relation navigation')
  assert.ok(await evaluate(() => document.querySelector('[role=dialog]').textContent.includes('受阻于')), 'inverse blocking relation')
  await closeTask()
  checkpoint('subtask inheritance, retained/discarded drafts, parent and directional relation navigation')

  await navigate('任务看板', 'board'); await click('显示', '[data-hifox-module]'); await click('负责人', '.my-menu'); await escape()
  await wait(() => evaluate(() => [...document.querySelectorAll('.my-card')].filter((item) => item.textContent.includes('Smoke parent edited')).length === 2), 'multiple-person board membership')
  assert.equal((await snapshot()).tasks.filter((item) => item.id === parentId).length, 1, 'board copies keep one persisted task')
  assert.ok(await evaluate(() => [...document.querySelectorAll('.my-card')].filter((item) => item.textContent.includes('Smoke parent edited')).every((item) => !item.draggable)), 'collaboration board cannot bypass workflow through native drag mutation')
  await click('筛选', '[data-hifox-module]'); await click(data.taskStatuses.find((item) => item.id === status('in_review')).name, '.my-menu'); await escape()
  await click('存为视图', '[data-hifox-module]')
  await evaluate(() => { const item = document.querySelector('.my-menu input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(item, 'Smoke review view'); item.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('保存视图', '.my-menu'); await ready()
  const view = (await snapshot()).views.find((item) => item.name === 'Smoke review view')
  assert.deepEqual(view.filter.statusIds, [status('in_review')]); assert.equal(view.groupBy, 'assignee')
  await click('筛选', '[data-hifox-module]'); await click('清除筛选', '.my-menu'); await escape()
  await navigate('视图', 'views'); await click('Smoke review view', '[data-hifox-module]')
  await wait(() => evaluate((id) => window.__hifox.getState().taskFilter.statusIds?.[0] === id, status('in_review')), 'saved filter reapplied')
  await click('筛选', '[data-hifox-module]'); await click('清除筛选', '.my-menu'); await escape()
  await click('布局：列表', '[data-hifox-module]')
  checkpoint('native board membership, lifecycle mutation boundary and saved status/group filters')

  await navigate('版本', 'iterations'); await evaluate(() => [...document.querySelectorAll('[data-hifox-module] button')].find((item) => item.querySelector('[role=progressbar]')?.getAttribute('aria-label') === 'Smoke v1 完成进度').click())
  await click('编辑版本范围与目标', '[aria-label="版本 Smoke v1"]'); await dialog('编辑版本'); await field('交付目标（选填）', 'Edited delivery goal'); await field('结束日期', '2030-01-13')
  await evaluate((id) => [...document.querySelectorAll('[role=dialog] li label')].find((item) => item.textContent.includes(id)).querySelector('input').click(), childId)
  await click('保存'); await ready()
  assert.equal((await snapshot()).iterations.find((item) => item.id === first.id).endDate, '2030-01-13'); assert.deepEqual((await task(childId)).iterationIds, [])
  await click('编辑版本范围与目标', '[aria-label="版本 Smoke v1"]'); await dialog('编辑版本')
  await evaluate((id) => [...document.querySelectorAll('[role=dialog] li label')].find((item) => item.textContent.includes(id)).querySelector('input').click(), childId)
  await click('保存'); await ready(); await click('开始版本', '[aria-label="版本 Smoke v1"]'); await ready(); await click('截版', '[aria-label="版本 Smoke v1"]'); await dialog('截版')
  assert.ok(await evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((item) => item.textContent === '确认截版').disabled), 'unfinished scope blocks closing')
  const before = await snapshot(), rejected = await evaluate((id) => window.trellis.hifox.completeIteration({ id }), first.id)
  assert.equal(rejected.ok, false); assert.match(rejected.error, /未完成/); assert.deepEqual(await snapshot(), before)
  await click('取消'); await navigate('全部任务', 'tasks'); await openTask(childId)
  await click('提交交付成果'); await dialog('提交交付成果'); await field('产出链接或交付说明', 'Child delivery evidence'); await field('下一位处理人', 'm-lin'); await click('提交交付成果'); await ready()
  assert.equal((await task(childId)).workflow.stage, 'acceptance'); assert.equal((await task(childId)).dispatch, undefined)
  await click('验收通过'); await dialog('验收通过'); await click('验收通过'); await ready(); assert.ok((await task(childId)).completedAt); await closeTask()
  await navigate('版本', 'iterations'); await evaluate(() => [...document.querySelectorAll('[data-hifox-module] button')].find((item) => item.querySelector('[role=progressbar]')?.getAttribute('aria-label') === 'Smoke v1 完成进度').click())
  await click('截版', '[aria-label="版本 Smoke v1"]'); await click('确认截版'); await ready()
  data = await snapshot()
  assert.equal(data.iterations.find((item) => item.id === first.id).status, 'completed'); assert.deepEqual((await task(parentId)).iterationIds, [first.id]); assert.deepEqual((await task(childId)).iterationIds, [first.id]); assert.deepEqual(data.iterations.find((item) => item.id === second.id).taskIds, [])
  const closed = await evaluate((id) => window.trellis.hifox.updateTask({ id, patch: { iterationIds: [] } }), childId)
  assert.equal(closed.ok, false); assert.match(closed.error, /已关闭版本/); assert.deepEqual(await snapshot(), data)
  checkpoint('version scope editing, unfinished rejection, general delivery and immutable closed scope without rollover')

  await navigate('分拣台', 'triage'); await click('新建任务', '[data-hifox-module]'); await dialog('新建待分拣任务'); await field('标题', 'Smoke triage'); await field('工作内容', 'general'); await click('创建任务'); await ready()
  const triageId = (await snapshot()).tasks.find((item) => item.title === 'Smoke triage').id
  assert.equal((await task(triageId)).triagePending, true)
  await field('优先级', 'high'); await ready(); await click('先接纳'); await ready(); assert.equal(Boolean((await task(triageId)).triagePending), false); await closeTask()
  await click('已接受 · 未排版本', '[data-hifox-module]')
  await wait(() => evaluate((id) => [...document.querySelectorAll('[data-row-idx]')].some((item) => item.textContent.includes(id)), triageId), 'accepted unversioned backlog visible')
  checkpoint('explicit triage, priority edit and accepted unversioned backlog remain visible')

  const retryParent = (await api('createTask', { spaceId: 'sp-eng', title: 'Retry parent', triagePending: false })).taskId
  await navigate('全部任务', 'tasks'); await click('新建任务', '[data-hifox-module]'); await dialog('新建待分拣任务'); await field('标题', 'Smoke preserved retry'); await field('工作内容', 'general'); await more(); await field('父任务', retryParent)
  const removed = await evaluate((id) => window.trellis.hifox.removeTask({ id }), retryParent); assert.equal(removed.ok, true)
  await click('创建任务'); await ready()
  await wait(() => evaluate(() => Boolean(document.querySelector('[role=dialog] [role=alert]'))), 'stale parent error shown')
  assert.deepEqual(await evaluate(() => window.__toasts().map(({ kind, title, body }) => ({ kind, title, body }))), [{ kind: 'error', title: '新建任务', body: '任务不存在' }], 'only the expected stale-parent failure is reported')
  assert.equal(await evaluate(() => document.querySelector('[role=dialog] input').value), 'Smoke preserved retry', 'failed create retains draft')
  assert.equal((await snapshot()).tasks.some((item) => item.title === 'Smoke preserved retry'), false)
  await field('父任务', ''); await click('创建任务'); await ready()
  assert.ok((await snapshot()).tasks.some((item) => item.title === 'Smoke preserved retry')); await evaluate(() => window.__dismissToasts()); await closeTask()
  checkpoint('actual stale-parent failure preserves draft and supports successful retry')

  assert.deepEqual(await evaluate(() => window.__errors), [], 'no renderer exceptions')
  assert.deepEqual(await evaluate(() => window.__toasts()), [], 'no hidden IPC failures')
  await new Promise((done) => { win.webContents.once('did-finish-load', done); win.webContents.reload() })
  await wait(() => evaluate(() => window.__hifox?.getState().snapshot?.tasks.some((item) => item.title === 'Smoke parent edited')), 'disk persistence after full reload')
  checkpoint('real persistence survives renderer reload without errors')
}

try {
  writeFileSync(join(directory, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>')
  writeFileSync(join(directory, 'fixture.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{HiFoxApp}from'/@fs/${repo}/src/renderer/src/hifox/HiFoxApp.tsx';import{dispatchEscKey}from'/@fs/${repo}/src/renderer/src/utils/esc-layer.ts';import{DialogHost}from'/@fs/${repo}/src/renderer/src/components/Dialogs.tsx';import{useHifox}from'/@fs/${repo}/src/renderer/src/hifox/store.ts';import{useApp}from'/@fs/${repo}/src/renderer/src/store/index.ts';import'/@fs/${repo}/src/renderer/src/my/my.css';import'/@fs/${repo}/src/renderer/src/styles.css';window.addEventListener('keydown',event=>{if(event.key==='Escape'&&dispatchEscKey()){event.preventDefault();event.stopPropagation()}});window.__hifox=useHifox;window.__toasts=()=>useApp.getState().toasts;window.__dismissToasts=()=>useApp.getState().toasts.forEach(item=>useApp.getState().dismissToast(item.id));window.__errors=[];window.addEventListener('error',event=>window.__errors.push(String(event.error??event.message)));window.addEventListener('unhandledrejection',event=>window.__errors.push(String(event.reason)));createRoot(document.getElementById('root')).render(<div className="my-root" data-my-theme="light" style={{height:'100vh',display:'flex'}}><HiFoxApp/><DialogHost/></div>);`)
  server = await createServer({ root: directory, configFile: false, cacheDir: join(directory, '.vite'), logLevel: 'error', plugins: [react()],
    resolve: { alias: [{ find: '@shared', replacement: resolve('src/shared') }, { find: 'react-dom', replacement: resolve('node_modules/react-dom') }, { find: 'react', replacement: resolve('node_modules/react') }] },
    css: { postcss: resolve('.') }, server: { host: '127.0.0.1', port: 0, fs: { allow: [directory, process.cwd()] } } })
  await server.listen()
  const address = server.httpServer.address()
  const url = `http://127.0.0.1:${address.port}`
  const preload = join(directory, 'preload.cjs')
  await build({ entryPoints: ['src/preload/index.ts'], outfile: preload, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const main = join(directory, 'main.cjs')
  await build({ stdin: { contents: `import assert from'node:assert/strict';import{app,BrowserWindow}from'electron';import{registerHifoxIpc}from'./src/main/ipc/hifox';import{resetDemoSnapshot}from'./src/main/services/hifox/store';app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.disableHardwareAcceleration();app.whenReady().then(async()=>{resetDemoSnapshot();registerHifoxIpc();const win=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false}});try{await win.loadURL(${JSON.stringify(url)});await(${scenario.toString()})(win);app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}});setTimeout(()=>{console.error('UI smoke timed out');app.exit(1)},90000);`, resolveDir: process.cwd(), loader: 'ts' }, outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const env = { ...process.env, HIFOX_STORE_DIR: join(directory, 'data') }; delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done, reject) => {
    const child = spawn(require('electron'), [main, '--no-sandbox'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron smoke exceeded 95s')) }, 95000)
    let output = '', errors = ''
    child.stdout.on('data', (bytes) => { output += String(bytes); process.stdout.write(bytes) })
    child.stderr.on('data', (bytes) => { errors += String(bytes) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? done() : reject(new Error(output + errors)) })
  })
} finally {
  await server?.close()
  assert.equal(dirname(resolve(directory)), realpathSync.native(tmpdir()))
  assert.ok(basename(directory).startsWith('tpanel-hifox-ui-'))
  rmSync(directory, { recursive: true, force: true })
}
