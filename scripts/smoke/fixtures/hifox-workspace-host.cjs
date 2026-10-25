const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createElement } = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const lucide = require('lucide-react')
const neutralGlyphs = {
  overview: 'Boxes', spaces: 'Wrench', members: 'Users', agents: 'Bot', crews: 'Users2',
  skills: 'Sparkles', tasks: 'ListTodo', board: 'KanbanSquare', inbox: 'Inbox', triage: 'Filter',
  projects: 'Layers', iterations: 'CalendarRange', automations: 'Workflow', review: 'ClipboardCheck',
  done: 'CircleCheck', blocked: 'CircleAlert', backlog: 'CircleDashed', todo: 'Circle',
  in_progress: 'CircleDot', cancelled: 'CircleX', relation: 'Link2', comment: 'MessageSquare',
  activity: 'Activity', reports: 'FileText'
}
const priorityGlyphs = { urgent: 'CircleAlert', high: 'SignalHigh', medium: 'SignalMedium', low: 'SignalLow', none: 'Minus' }
const originalGlyph = (name) => renderToStaticMarkup(createElement(lucide[name])).replace(/^<svg[^>]*>|<\/svg>$/g, '')
const originalGeometry = Object.fromEntries([...new Set([...Object.values(neutralGlyphs), ...Object.values(priorityGlyphs)])].map((name) => [name, originalGlyph(name)]))
const fixture = process.env.HIFOX_WORKSPACE_FIXTURE
const reportDir = process.env.HIFOX_WORKSPACE_REPORT
const root = process.env.HIFOX_WORKSPACE_ROOT
if (!fixture || !reportDir || !root || process.env.HIFOX_STORE_DIR !== join(fixture, 'store')) throw Error('Missing isolated HiFox fixture paths')
mkdirSync(join(fixture, 'profile'), { recursive: true })
app.setPath('userData', join(fixture, 'profile'))
const { registerHifoxIpc } = require(join(fixture, 'hifox-ipc.cjs'))
registerHifoxIpc()
app.commandLine.appendSwitch('force-prefers-reduced-motion')
const checks = [], errors = [], measurements = [], screenshots = [], allocationFocus = []
let w
let phase = 'startup'
const run = async (code) => {
  const result = await w.webContents.executeJavaScript(`(async()=>{try{return await eval(${JSON.stringify(code)})}catch(error){return{__hifoxFixtureError:error.message,stack:error.stack}}})()`, true)
  if (result?.__hifoxFixtureError) throw Error(result.__hifoxFixtureError + '\n' + result.stack)
  return result
}
const settle = (ms = 90) => new Promise((done) => setTimeout(done, ms))
const wait = async (code, label, ms = 6500) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await run(code)) return; await settle(35) }
  throw Error('Renderer timeout: ' + label)
}
const check = async (name, action) => {
  phase = name
  await action()
  checks.push({ name, status: 'passed' })
  console.log('PASS ' + name)
}
const snapshot = () => run('window.hifoxFixture.state().snapshot')
const click = async (text, scope = '.collab-main') => {
  await run(`(()=>{const p=document.querySelector(${JSON.stringify(scope)});if(!p)throw Error('Missing scope '+${JSON.stringify(scope)});const b=[...p.querySelectorAll('button')].find(e=>e.getClientRects().length&&(e.textContent.trim()===${JSON.stringify(text)}||[...e.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)}));if(!b)throw Error('Missing button '+${JSON.stringify(text)});if(b.disabled)throw Error('Disabled button '+${JSON.stringify(text)});b.focus();b.click()})()`)
  await settle()
}
const field = async (label, value, scope = '[role=dialog]') => {
  await run(`(()=>{const p=document.querySelector(${JSON.stringify(scope)});if(!p)throw Error('Missing field scope');const l=[...p.querySelectorAll('label')].find(e=>e.textContent.trim()===${JSON.stringify(label)});const e=l?.control??[...p.querySelectorAll('input,textarea,select')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e||e.disabled||e.closest('fieldset:disabled')||!e.getClientRects().length)throw Error('Missing field '+${JSON.stringify(label)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`)
  await settle()
}
const checkbox = async (text, scope = '[role=dialog]') => {
  await run(`(()=>{const p=document.querySelector(${JSON.stringify(scope)}),l=[...p.querySelectorAll('label')].find(e=>e.textContent.includes(${JSON.stringify(text)})&&e.querySelector('input[type=checkbox]'));if(!l)throw Error('Missing checkbox '+${JSON.stringify(text)});l.querySelector('input').click()})()`)
  await settle()
}
const control = async (selector, value) => {
  await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`)
  await settle()
}
const moreProperties = async () => {
  await run(`(()=>{const dialog=[...document.querySelectorAll('[role=dialog]')].at(-1);const summary=[...dialog.querySelectorAll('summary')].find(summary=>summary.textContent==='更多属性');if(summary&&!summary.parentElement.open)summary.click()})()`)
  await settle()
}
const openAllocation = async () => {
  await run(`(()=>{const dialog=[...document.querySelectorAll('[role=dialog]')].at(-1);const button=dialog.querySelector('button[aria-label^="分工："]');if(!button||button.disabled)throw Error('Allocation unavailable');button.click()})()`)
  await settle()
}
const allocate = async (label) => { await openAllocation(); await click(label, '.my-menu') }
const navigate = async (label, id) => {
  if (id === 'board') { await navigate('任务', 'tasks'); await click('布局：看板'); return }
  await run(`(()=>{const entry=window.hifoxFixture.modules.find(entry=>entry.id===${JSON.stringify(id)});const nav=document.querySelector('nav[aria-label="协作模块"]');const space=entry.scope==='space'?nav.querySelector('[data-nav-space="'+window.hifoxFixture.state().currentSpaceId+'"]'):null;const disclosure=space?.querySelector('.collab-nav-space-toggle[aria-expanded="false"]');if(disclosure)disclosure.click()})()`)
  await settle()
  await run(`(()=>{const entry=window.hifoxFixture.modules.find(entry=>entry.id===${JSON.stringify(id)});const nav=document.querySelector('nav[aria-label="协作模块"]');const space=entry.scope==='space'?nav.querySelector('[data-nav-space="'+window.hifoxFixture.state().currentSpaceId+'"]'):null;const disclosure=entry.parent&&space?.querySelector('[data-nav-branch="'+entry.parent+'"] .collab-nav-disclosure[aria-expanded="false"]');if(disclosure)disclosure.click();if(entry.group==='配置')space?.querySelector('.collab-nav-config:not([open])>summary')?.click()})()`)
  await settle()
  await run(`(()=>{const route=${JSON.stringify(id)};const entry=window.hifoxFixture.modules.find(entry=>entry.id===route);const scope=entry.scope==='space'?document.querySelector('[data-nav-space="'+window.hifoxFixture.state().currentSpaceId+'"]'):document.querySelector('nav[aria-label="协作模块"]');const b=scope?.querySelector('[data-hifox-route="'+route+'"]');if(!b||!b.getClientRects().length)throw Error('Missing visible module navigation '+route);b.focus();b.click()})()`)
  await wait(`document.querySelector('[data-hifox-module]')?.dataset.hifoxModule===${JSON.stringify(id)}`, id)
  await settle()
}
const api = async (name, input) => {
  const result = await run(`window.trellis.hifox[${JSON.stringify(name)}](${JSON.stringify(input)})`)
  assert.equal(result.ok, true, name + ': ' + result.error)
  await run('window.hifoxFixture.bootstrap()')
  await settle()
  return result
}
const closeModal = async () => {
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await settle()
}
const capture = async (name) => {
  const [width, height] = w.getContentSize()
  w.setContentSize(width + 1, height)
  await settle(35)
  w.setContentSize(width, height)
  w.webContents.invalidate()
  await settle(260)
  await run('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  writeFileSync(join(reportDir, name + '.png'), (await w.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  screenshots.push({ name: name + '.png', width, height })
}
const geometry = () => run(`(()=>{
  const r=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}};
  const main=document.querySelector('.collab-main'),dialog=document.querySelector('[role=dialog]'),root=document.querySelector('.my-root');
  const probe=document.createElement('span');root.append(probe);
  const token=name=>{probe.style.color='var('+name+')';return getComputedStyle(probe).color};
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');
  const ink=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].join(',')};
  const neutralColors=['primary','secondary','tertiary','on-accent','icon-primary','icon-secondary','icon-tertiary','icon-disabled'].map(role=>token('--my-txt-'+role));
  const icon=e=>({name:e.dataset.flowIcon,tone:e.dataset.flowTone,navigation:Boolean(e.closest("nav[aria-label=协作模块]")),lucide:e.classList.contains('lucide'),color:getComputedStyle(e).color,ink:ink(getComputedStyle(e).color),parentColor:getComputedStyle(e.parentElement).color,fill:e.getAttribute('fill'),stroke:e.getAttribute('stroke'),inlineColor:e.style.color,inlineFill:e.style.fill,geometry:e.innerHTML,strokeOnly:[e,...e.querySelectorAll('*')].every(p=>getComputedStyle(p).fill==='none'&&getComputedStyle(p).stroke===getComputedStyle(e).color),selected:e.closest('button')?.getAttribute('aria-current')==='page',hovered:e.closest('button')?.matches(':hover')??false,background:e.closest('button')&&getComputedStyle(e.closest('button')).backgroundColor});
  const value={viewport:[innerWidth,innerHeight],sidebars:document.querySelectorAll('aside[aria-label="协作导航"]').length,collapsed:document.querySelector('.collab-sidebar')?.classList.contains('is-collapsed'),main:main&&r(main),body:r(document.body),dialogs:document.querySelectorAll('[role=dialog]').length,dialog:dialog&&r(dialog),focusInDialog:dialog?dialog.contains(document.activeElement):null,heading:main?.querySelector('h1')?.textContent,neutralColors,neutralInks:neutralColors.map(ink),navigationHover:token('--my-bg-navigation-hover'),navigationSelected:token('--my-bg-navigation-selected'),
    icons:[...document.querySelectorAll('nav[aria-label="协作模块"] [data-hifox-route] [data-flow-icon]')].map(icon),
    neutralIcons:[...document.querySelectorAll('.collab-sidebar svg, .collab-main [data-flow-icon]:not([data-flow-tone="semantic"]), .collab-main header button svg')].map(icon),
    statuses:[...document.querySelectorAll('.collab-main[data-hifox-module="tasks"] [data-row-idx]')].map(row=>{
      const task=window.hifoxFixture.state().snapshot.tasks.find(task=>row.textContent.includes(task.id));
      const category=window.hifoxFixture.state().snapshot.taskStatuses.find(status=>status.id===task?.statusId)?.category;
      const group=({backlog:'backlog',todo:'unstarted',in_progress:'started',in_review:'started',blocked:'started',done:'completed',cancelled:'cancelled'})[category];
      const e=row.querySelector('[title="打开任务流程"] svg');
      return e&&{...icon(e),name:category,text:e.parentElement.textContent,expectedGeometry:({backlog:'CircleDashed',unstarted:'Circle',started:'CircleDot',completed:'CircleCheck',cancelled:'CircleX'})[group],expectedColor:token('--my-txt-icon-states-'+(category==='in_review'&&!task.workflow?'monitoring':group))}
    }).filter(Boolean),
    priorities:[...document.querySelectorAll('.collab-main [data-priority]')].map(badge=>{const e=badge.querySelector('svg');return{priority:badge.dataset.priority,text:badge.textContent,labelColor:getComputedStyle(badge).color,labelInk:ink(getComputedStyle(badge).color),expectedColor:token('--my-priority-'+badge.dataset.priority),icon:e&&icon(e)}}),
    nativePriorities:[...document.querySelectorAll('.collab-main[data-hifox-module="tasks"] [data-row-idx]')].map(row=>{
      const task=window.hifoxFixture.state().snapshot.tasks.find(task=>row.textContent.includes(task.id));
      const e=row.querySelector(':scope>span:nth-of-type(3) svg');
      return {priority:task?.priority,expectedColor:task&&token('--my-priority-'+task.priority),icon:e&&icon(e)}
    }),
    controls:dialog?[...dialog.querySelectorAll('input,textarea,select,button')].filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,text:e.textContent?.trim().slice(0,40),...r(e)})):[]};
  probe.remove();return value
})()`)
// Canvas premultiplied alpha can round the same color one channel unit apart.
const sameInk = (actual, expected) => actual.split(',').every((channel, index) => Math.abs(Number(channel) - Number(expected.split(',')[index])) <= 1)
const assertNeutralIcons = (value, label) => {
  assert.ok(value.neutralIcons.length >= 13, label + ' missing neutral icons')
  for (const icon of value.neutralIcons) {
    const detail = label + ' ' + (icon.name ?? 'chrome')
    assert.equal(icon.lucide, true, detail + ' must use original Lucide')
    assert.equal(icon.fill, 'none', detail + ' custom fill')
    assert.equal(icon.stroke, 'currentColor', detail + ' custom stroke')
    assert.equal(icon.strokeOnly, true, detail + ' tinted or filled descendant')
    assert.equal(icon.inlineColor, '', detail + ' inline tint')
    assert.equal(icon.inlineFill, '', detail + ' inline fill')
    if (icon.navigation || icon.name) assert.equal(icon.color, icon.parentColor, detail + ' must inherit parent ink')
    assert.ok(value.neutralInks.some((expected) => sameInk(icon.ink, expected)), detail + ' must use canonical neutral text/icon ink: ' + icon.color)
    if (icon.name) {
      assert.equal(icon.tone, 'neutral', detail + ' must opt out of semantic color')
      assert.equal(icon.geometry, originalGeometry[neutralGlyphs[icon.name]], detail + ' modified Lucide geometry')
    }
  }
}
const assertBusinessIcons = (value, label) => {
  for (const icon of value.statuses) {
    assert.equal(icon.geometry, originalGeometry[icon.expectedGeometry], label + ' native state geometry: ' + icon.name)
    assert.equal(icon.color, icon.expectedColor, label + ' status token: ' + icon.name)
    assert.ok(!value.neutralInks.some((expected) => sameInk(icon.ink, expected)), label + ' status lost color')
  }
  for (const badge of [...value.priorities, ...value.nativePriorities]) {
    assert.ok(badge.icon, label + ' missing priority icon: ' + badge.priority)
    assert.equal(badge.icon.geometry, originalGeometry[priorityGlyphs[badge.priority]], label + ' original priority geometry: ' + badge.priority)
    assert.equal(badge.icon.strokeOnly, true, label + ' priority must remain stroke-only')
    assert.equal(badge.icon.color, badge.expectedColor, label + ' priority severity token: ' + badge.priority)
    if (badge.labelInk) assert.ok(value.neutralInks.some((expected) => sameInk(badge.labelInk, expected)), label + ' priority label must remain neutral')
  }
}
const verifyIconStates = async () => {
  const windowSpace = await run('window.hifoxFixture.state().currentSpaceId')
  const modules = (await run('window.hifoxFixture.modules')).filter((module) => ['tasks', 'overview'].includes(module.id))
  const priorities = Object.keys(priorityGlyphs).sort()
  const statuses = (await snapshot()).taskStatuses.filter(status=>status.spaceId===windowSpace).map(status=>status.category).sort()
  w.setContentSize(1440, 1000)
  for (const theme of ['light', 'dark']) for (const collapsed of [false, true]) for (const module of modules) {
    await run(`window.hifoxFixture.appearance(${JSON.stringify(theme)},"standard");window.hifoxFixture.sidebar(${collapsed})`)
    await navigate(module.label, module.id)
    const hovered = module.id === 'tasks' ? '版本' : '收件箱'
    const point = await run(`(()=>{const button=document.querySelector('nav[aria-label="协作模块"] [aria-label='+${JSON.stringify(JSON.stringify(hovered))}+']');button.scrollIntoView({block:'nearest'});const b=button.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`)
    w.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) })
    await settle(220)
    const value = await geometry(), label = [module.id, theme, collapsed ? 'collapsed' : 'expanded'].join('/')
    measurements.push({ kind: 'icons', module: module.id, theme, ...value })
    assert.equal(value.icons.length, (await run('window.hifoxFixture.modules')).length)
    assert.equal(value.collapsed, collapsed)
    assert.deepEqual(value.icons.filter((icon) => icon.selected).map((icon) => icon.name), [module.icon], label + ' selected destination')
    assert.deepEqual(value.icons.filter((icon) => icon.hovered).map((icon) => icon.name), [module.id === 'tasks' ? 'iterations' : 'inbox'], label + ' actual pointer hover')
    assert.equal(value.icons.find((icon) => icon.selected).background, value.navigationSelected, label + ' selected surface')
    assert.equal(value.icons.find((icon) => icon.hovered).background, value.navigationHover, label + ' hover surface')
    assertNeutralIcons(value, label)
    assertBusinessIcons(value, label)
    if (module.id === 'tasks') {
      assert.deepEqual([...new Set(value.nativePriorities.map((badge) => badge.priority))].sort(), priorities, label + ' all priority severities')
      assert.deepEqual([...new Set(value.statuses.map((icon) => icon.name))].sort(), statuses, label + ' all task status colors')
    }
    await capture(`icons-${module.id}-${theme}-${collapsed ? 'collapsed' : 'expanded'}-hover`)
  }
  await run('window.hifoxFixture.sidebar(false)')
  assert.deepEqual(errors, [])
}
const recordForm = async (name) => {
  const value = await geometry()
  measurements.push({ kind: 'form', name, ...value })
  assert.equal(value.dialogs, 1, name + ' duplicate dialog')
  assert.ok(value.focusInDialog, name + ' focus escaped')
  assert.ok(value.dialog.x >= 0 && value.dialog.y >= 0 && value.dialog.x + value.dialog.width <= value.viewport[0] + 1 && value.dialog.y + value.dialog.height <= value.viewport[1] + 1, name + ' outside viewport')
  await capture(name)
}
const metadata = () => ({ scope: 'Production HiFoxApp + useHifox/useMy + canonical my CSS/Tailwind + production preload/contextBridge + registerHifoxIpc/services + isolated JSON disk. Native hidden Electron/Chromium; no mocked HiFox IPC, no remote sync/auth/runtime execution.', fixture, storeDir: process.env.HIFOX_STORE_DIR, setup: 'UI creates the space, member, skill, primary Agent/squad, version, main task/comments, project, saved view, triage task and automation. The unfinished-scope companion task and unavailable executor history are prepared through the actual preload/IPC API.', checks, measurements, screenshots, allocationFocus, rendererErrors: errors, notRun: ['remote synchronization/account permissions', 'Runtime execution/repository or process isolation', 'full MyShell mounting (module shell mounts directly here; duplicate sidebar shell has separate navigation smoke)'] })
app.whenReady().then(async () => {
  w = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { preload: join(fixture, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } })
  w.webContents.on('console-message', (event) => { if (event.level === 'error' && !event.message.includes('Electron Security Warning')) errors.push(event.message) })
  w.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer gone: ' + details.reason))
  await w.loadFile(join(fixture, 'index.html'))
  w.setContentSize(1440, 1000)
  await wait('Boolean(window.hifoxFixture?.state().snapshot)', 'production bootstrap')
  await run('window.hifoxFixture.appearance("light","standard")')
  if (process.env.HIFOX_WORKSPACE_ICONS_ONLY === '1') {
    await check('retained isolated tasks and overview preserve neutral original Lucide and colored business semantics', verifyIconStates)
    writeFileSync(join(reportDir, 'icon-summary.json'), JSON.stringify({ status: 'passed', retainedFixture: true, ...metadata() }, null, 2))
    console.log('HIFOX_WORKSPACE_ICONS_PASSED ' + checks.length)
    w.destroy(); app.quit(); return
  }
  if (process.env.HIFOX_WORKSPACE_REOPEN === '1') {
    await check('fresh Electron process reopens exact persisted native IPC snapshot', async () => {
      const disk = JSON.parse(readFileSync(join(process.env.HIFOX_STORE_DIR, 'store.json'), 'utf8'))
      assert.deepEqual(await snapshot(), disk)
      assert.ok(disk.spaces.some((space) => space.key === 'REVIEW'))
      assert.ok(disk.tasks.some((task) => task.title === '交付协作工作流 · 已保存'))
      assert.ok(disk.crews.some((crew) => crew.name === '交付小队'))
      await capture('workspace-reopened-light')
    })
    writeFileSync(join(reportDir, 'restart-summary.json'), JSON.stringify({ status: 'passed', ...metadata() }, null, 2))
    console.log('HIFOX_WORKSPACE_UI_PASSED restart')
    w.destroy(); app.quit(); return
  }
  let spaceId, memberId, skillId, agentId, crewId, iterationId, taskId, scopeTaskId
  await check('empty first launch has one real local owner and overview routes to space creation', async () => {
    const initial = await snapshot()
    assert.deepEqual(initial.spaces, [])
    assert.deepEqual(initial.members.map(({ name, role }) => ({ name, role })), [{ name: '我', role: 'owner' }])
    for (const key of ['tasks', 'agents', 'skills', 'crews', 'iterations']) assert.equal(initial[key].length, 0)
    assert.equal(await run('Boolean(window.trellis?.hifox?.snapshot)'), true)
    await capture('first-launch-light')
    await click('创建空间')
    await wait('document.querySelector("[data-hifox-module]")?.dataset.hifoxModule==="spaces"', 'first space route')
    await click('新建空间')
    await field('空间名称', '协作验收空间')
    await field('任务前缀', 'REVIEW')
    await field('描述（选填）', '真实本机协作流程验收：人员、Agent、小队、版本和人工交付。')
    await recordForm('form-space-light')
    await click('创建', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.spaces.length===1', 'created space')
    const created = (await snapshot()).spaces[0]
    spaceId = created.id
    assert.equal(created.memberIds.length, 1)
    await wait('document.querySelectorAll("[role=dialog]").length===0', 'space dialog closed')
  })
  await check('local member create edit reopen and shared confirmation Escape restore focus', async () => {
    await navigate('同事', 'members')
    await click('添加同事')
    await field('姓名', '验收同事')
    await field('邮箱（可选，仅作联系记录）', 'review@example.invalid')
    await field('职位（可选）', '交付负责人')
    await recordForm('form-member-light')
    await click('添加', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.members.length===2', 'member write')
    memberId = (await snapshot()).members.find((member) => member.name === '验收同事').id
    await run(`document.querySelector('[aria-label="编辑 验收同事"]').click()`)
    await field('职位（可选）', '验收负责人')
    await click('保存', '[role=dialog]')
    await wait('document.querySelectorAll("[role=dialog]").length===0', 'member saved')
    await run(`document.querySelector('[aria-label="编辑 验收同事"]').click()`)
    assert.ok((await run('document.querySelector("[role=dialog]").innerText')).includes('编辑 验收同事'))
    await closeModal()
    await run(`(()=>{const b=document.querySelector('[aria-label="移除 验收同事"]');b.focus();b.click()})()`)
    await wait('document.querySelectorAll("[role=dialog]").length===1', 'shared confirmation')
    const confirmation = await geometry()
    measurements.push({ kind: 'confirmation', ...confirmation })
    assert.ok(confirmation.focusInDialog, 'shared confirmation did not receive initial focus')
    await recordForm('form-member-remove-confirm-light')
    await run('(()=>{const b=[...document.querySelectorAll("[role=dialog] button")];b[b.length-1].focus()})()')
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await settle()
    assert.equal(await run('document.activeElement===document.querySelector("[role=dialog] button")'), true, 'shared confirmation Tab escaped')
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
    await settle()
    assert.equal(await run('(()=>{const b=document.querySelectorAll("[role=dialog] button");return document.activeElement===b[b.length-1]})()'), true, 'shared confirmation Shift+Tab escaped')
    await closeModal()
    assert.equal(await run('document.querySelectorAll("[role=dialog]").length'), 0)
    assert.equal(await run('document.activeElement.getAttribute("aria-label")'), '移除 验收同事', 'shared confirmation did not return focus')
    assert.equal((await snapshot()).members.length, 2)
  })
  await check('skill and Agent UI create bind and reopen through real storage', async () => {
    await navigate('技能', 'skills')
    await click('新建技能')
    await field('技能名称', '交付验收')
    await field('用途描述', '检查交付目标、关联任务与验证证据')
    await field('技能指令', '读取验收标准，逐项检查，记录验证结果与未完成事项。')
    await recordForm('form-skill-light')
    await click('创建', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.skills.length===1', 'skill create')
    skillId = (await snapshot()).skills[0].id
    await navigate('Agent', 'agents')
    await click('新建 Agent')
    await field('名称', '交付助手')
    await field('职责描述', '整理交付证据与验收清单')
    await field('工作指令', '先阅读任务和版本目标，说明工作计划，验证修改并汇报结果；等待人工确认。')
    await checkbox('交付验收')
    await recordForm('form-agent-light')
    await click('创建', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.agents.length===1', 'agent create')
    const agent = (await snapshot()).agents[0]
    agentId = agent.id
    assert.deepEqual(agent.skillIds, [skillId])
    await click('编辑')
    await wait('Boolean(document.querySelector("[role=dialog]"))', 'agent reopen')
    assert.equal(await run('document.querySelector("[role=dialog] input[type=checkbox]").checked'), true)
    await closeModal()
  })
  await check('squad UI records captain people instructions and cross-page Agent editing', async () => {
    await navigate('小队', 'crews')
    await click('组建小队')
    await field('名称', '交付小队')
    await field('职责（选填）', '由队长协调实现与人工验收')
    await field('队长', 'agent:' + agentId)
    await field('负责人（选填）', memberId)
    await checkbox('验收同事')
    await field('协作约定（选填）', '队长先确认目标和验收标准，协调同事评审，并把证据汇总到同一任务。')
    await recordForm('form-squad-light')
    await click('组建', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.crews.length===1', 'squad create')
    const crew = (await snapshot()).crews[0]
    crewId = crew.id
    assert.equal(crew.captain.id, agentId)
    assert.ok(crew.members.some((member) => member.id === memberId))
    assert.ok(crew.members.some((member) => member.id === agentId))
    await capture('squad-light')
    await run('(()=>{const b=[...document.querySelectorAll(".collab-main button")].find(e=>e.textContent.includes("交付助手"));if(!b)throw Error("Agent member link absent");b.click()})()')
    await wait('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="编辑 Agent"', 'squad Agent cross-page edit')
    await closeModal()
  })
  await check('version planning UI creates dates target and explicit empty scope', async () => {
    await navigate('版本', 'iterations')
    await click('新建版本')
    await field('版本名称', 'v1.0 本地协作交付')
    await field('交付目标（选填）', '完整走通人员分工、Agent 配置、小队执行槽和人工验收。')
    const start = new Date(), end = new Date(start)
    end.setDate(end.getDate() + 13)
    const date = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    await field('开始日期', date(start))
    await field('结束日期', date(end))
    await recordForm('form-version-light')
    await click('创建', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.iterations.length===1', 'version create')
    iterationId = (await snapshot()).iterations[0].id
  })
  await check('new task UI independently selects human owner and squad executor with version scope', async () => {
    await click('新建版本任务')
    await field('标题', '交付协作工作流')
    await field('工作内容', 'general')
    await field('验收标准', '界面可操作\n分工独立保存\n人工验收保留交付证据')
    await field('描述', '需求背景与验收标准应在多行输入框内自动换行。'.repeat(16) + '\n' + 'unbroken'.repeat(80))
    const multiline = await run(`(()=>{const field=document.querySelector('[role=dialog] textarea');const style=getComputedStyle(field);return{whiteSpace:style.whiteSpace,display:style.display,scrollWidth:field.scrollWidth,clientWidth:field.clientWidth,scrollHeight:field.scrollHeight,clientHeight:field.clientHeight}})()`)
    assert.equal(multiline.whiteSpace, 'pre-wrap', 'multiline fields must preserve paragraphs and wrap')
    assert.notEqual(multiline.display, 'inline-flex', 'textareas must not inherit button geometry')
    assert.ok(multiline.scrollWidth <= multiline.clientWidth + 1, 'long requirements must not scroll sideways')
    assert.ok(multiline.scrollHeight > multiline.clientHeight, 'long requirements must form multiple lines')
    await field('描述', '验收标准：界面可操作、分工独立保存、人工评审与完成不发起 Runtime。')
    await recordForm('form-task-light')
    await moreProperties()
    await allocate('验收同事')
    await allocate('小队 · 交付小队')
    allocationFocus.push(await run('({inDialog:document.querySelector("[role=dialog]").contains(document.activeElement),activeTag:document.activeElement.tagName,activeLabel:document.activeElement.getAttribute("aria-label")})'))
    await capture('form-task-allocation-light')
    await click('创建任务', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.tasks.length===1', 'task create')
    const task = (await snapshot()).tasks[0]
    taskId = task.id
    assert.deepEqual(task.assigneeIds, [memberId])
    assert.equal(task.executor.id, crewId)
    assert.deepEqual(task.iterationIds, [iterationId])
    assert.equal(task.dispatch.status, 'queued')
    assert.equal(task.workKind, 'general')
    assert.equal(task.workflow.stage, 'accepted')
    await wait('document.querySelectorAll("[role=dialog]").length===1', 'single global task details')
    await click('编辑标题', '[role=dialog]')
    await field('标题', '交付协作工作流 · 已保存')
    await click('保存标题', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.tasks[0].title.endsWith("已保存")', 'task content save')
    await click('讨论', '[role=dialog]')
    await field('发表评论', '@验收同事 请核对验收清单与版本目标。')
    await click('发送评论', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.comments.length===1', 'task comment persisted')
    const rootComment = (await snapshot()).comments[0]
    assert.ok((await run('[...document.querySelectorAll("[role=dialog] time")].map(element=>element.textContent)')).every((value) => !/T\d\d:|\.\d{3}Z$/.test(value)), 'raw ISO activity timestamp')
    await click('回复', '[role=dialog]')
    await field('发表评论', '回复确认：人员与小队分工已核对。')
    await click('发送评论', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.comments.length===2', 'reply persisted')
    const reply = (await snapshot()).comments.find((comment) => comment.id !== rootComment.id)
    assert.equal(reply.parentId, rootComment.id)
    await click('标记解决', `[data-comment-id="${rootComment.id}"]`)
    await wait('!window.hifoxFixture.state().busy', 'resolve root comment')
    assert.equal((await snapshot()).comments.find((comment) => comment.id === rootComment.id).resolved, true)
    await click('重新打开', `[data-comment-id="${rootComment.id}"]`)
    await wait('!window.hifoxFixture.state().busy', 'reopen root comment')
    assert.equal((await snapshot()).comments.find((comment) => comment.id === rootComment.id).resolved, false)
    await run(`document.querySelector('[data-comment-id="${reply.id}"]').scrollIntoView({block:'center'})`)
    await capture('task-comments-reply-light')
    await click('详情', '[role=dialog]')
    await click('安排处理', '[role=dialog]')
    await wait('document.querySelectorAll("[role=dialog]").length===2', 'arrangement dialog')
    await field('下一位处理人', 'local-owner', '[aria-label="安排处理"]')
    await click('确认安排', '[aria-label="安排处理"]')
    await wait('window.hifoxFixture.state().snapshot.tasks[0].workflow.stage==="developing"', 'arrangement persisted')
    assert.equal((await snapshot()).tasks[0].dispatch.status, 'waiting_runtime')
    await click('提交交付成果', '[role=dialog]')
    await field('产出链接或交付说明', '验收清单与讨论已保存在当前任务。', '[aria-label="提交交付成果"]')
    await field('下一位处理人', 'local-owner', '[aria-label="提交交付成果"]')
    await click('提交交付成果', '[aria-label="提交交付成果"]')
    await wait('window.hifoxFixture.state().snapshot.tasks[0].workflow.stage==="acceptance"', 'delivery write')
    assert.equal((await snapshot()).tasks.find((task) => task.id === taskId).dispatch, undefined)
    await capture('task-detail-review-light')
    await click('验收通过', '[role=dialog]')
    await click('验收通过', '[aria-label="验收通过"]')
    await wait('window.hifoxFixture.state().snapshot.tasks[0].workflow.stage==="done"', 'done write')
    const done = (await snapshot()).tasks.find((task) => task.id === taskId)
    assert.equal(done.dispatch, undefined)
    assert.ok(done.completedAt)
    assert.equal((await snapshot()).taskStatuses.find((status) => status.id === done.statusId).category, 'done')
    await closeModal()
    await navigate('全部任务', 'tasks')
    await run(`(()=>{const b=[...document.querySelectorAll('.collab-main [data-row-idx]')].find(e=>e.textContent.includes(${JSON.stringify('交付协作工作流 · 已保存')}));if(!b)throw Error('Task row missing');b.focus();b.click()})()`)
    await wait('document.querySelectorAll("[role=dialog]").length===1', 'task reopen from list')
    await closeModal()
  })
  await check('version scope rejects unfinished closing and retains immutable finished membership without rollover', async () => {
    const data = await snapshot(), todo = data.taskStatuses.find((status) => status.spaceId === spaceId && status.category === 'todo')
    const created = await api('createTask', { spaceId, title: '范围验收任务', statusId: todo.id, triagePending: false, assigneeIds: [memberId], executor: { kind: 'agent', id: agentId, name: '交付助手' } })
    scopeTaskId = created.taskId
    await navigate('版本', 'iterations')
    await click('编辑版本范围与目标')
    await checkbox('范围验收任务')
    await click('保存', '[role=dialog]')
    await wait('!window.hifoxFixture.state().busy', 'version scope save')
    assert.deepEqual((await snapshot()).tasks.find((task) => task.id === scopeTaskId).iterationIds, [iterationId])
    await click('开始版本')
    await wait('window.hifoxFixture.state().snapshot.iterations[0].status==="active"', 'version active')
    await capture('version-active-light')
    await click('截版')
    await recordForm('form-version-unfinished-light')
    assert.ok(await run('[...document.querySelectorAll("[role=dialog] button")].find(button=>button.textContent==="确认截版").disabled'), 'unfinished version close must be disabled')
    const before = await snapshot(), beforeDisk = readFileSync(join(process.env.HIFOX_STORE_DIR, 'store.json'), 'utf8')
    const rejected = await run(`window.trellis.hifox.completeIteration({id:${JSON.stringify(iterationId)}})`)
    assert.equal(rejected.ok, false); assert.match(rejected.error, /未完成/)
    assert.deepEqual(await snapshot(), before)
    assert.equal(readFileSync(join(process.env.HIFOX_STORE_DIR, 'store.json'), 'utf8'), beforeDisk, 'rejected closure preserves exact saved bytes')
    await click('取消', '[role=dialog]')
    await run(`(()=>{const row=[...document.querySelectorAll('.collab-main [data-row-idx]')].find(row=>row.textContent.includes(${JSON.stringify(scopeTaskId)}));if(!row)throw Error('Version task missing');row.click()})()`)
    const doneStatus = data.taskStatuses.find((status) => status.spaceId === spaceId && status.category === 'done')
    await field('状态', doneStatus.id)
    await wait('!window.hifoxFixture.state().busy', 'legacy companion completed')
    assert.ok((await snapshot()).tasks.find((task) => task.id === scopeTaskId).completedAt)
    await closeModal()
    await click('截版'); await recordForm('form-version-close-light'); await click('确认截版', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.iterations[0].status==="completed"', 'version closed')
    const after = await snapshot(), closed = after.iterations.find((it) => it.id === iterationId)
    assert.equal(after.iterations.length, 1, 'closing must not create another version')
    assert.deepEqual(closed.taskIds.sort(), [taskId, scopeTaskId].sort())
    assert.deepEqual(after.tasks.find((task) => task.id === scopeTaskId).iterationIds, [iterationId])
    const move = await run(`window.trellis.hifox.updateTask({id:${JSON.stringify(scopeTaskId)},patch:{iterationIds:[]}})`)
    assert.equal(move.ok, false); assert.match(move.error, /已关闭版本/)
    assert.deepEqual(await snapshot(), after)
    assert.deepEqual(JSON.parse(readFileSync(join(process.env.HIFOX_STORE_DIR, 'store.json'), 'utf8')), JSON.parse(JSON.stringify(after)))
  })
  await check('project UI creates owners adds existing task and reopens completed project', async () => {
    await navigate('专项', 'projects')
    await click('新建专项')
    await field('专项名称', '本地协作闭环')
    await field('专项目标', '汇总协作工作流验收任务与证据')
    await checkbox('验收同事')
    await recordForm('form-project-light')
    await click('创建专项', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.projects.length===1', 'project persisted')
    await click('添加已有任务')
    await field('任务', taskId)
    await click('添加到专项', '[role=dialog]')
    await wait('!window.hifoxFixture.state().busy', 'project task add')
    await closeModal()
    const project = (await snapshot()).projects[0]
    assert.equal((await snapshot()).tasks.find((task) => task.id === taskId).projectId, project.id)
    assert.deepEqual(project.ownerIds, [memberId])
    await click('标记完成')
    await wait('window.hifoxFixture.state().snapshot.projects[0].status==="done"', 'project complete')
    await click('重新打开')
    await wait('window.hifoxFixture.state().snapshot.projects[0].status==="active"', 'project reopen')
  })
  await check('native board persists its group/filter view and global creation Escape retains ownership', async () => {
    await navigate('任务看板', 'board')
    await click('显示'); await click('负责人', '.my-menu'); await closeModal()
    await click('存为视图')
    await control('.my-menu input', '按处理人交付视图')
    await click('保存视图', '.my-menu')
    await wait('window.hifoxFixture.state().snapshot.views.length===1', 'view persisted')
    assert.equal((await snapshot()).views[0].groupBy, 'assignee')
    await navigate('视图', 'views'); await click('按处理人交付视图')
    await wait('window.hifoxFixture.state().activeViewId===window.hifoxFixture.state().snapshot.views[0].id', 'saved view applied')
    await click('显示')
    assert.equal(await run('[...document.querySelectorAll(".my-menu button")].find(button=>button.textContent.trim()==="负责人").getAttribute("aria-pressed")'), 'true')
    await closeModal()
    await run('window.hifoxFixture.createTask()')
    await wait('document.querySelectorAll("[role=dialog]").length===1', 'global create modal')
    await closeModal()
    assert.equal(await run('window.hifoxFixture.state().createTaskOpen'), false)
  })
  await check('native triage priority and lifecycle acceptance retain accepted unversioned work', async () => {
    await navigate('分拣台', 'triage'); await click('新建任务')
    await field('标题', '待确认的验收补充'); await field('工作内容', 'general')
    await click('创建任务', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.tasks.some(task=>task.triagePending)', 'triage task persisted')
    const pending = (await snapshot()).tasks.find((task) => task.triagePending)
    await field('优先级', 'high')
    await wait('!window.hifoxFixture.state().busy', 'triage priority')
    await click('先接纳', '[role=dialog]')
    await wait('!window.hifoxFixture.state().snapshot.tasks.some(task=>task.triagePending)', 'triage accepted')
    const disposed = (await snapshot()).tasks.find((task) => task.id === pending.id)
    assert.equal(disposed.priority, 'high'); assert.equal(disposed.workflow.stage, 'accepted')
    assert.equal(disposed.dispatch, undefined)
    assert.ok((await snapshot()).triageDecisions.some((decision) => decision.taskId === pending.id))
    await closeModal(); await click('已接受 · 未排版本')
    await wait(`Boolean([...document.querySelectorAll('.collab-main [data-row-idx]')].find(row=>row.textContent.includes(${JSON.stringify(pending.id)})))`, 'accepted unversioned row')
  })
  await check('all five native work-item layouts retain collaboration identity and version dates', async () => {
    await navigate('任务', 'tasks')
    const before = await snapshot(), nativeBefore = await run('window.hifoxFixture.nativeState()')
    const version = before.iterations.find((item) => item.id === iterationId)
    const title = before.tasks.find((item) => item.id === taskId).title
    for (const label of ['列表', '看板', '表格', '甘特', '日历']) {
      await click('布局：' + label)
      assert.equal(await run(`document.querySelector('[aria-label="布局：${label}"]').getAttribute('aria-pressed')`), 'true')
      if (label === '列表') assert.ok(await run(`Boolean([...document.querySelectorAll('.collab-main [data-row-idx]')].find(row=>row.textContent.includes(${JSON.stringify(taskId)})))`))
      if (label === '看板') assert.ok(await run(`Boolean([...document.querySelectorAll('.collab-main .my-card')].find(card=>card.textContent.includes(${JSON.stringify(taskId)})))`))
      if (label === '表格') {
        assert.ok(await run(`document.querySelector('.collab-main').innerText.includes('版本开始')&&document.querySelector('.collab-main').innerText.includes('版本截止')`))
        await run(`(()=>{const row=[...document.querySelectorAll('.collab-main [role=button]')].find(row=>row.textContent.includes(${JSON.stringify(taskId)})&&row.textContent.includes(${JSON.stringify(title)}));if(!row)throw Error('Native spreadsheet task row missing');row.click()})()`)
        await wait(`window.hifoxFixture.state().openTaskId===${JSON.stringify(taskId)}`, 'spreadsheet opens owned collaboration detail')
        await closeModal()
      }
      if (label === '甘特') {
        assert.ok(await run(`document.querySelector('.collab-main').innerText.includes('版本排期')`))
        assert.ok(await run(`Boolean([...document.querySelectorAll('.collab-main [title]')].find(item=>item.title===${JSON.stringify(`${title}（${version.startDate} → ${version.endDate}）`)}))`))
      }
      if (label === '日历') {
        const now = new Date(), due = new Date(version.endDate + 'T12:00:00')
        if (now.getMonth() !== due.getMonth()) { await run('document.querySelector(".collab-main .my-scrollbar .lucide-chevron-right").closest("button").click()'); await settle() }
        assert.ok(await run(`document.querySelector('.collab-main').innerText.includes('版本截止')`))
        assert.ok(await run(`Boolean([...document.querySelectorAll('.collab-main button')].find(button=>button.textContent===${JSON.stringify(title)}))`))
      }
      await capture('native-layout-' + label)
    }
    assert.deepEqual(await snapshot(), before, 'layout selection must not mutate collaboration data')
    assert.deepEqual(await run('window.hifoxFixture.nativeState()'), nativeBefore, 'collaboration layouts must not write native task state')
    await click('布局：列表')
  })
  await check('automation creates real local reminders preserves pause on edit and records no runtime success', async () => {
    await navigate('自动化', 'automations')
    await click('新建自动化')
    await field('名称', '交付本地提醒')
    await field('触发器', 'task_created')
    await field('交给谁执行', 'member:' + memberId)
    await field('指令 / 说明', '请查看验收任务的目标与评论。')
    await recordForm('form-automation-light')
    await click('创建', '[role=dialog]')
    await wait('window.hifoxFixture.state().snapshot.automations.length===1', 'automation persisted')
    await run('document.querySelector(".collab-main button[title=手动运行一次]").click()')
    await wait('window.hifoxFixture.state().snapshot.automations[0].runs.length===1', 'local automation run')
    assert.equal((await snapshot()).automations[0].runs[0].outcome, 'done')
    assert.match((await snapshot()).automations[0].runs[0].detail, /本地收件箱/)
    await run('document.querySelector(".collab-main [role=switch]").click()')
    await wait('!window.hifoxFixture.state().snapshot.automations[0].enabled', 'automation paused')
    await click('编辑')
    await field('名称', '交付本地提醒 · 已暂停')
    await click('保存', '[role=dialog]')
    await wait('!window.hifoxFixture.state().busy', 'automation edit')
    assert.equal((await snapshot()).automations[0].enabled, false)
  })
  await check('inbox clears and restores actual local notifications and navigates to task details', async () => {
    await navigate('收件箱', 'inbox')
    await click('全部已读')
    await wait('!window.hifoxFixture.state().busy', 'inbox read')
    assert.ok((await snapshot()).inbox.every((item) => item.read))
    await run('document.querySelector("[aria-label=清理这一组提醒]").click()')
    await wait('window.hifoxFixture.state().snapshot.inbox.some(item=>item.cleared)', 'inbox clear')
    const cleared = (await snapshot()).inbox.find((item) => item.cleared)
    await run('(()=>{const b=[...document.querySelectorAll(".collab-main button")].find(button=>button.textContent.startsWith("已清理"));if(!b)throw Error("Missing cleared tab");b.click()})()')
    await settle()
    await run('document.querySelector("button[title=恢复]").click()')
    await wait('!window.hifoxFixture.state().busy', 'inbox restore')
    assert.equal(Boolean((await snapshot()).inbox.find((item) => item.id === cleared.id).cleared), false)
    await click('全部')
    await run(`(()=>{const b=[...document.querySelectorAll('.collab-main li button')].find(button=>button.textContent.includes(${JSON.stringify(taskId)}));if(!b)throw Error('Missing task notification');b.focus();b.click()})()`)
    await wait('document.querySelectorAll("[role=dialog]").length===1', 'inbox opens task')
    assert.equal(await run('window.hifoxFixture.state().openTaskId'), taskId)
    await closeModal()
  })
  await check('task and automation pickers exclude unavailable candidates and retain historical executor', async () => {
    const createAgent = async (name, extra = {}) => {
      const result = await api('saveAgent', { spaceId, name, instructions: '检查执行槽候选项可用性', ...extra })
      return result.data.agents.find((agent) => agent.name === name).id
    }
    const disabled = await createAgent('停用候选', { enabled: false })
    const archived = await createAgent('归档候选')
    const exclusive = await createAgent('专属候选')
    const history = await api('createTask', { spaceId, title: '保留历史执行者', executor: { kind: 'agent', id: archived, name: '归档候选' } })
    await api('removeAgent', { id: archived })
    await api('saveCrew', { id: crewId, spaceId, name: '交付小队', captainAgentId: agentId, instructions: '队长先确认目标和验收标准，协调同事评审，并把证据汇总到同一任务。', memberRefs: [{ kind: 'agent', id: agentId }, { kind: 'member', id: memberId }, { kind: 'agent', id: exclusive }], exclusiveAgentIds: [exclusive] })
    const extraCrew = await api('saveCrew', { spaceId, name: '归档小队候选', captainAgentId: agentId, memberRefs: [], instructions: '保留历史名册' })
    const archivedCrew = extraCrew.data.crews.find((crew) => crew.name === '归档小队候选').id
    await api('removeCrew', { id: archivedCrew })
    const rejectedNames = ['停用候选', '归档候选', '专属候选', '归档小队候选']
    const items = () => run('[...document.querySelectorAll(".my-menu button")].map(button=>({text:button.textContent.trim(),disabled:button.disabled}))')
    await navigate('全部任务', 'tasks'); await click('新建任务'); await moreProperties(); await openAllocation()
    assert.ok((await items()).every((item) => !rejectedNames.some((name) => item.text.includes(name))))
    await closeModal(); await closeModal()
    await run(`(()=>{const row=[...document.querySelectorAll('.collab-main [data-row-idx]')].find(row=>row.textContent.includes('保留历史执行者'));if(!row)throw Error('Historical native row missing');row.click()})()`)
    await wait('Boolean(document.querySelector("[role=dialog]"))', 'historical task')
    await openAllocation()
    const historyItems = await items()
    assert.ok(historyItems.some((item) => item.text === '归档候选（当前不可用）' && item.disabled))
    assert.ok(historyItems.every((item) => item.text === '归档候选（当前不可用）' || !rejectedNames.some((name) => item.text.includes(name))))
    assert.equal((await snapshot()).tasks.find((task) => task.id === history.taskId).dispatch, undefined)
    await closeModal(); await closeModal()
    await navigate('自动化', 'automations'); await click('新建自动化')
    const automationOptions = await run('(()=>{const label=[...document.querySelector("[role=dialog]").querySelectorAll("label")].find(label=>label.textContent==="交给谁执行");return [...label.control.options].map(option=>option.value)})()')
    assert.ok(automationOptions.every((value) => ![`agent:${disabled}`, `agent:${archived}`, `agent:${exclusive}`, `crew:${archivedCrew}`].includes(value)))
    await closeModal()
  })
  await check('task and overview icon states preserve neutral navigation and colored business semantics', async () => {
    const priorities = Object.keys(priorityGlyphs)
    const statuses = (await snapshot()).taskStatuses.filter((status) => status.spaceId === spaceId)
    for (const [index, status] of statuses.entries()) {
      await api('createTask', { spaceId, title: '图标语义验收 · ' + status.name, statusId: status.id, triagePending: false, priority: priorities[index % priorities.length] })
    }
    await verifyIconStates()
  })
  await check('hierarchical routes render in light dark standard large and 1440 960 700 widths', async () => {
    const modules = await run('window.hifoxFixture.modules')
    assert.equal(new Set(modules.map((entry) => entry.id)).size, modules.length)
    const hierarchy = await run(`(()=>{const nav=document.querySelector('nav[aria-label="协作模块"]'),space=nav.querySelector('[data-nav-space="'+window.hifoxFixture.state().currentSpaceId+'"]');return window.hifoxFixture.modules.map(entry=>({id:entry.id,global:entry.scope==='global'&&!nav.querySelector('[data-hifox-route="'+entry.id+'"]')?.closest('[data-nav-space]'),nested:entry.parent?Boolean(space?.querySelector('[data-nav-branch="'+entry.parent+'"] .collab-nav-children [data-hifox-route="'+entry.id+'"]')):true}))})()`)
    assert.ok(hierarchy.every((entry) => entry.nested), 'task and Agent children retain their parent branch')
    assert.ok(modules.filter((entry) => entry.scope === 'global').every((entry) => hierarchy.find((item) => item.id === entry.id)?.global), 'global routes must remain outside the space tree')
    for (const width of [1440, 960, 700]) {
      w.setContentSize(width, 1000)
      for (const theme of ['light', 'dark']) for (const font of ['standard', 'large']) {
        await run(`window.hifoxFixture.appearance(${JSON.stringify(theme)},${JSON.stringify(font)})`)
        for (const module of modules) {
          await navigate(module.label, module.id)
          const value = await geometry()
          const label = [module.id, width, theme, font].join('/')
          measurements.push({ kind: 'module', module: module.id, width, theme, font, ...value })
          assert.equal(value.sidebars, 1, module.id + ' duplicate sidebar')
          assert.equal(value.dialogs, 0, module.id + ' leaked dialog')
          assert.ok(value.heading, module.id + ' missing heading')
          assert.ok(value.main.width >= 250, module.id + ' unusable content width')
          assert.ok(value.main.x + value.main.width <= width + 1, module.id + ' page outside viewport')
          assert.ok(value.body.scrollWidth <= width + 1, module.id + ' document horizontal overflow')
          assert.equal(value.icons.length, modules.length)
          assert.deepEqual(value.icons.filter((icon) => icon.selected).map((icon) => icon.name), [module.icon], label + ' selected destination')
          assertNeutralIcons(value, label)
          assertBusinessIcons(value, label)
          if (width === 1440 && theme === 'light' && font === 'standard' && ['all-agents', 'views', 'my-tasks'].includes(module.id)) await capture(module.id + '-light')
        }
      }
    }
    assert.equal(new Set(measurements.filter((item) => item.kind === 'module').map((item) => item.module)).size, modules.length)
    assert.equal(errors.length, 0, errors.join('\n'))
  })
  await check('screenshots cover neutral light dark navigation overview headings and colored business badges', async () => {
    w.setContentSize(1440, 1000)
    await run('window.hifoxFixture.appearance("light","standard")')
    await navigate('协作概览', 'overview')
    await capture('overview-light')
    await run('window.hifoxFixture.appearance("dark","standard")')
    await capture('overview-dark')
    await navigate('任务看板', 'board')
    await capture('board-dark')
    await navigate('小队', 'crews')
    await capture('squad-dark')
    await navigate('版本', 'iterations')
    await capture('version-dark')
    const iconDark = (await geometry()).icons
    await run('window.hifoxFixture.appearance("light","large")')
    await settle()
    const iconLight = (await geometry()).icons
    assert.ok(iconDark.every((icon, i) => icon.color !== iconLight[i].color && icon.color === icon.parentColor && iconLight[i].color === iconLight[i].parentColor), 'navigation must follow each theme parent ink')
    w.setContentSize(960, 900)
    await navigate('协作概览', 'overview')
    await capture('overview-960-large-light')
    w.setContentSize(700, 900)
    await navigate('Agent', 'agents')
    await run(`(()=>{const heading=[...document.querySelectorAll('.collab-main h2')].find(e=>e.textContent==='交付助手');if(!heading)throw Error('Agent card missing');const card=heading.closest('section');const b=[...card.querySelectorAll('button')].find(e=>e.textContent.trim()==='编辑');if(!b)throw Error('Agent edit missing');b.focus();b.click()})()`)
    await recordForm('form-agent-700-large-light')
    await closeModal()
    await navigate('全部任务', 'tasks')
    await click('新建任务')
    await recordForm('form-task-700-large-light')
    await closeModal()
    await navigate('协作概览', 'overview')
    await capture('overview-700-large-light')
  })
  await check('shared priority colors stay semantic and dropdown focus respects destination and source ownership', async () => {
    w.setContentSize(960, 900)
    await run('window.hifoxFixture.focusProbe(true)')
    await wait('Boolean(document.querySelector("[data-focus-regression]"))', 'shared-control fixture')
    const frames = () => run('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const isFocused = (selector) => run(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`)
    const trigger = '[aria-label="Focus probe menu"]', outside = '[aria-label="Outside focus target"]'
    for (const theme of ['light', 'dark']) {
      await run(`window.hifoxFixture.appearance(${JSON.stringify(theme)},"standard")`)
      await frames()
      const colors = await run(`(()=>{const root=document.querySelector('[data-focus-regression]'),probe=document.createElement('span');root.append(probe);const token=name=>{probe.style.color='var('+name+')';return getComputedStyle(probe).color};const priorities=[...root.querySelectorAll('[data-focus-priority]')].map(item=>({priority:item.dataset.focusPriority,color:getComputedStyle(item.querySelector('svg')).color,expected:token('--my-priority-'+item.dataset.focusPriority)}));const neutral=[...root.querySelectorAll('[data-focus-neutral] svg')].map(icon=>({color:getComputedStyle(icon).color,parent:getComputedStyle(icon.parentElement).color,inline:icon.style.color}));probe.remove();return{priorities,neutral}})()`)
      assert.equal(colors.priorities.length, 5)
      for (const priority of colors.priorities) assert.equal(priority.color, priority.expected, theme + ' central severity color overrides neutral caller class: ' + priority.priority)
      for (const icon of colors.neutral) { assert.equal(icon.color, icon.parent); assert.equal(icon.inline, '') }
      await click('Focus probe menu', '[data-focus-regression]'); await click('Select and close', '.my-menu'); await frames()
      assert.ok(await isFocused(trigger), theme + ' explicit selection returns exact trigger focus')
    }
    await click('Focus probe menu', '[data-focus-regression]')
    const point = await run(`(()=>{const rect=document.querySelector(${JSON.stringify(outside)}).getBoundingClientRect();return{x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`)
    w.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await frames()
    assert.equal(await run('Boolean(document.querySelector(".my-menu"))'), false, 'outside input closes menu')
    assert.ok(await isFocused(outside), 'outside pointer retains the clicked input focus')
    await click('Focus probe menu', '[data-focus-regression]'); await click('Focus another control', '.my-menu'); await frames()
    assert.ok(await isFocused(outside), 'explicit close does not steal focus from another control')
    await click('Focus probe menu', '[data-focus-regression]'); await click('Open a modal', '.my-menu'); await frames()
    assert.ok(await isFocused('[aria-label="Modal focus target"]'), 'new modal keeps its actual autofocus target')
    await click('Close probe dialog', '[aria-label="Focus probe dialog"]')
    for (const action of ['Hide the trigger', 'Suspend the source', 'Replace the source']) {
      await click('Reset probe', '[data-focus-regression]')
      await run(`window.__focusTrigger=document.querySelector(${JSON.stringify(trigger)})`)
      await click('Focus probe menu', '[data-focus-regression]'); await click(action, '.my-menu'); await frames()
      assert.equal(await run('document.activeElement===window.__focusTrigger'), false, action + ' cancels delayed focus return')
      if (action === 'Hide the trigger') assert.ok(await run('window.__focusTrigger.isConnected&&!window.__focusTrigger.getClientRects().length'))
      if (action === 'Suspend the source') assert.ok(await run('window.__focusTrigger.isConnected&&window.__focusTrigger.getClientRects().length>0'))
      if (action === 'Replace the source') { assert.equal(await run('window.__focusTrigger.isConnected'), false); assert.equal(await isFocused(trigger), false) }
    }
    await click('Reset probe', '[data-focus-regression]'); await click('Focus probe menu', '[data-focus-regression]'); await closeModal(); await frames()
    assert.ok(await isFocused(trigger), 'Escape keeps dispatcher-owned focus return')
    await run('delete window.__focusTrigger;window.hifoxFixture.focusProbe(false)')
    await wait('Boolean(document.querySelector(".collab-workspace"))', 'actual workspace restored after shared-control checks')
  })
  await check('24-icon gallery loads actual light dark SVG resources at 16 20 24 pixels', async () => {
    await w.loadFile(join(root, 'resources/collaboration/index.html'))
    w.setContentSize(1440, 1300)
    await wait('[...document.images].length===144&&[...document.images].every(image=>image.complete&&image.naturalWidth>0)', 'gallery images')
    assert.equal(await run('document.querySelectorAll(".icon").length'), 48)
    await capture('collaboration-icon-gallery')
  })
  await check('allocation menu selection keeps keyboard focus inside the owning task dialog', async () => {
    assert.ok(allocationFocus.length > 0)
    assert.ok(allocationFocus.every((entry) => entry.inDialog && entry.activeLabel?.startsWith('分工：')), JSON.stringify(allocationFocus))
  })
  writeFileSync(join(reportDir, 'summary.json'), JSON.stringify({ status: 'passed', ...metadata() }, null, 2))
  console.log('HIFOX_WORKSPACE_UI_PASSED ' + checks.length)
  w.destroy(); app.quit()
}).catch(async (error) => {
  if (w && !w.isDestroyed()) {
    await capture('workspace-failed').catch(() => {})
    writeFileSync(join(reportDir, 'failure-screen.txt'), await run('document.body.innerText').catch(() => ''))
  }
  writeFileSync(join(reportDir, 'failure.json'), JSON.stringify({ status: 'failed', phase, message: error.message, stack: error.stack, ...metadata() }, null, 2))
  console.error('FAILED ' + phase + '\n' + error.stack)
  app.exit(1)
})
setTimeout(() => { console.error('HiFox workspace deadline: ' + phase); app.exit(1) }, 225000).unref()
