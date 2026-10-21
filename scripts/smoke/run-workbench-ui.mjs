/** Mounted run-workbench controls with isolated IPC; never starts an OS process. */
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
const temporary = mkdtempSync(join(tmpdir(), 'tpanel-run-workbench-ui-'))
const absolute = file => resolve(file).replace(/\\/g, '/')
const renderer = 'src/renderer/src/'
const fixture = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {flushSync} from '${absolute('node_modules/react-dom/index.js')}';
import {ApplicationDock} from '${absolute(renderer + 'applications/ApplicationDock.tsx')}';
import {ApplicationPanel} from '${absolute(renderer + 'applications/ApplicationPanel.tsx')}';
import {TitleBar} from '${absolute(renderer + 'components/TitleBar.tsx')}';
import {ApplicationRuntimeView} from '${absolute(renderer + 'applications/ApplicationPanel.tsx')}';
import {refreshApplications,closeApplicationEditor} from '${absolute(renderer + 'applications/useApplications.ts')}';
import {dispatchEscKey} from '${absolute(renderer + 'utils/esc-layer.ts')}';
import {useApp} from '${absolute(renderer + 'store')}';
import {setCapability} from '${absolute(renderer + 'api')}';
const sourceLife={mounts:0,unmounts:0};function Source(){React.useEffect(()=>{sourceLife.mounts++;return()=>{sourceLife.unmounts++}},[]);return <section className="fixture-source" aria-label="原始对话"><h1>原始对话</h1><textarea aria-label="对话草稿" defaultValue="尚未发送的对话草稿"/></section>}
const root=createRoot(document.getElementById('root')),events=new Set(),calls=[],apps=new Map();
const clone=value=>structuredClone(value),project='D:/fixture-applications',other='D:/fixture-other';
function makeApp(patch={}){const definition={id:'backend',name:'后端服务',cwd:'.',launch:{kind:'argv',executable:'java',args:['-jar','app.jar']},envFiles:['.env'],ports:[{host:'127.0.0.1',port:8080}],readiness:{kind:'none'},stopTimeoutMs:10000,revision:'revision-1',updatedAt:1,overrideKeys:['DB_PASSWORD']};return{definition,processState:'stopped',readiness:{state:'not-configured',checkedAt:null},run:null,ports:[{host:'127.0.0.1',port:8080,state:'available'}],approval:'required',canStart:true,canStop:false,canRestart:false,...patch}}
const f={project,other,makeApp,calls,events,apps,sourceLife,holdLogs:false,pendingLogs:[],deferLists:false,pendingLists:[],holdStart:false,startResolve:null,stopFailure:false,saveFailure:false,logs:'booting\\n'+Array.from({length:28},(_,i)=>'output '+i).join('\\n')+'\\nOUTPUT_END',refresh:refreshApplications,
 wait:async(test,label)=>{for(let i=0;i<160;i++){if(test())return;await new Promise(done=>setTimeout(done,10))}throw Error('Timed out: '+label)},
 settle:()=>new Promise(done=>setTimeout(done,80)),
 button:label=>[...document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===label)??[...document.querySelectorAll('button')].find(node=>node.textContent===label),
 setField:(label,value)=>{const node=document.querySelector('[aria-label="'+label+'"]');if(!node)throw Error('Missing field '+label);const setter=Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))},
 emit:(app,kind='state',root=project)=>{apps.set(root,[...(apps.get(root)??[]).filter(item=>item.definition.id!==app.definition.id),app]);events.forEach(listener=>listener({kind,root,appId:app.definition.id,runId:app.run?.id??null,app:clone(app)}))},
 escape:dispatchEscKey,
 failure:()=>{const failed=makeApp({processState:'failed',approval:'pending',lastError:'预期端口 8080 已被其他进程占用。'});failed.ports=[{host:'127.0.0.1',port:8080,state:'external-conflict',pid:404}];f.emit(failed,'attention')},
 switchRoot:root=>flushSync(()=>useApp.setState({snapshot:root?{meta:{root,name:root===project?'示例项目':'其他项目'}}:null})),
 mount:({theme='dark',size='standard',items=[makeApp()],root:projectRoot=project,ipc=true,header=false,projectName='示例项目'}={})=>{flushSync(()=>root.render(null));closeApplicationEditor();setCapability(ipc);calls.length=0;events.clear();apps.clear();apps.set(projectRoot,clone(items));f.deferLists=false;f.pendingLists=[];f.holdStart=false;f.startResolve=null;f.stopFailure=false;f.saveFailure=false;useApp.setState({snapshot:projectRoot?{meta:{root:projectRoot,name:projectName}}:null});document.documentElement.classList.toggle('dark',theme==='dark');flushSync(()=>root.render(<div className="my-root" data-my-theme={theme} data-my-font-size={size} style={{height:'100%',background:'var(--my-bg-canvas)',display:'flex',flexDirection:'column'}}>{header?<TitleBar/>:<header className="my-window-header" style={{height:48,display:'flex',justifyContent:'flex-end',flexShrink:0}}><ApplicationPanel/></header>}<main className="my-application-fixture-body"><Source/><ApplicationRuntimeView/></main><ApplicationDock/></div>))},
 reset:()=>flushSync(()=>root.render(null))};
window.applicationsFixture=f;
const find=(root,id)=>apps.get(root)?.find(app=>app.definition.id===id);
const success=(root,app)=>({ok:true,root,app:clone(app)});
window.__applicationsApi={
 gitWorkspace:{status:async({expectedRoot})=>({ok:true,root:expectedRoot,snapshot:{root:expectedRoot,repoRoot:expectedRoot,revision:'a'.repeat(64),head:'a'.repeat(40),branch:'codex/a-deliberately-long-branch-name-for-header-truncation',detached:false,unborn:false,clean:true,staged:[],unstaged:[],untracked:[],branches:[],remotes:[],operation:null,conflicts:false,observedAt:1}})},
 appRuntimeList:async root=>{calls.push(['list',root]);if(f.deferLists)return new Promise(resolve=>f.pendingLists.push({root,resolve}));return{ok:true,root,apps:clone(apps.get(root)??[])}},
 appRuntimeSave:async(root,input)=>{calls.push(['save',root,clone(input)]);if(f.saveFailure)return{ok:false,code:'E_CONFLICT',error:'配置已变更，请重新读取。'};const previous=find(root,input.config.id);const keys=new Set(previous?.definition.overrideKeys??[]);for(const row of input.overrides??[]){if(row.action==='clear')keys.delete(row.key);else keys.add(row.key)}const app=makeApp({definition:{...clone(input.config),revision:'saved-revision',updatedAt:2,overrideKeys:[...keys]}});apps.set(root,[...(apps.get(root)??[]).filter(item=>item.definition.id!==app.definition.id),app]);return success(root,app)},
 appRuntimeRemove:async(root,id,revision)=>{calls.push(['remove',root,id,revision]);apps.set(root,(apps.get(root)??[]).filter(item=>item.definition.id!==id));return{ok:true,root}},
 appRuntimeStart:async(root,id,revision)=>{calls.push(['start',root,id,revision]);const app=find(root,id);const launch=decision=>{if(decision==='deny'){app.approval='pending';f.emit(app,'attention',root);return{ok:false,code:'E_DENIED',reason:'APPROVAL_REQUIRED',error:'请确认应用启动配置。'}}app.processState='running';app.approval='approved';app.canStart=false;app.canStop=true;app.canRestart=true;app.run={id:'run-1',pid:321,startedAt:1,exitedAt:null,exitCode:null,signal:null};return success(root,app)};if(f.holdStart)return new Promise(resolve=>{f.startResolve=decision=>resolve(launch(decision))});return launch('approve')},
 appRuntimeStop:async(root,id)=>{calls.push(['stop',root,id]);const app=find(root,id);if(f.stopFailure){app.processState='cleanup-required';app.lastError='停止超时，仍需核验进程。';app.canRestart=false;f.emit(app,'state',root);return{ok:false,code:'E_TIMEOUT',error:app.lastError}}app.processState='stopped';app.canStart=true;app.canStop=false;return success(root,app)},
 appRuntimeRestart:async(root,id,revision)=>{calls.push(['restart',root,id,revision]);return success(root,find(root,id))},
 appRuntimeLogs:async(root,id)=>{const runId=find(root,id)?.run?.id??null;calls.push(['logs',root,id,runId]);const value={ok:true,root,appId:id,runId,output:id+':'+(runId??'none')+'\\n'+f.logs,outputTruncated:true,cursor:1000};if(f.holdLogs)return new Promise((resolve,reject)=>f.pendingLogs.push({root,id,runId,resolve,reject,value}));return value},
 onAppRuntimeEvent:listener=>{events.add(listener);return()=>events.delete(listener)},
 devtoolsListScripts:async dir=>{calls.push(['scripts',dir]);return{ok:true,dir,scripts:[{name:'dev',command:'node server.js'},{name:'test',command:'node test.js'}]}},
 pickProject:async()=>project+'/service',onWindowMaximized:()=>()=>{},setCapsuleMode:()=>{},windowMinimize:()=>{},windowMaximize:()=>{},windowClose:()=>{}
};window.addEventListener('keydown',event=>{if(event.key==='Escape'&&dispatchEscKey())event.preventDefault()});f.mount();`

async function layoutChecks({ theme, size }) {
  const f = window.applicationsFixture, passed = []
  const check = (name, condition, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); passed.push(name) }
  const app = f.makeApp({ processState: 'running', canStart: false, canStop: true, canRestart: true, approval: 'approved', run: { id: 'run-current', pid: 100, startedAt: 1, exitedAt: null, exitCode: null, signal: null } })
  f.mount({ theme, size, items: [app] })
  await f.wait(() => document.querySelector('[data-app-id="backend"] [data-process-state="running"]'), 'runtime loaded')
  const source = document.querySelector('[aria-label="对话草稿"]'), mounts = f.sourceLife.mounts
  f.button('显示运行窗口').click()
  await f.wait(() => document.querySelector('.my-run-dock pre')?.textContent.includes('backend:run-current'), 'current run output')
  await f.settle()
  const dock = document.querySelector('.my-run-dock'), dockBox = dock.getBoundingClientRect(), main = document.querySelector('main').getBoundingClientRect()
  check('output stays in bottom dock', Math.abs(dockBox.bottom - innerHeight) <= 1 && main.bottom <= dockBox.top + 1, { dock: dockBox.toJSON(), main: main.toJSON() })
  check('expanded dock obeys canonical maximum', dockBox.height <= innerHeight * 0.55 + 1 && dockBox.height >= 160)
  check('dock publishes actual occupied geometry', Math.abs(Number.parseFloat(getComputedStyle(document.querySelector('.my-root')).getPropertyValue('--my-run-dock-occupied-height')) - dockBox.height) < 1)
  check('output and readiness remain truthful', dock.querySelector('[data-process-state="running"]') && dock.querySelector('[data-readiness-state="not-configured"]') && dock.textContent.includes('早期输出已截断'))
  check('output keyboard scroll remains bounded', dock.querySelector('pre').tabIndex === 0 && dock.querySelector('pre').scrollHeight > dock.querySelector('pre').clientHeight)
  const separator = dock.querySelector('[role="separator"]')
  separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); await f.settle()
  check('keyboard End clamps to measured token maximum', Math.abs(dock.getBoundingClientRect().height - innerHeight * 0.55) < 2)
  separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); await f.settle()
  check('keyboard Home clamps to token minimum', Math.abs(dock.getBoundingClientRect().height - 160) < 2)
  f.button('折叠运行窗口').click(); await f.settle()
  check('collapse retains original source and draft', source === document.querySelector('[aria-label="对话草稿"]') && source.value.includes('尚未发送') && f.sourceLife.mounts === mounts)
  check('collapse never stops service and updates occupied geometry', !f.calls.some(call => call[0] === 'stop') && Math.abs(Number.parseFloat(getComputedStyle(document.querySelector('.my-root')).getPropertyValue('--my-run-dock-occupied-height')) - dock.getBoundingClientRect().height) < 1)
  f.button('展开运行窗口').click(); await f.settle()
  f.button('编辑 后端服务').click(); await f.wait(() => document.querySelector('.my-run-config-manager'), 'manager')
  const modal = document.querySelector('[role="dialog"]'), box = modal.getBoundingClientRect(), form = modal.querySelector('form'), footer = modal.querySelector('footer')
  check('manager fits viewport in both themes and all font sizes', box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1, box.toJSON())
  check('active runtime configuration cannot be saved before verified stop', f.button('保存').disabled && f.button('保存并运行').disabled)
  check('configuration list and form compose one modal', modal.querySelector('[aria-label="运行配置列表"]') && modal.querySelector('[aria-label="应用名称"]') && document.querySelectorAll('.my-root').length === 1)
  check('configuration scroll does not hide save actions', form.scrollHeight >= form.clientHeight && footer.getBoundingClientRect().bottom <= box.bottom + 1, {modal:box.toJSON(),footer:footer.getBoundingClientRect().toJSON(),form:form.getBoundingClientRect().toJSON(),scroll:form.scrollHeight,client:form.clientHeight})
  check('desktop master detail and narrow stack use same controls', innerWidth <= 640 ? modal.querySelector('.my-run-config-sidebar').getBoundingClientRect().bottom <= modal.querySelector('.my-run-config-detail').getBoundingClientRect().top + 1 : modal.querySelector('.my-run-config-sidebar').getBoundingClientRect().right <= modal.querySelector('.my-run-config-detail').getBoundingClientRect().left + 1)
  check('no viewport horizontal overflow', document.documentElement.scrollWidth <= innerWidth + 1)
  check('opening configuration does not replace underlying source', document.querySelector('[aria-label="对话草稿"]') === source && f.sourceLife.mounts === mounts)
  f.escape(); await f.wait(() => !document.querySelector('[role="dialog"]'), 'close clean manager')
  return passed
}

async function headerChecks({ theme, size }) {
  const f = window.applicationsFixture, passed = []
  const check = (name, condition, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); passed.push(name) }
  const app = f.makeApp(); app.definition.name = 'A deliberately long application configuration name for header truncation'
  f.mount({ theme, size, items: [app], header: true, projectName: 'A deliberately long project name for header truncation' })
  await f.wait(() => document.querySelector('.my-run-config-trigger')?.textContent.includes(app.definition.name) && document.querySelector('.my-git-branch-trigger')?.textContent.includes('codex/'), 'real shared header')
  await f.settle()
  const header = document.querySelector('.my-window-header'), search = document.querySelector('.my-window-search')
  const controls = [document.querySelector('.my-project-switcher'), document.querySelector('.my-git-branch-trigger'), search, document.querySelector('.my-run-toolbar'), f.button('打开任务悬浮窗'), f.button('最小化窗口'), f.button('最大化窗口'), f.button('关闭窗口')]
  const boxes = controls.map(node => node.getBoundingClientRect())
  check('actual header controls fit the native minimum width', boxes.every(box => box.width > 0 && box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= header.getBoundingClientRect().bottom + 1), boxes.map(box => box.toJSON()))
  check('actual Git/run/search/native groups never overlap', boxes.every((box, index) => index === 0 || box.left >= boxes[index - 1].right - 1), boxes.map(box => box.toJSON()))
  check('native window buttons retain full targets with long labels', boxes.slice(-4).every(box => box.width >= 43), boxes.map(box => box.toJSON()))
  check('search icon remains reachable with long labels', search.getBoundingClientRect().width >= 35 && search.querySelector('svg').getBoundingClientRect().width >= 15, search.getBoundingClientRect().toJSON())
  check('native header interactions remain outside the drag region', controls.every(node => node.classList.contains('no-drag') || node.closest('.no-drag')))
  check('actual header never creates horizontal document overflow', document.documentElement.scrollWidth <= innerWidth + 1)
  return passed
}

async function interactionChecks() {
  const f = window.applicationsFixture, passed = []
  const check = (name, condition, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); passed.push(name) }
  const frontend = f.makeApp(); frontend.definition = { ...frontend.definition, id: 'frontend', name: '前端服务', launch: { kind: 'npm-script', script: 'dev' }, overrideKeys: [] }
  const items = [f.makeApp(), frontend]
  const selector = () => document.querySelector('.my-run-config-trigger')
  const choose = async name => { selector().click(); await f.wait(() => f.button('选择配置 ' + name), 'selector option'); f.button('选择配置 ' + name).click(); await f.settle() }
  f.mount({ items }); await f.wait(() => f.button('启动 后端服务') && !f.button('启动 后端服务').disabled, 'first config')
  const source = document.querySelector('[aria-label="对话草稿"]'), mounts = f.sourceLife.mounts, unmounts = f.sourceLife.unmounts
  await choose('前端服务')
  check('selection changes label without running', selector().textContent.includes('前端服务') && !f.calls.some(call => call[0] === 'start'))
  f.button('启动 前端服务').click(); await f.wait(() => document.querySelector('.my-run-dock pre')?.textContent.includes('frontend:run-1'), 'manual start output')
  check('manual start opens console for the exact selected revision', JSON.stringify(f.calls.find(call => call[0] === 'start')) === JSON.stringify(['start', f.project, 'frontend', 'revision-1']) && document.querySelector('.my-run-dock [data-process-state="running"]'))
  await choose('后端服务'); f.button('显示运行窗口').click(); await f.wait(() => document.querySelectorAll('[role="tab"]').length === 2, 'two output tabs')
  check('show output is presentation-only', f.calls.filter(call => call[0] === 'start').length === 1)
  const backendTab = [...document.querySelectorAll('[role="tab"]')].find(node => node.textContent.includes('后端服务'))
  backendTab.focus(); backendTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await f.settle()
  check('dock tabs provide keyboard selection', document.activeElement?.getAttribute('role') === 'tab' && document.activeElement?.textContent.includes('前端服务') && selector().textContent.includes('前端服务'))
  f.button('关闭 前端服务 输出').focus(); f.button('关闭 前端服务 输出').click(); await f.settle()
  check('closing a focused output tab restores focus to the remaining tab', document.activeElement?.getAttribute('role') === 'tab' && document.activeElement?.textContent.includes('后端服务'))
  check('closing output cannot silently change the named launch selection', selector().textContent.includes('前端服务'))
  f.button('关闭运行窗口').focus(); f.button('关闭运行窗口').click(); await f.settle()
  check('closing the dock restores focus to its remaining expand control', document.activeElement === f.button('展开运行窗口'))
  f.button('展开运行窗口').click(); await f.settle()
  check('close tabs and dock never stop applications', !f.calls.some(call => call[0] === 'stop'))
  check('all presentation transitions retain source DOM and owner', source === document.querySelector('[aria-label="对话草稿"]') && f.sourceLife.mounts === mounts && f.sourceLife.unmounts === unmounts)
  await choose('前端服务'); f.button('重启 前端服务').click(); await f.settle(); await f.wait(() => f.calls.some(call => call[0] === 'restart') && f.button('运行窗口停止 前端服务') && !f.button('运行窗口停止 前端服务').disabled, 'manual restart')
  f.button('运行窗口停止 前端服务').click(); await f.wait(() => document.querySelector('.my-run-dock [data-process-state="stopped"]'), 'manual stop')
  check('only explicit stop delegates lifecycle authority', f.calls.filter(call => call[0] === 'stop').length === 1)

  f.button('编辑 后端服务').click(); await f.wait(() => document.querySelector('[aria-label="应用名称"]'), 'configuration manager')
  f.setField('应用名称', '后端草稿'); await f.settle(); f.button('编辑配置 前端服务').click(); await f.wait(() => document.querySelector('[aria-label="应用标识"]').value === 'frontend', 'switch draft')
  f.setField('应用名称', '前端草稿'); await f.settle(); f.button('编辑配置 后端服务').click(); await f.wait(() => document.querySelector('[aria-label="应用标识"]').value === 'backend', 'return draft')
  check('switching configurations preserves unsaved independent drafts', document.querySelector('[aria-label="应用名称"]').value === '后端草稿' && document.querySelectorAll('[aria-label="未保存"]').length === 2)
  f.escape(); await f.wait(() => document.querySelector('[aria-label="未保存的运行配置"]'), 'discard review')
  check('dirty close focuses explicit non-destructive choice', document.activeElement?.textContent === '继续编辑' && document.querySelector('[aria-label="应用名称"]').value === '后端草稿')
  f.escape(); await f.wait(() => !document.querySelector('[aria-label="未保存的运行配置"]'), 'Escape returns to edit')
  f.escape(); await f.wait(() => document.querySelector('[aria-label="未保存的运行配置"]'), 'Escape re-arms dirty confirmation')
  f.button('继续编辑').click(); await f.settle()
  const starts = f.calls.filter(call => call[0] === 'start').length
  f.button('保存').click(); await f.wait(() => f.calls.some(call => call[0] === 'save') && document.querySelector('[aria-label="未保存的运行配置"]'), 'save current with other draft')
  check('plain save never starts and retains other dirty drafts', f.calls.filter(call => call[0] === 'start').length === starts && document.querySelectorAll('[aria-label="未保存"]').length === 1)
  f.button('继续编辑').click(); await f.settle()
  check('saved overrides reset to write-only public projection', !document.querySelector('[aria-label="变量值 1"]'))
  f.button('编辑配置 前端服务').click(); await f.settle()
  check('other draft survives saving its sibling', document.querySelector('[aria-label="应用名称"]').value === '前端草稿')
  f.button('保存并运行').click(); await f.wait(() => !document.querySelector('.my-run-config-manager') && f.calls.filter(call => call[0] === 'start').length === starts + 1, 'explicit save and run')
  check('save and run uses newly acknowledged revision', JSON.stringify(f.calls.filter(call => call[0] === 'start').at(-1)) === JSON.stringify(['start', f.project, 'frontend', 'saved-revision']))
  check('configuration save does not replace original source', source === document.querySelector('[aria-label="对话草稿"]') && f.sourceLife.mounts === mounts)

  f.holdLogs = true; f.pendingLogs = []; f.button('关闭运行窗口').click(); await f.settle(); f.button('显示运行窗口').click(); await f.wait(() => f.pendingLogs.length === 1, 'old run logs held')
  const oldLog = f.pendingLogs[0], updated = structuredClone(f.apps.get(f.project).find(app => app.definition.id === 'frontend')); updated.run.id = 'run-new'; f.emit(updated)
  await f.wait(() => f.pendingLogs.some(row => row.runId === 'run-new'), 'new run logs requested')
  const newLog = f.pendingLogs.find(row => row.runId === 'run-new'); newLog.resolve({ ...newLog.value, output: 'CURRENT_RUN_ONLY' }); await f.wait(() => document.querySelector('.my-run-dock pre')?.textContent === 'CURRENT_RUN_ONLY', 'new run output applied')
  oldLog.resolve({ ...oldLog.value, output: 'STALE_OLD_RUN' }); await f.settle()
  check('late logs from replaced run cannot overwrite current run output', document.querySelector('.my-run-dock pre')?.textContent === 'CURRENT_RUN_ONLY')
  f.pendingLogs = []; f.emit(updated, 'output'); await f.wait(() => f.pendingLogs.length === 1, 'first current-run read'); f.emit(updated, 'output'); await f.wait(() => f.pendingLogs.length === 2, 'second current-run read')
  f.pendingLogs[1].resolve({ ...f.pendingLogs[1].value, output: 'NEWEST_READ' }); await f.wait(() => document.querySelector('.my-run-dock pre')?.textContent === 'NEWEST_READ', 'latest read accepted'); f.pendingLogs[0].reject(Error('old read failed')); await f.settle()
  check('older log read failure cannot hide a newer successful read', document.querySelector('.my-run-dock pre')?.textContent === 'NEWEST_READ' && !document.querySelector('.my-run-dock [role="alert"]'))
  f.holdLogs = false
  f.deferLists = true; void f.refresh(); await f.wait(() => f.pendingLists.length === 1, 'old A list'); f.switchRoot(f.other); f.switchRoot(f.project); await f.wait(() => f.pendingLists.length === 3, 'A B A generations')
  const fresh = f.makeApp(); fresh.definition.name = 'Fresh A'; f.pendingLists[2].resolve({ ok: true, root: f.project, apps: [fresh] }); await f.wait(() => selector()?.textContent.includes('Fresh A'), 'fresh owner')
  f.pendingLists[0].resolve({ ok: true, root: f.project, apps: items }); f.pendingLists[1].resolve({ ok: true, root: f.other, apps: items }); await f.settle()
  check('A B A cannot revive old selection or open old run tabs', selector().textContent.includes('Fresh A') && !document.querySelector('.my-run-dock [role="tabpanel"]') && document.querySelectorAll('[role="tab"]').length === 0)
  check('root change resets dock geometry to collapsed bar', Math.abs(Number.parseFloat(getComputedStyle(document.querySelector('.my-root')).getPropertyValue('--my-run-dock-occupied-height')) - document.querySelector('.my-run-dock').getBoundingClientRect().height) < 1)
  const preferences = Object.keys(localStorage).filter(key => key.startsWith('tpanel.my.run.v1:')).map(key => JSON.parse(localStorage.getItem(key)))
  check('presentation persistence never caches runtime output or secret values', preferences.every(value => Object.keys(value).every(key => ['selectedId', 'dockHeight'].includes(key))))
  f.mount({ root: null, items: [], ipc: false }); await f.settle()
  check('no IPC has no run dock and cannot invoke native actions', !document.querySelector('.my-run-dock') && f.calls.length === 0 && f.button('添加运行配置').disabled)
  f.reset(); await f.settle(); check('unmount releases output and projection subscriptions', f.events.size === 0)
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
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: process.cwd(), contents: args.path === 'store'
      ? `import{create}from '${absolute('node_modules/zustand/esm/index.mjs')}';export const useApp=create(()=>({snapshot:null,openError:null,setPage:page=>window.applicationsFixture.calls.push(['page',page])}));`
      : args.path === 'my-store' ? `import{create}from '${absolute('node_modules/zustand/esm/index.mjs')}';export const useMy=create(set=>({sidebarCollapsed:false,toggleSidebar:()=>{},setPaletteOpen:()=>{},setToolView:toolView=>set({toolView})}));`
        : args.path === 'api' ? `export let hasIpc=true;export function setCapability(value){hasIpc=value}export const api=new Proxy({},{get:(_target,key)=>key==='gitWorkspace'?window.__applicationsApi[key]:(...args)=>window.__applicationsApi[key](...args)});`
          : `export function ProjectSwitcher(){return <button className="my-project-switcher no-drag my-control">示例项目</button>}` }))
  } }] })
  const sheets = ['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'my/my-utilities.css', 'my/my-applications.css', 'git-workspace/git-workspace.css', 'styles.css']
  const css = (await postcss([tailwind(config)]).process(sheets.map(file => readFileSync(renderer + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(temporary, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}.my-application-fixture-body{flex:1;min-height:0;overflow:auto;padding:var(--my-page-inset)}.fixture-source{padding:var(--my-space-16);margin-bottom:var(--my-space-16);border:1px solid var(--my-border-subtle);border-radius:var(--my-radius-md);font-size:var(--my-text-sm);color:var(--my-txt-secondary)}.fixture-source textarea{width:100%;background:var(--my-bg-layer-1);border:1px solid var(--my-border-subtle);margin-top:var(--my-space-8);padding:var(--my-space-8)}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  const serialize = fn => JSON.stringify('(' + fn.toString() + ')')
  writeFileSync(join(temporary, 'main.cjs'), `const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{writeFileSync}=require('node:fs');const{join}=require('node:path');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
const layout=${serialize(layoutChecks)},headerChecks=${serialize(headerChecks)},interactions=${serialize(interactionChecks)},screenshots=${JSON.stringify(screenshots)};
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,frame:false,width:960,height:720,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false,offscreen:Boolean(screenshots)}});const errors=[];w.webContents.on('console-message',details=>{if(details.level==='error'){errors.push(details.message);console.error(details.message)}});w.webContents.on('render-process-gone',(_event,details)=>{console.error(details);app.exit(1)});await w.loadFile(${JSON.stringify(join(temporary, 'index.html'))});
w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
const evaluate=(fn,arg)=>w.webContents.executeJavaScript(fn+'('+JSON.stringify(arg??null)+')');
const resize=async(width,height)=>{w.setContentSize(width,height);for(let i=0;i<30;i++){const size=await w.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');if(size.width===width&&size.height===height){await new Promise(done=>setTimeout(done,80));return;}await new Promise(done=>setTimeout(done,20))}throw Error('viewport resize timed out: '+JSON.stringify(await w.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')))};
// Wait for the committed state and compositor, not the next possibly stale offscreen paint.
const capture=async name=>{if(!screenshots)return;await w.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');await new Promise(done=>setTimeout(done,250));const state=await w.webContents.executeJavaScript('({theme:document.querySelector(".my-root").dataset.myTheme,size:document.querySelector(".my-root").dataset.myFontSize})');assert.equal(state.theme,name.split('-')[0],'capture theme matches requested state');assert.equal(state.size,name.split('-')[1],'capture font matches requested state');const result=await w.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const path=join(screenshots,name+'.png');writeFileSync(path,Buffer.from(result.data,'base64'));console.log('SCREENSHOT '+path)};
let count=0;for(const[width,height]of [[1100,800],[360,620]]){await resize(width,height);for(const theme of ['light','dark'])for(const size of ['small','standard','large']){const checks=await evaluate(layout,{theme,size});count+=checks.length;console.log('PASS '+theme+'/'+size+'/'+width+'x'+height+': '+checks.length+' workbench layout checks');if(screenshots&&(size==='standard'||(width===360&&size==='large'))){await capture(theme+'-'+size+'-'+width+'x'+height+'-dock');await w.webContents.executeJavaScript('window.applicationsFixture.button("编辑 后端服务").click();window.applicationsFixture.settle()');await capture(theme+'-'+size+'-'+width+'x'+height+'-configuration');await w.webContents.executeJavaScript('window.applicationsFixture.escape();window.applicationsFixture.settle()');}}}
let headerCount=0;await resize(960,620);for(const theme of ['light','dark'])for(const size of ['small','standard','large']){const checks=await evaluate(headerChecks,{theme,size});headerCount+=checks.length;checks.forEach(name=>console.log('PASS '+theme+'/'+size+'/960x620: '+name));if(screenshots&&size==='large')await capture(theme+'-'+size+'-960x620-header');}
// Use actual Chromium pointer input: synthetic PointerEvents do not own pointer capture.
await resize(1100,800);await evaluate(layout,{theme:'dark',size:'standard'});const grip=await w.webContents.executeJavaScript('(()=>{const r=document.querySelector("[role=separator]").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()');await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:grip.x,y:grip.y,button:'left',buttons:1,clickCount:1});await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:grip.x,y:1,button:'left',buttons:1});await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:grip.x,y:1,button:'left',buttons:0,clickCount:1});await w.webContents.executeJavaScript('window.applicationsFixture.settle()');assert.equal(await w.webContents.executeJavaScript('Math.abs(document.querySelector(".my-run-dock").getBoundingClientRect().height-innerHeight*.55)<2'),true,'captured pointer clamps at maximum');assert.equal(await w.webContents.executeJavaScript('window.applicationsFixture.calls.some(row=>row[0]==="stop")'),false,'pointer resize never stops service');console.log('PASS actual captured pointer resize and lifecycle isolation');
await resize(960,720);const checks=await evaluate(interactions);checks.forEach(name=>console.log('PASS '+name));assert.deepEqual(errors,[],'renderer console errors');assert.equal(w.isVisible(),false);console.log('Run workbench UI smoke passed: '+count+' mounted layout checks, '+headerCount+' real-header checks and '+checks.length+' selection/dock/config/log-generation checks.');w.destroy();app.exit(0);
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
  assert.ok(basename(temporary).startsWith('tpanel-run-workbench-ui-'))
  rmSync(temporary, { recursive: true, force: true })
}
