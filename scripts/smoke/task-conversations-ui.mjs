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
const bootstrap = `window.trellis=Object.fromEntries(['taskConversationsList','taskConversationsDiscover','taskConversationsBind','taskConversationsSetPrimary','taskConversationsUnbind','taskConversationsOpen','taskConversationsPrepare','taskConversationsContinue','taskConversationsPreview','taskConversationsInspect','onSnapshotUpdated'].map(name=>[name,(...args)=>window.homeFixture[name](...args)]));`
const fixture = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {flushSync} from '${absolute('node_modules/react-dom/index.js')}';
import {YourWorkPage} from '${absolute(sourceRoot + 'my/pages/YourWorkPage.tsx')}';
import {TaskConversationEntry} from '${absolute(sourceRoot + 'my/components/TaskConversationEntry.tsx')}';
import {RuntimePicker,RuntimeMark} from '${absolute(sourceRoot + 'acp/RuntimePicker.tsx')}';
import {RuntimePanel} from '${absolute(sourceRoot + 'acp/RuntimePanel.tsx')}';
import {useApp} from '${absolute(sourceRoot + 'store/index.ts')}';
import {useMy} from '${absolute(sourceRoot + 'my/store.ts')}';
import {InteractionScope} from '${absolute(sourceRoot + 'utils/interaction-scope.tsx')}';
import {dispatchEscKey,escLayerCount} from '${absolute(sourceRoot + 'utils/esc-layer.ts')}';
import {taskConversationDirectory} from '${absolute(sourceRoot + 'my/use-task-conversations.ts')}';
const root=createRoot(document.getElementById('root'));let config={theme:'dark',size:'standard',active:true,runtimePreview:false};
const runtimeAgents=[['codex','Codex'],['claude','Claude Code'],['zcode','ZCode'],['custom-engine','自定义引擎']].map(([id,name])=>({id,runtimeId:id,name,enabled:true,available:true,setupRequired:false,health:'not_checked'}));
const native={root:'D:/fixture-project',calls:[],copied:[],openRequests:[],subscribers:new Set(),holdNextList:false,held:[],holdOpen:false,finishOpen:null,openError:null,copyError:null,prepareError:null,holdPrepare:false,heldPrepare:[],holdPreview:false,heldPreviews:[],previewError:null,previewUnavailable:null,discoverError:null,listError:null,listPages:new Map()};
const titles=['皮试全流程复盘优化','门诊处方皮试液自动带出','治理基座Trellis工作流与技能统一整改及很长的任务标题','治理基座Jira任务接入与状态同步'];
const stamp=Date.now();
const makeSnapshot=projectRoot=>({meta:{root:projectRoot,name:'Trellis 前端隔离检查',developer:'fixture',currentTask:null},tasks:titles.map((title,index)=>({dirName:'10-21-fixture-'+index,path:projectRoot+'/.trellis/tasks/10-21-fixture-'+index,date:'10-21',record:{id:'fixture-'+index,title,status:index<2?'planning':'in_progress',priority:'P2',assignee:'fixture',creator:'fixture',description:'隔离原生 API 数据；不访问外部客户端。',scope:index===1?'backend':null,createdAt:'2026-10-21'},artifacts:[],updatedAt:stamp-index*1000,taskJsonMtime:stamp})),archived:[]});
const conversations=[
 {id:'candidate-codex',source:'codex',sessionId:'codex-native-id',title:'皮试流程复盘与改进',titleSource:'native',capability:'session',destinationLabel:'Codex'},
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
const packetFor=input=>{const project=useApp.getState().snapshot;const task=[...project.tasks,...project.archived].find(task=>task.path===input.expectedRoot+'/.trellis/tasks/'+input.taskDir);if(!task)throw Error('fixture task not found');const history=project.archived.includes(task)||task.record.status==='completed';return{projectRoot:input.expectedRoot,taskDir:input.taskDir,taskTitle:task.record.title,status:task.record.status,mode:history?'history':'continue',text:'选中任务：'+task.record.title+'；目录：'+input.taskDir+'；状态：'+task.record.status+'；任务资料：prd.md',issues:[],files:['prd.md']}};
window.homeFixture={native,conversations,stamp,escLayerCount,taskConversationDirectory,
 taskConversationsList:async input=>{record('list',input);if(native.listError)return{ok:false,code:'E_IO',error:native.listError};const data=valueFor(input.expectedRoot);Object.assign(data,native.listPages.get(input.expectedRoot)?.shift()??{});const captured=ok(data);if(native.holdNextList){native.holdNextList=false;return new Promise(resolve=>native.held.push(()=>resolve(captured)))}return captured},
 taskConversationsDiscover:async input=>{record('discover',input);if(native.discoverError)return{ok:false,code:'E_IO',error:native.discoverError};return ok({projectRoot:input.expectedRoot,items:conversations.map(c=>({...c,cwd:input.expectedRoot})),sources,truncated:false})},
 taskConversationsBind:async input=>{record('bind',input);const data=valueFor(input.expectedRoot);const task=useApp.getState().snapshot.tasks.find(t=>t.path===input.expectedRoot+'/.trellis/tasks/'+input.taskDir);const ref=task?.record?.id?'task:'+task.record.id:'dir:.trellis/tasks/'+input.taskDir;data.bindings.push({id:'bound-'+input.conversationId,taskDir:input.taskDir,taskRef:ref,currentTaskRef:ref,conversation:conversations.find(c=>c.id===input.conversationId),primary:!data.bindings.some(b=>b.taskDir===input.taskDir),linkedAt:stamp,origin:'manual'});return ok(data)},
 taskConversationsSetPrimary:async input=>{record('primary',input);const data=valueFor(input.expectedRoot);data.bindings.forEach(b=>{if(b.taskDir===input.taskDir)b.primary=b.id===input.bindingId});return ok(data)},
 taskConversationsUnbind:async input=>{record('unbind',input);const data=valueFor(input.expectedRoot);data.bindings=data.bindings.filter(b=>b.id!==input.bindingId);return ok(data)},
 taskConversationsOpen:async input=>{record('open',input);if(native.openError)return{ok:false,code:'E_IO',error:native.openError};const c=valueFor(input.expectedRoot).bindings.find(b=>b.id===input.bindingId).conversation;const result=ok({source:c.source,sessionId:c.sessionId,capability:c.capability,destinationLabel:c.destinationLabel,detail:'已请求'+c.destinationLabel});return native.holdOpen?new Promise(resolve=>{native.finishOpen=()=>resolve(result)}):result},
 taskConversationsPrepare:async input=>{record('prepare',input);if(native.prepareError)return{ok:false,code:'E_IO',error:native.prepareError};const result=ok(packetFor(input));return native.holdPrepare?new Promise(resolve=>native.heldPrepare.push(()=>resolve(result))):result},
 taskConversationsContinue:async input=>{record('continue',input);if(native.copyError)return{ok:false,code:'E_IO',error:native.copyError};const packet=packetFor(input);native.copied.push(packet);const binding=input.bindingId?valueFor(input.expectedRoot).bindings.find(b=>b.id===input.bindingId):null;const c=binding?.conversation;const opened=c&&!native.openError?{source:c.source,sessionId:c.sessionId,capability:c.capability,destinationLabel:c.destinationLabel,detail:'已请求'+c.destinationLabel}:undefined;if(opened)native.openRequests.push({method:'continue',input});const result=ok({packet,copied:true,...(opened?{opened}:{}),...(binding&&native.openError?{openError:native.openError}:{})});return native.holdOpen?new Promise(resolve=>{native.finishOpen=()=>resolve(result)}):result},
 taskConversationsPreview:async input=>{record('preview',input);const result=native.previewError?{ok:false,code:'E_IO',error:native.previewError}:ok({projectRoot:input.expectedRoot,conversationId:input.conversationId,messages:native.previewUnavailable?[]:[{role:'user',text:'用户核对 '+input.conversationId+' <img src="https://invalid.example/remote.png">'},{role:'assistant',text:'助手可见答复 '+input.conversationId}],truncated:true,...(native.previewUnavailable?{unavailableReason:native.previewUnavailable}:{})});return native.holdPreview?new Promise(resolve=>native.heldPreviews.push({id:input.conversationId,finish:()=>resolve(result)})):result},
 taskConversationsInspect:async input=>{record('inspect',input);if(native.openError)return{ok:false,code:'E_IO',error:native.openError};const c=conversations.find(c=>c.id===input.conversationId);native.openRequests.push({method:'inspect',input});return ok({source:c.source,sessionId:c.sessionId,capability:c.capability,destinationLabel:c.destinationLabel,detail:'已请求'+c.destinationLabel})},
 onSnapshotUpdated:callback=>{native.subscribers.add(callback);return()=>native.subscribers.delete(callback)},
 snapshot:()=>valueFor(native.root),snapshotFor:valueFor,
 configure:patch=>{config={...config,...patch};document.documentElement.classList.toggle('dark',config.theme==='dark');flushSync(()=>root.render(<div className="my-root fixture-host" data-my-theme={config.theme} data-my-font-size={config.size}><InteractionScope active={config.active}><YourWorkPage/>{config.runtimePreview&&<section data-runtime-preview className="bg-my-canvas text-my-primary p-4 space-y-3" style={{position:'absolute',top:20,left:20,width:500,zIndex:10}}><RuntimePicker agents={runtimeAgents} value="codex" onSelect={()=>{}}/><div data-unknown-brands className="flex items-center gap-2"><RuntimeMark runtimeId="custom-engine"/><RuntimeMark/><TaskConversationEntry title="面板会话" source="panel" sourceLabel="面板" capability="session" onOpen={()=>{}}/></div><RuntimePanel agents={runtimeAgents} onChange={()=>{}} isCurrent={()=>true}/></section>}</InteractionScope></div>))},
 switchRoot:projectRoot=>{native.root=projectRoot;flushSync(()=>{useApp.setState({snapshot:makeSnapshot(projectRoot),page:'dashboard'});useMy.getState().syncFromSnapshot()})},
 emitSnapshot:()=>{for(const cb of native.subscribers)cb(useApp.getState().snapshot)},
 setVisible:visible=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:visible?'visible':'hidden'});document.dispatchEvent(new Event('visibilitychange'))},
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
  const renderedBrandAssets = []
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
  const scanInterval = () => js('new Promise(resolve=>setTimeout(resolve,1150))')
  const check = async (name, code) => { const value = await js(code); assert.equal(value, true, name + ': ' + JSON.stringify(value)); checks.push(name); console.log('PASS ' + name) }
  const readBrandAssets = async (surface) => {
    await js('document.getAnimations().forEach(animation=>{if(animation.effect.getTiming().iterations!==Infinity)animation.finish()})')
    await settle()
    const assets = await js(`Promise.all([...document.querySelectorAll('.tool-brand-icon:not([data-tool-brand="unknown"])')].map(async mark=>{const image=mark.querySelector('img'),mask=mark.querySelector('.tool-brand-icon__mask');const value=mask?getComputedStyle(mask).maskImage:'';const url=image?.src??new URL(value.slice(4,-1).replaceAll('"','').replaceAll("'",''),document.baseURI).href;const decoded=new Image();decoded.src=url;await decoded.decode();let opacity=1;const filters=[];for(let element=image??mask;element;element=element.parentElement){const style=getComputedStyle(element);opacity*=Number(style.opacity);if(style.filter!=='none')filters.push(style.filter)}return{effectiveOpacity:opacity,filters,brand:mark.dataset.toolBrand,mode:mark.dataset.toolBrandMode,url,naturalWidth:decoded.naturalWidth,width:mark.getBoundingClientRect().width,color:getComputedStyle(mark).color,maskColor:mask?getComputedStyle(mask).backgroundColor:null}}))`)
    assert.ok(assets.length > 0 && assets.every(asset => asset.url.startsWith('file:') && asset.naturalWidth > 0 && asset.width === 16 && asset.effectiveOpacity === 1 && asset.filters.length === 0), surface + ' preserves decoded local asset colors, opacity and existing 16px slots: ' + JSON.stringify(assets))
    renderedBrandAssets.push({ surface, assets })
  }
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await settle()
  }
  const repair = async (index) => {
    await js(`document.querySelectorAll('.my-home-task-open')[${index}].click()`); await settle()
    await js(`document.querySelector('[aria-label="任务更多操作"]').click()`); await settle()
    await js(`[...document.querySelectorAll('.my-menu-item')].find(button=>button.textContent==='修复执行入口').click()`); await settle()
  }
  const capture = async (name, rect) => {
    // Hidden Chromium may hold CSS entry animations at their initial frame.
    // Capture their real completed appearance, without altering component styles.
    await js('document.getAnimations().forEach(animation=>{if(animation.effect.getTiming().iterations!==Infinity)animation.finish()})')
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    // Wake the hidden compositor after finishing UI animations, without OS focus.
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1 + screenshots.length % 2, y: 1 })
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
  await check('unbound normal entry offers selected-task instructions without a global picker', `(()=>{const b=document.querySelectorAll('.my-task-conversation-entry')[3];return !('indexing' in window.homeFixture.snapshot())&&b.textContent.includes('接续此任务')&&b.getAttribute('aria-disabled')!=='true'&&b.getAttribute('aria-label').includes('复制当前任务')&&b.getAttribute('aria-label').includes('尚未恢复旧会话历史')&&!b.getAttribute('aria-label').includes('选择会话')})()`)
  await js(`window.homeFixture.native.listError='原生历史暂不可读（fixture）';document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await check('source search failure keeps selected-task continuation available', `(()=>{const b=document.querySelectorAll('.my-task-conversation-entry')[3];return b.textContent.includes('接续此任务')&&b.getAttribute('aria-disabled')!=='true'&&b.getAttribute('aria-label').includes('原生历史暂不可读')&&b.getAttribute('aria-label').includes('复制当前任务')})()`)
  await js(`window.homeFixture.native.listError=null;document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  for (const theme of ['light', 'dark']) for (const size of ['small', 'standard', 'large']) {
    await js(`window.homeFixture.configure(${JSON.stringify({ theme, size })})`); await settle()
    await check(theme + '/' + size + ' real homepage geometry and all original fields', `(()=>{const rows=[...document.querySelectorAll('.my-home-task-row')];if(rows.length!==4)return rows.length;const frames=rows.map(r=>r.querySelector('.my-task-conversation-entry').getBoundingClientRect());if(!frames.every(r=>Math.abs(r.width-220)<.1&&Math.abs(r.height-28)<.1&&Math.abs(r.left-frames[0].left)<.1&&Math.abs(r.right-frames[0].right)<.1))return frames.map(r=>r.toJSON());if(!rows.every(r=>r.querySelector('.my-home-task-open')&&r.querySelector('.my-home-task-title')&&r.querySelector('.my-home-task-status')&&r.querySelector('.my-home-task-time')&&r.querySelector('.my-home-star-btn')))return 'missing original field';if(!rows[1].querySelector('.my-home-task-scope'))return 'missing scope';if(rows.some(r=>r.querySelector('button button')))return 'nested actions';if(document.querySelector('.my-home-main-col').getBoundingClientRect().width<900||document.querySelector('.my-home-main-col').getBoundingClientRect().width>970)return 'left column not representative';const glyphs=rows.map(r=>r.querySelector('.my-task-conversation-entry__action').getBoundingClientRect().x);if(!glyphs.every(x=>Math.abs(x-glyphs[0])<.1))return glyphs;const radii=['.my-task-conversation-entry','.my-home-tab','.my-home-search .my-input'].map(s=>getComputedStyle(document.querySelector(s)).borderRadius);if(!radii.every(r=>r===radii[0]))return radii;return rows[1].querySelector('.my-task-conversation-entry__destination').textContent==='终端'&&rows[2].querySelector('.my-task-conversation-entry__destination').textContent==='工作区'})()`)
    if (size === 'standard') {
      await readBrandAssets('homepage-' + theme)
      await check(theme + ' genuine native identities, theme-aware Codex and neutral unmatched entry', `(()=>{const entries=[...document.querySelectorAll('.my-home-task-row .my-task-conversation-entry')],marks=entries.slice(0,3).map(entry=>entry.querySelector('[data-tool-brand]'));const mask=marks[0].querySelector('.tool-brand-icon__mask'),ink=getComputedStyle(mask).backgroundColor;const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.fillStyle=ink;context.fillRect(0,0,1,1);const red=context.getImageData(0,0,1,1).data[0];return marks.map(mark=>mark.dataset.toolBrand).join('|')==='codex|claude-code|zcode'&&marks.every((mark,index)=>entries[index].getAttribute('aria-label').includes(['Codex','Claude Code','ZCode'][index]))&&getComputedStyle(mask).maskImage.includes('codex-')&&ink===getComputedStyle(marks[0]).color&&(${JSON.stringify(theme)}==='light'?red<128:red>128)&&!entries[3].querySelector('[data-tool-brand]')&&Boolean(entries[3].querySelector('.my-task-conversation-entry__icon > svg'))&&entries[3].dataset.source==='unbound'||{ink,parentInk:getComputedStyle(marks[0]).color,mask:getComputedStyle(mask).maskImage,brands:marks.map(mark=>mark.dataset.toolBrand),unbound:entries[3].dataset.source}})()`)
    }
  }
  await js('window.homeFixture.configure({theme:"dark",size:"standard"})'); await settle(); await capture('homepage-desktop-dark')
  await js('document.querySelector(".my-task-conversation-entry").focus()'); await settle()
  await check('Codex tooltip and accessible label disclose copying, opening and explicit paste/send without duplicate source', `(()=>{const entry=document.querySelector('.my-task-conversation-entry'),tip=document.querySelector('[role=tooltip]');return Boolean(tip)&&[tip.textContent,entry.getAttribute('aria-label')].every(text=>text.includes('复制当前任务')&&text.includes('请求打开原会话')&&text.includes('粘贴并发送')&&!text.includes('Codex · Codex')&&!text.includes('右键'))})()`)
  await key('Escape')
  await js('document.querySelectorAll(".my-task-conversation-entry")[2].focus()'); await settle()
  await check('full native title, truthful workspace limitation, themed portal above and global radius', `(()=>{const b=document.querySelectorAll('.my-task-conversation-entry')[2],t=document.querySelector('[role=tooltip]');if(!t)return 'missing tooltip';const r=t.getBoundingClientRect(),br=b.getBoundingClientRect();return t.parentElement.classList.contains('my-root')&&t.textContent.includes(window.homeFixture.conversations[2].title)&&t.textContent.includes('ZCode')&&t.textContent.includes('未恢复精确旧会话')&&!t.textContent.includes('请求打开原会话')&&r.bottom<=br.top-5&&r.left>=8&&r.right<=innerWidth-8&&getComputedStyle(t).borderRadius===getComputedStyle(b).borderRadius&&document.activeElement===b&&!b.hasAttribute('title')})()`)
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
  await check('actual pointer hover retains terminal destination and paste/send disclosure', `Boolean(document.querySelector('[role=tooltip]'))&&document.querySelector('[role=tooltip]').textContent.includes('终端续接')&&document.querySelector('[role=tooltip]').textContent.includes('粘贴并发送')&&!document.querySelector('[role=tooltip]').textContent.includes('右键')`)
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); await settle()
  await js('document.querySelectorAll(".my-home-task-open")[0].click()'); await settle()
  await check('task action still inspects the selected task without copying or opening native history', `document.querySelector('.my-home-task-preview').textContent.includes('皮试全流程复盘优化')&&window.homeFixture.native.calls.filter(c=>c.method==='continue'||c.method==='open').length===0&&Boolean(document.querySelector('[aria-label="任务更多操作"]'))`)
  await key('Escape')
  await js('document.querySelectorAll(".my-home-star-btn")[0].click()'); await settle()
  await check('favorite action independent of continuation', `window.homeFixture.stores.useMy.getState().favorites.includes('10-21-fixture-0')&&window.homeFixture.native.calls.filter(c=>c.method==='continue').length===0`)
  await js('window.homeFixture.native.holdOpen=true;document.querySelectorAll(".my-task-conversation-entry")[0].click()'); await settle()
  await check('pending continuation is accessible, bounded and suppresses duplicate copies/opens', `(()=>{const b=document.querySelector('.my-task-conversation-entry');b.click();return b.getAttribute('aria-busy')==='true'&&b.getAttribute('aria-disabled')==='true'&&b.getBoundingClientRect().width===220&&b.textContent.includes('处理中')&&window.homeFixture.native.calls.filter(c=>c.method==='continue').length===1})()`)
  await js('window.homeFixture.native.holdOpen=false;window.homeFixture.native.finishOpen()'); await settle()
  await check('one click copies the selected task and requests its exact old conversation without a picker', `(()=>{const f=window.homeFixture,calls=f.native.calls.filter(c=>c.method==='continue'),feedback=document.querySelector('.my-home-conversation-feedback').textContent;return calls.length===1&&calls[0].input.taskDir==='10-21-fixture-0'&&calls[0].input.bindingId==='binding-0'&&f.native.copied[0].text.includes('皮试全流程复盘优化')&&f.native.copied[0].text.includes('10-21-fixture-0')&&feedback.includes('已复制')&&feedback.includes('已请求')&&feedback.includes('粘贴并发送')&&!document.querySelector('[role=dialog]')})()`)
  await js('document.querySelectorAll(".my-task-conversation-entry")[1].focus()'); await settle(); await key('Enter')
  await check('native keyboard continuation retains the actual Claude terminal destination', `window.homeFixture.native.calls.filter(c=>c.method==='continue').at(-1).input.bindingId==='binding-1'&&document.querySelector('.my-home-conversation-feedback').textContent.includes('终端续接')`)
  await js(`document.querySelectorAll('.my-task-conversation-entry')[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));document.querySelectorAll('.my-task-conversation-entry')[0].focus()`); await key('F10', ['shift'])
  await check('normal entries no longer expose right-click or Shift+F10 repair management', `!document.querySelector('[role=dialog]')&&!document.querySelector('.my-task-conversation-entry').getAttribute('aria-description')`)
  await js(`document.querySelectorAll('.my-task-conversation-entry')[3].click()`); await settle()
  await check('unbound continuation prepares only the selected task and never discovers global candidates', `(()=>{const f=window.homeFixture,p=document.querySelector('.my-task-continuation');return Boolean(p)&&p.textContent.includes('尚未恢复旧会话历史')&&p.querySelector('pre').textContent.includes('10-21-fixture-3')&&f.native.calls.filter(c=>c.method==='discover').length===0&&!document.querySelector('.my-task-conversation-candidate')})()`)
  await capture('task-continuation-unbound')
  await js(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.includes('复制接续说明')).click()`); await settle()
  await check('unbound copy uses Continue without binding and never opens or binds a conversation', `(()=>{const f=window.homeFixture,c=f.native.calls.filter(c=>c.method==='continue').at(-1);return c.input.taskDir==='10-21-fixture-3'&&!('bindingId' in c.input)&&f.native.copied.at(-1).taskDir==='10-21-fixture-3'&&f.native.calls.filter(c=>c.method==='bind').length===0&&document.querySelector('.my-task-continuation [role=status]').textContent.includes('粘贴并发送')})()`)
  await key('Escape')
  await js(`window.homeFixture.native.discoverError='原生会话索引读取失败（fixture）'`)
  await repair(3)
  await check('association discovery error is visible and retryable', `document.querySelector('[role=dialog] [role=alert]').textContent.includes('索引读取失败')`)
  await js('window.homeFixture.native.discoverError=null;document.querySelector("[aria-label=重新发现原生会话]").click()'); await settle()
  await check('unbound association modal discovers only project-scoped actual candidates', `Boolean(document.querySelector('[role=dialog]'))&&document.querySelectorAll('.my-task-conversation-candidate').length===6&&document.querySelector('.my-task-conversation-association').textContent.includes('Claude Code')&&document.querySelector('.my-task-conversation-association').textContent.includes('终端续接')&&window.homeFixture.native.calls.filter(c=>c.method==='discover').at(-1).input.expectedRoot===window.homeFixture.native.root`)
  await check('candidate update times use relative labels and guard missing/out-of-range dates', `(()=>{const rows=[...document.querySelectorAll('.my-task-conversation-candidate')];return rows[0].querySelector('time')?.textContent==='6 小时前'&&rows[1].querySelector('time')?.textContent==='2 天前'&&rows[3].textContent.includes('时间未记录')&&!rows[3].querySelector('time')&&rows[4].textContent.includes('时间未记录')&&!rows[4].querySelector('time')&&!rows.some(row=>/Invalid Date|NaN/.test(row.textContent))})()`)
  await check('genuine candidate icons and single source metadata retain actual destinations', `(()=>{const rows=[...document.querySelectorAll('.my-task-conversation-candidate')],entry=document.querySelector('.my-task-conversation-entry');return rows.map(row=>row.querySelector('[data-tool-brand]').dataset.toolBrand).join('|')==='codex|claude-code|zcode|codex|claude-code|codex'&&rows[0].querySelector('.my-task-conversation-candidate__meta').textContent==='Codex · 6 小时前'&&!rows[0].getAttribute('aria-label').includes('Codex · Codex')&&!entry.getAttribute('aria-label').includes('Codex · Codex')&&rows[1].textContent.includes('Claude Code · 终端续接')&&rows[2].textContent.includes('ZCode · 打开工作区')})()`)
  await readBrandAssets('native-candidates')
  await capture('association-candidates')
  await check('association feedback belongs to current task rather than previous resume', `!document.querySelector('.my-task-conversation-association').textContent.includes('已请求终端续接')`)
  await check('association dialog is actually visible in Chromium viewport', `(()=>{const p=document.querySelector('[role=dialog]'),r=p.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.width>300&&getComputedStyle(p).opacity==='1'&&p.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`)
  await js(`document.querySelector('[aria-label="会话来源"]').click()`); await settle()
  await check('native source filter retains only three adapters with their actual brand marks', `(()=>{const options=[...document.querySelectorAll('[role=option]')];return options.map(b=>b.textContent).join('|')==='全部来源|Codex|Claude Code|ZCode'&&options.slice(1).map(b=>b.querySelector('[data-tool-brand]').dataset.toolBrand).join('|')==='codex|claude-code|zcode'})()`)
  await readBrandAssets('native-source-filter')
  await js(`[...document.querySelectorAll('[role=option]')].find(b=>b.textContent==='ZCode').click()`); await settle()
  await check('shared source Select filters actual native source labels', `document.querySelectorAll('.my-task-conversation-candidate').length===1&&document.querySelector('.my-task-conversation-candidate').textContent.includes('ZCode')`)
  await js(`document.querySelector('[aria-label="会话来源"]').click()`); await settle()
  await js(`[...document.querySelectorAll('[role=option]')].find(b=>b.textContent==='全部来源').click()`); await settle()
  await js(`(()=>{const input=document.querySelector('[aria-label="筛选当前项目的原生会话"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Jira');input.dispatchEvent(new Event('input',{bubbles:true}))})()`); await settle()
  await check('candidate title filter retains native source and exact duplicate identities', `(()=>{const rows=[...document.querySelectorAll('.my-task-conversation-candidate')];return rows.length===2&&rows.every(row=>row.textContent.includes('Codex')&&row.textContent.includes('ID '))&&rows[0].title.includes('codex-extra-native-id')&&rows[1].title.includes('codex-extra-native-twin')&&rows[0].getAttribute('aria-label')!==rows[1].getAttribute('aria-label')})()`)
  await capture('association-duplicate-titles')
  await js(`document.querySelector('.my-task-conversation-candidate').click()`); await settle()
  await check('repair preview renders bounded user/assistant snippets as plain text without remote resources', `(()=>{const p=document.querySelector('.my-task-conversation-preview');return p.textContent.includes('用户核对 candidate-extra')&&p.textContent.includes('助手可见答复 candidate-extra')&&p.textContent.includes('<img src=')&&!p.querySelector('img')&&p.querySelectorAll('li').length===2&&p.textContent.includes('部分最近对话')&&window.homeFixture.native.calls.filter(c=>c.method==='preview').at(-1).input.taskDir==='10-21-fixture-3'})()`)
  await capture('repair-selected-preview')
  await js(`window.homeFixture.beforeInspectCopies=window.homeFixture.native.copied.length;[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.includes('打开原生会话核对')).click()`); await settle()
  await check('Inspect requests the selected candidate without binding or copying task instructions', `window.homeFixture.native.calls.filter(c=>c.method==='inspect').at(-1).input.conversationId==='candidate-extra'&&window.homeFixture.native.calls.filter(c=>c.method==='bind').length===0&&window.homeFixture.native.copied.length===window.homeFixture.beforeInspectCopies&&document.querySelector('.my-task-conversation-association').textContent.includes('尚未保存执行入口')`)
  await js(`window.homeFixture.beforeSaveOpens=window.homeFixture.native.openRequests.length;[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='保存执行入口').click()`); await settle()
  await check('saving an execution entry closes repair without implying opening or execution', `(()=>{const f=window.homeFixture,c=f.native.calls.find(c=>c.method==='bind');return c.input.taskDir==='10-21-fixture-3'&&c.input.conversationId==='candidate-extra'&&!document.querySelector('[role=dialog]')&&f.native.openRequests.length===f.beforeSaveOpens&&document.querySelector('.my-home-conversation-feedback').textContent.includes('尚未打开会话或执行任务')})()`)
  await repair(3)
  await check('repair is available only through task details More with retained relationship controls', `document.querySelector('[role=dialog] h2').textContent==='修复执行入口'&&document.querySelector('.my-task-conversation-association__bindings').textContent.includes('Jira 接入联调原生会话')`)
  await js(`(()=>{const b=[...document.querySelectorAll('.my-task-conversation-candidate')].find(b=>b.textContent.includes('补充原生验证记录'));b.click()})()`); await settle()
  await js(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='保存执行入口').click()`); await settle()
  await repair(3)
  await js(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='设为主会话').click()`); await settle()
  await check('explicit primary change updates persisted binding projection with actual relationship icons', `window.homeFixture.native.calls.some(c=>c.method==='primary'&&c.input.bindingId==='bound-candidate-second')&&window.homeFixture.snapshot().bindings.find(b=>b.id==='bound-candidate-second').primary&&[...document.querySelectorAll('.my-task-conversation-association__bindings [data-tool-brand]')].map(mark=>mark.dataset.toolBrand).join('|')==='codex|claude-code'&&document.querySelector('.my-task-conversation-association__primary').closest('li').querySelector('[data-tool-brand]').dataset.toolBrand==='claude-code'`)
  await js(`document.querySelector('[aria-label="解除关联：补充原生验证记录"]').click()`); await settle()
  await check('unlink removes only selected relationship', `window.homeFixture.native.calls.some(c=>c.method==='unbind'&&c.input.bindingId==='bound-candidate-second')&&!window.homeFixture.snapshot().bindings.some(b=>b.id==='bound-candidate-second')`)
  await js(`window.homeFixture.native.holdPreview=true;document.querySelectorAll('.my-task-conversation-candidate')[0].click()`); await settle()
  await js(`document.querySelectorAll('.my-task-conversation-candidate')[1].click()`); await settle()
  await js(`window.homeFixture.native.heldPreviews.shift().finish()`); await settle()
  await check('older preview cannot leak when a different candidate is selected', `document.querySelector('.my-task-conversation-preview [role=status]').textContent.includes('读取会话片段')&&!document.querySelector('.my-task-conversation-preview').textContent.includes('candidate-codex')`)
  await js(`window.homeFixture.native.heldPreviews.shift().finish();window.homeFixture.native.holdPreview=false`); await settle()
  await check('selected preview retains its exact source identity', `document.querySelector('.my-task-conversation-preview').textContent.includes('candidate-claude')&&!document.querySelector('.my-task-conversation-preview').textContent.includes('candidate-codex')`)
  await js(`window.homeFixture.native.previewError='原生片段被占用（fixture）';document.querySelectorAll('.my-task-conversation-candidate')[2].click()`); await settle()
  await check('preview RPC failure explicitly replaces earlier snippet text', `document.querySelector('.my-task-conversation-preview [role=alert]').textContent.includes('片段被占用')&&!document.querySelector('.my-task-conversation-preview').textContent.includes('candidate-claude')`)
  await js(`window.homeFixture.native.previewError=null;window.homeFixture.native.previewUnavailable='此原生来源暂不支持安全片段预览';document.querySelectorAll('.my-task-conversation-candidate')[3].click()`); await settle()
  await check('unsupported preview availability is explicit rather than a fabricated empty history', `document.querySelector('.my-task-conversation-preview [role=alert]').textContent.includes('不支持安全片段预览')&&document.querySelectorAll('.my-task-conversation-preview__messages li').length===0`)
  await js(`window.homeFixture.native.previewUnavailable=null;window.homeFixture.native.holdPreview=true;document.querySelectorAll('.my-task-conversation-candidate')[0].click()`); await settle()
  await js(`window.homeFixture.previewRoot=window.homeFixture.native.root;window.homeFixture.switchRoot('D:/preview-other-fixture')`); await settle()
  await js(`window.homeFixture.switchRoot(window.homeFixture.previewRoot);window.homeFixture.native.heldPreviews.shift().finish();window.homeFixture.native.holdPreview=false`); await settle()
  await check('A-to-B-to-A root transition cannot restore old repair or snippet state', `!document.querySelector('[role=dialog]')&&!document.body.textContent.includes('用户核对 candidate-codex')`)
  await js(`window.homeFixture.native.holdPrepare=true;document.querySelectorAll('.my-home-task-row .my-task-conversation-entry')[3].click()`); await settle()
  await js(`window.homeFixture.switchRoot('D:/prepare-other-fixture')`); await settle()
  await js(`window.homeFixture.switchRoot(window.homeFixture.previewRoot);window.homeFixture.native.heldPrepare.shift()();window.homeFixture.native.holdPrepare=false`); await settle()
  await check('old task packet cannot reopen continuation after the project owner changes', `!document.querySelector('.my-task-continuation')&&!document.querySelector('[role=dialog]')`)
  await js(`window.homeFixture.sharedParentBackup=structuredClone(window.homeFixture.snapshot().bindings[1].conversation);window.homeFixture.snapshot().bindings[1].conversation={...window.homeFixture.snapshot().bindings[0].conversation};document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await js(`document.querySelectorAll('.my-home-task-row .my-task-conversation-entry')[1].click()`); await settle()
  await check('tasks sharing a parent native conversation copy the selected child task rather than the other task', `(()=>{const f=window.homeFixture,p=f.native.copied.at(-1),c=f.native.calls.filter(c=>c.method==='continue').at(-1);return c.input.bindingId==='binding-1'&&p.taskDir==='10-21-fixture-1'&&p.text.includes('门诊处方皮试液自动带出')&&!p.text.includes('皮试全流程复盘优化')&&f.snapshot().bindings[0].conversation.sessionId===f.snapshot().bindings[1].conversation.sessionId})()`)
  await js(`window.homeFixture.snapshot().bindings[1].conversation=window.homeFixture.sharedParentBackup;window.homeFixture.native.copyError='剪贴板写入失败（fixture）';window.homeFixture.copyFailureBaseline={copies:window.homeFixture.native.copied.length,opens:window.homeFixture.native.openRequests.length};document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await js(`document.querySelector('.my-task-conversation-entry').click()`); await settle()
  await check('clipboard failure reports failure and does not claim copied instructions or request opening', `window.homeFixture.native.copied.length===window.homeFixture.copyFailureBaseline.copies&&window.homeFixture.native.openRequests.length===window.homeFixture.copyFailureBaseline.opens&&document.querySelector('.my-home-conversation-feedback[role=alert]').textContent.includes('剪贴板写入失败')&&!document.querySelector('.my-home-conversation-feedback').textContent.includes('已复制')`)
  await js(`(()=>{const f=window.homeFixture;f.native.copyError=null;f.finishedBackup=structuredClone(f.stores.useApp.getState().snapshot);const project=structuredClone(f.finishedBackup);project.tasks[0].record.status='completed';project.tasks[0].record.completedAt=new Date(f.stamp).toISOString();f.stores.useApp.setState({snapshot:project});f.stores.useMy.getState().syncFromSnapshot();document.querySelectorAll('.my-home-tab')[3].click();f.finishedCopyBaseline=f.native.copied.length})()`); await settle()
  await js(`document.querySelector('.my-home-task-row .my-task-conversation-entry').click()`); await settle()
  await check('completed bound task opens existing history without copying or restarting work', `window.homeFixture.native.calls.filter(c=>c.method==='open').at(-1).input.bindingId==='binding-0'&&window.homeFixture.native.copied.length===window.homeFixture.finishedCopyBaseline&&document.querySelector('.my-task-conversation-entry').getAttribute('aria-label').includes('仅打开原会话查看历史')`)
  await js(`(()=>{const f=window.homeFixture,project=structuredClone(f.finishedBackup);const task=project.tasks.splice(3,1)[0];task.record.status='completed';task.record.completedAt=new Date(f.stamp).toISOString();project.archived.push(task);f.stores.useApp.setState({snapshot:project});f.stores.useMy.getState().syncFromSnapshot()})()`); await settle()
  await js(`document.querySelector('.my-home-task-row .my-task-conversation-entry').click()`); await settle()
  await check('archived unbound task offers handoff/history material rather than continue-work copy', `document.querySelector('.my-task-conversation-entry').textContent.includes('查看交接与历史')&&document.querySelector('.my-task-continuation h2').textContent==='任务交接与历史资料'&&document.querySelector('.my-task-continuation pre').textContent.includes('10-21-fixture-3')&&Boolean([...document.querySelectorAll('.my-task-continuation button')].find(b=>b.textContent.includes('复制交接资料')))&&!document.querySelector('.my-task-continuation').textContent.includes('粘贴并发送')`)
  await key('Escape')
  await js(`window.homeFixture.stores.useApp.setState({snapshot:window.homeFixture.finishedBackup});window.homeFixture.stores.useMy.getState().syncFromSnapshot();document.querySelectorAll('.my-home-tab')[0].click()`); await settle()
  await js(`(()=>{const f=window.homeFixture;f.identityBackup={project:structuredClone(f.stores.useApp.getState().snapshot),native:structuredClone(f.snapshot())};const project=structuredClone(f.identityBackup.project);project.tasks[0].record.id='replacement-task';f.snapshot().bindings[0].currentTaskRef=null;f.snapshot().bindings[0].conversation={...f.snapshot().bindings[0].conversation,title:'旧任务保留的原生会话',capability:'unavailable'};f.stores.useApp.setState({snapshot:project});f.stores.useMy.getState().syncFromSnapshot();document.querySelector('[aria-label="刷新任务会话"]').click()})()`); await settle()
  await check('reused directory cannot inherit an orphan primary with a different stable task identity', `document.querySelector('.my-task-conversation-entry').dataset.capability==='associate'&&!document.querySelector('.my-task-conversation-entry').textContent.includes('旧任务')`)
  await js(`(()=>{const f=window.homeFixture;f.snapshot().bindings.push({id:'replacement-binding',taskDir:'10-21-fixture-0',taskRef:'task:replacement-task',currentTaskRef:'task:replacement-task',conversation:{...f.conversations[3],title:'新任务正确的原生会话'},primary:true,linkedAt:f.stamp,origin:'manual'});document.querySelector('[aria-label="刷新任务会话"]').click()})()`); await settle()
  await check('new task valid primary wins while old task history stays retained', `document.querySelector('.my-task-conversation-entry').textContent.includes('新任务正确')&&window.homeFixture.snapshot().bindings.some(b=>b.id==='binding-0'&&b.conversation.title==='旧任务保留的原生会话')`)
  await js(`document.querySelector('.my-task-conversation-entry').click()`); await settle()
  await check('reused-directory continuation uses only the new task binding', `window.homeFixture.native.calls.filter(c=>c.method==='continue').at(-1).input.bindingId==='replacement-binding'`)
  await repair(0)
  await check('relationship management excludes orphan records owned by a different task', `document.querySelectorAll('[role=dialog] [aria-label^="解除关联："]').length===1&&!document.querySelector('[role=dialog]').textContent.includes('旧任务保留')`)
  await key('Escape')
  await js(`(()=>{const f=window.homeFixture;const project=structuredClone(f.stores.useApp.getState().snapshot);project.tasks[0].record.id='';f.snapshot().bindings.forEach(b=>{if(b.taskDir==='10-21-fixture-0')b.currentTaskRef=null});f.snapshot().bindings.push({id:'directory-binding',taskDir:'10-21-fixture-0',taskRef:'dir:.trellis/tasks/10-21-fixture-0',currentTaskRef:'dir:.trellis/tasks/10-21-fixture-0',conversation:{...f.conversations[3],title:'无任务ID的目录关联会话'},primary:true,linkedAt:f.stamp,origin:'manual'});f.stores.useApp.setState({snapshot:project});f.stores.useMy.getState().syncFromSnapshot();document.querySelector('[aria-label="刷新任务会话"]').click()})()`); await settle()
  await check('task without a usable native ID follows the shared exact directory identity contract', `document.querySelector('.my-task-conversation-entry').textContent.includes('无任务ID的目录关联')`)
  await js(`(()=>{const f=window.homeFixture;const project=structuredClone(f.stores.useApp.getState().snapshot);project.tasks[0].record.id='large-file-visible-id';project.tasks[0].record.description='x'.repeat(270000);f.stores.useApp.setState({snapshot:project});f.stores.useMy.getState().syncFromSnapshot()})()`); await settle()
  await check('renderer honors main directory identity when scanner exposes an ID beyond identity-reader size budget', `document.querySelector('.my-task-conversation-entry').textContent.includes('无任务ID的目录关联')`)
  await js(`(()=>{const f=window.homeFixture;Object.assign(f.snapshot(),f.identityBackup.native);f.stores.useApp.setState({snapshot:f.identityBackup.project});f.stores.useMy.getState().syncFromSnapshot();document.querySelector('[aria-label="刷新任务会话"]').click()})()`); await settle()
  await js(`window.homeFixture.native.openError='Codex 协议不可用（fixture）';document.querySelectorAll('.my-task-conversation-entry')[0].click()`); await settle()
  await check('copy success with native open failure exposes truthful partial feedback and useful task fallback', `document.querySelector('.my-home-conversation-feedback[role=alert]').textContent.includes('协议不可用')&&document.querySelector('.my-home-conversation-feedback[role=alert]').textContent.includes('已复制')&&document.querySelector('.my-task-continuation').textContent.includes('粘贴并发送')`)
  await key('Escape')
  await js(`window.homeFixture.native.openError=null;const c=window.homeFixture.snapshot().bindings.find(b=>b.id==='binding-2').conversation;c.capability='unavailable';c.unavailableReason='原生元信息已删除（fixture）';c.destinationLabel='入口不可用';document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await check('unavailable bound entry preserves native title and an enabled task-instruction fallback', `(()=>{const b=document.querySelectorAll('.my-home-task-row')[2].querySelector('.my-task-conversation-entry');return b.getAttribute('aria-disabled')!=='true'&&b.textContent.includes('Trellis 工作流')&&b.querySelector('.lucide-info')!==null})()`)
  await js(`window.homeFixture.unavailableBaseline=window.homeFixture.native.openRequests.length;document.querySelectorAll('.my-home-task-row')[2].querySelector('.my-task-conversation-entry').click()`); await settle()
  await check('unavailable source opens task instructions instead of trapping users in a disabled control', `document.querySelector('.my-task-continuation pre').textContent.includes('10-21-fixture-2')&&document.querySelector('.my-task-continuation').textContent.includes('原生元信息已删除')&&window.homeFixture.native.openRequests.length===window.homeFixture.unavailableBaseline`)
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
  await js(`(()=>{const f=window.homeFixture;f.scanHomeRoot=f.native.root;f.scanRoot='D:/automatic-history-fixture';const data=f.snapshotFor(f.scanRoot);const recovered={id:'history-recovered',taskDir:'10-21-fixture-3',taskRef:'task:fixture-3',currentTaskRef:'task:fixture-3',conversation:{...f.conversations[3],cwd:f.scanRoot,title:'自动找回的原生会话'},primary:true,linkedAt:f.stamp,origin:'runtime'};f.native.listPages.set(f.scanRoot,[{indexing:true},{indexing:true},{indexing:false,bindings:[...data.bindings,recovered]}]);f.native.holdNextList=true;f.switchRoot(f.scanRoot)})()`); await settle()
  await check('initial search reports source status while keeping task-instruction fallback enabled', `(()=>{const b=document.querySelectorAll('.my-task-conversation-entry')[3];return b.textContent.includes('查找原会话…')&&b.getAttribute('aria-disabled')!=='true'&&!document.querySelector('[role=dialog]')})()`)
  await js(`window.homeFixture.native.held.shift()()`); await settle()
  await check('indexing keeps bound and unbound task actions usable at exact geometry', `(()=>{const entries=[...document.querySelectorAll('.my-task-conversation-entry')];return entries.every(b=>b.getAttribute('aria-disabled')!=='true'&&b.getBoundingClientRect().width===220&&b.getBoundingClientRect().height===28)&&entries[3].textContent.includes('查找原会话…')&&!document.querySelector('[role=dialog]')})()`)
  await js(`window.homeFixture.scanDiscoverBaseline=window.homeFixture.native.calls.filter(c=>c.method==='discover').length;document.querySelectorAll('.my-task-conversation-entry')[3].click()`); await settle()
  await js(`[...document.querySelectorAll('.my-task-continuation button')].find(b=>b.textContent.includes('复制接续说明')).click()`); await settle()
  await check('historical indexing still permits preparing and copying selected-task instructions without a picker', `window.homeFixture.native.copied.at(-1).taskDir==='10-21-fixture-3'&&!('bindingId' in window.homeFixture.native.calls.filter(c=>c.method==='continue').at(-1).input)&&window.homeFixture.native.calls.filter(c=>c.method==='discover').length===window.homeFixture.scanDiscoverBaseline&&window.homeFixture.snapshot().indexing===true`)
  await key('Escape')
  await js(`(()=>{const f=window.homeFixture;const recovered={id:'history-recovered',taskDir:'10-21-fixture-3',taskRef:'task:fixture-3',currentTaskRef:'task:fixture-3',conversation:{...f.conversations[3],cwd:f.scanRoot,title:'自动找回的原生会话'},primary:true,linkedAt:f.stamp,origin:'runtime'};f.native.listPages.set(f.scanRoot,[{indexing:true},{indexing:false,bindings:[...f.snapshot().bindings,recovered]}]);f.scanBaseline=f.native.calls.filter(c=>c.method==='list').length})()`)
  await scanInterval()
  await check('indexing advances automatically before ordinary five-second refresh throttle', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.scanBaseline===1&&document.querySelectorAll('.my-task-conversation-entry')[3].textContent.includes('查找原会话…')`)
  await scanInterval()
  await check('subsequent scan batch automatically recovers native entry without manual association', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.scanBaseline===2&&document.querySelectorAll('.my-task-conversation-entry')[3].textContent.includes('自动找回的原生会话')&&document.querySelectorAll('.my-task-conversation-entry')[3].getAttribute('aria-disabled')!=='true'&&!document.querySelector('[role=dialog]')`)
  await scanInterval()
  await check('completed indexing false ends continuation instead of perpetual polling', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.scanBaseline===2`)
  await js(`(()=>{const f=window.homeFixture;f.snapshot().indexing=true;document.querySelector('[aria-label="刷新任务会话"]').click()})()`); await settle()
  await js(`window.homeFixture.native.holdOpen=true;document.querySelector('.my-task-conversation-entry').click()`); await settle()
  await js(`window.homeFixture.scanBaseline=window.homeFixture.native.calls.filter(c=>c.method==='list').length`)
  await scanInterval()
  await check('pending native continuation pauses historical reads while bound action remains one-click', `window.homeFixture.native.calls.filter(c=>c.method==='list').length===window.homeFixture.scanBaseline&&document.querySelector('.my-task-conversation-entry').getAttribute('aria-busy')==='true'&&window.homeFixture.native.calls.filter(c=>c.method==='continue').at(-1).input.bindingId==='binding-0'`)
  await js(`window.homeFixture.native.holdOpen=false;window.homeFixture.native.finishOpen()`); await settle()
  await js(`window.homeFixture.native.holdNextList=true`)
  await scanInterval()
  await js(`window.homeFixture.scanBaseline=window.homeFixture.native.calls.filter(c=>c.method==='list').length`)
  await scanInterval()
  await check('in-flight historical list prevents overlapping scan reads', `window.homeFixture.native.held.length===1&&window.homeFixture.native.calls.filter(c=>c.method==='list').length===window.homeFixture.scanBaseline`)
  await js(`(()=>{const f=window.homeFixture;f.native.listError='历史检索读取失败（fixture）';f.native.held.shift()();for(let i=0;i<20;i++)f.emitSnapshot();window.dispatchEvent(new Event('focus'))})()`); await settle()
  await scanInterval()
  await check('IPC scan error is visible and stops automatic retries', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.scanBaseline===1&&document.querySelector('.my-home-conversation-feedback[role=alert]').textContent.includes('历史检索读取失败')`)
  await js(`window.homeFixture.native.listError=null;window.homeFixture.emitSnapshot()`)
  await js('new Promise(resolve=>setTimeout(resolve,4200))')
  await check('snapshot notifications before or after failed scan cannot silently retry it', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.scanBaseline===1&&document.querySelector('.my-home-conversation-feedback[role=alert]')!==null`)
  await js(`window.homeFixture.native.listPages.set(window.homeFixture.native.root,[{indexing:true},{indexing:false}]);document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await scanInterval()
  await check('explicit manual refresh restarts indexing after IPC error', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.scanBaseline===3&&!document.querySelector('.my-home-conversation-feedback[role=alert]')`)
  await js(`window.homeFixture.snapshot().indexing=true;document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await js(`(()=>{const f=window.homeFixture;f.setVisible(false);f.configure({active:false});f.configure({active:true});f.scanBaseline=f.native.calls.filter(c=>c.method==='list').length;f.emitSnapshot();window.dispatchEvent(new Event('focus'))})()`); await settle()
  await scanInterval()
  await check('hidden document cancels scan timer and suppresses reactivation and notification reads', `document.visibilityState==='hidden'&&window.homeFixture.native.calls.filter(c=>c.method==='list').length===window.homeFixture.scanBaseline`)
  await js(`window.homeFixture.native.listPages.set(window.homeFixture.native.root,[{indexing:false}]);window.homeFixture.setVisible(true)`); await settle()
  await scanInterval()
  await check('document visibility restores unfinished scan automatically', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.scanBaseline===1&&window.homeFixture.snapshot().indexing===false`)
  await js(`window.homeFixture.snapshot().indexing=true;document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await js(`window.homeFixture.configure({active:false});window.homeFixture.scanBaseline=window.homeFixture.native.calls.filter(c=>c.method==='list').length`); await settle()
  await scanInterval()
  await check('inactive retained homepage cancels historical continuation', `window.homeFixture.native.calls.filter(c=>c.method==='list').length===window.homeFixture.scanBaseline`)
  await js(`window.homeFixture.native.listPages.set(window.homeFixture.native.root,[{indexing:false}]);window.homeFixture.configure({active:true})`); await settle()
  await check('reactivation resumes unfinished historical scan', `window.homeFixture.native.calls.filter(c=>c.method==='list').length-window.homeFixture.scanBaseline===1`)
  await js(`window.homeFixture.snapshot().indexing=true;document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await js(`window.homeFixture.switchRoot('D:/completed-history-fixture');window.homeFixture.scanBaseline=window.homeFixture.native.calls.filter(c=>c.method==='list').length`); await settle()
  await js(`window.homeFixture.scanBaseline=window.homeFixture.native.calls.filter(c=>c.method==='list').length`)
  await scanInterval()
  await check('project switch cancels old scan without polling completed new project', `window.homeFixture.native.calls.filter(c=>c.method==='list').length===window.homeFixture.scanBaseline&&document.querySelectorAll('.my-task-conversation-entry')[3].textContent.includes('接续此任务')`)
  await js(`window.homeFixture.native.holdNextList=true;window.homeFixture.switchRoot(window.homeFixture.scanRoot)`); await settle()
  await js(`(()=>{const f=window.homeFixture;f.switchRoot('D:/completed-history-fixture');delete f.snapshotFor(f.scanRoot).indexing;f.switchRoot(f.scanRoot)})()`); await settle()
  await js(`window.homeFixture.native.held.shift()();window.homeFixture.scanBaseline=window.homeFixture.native.calls.filter(c=>c.method==='list').length`); await settle()
  await scanInterval()
  await check('stale same-root indexing result cannot restart completed new owner scan', `window.homeFixture.native.calls.filter(c=>c.method==='list').length===window.homeFixture.scanBaseline&&document.querySelectorAll('.my-task-conversation-entry')[3].textContent.includes('自动找回的原生会话')`)
  await js(`window.homeFixture.switchRoot(window.homeFixture.scanHomeRoot)`); await settle()
  for (const theme of ['light', 'dark']) {
    await js(`window.homeFixture.configure(${JSON.stringify({ theme, size: 'standard', runtimePreview: true })});document.querySelector('.acp-runtime-trigger').click()`); await settle()
    await readBrandAssets('runtime-picker-' + theme)
    await check(theme + ' runtime picker and management use actual brands without alphabet badges or vendor guesses', `(()=>{const trigger=document.querySelector('.acp-runtime-trigger'),options=[...document.querySelectorAll('.acp-runtime-option')],marks=[...document.querySelectorAll('.acp-runtime-mark')],unknown=[...document.querySelectorAll('[data-unknown-brands] .acp-runtime-mark')],panel=[...document.querySelectorAll('.acp-engine-panel [data-tool-brand]')],semantic=document.querySelector('[data-unknown-brands] .my-task-conversation-entry__icon');return trigger.querySelector('[data-tool-brand]').dataset.toolBrand==='codex'&&options.map(option=>option.querySelector('[data-tool-brand]').dataset.toolBrand).join('|')==='codex|claude-code|zcode|unknown'&&panel.map(mark=>mark.dataset.toolBrand).join('|')==='codex|claude-code|zcode|unknown'&&unknown.length===2&&unknown.every(mark=>mark.dataset.toolBrand==='unknown'&&Boolean(mark.querySelector('svg'))&&!mark.textContent.trim())&&marks.every(mark=>!mark.textContent.trim()&&mark.getBoundingClientRect().width===16&&getComputedStyle(mark).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(mark).borderRadius==='0px'&&getComputedStyle(mark).lineHeight==='0px')&&Boolean(semantic.querySelector('svg'))&&!semantic.querySelector('[data-tool-brand]')})()`)
    await capture('runtime-picker-' + theme)
    await key('Escape')
    await js('window.homeFixture.configure({runtimePreview:false})'); await settle()
  }
  window.setContentSize(640, 840); await settle()
  await check('narrow viewport keeps one-line equal-width entries and local horizontal access', `(()=>{const list=document.querySelector('.my-home-task-rows'),rows=[...document.querySelectorAll('.my-home-task-row')];return list.scrollWidth>list.clientWidth&&['auto','scroll'].includes(getComputedStyle(list).overflowX)&&rows.every(r=>r.querySelector('.my-task-conversation-entry').getBoundingClientRect().width===220&&getComputedStyle(r.querySelector('.my-home-task-title')).whiteSpace==='nowrap')&&document.documentElement.scrollWidth<=innerWidth})()`)
  await js(`document.querySelector('.my-home-task-rows').scrollLeft=300;document.querySelectorAll('.my-home-task-row')[2].querySelector('.my-task-conversation-entry').focus()`); await settle()
  await check('narrow full-title tooltip clamped to viewport without focus theft', `(()=>{const t=document.querySelector('[role=tooltip]');if(!t)return 'no tooltip';const r=t.getBoundingClientRect();return r.left>=8&&r.right<=innerWidth-8&&r.top>=8&&r.bottom<=innerHeight-8&&document.activeElement.classList.contains('my-task-conversation-entry')})()`)
  await capture('homepage-narrow-tooltip')
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await settle()
  await js(`document.activeElement?.blur();document.querySelectorAll('.my-home-task-row')[2].querySelector('.my-task-conversation-entry').focus()`); await settle()
  await check('reduced motion suppresses floating animation', `getComputedStyle(document.querySelector('[role=tooltip]')).animationName==='none'`)
  await key('Escape'); await js(`document.querySelector('.my-home-task-rows').scrollLeft=0`); await settle(); await capture('homepage-narrow')
  await js(`window.homeFixture.snapshot().indexing=true;document.querySelector('[aria-label="刷新任务会话"]').click()`); await settle()
  await js(`window.homeFixture.unmount();window.homeFixture.scanBaseline=window.homeFixture.native.calls.filter(c=>c.method==='list').length`); await settle()
  await scanInterval()
  await check('unmount removes listeners, Escape layers and pending scan timer', `window.homeFixture.native.subscribers.size===0&&window.homeFixture.escLayerCount()===0&&window.homeFixture.native.calls.filter(c=>c.method==='list').length===window.homeFixture.scanBaseline`)
  assert.deepEqual(errors, [], 'renderer errors')
  writeFileSync(join(output, 'report.json'), JSON.stringify({ result: 'passed', checks, screenshots, captureMetrics, renderedBrandAssets, limitations: ['Isolated Electron renders production homepage, hook, modal, RuntimePicker and RuntimePanel against fixture API results.', 'No real Codex/Claude Code/ZCode launch or desktop-window acceptance is claimed.'] }, null, 2))
  console.log('REPORT ' + join(output, 'report.json'))
  app.exit(0)
}

try {
  writeFileSync(join(directory, 'entry.tsx'), fixture)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [absolute('node_modules')], alias: { '@shared': absolute('src/shared') }, loader: { '.svg': 'file', '.png': 'file' }, assetNames: 'assets/[name]-[hash]' })
  const cssFiles = ['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'my/my-utilities.css', 'my/my-dashboard.css', 'my/task-conversation-entry.css', 'acp/workspace.css', 'styles.css']
  const css = (await postcss([tailwind(tailwindConfig)]).process(cssFiles.map((file) => readFileSync(sourceRoot + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>${css}html,body,#root{height:100%;margin:0;overflow:hidden}.fixture-host{height:100%;max-width:1320px;margin-inline:auto}@media(max-width:800px){.fixture-host{width:100%}}</style></head><body><div id="root"></div><script>${bootstrap}</script><script src="renderer.js"></script></body></html>`)
  writeFileSync(join(directory, 'main.cjs'), `(${electronChecks.toString()})().catch(error=>{console.error(error);require('electron').app.exit(1)});setTimeout(()=>{console.error('task conversation UI timed out');require('electron').app.exit(1)},140000)`)
  const require = createRequire(import.meta.url)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(require('electron'), [join(directory, 'main.cjs'), output, '--no-sandbox'], { env, windowsHide: true, timeout: 150000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
  console.log('Task conversation UI evidence: ' + output)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
}
