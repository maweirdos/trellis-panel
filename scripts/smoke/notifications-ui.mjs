/** Mounted production notifications in isolated, hidden Electron Chromium. No real IPC or OS notifications. */
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
const screenshotDirectory = screenshotArg < 0 ? undefined : process.argv[screenshotArg + 1]
if (screenshotArg >= 0) assert.ok(screenshotDirectory && isAbsolute(screenshotDirectory), '--screenshots requires an absolute directory')
if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true })
const temporary = mkdtempSync(join(tmpdir(), 'tpanel-notifications-ui-'))
const absolute = file => resolve(file).replace(/\\/g, '/')
const rendererRoot = 'src/renderer/src/'

const fixture = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {flushSync} from '${absolute('node_modules/react-dom/index.js')}';
import {create} from '${absolute('node_modules/zustand/esm/index.mjs')}';
import {toastSlice} from '${absolute(rendererRoot + 'store/slices/toast.ts')}';
import {Toasts} from '${absolute(rendererRoot + 'components/Toasts.tsx')}';
const calls=[];
const snapshot={meta:{root:'D:/synthetic-notifications'},tasks:[{dirName:'active'}],archived:[{dirName:'archived'}]};
const store=create((set,get,api)=>({...toastSlice(set,get,api),snapshot,showTask:(...args)=>calls.push(args)}));
window.__notificationStore=store;
// Only long application dismiss timers are virtual. React, layout, RAF and test settling retain real time.
const realSet=window.setTimeout.bind(window),realClear=window.clearTimeout.bind(window),timers=new Map();let now=0,next=-1;
window.setTimeout=(callback,delay,...args)=>{if(typeof callback==='function'&&(delay===5000||delay===9000)){const id=next--;timers.set(id,{due:now+delay,callback:()=>callback(...args)});return id}return realSet(callback,delay,...args)};
window.clearTimeout=id=>{if(!timers.delete(id))realClear(id)};
const root=createRoot(document.getElementById('root'));
window.notificationFixture={store,calls,timers,snapshot,
 longTitle:'Full recoverable title '+('notification title needs deliberate readable wrapping '.repeat(15))+'TITLE-END',
 longBody:Array.from({length:32},(_,i)=>'Detail '+(i+1)+': '+('unbrokenLongContent'.repeat(4))).join('\\n')+'\\nBODY-END',
 settle:()=>new Promise(done=>realSet(done,65)),
 advance:async ms=>{const end=now+ms;for(;;){const entry=[...timers].sort((a,b)=>a[1].due-b[1].due).find(([,t])=>t.due<=end);if(!entry)break;now=entry[1].due;timers.delete(entry[0]);flushSync(()=>entry[1].callback());await new Promise(done=>realSet(done,0))}now=end},
 mount:({theme='dark',size='standard',items=[]}={})=>{flushSync(()=>root.render(null));store.setState({toasts:[],snapshot:structuredClone(snapshot)});calls.length=0;document.documentElement.classList.toggle('dark',theme==='dark');flushSync(()=>root.render(<div className="my-root" data-my-theme={theme} data-my-font-size={size} style={{height:'100%',background:'var(--my-bg-canvas)'}}><Toasts/></div>));flushSync(()=>items.forEach(item=>store.getState().pushToast(item)))},
 push:item=>flushSync(()=>store.getState().pushToast(item)),
 reset:()=>flushSync(()=>root.render(null))
};window.notificationFixture.mount();`

async function layoutChecks({ theme, size }) {
  const f = window.notificationFixture
  const passed = []
  const check = (name, condition, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); passed.push(name) }
  const frame = node => { const s = getComputedStyle(node); return [s.backgroundColor, s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor, s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth, s.borderRadius, s.boxShadow] }
  const frames = [], icons = []
  for (const kind of ['info', 'success', 'warn', 'error']) {
    f.mount({ theme, size, items: [{ kind, title: 'Notification title', body: 'Readable notification body' }] })
    await f.settle()
    const card = document.querySelector('.my-notification'), stack = document.querySelector('.my-notification-stack')
    const r = card.getBoundingClientRect(), sr = stack.getBoundingClientRect()
    check(kind + ' viewport fit', r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 && sr.top >= 0 && sr.bottom <= innerHeight + 1, { r: r.toJSON(), sr: sr.toJSON(), viewport: [innerWidth, innerHeight] })
    check(kind + ' no horizontal document or stack overflow', [document.documentElement, document.body, stack, card].every(el => el.scrollWidth <= el.clientWidth + 1))
    check(kind + ' accessible close and live message', card.querySelector('button[aria-label="关闭通知"]') && card.querySelector(kind === 'error' ? '[role=alert]' : '[role=status]')?.getAttribute('aria-atomic') === 'true')
    check(kind + ' short copy has no expand action', !card.querySelector('[aria-expanded]'))
    const expected = { small: 12, standard: 13, large: 14 }[size]
    check(kind + ' shared typography', parseFloat(getComputedStyle(card.querySelector('.my-notification-title')).fontSize) === expected && parseFloat(getComputedStyle(card.querySelector('.my-notification-body')).fontSize) === expected - 1)
    frames.push(frame(card)); icons.push(getComputedStyle(card.querySelector('.my-notification-icon')).color)
  }
  check('all four severity frames identical', frames.every(value => JSON.stringify(value) === JSON.stringify(frames[0])), frames)
  check('severity color is on icon', new Set(icons).size === 4, icons)
  // Chromium snaps a 1 CSS px border to device pixels (e.g. 0.666667px at Windows 150% scaling).
  check('uniform thin neutral border on every side', frames[0].slice(5, 9).every(width => width === frames[0][5] && parseFloat(width) > 0 && parseFloat(width) <= 1), frames[0])
  f.mount({ theme, size, items: [{ kind: 'info', title: f.longTitle, body: f.longBody }] })
  await f.settle()
  const card = document.querySelector('.my-notification'), title = card.querySelector('.my-notification-title'), body = card.querySelector('.my-notification-body')
  for (const [name, node] of [['title', title], ['body', body]]) {
    const style = getComputedStyle(node)
    check(name + ' actually clipped at two lines', style.webkitLineClamp === '2' && node.scrollHeight > node.clientHeight + 1 && node.clientHeight <= parseFloat(style.lineHeight) * 2 + 1, { client: node.clientHeight, scroll: node.scrollHeight, clamp: style.webkitLineClamp })
  }
  const expand = card.querySelector('[aria-expanded=false]')
  check('clipped content offers expansion', expand && document.getElementById(expand.getAttribute('aria-controls')) === card.querySelector('.my-notification-message'))
  expand.click(); await f.settle()
  const message = card.querySelector('.my-notification-message')
  check('expanded content fully restored', title.textContent === f.longTitle && body.textContent === f.longBody && [title, body].every(node => getComputedStyle(node).webkitLineClamp !== '2' && node.scrollHeight <= node.clientHeight + 1))
  check('long details scroll internally and are keyboard reachable', message.scrollHeight > message.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(message).overflowY) && message.tabIndex === 0)
  message.focus(); message.scrollTop = message.scrollHeight
  check('full content end is reachable', message.scrollTop > 0 && Math.abs(message.scrollHeight - message.clientHeight - message.scrollTop) <= 1 && body.textContent.endsWith('BODY-END'))
  card.querySelector('[aria-expanded=true]').click(); await f.settle()
  check('collapse restores clamp without losing copy', getComputedStyle(body).webkitLineClamp === '2' && body.scrollHeight > body.clientHeight && body.textContent === f.longBody)
  return { passed, background: frames[0][0] }
}

async function interactionChecks() {
  const f = window.notificationFixture, passed = []
  const check = (name, condition, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); passed.push(name) }
  const mount = async items => { f.mount({ items }); await f.settle() }
  const info = { kind: 'info', title: 'Timer notification', body: 'Details' }
  const count = () => f.store.getState().toasts.length
  const action = () => [...document.querySelectorAll('button')].find(button => button.textContent === '查看任务')
  for (const [kind, duration] of [['info', 5000], ['success', 5000], ['warn', 9000], ['error', 9000]]) {
    await mount([{ ...info, kind }])
    check(kind + ' active timer in hidden native window with emulated foreground document', !document.hidden && f.timers.size === 1, { hidden: document.hidden, timers: [...f.timers] })
    await f.advance(duration - 1); check(kind + ' remains before timeout', count() === 1)
    await f.advance(1); check(kind + ' dismisses at inactivity deadline', count() === 0 && !document.querySelector('.my-notification'))
  }
  await mount([info])
  const toast = document.querySelector('.my-toast')
  await f.advance(4999)
  toast.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body })); await f.settle()
  await f.advance(30000); check('hover pauses dismissal', count() === 1 && f.timers.size === 0)
  toast.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body })); await f.settle()
  await f.advance(4999); check('leaving hover starts full inactivity interval', count() === 1)
  await f.advance(1); check('dismissal resumes after hover', count() === 0)
  await mount([info])
  const close = document.querySelector('[aria-label="关闭通知"]')
  close.focus(); await f.settle(); await f.advance(30000)
  check('keyboard focus pauses dismissal', count() === 1 && f.timers.size === 0)
  close.blur(); await f.settle(); await f.advance(4999); check('blur preserves full inactivity interval', count() === 1)
  await f.advance(1); check('dismissal resumes after blur', count() === 0)
  await mount([{ ...info, title: f.longTitle, body: f.longBody }])
  document.querySelector('[aria-expanded=false]').click(); await f.settle(); await f.advance(30000)
  check('expanded details pause dismissal', count() === 1 && f.timers.size === 0)
  document.querySelector('[aria-expanded=true]').click(); await f.settle(); await f.advance(4999)
  check('collapse starts full inactivity interval', count() === 1)
  await f.advance(1); check('dismissal resumes after collapse', count() === 0)
  await mount([info])
  // Visibility alone is synthesized; no real window is shown or focused.
  Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); await f.settle(); await f.advance(30000)
  check('hidden document pauses dismissal', count() === 1 && f.timers.size === 0)
  delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); await f.settle(); await f.advance(5000)
  check('visibility restoration resumes dismissal', count() === 0)
  await mount([info]); document.querySelector('[aria-label="关闭通知"]').click(); await f.settle()
  check('accessible close removes item and timer', count() === 0 && f.timers.size === 0)
  await mount([])
  for (const title of ['one', 'two', 'three', 'four']) f.push({ ...info, title })
  await f.settle()
  check('bounded newest three in store and mounted stack', count() === 3 && document.querySelectorAll('.my-notification').length === 3 && f.store.getState().toasts.map(t => t.title).join(',') === 'two,three,four')
  const oldId = f.store.getState().toasts[0].id
  f.push({ ...info, title: 'two' }); await f.settle()
  check('exact duplicate refreshed once and moves newest', count() === 3 && f.store.getState().toasts.map(t => t.title).join(',') === 'three,four,two' && f.store.getState().toasts.at(-1).id !== oldId)
  for (const variant of [{ body: 'different body' }, { kind: 'warn' }, { task: { projectRoot: 'D:/other', dirName: 'active' } }]) {
    await mount([info]); f.push({ ...info, ...variant }); await f.settle(); check('distinct payload retained ' + JSON.stringify(variant), count() === 2)
  }
  const task = { projectRoot: 'd:\\SYNTHETIC-notifications\\', dirName: 'active' }
  await mount([{ ...info, task }]); check('current project action visible with normalized Windows root', action())
  action().click(); await f.settle(); check('current project active task opens and dismisses', JSON.stringify(f.calls) === JSON.stringify([['active', false]]) && count() === 0, f.calls)
  await mount([{ ...info, task: { ...task, dirName: 'archived' } }]); action().click(); await f.settle()
  check('archived task routes to archive', JSON.stringify(f.calls) === JSON.stringify([['archived', true]]) && count() === 0, f.calls)
  await mount([{ ...info, task: { projectRoot: 'D:/foreign-project', dirName: 'active' } }])
  check('foreign project has no misleading task action', !action() && f.calls.length === 0)
  await mount([{ ...info, task }]); const staleAction = action()
  f.store.setState({ snapshot: { ...f.snapshot, meta: { root: 'D:/foreign-project' } } }); staleAction.click(); await f.settle()
  check('click rechecks latest project before navigation', f.calls.length === 0 && count() === 1)
  await mount([{ ...info, task: { ...task, dirName: 'missing' } }]); action().click(); await f.settle()
  check('missing task produces warning without navigating', f.calls.length === 0 && count() === 1 && f.store.getState().toasts[0].kind === 'warn' && document.body.textContent.includes('该任务已不可用'))
  f.reset(); await f.settle(); check('unmount clears application timers', f.timers.size === 0)
  return passed
}

async function stackChecks({ theme, size }) {
  const f = window.notificationFixture
  f.mount({ theme, size, items: ['info', 'warn', 'error'].map(kind => ({ kind, title: f.longTitle, body: f.longBody })) })
  await f.settle()
  const stack = document.querySelector('.my-notification-stack'), box = stack.getBoundingClientRect()
  if (box.left < 0 || box.right > innerWidth + 1 || box.top < 0 || box.bottom > innerHeight + 1 || stack.scrollWidth > stack.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth) throw Error('short stack exceeds viewport: ' + JSON.stringify({ box: box.toJSON(), width: innerWidth, height: innerHeight }))
  if (stack.scrollHeight <= stack.clientHeight || !['auto', 'scroll'].includes(getComputedStyle(stack).overflowY)) throw Error('short stack lacks internal scrolling')
  stack.scrollTop = stack.scrollHeight
  const close = stack.lastElementChild.querySelector('[aria-label="关闭通知"]'), r = close.getBoundingClientRect()
  if (r.top < box.top || r.bottom > box.bottom + 1 || document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') !== close) throw Error('last notification close unreachable after stack scrolling')
  return 'short viewport stack scrolls; last close remains reachable; no horizontal overflow'
}

try {
  const entry = join(temporary, 'entry.tsx')
  writeFileSync(entry, fixture)
  await build({ entryPoints: [entry], outfile: join(temporary, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [absolute('node_modules')], plugins: [{ name: 'isolated-toast-store', setup(builder) {
    builder.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useApp=(selector)=>window.__notificationStore(selector);useApp.getState=()=>window.__notificationStore.getState();', loader: 'js' }))
  } }] })
  const cssFiles = ['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'my/my-utilities.css', 'styles.css']
  const css = (await postcss([tailwind(config)]).process(cssFiles.map(file => readFileSync(rendererRoot + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(temporary, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  const serialize = fn => JSON.stringify('(' + fn.toString() + ')')
  writeFileSync(join(temporary, 'main.cjs'), `const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{writeFileSync}=require('node:fs');const{join}=require('node:path');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.disableHardwareAcceleration();
const screenshots=${JSON.stringify(screenshotDirectory ?? null)},layout=${serialize(layoutChecks)},interactions=${serialize(interactionChecks)},stackCheck=${serialize(stackChecks)};
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,frame:false,width:960,height:720,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});const errors=[];
w.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});w.webContents.on('render-process-gone',(_event,details)=>{console.error(details);app.exit(1)});
await w.loadFile(${JSON.stringify(join(temporary, 'index.html'))});w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
const evaluate=(fn,arg)=>w.webContents.executeJavaScript(fn+'('+JSON.stringify(arg??null)+')');
const resize=async(width,height)=>{w.setContentSize(width,height);for(let i=0;i<30;i++){const size=await w.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');if(size.width===width&&size.height===height)return;await new Promise(done=>setTimeout(done,20))}throw Error('viewport resize timed out')};
const capture=async name=>{if(screenshots){await new Promise(done=>setTimeout(done,100));writeFileSync(join(screenshots,name+'.png'),(await w.webContents.capturePage()).toPNG());console.log('SCREENSHOT '+join(screenshots,name+'.png'))}};
let assertions=0;const backgrounds={};
for(const[width,height]of [[960,720],[320,480]]){await resize(width,height);for(const theme of ['light','dark'])for(const size of ['small','standard','large']){const result=await evaluate(layout,{theme,size});assertions+=result.passed.length;backgrounds[theme]=result.background;console.log('PASS '+theme+'/'+size+'/'+width+'x'+height+': '+result.passed.length+' layout/clamp/accessibility checks');if(size==='standard'||(width===320&&size==='large'))await capture(theme+'-'+size+'-'+width+'x'+height+'-collapsed');}}
assert.notEqual(backgrounds.light,backgrounds.dark,'theme paints differ');
await resize(320,240);for(const theme of ['light','dark'])for(const size of ['small','standard','large']){console.log('PASS '+theme+'/'+size+'/320x240: '+await evaluate(stackCheck,{theme,size}));if(size==='large')await capture(theme+'-large-320x240-stack');}
await resize(420,540);for(const theme of ['light','dark']){await w.webContents.executeJavaScript('window.notificationFixture.mount({theme:'+JSON.stringify(theme)+',items:[{kind:"info",title:window.notificationFixture.longTitle,body:window.notificationFixture.longBody}]});window.notificationFixture.settle()');await w.webContents.executeJavaScript('document.querySelector("[aria-expanded=false]").click();window.notificationFixture.settle()');await capture(theme+'-standard-420x540-expanded');}
await resize(960,720);for(const theme of ['light','dark']){await w.webContents.executeJavaScript('window.notificationFixture.mount('+JSON.stringify({theme,items:[{kind:'info',title:'任务更新：历史会话完整性与会话结构重整',body:'5 个文件已变更 · workspace.css、wrapup-candidate-tree.json 等',task:{projectRoot:'D:/synthetic-notifications',dirName:'active'}}]})+');window.notificationFixture.settle()');await capture(theme+'-task-material');}const results=await evaluate(interactions);for(const name of results)console.log('PASS '+name);
assert.deepEqual(errors,[],'renderer console errors');assert.equal(w.isVisible(),false,'fixture never shown');console.log('Notifications UI smoke passed: '+assertions+' layout assertions in 12 theme/font/viewport combinations; 6 short-stack combinations; '+results.length+' interaction/timer/store/navigation assertions.');w.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});setTimeout(()=>{console.error('notifications UI fixture timed out');app.exit(1)},45000);`)
  const require = createRequire(import.meta.url), env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(require('electron'), [join(temporary, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 55000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-notifications-ui-'))
  rmSync(temporary, { recursive: true, force: true })
}
