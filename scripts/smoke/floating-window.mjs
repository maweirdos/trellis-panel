/** Actual hidden Chromium rendering; only synthetic snapshot/store and API calls are mocked. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import config from '../../tailwind.config.js'

const screenshotArg = process.argv.indexOf('--screenshots')
const screenshotDirectory = screenshotArg < 0 ? process.env.FLOATING_WINDOW_SCREENSHOTS : process.argv[screenshotArg + 1]
if (screenshotArg >= 0) assert.ok(screenshotDirectory, '--screenshots requires an absolute directory')
if (screenshotDirectory) {
  assert.ok(isAbsolute(screenshotDirectory), 'screenshot directory must be absolute')
  mkdirSync(screenshotDirectory, { recursive: true })
}
const temporary = mkdtempSync(join(tmpdir(), 'tpanel-floating-window-'))
const fixtureTimeoutMs = 90000
const absolute = file => resolve(file).replace(/\\/g, '/')
const rendererRoot = 'src/renderer/src/'

// Keep test data and mocked IPC inside the isolated renderer, never the app profile.
const fixture = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {CapsuleView} from '${absolute(rendererRoot + 'components/CapsuleView.tsx')}';
const listeners = new Set(), snapshots = new Set();
const task = (id, status='in_progress', extra={}, info={}) => ({dirName:id,path:'D:/synthetic-floating/.trellis/tasks/'+id,taskJsonMtime:123,phase:({planning:'plan',in_progress:'implement',review:'review',completed:'completed',done:'completed'})[status]??'unknown',artifacts:[],record:{title:'Task '+id,status,priority:'P2',assignee:'Fixture developer',branch:'codex/fixture',subtasks:[],...extra},...info});
const snapshot = (tasks,root='D:/synthetic-floating') => ({meta:{name:'Synthetic floating fixture',root},tasks,archived:[]});
const withDocs = (item,names=['prd.md','design.md','handoff.md']) => ({...item,artifacts:names.map((name,index)=>({name,path:item.path+'/'+name,kind:'file',size:1024+index*381,mtime:Date.UTC(2026,9,20,5,index*9),ext:'.md'}))});
const guarded = withDocs(task('guarded-docs'));
guarded.artifacts.push({name:'outside.md',path:'D:/foreign-project/outside.md',kind:'file',size:3,mtime:1,ext:'.md'},{name:'escape.md',path:guarded.path+'/../escape.md',kind:'file',size:3,mtime:1,ext:'.md'},{name:'folder.md',path:guarded.path+'/folder.md',kind:'dir',size:0,mtime:1,ext:'.md'},{name:'task.json',path:guarded.path+'/task.json',kind:'file',size:3,mtime:1,ext:'.json'});
const long = task('long-metadata-'+('directory-'.repeat(12)),'in_progress',{
 title:'Layout and progress recovery '+('long task title with deliberate readable wrapping '.repeat(8)),
 assignee:'fixture-developer-'+('long-'.repeat(12)),branch:'codex/'+('long-unbroken-branch-name-'.repeat(14)),
 subtasks:[...Array.from({length:18},(_,i)=>(i===1?'- [x] ':'- [ ] ')+('Subtask '+(i+1)+' useful readable detail ').repeat(i===3?8:1)),'Reference only, not a checkbox']
});
const fixtures={long:snapshot([withDocs(long,['prd.md','design.md','handoff.md','review.md','reference-'+('very-long-document-name-'.repeat(10))+'.md'])]),normal:snapshot([task('completed','completed'),withDocs(task('active-a')),withDocs(task('active-b','review'))]),
 summary:snapshot([withDocs(task('10-19-floating-layout','review',{title:'\u64cd\u4f5c\u65e5\u5fd7\u589e\u52a0\u7b5b\u9009\u4e0e\u5206\u9875',branch:'feature/audit-filter'},{jiraKey:'DEMO-131'}))]),
 unknown:snapshot([task('unknown-phase','in_progress',{}, {phase:'unknown'})]),
 manyDocs:snapshot([withDocs(task('many-docs'),['prd.md','design.md','handoff.md','review.md','notes.md'])]),
 guarded:snapshot([guarded]),
 foreign:snapshot([{...withDocs(task('foreign-task')),path:'D:/foreign-project/.trellis/tasks/foreign-task',artifacts:[{name:'foreign.md',path:'D:/foreign-project/.trellis/tasks/foreign-task/foreign.md',kind:'file',size:48,mtime:Date.UTC(2026,9,20),ext:'.md'}]}],'D:/foreign-project'),
 fallback:snapshot([task('done-a','completed'),task('done-b','done')]),empty:snapshot([]),none:null,
 branchless:snapshot([task('branchless','planning',{branch:null,assignee:'',title:'No subtasks or branch'})])};
const runtime = window.__floatingSmoke = {calls:[],toasts:[],failures:{},results:{},holds:new Set(),pending:[],holdUpdates:false,pendingUpdate:null,snapshotOverride:null,deferStore:false,snapshotWrites:0,unhandled:[],snapshotListeners:snapshots,storeListeners:listeners,
 state:{snapshot:null,theme:'light',settings:{theme:'light'},setSnapshot(value){runtime.snapshotWrites++;runtime.latest=value;runtime.state={...runtime.state,snapshot:value};if(!runtime.deferStore)for(const listener of listeners)listener()},pushToast(value){runtime.toasts.push(value)}},
 api:{},latest:null};
window.addEventListener('unhandledrejection',event=>{runtime.unhandled.push(String(event.reason));event.preventDefault()});
const record=(name,args)=>{runtime.calls.push({name,args});const failure=runtime.failures[name];if(failure){delete runtime.failures[name];throw Error(failure)}};
for(const name of ['setCapsuleShape','setCapsuleOnTop','setCapsuleMode','closeCapsule','openInEditor','revealInExplorer','copyToClipboard','showQuickTodo','docOpen','openMainTask'])runtime.api[name]=async(...args)=>{record(name,args);if(runtime.holds.has(name))return new Promise((resolve,reject)=>runtime.pending.push({name,args,resolve,reject}));return runtime.results[name]??(['docOpen','openMainTask'].includes(name)?{ok:true}:undefined)};
runtime.api.onSnapshotUpdated=callback=>{snapshots.add(callback);return()=>snapshots.delete(callback)};
runtime.api.getSnapshot=async()=>{record('getSnapshot',[]);return runtime.snapshotOverride??runtime.latest};
runtime.api.updateTask=async(path,patch,mtime)=>{record('updateTask',[path,patch,mtime]);
 if(runtime.holdUpdates)await new Promise(done=>{runtime.pendingUpdate=done});
 if(runtime.updateError){const error=runtime.updateError;runtime.updateError=null;return{ok:false,error}}
 runtime.latest={...runtime.latest,tasks:runtime.latest.tasks.map(item=>item.path===path?{...item,record:{...item.record,...patch}}:item)};return{ok:true}};
const root=createRoot(document.getElementById('root'));let epoch=0;
window.floatingFixture={runtime,fixtures,mount({scenario='long',theme='light',size='standard',shape='card',pinned=true}={}){
 runtime.calls=[];runtime.toasts=[];runtime.failures={};runtime.results={};runtime.holds=new Set();runtime.pending=[];runtime.holdUpdates=false;runtime.pendingUpdate=null;runtime.snapshotOverride=null;runtime.deferStore=false;runtime.snapshotWrites=0;runtime.unhandled=[];runtime.updateError=null;
 runtime.state={...runtime.state,theme,settings:{theme}};
 const value=structuredClone(fixtures[scenario]);runtime.state.setSnapshot(value);
 history.replaceState(null,'','?shape='+shape+'&pinned='+pinned);document.documentElement.className=theme==='dark'?'dark is-capsule':'is-capsule';
 root.render(<div className="my-root" data-my-theme={theme} data-my-font-size={size} style={{height:'100%'}}><CapsuleView key={++epoch}/></div>);
},emit(value){for(const callback of snapshots)callback(structuredClone(value))},emitDeferred(value){runtime.deferStore=true;runtime.state.setSnapshot(structuredClone(value))},flush(){runtime.deferStore=false;for(const listener of listeners)listener()},unmount(){root.render(null)}};
window.floatingFixture.mount();`

async function waitForViewport({ width, height }) {
  const deadline = performance.now() + 3000
  while (innerWidth !== width || innerHeight !== height) {
    if (performance.now() > deadline) throw Error(`native viewport resize timed out: requested ${width}x${height}, actual ${innerWidth}x${innerHeight}`)
    await new Promise(done => setTimeout(done, 20))
  }
  await new Promise(done => requestAnimationFrame(done))
  return { width: innerWidth, height: innerHeight, scale: devicePixelRatio }
}

async function layoutChecks({ theme, size, width, height, scenario = 'long' }) {
  const fixture = window.floatingFixture
  fixture.mount({ theme, size, scenario })
  await new Promise(done => setTimeout(done, 70))
  const passed = []
  const check = (name, value, detail) => {
    if (!value) throw Error(`${theme}/${size}/${innerWidth}x${innerHeight}: ${name}: ${JSON.stringify(detail)}`)
    passed.push(name)
  }
  const body = document.querySelector('.my-floating-body')
  const header = document.querySelector('header')
  const footer = document.querySelector('footer')
  const title = document.querySelector('h1')
  const box = element => element.getBoundingClientRect()
  const text = element => getComputedStyle(element).userSelect === 'text'
  check('native viewport matches requested dimensions', innerWidth === width && innerHeight === height, { requested: [width, height], actual: [innerWidth, innerHeight] })
  check('real component mounted with one snapshot subscription', body && header && footer && title && fixture.runtime.snapshotListeners.size === 1)
  check('theme and font preference inherited', document.querySelector('.my-root').dataset.myTheme === theme && getComputedStyle(document.querySelector('.my-root')).fontSize === ({ small: '13px', standard: '14px', large: '15px' })[size])
  check('no document, body or content horizontal overflow', [document.documentElement, document.body, body].every(element => element.scrollWidth <= element.clientWidth + 1), { document: document.documentElement.scrollWidth, body: document.body.scrollWidth, content: body.scrollWidth, viewport: innerWidth })
  check('header carries project identity', header.textContent.includes(fixture.runtime.latest.meta.name))
  const footerButtons = [...footer.querySelectorAll('button')]
  check('four labelled light footer actions with one main entry', footerButtons.length === 4 && ['\u5de5\u7a0b', '\u76ee\u5f55', '\u901f\u8bb0', '\u4e3b\u9762\u677f'].every(label => footerButtons.some(button => button.textContent.trim() === label)) && [...document.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === '\u6253\u5f00\u4e3b\u9762\u677f').length === 1)
  const mainButton = footerButtons.find(button => button.textContent.trim() === '\u4e3b\u9762\u677f')
  const range = document.createRange()
  const walker = document.createTreeWalker(mainButton, NodeFilter.SHOW_TEXT)
  let lastText = null
  while (walker.nextNode()) if (walker.currentNode.textContent.trim()) lastText = walker.currentNode
  range.selectNodeContents(lastText)
  const bodyStyle = getComputedStyle(body)
  const firstGlyph = footerButtons[0].querySelector('svg')
  const contentLeft = box(body).left + parseFloat(bodyStyle.paddingLeft)
  const contentRight = box(body).right - parseFloat(bodyStyle.paddingRight) - (body.offsetWidth - body.clientWidth)
  const footerBoxes = footerButtons.map(box)
  const footerGaps = footerBoxes.slice(1).map((rect, index) => rect.left - footerBoxes[index].right)
  check('footer visible edges align with body including scrollbar space', Math.abs(box(firstGlyph).left - contentLeft) <= 1 && Math.abs(range.getBoundingClientRect().right - contentRight) <= 1, { left: box(firstGlyph).left, contentLeft, right: range.getBoundingClientRect().right, contentRight })
  check('footer controls share height and evenly distributed gaps', footerBoxes.every(rect => Math.abs(rect.top - footerBoxes[0].top) <= 1 && Math.abs(rect.height - footerBoxes[0].height) <= 1) && Math.max(...footerGaps) - Math.min(...footerGaps) <= 1 && footerButtons.every(button => button.scrollWidth <= button.clientWidth + 1), { footerBoxes: footerBoxes.map(rect => [rect.left, rect.top, rect.width, rect.height]), footerGaps })
  const titleStyle = getComputedStyle(title)
  check('two-line title clamp with full tooltip', titleStyle.webkitLineClamp === '2' && title.title === fixture.runtime.latest.tasks[0].record.title && (scenario !== 'long' || title.scrollHeight > title.clientHeight) && box(title).height <= parseFloat(titleStyle.lineHeight) * 2 + 1, { clamp: titleStyle.webkitLineClamp, title: title.title, height: box(title).height, lineHeight: titleStyle.lineHeight })
  const current = fixture.runtime.latest.tasks[0]
  const metadata = [...body.querySelectorAll('[title]')].find(element => element.title.includes(current.dirName))
  const branch = [...body.querySelectorAll('[title]')].find(element => element.title === current.record.branch)
  check('title, task metadata and actual branch remain selectable', metadata && text(title) && text(metadata) && (!current.record.branch || (branch && text(branch))))
  check('task identity and actual branch expose full values', metadata?.title.includes(current.dirName) && (!current.record.branch || branch?.title === current.record.branch))
  check('drag header and non-drag interactive zones', getComputedStyle(header).webkitAppRegion === 'drag' && [body, footer, ...header.querySelectorAll('button')].every(element => getComputedStyle(element).webkitAppRegion === 'no-drag'))
  const disclosure = [...body.querySelectorAll('button')].find(button => /\u5b50\u4efb\u52a1/.test((button.getAttribute('aria-label') ?? '') + button.textContent) && button.hasAttribute('aria-expanded'))
  if (current.record.subtasks.length) {
    check('subtasks remain a closed secondary disclosure initially', disclosure && disclosure.getAttribute('aria-expanded') === 'false' && !body.querySelector('[role=checkbox]'))
    disclosure.click()
    await new Promise(done => setTimeout(done, 40))
    check('expanded subtasks scroll internally', body.querySelectorAll('[role=checkbox]').length === current.record.subtasks.length && body.scrollHeight > body.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(body).overflowY), { client: body.clientHeight, scroll: body.scrollHeight })
  } else {
    check('small no-child task has no child disclosure or reserved panel', !disclosure && !body.querySelector('[role=checkbox]') && body.scrollHeight <= body.clientHeight)
  }
  const before = [box(header).top, box(footer).top]
  body.scrollTop = body.scrollHeight
  await new Promise(done => requestAnimationFrame(done))
  check('header and footer stay anchored for scrolling and compact content', (scenario !== 'long' || body.scrollTop > 0) && [box(header).top, box(footer).top].every((value, index) => Math.abs(value - before[index]) < 1))
  check('header and footer stay inside viewport', box(header).top >= 0 && box(footer).bottom <= innerHeight && box(footer).top >= box(header).bottom)
  body.scrollTop = 0
  return { passed, background: getComputedStyle(document.querySelector('.my-floating-surface')).backgroundColor }
}

async function pillChecks({ theme, size, width, height }) {
  window.floatingFixture.mount({ scenario: 'normal', theme, size, shape: 'pill' })
  await new Promise(done => setTimeout(done, 70))
  if (innerWidth !== width || innerHeight !== height) throw Error(`pill viewport mismatch: requested ${width}x${height}, actual ${innerWidth}x${innerHeight}`)
  const strip = document.querySelector('.my-floating-strip')
  const buttons = strip?.querySelectorAll('button')
  const surface = document.querySelector('.my-floating-surface')?.getBoundingClientRect()
  if (!strip || !buttons?.length || !surface) throw Error('pill did not mount')
  if ([document.documentElement, document.body, strip].some(element => element.scrollWidth > element.clientWidth + 1)) throw Error('pill horizontal overflow')
  if (surface.top < 0 || surface.bottom > innerHeight) throw Error('pill exceeds native height')
  if (getComputedStyle(strip).webkitAppRegion !== 'drag' || ![...buttons].every(button => getComputedStyle(button).webkitAppRegion === 'no-drag')) throw Error('pill drag/no-drag regions')
  if (![...buttons].some(button => button.getAttribute('aria-label') === '\u6253\u5f00\u4e3b\u9762\u677f')) throw Error('pill main entry missing')
  return `${theme}/${size}/${innerWidth}x${innerHeight}: pill bounds, drag regions and main entry`
}

function focusCheck() {
  const active = document.activeElement
  const style = getComputedStyle(active)
  if (active.tagName !== 'BUTTON' || !active.matches(':focus-visible') || style.outlineStyle === 'none' || parseFloat(style.outlineWidth) <= 0 || style.outlineColor === 'rgba(0, 0, 0, 0)') throw Error(`keyboard button focus invisible: ${active.tagName}/${style.outlineStyle}/${style.outlineWidth}`)
  return 'keyboard Tab gives floating-window button a visible focus outline'
}

async function interactionChecks() {
  const fixture = window.floatingFixture
  const runtime = fixture.runtime
  const passed = []
  const wait = () => new Promise(done => setTimeout(done, 60))
  const check = (name, value, detail) => {
    if (!value) throw Error(`${name}: ${JSON.stringify(detail)}`)
    passed.push(name)
  }
  const mount = async options => { fixture.mount(options); await wait() }
  const byLabel = label => [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent.trim() === label)
  const click = async label => { const button = byLabel(label); check(`action available: ${label}`, button && !button.disabled); button.click(); await wait() }
  const calls = name => runtime.calls.filter(call => call.name === name)
  const title = () => document.querySelector('h1')?.textContent
  const labels = { previous: '\u4e0a\u4e00\u4e2a\u4efb\u52a1', next: '\u4e0b\u4e00\u4e2a\u4efb\u52a1', copy: '\u590d\u5236\u4efb\u52a1\u4fe1\u606f', editor: '\u6253\u5f00\u5f53\u524d\u5de5\u7a0b', folder: '\u6253\u5f00\u4efb\u52a1\u76ee\u5f55', note: '\u901f\u8bb0', main: '\u6253\u5f00\u4e3b\u9762\u677f', hide: '\u9690\u85cf\u4efb\u52a1\u60ac\u6d6e\u7a97', pin: '\u53d6\u6d88\u7f6e\u9876', unpin: '\u7f6e\u9876\u7a97\u53e3', collapse: '\u6536\u8d77\u4e3a\u4efb\u52a1\u72b6\u6001\u6761', expand: '\u5c55\u5f00\u4efb\u52a1\u60ac\u6d6e\u7a97' }
  await mount({ scenario: 'normal' })
  check('active task filtering starts at first active task', title() === 'Task active-a')
  await click(labels.previous)
  check('previous wraps within active tasks', title() === 'Task active-b')
  await click(labels.next)
  check('next wraps within active tasks', title() === 'Task active-a')
  await click(labels.copy)
  check('copy keeps original task payload and toast', calls('copyToClipboard').at(-1).args[0] === 'active-a Task active-a' && runtime.toasts.at(-1)?.kind === 'info')
  await click(labels.editor)
  await click(labels.folder)
  await click(labels.note)
  await click(labels.main)
  await click(labels.hide)
  check('all four footer actions and hide reach real native APIs', calls('openInEditor')[0].args[0] === runtime.latest.meta.root && calls('revealInExplorer')[0].args[0] === runtime.latest.tasks[1].path && calls('showQuickTodo').length === 1 && calls('openMainTask')[0].args[0] === runtime.latest.meta.root && calls('openMainTask')[0].args[1] === 'active-a' && calls('closeCapsule').length === 1)
  await click(labels.pin)
  check('pin button state follows successful IPC', calls('setCapsuleOnTop').at(-1).args[0] === false && byLabel(labels.unpin)?.getAttribute('aria-pressed') === 'false')
  await click(labels.unpin)
  check('pin toggles back', calls('setCapsuleOnTop').at(-1).args[0] === true && byLabel(labels.pin)?.getAttribute('aria-pressed') === 'true')
  runtime.failures.openInEditor = 'Synthetic editor failure'
  await click(labels.editor)
  check('action failure has visible alert', document.querySelector('[role=alert]')?.textContent.includes('Synthetic editor failure'))
  await click(labels.folder)
  check('subsequent action clears error', !document.querySelector('[role=alert]'))
  await mount({ scenario: 'fallback' })
  check('all tasks remain reachable without active tasks', title() === 'Task done-a')
  await click(labels.next)
  check('fallback navigation reaches completed tasks', title() === 'Task done-b')

  await mount({ scenario: 'long' })
  const disclosure = [...document.querySelectorAll('button')].find(button => /\u5b50\u4efb\u52a1/.test((button.getAttribute('aria-label') ?? '') + button.textContent) && button.hasAttribute('aria-expanded'))
  check('subtask disclosure is closed before explicit user action', disclosure?.getAttribute('aria-expanded') === 'false' && !document.querySelector('[role=checkbox]'))
  disclosure.click()
  await wait()
  check('invalid subtask entries disabled', [...document.querySelectorAll('[role=checkbox]')].at(-1)?.disabled)
  const original = structuredClone(runtime.latest.tasks[0])
  runtime.holdUpdates = true
  document.querySelector('[role=checkbox]').click()
  await wait()
  check('busy disables all subtasks and blocks duplicate mutation', [...document.querySelectorAll('[role=checkbox]')].every(button => button.disabled) && calls('updateTask').length === 1)
  document.querySelector('[role=checkbox]').click()
  check('disabled subtask cannot queue another update', calls('updateTask').length === 1)
  const update = calls('updateTask')[0]
  check('subtask patch preserves siblings and mtime', update.args[0] === original.path && update.args[2] === original.taskJsonMtime && update.args[1].subtasks[0] === original.record.subtasks[0].replace('[ ]', '[x]') && update.args[1].subtasks.slice(1).every((value, index) => value === original.record.subtasks[index + 1]))
  runtime.pendingUpdate()
  await wait()
  check('successful mutation refreshes snapshot and checkbox', calls('getSnapshot').length === 1 && document.querySelector('[role=checkbox]').getAttribute('aria-checked') === 'true' && !document.querySelector('[role=checkbox]').disabled)
  runtime.holdUpdates = false
  runtime.updateError = 'Synthetic update rejected'
  document.querySelector('[role=checkbox]').click()
  await wait()
  check('failed mutation shows feedback and unlocks controls', document.querySelector('[role=alert]')?.textContent.includes('Synthetic update rejected') && !document.querySelector('[role=checkbox]').disabled && document.querySelector('[role=checkbox]').getAttribute('aria-checked') === 'true')
  fixture.emit(fixture.fixtures.branchless)
  await wait()
  check('snapshot subscription updates rendered task', title() === 'No subtasks or branch' && runtime.snapshotListeners.size === 1)
  check('no-subtask and branchless state has no reserved child section', !document.querySelector('[role=progressbar]') && !document.querySelector('[role=checkbox]') && !document.querySelector('[title="codex/fixture"]') && !document.body.textContent.includes('\u6682\u65e0\u5b50\u4efb\u52a1'))
  check('single-task navigation disabled', byLabel(labels.previous)?.disabled && byLabel(labels.next)?.disabled)
  await mount({ scenario: 'empty' })
  check('empty project disables task directory but keeps project actions', document.body.textContent.includes('\u5f53\u524d\u9879\u76ee\u6682\u65e0\u4efb\u52a1') && !byLabel(labels.editor)?.disabled && byLabel(labels.folder)?.disabled && !byLabel(labels.note)?.disabled)
  await mount({ scenario: 'none' })
  check('no-project state is distinct', document.body.textContent.includes('\u6253\u5f00\u9879\u76ee\u540e\u5f00\u59cb\u5de5\u4f5c') && byLabel(labels.editor)?.disabled)
  await mount({ scenario: 'normal' })
  runtime.failures.setCapsuleShape = 'Synthetic shape failure'
  await click(labels.collapse)
  check('shape rejection preserves card and surfaces error', document.querySelector('footer') && document.querySelector('[role=alert]')?.textContent.includes('Synthetic shape failure'))
  await click(labels.collapse)
  check('collapse switches shape with retained pill main entry', document.querySelector('.my-floating-strip') && calls('setCapsuleShape').at(-1).args[0] === 'pill' && byLabel(labels.main))
  await click(labels.main)
  check('pill main-panel action remains owner-scoped', calls('openMainTask').at(-1).args[0] === runtime.latest.meta.root && calls('openMainTask').at(-1).args[1] === 'active-a')
  await click(labels.expand)
  check('expand restores card through IPC', document.querySelector('footer') && calls('setCapsuleShape').at(-1).args[0] === 'card')
  fixture.unmount()
  await wait()
  check('snapshot and store subscriptions clean up on unmount', runtime.snapshotListeners.size === 0 && runtime.storeListeners.size === 0)
  return passed
}

async function materialChecks() {
  const fixture = window.floatingFixture
  const runtime = fixture.runtime
  const passed = []
  const wait = () => new Promise(done => setTimeout(done, 70))
  const check = (name, value, detail) => {
    if (!value) throw Error(`${name}: ${JSON.stringify(detail)}`)
    passed.push(name)
  }
  const mount = async scenario => { fixture.mount({ scenario }); await wait() }
  const calls = name => runtime.calls.filter(call => call.name === name)
  const buttonByLabel = label => [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent.trim() === label)
  const docButtons = () => [...document.querySelectorAll('button')].filter(button => /\.md(?:$|\s)/i.test(button.title) || /\.md(?:$|\s)/i.test(button.getAttribute('aria-label') ?? ''))
  const clickDoc = async () => {
    const button = docButtons()[0]
    check('real task document action exists', button && !button.disabled)
    button.click()
    await wait()
  }
  const settle = async (name, result) => {
    const index = runtime.pending.findIndex(pending => pending.name === name)
    check(`pending operation exists: ${name}`, index >= 0)
    runtime.pending.splice(index, 1)[0].resolve(result)
    await wait()
  }
  await mount('summary')
  check('no-subtask card shows three real documents without child placeholder', docButtons().length === 3 && !document.querySelector('[role=checkbox]') && !document.body.textContent.includes('\u6682\u65e0\u5b50\u4efb\u52a1'))
  check('actual source identity is visible', document.body.textContent.includes('DEMO-131'))
  const materialSection = docButtons()[0].closest('section')
  check('file facts never invent review approval or document version', !/\u5df2\u786e\u8ba4|\u5f85\u8865\u5168|\bv\d+\b/i.test(materialSection.textContent), materialSection.textContent)
  check('local task phases never claim Jira testing receipts', !/\u63d0\u6d4b|\u6d4b\u8bd5\u901a\u8fc7/.test(document.querySelector('.my-floating-body').textContent))
  await clickDoc()
  const request = calls('docOpen')[0].args[0]
  check('document opens with actual owner path, title and theme', request.file === runtime.latest.tasks[0].artifacts[0].path && typeof request.key === 'string' && request.key.length > 0 && typeof request.title === 'string' && request.title.length > 0 && request.theme === 'light', request)
  runtime.results.docOpen = { ok: false, error: 'Synthetic document unavailable' }
  await clickDoc()
  check('native document rejection is visible', document.querySelector('[role=alert]')?.textContent.includes('Synthetic document unavailable'))
  delete runtime.results.docOpen
  await clickDoc()
  check('retrying a document clears its error', !document.querySelector('[role=alert]'))

  await mount('guarded')
  check('foreign, traversal, directory and non-Markdown artifacts stay non-actionable', docButtons().length === 3 && !document.body.textContent.includes('outside') && !document.body.textContent.includes('escape') && !document.body.textContent.includes('folder.md') && !document.body.textContent.includes('task.json'))

  await mount('manyDocs')
  check('three documents are the bounded default', docButtons().length === 3)
  const all = [...document.querySelectorAll('button')].find(button => /\u5168\u90e8\u8d44\u6599/.test((button.getAttribute('aria-label') ?? '') + button.textContent))
  check('all-documents action is available', all && !all.disabled)
  all.click()
  await wait()
  check('all-documents reaches remaining files or owner-scoped main detail', docButtons().length === 5 || calls('openMainTask').some(call => call.args[0] === runtime.latest.meta.root && call.args[1] === 'many-docs'))

  await mount('normal')
  runtime.holds.add('docOpen')
  await clickDoc()
  const oldPath = calls('docOpen')[0].args[0].file
  buttonByLabel('\u4e0b\u4e00\u4e2a\u4efb\u52a1').click()
  await wait()
  await settle('docOpen', { ok: false, error: 'Stale first-task document error' })
  check('late document result cannot attach to another task', document.querySelector('h1').textContent === 'Task active-b' && !document.querySelector('[role=alert]') && oldPath.includes('/active-a/'))
  runtime.holds.delete('docOpen')
  await clickDoc()
  check('next task opens its own document', calls('docOpen').at(-1).args[0].file.includes('/active-b/'))

  await mount('normal')
  runtime.holds.add('docOpen')
  await clickDoc()
  buttonByLabel('\u4e0b\u4e00\u4e2a\u4efb\u52a1').click()
  await wait()
  buttonByLabel('\u4e0b\u4e00\u4e2a\u4efb\u52a1').click()
  await wait()
  await settle('docOpen', { ok: false, error: 'Superseded A-B-A request error' })
  check('returning to the same task does not revive an old document request', document.querySelector('h1').textContent === 'Task active-a' && !document.querySelector('[role=alert]'))

  await mount('summary')
  runtime.holds.add('docOpen')
  await clickDoc()
  docButtons()[1].click()
  await wait()
  check('separate document openings capture each actual file', calls('docOpen').length === 2 && calls('docOpen')[0].args[0].file.endsWith('/prd.md') && calls('docOpen')[1].args[0].file.endsWith('/design.md'))
  await settle('docOpen', { ok: false, error: 'Older document opening failed' })
  check('older completion preserves the newer document pending state', !document.querySelector('[role=alert]') && docButtons()[1].getAttribute('aria-busy') === 'true')
  await settle('docOpen', { ok: true })
  check('latest document completion clears its own pending state', !document.querySelector('[aria-busy=true]'))

  await mount('normal')
  runtime.holds.add('docOpen')
  await clickDoc()
  fixture.emit({ ...structuredClone(runtime.latest), tasks: [structuredClone(runtime.latest.tasks[2])] })
  await wait()
  await settle('docOpen', { ok: false, error: 'Removed-task document error' })
  check('removed task completion cannot replace current task feedback', document.querySelector('h1').textContent === 'Task active-b' && !document.querySelector('[role=alert]'))

  await mount('normal')
  runtime.holds.add('docOpen')
  await clickDoc()
  fixture.emit(fixture.fixtures.foreign)
  await wait()
  await settle('docOpen', { ok: false, error: 'Foreign-project document error' })
  check('project switch isolates late document feedback and document list', runtime.latest.meta.root === 'D:/foreign-project' && !document.querySelector('[role=alert]') && docButtons().every(button => !button.title.includes('D:/synthetic-floating/')))

  await mount('normal')
  runtime.holds.add('openMainTask')
  buttonByLabel('\u6253\u5f00\u4e3b\u9762\u677f').click()
  await wait()
  const mainRequest = calls('openMainTask')[0]
  fixture.emit(fixture.fixtures.foreign)
  await wait()
  await settle('openMainTask', { ok: false, error: 'Stale main-navigation error' })
  check('main navigation captures root and task and isolates late rejection', mainRequest.args[0] === 'D:/synthetic-floating' && mainRequest.args[1] === 'active-a' && runtime.latest.meta.root === 'D:/foreign-project' && !document.querySelector('[role=alert]'))

  await mount('normal')
  runtime.results.docOpen = { ok: false, error: 'Visible error from previous project' }
  await clickDoc()
  check('source document failure is initially visible', document.querySelector('[role=alert]')?.textContent.includes('Visible error from previous project'))
  fixture.emit(fixture.fixtures.foreign)
  await wait()
  check('already displayed errors do not follow a project switch', !document.querySelector('[role=alert]'))

  await mount('normal')
  buttonByLabel('\u4e0b\u4e00\u4e2a\u4efb\u52a1').click()
  await wait()
  check('selection-reset scenario really selected the second task', document.querySelector('h1').textContent === 'Task active-b')
  const foreignSharedNames = structuredClone(fixture.fixtures.normal)
  foreignSharedNames.meta.root = 'D:/foreign-project'
  foreignSharedNames.tasks = foreignSharedNames.tasks.filter(task => task.record.status !== 'completed').map(task => ({ ...task, path: task.path.replace('D:/synthetic-floating', 'D:/foreign-project'), record: { ...task.record, title: 'Foreign ' + task.dirName }, artifacts: task.artifacts.map(file => ({ ...file, path: file.path.replace('D:/synthetic-floating', 'D:/foreign-project') })) }))
  fixture.emit(foreignSharedNames)
  await wait()
  check('a new project starts its own ephemeral task selection despite shared task names', document.querySelector('h1').textContent === 'Foreign active-a')

  for (const scenario of ['project', 'task', 'material']) {
    await mount('summary')
    const staleButton = docButtons()[0]
    const next = scenario === 'project' ? structuredClone(fixture.fixtures.foreign) : structuredClone(runtime.latest)
    if (scenario === 'task') next.tasks = []
    if (scenario === 'material') next.tasks[0].artifacts = next.tasks[0].artifacts.slice(1)
    fixture.emitDeferred(next)
    check(`stale ${scenario} click uses a still-mounted pre-commit control`, staleButton.isConnected)
    staleButton.click()
    await wait()
    check(`live snapshot rejects stale ${scenario} document dispatch before React commits`, calls('docOpen').length === 0)
    fixture.flush()
    await wait()
  }

  await mount('long')
  const disclosure = [...document.querySelectorAll('button')].find(button => button.hasAttribute('aria-expanded') && /\u5b50\u4efb\u52a1/.test(button.textContent))
  disclosure.click()
  await wait()
  runtime.snapshotOverride = structuredClone(runtime.latest)
  runtime.holdUpdates = true
  document.querySelector('[role=checkbox]').click()
  await wait()
  fixture.emit(fixture.fixtures.foreign)
  await wait()
  runtime.pendingUpdate()
  await wait()
  check('late subtask refresh cannot restore the previous project snapshot', runtime.latest.meta.root === 'D:/foreign-project' && document.querySelector('h1').textContent === 'Task foreign-task')

  for (const name of ['docOpen', 'openMainTask']) {
    await mount('summary')
    runtime.holds.add(name)
    if (name === 'docOpen') await clickDoc()
    else { buttonByLabel('\u6253\u5f00\u4e3b\u9762\u677f').click(); await wait() }
    const pending = runtime.pending.find(operation => operation.name === name)
    check(`unmount scenario really has an in-flight ${name} operation`, pending)
    fixture.unmount()
    await wait()
    const writes = runtime.snapshotWrites
    pending.resolve({ ok: false, error: 'Late error after unmount: ' + name })
    await wait()
    check(`unmounted ${name} result has no UI, global state write or unhandled rejection`, !document.querySelector('.my-floating-surface') && runtime.snapshotWrites === writes && runtime.unhandled.length === 0 && runtime.snapshotListeners.size === 0 && runtime.storeListeners.size === 0)
  }

  await mount('long')
  const unmountDisclosure = [...document.querySelectorAll('button')].find(button => button.hasAttribute('aria-expanded') && /\u5b50\u4efb\u52a1/.test(button.textContent))
  unmountDisclosure.click()
  await wait()
  runtime.snapshotOverride = structuredClone(runtime.latest)
  runtime.holdUpdates = true
  document.querySelector('[role=checkbox]').click()
  await wait()
  fixture.unmount()
  await wait()
  const writesAfterUnmount = runtime.snapshotWrites
  runtime.pendingUpdate()
  await wait()
  check('unmounted subtask completion cannot publish an old snapshot', runtime.snapshotWrites === writesAfterUnmount && runtime.unhandled.length === 0)

  await mount('unknown')
  const body = document.querySelector('.my-floating-body')
  const phaseDescription = body.querySelector('ol[aria-label]')?.getAttribute('aria-label') ?? ''
  check('unknown phase remains unknown rather than inferred from status', /\u672a\u77e5|\u672a\u8bc6\u522b|\u672a\u786e\u5b9a/.test(body.textContent + phaseDescription) && !body.querySelector('[aria-current=step]'), { text: body.textContent, phaseDescription })
  check('unknown phase never invents approval or publication', !/\u9700\u6c42\u5df2\u786e\u8ba4|\u63d0\u6d4b\u6210\u529f|\u6d4b\u8bd5\u901a\u8fc7/.test(body.textContent))
  return passed
}

try {
  const entry = join(temporary, 'entry.tsx')
  writeFileSync(entry, fixture)
  const mocks = {
    '../store': `import{useSyncExternalStore}from 'react';export const useApp=selector=>useSyncExternalStore(listener=>{const set=window.__floatingSmoke.storeListeners;set.add(listener);return()=>set.delete(listener)},()=>selector(window.__floatingSmoke.state));useApp.getState=()=>window.__floatingSmoke.state;`,
    '../api': 'export const api=new Proxy({},{get:(_,key)=>window.__floatingSmoke.api[key]});'
  }
  await build({ entryPoints: [entry], outfile: join(temporary, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [absolute('node_modules')], plugins: [{ name: 'synthetic-store-and-api', setup(builder) {
    builder.onResolve({ filter: /^\.\.\/(store|api)$/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js', resolveDir: process.cwd() }))
  } }] })
  const cssFiles = ['my/my-tokens.css', 'my/my-components.css', 'my/my-shell.css', 'my/my-utilities.css', 'styles.css']
  const css = (await postcss([tailwind(config)]).process(cssFiles.map(file => readFileSync(rendererRoot + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(temporary, 'index.html'), `<!doctype html><html class="is-capsule"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  await build({ entryPoints: ['src/shared/floating-window.ts'], outfile: join(temporary, 'bounds.cjs'), bundle: true, platform: 'node', format: 'cjs' })
  const evaluate = fn => `(${fn.toString()})`
  writeFileSync(join(temporary, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const {writeFileSync}=require('node:fs');const {join}=require('node:path');
const {FLOATING_TASK_WINDOWS:bounds}=require('./bounds.cjs');
assert.deepEqual([bounds.card.width,bounds.card.height,bounds.card.minWidth,bounds.card.minHeight],[400,380,360,320],'approved native card dimensions');assert.deepEqual([bounds.pill.width,bounds.pill.height,bounds.pill.minWidth,bounds.pill.minHeight],[440,64,360,64],'pill dimensions remain unchanged');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.disableHardwareAcceleration();
const screenshotDirectory=${JSON.stringify(screenshotDirectory ?? null)};
const layout=${JSON.stringify(evaluate(layoutChecks))},interactions=${JSON.stringify(evaluate(interactionChecks))},materials=${JSON.stringify(evaluate(materialChecks))},pill=${JSON.stringify(evaluate(pillChecks))},focus=${JSON.stringify(evaluate(focusCheck))},viewport=${JSON.stringify(evaluate(waitForViewport))};
app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,frame:false,width:bounds.card.width,height:bounds.card.height,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
const errors=[];window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message)});window.webContents.on('render-process-gone',(_event,details)=>{throw Error('renderer gone: '+details.reason)});
await window.loadFile(${JSON.stringify(join(temporary, 'index.html'))});window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
const checkFocus=async()=>{for(const type of ['keyDown','keyUp'])await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await window.webContents.executeJavaScript(focus+'()')};
const resize=async(width,height)=>{window.setContentSize(width,height);await window.webContents.executeJavaScript(viewport+'('+JSON.stringify({width,height})+')');assert.deepEqual(window.getContentSize(),[width,height],'native content size matches requested viewport')};
const capture=async(name,width,height)=>{if(screenshotDirectory){const actual=await window.webContents.executeJavaScript(viewport+'('+JSON.stringify({width,height})+')');assert.deepEqual(window.getContentSize(),[width,height],'screenshot native content size');const image=await window.webContents.capturePage();const physical=image.getSize();assert.deepEqual(physical,{width:Math.round(width*actual.scale),height:Math.round(height*actual.scale)},'captured physical dimensions match requested CSS viewport and display scale');writeFileSync(join(screenshotDirectory,name+'.png'),image.toPNG());console.log('SCREENSHOT '+join(screenshotDirectory,name+'.png')+' ['+width+'x'+height+' CSS / '+physical.width+'x'+physical.height+' physical @'+actual.scale+']')}};
const backgrounds={};let layoutCount=0;
for(const [width,height]of [[bounds.card.width,bounds.card.height],[bounds.card.minWidth,bounds.card.minHeight]])for(const theme of ['light','dark'])for(const size of ['small','standard','large']){
await resize(width,height);const result=await window.webContents.executeJavaScript(layout+'('+JSON.stringify({theme,size,width,height})+')');await checkFocus();backgrounds[theme]=result.background;layoutCount+=result.passed.length;console.log('PASS '+theme+'/'+size+'/'+width+'x'+height+': '+result.passed.length+' renderer layout checks and keyboard focus');
if(size==='standard'||(width===bounds.card.minWidth&&size==='large'))await capture(theme+'-'+width+'x'+height+'-'+size,width,height)}
assert.notEqual(backgrounds.light,backgrounds.dark,'actual theme colors differ');console.log('PASS actual light/dark surface paint differs');
await resize(bounds.card.width,bounds.card.height);for(const theme of ['light','dark'])for(const size of ['small','standard','large']){const result=await window.webContents.executeJavaScript(layout+'('+JSON.stringify({theme,size,width:bounds.card.width,height:bounds.card.height,scenario:'branchless'})+')');layoutCount+=result.passed.length;console.log('PASS '+theme+'/'+size+': compact non-scrolling content, footer edge alignment and '+result.passed.length+' layout checks')}
for(const theme of ['light','dark']){await resize(bounds.card.width,bounds.card.height);await window.webContents.executeJavaScript('window.floatingFixture.mount('+JSON.stringify({scenario:'summary',theme})+');new Promise(done=>setTimeout(done,70))');const compact=await window.webContents.executeJavaScript('(()=>{const body=document.querySelector(".my-floating-body");return {client:body.clientHeight,scroll:body.scrollHeight,checkboxes:body.querySelectorAll("[role=checkbox]").length}})()');assert.equal(compact.checkboxes,0,'normal no-subtask card has no child controls');assert.ok(compact.scroll<=compact.client+1,'standard no-subtask card fits real materials and phases without body scrolling: '+JSON.stringify(compact));await capture(theme+'-'+bounds.card.width+'x'+bounds.card.height+'-no-subtasks',bounds.card.width,bounds.card.height);await window.webContents.executeJavaScript('window.floatingFixture.mount('+JSON.stringify({scenario:'branchless',theme})+');new Promise(done=>setTimeout(done,70))');await capture(theme+'-'+bounds.card.width+'x'+bounds.card.height+'-no-materials',bounds.card.width,bounds.card.height)}
await resize(bounds.card.width,bounds.card.height);for(const name of await window.webContents.executeJavaScript(interactions+'()'))console.log('PASS '+name);
for(const name of await window.webContents.executeJavaScript(materials+'()'))console.log('PASS '+name);
for(const [width,height]of [[bounds.pill.width,bounds.pill.height],[bounds.pill.minWidth,bounds.pill.minHeight]])for(const theme of ['light','dark'])for(const size of ['small','standard','large']){
await resize(width,height);console.log('PASS '+await window.webContents.executeJavaScript(pill+'('+JSON.stringify({theme,size,width,height})+')'));await checkFocus();
if(size==='standard'&&width===bounds.pill.width)await capture(theme+'-pill',width,height);if(size==='large'&&width===bounds.pill.minWidth)await capture(theme+'-pill-'+width+'x'+height+'-large',width,height)}
assert.deepEqual(errors,[],'renderer console errors');console.log('Floating-window smoke passed: '+layoutCount+' card layout assertions across 12 scrolling and 6 compact theme/font/viewport combinations; 12 native-sized pill combinations; keyboard focus, scoped native actions, real-material facts and lifecycle races. Native OS drag/pin behavior is not exercised.');window.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});setTimeout(()=>{console.error('floating-window fixture timed out');app.exit(1)},${fixtureTimeoutMs});`)
  const require = createRequire(import.meta.url)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(require('electron'), [join(temporary, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: fixtureTimeoutMs + 10000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-floating-window-'))
  rmSync(temporary, { recursive: true, force: true })
}
