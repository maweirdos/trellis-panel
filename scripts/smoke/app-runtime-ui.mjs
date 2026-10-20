/** Mounted application UI with isolated IPC: no real app, Agent, env file or OS process is launched. */
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

const screenshotIndex = process.argv.indexOf('--screenshots')
const screenshots = screenshotIndex < 0 ? null : process.argv[screenshotIndex + 1]
if (screenshotIndex >= 0) assert.ok(screenshots && isAbsolute(screenshots), '--screenshots requires an absolute path')
if (screenshots) mkdirSync(screenshots, { recursive: true })
const temporary = mkdtempSync(join(tmpdir(), 'tpanel-app-runtime-ui-'))
const absolute = file => resolve(file).replace(/\\/g, '/')
const renderer = 'src/renderer/src/'
const fixture = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {flushSync} from '${absolute('node_modules/react-dom/index.js')}';
import {TitleBar} from '${absolute(renderer + 'components/TitleBar.tsx')}';
import {ApplicationRuntimeView} from '${absolute(renderer + 'applications/ApplicationPanel.tsx')}';
import {refreshApplications,closeApplicationEditor} from '${absolute(renderer + 'applications/useApplications.ts')}';
import {dispatchEscKey} from '${absolute(renderer + 'utils/esc-layer.ts')}';
import {useApp} from '${absolute(renderer + 'store')}';
import {setCapability} from '${absolute(renderer + 'api')}';
const root=createRoot(document.getElementById('root')),events=new Set(),calls=[],apps=new Map();
const clone=value=>structuredClone(value),project='D:/fixture-applications',other='D:/fixture-other';
function makeApp(patch={}){const definition={id:'backend',name:'后端服务',cwd:'.',launch:{kind:'argv',executable:'java',args:['-jar','app.jar']},envFiles:['.env'],ports:[{host:'127.0.0.1',port:8080}],readiness:{kind:'none'},stopTimeoutMs:10000,revision:'revision-1',updatedAt:1,overrideKeys:['DB_PASSWORD']};return{definition,processState:'stopped',readiness:{state:'not-configured',checkedAt:null},run:null,ports:[{host:'127.0.0.1',port:8080,state:'available'}],approval:'required',canStart:true,canStop:false,canRestart:false,...patch}}
const f={project,other,makeApp,calls,events,apps,deferLists:false,pendingLists:[],holdStart:false,startResolve:null,stopFailure:false,saveFailure:false,logs:'booting\\n'+Array.from({length:28},(_,i)=>'output '+i).join('\\n')+'\\nOUTPUT_END',refresh:refreshApplications,
 wait:async(test,label)=>{for(let i=0;i<160;i++){if(test())return;await new Promise(done=>setTimeout(done,10))}throw Error('Timed out: '+label)},
 settle:()=>new Promise(done=>setTimeout(done,80)),
 button:label=>[...document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===label)??[...document.querySelectorAll('button')].find(node=>node.textContent===label),
 setField:(label,value)=>{const node=document.querySelector('[aria-label="'+label+'"]');if(!node)throw Error('Missing field '+label);const setter=Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))},
 emit:(app,kind='state',root=project)=>{apps.set(root,[app]);events.forEach(listener=>listener({kind,root,appId:app.definition.id,runId:app.run?.id??null,app:clone(app)}))},
 escape:dispatchEscKey,
 failure:()=>{const failed=makeApp({processState:'failed',approval:'pending',lastError:'预期端口 8080 已被其他进程占用。'});failed.ports=[{host:'127.0.0.1',port:8080,state:'external-conflict',pid:404}];f.emit(failed,'attention')},
 switchRoot:root=>flushSync(()=>useApp.setState({snapshot:root?{meta:{root,name:root===project?'示例项目':'其他项目'}}:null})),
 mount:({theme='dark',size='standard',items=[makeApp()],root:projectRoot=project,ipc=true}={})=>{flushSync(()=>root.render(null));closeApplicationEditor();setCapability(ipc);calls.length=0;events.clear();apps.clear();apps.set(projectRoot,clone(items));f.deferLists=false;f.pendingLists=[];f.holdStart=false;f.startResolve=null;f.stopFailure=false;f.saveFailure=false;useApp.setState({snapshot:projectRoot?{meta:{root:projectRoot,name:'示例项目'}}:null});document.documentElement.classList.toggle('dark',theme==='dark');flushSync(()=>root.render(<div className="my-root" data-my-theme={theme} data-my-font-size={size} style={{height:'100%',background:'var(--my-bg-canvas)',display:'flex',flexDirection:'column'}}><TitleBar/><main className="my-application-fixture-body"><ApplicationRuntimeView/></main></div>))},
 reset:()=>flushSync(()=>root.render(null))};
window.applicationsFixture=f;
const find=(root,id)=>apps.get(root)?.find(app=>app.definition.id===id);
const success=(root,app)=>({ok:true,root,app:clone(app)});
window.__applicationsApi={
 appRuntimeList:async root=>{calls.push(['list',root]);if(f.deferLists)return new Promise(resolve=>f.pendingLists.push({root,resolve}));return{ok:true,root,apps:clone(apps.get(root)??[])}},
 appRuntimeSave:async(root,input)=>{calls.push(['save',root,clone(input)]);if(f.saveFailure)return{ok:false,code:'E_CONFLICT',error:'配置已变更，请重新读取。'};const previous=find(root,input.config.id);const keys=new Set(previous?.definition.overrideKeys??[]);for(const row of input.overrides??[]){if(row.action==='clear')keys.delete(row.key);else keys.add(row.key)}const app=makeApp({definition:{...clone(input.config),revision:'saved-revision',updatedAt:2,overrideKeys:[...keys]}});apps.set(root,[...(apps.get(root)??[]).filter(item=>item.definition.id!==app.definition.id),app]);return success(root,app)},
 appRuntimeRemove:async(root,id,revision)=>{calls.push(['remove',root,id,revision]);apps.set(root,(apps.get(root)??[]).filter(item=>item.definition.id!==id));return{ok:true,root}},
 appRuntimeStart:async(root,id,revision)=>{calls.push(['start',root,id,revision]);const app=find(root,id);const launch=decision=>{if(decision==='deny'){app.approval='pending';f.emit(app,'attention',root);return{ok:false,code:'E_DENIED',reason:'APPROVAL_REQUIRED',error:'请确认应用启动配置。'}}app.processState='running';app.approval='approved';app.canStart=false;app.canStop=true;app.canRestart=true;app.run={id:'run-1',pid:321,startedAt:1,exitedAt:null,exitCode:null,signal:null};return success(root,app)};if(f.holdStart)return new Promise(resolve=>{f.startResolve=decision=>resolve(launch(decision))});return launch('approve')},
 appRuntimeStop:async(root,id)=>{calls.push(['stop',root,id]);const app=find(root,id);if(f.stopFailure){app.processState='cleanup-required';app.lastError='停止超时，仍需核验进程。';app.canRestart=false;f.emit(app,'state',root);return{ok:false,code:'E_TIMEOUT',error:app.lastError}}app.processState='stopped';app.canStart=true;app.canStop=false;return success(root,app)},
 appRuntimeRestart:async(root,id,revision)=>{calls.push(['restart',root,id,revision]);return success(root,find(root,id))},
 appRuntimeLogs:async(root,id)=>{calls.push(['logs',root,id]);return{ok:true,root,appId:id,runId:find(root,id)?.run?.id??null,output:f.logs,outputTruncated:true,cursor:1000}},
 onAppRuntimeEvent:listener=>{events.add(listener);return()=>events.delete(listener)},
 devtoolsListScripts:async dir=>{calls.push(['scripts',dir]);return{ok:true,dir,scripts:[{name:'dev',command:'node server.js'},{name:'test',command:'node test.js'}]}},
 pickProject:async()=>project+'/service',onWindowMaximized:()=>()=>{},setCapsuleMode:()=>{},windowMinimize:()=>{},windowMaximize:()=>{},windowClose:()=>{}
};window.addEventListener('keydown',event=>{if(event.key==='Escape'&&dispatchEscKey())event.preventDefault()});f.mount();`

async function layoutChecks({ theme, size }) {
  const f = window.applicationsFixture, passed = []
  const check = (name, condition, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); passed.push(name) }
  const app = f.makeApp({ processState: 'running', canStart: false, canStop: true, canRestart: true, approval: 'approved', run: { id: 'run', pid: 100, startedAt: 1, exitedAt: null, exitCode: null, signal: null } })
  f.mount({ theme, size, items: [app] })
  await f.wait(() => document.querySelector('[data-app-id="backend"] [data-process-state="running"]'), 'mounted list')
  const trigger = document.querySelector('button[aria-haspopup="dialog"]')
  check('compact trigger uses true live count', trigger?.getAttribute('aria-label').includes('1 个运行中'), trigger?.getAttribute('aria-label'))
  trigger.click(); await f.wait(() => document.querySelector('.my-applications-popup'), 'popup')
  await f.settle()
  const popup = document.querySelector('.my-applications-popup'), box = popup.parentElement.getBoundingClientRect()
  check('open trigger tooltip cannot cover panel actions', getComputedStyle(document.querySelector('.my-application-trigger .my-tooltip')).display === 'none')
  check('popup fits viewport', box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1, box.toJSON())
  check('header geometry is unchanged', Math.abs(document.querySelector('.my-window-header').getBoundingClientRect().height - 48) < 1)
  check('process and readiness remain distinct', popup.querySelector('[data-process-state="running"]')?.textContent.includes('进程运行中') && popup.querySelector('[data-readiness-state="not-configured"]')?.textContent.includes('未配置'))
  check('all lifecycle controls accessible', popup.querySelector('[aria-label="停止 后端服务"]') && popup.querySelector('[aria-label="重启 后端服务"]'))
  check('card uses shared font scale', parseFloat(getComputedStyle(popup.querySelector('h3')).fontSize) === { small: 12, standard: 13, large: 14 }[size])
  const card = popup.querySelector('.my-application-card'), style = getComputedStyle(card)
  check('uniform neutral card border', ['Top', 'Right', 'Bottom', 'Left'].every(side => style['border' + side + 'Color'] === style.borderTopColor && style['border' + side + 'Width'] === style.borderTopWidth))
  popup.querySelector('[aria-label="查看 后端服务 输出"]').click()
  await f.wait(() => popup.querySelector('pre')?.textContent.includes('OUTPUT_END'), 'bounded output')
  check('output has own bounded keyboard scroll area', popup.querySelector('pre').tabIndex === 0 && popup.querySelector('pre').scrollHeight > popup.querySelector('pre').clientHeight)
  check('truncation is explicit', popup.textContent.includes('早期输出已截断'))
  popup.querySelector('[aria-label="编辑 后端服务"]').click()
  await f.wait(() => document.querySelector('[role="dialog"][aria-label="编辑应用"]'), 'editor')
  check('popup closes without unmounting sibling editor', !document.querySelector('.my-applications-popup'))
  const modal = document.querySelector('[role="dialog"]'), modalBox = modal.getBoundingClientRect()
  check('editor fits viewport', modalBox.left >= 0 && modalBox.right <= innerWidth + 1 && modalBox.bottom <= innerHeight + 1, modalBox.toJSON())
  const focusProbe = document.createElement('span'); focusProbe.style.color = 'var(--my-focus-ring)'; modal.append(focusProbe)
  check('focused dialog uses the canonical focus token', getComputedStyle(modal).outlineStyle === 'solid' && getComputedStyle(modal).outlineColor === getComputedStyle(focusProbe).color)
  focusProbe.remove()
  check('saved override is write-only', modal.querySelector('[aria-label="变量名称 1"]').value === 'DB_PASSWORD' && !modal.querySelector('[aria-label="变量值 1"]'))
  check('one app typography root owns modal portal', document.querySelectorAll('.my-root').length === 1 && modal.closest('.my-root'))
  const controls = [...modal.querySelectorAll('button,input,textarea,[tabindex]')].filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length)
  controls[0].focus(); controls[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
  check('shared modal contains keyboard focus', document.activeElement === controls.at(-1))
  f.escape(); await f.wait(() => !document.querySelector('[role="dialog"]'), 'editor Escape')
  await f.settle()
  check('editor returns focus to header trigger', document.activeElement === trigger, { active: document.activeElement?.outerHTML.slice(0, 220), connected: trigger.isConnected })
  check('no document horizontal overflow', document.documentElement.scrollWidth <= innerWidth + 1)
  return passed
}

async function interactionChecks() {
  const f = window.applicationsFixture, passed = []
  const check = (name, condition, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); passed.push(name) }
  f.mount(); await f.wait(() => f.button('启动 后端服务'), 'initial application')
  f.holdStart = true; f.button('启动 后端服务').click()
  await f.wait(() => f.startResolve && document.body.textContent.includes('正在启动'), 'acknowledged start')
  check('start uses exact expected project and revision', JSON.stringify(f.calls.find(call => call[0] === 'start')) === JSON.stringify(['start', f.project, 'backend', 'revision-1']))
  check('start does not optimistically claim running', document.querySelector('[data-process-state="stopped"]') && !document.querySelector('[data-process-state="running"]'))
  f.startResolve('deny'); await f.wait(() => document.body.textContent.includes('等待你确认启动配置'), 'approval pending')
  check('approval denial and attention remain visible', document.body.textContent.includes('请确认应用启动配置。') && f.button('启动 后端服务').textContent.includes('确认并启动'))
  f.holdStart = false; f.button('启动 后端服务').click(); await f.wait(() => document.querySelector('[data-process-state="running"]'), 'approved IPC result')
  f.stopFailure = true; f.button('停止 后端服务').click(); await f.wait(() => document.querySelector('[data-process-state="cleanup-required"]'), 'stop timeout')
  check('cleanup failure stays visible and blocks restart', document.body.textContent.includes('停止超时') && !f.button('重启 后端服务'))

  f.mount({ items: [] }); await f.wait(() => document.body.textContent.includes('还没有应用'), 'empty list')
  const add = f.button('添加应用'); add.click(); await f.wait(() => document.querySelector('[aria-label="应用标识"]'), 'new editor')
  for (const [label, value] of [['应用名称', '应用夹具'], ['应用标识', 'fixture-app'], ['可执行程序', 'node'], ['启动参数', 'a path with spaces/server.js'], ['环境文件', '.env']]) { f.setField(label, value); await f.settle() }
  f.button('高级配置').click(); await f.settle(); f.button('添加变量').click(); await f.settle()
  f.setField('变量名称 1', 'API_TOKEN'); await f.settle(); f.setField('变量值 1', 'synthetic-secret-value'); await f.settle()
  f.saveFailure = true; f.button('保存').click(); await f.wait(() => document.body.textContent.includes('配置已变更'), 'save conflict')
  check('save conflict preserves draft without execution', document.querySelector('[aria-label="应用名称"]').value === '应用夹具' && f.calls.filter(call => call[0] === 'start').length === 0)
  f.saveFailure = false; f.button('保存').click(); await f.wait(() => !document.querySelector('[role="dialog"]') && document.querySelector('[data-app-id="fixture-app"]'), 'saved application')
  const saved = f.calls.filter(call => call[0] === 'save').at(-1)
  check('save preserves argument boundaries and write-only override patch', saved[2].config.launch.args[0] === 'a path with spaces/server.js' && saved[2].overrides[0].action === 'replace' && saved[2].overrides[0].value === 'synthetic-secret-value')
  check('save does not start and secret is absent from public UI', !f.calls.some(call => call[0] === 'start') && !document.body.textContent.includes('synthetic-secret-value'))
  check('inline editor restores its actual connected opener', document.activeElement === add)
  f.button('删除 应用夹具').click(); await f.wait(() => document.querySelector('[aria-label="删除应用配置"]'), 'remove review'); f.button('删除').click(); await f.wait(() => !document.querySelector('[data-app-id="fixture-app"]'), 'removed')
  check('remove binds exact local revision', JSON.stringify(f.calls.find(call => call[0] === 'remove')) === JSON.stringify(['remove', f.project, 'fixture-app', 'saved-revision']))

  f.button('导入 npm 脚本').click(); await f.wait(() => document.querySelector('[aria-label="npm 脚本"]') && !document.querySelector('[aria-label="npm 脚本"]').disabled, 'npm discovery')
  f.button('npm 脚本').click(); await f.wait(() => [...document.querySelectorAll('[role="option"]')].some(node => node.textContent === 'dev'), 'npm dev choice'); [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === 'dev').click(); await f.settle()
  f.button('保存').click(); await f.wait(() => document.querySelector('[data-app-id="dev"]'), 'npm saved')
  check('npm import discovers real scripts and saves without execution', f.calls.some(call => call[0] === 'scripts') && f.calls.filter(call => call[0] === 'save').at(-1)[2].config.launch.kind === 'npm-script' && !f.calls.some(call => call[0] === 'start'))

  f.mount(); await f.wait(() => document.querySelector('[data-app-id="backend"]'), 'root-race setup'); f.deferLists = true; void f.refresh(); await f.wait(() => f.pendingLists.length === 1, 'old A list')
  f.switchRoot(f.other); f.switchRoot(f.project); await f.wait(() => f.pendingLists.length === 3, 'A B A list generations')
  const requests = [...f.pendingLists], fresh = f.makeApp(); fresh.definition.name = 'Fresh A'; requests[2].resolve({ ok: true, root: f.project, apps: [fresh] }); await f.wait(() => document.body.textContent.includes('Fresh A'), 'fresh A')
  const old = f.makeApp(); old.definition.name = 'Old A'; requests[0].resolve({ ok: true, root: f.project, apps: [old] }); const foreign = f.makeApp(); foreign.definition.name = 'Foreign B'; requests[1].resolve({ ok: true, root: f.other, apps: [foreign] }); await f.settle()
  check('late A and B replies cannot revive stale A after A B A', document.body.textContent.includes('Fresh A') && !document.body.textContent.includes('Old A') && !document.body.textContent.includes('Foreign B'))
  f.deferLists = false
  f.mount(); await f.wait(() => document.querySelector('[data-app-id="backend"]'), 'event-race setup'); f.deferLists = true; void f.refresh(); await f.wait(() => f.pendingLists.length === 1, 'pending refresh')
  const newer = f.makeApp({ processState: 'running', canStart: false, canStop: true }); f.emit(newer); await f.wait(() => document.querySelector('[data-process-state="running"]'), 'newer event'); f.pendingLists[0].resolve({ ok: true, root: f.project, apps: [f.makeApp()] }); await f.settle()
  check('older list snapshot cannot overwrite newer runtime event', document.querySelector('[data-process-state="running"]'))

  f.mount(); await f.wait(() => f.button('启动 后端服务'), 'terminal-event race setup'); f.holdStart = true; f.button('启动 后端服务').click(); await f.wait(() => f.startResolve, 'start reply held')
  f.emit(f.makeApp({ processState: 'exited', approval: 'approved', canStart: true, canStop: false, canRestart: true, run: { id: 'run-1', pid: 321, startedAt: 1, exitedAt: 2, exitCode: 0, signal: null } }), 'done')
  await f.wait(() => document.querySelector('[data-process-state="exited"]'), 'authoritative exit event'); f.startResolve('approve'); await f.settle()
  check('late start reply cannot overwrite a newer terminal event', document.querySelector('[data-process-state="exited"]') && !document.querySelector('[data-process-state="running"]'))

  f.mount(); await f.wait(() => f.button('启动 后端服务'), 'late-action setup'); f.holdStart = true; f.button('启动 后端服务').click(); await f.wait(() => f.startResolve, 'old action held')
  const resolveOld = f.startResolve; f.switchRoot(f.other); f.apps.set(f.project, [f.makeApp()]); f.switchRoot(f.project); await f.wait(() => f.button('启动 后端服务'), 'new A state'); resolveOld('approve'); await f.settle()
  check('late lifecycle result cannot overwrite replacement A owner', document.querySelector('[data-process-state="stopped"]') && !document.querySelector('[data-process-state="running"]'))

  f.mount({ root: null, items: [], ipc: false }); await f.wait(() => document.body.textContent.includes('桌面端可管理本地应用'), 'no bridge')
  check('no IPC preview is truthful and invokes no native API', f.calls.length === 0 && f.button('添加应用').disabled && !f.button('最小化窗口'))
  f.reset(); await f.settle(); check('unmount releases all runtime event subscriptions', f.events.size === 0)
  return passed
}

try {
  const entry = join(temporary, 'entry.tsx')
  writeFileSync(entry, fixture)
  await build({ entryPoints: [entry], outfile: join(temporary, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [absolute('node_modules')], loader: { '.svg': 'dataurl' }, plugins: [{ name: 'isolated-applications', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.path.startsWith('@shared/')) return { path: absolute('src/shared/' + args.path.slice(8) + '.ts') }
      if (args.path.endsWith('.svg?url')) return { path: resolve(dirname(args.importer), args.path.replace(/\?url$/, '')) }
      const path = absolute(resolve(dirname(args.importer || entry), args.path))
      if (path === absolute(renderer + 'store')) return { path: 'store', namespace: 'fixture' }
      if (path === absolute(renderer + 'my/store')) return { path: 'my-store', namespace: 'fixture' }
      if (path === absolute(renderer + 'api')) return { path: 'api', namespace: 'fixture' }
      if (path === absolute(renderer + 'my/layout/ProjectSwitcher')) return { path: 'project', namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: process.cwd(), contents: args.path === 'store'
      ? `import{create}from '${absolute('node_modules/zustand/esm/index.mjs')}';export const useApp=create(()=>({snapshot:null,openError:null,setPage:page=>window.applicationsFixture.calls.push(['page',page])}));`
      : args.path === 'my-store' ? `import{create}from '${absolute('node_modules/zustand/esm/index.mjs')}';export const useMy=create(set=>({sidebarCollapsed:false,toggleSidebar:()=>{},setPaletteOpen:()=>{},setToolView:toolView=>set({toolView})}));`
        : args.path === 'api' ? `export let hasIpc=true;export function setCapability(value){hasIpc=value}export const api=new Proxy({},{get:(_target,key)=>(...args)=>window.__applicationsApi[key](...args)});`
          : `export function ProjectSwitcher(){return <button className="my-project-switcher no-drag my-control">示例项目</button>}` }))
  } }] })
  const sheets = ['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'my/my-utilities.css', 'my/my-applications.css', 'styles.css']
  const css = (await postcss([tailwind(config)]).process(sheets.map(file => readFileSync(renderer + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(temporary, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}.my-application-fixture-body{flex:1;min-height:0;overflow:auto;padding:var(--my-page-inset)}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  const serialize = fn => JSON.stringify('(' + fn.toString() + ')')
  writeFileSync(join(temporary, 'main.cjs'), `const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{writeFileSync}=require('node:fs');const{join}=require('node:path');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
const layout=${serialize(layoutChecks)},interactions=${serialize(interactionChecks)},screenshots=${JSON.stringify(screenshots)};
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,frame:false,width:960,height:720,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false,offscreen:Boolean(screenshots)}});const errors=[];w.webContents.on('console-message',details=>{if(details.level==='error'){errors.push(details.message);console.error(details.message)}});w.webContents.on('render-process-gone',(_event,details)=>{console.error(details);app.exit(1)});await w.loadFile(${JSON.stringify(join(temporary, 'index.html'))});
w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
const evaluate=(fn,arg)=>w.webContents.executeJavaScript(fn+'('+JSON.stringify(arg??null)+')');
const resize=async(width,height)=>{w.setContentSize(width,height);for(let i=0;i<30;i++){const size=await w.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');if(size.width===width&&size.height===height){await new Promise(done=>setTimeout(done,80));return;}await new Promise(done=>setTimeout(done,20))}throw Error('viewport resize timed out: '+JSON.stringify(await w.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')))};
const capture=async name=>{if(!screenshots)return;const image=await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('offscreen paint timed out')),3000);w.webContents.once('paint',(_event,_dirty,image)=>{clearTimeout(timer);accept(image)});w.webContents.invalidate()});const path=join(screenshots,name+'.png');writeFileSync(path,image.toPNG());console.log('SCREENSHOT '+path)};
let count=0;for(const[width,height]of [[960,720],[360,620]]){await resize(width,height);for(const theme of ['light','dark'])for(const size of ['small','standard','large']){const checks=await evaluate(layout,{theme,size});count+=checks.length;console.log('PASS '+theme+'/'+size+'/'+width+'x'+height+': '+checks.length+' mounted layout checks');if(size==='standard'||(width===360&&size==='large')){await w.webContents.executeJavaScript('document.querySelector("button[aria-haspopup=dialog]").click();window.applicationsFixture.settle()');await capture(theme+'-'+size+'-'+width+'x'+height+'-applications');await w.webContents.executeJavaScript('window.applicationsFixture.button("查看 后端服务 输出").click();window.applicationsFixture.wait(()=>document.querySelector(".my-applications-popup pre")?.textContent.includes("OUTPUT_END"),"output screenshot")');await capture(theme+'-'+size+'-'+width+'x'+height+'-output');await w.webContents.executeJavaScript('window.applicationsFixture.button("编辑 后端服务").click();window.applicationsFixture.settle()');await capture(theme+'-'+size+'-'+width+'x'+height+'-configuration');if(width===960){await w.webContents.executeJavaScript('window.applicationsFixture.escape();window.applicationsFixture.settle()');await w.webContents.executeJavaScript('window.applicationsFixture.failure();window.applicationsFixture.settle()');await w.webContents.executeJavaScript('document.querySelector("button[aria-haspopup=dialog]").click();window.applicationsFixture.settle()');await capture(theme+'-'+size+'-'+width+'x'+height+'-conflict-pending');}}}}
await resize(960,720);const checks=await evaluate(interactions);checks.forEach(name=>console.log('PASS '+name));assert.deepEqual(errors,[],'renderer console errors');assert.equal(w.isVisible(),false);console.log('Applications UI smoke passed: '+count+' mounted layout checks and '+checks.length+' lifecycle/config/IPC-race checks.');w.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});setTimeout(()=>{console.error('application UI fixture timed out');app.exit(1)},55000);`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [join(temporary, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 65000, maxBuffer: 2 * 1024 * 1024 })
  process.stdout.write(result.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-app-runtime-ui-'))
  rmSync(temporary, { recursive: true, force: true })
}
