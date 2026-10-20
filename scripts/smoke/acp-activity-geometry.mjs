/** Actual compact conversation rows measured in Chromium; no native Agent or remote knowledge. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import tailwindConfig from '../../tailwind.config.js'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-acp-activity-geometry-'))
const absolute = (path) => resolve(path).replace(/\\/g, '/')
const reportPath = process.env.TPANEL_ACP_ACTIVITY_GEOMETRY_REPORT ? resolve(process.env.TPANEL_ACP_ACTIVITY_GEOMETRY_REPORT) : null
try {
  writeFileSync(join(directory, 'entry.tsx'), `import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{EventRow}from'${absolute('src/renderer/src/acp/TranscriptRow.tsx')}';
import{CurrentTurnStatus}from'${absolute('src/renderer/src/acp/CurrentTurnStatus.tsx')}';
import{compileItems}from'${absolute('src/renderer/src/acp/timeline.ts')}';
import{useApp}from'${absolute('src/renderer/src/store/index.ts')}';
const root='D:/activity-geometry',scope={source:'acp',projectRoot:root,sessionId:'geometry',turnId:'turn',connectionGeneration:'generation'};
useApp.setState({snapshot:{meta:{root},tasks:[],archived:[]}});
const event=(id,kind,text,payload={})=>({...scope,id,kind,text,payload,ts:100+events.length}),events=[];
const add=(...args)=>events.push(event(...args));
add('read-one','tool-call','Read rules',{toolCallId:'read-one',kind:'read',status:'completed',locations:[{path:root+'/rules.md'}]});
add('read-two','tool-call','Read spec',{toolCallId:'read-two',kind:'read',status:'completed',locations:[{path:root+'/spec.md'}]});
add('terminal-ok','tool-call','Inspect files',{toolCallId:'terminal-ok',kind:'execute',status:'completed'});
add('terminal-failed','tool-call','Failed command',{toolCallId:'terminal-failed',kind:'execute',status:'failed'});
add('native-search','tool-call','Search project',{toolCallId:'native-search',kind:'search',status:'completed'});
add('thought','thought','Already received thought for the compact disclosure.');
add('failed-turn','turn-done','',{result:{status:'failed'}});
add('completed-turn','turn-done','',{result:{status:'completed'}});
const session={...scope,agentId:'codex',agentName:'Codex',status:'ready',startedAt:1,events:[]};
function Fixture(){const[state,set]=useState({theme:'light',size:'standard',layout:'contiguous',permission:false});window.setGeometry=set;const items=compileItems(events);return <div className="my-root text-my-md text-my-primary" data-my-theme={state.theme} data-my-font-size={state.size}><div className="my-conversation-frame"><main id="geometry" className="acp-transcript-content my-conversation-column">{items.map(item=><React.Fragment key={item.key}><EventRow item={item} session={session} events={events} pendingPerm={{}} permissionPending={{}} permissionErrors={{}} onRespond={()=>{}} onOpenTask={()=>{}}/>{state.layout==='separate'&&<p className="acp-chat-copy">An assistant paragraph between the actual rows.</p>}</React.Fragment>)}<CurrentTurnStatus activity={state.permission?{phase:'permission',label:'等待你的授权',spinning:false}:{phase:'waiting',label:'等待模型回复',spinning:true}}/></main></div></div>}
createRoot(document.getElementById('root')).render(<Fixture/>);
window.measureGeometry=()=>{const column=document.querySelector('#geometry'),headers=[...column.querySelectorAll('.acp-activity-row>summary,.acp-run-heading,.acp-current-turn-status')].filter(header=>!header.closest('.acp-activity-body,.acp-run-body'));
const contentLeft=column.getBoundingClientRect().left+parseFloat(getComputedStyle(column).paddingLeft);
return {contentLeft,rows:headers.map(header=>{const icon=header.firstElementChild?.tagName.toLowerCase()==='svg'?header.firstElementChild:null,label=header.querySelector(':scope>span'),chevron=header.querySelector(':scope>.acp-disclosure-arrow,:scope>.acp-run-chevron'),box=icon?.getBoundingClientRect(),text=label.getBoundingClientRect(),style=icon&&getComputedStyle(icon);return {id:header.closest('[data-acp-item]')?.dataset.acpItem??'current',icon:box?{left:box.left,width:box.width,height:box.height,centerY:box.top+box.height/2,glyphWidth:parseFloat(style.width),stroke:parseFloat(style.strokeWidth)}:null,labelLeft:text.left,labelCenterY:text.top+text.height/2,height:header.getBoundingClientRect().height,chevronWidth:chevron?.getBoundingClientRect().width??null}})}};`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [absolute('node_modules')] })
  const css = (await postcss([tailwind(tailwindConfig)]).process(['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'styles.css', 'acp/workspace.css'].map(file => readFileSync('src/renderer/src/' + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body,#root{margin:0;min-height:100%}.my-root{min-height:100vh;background:var(--my-bg-canvas)}#geometry{padding-block:24px}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  writeFileSync(join(directory, 'main.cjs'), `const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{writeFileSync}=require('node:fs');
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1050,height:1000,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});const errors=[];w.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error(event.message)}});await w.loadFile(${JSON.stringify(join(directory, 'index.html'))});
w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await w.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
const run=source=>w.webContents.executeJavaScript(source),pause=()=>new Promise(resolve=>setTimeout(resolve,30)),set=async value=>{await run('window.setGeometry(s=>({...s,...'+JSON.stringify(value)+'}))');await pause()};await pause();
const first=await run('window.measureGeometry()');console.log('COMPACT_GEOMETRY '+JSON.stringify(first));if(${JSON.stringify(reportPath)})writeFileSync(${JSON.stringify(reportPath)},JSON.stringify(first,null,2));
const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<0.55,label+': actual '+actual+', expected '+expected);
let cases=0;
for(const width of [1050,600,360]){w.setContentSize(width,1000);await pause();for(const theme of ['light','dark'])for(const size of ['small','standard','large'])for(const layout of ['contiguous','separate'])for(const permission of [false,true]){await set({theme,size,layout,permission});const measurement=await run('window.measureGeometry()');const label=width+'/'+theme+'/'+size+'/'+layout+'/'+permission;assert.equal(measurement.rows.length,9,label+' actual compact rows');for(const row of measurement.rows){if(row.id==='activity:completed-turn'){assert.equal(row.icon,null,label+' successful duration has no phantom icon');near(row.labelLeft,measurement.contentLeft,label+' duration stays at column edge');continue}assert.ok(row.icon,label+' '+row.id+' leading glyph exists');near(row.icon.left,measurement.contentLeft,label+' '+row.id+' slot x');near(row.icon.width,16,label+' '+row.id+' 16px slot');near(row.icon.height,14,label+' '+row.id+' glyph height');near(row.icon.glyphWidth,14,label+' '+row.id+' glyph width');near(row.icon.stroke,1.6,label+' '+row.id+' stroke');near(row.labelLeft,measurement.contentLeft+22,label+' '+row.id+' first label x');near(row.icon.centerY,row.labelCenterY,label+' '+row.id+' vertical center');assert.ok(row.height>=24,label+' '+row.id+' minimum row height');if(row.chevronWidth!==null)near(row.chevronWidth,12,label+' '+row.id+' chevron width')}assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'),label+' no horizontal overflow');cases++}}
await set({theme:'dark',size:'standard',layout:'contiguous',permission:false});
const keyboardToggle=async selector=>{await run('document.querySelector('+JSON.stringify(selector)+').focus()');await w.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:String.fromCharCode(13)});await w.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await pause()};
await keyboardToggle('[data-acp-item="read-one"]>summary');const detail=await run('({column:window.measureGeometry().contentLeft,body:document.querySelector("[data-acp-item=read-one]>.acp-activity-body").getBoundingClientRect().left,padding:parseFloat(getComputedStyle(document.querySelector("[data-acp-item=read-one]>.acp-activity-body")).paddingLeft)})');assert.ok(detail.body>detail.column&&detail.padding>0,'expanded tool detail indentation remains separate');
assert.deepEqual(errors,[]);console.log('PASS '+cases+' real compact-row geometry combinations, tool keyboard disclosure, nested indentation and icon-free completion');app.exit(0)}).catch(error=>{console.error(error.stack);app.exit(1)});setTimeout(()=>{console.error('activity geometry fixture timed out');app.exit(1)},30000);`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [join(directory, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 35000, maxBuffer: 2 * 1024 * 1024 })
  process.stdout.write(result.stdout)
  assert.ok(result.stdout.includes('PASS '))
} catch (error) { if (error.stdout) process.stdout.write(error.stdout); if (error.stderr) process.stderr.write(error.stderr); throw error }
finally { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('tpanel-acp-activity-geometry-')); rmSync(directory, { recursive: true, force: true }) }
