/** Actual homepage/hook/modal in isolated Electron. Native metadata/launch are fixtures. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import tailwindConfig from '../../tailwind.config.js'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-task-conversations-ui-'))
const outputIndex = process.argv.indexOf('--output')
const output = resolve(outputIndex < 0 ? join(directory, 'evidence') : process.argv[outputIndex + 1])
mkdirSync(output, { recursive: true })
const absolute = (path) => resolve(path).replaceAll('\\', '/')
const sourceRoot = 'src/renderer/src/'
const bootstrap = `window.trellis=Object.fromEntries(['taskConversationsList','taskConversationsDiscover','taskConversationsBind','taskConversationsSetPrimary','taskConversationsUnbind','taskConversationsOpen','onSnapshotUpdated'].map(name=>[name,(...args)=>window.homeFixture[name](...args)]));`
const fixture = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {flushSync} from '${absolute('node_modules/react-dom/index.js')}';
import {YourWorkPage} from '${absolute(sourceRoot + 'my/pages/YourWorkPage.tsx')}';
import {useApp} from '${absolute(sourceRoot + 'store/index.ts')}';
import {useMy} from '${absolute(sourceRoot + 'my/store.ts')}';
import {InteractionScope} from '${absolute(sourceRoot + 'utils/interaction-scope.tsx')}';
import {dispatchEscKey,escLayerCount} from '${absolute(sourceRoot + 'utils/esc-layer.ts')}';
import {taskConversationDirectory} from '${absolute(sourceRoot + 'my/use-task-conversations.ts')}';
const root=createRoot(document.getElementById('root'));let config={theme:'dark',size:'standard',active:true};
const native={root:'D:/fixture-project',calls:[],subscribers:new Set(),holdNextList:false,held:[],holdOpen:false,finishOpen:null,openError:null,discoverError:null,listError:null};
const titles=['皮试全流程复盘优化','门诊处方皮试液自动带出','治理基座Trellis工作流与技能统一整改及很长的任务标题','治理基座Jira任务接入与状态同步'];
const stamp=Date.now();
const makeSnapshot=projectRoot=>({meta:{root:projectRoot,name:'Trellis 前端隔离检查',developer:'fixture',currentTask:null},tasks:titles.map((title,index)=>({dirName:'10-21-fixture-'+index,path:projectRoot+'/.trellis/tasks/10-21-fixture-'+index,date:'10-21',record:{id:'fixture-'+index,title,status:index<2?'planning':'in_progress',priority:'P2',assignee:'fixture',creator:'fixture',description:'隔离原生 API 数据；不访问外部客户端。',scope:index===1?'backend':null,createdAt:'2026-10-21'},artifacts:[],updatedAt:stamp-index*1000,taskJsonMtime:stamp})),archived:[]});
const conversations=[
 {id:'candidate-codex',source:'codex',sessionId:'codex-native-id',title:'皮试流程复盘与改进',titleSource:'native',capability:'session',destinationLabel:'打开原生会话'},
 {id:'candidate-claude',source:'claude-code',sessionId:'claude-native-id',title:'处方皮试液自动带出方案',titleSource:'native',capability:'session',destinationLabel:'终端续接'},
 {id:'candidate-zcode',source:'zcode',sessionId:'zcode-native-id',title:'Trellis 工作流与技能统一整改 — 完整原生标题必须在悬浮预览保留，不能用任务名替换',titleSource:'native',capability:'workspace',destinationLabel:'打开工作区'},
 {id:'candidate-extra',source:'codex',sessionId:'codex-extra-native-id',title:'Jira 接入联调原生会话',titleSource:'native',capability:'session',destinationLabel:'打开原生会话'},
 {id:'candidate-second',source:'claude-code',sessionId:'claude-second-native-id',title:'补充原生验证记录',titleSource:'summary',capability:'session',destinationLabel:'终端恢复'},
 {id:'candidate-twin',source:'codex',sessionId:'codex-extra-native-twin',title:'Jira 接入联调原生会话',titleSource:'native',capability:'session',destinationLabel:'打开原生会话'}
].map((item,index)=>({...item,cwd:native.root,updatedAt:[stamp-6*3600000,stamp-2*86400000,stamp-2*86400000,0,Number.MAX_SAFE_INTEGER,stamp-86400000][index]}));
const sources=[{source:'codex',available:true},{source:'claude-code',available:true,detail:'通过终端恢复原生历史'},{source:'zcode',available:true,detail:'当前支持工作区目的地'}];
const nativeSnapshot=projectRoot=>({projectRoot,refreshedAt:stamp,bindings:[0,1,2].map(index=>({id:'binding-'+index,taskDir:'10-21-fixture-'+index,taskRef:'task:fixture-'+index,currentTaskRef:'task:fixture-'+index,conversation:{...conversations[index],cwd:projectRoot},primary:true,linkedAt:stamp,origin:'manual'})),sources:structuredClone(sources)});
const snapshots=new Map();const valueFor=projectRoot=>{if(!snapshots.has(projectRoot))snapshots.set(projectRoot,nativeSnapshot(projectRoot));return snapshots.get(projectRoot)};
const record=(method,input)=>{native.calls.push({method,input});if(input.expectedRoot!==native.root)throw Error('fixture foreign expectedRoot');};
const ok=value=>({ok:true,value:structuredClone(value)});
window.homeFixture={native,conversations,stamp,escLayerCount,taskConversationDirectory,
 taskConversationsList:async input=>{record('list',input);if(native.listError)return{ok:false,code:'E_IO',error:native.listError};const captured=ok(valueFor(input.expectedRoot));if(native.holdNextList){native.holdNextList=false;return new Promise(resolve=>native.held.push(()=>resolve(captured)))}return captured},
 taskConversationsDiscover:async input=>{record('discover',input);if(native.discoverError)return{ok:false,code:'E_IO',error:native.discoverError};return ok({projectRoot:input.expectedRoot,items:conversations.map(c=>({...c,cwd:input.expectedRoot})),sources,truncated:false})},
 taskConversationsBind:async input=>{record('bind',input);const data=valueFor(input.expectedRoot);const task=useApp.getState().snapshot.tasks.find(t=>t.path===input.expectedRoot+'/.trellis/tasks/'+input.taskDir);const ref=task?.record?.id?'task:'+task.record.id:'dir:.trellis/tasks/'+input.taskDir;data.bindings.push({id:'bound-'+input.conversationId,taskDir:input.taskDir,taskRef:ref,currentTaskRef:ref,conversation:conversations.find(c=>c.id===input.conversationId),primary:!data.bindings.some(b=>b.taskDir===input.taskDir),linkedAt:stamp,origin:'manual'});return ok(data)},
 taskConversationsSetPrimary:async input=>{record('primary',input);const data=valueFor(input.expectedRoot);data.bindings.forEach(b=>{if(b.taskDir===input.taskDir)b.primary=b.id===input.bindingId});return ok(data)},
 taskConversationsUnbind:async input=>{record('unbind',input);const data=valueFor(input.expectedRoot);data.bindings=data.bindings.filter(b=>b.id!==input.bindingId);return ok(data)},
 taskConversationsOpen:async input=>{record('open',input);if(native.openError)return{ok:false,code:'E_IO',error:native.openError};const c=valueFor(input.expectedRoot).bindings.find(b=>b.id===input.bindingId).conversation;const result=ok({source:c.source,sessionId:c.sessionId,capability:c.capability,destinationLabel:c.destinationLabel,detail:'已请求'+c.destinationLabel});return native.holdOpen?new Promise(resolve=>{native.finishOpen=()=>resolve(result)}):result},
 onSnapshotUpdated:callback=>{native.subscribers.add(callback);return()=>native.subscribers.delete(callback)},
 snapshot:()=>valueFor(native.root),snapshotFor:valueFor,
 configure:patch=>{config={...config,...patch};document.documentElement.classList.toggle('dark',config.theme==='dark');flushSync(()=>root.render(<div className="my-root fixture-host" data-my-theme={config.theme} data-my-font-size={config.size}><InteractionScope active={config.active}><YourWorkPage/></InteractionScope></div>))},
 switchRoot:projectRoot=>{native.root=projectRoot;flushSync(()=>{useApp.setState({snapshot:makeSnapshot(projectRoot),page:'dashboard'});useMy.getState().syncFromSnapshot()})},
 emitSnapshot:()=>{for(const cb of native.subscribers)cb(useApp.getState().snapshot)},
 unmount:()=>flushSync(()=>root.render(null)),stores:{useApp,useMy}
};
useApp.setState({snapshot:makeSnapshot(native.root),page:'dashboard',todos:[]});useMy.getState().syncFromSnapshot();
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&dispatchEscKey()){event.preventDefault();event.stopPropagation()}});
window.homeFixture.configure({});`

async function electronChecks() {
  const { app, BrowserWindow } = require('electron')
  const assert = require('node:assert/strict')
  const { writeFileSync } = require('node:fs')
  const { join } = require('node:path')
  const output = process.argv[2]
  const checks = []
  const screenshots = []
  const captureMetrics = []
  app.setPath('userData', join(__dirname, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } })
  const errors = []
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  await window.loadFile(join(__dirname, 'index.html'))
  // CSS coordinates match capturePage's DIP rectangle; preserve native DPR pixels.
  window.webContents.setZoomFactor(1)
  window.setContentSize(1440, 1000)
  await window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const js = (code) => window.webContents.executeJavaScript(code)
  const settle = () => js('new Promise(r=>setTimeout(r,75))')
  const check = async (name, code) => { const value = await js(code); assert.equal(value, true, name + ': ' + JSON.stringify(value)); checks.push(name); console.log('PASS ' + name) }
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await settle()
  }
  const capture = async (name, rect) => {
    // Hidden Chromium may hold CSS entry animations at their initial frame.
    // Capture their real completed appearance, without altering component styles.
    await js('document.getAnimations().forEach(animation=>{if(animation.effect.getTiming().iterations!==Infinity)animation.finish()})')
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    window.webContents.invalidate()
    await js('new Promise(resolve=>setTimeout(resolve,220))')
    const path = join(output, name + '.png')
    const image = rect ? await window.webContents.capturePage(rect) : await window.webContents.capturePage()
    const png = image.toPNG()
    writeFileSync(path, png)
    screenshots.push(path)
    const viewport = await js(`({cssViewport:{width:innerWidth,height:innerHeight},devicePixelRatio,visualViewport:{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale},leftColumnCssWidth:document.querySelector('.my-home-main-col').getBoundingClientRect().width})`)
    const metrics = { path, ...viewport, zoomFactor: window.webContents.getZoomFactor(), zoomLevel: window.webContents.getZoomLevel(), captureRectDip: rect ?? { x: 0, y: 0, width: viewport.cssViewport.width, height: viewport.cssViewport.height }, pngPixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, nativeImageLogicalSize: image.getSize(), nativeImageScaleFactors: image.getScaleFactors(), normalization: 'webContents zoomFactor=1; native devicePixelRatio retained; direct capturePage PNG, no crop/resize processing' }
    captureMetrics.push(metrics)
    return metrics
  }
  await settle()
  for (const theme of ['light', 'dark']) for (const size of ['small', 'standard', 'large']) {
    await js(`window.homeFixture.configure(${JSON.stringify({ theme, size })})`); await settle()
    await check(theme + '/' + size + ' real homepage geometry and all original fields', `(()=>{const rows=[...document.querySelectorAll('.my-home-task-row')];if(rows.length!==4)return rows.length;const frames=rows.map(r=>r.querySelector('.my-task-conversation-entry').getBoundingClientRect());if(!frames.every(r=>Math.abs(r.width-220)<.1&&Math.abs(r.height-28)<.1&&Math.abs(r.left-frames[0].left)<.1&&Math.abs(r.right-frames[0].right)<.1))return frames.map(r=>r.toJSON());if(!rows.every(r=>r.querySelector('.my-home-task-open')&&r.querySelector('.my-home-task-title')&&r.querySelector('.my-home-task-status')&&r.querySelector('.my-home-task-time')&&r.querySelector('.my-home-star-btn')))return 'missing original field';if(!rows[1].querySelector('.my-home-task-scope'))return 'missing scope';if(rows.some(r=>r.querySelector('button button')))return 'nested actions';if(document.querySelector('.my-home-main-col').getBoundingClientRect().width<900||document.querySelector('.my-home-main-col').getBoundingClientRect().width>970)return 'left column not representative';const glyphs=rows.map(r=>r.querySelector('.my-task-conversation-entry__action').getBoundingClientRect().x);if(!glyphs.every(x=>Math.abs(x-glyphs[0])<.1))return glyphs;const radii=['.my-task-conversation-entry','.my-home-tab','.my-home-search .my-input'].map(s=>getComputedStyle(document.querySelector(s)).borderRadius);if(!radii.every(r=>r===radii[0]))return radii;return rows[1].querySelector('.my-task-conversation-entry__destination').textContent==='终端'&&rows[2].querySelector('.my-task-conversation-entry__destination').textContent==='工作区'})()`)
  }
  await js('window.homeFixture.configure({theme:"dark",size:"standard"})'); await settle(); await capture('homepage-desktop-dark')
  await js('document.querySelectorAll(".my-task-conversation-entry")[2].focus()'); await settle()
  await check('full native title, complete destination, themed portal above and global radius', `(()=>{const b=document.querySelectorAll('.my-task-conversation-entry')[2],t=document.querySelector('[role=tooltip]');if(!t)return 'missing tooltip';const r=t.getBoundingClientRect(),br=b.getBoundingClientRect();return t.parentElement.classList.contains('my-root')&&t.textContent.includes(window.homeFixture.conversations[2].title)&&t.textContent.includes('ZCode')&&r.bottom<=br.top-5&&r.left>=8&&r.right<=innerWidth-8&&getComputedStyle(t).borderRadius===getComputedStyle(b).borderRadius&&document.activeElement===b&&!b.hasAttribute('title')})()`)
  await capture('homepage-desktop-tooltip')
  const focusedRect = await js(`(()=>{const panel=document.querySelector('.my-home-list-panel').getBoundingClientRect(),header=document.querySelector('.my-home-list-toolbar').getBoundingClientRect(),last=document.querySelector('.my-home-task-row:last-child').getBoundingClientRect(),tip=document.querySelector('[role=tooltip]').getBoundingClientRect();const gutter=parseFloat(getComputedStyle(document.querySelector('.my-root')).getPropertyValue('--my-space-8'));const x=Math.floor(Math.min(panel.left,tip.left)),y=Math.floor(Math.min(header.top,tip.top));const right=Math.ceil(Math.max(panel.right,tip.right)),bottom=Math.ceil(Math.max(last.bottom,tip.bottom)+gutter);return{x,y,width:right-x,height:bottom-y}})()`)
  const focusedCapture = await capture('homepage-task-list-focused', focusedRect)
  assert.equal(focusedCapture.zoomFactor, 1)
  assert.equal(focusedCapture.visualViewport.scale, 1)
  assert.ok(focusedRect.height < 400, 'focused rectangle excludes the blank flex remainder')
  checks.push('direct capturePage rectangle contains real task header, four rows and tooltip without summary/sidebar')
  console.log('FOCUSED_CAPTURE ' + JSON.stringify(focusedCapture))
  await key('Escape')
  await check('Escape dismisses only preview and keeps entry focus', `!document.querySelector('[role=tooltip]')&&document.activeElement===document.querySelectorAll('.my-task-conversation-entry')[2]`)
  await js('document.activeElement.blur()'); await settle()
  const hoverPoint = await js(`(()=>{const r=document.querySelectorAll('.my-task-conversation-entry')[1].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint }); await settle()
  await check('actual pointer hover exposes destination and discoverable relationship management', `Boolean(document.querySelector('[role=tooltip]'))&&document.querySelector('[role=tooltip]').textContent.includes('终端续接')&&document.querySelector('[role=tooltip]').textContent.includes('右键管理关联')`)
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); await settle()
  await js('document.querySelectorAll(".my-home-task-open")[0].click()'); await settle()
  await check('task action retains original task inspect', `window.homeFixture.stores.useMy.getState().peekIssueId==='10-21-fixture-0'&&window.homeFixture.native.calls.filter(c=>c.method==='open').length===0`)
  await js('document.querySelectorAll(".my-home-star-btn")[0].click()'); await settle()
  await check('favorite action independent of session open', `window.homeFixture.stores.useMy.getState().favorites.includes('10-21-fixture-0')&&window.homeFixture.native.calls.filter(c=>c.method==='open').length===0`)
  await js('window.homeFixture.native.holdOpen=true;document.querySelectorAll(".my-task-conversation-entry")[0].click()'); await settle()
  await check('pending open is accessible, bounded, and suppresses duplicate native actions', `(()=>{const b=document.querySelector('.my-task-conversation-entry');b.click();return b.getAttribute('aria-busy')==='true'&&b.getAttribute('aria-disabled')==='true'&&b.getBoundingClientRect().width===220&&b.textContent.includes('处理中')&&window.homeFixture.native.calls.filter(c=>c.method==='open').length===1})()`)
  await js('window.homeFixture.native.holdOpen=false;window.homeFixture.native.finishOpen()'); await settle()
  await check('one click opens exact binding without a dialog or task action', `(()=>{const calls=window.homeFixture.native.calls.filter(c=>c.method==='open');return calls.length===1&&calls[0].input.taskDir==='10-21-fixture-0'&&calls[0].input.bindingId==='binding-0'&&!document.querySelector('[role=dialog]')})()`)
  await js('document.querySelectorAll(".my-task-conversation-entry")[1].focus()'); await settle(); await key('Enter')
  await check('native keyboard entry opens exact Claude terminal destination honestly', `window.homeFixture.native.calls.filter(c=>c.method==='open').at(-1).input.bindingId==='binding-1'&&document.querySelector('.my-home-conversation-feedback').textContent.includes('终端续接')`)
  await js('window.homeFixture.native.discoverError="原生会话索引读取失败（fixture）";document.querySelectorAll(".my-task-conversation-entry")[3].click()'); await settle()
  await check('association discovery error is visible and retryable', `document.querySelector('[role=dialog] [role=alert]').textContent.includes('索引读取失败')`)
  await js('window.homeFixture.native.discoverError=null;document.querySelector("[aria-label=重新发现原生会话]").click()'); await settle()
  await check('unbound association modal discovers only project-scoped actual candidates', `Boolean(document.querySelector('[role=dialog]'))&&document.querySelectorAll('.my-task-conversation-candidate').length===6&&document.querySelector('.my-task-conversation-association').textContent.includes('Claude Code')&&document.querySelector('.my-task-conversation-association').textContent.includes('终端续接')&&window.homeFixture.native.calls.filter(c=>c.method==='discover').at(-1).input.expectedRoot===window.homeFixture.native.root`)
  await check('candidate update times use relative labels and guard missing/out-of-range dates', `(()=>{const rows=[...document.querySelectorAll('.my-task-conversation-candidate')];return rows[0].querySelector('time')?.textContent==='6 小时前'&&rows[1].querySelector('time')?.textContent==='2 天前'&&rows[3].textContent.includes('时间未记录')&&!rows[3].querySelector('time')&&rows[4].textContent.includes('时间未记录')&&!rows[4].querySelector('time')&&!rows.some(row=>/Invalid Date|NaN/.test(row.textContent))})()`)
  await capture('association-candidates')
  await check('association feedback belongs to current task rather than previous resume', `!document.querySelector('.my-task-conversation-association').textContent.includes('已请求终端续接')`)
  await check('association dialog is actually visible in Chromium viewport', `(()=>{const p=document.querySelector('[role=dialog]'),r=p.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.width>300&&getComputedStyle(p).opacity==='1'&&p.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`)
  await js(`document.querySelector('[aria-label="会话来源"]').click()`); await settle()
  await js(`[...document.querySelectorAll('[role=option]')].find(b=>b.textContent==='ZCode').click()`); await settle()
  await check('shared source Select filters actual native source labels', `document.querySelectorAll('.my-task-conversation-candidate').length===1&&document.querySelector('.my-task-conversation-candidate').textContent.includes('ZCode')`)
  await js(`document.querySelector('[aria-label="会话来源"]').click()`); await settle()
  await js(`[...document.querySelectorAll('[role=option]')].find(b=>b.textContent==='全部来源').click()`); await settle()
  await js(`(()=>{const input=document.querySelector('[aria-label="筛选当前项目的原生会话"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Jira');input.dispatchEvent(new Event('input',{bubbles:true}))})()`); await settle()
  await check('candidate title filter retains native source and exact duplicate identities', `(()=>{const rows=[...document.querySelectorAll('.my-task-conversation-candidate')];return rows.length===2&&rows.every(row=>row.textContent.includes('Codex')&&row.textContent.includes('ID '))&&rows[0].title.includes('codex-extra-native-id')&&rows[1].title.includes('codex-extra-native-twin')&&rows[0].getAttribute('aria-label')!==rows[1].getAttribute('aria-label')})()`)
  await capture('association-duplicate-titles')
  await js(`document.querySelector('.my-task-conversation-candidate').click()`); await settle()
  await js(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='关联所选会话').click()`); await settle()
  await check('real bind callback uses opaque candidate ID and exact task directory', `(()=>{const c=window.homeFixture.native.calls.find(c=>c.method==='bind');return c.input.taskDir==='10-21-fixture-3'&&c.input.conversationId==='candidate-extra'&&document.querySelector('.my-task-conversation-association__bindings').textContent.includes('Jira 接入联调原生会话')})()`)
  await key('Escape'); await js('document.querySelectorAll(".my-task-conversation-entry")[3].focus()'); await settle(); await key('F10', ['shift'])
  await check('Shift+F10 manages bound entry without changing primary click', `Boolean(document.querySelector('[role=dialog]'))&&document.querySelector('.my-task-conversation-association__bindings').textContent.includes('Jira 接入联调原生会话')`)
  await js(`(()=>{const b=[...document.querySelectorAll('.my-task-conversation-candidate')].find(b=>b.textContent.includes('补充原生验证记录'));b.click()})()`); await settle()
  await js(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='关联所选会话').click()`); await settle()
  await js(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='设为主会话').click()`); await settle()
  await check('explicit primary change updates persisted binding projection', `window.homeFixture.native.calls.some(c=>c.method==='primary'&&c.input.bindingId==='bound-candidate-second')&&window.homeFixture.snapshot().bindings.find(b=>b.id==='bound-candidate-second').primary`)
  await js(`document.querySelector('[aria-label="解除关联：补充原生验证记录"]').click()`); await settle()
  await check('unlink removes only selected relationship', `window.homeFixture.native.calls.some(c=>c.method==='unbind'&&c.input.bindingId==='bound-candidate-second')&&!window.homeFixture.snapshot().bindings.some(b=>b.id==='bound-candidate-second')`)
  await key('Escape')
  await js(`(()=>{const f=window.homeFixture;f.identityBackup={project:structuredClone(f.stores.useApp.getState().snapshot),native:structuredClone(f.snapshot())};const project=structuredClone(f.identityBackup.project);project.tasks[0].record.id='replacement-task';f.snapshot().bindings[0].currentTaskRef=null;f.snapshot().bindings[0].conversation={...f.snapshot().bindings[0].conversation,title:'旧任务保留的原生会话',capability:'unavailable'};f.stores.useApp.setState({snapshot:project});f.stores.useMy.getState().syncFromSnapshot();document.querySelector('[aria-label="刷新任务会话"]').click()})()`); await settle()
  await check('reused directory cannot inherit an orphan primary with a different stable task identity', `document.querySelector('.my-task-conversation-entry').dataset.capability==='associate'&&!document.querySelector('.my-task-conversation-entry').textContent.includes('旧任务')`)
  await js(`(()=>{const f=window.homeFixture;f.snapshot().bindings.push({id:'replacement-binding',taskDir:'10-21-fixture-0',taskRef:'task:replacement-task',currentTaskRef:'task:replacement-task',conversation:{...f.conversations[3],title:'新任务正确的原生会话'},primary:true,linkedAt:f.stamp,origin:'manual'});document.querySelector('[aria-label="刷新任务会话"]').click()})()`); await settle()
  await check('new task valid primary wins while old task history stays retained', `document.querySelector('.my-task-conversation-entry').textContent.includes('新任务正确')&&window.homeFixture.snapshot().bindings.some(b=>b.id==='binding-0'&&b.conversation.title==='旧任务保留的原生会话')`)
  await js(`document.querySelector('.my-task-conversation-entry').click()`); await settle()
  await check('reused-directory resume opens only the new task binding', `window.homeFixture.native.calls.filter(c=>c.method==='open').at(-1).input.bindingId==='replacement-binding'`)
  await js(`document.querySelector('.my-task-conversation-entry').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`); await settle()
  await check('relationship management excludes orphan records owned by a different task', `document.querySelectorAll('[role=dialog] [aria-label^="解除关联："]').length===1&&!document.querySelector('[role=dialog]').textContent.includes('旧任务保留')`)
  await key('Escape')
  await js(`(()=>{const f=window.homeFixture;const project=structuredClone(f.stores.useApp.getState().snapshot);project.tasks[0].record.id='';f.snapshot().bindings.forEach(b=>{if(b.taskDir==='10-21-fixture-0')b.currentTaskRef=null});f.snapshot().bindings.push({id:'directory-binding',taskDir:'10-21-fixture-0',taskRef:'dir:.trellis/tasks/10-21-fixture-0',currentTaskRef:'dir:.trellis/tasks/10-21-fixture-0',conversation:{...f.conversations[3],title:'无任务ID的目录关联会话'},primary:true,linkedAt:f.stamp,origin:'manual'});f.stores.useApp.setState({snapshot:project});f.stores.useMy.getState().syncFromSnapshot();document.querySelector('[aria-label="刷新任务会话"]').click()})()`); await settle()
  await check('task without a usable native ID follows the shared exact directory identity contract', `document.querySelector('.my-task-conversation-entry').textContent.includes('无任务ID的目录关联')`)
  await js(`(()=>{const f=window.homeFixture;const project=structuredClone(f.stores.useApp.getState().snapshot);project.tasks[0].record.id='large-file-visible-id';project.tasks[0].record.description='x'.repeat(270000);f.stores.useApp.setState({snapshot:project});f.stores.useMy.getState().syncFromSnapshot()})()`); await settle()
  await check('renderer honors main directory identity when scanner exposes an ID beyond identity-reader size budget', `document.querySelector('.my-task-conversation-entry').textContent.includes('无任务ID的目录关联')`)
  await js(`(()=>{const f=window.homeFixture;Object.assign(f.snapshot(),f.identityBackup.native);f.stores.useApp.setState({snapshot:f.identityBackup.project});f.stores.useMy.getState().syncFromSnapshot();document.querySelector('[aria-label="刷新任务会话"]').click()})()`); await settle()
  await js(`window.homeFixture.native.openError='Codex 协议不可用（fixture）';document.querySelectorAll('.my-task-conversation-entry')[0].click()`); await settle()
  await check('native open failure is visible without new-conversation fallback', `document.querySelector('.my-home-conversation-feedback[role=alert]').textContent.includes('协议不可用')`)
  await js(`window.homeFixture.native.openError=null;const c=window.homeFixture.snapshot().bindings.find(b=>b.id==='binding-2').conversation;c.capability='unavailable';c.unavailableReason='原生元信息已删除（fixture）';c.destinationLabel='入口不可用';document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await check('unavailable binding preserves cached native title and disables launching', `(()=>{const b=document.querySelectorAll('.my-home-task-row')[2].querySelector('.my-task-conversation-entry');return b.getAttribute('aria-disabled')==='true'&&b.textContent.includes('Trellis 工作流')&&b.querySelector('.lucide-info')!==null})()`)
  await js(`document.querySelectorAll('.my-home-task-row')[2].querySelector('.my-task-conversation-entry').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`); await settle()
  await check('unavailable retained binding remains manageable', `Boolean(document.querySelector('[role=dialog]'))&&document.querySelector('[aria-label^="解除关联：Trellis"]')!==null`)
  await key('Escape')
  await js(`window.homeFixture.native.listError='原生索引被占用（fixture）';document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await check('source read error preserves last successful list and timestamp', `document.querySelector('.my-home-conversation-feedback[role=alert]').textContent.includes('索引被占用')&&document.querySelectorAll('.my-home-task-row').length===4&&Boolean(document.querySelector('.my-home-conversation-refresh time'))`)
  await js(`window.homeFixture.native.listError=null;window.homeFixture.snapshot().bindings.find(b=>b.id==='binding-2').conversation={...window.homeFixture.conversations[2]};document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await js(`window.homeFixture.native.holdNextList=true;document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await js(`window.homeFixture.switchRoot('D:/other-fixture-project')`); await settle()
  await js(`window.homeFixture.snapshotFor('D:/fixture-project').bindings[0].conversation.title='重返当前项目的最新原标题';window.homeFixture.switchRoot('D:/fixture-project')`); await settle()
  await js(`window.homeFixture.native.held.shift()()`); await settle()
  await check('A-to-B-to-A ignores old same-root response generation', `document.querySelector('.my-task-conversation-entry').textContent.includes('最新原标题')`)
  await check('directory mapping preserves archive parents, rejects traversal/foreign root', `(()=>{const f=window.homeFixture.taskConversationDirectory;return f('D:/p','D:/p/.trellis/tasks/archive/2026-10/Same')==='archive/2026-10/Same'&&f('D:/p','D:/q/.trellis/tasks/Same')===null&&f('D:/p','../Same')===null&&f('/p','/p/.trellis/tasks/Upper')==='Upper'})()`)
  await js(`window.homeFixture.configure({active:false})`); await settle()
  await check('inactive retained homepage owns no floating layer', `!document.querySelector('[role=dialog]')&&!document.querySelector('[role=tooltip]')&&window.homeFixture.escLayerCount()===0`)
  await js(`window.homeFixture.configure({active:true,theme:'light',size:'large'})`); await settle(); await capture('homepage-desktop-light-large')
  await js(`window.homeFixture.native.refreshBaseline=window.homeFixture.native.calls.filter(c=>c.method==='list').length;for(let i=0;i<20;i++)window.homeFixture.emitSnapshot();window.dispatchEvent(new Event('focus'))`); await settle()
  await check('snapshot/focus burst does not flood native metadata reads', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.native.refreshBaseline<=1`)
  await js('new Promise(resolve=>setTimeout(resolve,5100))')
  await check('bounded automatic refresh eventually observes snapshot notification', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.native.refreshBaseline===1`)
  window.setContentSize(640, 840); await settle()
  await check('narrow viewport keeps one-line equal-width entries and local horizontal access', `(()=>{const list=document.querySelector('.my-home-task-rows'),rows=[...document.querySelectorAll('.my-home-task-row')];return list.scrollWidth>list.clientWidth&&['auto','scroll'].includes(getComputedStyle(list).overflowX)&&rows.every(r=>r.querySelector('.my-task-conversation-entry').getBoundingClientRect().width===220&&getComputedStyle(r.querySelector('.my-home-task-title')).whiteSpace==='nowrap')&&document.documentElement.scrollWidth<=innerWidth})()`)
  await js(`document.querySelector('.my-home-task-rows').scrollLeft=300;document.querySelectorAll('.my-home-task-row')[2].querySelector('.my-task-conversation-entry').focus()`); await settle()
  await check('narrow full-title tooltip clamped to viewport without focus theft', `(()=>{const t=document.querySelector('[role=tooltip]');if(!t)return 'no tooltip';const r=t.getBoundingClientRect();return r.left>=8&&r.right<=innerWidth-8&&r.top>=8&&r.bottom<=innerHeight-8&&document.activeElement.classList.contains('my-task-conversation-entry')})()`)
  await capture('homepage-narrow-tooltip')
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await settle()
  await js(`document.activeElement?.blur();document.querySelectorAll('.my-home-task-row')[2].querySelector('.my-task-conversation-entry').focus()`); await settle()
  await check('reduced motion suppresses floating animation', `getComputedStyle(document.querySelector('[role=tooltip]')).animationName==='none'`)
  await key('Escape'); await js(`document.querySelector('.my-home-task-rows').scrollLeft=0`); await settle(); await capture('homepage-narrow')
  await js(`window.homeFixture.unmount()`); await settle()
  await check('unmount removes listeners and Escape layers', `window.homeFixture.native.subscribers.size===0&&window.homeFixture.escLayerCount()===0`)
  assert.deepEqual(errors, [], 'renderer errors')
  writeFileSync(join(output, 'report.json'), JSON.stringify({ result: 'passed', checks, screenshots, captureMetrics, limitations: ['Isolated Electron renders production homepage, hook and modal against fixture native API results.', 'No real Codex/Claude Code/ZCode launch or desktop-window acceptance is claimed.'] }, null, 2))
  console.log('REPORT ' + join(output, 'report.json'))
  app.exit(0)
}

try {
  writeFileSync(join(directory, 'entry.tsx'), fixture)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [absolute('node_modules')], alias: { '@shared': absolute('src/shared') } })
  const cssFiles = ['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'my/my-utilities.css', 'my/my-dashboard.css', 'my/task-conversation-entry.css', 'styles.css']
  const css = (await postcss([tailwind(tailwindConfig)]).process(cssFiles.map((file) => readFileSync(sourceRoot + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0;overflow:hidden}.fixture-host{height:100%;max-width:1320px;margin-inline:auto}@media(max-width:800px){.fixture-host{width:100%}}</style></head><body><div id="root"></div><script>${bootstrap}</script><script src="renderer.js"></script></body></html>`)
  writeFileSync(join(directory, 'main.cjs'), `(${electronChecks.toString()})().catch(error=>{console.error(error);require('electron').app.exit(1)});setTimeout(()=>{console.error('task conversation UI timed out');require('electron').app.exit(1)},45000)`)
  const require = createRequire(import.meta.url)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(require('electron'), [join(directory, 'main.cjs'), output, '--no-sandbox'], { env, windowsHide: true, timeout: 55000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
  console.log('Task conversation UI evidence: ' + output)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
}
