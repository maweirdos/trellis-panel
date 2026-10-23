import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'node:net'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-app-e2e-'))
const project = join(temporary, 'service project')
const imageIndex = process.argv.indexOf('--screenshots')
const screenshots = imageIndex < 0 ? null : process.argv[imageIndex + 1]
assert.ok(!screenshots || isAbsolute(screenshots))
if (screenshots) mkdirSync(screenshots, { recursive: true })
mkdirSync(join(project, '.trellis', 'spec'), { recursive: true })
const reserve = createServer()
await new Promise((accept, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', accept) })
const address = reserve.address()
assert.ok(address && typeof address === 'object')
const port = address.port
await new Promise(done => reserve.close(done))
try {
  writeFileSync(join(project, '.env'), `PORT=${port}\nAPP_MARKER=first-value\n`)
  writeFileSync(join(project, 'service.cjs'), `require('node:http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({marker:process.env.APP_MARKER,pid:process.pid}))}).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('SERVICE_READY'));`)
  const entry = join(temporary, 'entry.ts')
  writeFileSync(entry, [
    `export {registerIpc} from ${JSON.stringify(resolve('src/main/ipc/index.ts'))};`,
    `export {openProjectAt,closeProjectAt,stopTimers,setMainWindow,sendSnapshot} from ${JSON.stringify(resolve('src/main/state.ts'))};`,
    `export {appRuntime} from ${JSON.stringify(resolve('src/main/services/app-runtime/index.ts'))};`,
    `export {shutdownAcp} from ${JSON.stringify(resolve('src/main/services/acp.ts'))};`
  ].join('\n'))
  const moduleRequire = createRequire(import.meta.url)
  await build({ entryPoints: [entry], outfile: join(temporary, 'domain.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', nodePaths: [resolve('node_modules')], plugins: [{ name: 'production-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]|^@/ }, args => {
      if (args.kind === 'entry-point' || isAbsolute(args.path)) return undefined
      if (args.path === 'electron' || args.path.startsWith('node:')) return { path: args.path, external: true }
      try { const file = moduleRequire.resolve(args.path); return { path: args.kind === 'dynamic-import' && isAbsolute(file) ? pathToFileURL(file).href : file, external: true } } catch { return undefined }
    })
  } }] })
  const config = {
    id: 'e2e-service', name: '本地后端服务', cwd: '.',
    launch: { kind: 'argv', executable: process.execPath, args: ['service.cjs'] },
    envFiles: ['.env'], ports: [{ host: '127.0.0.1', port }],
    readiness: { kind: 'http', url: `http://127.0.0.1:${port}/health`, timeoutMs: 15000 }
  }
  writeFileSync(join(temporary, 'main.cjs'), `
const {app,BrowserWindow,dialog}=require('electron');
const assert=require('node:assert/strict');const{writeFileSync}=require('node:fs');const{join}=require('node:path');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.disableHardwareAcceleration();
const profile=app.getPath('userData');require('node:fs').mkdirSync(profile,{recursive:true});
writeFileSync(join(profile,'settings.json'),JSON.stringify({theme:'light',recentProjects:[],desktop:{autoUpdate:false}}));
let domain;try{domain=require('./domain.cjs')}catch(error){console.error(error);app.exit(1)};const project=${JSON.stringify(project)};const config=${JSON.stringify(config)};const screenshots=${JSON.stringify(screenshots)};
let approvals=0;dialog.showMessageBox=async()=>{approvals++;return{response:1,checkboxChecked:false}};
const wait=ms=>new Promise(done=>setTimeout(done,ms));let window;
async function run(){
window=new BrowserWindow({show:false,frame:false,width:1180,height:800,webPreferences:{preload:${JSON.stringify(resolve('out/preload/index.js'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false,offscreen:true}});
const errors=[];window.webContents.on('console-message',details=>{if(details.level==='error'){errors.push(details.message);console.error('RENDERER '+details.message)}});
domain.setMainWindow(window);
domain.registerIpc({getMain:()=>window,getCapsule:()=>null,getQuickTodo:()=>null,showMain:()=>{},createMain:()=>{},captureMain:async()=>null,capsule:{onTop:()=>true,setOnTop:()=>{},shape:()=>'pill',setShape:()=>{},create:()=>{}},openDocWindow:()=>({ok:false})});
await window.loadFile(${JSON.stringify(resolve('out/renderer/index.html'))});
window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
const evaluate=(source)=>window.webContents.executeJavaScript(source);
await evaluate('window.trellis.openProject('+JSON.stringify(project)+')').then(result=>assert.equal(result.ok,true,result.error));
domain.sendSnapshot();
for(let i=0;i<100;i++){if(await evaluate('Boolean(document.querySelector(".my-window-header"))'))break;await wait(50)}
await evaluate('window.trellis.appRuntimeSave('+JSON.stringify(project)+','+JSON.stringify({config})+')').then(result=>assert.equal(result.ok,true,result.error));
const click=async label=>{
const clicked=await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==='+JSON.stringify(label)+');if(!b||b.disabled)return false;b.click();return true})()');assert.equal(clicked,true,'button available: '+label);
};
const openPanel=async()=>{if(!await evaluate('Boolean(document.querySelector(".my-applications-popup"))')){const clicked=await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||"").startsWith("运行配置：")&&b.getAttribute("aria-haspopup")==="dialog");if(!b)return false;b.click();return true})()');assert.equal(clicked,true,'header application trigger')}await wait(150)};
const appState=()=>evaluate('window.trellis.appRuntimeList('+JSON.stringify(project)+')');
const until=async(predicate,label)=>{const deadline=Date.now()+30000;let state;while(Date.now()<deadline){state=await appState();if(state.ok&&predicate(state.apps[0]))return state.apps[0];await wait(120)}throw Error(label+': '+JSON.stringify(state))};
const untilUI=async source=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(await evaluate(source))return;await wait(50)}throw Error('renderer state timed out: '+source)};
const capture=async name=>{if(screenshots){await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('offscreen repaint timed out')),3000);window.webContents.once('paint',()=>{clearTimeout(timer);accept()});window.webContents.invalidate()});writeFileSync(join(screenshots,name+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())}};
await openPanel();
for(let i=0;i<40;i++){if(await evaluate('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="启动 本地后端服务")'))break;await wait(50)}
await click('启动 本地后端服务');
let first=await until(a=>a?.processState==='running'&&a?.readiness.state==='ready','service ready');
assert.equal(approvals,1,'first UI launch asks native human review (decision simulated in this fixture)');
let body=await fetch(${JSON.stringify(`http://127.0.0.1:${port}/health`)}).then(r=>r.json());assert.equal(body.marker,'first-value');
assert.equal(await evaluate('document.querySelector("[data-process-state=running]")!==null'),true);
assert.equal(await evaluate('document.querySelector("[data-readiness-state=ready]")!==null'),true);
await untilUI('Boolean(document.querySelector("[data-readiness-state=ready]"))&&[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="停止 本地后端服务"&&!b.disabled)');await capture('real-runtime-light-running');
writeFileSync(join(project,'.env'),'PORT='+config.ports[0].port+'\\nAPP_MARKER=second-value\\n');
await click('运行窗口重启 本地后端服务');
const second=await until(a=>a?.run?.id!==first.run.id&&a?.processState==='running'&&a?.readiness.state==='ready','service restarted');
assert.notEqual(second.run.pid,first.run.pid);assert.equal(approvals,1,'env-value reload reuses unchanged command approval');
body=await fetch(${JSON.stringify(`http://127.0.0.1:${port}/health`)}).then(r=>r.json());assert.equal(body.marker,'second-value');
await evaluate('window.trellis.setSettings({theme:"dark"})');await untilUI('document.querySelector(".my-root")?.dataset.myTheme==="dark"');await openPanel();await untilUI('Boolean(document.querySelector("[data-readiness-state=ready]"))&&[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="停止 本地后端服务"&&!b.disabled)');await capture('real-runtime-dark-restarted');
await click('停止 本地后端服务');await until(a=>a?.processState==='stopped','service stopped');
await assert.rejects(fetch(${JSON.stringify(`http://127.0.0.1:${port}/health`)}));
assert.equal(await evaluate('document.querySelector("[data-process-state=stopped]")!==null'),true);
await capture('real-runtime-dark-stopped');
assert.equal(window.isVisible(),false,'fixture host never steals foreground focus');
assert.deepEqual(errors,[],'real renderer console errors');
console.log('PASS actual built renderer + preload + registered IPC + real Windows service: UI start, separate readiness, native-review invocation, env reload on verified restart, light/dark captures and stop with port release. Human decision is simulated.');
}
app.whenReady().then(run).then(async()=>{await domain.appRuntime.shutdown();domain.closeProjectAt();domain.stopTimers();await domain.shutdownAcp();window.destroy();app.exit(0)}).catch(async error=>{console.error(error);try{await domain.appRuntime.shutdown()}catch(cleanup){console.error(cleanup)}app.exit(1)});
setTimeout(()=>{console.error('application end-to-end timed out');app.exit(1)},105000).unref();
`)
  const env = { ...process.env, NODE_PATH: resolve('node_modules') }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [join(temporary, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 115000, maxBuffer: 2 * 1024 * 1024 })
  process.stdout.write(result.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-app-e2e-'))
  rmSync(temporary, { recursive: true, force: true })
}
