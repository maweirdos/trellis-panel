/** Actual Console/ReactDOM/CSS with delayed Electron IPC; no provider or network. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Script } from 'node:vm'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import tailwindConfig from '../../tailwind.config.js'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-acp-turn-status-'))
const absolute = (path) => resolve(path).replace(/\\/g, '/')
const captureDirectory = process.env.TPANEL_ACP_TURN_STATUS_CAPTURE_DIR ? resolve(process.env.TPANEL_ACP_TURN_STATUS_CAPTURE_DIR) : null
const visualMode = process.env.TPANEL_ACP_CHAT_VISUAL === '1'
if (captureDirectory) mkdirSync(captureDirectory, { recursive: true })

const rootA = 'D:/turn-status-dom', rootB = 'D:/turn-status-other'
const event = (id, kind, turnId, extra = {}) => ({ id, kind, turnId, ts: 100, source: 'acp', sessionId: 'a', projectRoot: rootA, connectionGeneration: 'gen-a', ...extra })
const oldEvents = [
  event('old-question', 'message', 'old', { text: 'Recorded question', payload: { role: 'user' } }),
  event('old-answer', 'message', 'old', { text: Array.from({ length: 45 }, (_, i) => `Recorded paragraph ${i + 1}.`).join('\n\n'), payload: { role: 'assistant' } }),
  event('old-done', 'turn-done', 'old', { payload: { result: { status: 'completed' } } })
]
const record = (sessionId, patch = {}) => ({ sessionId, projectRoot: rootA, title: sessionId, agentId: 'codex', agentName: 'Codex', startedAt: 10, status: 'ready', connectionGeneration: `gen-${sessionId}`, pendingPermissions: [], events: [], ...patch })
const records = [record('a', { turnId: 'old', events: oldEvents }), record('empty'), record('history', { turnId: 'history-turn', events: [
  event('history-thought', 'thought', 'history-turn', { sessionId: 'history', connectionGeneration: 'gen-history', text: 'Recorded thought' }),
  event('history-tool', 'tool-call', 'history-turn', { sessionId: 'history', connectionGeneration: 'gen-history', text: 'Read fixture', payload: { toolCallId: 'history-tool', kind: 'read', status: 'pending' } }),
  event('history-answer', 'message', 'history-turn', { sessionId: 'history', connectionGeneration: 'gen-history', text: 'Recorded answer', payload: { role: 'assistant' } }),
  event('history-done', 'turn-done', 'history-turn', { sessionId: 'history', connectionGeneration: 'gen-history' })
] }), record('b', { projectRoot: rootB })]

try {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{AcpConsolePage}from'${absolute('src/renderer/src/pages/AcpConsole.tsx')}';
import{InteractionScope}from'${absolute('src/renderer/src/utils/interaction-scope.tsx')}';
import{useApp}from'${absolute('src/renderer/src/store/index.ts')}';
const off=()=>()=>{};
globalThis.__turnApi={
  knowledgeAccess:{source:async input=>({ok:true,data:{id:input.sourceId,sourceHandle:input.sourceId,title:({'visual-rule':'HIS 业务规则与状态权限总册','visual-nurse':'住院护士工作站手册','visual-doctor':'门诊医生工作站手册'})[input.sourceId],text:'# 皮试医嘱业务规则\\n\\n此为隔离验收资料，不连接生产知识库。',contentHash:'fixture',kind:'weknora',documentId:input.sourceId,collectionId:'fixture',relativePath:null,instanceId:'https://synthetic.invalid',fetchedAt:1,mode:'excerpt',truncated:true,sessionId:input.sessionId,turnId:'visual-turn',scopeRevision:'fixture',suppliedToAgent:true,historical:false}})},
  acpAgents:async()=>({ok:true,agents:[{id:'codex',runtimeId:'codex',name:'Codex',enabled:true,available:true}]}),acpProfiles:async()=>({ok:true,profiles:[{id:'role',name:'Fixture role',runtimeId:'codex',instructions:'',maxTurnMinutes:30}]}),acpSessionNew:()=>window.bridge.create(),
  acpSessions:()=>window.bridge.sessions(),acpSessionPrompt:(...args)=>window.bridge.prompt(...args),
  acpSessionCancel:async()=>({ok:false,error:'fixture cancel acknowledgement pending'}),
  onAcpOutput:callback=>window.bridge.on('output',callback),onAcpState:callback=>window.bridge.on('state',callback),onAcpDone:callback=>window.bridge.on('done',callback),onMaterialUpdated:off
};
function Fixture(){const[settings,setSettings]=useState(false),[mounted,setMounted]=useState(true),[theme,setTheme]=useState('light');
window.fixtureSet={settings:setSettings,mounted:setMounted,theme:setTheme,root:root=>useApp.setState({snapshot:{meta:{root},tasks:[]}})};
return <div className="my-root text-my-md text-my-primary" data-my-theme={${visualMode ? "'dark'" : 'theme'}} data-my-font-size="standard">{${visualMode}&&<nav aria-label="隔离验收状态" className="border-b border-my-line bg-my-layer-1 text-my-primary" style={{height:44,display:'flex',alignItems:'center',gap:16,paddingInline:16}}><strong>隔离验收 · 无真实查询</strong>{['检索中','等待模型','回答完成'].map((label,index)=><button key={label} type="button" onClick={()=>window.bridge.visual(index)}>{label}</button>)}</nav>}<div hidden={settings} aria-hidden={settings||undefined} ref={node=>{if(node)node.inert=settings}} style={{height:${visualMode ? "'calc(100% - 44px)'" : "'100%'"}}}><InteractionScope active={!settings}>{mounted&&<AcpConsolePage/>}</InteractionScope></div>{settings&&<section aria-label="Settings fixture"><input id="settings-focus"/></section>}</div>}
createRoot(document.getElementById('root')).render(<Fixture/>);
const status=()=>document.querySelector('[role="status"][aria-label="当前回合状态"]');
const field=()=>document.querySelector('[aria-label="Agent 指令"]');
const stream=()=>document.querySelector('.acp-transcript');
window.fixture={
  select:id=>document.querySelector('[data-acp-session="'+id+'"]').click(),
  create:()=>document.querySelector('.acp-navigation-primary button').click(),
  start:()=>[...document.querySelectorAll('button')].find(node=>node.textContent==='创建新会话').click(),
  draft:text=>{const node=field();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,text);node.dispatchEvent(new Event('input',{bubbles:true}))},
  submit:()=>document.querySelector('[title="发送指令"]')?.click(),
  enter:()=>field().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true})),
  scroll:top=>{const node=stream();node.scrollTop=top==='bottom'?node.scrollHeight:top;node.dispatchEvent(new Event('scroll',{bubbles:true}))},
  snapshot:()=>{const node=status(),body=document.querySelector('.acp-transcript-content'),scroller=stream();return{
    count:document.querySelectorAll('[role="status"][aria-label="当前回合状态"]').length,phase:node?.dataset.phase??null,text:node?.textContent??'',visible:node?.checkVisibility()??false,
    runningAnimations:node?node.getAnimations({subtree:true}).filter(animation=>animation.playState==='running').length:0,
    tail:!!node&&body?.lastElementChild===node,rows:[...document.querySelectorAll('[data-acp-item]')].map(row=>row.dataset.acpItem),
    invitation:!!document.querySelector('.acp-empty'),draft:field()?.value??null,sendDisabled:document.querySelector('[title="发送指令"]')?.disabled??true,
    sessionStatus:document.querySelector('.acp-session-status')?.textContent??'',scrollTop:scroller?.scrollTop??0,scrollHeight:scroller?.scrollHeight??0,clientHeight:scroller?.clientHeight??0,
    transcriptAnimations:body?body.getAnimations({subtree:true}).filter(animation=>animation.playState==='running').length:0,
    settingsFocus:document.activeElement?.id==='settings-focus'
    ,composerFocus:document.activeElement===field(),visibleSpinners:[...document.querySelectorAll('.acp-transcript .acp-progress-spinner,.acp-transcript .animate-spin')].filter(node=>node.checkVisibility()).length
  }}
};`)
  const storeSource = `import{create}from'${absolute('node_modules/zustand/esm/index.mjs')}';export const useApp=create(set=>({snapshot:{meta:{root:${JSON.stringify(rootA)}} ,tasks:[]},page:'acp',pushToast(){},setPage:page=>set({page}),showTask(){},openArtifact(){}}));`
  const mySource = `import{create}from'${absolute('node_modules/zustand/esm/index.mjs')}';export const useMy=create(set=>({sidebarWidth:275,sidebarCollapsed:false,fontSize:'standard',setSidebarWidth:sidebarWidth=>set({sidebarWidth}),toggleSidebar:()=>set(s=>({sidebarCollapsed:!s.sidebarCollapsed})),requestAgentView:agentTarget=>set({agentTarget}),setAgentSessionTarget:agentSessionTarget=>set({agentSessionTarget}),setSettingsView(){}}));`
  await build({ entryPoints: [entry], outfile: join(directory, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [absolute('node_modules')], define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'turn-fixture-host', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => {
      const path = absolute(resolve(dirname(args.importer || entry), args.path))
      if (path === absolute('src/renderer/src/api')) return { path: 'api', namespace: 'fixture' }
      if ([absolute('src/renderer/src/store'), absolute('src/renderer/src/store/index.ts')].includes(path)) return { path: 'store', namespace: 'fixture' }
      if ([absolute('src/renderer/src/my/store'), absolute('src/renderer/src/my/store.ts')].includes(path)) return { path: 'my', namespace: 'fixture' }
      if (args.path.endsWith('.css')) return { path: 'style', namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ loader: 'tsx', resolveDir: process.cwd(), contents: args.path === 'store' ? storeSource : args.path === 'my' ? mySource : args.path === 'api' ? 'export const hasIpc=true;export const api=new Proxy({},{get:(_target,key)=>globalThis.__turnApi?.[key]});' : '' }))
  } }] })
  const css = (await postcss([tailwind(tailwindConfig)]).process(['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'styles.css', 'acp/workspace.css'].map((file) => readFileSync('src/renderer/src/' + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>${css}\nhtml,body,#root,.my-root{height:100%;margin:0}[hidden]{display:none!important}.acp-transcript{overflow-anchor:none}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  writeFileSync(join(directory, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('bridge',{
sessions:()=>ipcRenderer.invoke('turn-fixture:sessions'),prompt:(...args)=>ipcRenderer.invoke('turn-fixture:prompt',args),create:()=>ipcRenderer.invoke('turn-fixture:new'),visual:stage=>ipcRenderer.invoke('turn-fixture:visual',stage),
on:(name,callback)=>{const listener=(_event,payload)=>callback(payload);ipcRenderer.on('turn-fixture:'+name,listener);return()=>ipcRenderer.removeListener('turn-fixture:'+name,listener)}
});`)
  writeFileSync(join(directory, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const assert=require('node:assert/strict');const{writeFileSync}=require('node:fs');const{join}=require('node:path');
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.disableHardwareAcceleration();
const rootA=${JSON.stringify(rootA)},rootB=${JSON.stringify(rootB)},records=${JSON.stringify(records)},originalRecords=JSON.stringify(records),pending=[],prompts=[],creates=[];
ipcMain.handle('turn-fixture:sessions',()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true,sessions:structuredClone(records)}),30)));
ipcMain.handle('turn-fixture:prompt',(_event,args)=>{prompts.push(args);return new Promise((resolve,reject)=>pending.push({resolve,reject}))});
ipcMain.handle('turn-fixture:new',()=>new Promise(resolve=>creates.push(resolve)));
if(${visualMode})records.splice(0,records.length,{...records[0],title:'项目知识对话验收',events:[],turnId:undefined});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:${visualMode},title:'Trellis Synthetic Knowledge UI Acceptance',width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,preload:${JSON.stringify(join(directory, 'preload.cjs'))}}});
w.webContents.on('console-message',event=>{if(event.level==='error'||event.level>=3)console.error(event.message)});w.webContents.on('render-process-gone',(_event,details)=>{console.error(details);app.exit(1)});
await w.loadFile(${JSON.stringify(join(directory, 'index.html'))});
const run=source=>w.webContents.executeJavaScript(source).catch(error=>{console.error('Renderer call: '+source);throw error}),pause=()=>new Promise(resolve=>setTimeout(resolve,25)),snapshot=()=>run('window.fixture.snapshot()');
const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(await predicate())return;await pause()}throw Error('timeout '+label+' '+JSON.stringify(await snapshot()))};
const check=(name)=>console.log('PASS '+name),select=async id=>{await wait(()=>run('!!document.querySelector('+JSON.stringify('[data-acp-session="'+id+'"]')+')'),'session '+id);await run('window.fixture.select('+JSON.stringify(id)+')');await wait(()=>run('!!document.querySelector("textarea")'),'composer');await pause()};
const draft=async text=>{await run('window.fixture.draft('+JSON.stringify(text)+')');await wait(async()=>(await snapshot()).draft===text,'draft update')};
const submit=async text=>{await draft(text);await run('window.fixture.submit()');await wait(()=>pending.length===1,'delayed real prompt IPC')};
const release=async(reply,throws=false)=>{assert.equal(pending.length,1);const request=pending.shift();if(throws)request.reject(new Error(reply));else request.resolve(reply);await pause()};
const fact=(id,kind,turnId,extra={})=>({id,kind,turnId,ts:200,source:'acp',sessionId:'a',projectRoot:rootA,connectionGeneration:'gen-a',...extra});
let revision=10;
const state=async(status,turnId,extra={})=>{const index=records.findIndex(s=>s.sessionId==='a');const session={...records[index],status,turnId,stateRevision:++revision,...extra};records[index]=session;w.webContents.send('turn-fixture:state',{sessionId:'a',projectRoot:rootA,connectionGeneration:'gen-a',status,turnId,stateRevision:session.stateRevision,session});await pause()};
const output=async event=>{if(event.projectRoot===rootA&&event.sessionId==='a'&&event.connectionGeneration==='gen-a')records[0].events.push(event);w.webContents.send('turn-fixture:output',event);await pause()};
const phase=async expected=>wait(async()=>(await snapshot()).phase===expected,'phase '+expected);
const tail=async expected=>{await phase(expected);const s=await snapshot();assert.equal(s.count,1);assert.equal(s.visible,true);assert.equal(s.tail,true,'current status is the actual final body row');return s};
const quiet=async expected=>{await pause();assert.equal((await snapshot()).phase,expected,'silence retains current-turn feedback')};
// Hidden windows may return the previous compositor frame on their first
// capture. Flush it, then save the painted state already verified in the DOM.
const capture=async name=>{const destination=${JSON.stringify(captureDirectory)};if(!destination)return;await w.webContents.capturePage();await pause();writeFileSync(join(destination,name+'.png'),(await w.webContents.capturePage()).toPNG())};

if(${visualMode}){
await wait(()=>run('!!window.fixture'),'fixture boot');await select('a');
const stages=[],visualEvent=(id,kind,extra={})=>fact('visual-'+id,kind,'visual-turn',extra);
let previous=-1;
const advance=async stage=>{if(stage<previous){stages.length=0;previous=-1;records[0].events=[];await run('window.fixtureSet.mounted(false)');await pause();await run('window.fixtureSet.mounted(true)');await select('a')}
if(previous<0){await state('busy','visual-turn');await output(visualEvent('start','session-status',{payload:{activityScope:'turn',observation:{label:'开始处理',atMs:1}}}));await output(visualEvent('question','message',{text:'皮试医嘱的业务流程是什么',payload:{role:'user',delivery:'preparing'}}));await output(visualEvent('search','diagnostic',{payload:{activityScope:'turn',knowledgeOperation:{operationId:'visual-search',kind:'search',phase:'running',query:'皮试医嘱的业务流程是什么',detail:'实际隔离验收知识检索'}}}));previous=0}
if(stage>=1&&previous<1){await output(visualEvent('search-done','diagnostic',{payload:{activityScope:'turn',knowledgeOperation:{operationId:'visual-search',kind:'search',phase:'completed',query:'皮试医嘱的业务流程是什么',status:'ok',persistence:'durable',sourceIds:['visual-rule','visual-nurse','visual-doctor'],detail:'已检索本地与项目远端范围'}}}));await output(visualEvent('sent','diagnostic',{payload:{activityScope:'turn',promptDelivery:{state:'sent'}}}));previous=1}
if(stage>=2&&previous<2){await output(visualEvent('answer','message',{text:'## 皮试医嘱业务流程\\n\\n依据项目资料，先开立医嘱，再执行皮试、录入结果，最后在医生站与护士站回显状态。\\n\\n这是界面验收用的隔离回答，未访问生产知识库。',payload:{role:'assistant'}}));await output(visualEvent('done','turn-done',{payload:{result:{status:'completed'}}}));await state('ready','visual-turn');previous=2}
return true};
ipcMain.handle('turn-fixture:visual',(_event,stage)=>advance(stage));await advance(0);console.log('VISUAL_FIXTURE_READY '+${JSON.stringify(directory)});w.on('closed',()=>app.quit());return}

await wait(()=>run('!!window.fixture'),'fixture boot');await select('a');assert.equal((await snapshot()).count,0);
await run('window.fixture.scroll("bottom")');await pause();const before=await snapshot();assert.ok(before.scrollHeight>before.clientHeight+100,'fixture really has scrollable recorded history');
await submit('first delayed prompt');let s=await tail('submitting');assert.deepEqual(s.rows,before.rows);assert.equal(JSON.stringify(records),originalRecords,'local submission never writes a synthetic saved event');
await wait(async()=>{const s=await snapshot();return s.scrollTop+s.clientHeight>=s.scrollHeight-2},'indicator-only bottom follow');
check('delayed real IPC shows one body-tail status before any state/output and follows the bottom without saved events');

await run('window.fixtureSet.settings(true)');await pause();s=await snapshot();assert.equal(s.count,0);assert.equal(s.transcriptAnimations,0);await run('document.querySelector("#settings-focus").focus()');
await quiet(null);await run('window.fixtureSet.settings(false)');await tail('submitting');
await run('window.fixtureSet.settings(true)');await pause();await run('document.querySelector("#settings-focus").focus()');await release({ok:true,turnId:'one'});s=await snapshot();assert.equal(s.count,0);assert.equal(s.transcriptAnimations,0);assert.equal(s.settingsFocus,true,'source does not steal destination focus');
await run('window.fixtureSet.settings(false)');await tail('waiting');
await draft('next draft');await run('window.fixture.enter();window.fixture.submit()');await pause();assert.equal(prompts.length,1);assert.equal(pending.length,0);assert.equal((await snapshot()).draft,'next draft');
check('retained Settings hides animation without forgetting pending data; hidden ACK returns to waiting and blocks duplicate submit');

await state('busy','one');await tail('waiting');
await output(fact('transport-start','session-status','one',{payload:{activityScope:'turn',observation:{label:'开始处理',atMs:1}}}));
await output(fact('question-one','message','one',{text:'普通业务问题',payload:{role:'user',delivery:'preparing'}}));
await tail('processing');assert.ok(!await run('document.querySelector(".acp-transcript").innerText.includes("等待模型回复")'),'host admission is not native delivery');
await output(fact('preflight-running','diagnostic','one',{payload:{activityScope:'turn',knowledgeOperation:{operationId:'preflight',kind:'search',phase:'running',query:'普通业务问题',detail:'正在检索项目知识库'}}}));
s=await tail('knowledge');assert.equal(s.visibleSpinners,1);assert.ok(!await run('document.querySelector(".acp-transcript").innerText.includes("开始处理")'));assert.ok(!await run('document.querySelector(".acp-transcript").innerText.includes("等待模型回复")'));assert.equal(await run('document.querySelector("[data-acp-item=question-one]").innerText'),'普通业务问题');
await capture('project-lookup-current');
await output(fact('preflight-completed','diagnostic','one',{payload:{activityScope:'turn',knowledgeOperation:{operationId:'preflight',kind:'search',phase:'completed',query:'普通业务问题',detail:'本次查无相关来源',status:'empty',sourceIds:[]}}}));
await tail('processing');assert.ok(!await run('document.querySelector(".acp-transcript").innerText.includes("等待模型回复")'),'lookup completion alone is not native delivery');
await output(fact('transport-sent','session-status','one',{payload:{activityScope:'turn',observation:{label:'指令已发送至引擎',atMs:2}}}));
s=await tail('waiting');assert.equal(s.visibleSpinners,1);assert.ok(!await run('document.querySelector(".acp-transcript").innerText.includes("指令已发送至引擎")'));
check('question precedes a single real preflight status; completion transitions to model waiting without preparing or transport scaffolding');
for(const theme of ['light','dark']){await run('window.fixtureSet.theme('+JSON.stringify(theme)+')');await pause();await tail('waiting');await capture('current-turn-waiting-'+theme)}
w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await pause();s=await tail('waiting');assert.equal(s.runningAnimations,0,'reduced motion keeps the status readable without animation');await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});w.webContents.debugger.detach();
for(const change of [{sessionId:'other'},{connectionGeneration:'stale'},{projectRoot:rootB},{turnId:'old'}]){
await output({...fact('foreign-thought','thought','one',{text:'Foreign thought'}),...change});await tail('waiting');
await output({...fact('foreign-done','turn-done','one'),...change});await tail('waiting')}
const statusBefore=(await snapshot()).sessionStatus;
w.webContents.send('turn-fixture:done',{sessionId:'a',projectRoot:rootA,connectionGeneration:'gen-a',turnId:'old',status:'ready',session:{...records[0],turnId:'old',status:'ready'}});await pause();await tail('waiting');assert.equal((await snapshot()).sessionStatus,statusBefore,'previous-turn done cannot overwrite current busy metadata');
check('busy before the first token and foreign/stale completion cannot remove or relabel the owned current status');

await output(fact('thought','thought','one',{text:'Already received thought'}));await tail('thinking');await quiet('thinking');
await output(fact('tool','tool-call','one',{text:'Search project',payload:{toolCallId:'search',kind:'search',status:'in_progress'}}));s=await tail('tool');assert.equal(s.visibleSpinners,1);await quiet('tool');
await output(fact('tool-completed','tool-call','one',{payload:{toolCallId:'search',status:'completed'}}));await tail('processing');await quiet('processing');
await output(fact('tool-output','tool-call','one',{payload:{toolCallId:'search',content:[{type:'content',content:{type:'text',text:'Actual saved tool result'}}]}}));await tail('processing');
await output(fact('answer','message','one',{text:'Actual assistant body',payload:{role:'assistant'}}));await tail('replying');await quiet('replying');
const rowOrder=(await snapshot()).rows;assert.ok(rowOrder.indexOf('thought')<rowOrder.indexOf('tool')&&rowOrder.indexOf('tool')<rowOrder.indexOf('answer'),'recorded thought/tool/answer keep chronology');
check('thought, silence, tool completion, partial output, silence and assistant body retain one continuous final status');

const permission={requestId:'permission-one',sessionId:'a',connectionGeneration:'gen-a',turnId:'one',agentName:'Codex',toolCall:{title:'Read protected fixture'},options:[{optionId:'allow',kind:'allow_once',name:'Allow once'}]};
await state('awaiting_permission','one',{pendingPermissions:[permission]});s=await tail('permission');assert.equal(s.runningAnimations,0);assert.match(s.text,/授权/);await quiet('permission');
await state('cancelling','one',{pendingPermissions:[]});s=await tail('cancelling');assert.match(s.text,/停止/);
await state('busy','one');await output(fact('done-one','turn-done','one',{payload:{result:{status:'completed'}}}));await phase(null);assert.equal((await snapshot()).count,0);assert.equal(records[0].status,'busy');
check('authorization is static, cancelling is truthful, and exact terminal output stops before busy metadata catches up');

await state('ready','one');await run('window.fixture.scroll(40)');await pause();assert.ok((await snapshot()).scrollTop+200<(await snapshot()).scrollHeight);
await submit('reader up');await tail('submitting');await wait(async()=>{const s=await snapshot();return s.scrollTop+s.clientHeight>=s.scrollHeight-2},'explicit Send opts back into latest');
await run('window.fixture.scroll(40)');await pause();const readerTop=(await snapshot()).scrollTop;
await release({ok:true,turnId:'reader-turn'});await tail('waiting');assert.equal((await snapshot()).scrollTop,readerTop,'passive ACK respects a manual scroll after Send');
await output(fact('reader-thought','thought','reader-turn',{text:'Already received next thought'}));await tail('thinking');assert.equal((await snapshot()).scrollTop,readerTop,'passive phase changes do not pull the reader down');
await state('busy','reader-turn');await output(fact('reader-done','turn-done','reader-turn'));await state('ready','reader-turn');await phase(null);
await submit('rejection retains draft');await tail('submitting');await release({ok:false,error:'fixture refused'});await phase(null);assert.equal((await snapshot()).draft,'rejection retains draft');
await submit('throw retains draft');await tail('submitting');await release('fixture IPC failure',true);await phase(null);assert.equal((await snapshot()).draft,'throw retains draft');
check('Send opts into latest; subsequent manual reader-up survives passive phases; rejected/thrown IPC retain drafts');

await select('empty');await submit('empty draft');s=await tail('submitting');assert.equal(s.invitation,false,'pending submission hides the empty invitation');
await select('history');assert.equal((await snapshot()).count,0);assert.equal((await snapshot()).transcriptAnimations,0);assert.ok(await run('document.querySelector("[data-acp-item=history-tool]").textContent.includes("文件读取未完成")'),'incomplete historical tool is static and never relabelled successful');await select('empty');await tail('submitting');
await release({ok:false,error:'empty fixture refused'});await phase(null);assert.equal((await snapshot()).draft,'empty draft');
check('empty pending hides invitation; selecting completed history is static and returning preserves the exact pending owner');

await select('a');await submit('fast turn');await state('busy','fast');await output(fact('fast-done','turn-done','fast'));await phase(null);await release({ok:true,turnId:'fast'});await phase(null);assert.equal((await snapshot()).count,0);
check('terminal before delayed ACK does not resurrect the completed turn');

await state('busy','real-reopen');await tail('waiting');await run('window.fixtureSet.mounted(false)');await pause();await run('window.fixtureSet.mounted(true)');await select('a');await tail('waiting');
await output(fact('reopen-done','turn-done','real-reopen'));await state('ready','real-reopen');await phase(null);await run('window.fixtureSet.mounted(false)');await pause();await run('window.fixtureSet.mounted(true)');await select('a');assert.equal((await snapshot()).count,0);assert.equal((await snapshot()).transcriptAnimations,0);
check('cold component reopen restores actual busy only; completed saved history remains static');

await submit('old root request');await tail('submitting');await run('window.fixtureSet.root('+JSON.stringify(rootB)+')');await select('b');await release({ok:true,turnId:'foreign-ack'});assert.equal((await snapshot()).count,0);
await output(fact('old-root-thought','thought','foreign-ack',{text:'Old root'}));assert.equal((await snapshot()).count,0);assert.equal((await snapshot()).draft,'');assert.equal(prompts.length,7,'no draft is automatically resubmitted by selection, Settings, reopen or root changes');
check('root replacement rejects stale ACK/output without inheriting a marker or auto-sending a draft');

await run('window.fixtureSet.root('+JSON.stringify(rootA)+')');await select('a');
const beginNew=async()=>{await run('window.fixture.create()');await wait(()=>run('!!document.querySelector(".acp-new-conversation")'),'real chooser mount');await run('window.fixture.start()');await wait(()=>creates.length===1,'new session IPC')};
const releaseNew=async(id,status='starting')=>{const session={...records[0],sessionId:id,title:id,connectionGeneration:'gen-'+id,status,turnId:undefined,events:[]};records.push(session);creates.shift()({ok:true,sessionId:id});await wait(()=>run('document.querySelector(".acp-header-identity").textContent==='+JSON.stringify(id)),'selected new conversation');await pause();return session};
const readyNew=async session=>{session.status='ready';w.webContents.send('turn-fixture:state',{projectRoot:rootA,sessionId:session.sessionId,connectionGeneration:session.connectionGeneration,status:'ready',session});await pause()};
await beginNew();const firstNew=await releaseNew('new-delayed');assert.equal((await snapshot()).composerFocus,false,'not ready is not focusable admission');await readyNew(firstNew);await wait(async()=>(await snapshot()).composerFocus,'autofocus after delayed ready and chooser close');assert.equal((await snapshot()).draft,'');assert.equal(prompts.length,7,'focus never submits');
await run('document.querySelector(".acp-header-task").focus()');await readyNew(firstNew);assert.equal((await snapshot()).composerFocus,false,'ready repeats never steal focus');
await run('window.fixtureSet.mounted(false)');await pause();await run('window.fixtureSet.mounted(true)');await wait(()=>run('!!document.querySelector("textarea")'),'explicit empty conversation survives remount');assert.equal(await run('document.querySelector(".acp-header-identity").textContent'),'new-delayed');assert.equal((await snapshot()).composerFocus,false,'restoring is not new-session focus');
check('actual chooser closes into new empty conversation; delayed ready focuses once and remount keeps selection without stealing focus');

await beginNew();await releaseNew('new-already-ready','ready');await wait(async()=>(await snapshot()).composerFocus,'already-ready creation focuses after chooser restoration');
check('already-ready creation wins the chooser return-focus race without another click');

await beginNew();const hiddenNew=await releaseNew('new-hidden');await run('window.fixtureSet.settings(true)');await pause();await run('document.querySelector("#settings-focus").focus()');await readyNew(hiddenNew);assert.equal((await snapshot()).settingsFocus,true);await run('window.fixtureSet.settings(false)');await pause();assert.equal((await snapshot()).composerFocus,false,'returning cannot revive hidden creation intent');
await beginNew();const navigated=await releaseNew('new-navigation');await select('a');await readyNew(navigated);assert.equal((await snapshot()).composerFocus,false,'late ready cannot focus another session');
check('Settings suspension and selection replacement permanently cancel pending new-session autofocus');
console.log('ACP_TURN_STATUS_PASSED');app.exit(0)}).catch(error=>{console.error(error.stack);app.exit(1)});if(!${visualMode})setTimeout(()=>{console.error('ACP turn status host timed out');app.exit(1)},40000);`)
  new Script(readFileSync(join(directory, 'main.cjs'), 'utf8'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (visualMode) console.log('Launching isolated production-component UI: Trellis Synthetic Knowledge UI Acceptance')
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [join(directory, 'main.cjs'), '--no-sandbox'], { env, windowsHide: !visualMode, timeout: visualMode ? 0 : 45000, maxBuffer: 2 * 1024 * 1024 })
  process.stdout.write(result.stdout)
  assert.ok(result.stdout.includes(visualMode ? 'VISUAL_FIXTURE_READY' : 'ACP_TURN_STATUS_PASSED'))
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith('tpanel-acp-turn-status-'))
  rmSync(directory, { recursive: true, force: true })
}
