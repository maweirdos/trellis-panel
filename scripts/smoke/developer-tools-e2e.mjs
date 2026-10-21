import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync, execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'node:net'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-workbench-e2e-'))
const project = join(temporary, 'fixture project')
const remote = join(temporary, 'remote.git')
const captureIndex = process.argv.indexOf('--screenshots')
const screenshots = captureIndex < 0 ? null : process.argv[captureIndex + 1]
assert.ok(!screenshots || isAbsolute(screenshots))
if (screenshots) mkdirSync(screenshots, { recursive: true })
mkdirSync(join(project, '.trellis', 'spec'), { recursive: true })
const reserve = createServer()
await new Promise((accept, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', accept) })
const address = reserve.address()
assert.ok(address && typeof address === 'object')
const port = address.port
await new Promise(done => reserve.close(done))
const git = (args, cwd = project) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function clickElement({ label, scope }) {
  const parent = scope ? document.querySelector(scope) : document
  const element = [...(parent?.querySelectorAll('button,input[type=checkbox]') ?? [])].find(node => node.getAttribute('aria-label') === label || node.tagName === 'BUTTON' && node.textContent.trim() === label)
  if (!element || element.disabled) return false
  element.click()
  return true
}

function setField({ label, value }) {
  const element = [...document.querySelectorAll('input,textarea')].find(node => node.getAttribute('aria-label') === label)
  if (!element) return false
  const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

function uiFacts() {
  const dock = document.querySelector('[aria-label="运行窗口"]')
  const panel = document.querySelector('.my-git-workspace-panel')
  return {
    expanded: dock?.classList.contains('is-expanded') ?? false,
    dockHeight: dock?.getBoundingClientRect().height ?? 0,
    panelBottom: panel?.getBoundingClientRect().bottom ?? 0,
    dockTop: dock?.getBoundingClientRect().top ?? innerHeight,
    configList: Boolean(document.querySelector('[aria-label="运行配置列表"]')),
    sameSource: window.__workbenchSource === document.querySelector('[data-page-scroll]'),
    theme: document.querySelector('.my-root')?.dataset.myTheme
  }
}

try {
  writeFileSync(join(project, '.gitignore'), '.trellis/\n.env\n')
  writeFileSync(join(project, 'README.md'), '# Fixture workspace\n')
  writeFileSync(join(project, '.env'), `PORT=${port}\nFIXTURE_MARKER=first-value\n`)
  writeFileSync(join(project, 'service.cjs'), `require('node:http').createServer((q,s)=>s.end(JSON.stringify({marker:process.env.FIXTURE_MARKER,pid:process.pid}))).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('WORKBENCH_SERVICE_READY'));`)
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Workbench Fixture'])
  git(['config', 'user.email', 'fixture@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['add', '--', '.gitignore', 'README.md', 'service.cjs'])
  git(['commit', '-m', 'fixture baseline'])
  git(['init', '--bare', remote], temporary)
  git(['remote', 'add', 'origin', remote])

  const entry = join(temporary, 'entry.ts')
  writeFileSync(entry, [
    `export {registerIpc} from ${JSON.stringify(resolve('src/main/ipc/index.ts'))};`,
    `export {openProjectAt,closeProjectAt,stopTimers,setMainWindow,sendSnapshot} from ${JSON.stringify(resolve('src/main/state.ts'))};`,
    `export {appRuntime} from ${JSON.stringify(resolve('src/main/services/app-runtime/index.ts'))};`,
    `export {shutdownAcp} from ${JSON.stringify(resolve('src/main/services/acp.ts'))};`
  ].join('\n'))
  const require = createRequire(import.meta.url)
  await build({ entryPoints: [entry], outfile: join(temporary, 'domain.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', nodePaths: [resolve('node_modules')], plugins: [{ name: 'actual-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]|^@/ }, args => {
      if (args.kind === 'entry-point' || isAbsolute(args.path)) return undefined
      if (args.path === 'electron' || args.path.startsWith('node:')) return { path: args.path, external: true }
      try { const file = require.resolve(args.path); return { path: args.kind === 'dynamic-import' && isAbsolute(file) ? pathToFileURL(file).href : file, external: true } } catch { return undefined }
    })
  } }] })
  const configuration = { id: 'fixture-service', name: '后端服务', cwd: '.', launch: { kind: 'argv', executable: process.execPath, args: ['service.cjs'] }, envFiles: ['.env'], ports: [{ host: '127.0.0.1', port }], readiness: { kind: 'http', url: `http://127.0.0.1:${port}/`, timeoutMs: 15000 } }
  writeFileSync(join(temporary, 'main.cjs'), `
const{app,BrowserWindow,dialog}=require('electron');const assert=require('node:assert/strict');const{writeFileSync,readFileSync,mkdirSync}=require('node:fs');const{join}=require('node:path');const{execFileSync}=require('node:child_process');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
mkdirSync(app.getPath('userData'),{recursive:true});writeFileSync(join(app.getPath('userData'),'settings.json'),JSON.stringify({theme:'light',recentProjects:[],desktop:{autoUpdate:false}}));
let domain;try{domain=require('./domain.cjs')}catch(error){console.error(error);app.exit(1)}
const project=${JSON.stringify(project)},remote=${JSON.stringify(remote)},configuration=${JSON.stringify(configuration)},screenshots=${JSON.stringify(screenshots)};
const clickSource=${JSON.stringify(clickElement.toString())},fieldSource=${JSON.stringify(setField.toString())},factsSource=${JSON.stringify(uiFacts.toString())};
const git=(args,cwd=project)=>execFileSync('git',args,{cwd,windowsHide:true,encoding:'utf8'}).trim();
let approvals=0;dialog.showMessageBox=async()=>{approvals++;return{response:1,checkboxChecked:false}};
let window;const wait=ms=>new Promise(done=>setTimeout(done,ms));
async function run(){
window=new BrowserWindow({show:false,frame:false,width:1360,height:860,webPreferences:{preload:${JSON.stringify(resolve('out/preload/index.js'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false,offscreen:true}});
const errors=[];window.webContents.on('console-message',details=>{if(details.level==='error'){errors.push(details.message);console.error('RENDERER '+details.message)}});
domain.setMainWindow(window);domain.registerIpc({getMain:()=>window,getCapsule:()=>null,getQuickTodo:()=>null,showQuickTodo:()=>{},showMain:()=>{},createMain:()=>{},captureMain:async()=>null,isDocWindowSender:()=>false,capsule:{onTop:()=>true,setOnTop:()=>{},shape:()=>'pill',setShape:()=>{},create:()=>{}},openDocWindow:()=>({ok:false})});
assert.equal(domain.openProjectAt(project).ok,true);await window.loadFile(${JSON.stringify(resolve('out/renderer/index.html'))});
window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
const evaluate=source=>window.webContents.executeJavaScript(source);const call=(source,arg)=>evaluate('('+source+')('+JSON.stringify(arg??null)+')');
const until=async(check,label)=>{const deadline=Date.now()+35000;while(Date.now()<deadline){if(await check())return;await wait(100)}throw Error('timed out: '+label)};
const click=async(label,scope)=>{await until(()=>call(clickSource,{label,scope}),'click '+label)};
const api=async(method,input)=>evaluate('window.trellis.'+method+'('+JSON.stringify(input)+')');
const appState=async()=>{const result=await api('appRuntimeList',project);assert.equal(result.ok,true,result.error);return result.apps.find(a=>a.definition.id===configuration.id)};
const snapshot=async()=>{for(let i=0;i<10;i++){const result=await api('gitWorkspace.status',{expectedRoot:project});if(result.ok)return result.snapshot;assert.equal(result.code,'E_CONFLICT',result.error);await wait(50)}throw Error('Git snapshot kept changing during observation')};
const capture=async name=>{if(!screenshots)return;await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await wait(250);const image=await window.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(screenshots,name+'.png'),Buffer.from(image.data,'base64'))};
await until(()=>evaluate('Boolean(document.querySelector(".my-shell-layout"))'),'real project shell');
await evaluate('window.__workbenchSource=document.querySelector("[data-page-scroll]")');
assert.equal((await evaluate('window.trellis.appRuntimeSave('+JSON.stringify(project)+','+JSON.stringify({config:configuration})+')')).ok,true);
await until(()=>evaluate('Boolean([...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||"").startsWith("运行配置：后端服务")))'),'saved configuration in toolbar');
await evaluate('([...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||"").startsWith("运行配置："))).click()');await click('编辑配置…');await until(async()=>(await call(factsSource)).configList,'editable configuration');
assert.equal(await call(fieldSource,{label:'启动参数',value:'service.cjs\\nargument with spaces'}),true);await click('保存','.my-run-config-manager');
await until(async()=>{const state=await appState();return state?.definition.launch.kind==='argv'&&state.definition.launch.args.length===2},'real UI saved arguments');
assert.deepEqual((await appState()).definition.launch.args,['service.cjs','argument with spaces']);assert.equal(approvals,0,'save never launches or requests execution approval');await assert.rejects(fetch(configuration.readiness.url));
await until(async()=>!(await call(factsSource)).configList,'saved manager dismissed');
await click('启动 后端服务','[aria-label="应用运行控制"]');
await until(async()=>{const state=await appState();return state?.processState==='running'&&state.readiness.state==='ready'},'ready service');
await until(async()=>(await call(factsSource)).expanded,'auto-open console');
const first=await appState();assert.equal(approvals,1);assert.equal(JSON.parse(await fetch(configuration.readiness.url).then(r=>r.text())).marker,'first-value');
await click('折叠运行窗口');assert.equal(JSON.parse(await fetch(configuration.readiness.url).then(r=>r.text())).marker,'first-value');
await until(async()=>!(await call(factsSource)).expanded,'collapsed console');assert.equal((await call(factsSource)).sameSource,true);
await click('展开运行窗口');await until(async()=>(await call(factsSource)).expanded,'expanded console');const height=(await call(factsSource)).dockHeight;
await evaluate('[...document.querySelectorAll("[role=separator]")].find(n=>n.getAttribute("aria-label")==="调整运行窗口高度").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true}))');
await until(async()=>(await call(factsSource)).dockHeight>height,'keyboard resize');assert.equal((await call(factsSource)).sameSource,true);

writeFileSync(join(project,'feature file 中文.txt'),'reviewed content\\n');writeFileSync(join(project,'untouched.txt'),'unreviewed content\\n');
const openGit=async()=>{const clicked=await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||"").startsWith("Git 分支："));if(!b)return false;b.click();return true})()');assert.equal(clicked,true);await click('更改与提交')};
await openGit();await click('刷新 Git 状态','.my-git-workspace-panel');await click('选择工作区文件 feature file 中文.txt');await click('暂存所选','.my-git-workspace-panel');
await until(async()=>(await snapshot()).staged.some(f=>f.path==='feature file 中文.txt'),'selected file staged');
assert.equal(await call(fieldSource,{label:'提交说明',value:'workbench reviewed change'}),true);await click('提交暂存内容','.my-git-workspace-panel');
await until(async()=>(await snapshot()).staged.length===0,'reviewed commit');assert.deepEqual(git(['show','--pretty=','--name-only','-z','HEAD']).split(String.fromCharCode(0)).filter(Boolean),['feature file 中文.txt']);assert.equal(readFileSync(join(project,'untouched.txt'),'utf8'),'unreviewed content\\n');
await click('刷新 Git 状态','.my-git-workspace-panel');await click('选择工作区文件 untouched.txt');await click('暂存所选','.my-git-workspace-panel');await until(async()=>(await snapshot()).staged.length===1,'remaining fixture staged');
assert.equal(await call(fieldSource,{label:'提交说明',value:'fixture clean for branch switch'}),true);await click('提交暂存内容','.my-git-workspace-panel');await until(async()=>(await snapshot()).clean,'clean fixture');
await click('刷新 Git 状态','.my-git-workspace-panel');
await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||"").startsWith("Git 分支："));b.click()})()');await click('创建分支…');
assert.equal(await call(fieldSource,{label:'分支名称',value:'feature/e2e'}),true);await evaluate('([...document.querySelectorAll("label")].find(n=>n.textContent.includes("创建后切换"))?.querySelector("input")).click()');await click('创建分支');await until(async()=>(await snapshot()).branches.some(b=>b.name==='feature/e2e'),'created local branch');
await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||"").startsWith("Git 分支："));b.click()})()');await click('切换到分支 feature/e2e');await click('切换分支');await until(async()=>(await snapshot()).branch==='feature/e2e','switched local branch');
await click('推送…','.my-git-workspace-panel');await click('推送');await until(async()=>{try{return git(['show-ref','--verify','--hash','refs/heads/feature/e2e'],remote)===git(['rev-parse','HEAD'])}catch{return false}},'actual local bare push');
assert.equal((await appState()).run.id,first.run.id,'Git operations leave the running service unchanged');
writeFileSync(join(project,'preview.txt'),'a visible pending change\\n');await click('刷新 Git 状态','.my-git-workspace-panel');
await until(async()=>{const f=await call(factsSource);return f.panelBottom<=f.dockTop+1},'side panel ends above dock');await capture('workbench-real-light');
await evaluate('window.trellis.setSettings({theme:"dark"})');await until(async()=>(await call(factsSource)).theme==='dark','dark theme');await capture('workbench-real-dark');
await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||"").startsWith("运行配置："));b.click()})()');await click('编辑配置…');await until(async()=>(await call(factsSource)).configList,'master-detail configuration');await capture('workbench-real-config');await click('关闭应用配置');
await click('停止 后端服务','[aria-label="应用运行控制"]');await until(async()=>(await appState()).processState==='stopped','verified service stop');await assert.rejects(fetch(configuration.readiness.url));
assert.deepEqual(errors,[],'real renderer console errors');assert.equal(window.isVisible(),false);assert.ok(approvals>=4,'native review invoked for launch, commits and push (choices simulated)');
console.log('PASS built UI/preload/actual IPC: run toolbar, alive-after-collapse, resize/source retention, selected staging/reviewed commits, local branch create/switch, ordinary bare-remote push, joint Git/dock geometry, themed master-detail config and verified stop. Native human choices are simulated.');
}
app.whenReady().then(run).then(async()=>{await domain.appRuntime.shutdown();domain.closeProjectAt();domain.stopTimers();await domain.shutdownAcp();window.destroy();app.exit(0)}).catch(async error=>{console.error(error);try{await domain.appRuntime.shutdown()}catch(cleanup){console.error(cleanup)}app.exit(1)});
setTimeout(()=>{console.error('workbench fixture timed out');app.exit(1)},160000).unref();
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(require('electron'), [join(temporary, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 170000, maxBuffer: 3 * 1024 * 1024 })
  process.stdout.write(result.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-workbench-e2e-'))
  rmSync(temporary, { recursive: true, force: true })
}
