/** Mounted production role editors and delivery inspector; fixture IPC, no native Agent. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import config from '../../tailwind.config.js'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-agent-context-ui-'))
const captures = process.env.TPANEL_AGENT_CONTEXT_CAPTURE_DIR ? resolve(process.env.TPANEL_AGENT_CONTEXT_CAPTURE_DIR) : null
if (captures) mkdirSync(captures, { recursive: true })
try {
  await build({ entryPoints: [resolve('tests/agent-runtime/fixtures/acp-agent-context-ui.jsx')], outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: resolve('tsconfig.web.json'), loader: { '.svg': 'dataurl', '.png': 'dataurl' } })
  const css = (await postcss([tailwind(config)]).process(['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'styles.css', 'acp/workspace.css'].map((file) => readFileSync('src/renderer/src/' + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(directory, 'index.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}html,body,#root,.my-root{min-height:100%;margin:0}.my-root{background:var(--my-bg-canvas)}</style></head><body><div id="root"></div><script>window.trellis={}</script><script src="renderer.js"></script></body></html>`)
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{writeFileSync}=require('node:fs');
app.whenReady().then(async()=>{
  const window=new BrowserWindow({show:false,width:760,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  const errors=[];window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message)});
  await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
  window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const run=async source=>{try{return await window.webContents.executeJavaScript(source)}catch(error){console.error('Failed renderer assertion: '+source);throw error}};
  const wait=()=>new Promise(resolve=>setTimeout(resolve,35));
  const until=async(source,label)=>{for(let i=0;i<100;i++){if(await run(source))return;await wait()}throw Error('Deadline: '+label)};
  const configure=async patch=>{await run('window.configureFixture('+JSON.stringify(patch)+')');await wait()};
  const text=()=>run('document.querySelector("main").textContent');
  const click=async(label,selector='button')=>{await until('[...document.querySelectorAll('+JSON.stringify(selector)+')].some(e=>e.textContent.includes('+JSON.stringify(label)+')&&!e.disabled)','enabled '+label);await run('(()=>{const e=[...document.querySelectorAll('+JSON.stringify(selector)+')].find(e=>e.textContent.includes('+JSON.stringify(label)+'));if(!e)throw Error("Missing control: "+'+JSON.stringify(label)+');e.click()})()');await wait()};
  const check=async(name)=>{await run('(()=>{const e=[...document.querySelectorAll("label")].find(e=>e.textContent.includes('+JSON.stringify(name)+'));if(!e)throw Error("Missing skill: "+'+JSON.stringify(name)+');e.querySelector("input[type=checkbox]").click()})()');await wait()};
  const release=async(index,entries)=>{await run('contextFixture.scans['+index+'].resolve(contextFixture.ok('+entries+'))');await wait()};
  const scanCount=()=>run('contextFixture.scans.length');
  const capture=async name=>{if(${JSON.stringify(captures)}){await window.webContents.capturePage();await wait();writeFileSync(${JSON.stringify(captures)}+'/'+name+'.png',(await window.webContents.capturePage()).toPNG())}};
  await until('contextFixture.scans.length===1','initial scan');
  assert.ok((await text()).includes('正在读取项目技能'));
  await release(0,'[contextFixture.skill("D:/project/.agents/skills/review/SKILL.md"),contextFixture.skill("d:\\\\PROJECT\\\\.agents\\\\skills\\\\review\\\\SKILL.md","重复技能"),contextFixture.skill("D:/project-other/.agents/skills/outside/SKILL.md","ROOT SIBLING"),contextFixture.skill("D:/outside/SKILL.md","OUTSIDE"),contextFixture.skill("D:/project/../escape/SKILL.md","TRAVERSAL"),contextFixture.skill("D:/project/.agents/skills/no/README.md","NOT A SKILL"),contextFixture.skill("D:/project/commands/SKILL.md","COMMAND","command")]');
  assert.equal(await run('document.querySelectorAll("input[type=checkbox]").length'),1,'only contained canonical skill, Windows duplicate removed');
  assert.ok((await text()).includes('需求审阅')&&(await text()).includes('检查验收边界'));
  await check('需求审阅');assert.deepEqual(await run('window.selection'),['.agents/skills/review/SKILL.md']);
  assert.ok((await text()).includes('已选 1 / 32'));
  console.log('PASS skill names/descriptions, controlled selection and project/root/path guards');

  await configure({key:100});const oldA=await scanCount()-1;await configure({root:'D:/B'});const oldB=await scanCount()-1;await configure({root:'D:/project'});const newA=await scanCount()-1;
  await release(oldB,'[contextFixture.skill("D:/B/.agents/skills/stale/SKILL.md","STALE B")]');
  await release(newA,'[contextFixture.skill("D:/project/.agents/skills/fresh/SKILL.md","FRESH A")]');
  await release(oldA,'[contextFixture.skill("D:/project/.agents/skills/old/SKILL.md","STALE A")]');
  assert.ok((await text()).includes('FRESH A')&&!(await text()).includes('STALE'));
  console.log('PASS A → B → A ignores superseded scan responses');

  await configure({root:'D:/closed'});const closed=await scanCount()-1;await configure({open:false});await release(closed,'[contextFixture.skill("D:/closed/x/SKILL.md","CLOSED RESPONSE")]');
  await configure({root:'D:/project',open:true});const reopened=await scanCount()-1;
  await run('contextFixture.scans['+reopened+'].reject("项目扫描不可用")');await wait();
  assert.ok((await text()).includes('项目扫描不可用')&&(await text()).includes('已保留选择'));
  assert.deepEqual(await run('window.selection'),['.agents/skills/review/SKILL.md']);
  await click('重试读取技能');const retry=await scanCount()-1;await release(retry,'[]');
  assert.ok((await text()).includes('未在本次扫描中找到')&&(await text()).includes('.agents/skills/review/SKILL.md'));
  await capture('missing-selection');
  console.log('PASS closed/unmounted scans, recoverable errors, retry and missing selections retain drafts');

  await configure({root:'D:/suspended'});const suspended=await scanCount()-1;await configure({active:false});await release(suspended,'[contextFixture.skill("D:/suspended/a/SKILL.md","HIDDEN RESPONSE")]');
  assert.ok(!(await text()).includes('HIDDEN RESPONSE'));await configure({active:true});const resumed=await scanCount()-1;await release(resumed,'[]');
  await configure({root:'D:/not-current'});const notCurrent=await scanCount()-1;await configure({current:false});await release(notCurrent,'[contextFixture.skill("D:/not-current/a/SKILL.md","FOREIGN OWNER")]');
  assert.ok(!(await text()).includes('FOREIGN OWNER'));await configure({current:true,root:'D:/project'});await release(await scanCount()-1,'[]');
  console.log('PASS hidden and no-longer-current owners reject async scan results');

  await run('contextFixture.scanMode("immediate",contextFixture.ok(Array.from({length:33},(_,i)=>contextFixture.skill("D:/project/.agents/skills/s"+i+"/SKILL.md","Skill "+i))))');
  await configure({key:1,value:Array.from({length:32},(_,i)=>'.agents/skills/s'+i+'/SKILL.md')});
  assert.equal(await run('[...document.querySelectorAll("input[type=checkbox]")].filter(e=>e.disabled&&!e.checked).length'),1);
  await check('Skill 32');assert.equal(await run('window.selection.length'),32);
  await check('Skill 0');await check('Skill 32');assert.equal(await run('window.selection.length'),32);assert.ok(await run('window.selection.includes(".agents/skills/s32/SKILL.md")'));
  console.log('PASS selection limit disables additions and permits replacing selected skills');

  await run('contextFixture.scanMode("immediate",contextFixture.ok([contextFixture.skill("D:/project/.agents/skills/review/SKILL.md")]))');
  await configure({mode:'editor',key:2,profile:{id:'role',name:'需求助手',description:'需求分析',runtimeId:'codex',instructions:'保留原始需求。',maxTurnMinutes:30,skillPaths:[],createdAt:1,updatedAt:1}});
  await check('需求审阅');await run('contextFixture.saveError("技能文件已变化")');await click('保存角色');
  assert.ok((await text()).includes('技能文件已变化'));assert.equal(await run('document.querySelector("input[type=checkbox]").checked'),true);
  assert.deepEqual(await run('contextFixture.saves.at(-1).skillPaths'),['.agents/skills/review/SKILL.md']);
  await run('contextFixture.saveError("")');await click('保存角色');assert.deepEqual(await run('contextFixture.callbacks.at(-1).skillPaths'),['.agents/skills/review/SKILL.md']);
  console.log('PASS all-default editor saves real selections through acpProfileSave and retains failed drafts');

  await configure({mode:'role',key:3,profile:{id:'role',name:'需求助手',description:'需求分析',runtimeId:'codex',instructions:'FUTURE DEFAULT INSTRUCTIONS',maxTurnMinutes:30,skillPaths:[],createdAt:1,updatedAt:1},historical:true});
  assert.ok((await text()).includes('本会话技能快照 · 1 个')&&(await text()).includes('frozen/SKILL.md'));
  await check('需求审阅');await run('contextFixture.saveError("保存不可用")');await click('保存修改');
  assert.ok((await text()).includes('保存不可用'));assert.equal(await run('document.querySelector("input[type=checkbox]").checked'),true);
  await run('contextFixture.saveError("")');await click('保存修改');
  assert.equal(await run('contextFixture.saves.at(-1).instructions'),'FUTURE DEFAULT INSTRUCTIONS','future defaults do not start from old session snapshot');
  assert.deepEqual(await run('contextFixture.callbacks.at(-1).skillPaths'),['.agents/skills/review/SKILL.md']);
  assert.ok((await text()).includes('frozen/SKILL.md'));
  await configure({section:'overview'});assert.ok((await text()).includes('已选 1 个'));
  await configure({section:'skills',deleted:true});assert.equal(await run('document.querySelectorAll("input[type=checkbox]").length'),0,'deleted default cannot be recreated from frozen session');
  console.log('PASS role skills save/error state, selected count, future defaults and frozen historical snapshot');

  await run('configureFixture({mode:"role",section:"instructions",historical:true,deleted:false,key:33,profile:{...contextFixture.profile,instructions:"LATEST DEFAULT",skillPaths:[".agents/skills/new/SKILL.md"]}})');await wait();
  await run('(()=>{const input=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"EDITED CURRENT INSTRUCTIONS");input.dispatchEvent(new Event("input",{bubbles:true}))})()');await wait();
  await click('保存修改');
  assert.deepEqual(await run('contextFixture.saves.at(-1).skillPaths'),['.agents/skills/new/SKILL.md'],'editing historical instructions must preserve latest skill defaults');
  assert.equal(await run('contextFixture.saves.at(-1).instructions'),'EDITED CURRENT INSTRUCTIONS');
  console.log('PASS historical instruction edits preserve newer default skill bindings');

  await configure({mode:'session',key:4,session:{}});
  let summary=await run('[...document.querySelectorAll("summary")].find(e=>e.textContent.startsWith("角色与技能交付"))?.textContent');
  assert.equal(summary,'角色与技能交付 · 已发送');
  assert.equal(await run('[...document.querySelectorAll("details")].find(e=>e.querySelector("summary")?.textContent.startsWith("角色与技能交付")).open'),false);
  await click('角色与技能交付','summary');
  assert.ok((await text()).includes('需求审阅')&&(await text()).includes('generation-1 / turn-1'));
  assert.ok(!(await text()).includes('已加载')&&!(await text()).includes('已应用')&&!(await text()).includes('已生效'));
  assert.equal(await run('document.querySelectorAll("input,textarea,button").length'),0,'historical delivery remains read-only');
  await capture('historical-sent');
  await configure({session:{agentContext:{state:'not_sent',method:'embedded-resource',revision:'b'.repeat(64),uri:'trellis-agent-context://not-sent',instructionsProvided:false,skills:[],connectionGeneration:'generation-1',turnId:'turn-1'}}});
  assert.ok((await text()).includes('角色与技能交付 · 未发送'));
  await capture('historical-not-sent');
  await configure({session:{agentContext:{state:'prepared',method:'embedded-resource',revision:'c'.repeat(64),uri:'trellis-agent-context://prepared',instructionsProvided:true,skills:[],connectionGeneration:'generation-1',turnId:'turn-1'}}});
  assert.ok((await text()).includes('角色与技能交付 · 已准备'));
  for(const patch of [{connectionGeneration:'different-generation'},{turnId:'different-turn'},{turnId:undefined},{connectionGeneration:undefined}]){
    await run('configureFixture({session:{...contextFixture.session,...'+JSON.stringify(patch)+',agentContext:contextFixture.context}})');await wait();
    // JSON omits undefined; explicitly clear absent scope fields below.
    if(Object.hasOwn(patch,'turnId')&&patch.turnId===undefined)await run('configureFixture({session:{...contextFixture.session,turnId:undefined,agentContext:contextFixture.context}})');
    if(Object.hasOwn(patch,'connectionGeneration')&&patch.connectionGeneration===undefined)await run('configureFixture({session:{...contextFixture.session,connectionGeneration:undefined,agentContext:contextFixture.context}})');
    await wait();assert.ok((await text()).includes('角色与技能交付 · 未记录本轮回执'));assert.ok(!(await text()).includes('需求审阅'));
  }
  console.log('PASS sent/not_sent/prepared history is read-only, exact generation/turn required, no fake applied/loaded claims');

  for(const theme of ['light','dark']){
    window.setContentSize(320,760);await configure({mode:'role',historical:false,deleted:false,section:'skills',key:10+(theme==='dark'?1:0),theme,size:'large'});
    assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false,'narrow '+theme+' no horizontal overflow');
    const checkboxes=await run('[...document.querySelectorAll("input[type=checkbox]")].map(e=>({label:!!e.closest("label")?.textContent.trim(),w:e.getBoundingClientRect().width}))');assert.ok(checkboxes.every(e=>e.label&&e.w>0));
    await capture('skills-'+theme+'-narrow');
  }
  assert.deepEqual(errors,[],'no React errors');console.log('PASS light/dark narrow rendered controls and clean React mount');
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});setTimeout(()=>{console.error('Agent context UI timed out');app.exit(1)},45000);`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [join(directory, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 50000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
  console.log('ACP agent context UI passed (mounted renderer with fixture IPC; no provider session).')
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith('tpanel-agent-context-ui-'))
  rmSync(directory, { recursive: true, force: true })
}
