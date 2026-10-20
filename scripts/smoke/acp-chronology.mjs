/** Real React/Chromium transcript order and disclosure identity; no provider session. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import config from '../../tailwind.config.js'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-acp-chronology-'))
const absolute = (file) => resolve(file).replace(/\\/g, '/')
const captureDir = process.env.TPANEL_ACP_CHRONOLOGY_CAPTURE_DIR
if (captureDir) mkdirSync(captureDir, { recursive: true })
try {
  writeFileSync(join(directory, 'entry.tsx'), `import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{EventRow}from'${absolute('src/renderer/src/acp/TranscriptRow.tsx')}';
import{compileItems,mergeEvents}from'${absolute('src/renderer/src/acp/timeline.ts')}';
const scope={source:'acp',projectRoot:'D:/chronology',sessionId:'chronology',turnId:'turn',connectionGeneration:'generation'};
const event=(id,kind,text,payload={})=>({...scope,id,kind,text,payload,ts:Date.now()-1000+events.length*10,historySeq:events.length+1}),events=[];
const add=(...args)=>events.push(event(...args));
add('setup','session-status','ACP 会话已就绪',{activityScope:'connection',observation:{label:'ACP 会话已就绪',atMs:100}});
add('user','message','检查文件',{role:'user'});
add('start','session-status','',{activityScope:'turn',observation:{label:'开始处理',atMs:120}});
add('sent','session-status','',{activityScope:'turn',observation:{label:'指令已发送至引擎',atMs:130}});
add('a','message','**A**：先搜索。',{role:'assistant',messageId:'native'});
add('search','tool-call','Search README',{toolCallId:'search',kind:'search',status:'in_progress'});
add('search-status','session-status','',{activityScope:'turn',observation:{label:'正在检索资料',atMs:160}});
add('b','message','B：找到文件，继续读取。',{role:'assistant',messageId:'native'});
add('read','tool-call','Read README',{toolCallId:'read',kind:'read',status:'in_progress',locations:[{path:'D:/chronology/README.md'}]});
add('thought','thought','核对搜索与原文的关系。');
add('c','message','### C\\n\\n最终结果包含 **原文**。',{role:'assistant',messageId:'native'});
add('search-patch','tool-call',undefined,{toolCallId:'search',status:'completed'});
add('read-patch','tool-call',undefined,{toolCallId:'read',status:'completed'});
add('done','turn-done','回合已结束',{result:{status:'completed'}});
function Fixture(){const[state,set]=useState({count:1,archived:false,theme:'light',size:'standard'});window.setChronology=set;const selected=events.slice(0,state.count);const items=compileItems(state.archived?mergeEvents(structuredClone(selected).reverse(),[]):mergeEvents([],selected));const session={...scope,status:state.archived||state.count===events.length?'ready':'busy'};return <div className="my-root" data-my-theme={state.theme} data-my-font-size={state.size}><div className="my-conversation-frame"><main id="transcript" key={state.archived?'archive':'live'} className="acp-transcript-content my-conversation-column">{items.map(item=><EventRow key={item.key} item={item} session={session} events={selected} pendingPerm={{}} permissionPending={{}} permissionErrors={{}} onRespond={()=>{}}/>)}</main></div></div>};createRoot(document.getElementById('root')).render(<Fixture/>);`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [absolute('node_modules')] })
  const css = (await postcss([tailwind(config)]).process(['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'styles.css', 'acp/workspace.css'].map((file) => readFileSync('src/renderer/src/' + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body,#root{margin:0;min-height:100%}.my-root{min-height:100%;background:var(--my-bg-canvas);color:var(--my-txt-primary)}#transcript{padding-block:24px}</style></head><body><div id="root"></div><script>window.trellis={}</script><script src="renderer.js"></script></body></html>`)
  writeFileSync(join(directory, 'main.cjs'), `const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{writeFileSync}=require('node:fs');const{join}=require('node:path');
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1050,height:850,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});const errors=[];w.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error(event.message)}});await w.loadFile(${JSON.stringify(join(directory, 'index.html'))});
w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
const run=async s=>{try{return await w.webContents.executeJavaScript(s)}catch(error){console.error('Renderer call: '+s);throw error}},wait=()=>new Promise(r=>setTimeout(r,35)),set=async state=>{await run('window.setChronology(s=>({...s,...'+JSON.stringify(state)+'}))');await wait()},anchors=()=>run('[...document.querySelectorAll("#transcript>[data-acp-item]")].map(n=>n.dataset.acpItem)');await wait();
const expected=['user','a','search','activity:search-status','b','read','thought','c','activity:done'];
for(let count=1;count<=14;count++){await set({count});const current=await anchors();assert.deepEqual(current,expected.slice(0,current.length),'live prefix '+count);if(count===9){await run('window.savedSearch=document.querySelector("[data-acp-item=search]");window.savedSearch.open=true;document.querySelector(".acp-run-activity button").click()')}if(count>=9)assert.ok(await run('window.savedSearch===document.querySelector("[data-acp-item=search]")&&window.savedSearch.open'),'tool node and expansion survive append/update/done')}
assert.ok(await run('document.querySelector(".acp-run-activity button").getAttribute("aria-expanded")==="true"'),'process expansion survives completion');
assert.equal(await run('document.querySelectorAll(".is-running,.acp-thought-preview").length'),0,'completed history never replays');
assert.equal(await run('[...document.querySelectorAll(".acp-answer")].map(n=>n.textContent.trim().replaceAll(String.fromCharCode(10)," ")).join("|")'),'A：先搜索。|B：找到文件，继续读取。|C 最终结果包含 原文。');
const live=await anchors();await set({archived:true});assert.deepEqual(await anchors(),live,'fresh archived mount uses identical anchors');
assert.equal(await run('document.querySelectorAll(".acp-response-footer,.acp-connection-context").length'),0,'no turn-wide relocation or duplicate connection setup');
for(const theme of ['light','dark'])for(const size of ['small','standard','large']){await set({theme,size});assert.deepEqual(await anchors(),expected);assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'),'no horizontal overflow '+theme+'/'+size);if(${JSON.stringify(captureDir ?? '')}&&size==='standard'){await w.webContents.capturePage(undefined,{stayHidden:true});await wait();writeFileSync(join(${JSON.stringify(captureDir ?? '')},theme+'-chronology.png'),(await w.webContents.capturePage(undefined,{stayHidden:true})).toPNG())}}
w.setContentSize(360,850);await wait();assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'),'narrow transcript fits');assert.deepEqual(await anchors(),expected);assert.deepEqual(errors,[]);console.log('PASS Chromium live prefixes, tool/process expansion retention, terminal/reopen anchors, no history replay, six theme/font combinations and narrow layout');app.exit(0)}).catch(error=>{console.error(error.stack);app.exit(1)});setTimeout(()=>{console.error('chronology fixture timed out');app.exit(1)},30000);`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [join(directory, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 35000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
  assert.ok(result.stdout.includes('PASS Chromium'))
} catch (error) { if (error.stdout) process.stdout.write(error.stdout); if (error.stderr) process.stderr.write(error.stderr); throw error }
finally { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }) }
