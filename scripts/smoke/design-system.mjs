/** Shared-source and real Chromium component checks; does not start a provider session. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import config from '../../tailwind.config.js'

const read = file => readFileSync(file, 'utf8')
const root = 'src/renderer/src/'
const tokens = read(root + 'my/my-tokens.css')
const sources = [...globSync(root + '**/*.{ts,tsx,css}')].map(read).join('\n') + read('tailwind.config.js')
for (const file of globSync(root + '**/*.tsx')) {
  if (file.replace(/\\/g, '/') !== root + 'App.tsx') assert.doesNotMatch(read(file), /className=["'][^"']*\bmy-root\b/, `only App owns typography roots: ${file}`)
}
assert.doesNotMatch(sources, /--leaf-|(?:bg|text|border)-leaf\b|@fontsource-variable\/inter/)
assert.doesNotMatch(sources, /(?:text-\[\d+(?:\.\d+)?px\]|rounded-\[\d+(?:\.\d+)?px\])/)
const declared = new Set([...sources.matchAll(/(--my-[\w-]+)['"]?\s*:/g)].map(match => match[1]))
for (const [, reference] of sources.matchAll(/var\((--my-[\w-]+)\s*\)/g)) assert.ok(declared.has(reference), `undefined token ${reference}`)
const tokenTree = postcss.parse(tokens)
const base = Object.fromEntries(tokenTree.nodes.find(node => node.type === 'rule' && node.selector.replace(/\s/g, '') === ':root,.my-root').nodes.map(node => [node.prop, node.value]))
const themes = Object.fromEntries(['light', 'dark'].map(theme => {
  const rule = tokenTree.nodes.find(node => node.type === 'rule' && node.selector.includes(`[data-my-theme='${theme}']`))
  return [theme, { ...base, ...Object.fromEntries(rule.nodes.map(node => [node.prop, node.value])) }]
}))
for (const [theme, values] of Object.entries(themes)) {
  const visit = (name, trail = []) => {
    assert.ok(!trail.includes(name), `${theme} circular token ${[...trail, name].join(' -> ')}`)
    for (const [, next] of (values[name] ?? '').matchAll(/var\((--my-[\w-]+)/g)) visit(next, [...trail, name])
  }
  for (const name of Object.keys(values)) visit(name)
}
const markPath = read('resources/brand/mark.svg').match(/<path[^>]+d="([^"]+)"/)[1]
assert.ok(read('src/renderer/public/favicon.svg').includes(markPath), 'favicon derives from the canonical mark')
assert.ok(read('src/renderer/src/my/BrandMark.tsx').includes('resources/brand/mark.svg?url'))
const ico = readFileSync('resources/brand/icon.ico')
const appId = read('electron-builder.yml').match(/^appId:\s*(\S+)/m)[1]
assert.ok(read('src/main/index.ts').includes(`app.setAppUserModelId('${appId}')`), 'native taskbar identity matches the packaged application')
assert.equal(ico.readUInt16LE(2), 1)
assert.equal(ico.readUInt16LE(4), 7)
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  const png = readFileSync(`resources/brand/icon-${size}.png`)
  assert.equal(png.readUInt32BE(16), size)
  assert.equal(png.readUInt32BE(20), size)
}
console.log('PASS canonical tokens, dependency graph, no legacy brand, same-source brand assets')

const directory = mkdtempSync(join(tmpdir(), 'tpanel-design-system-'))
const absolute = path => resolve(path).replace(/\\/g, '/')
const fixture = `import React,{useState} from '${absolute('node_modules/react/index.js')}';
import{createRoot}from '${absolute('node_modules/react-dom/client.js')}';
import{Button,Checkbox,Dropdown,DropdownItem,Modal,SearchInput,Avatar}from '${absolute(root + 'my/ui.tsx')}';
import{BrandMark}from '${absolute(root + 'my/BrandMark.tsx')}';
function Fixture(){const[cfg,set]=useState({theme:'dark',size:'standard'});window.setFixture=set;return <div id="fixture" className="my-root" data-my-theme={cfg.theme} data-my-font-size={cfg.size} style={{minHeight:'100%',padding:24}}>
<BrandMark/><Avatar name="本" color="var(--my-bg-accent-primary)" tone="accent"/>
<Button variant="primary" data-test="primary">开始工作</Button><Button variant="danger" data-test="danger">删除</Button><Button disabled>禁用</Button>
<Checkbox checked onChange={()=>{}}/><input data-test="field" className="my-input" placeholder="输入内容"/><select className="my-input"><option>选择项目</option></select><textarea className="my-input" rows={2}/>
<SearchInput value="" onChange={()=>{}} placeholder="搜索"/>
<Dropdown width={240} trigger={({toggle})=><Button onClick={toggle}>打开菜单</Button>}>{()=> <><DropdownItem selected>已选择</DropdownItem><DropdownItem disabled>不可用</DropdownItem></>}</Dropdown>
<div data-test="composer" className="acp-composer"><textarea aria-label="会话草稿" defaultValue="保留的草稿"/></div>
<div data-test="utility" className="bg-transparent">透明窗体</div>
<Modal open={Boolean(cfg.modal)} onClose={()=>set({...cfg,modal:false})}><Button>弹窗</Button></Modal>
</div>};createRoot(document.getElementById('root')).render(<Fixture/>);`
const cssFiles = ['my/my-tokens.css', 'my/my-components.css', 'my/my-shell.css', 'styles.css', 'acp/workspace.css']
try {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, fixture)
  await build({ entryPoints: [entry], outfile: join(directory, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [absolute('node_modules')], loader: { '.svg':'dataurl' }, plugins: [{ name:'svg-url', setup(builder) { builder.onResolve({filter:/\.svg\?url$/}, args => ({path:resolve(dirname(args.importer),args.path.replace(/\?url$/,''))})) } }] })
  const css = (await postcss([tailwind(config)]).process(cssFiles.map(file=>read(root+file)).join('\n'), {from:undefined})).css
  writeFileSync(join(directory,'index.html'), `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}#fixture{box-sizing:border-box}#fixture>.my-input{display:block;margin-block:8px;max-width:320px}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  await build({entryPoints:['src/main/services/window-appearance.ts'],outfile:join(directory,'appearance.cjs'),bundle:true,platform:'node',format:'cjs'})
  writeFileSync(join(directory,'main.cjs'), `const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{mainWindowAppearance,applyMainWindowAppearance}=require('./appearance.cjs');
app.setPath('userData',${JSON.stringify(join(directory,'profile'))});app.disableHardwareAcceleration();
const values=${JSON.stringify(themes)};
for(const theme of ['light','dark']){const appearance=mainWindowAppearance(theme,'win32');assert.equal(appearance.backgroundColor,values[theme]['--my-bg-canvas']);assert.ok(appearance.accentColor);assert.equal(mainWindowAppearance(theme,'linux').accentColor,undefined);}
const calls=[];applyMainWindowAppearance({isDestroyed:()=>false,setBackgroundColor:v=>calls.push(v),setAccentColor:v=>calls.push(v)},'light','win32');assert.equal(calls.length,2);
applyMainWindowAppearance({isDestroyed:()=>true,setBackgroundColor:()=>{throw Error('destroyed')},setAccentColor:()=>{throw Error('destroyed')}},'dark','win32');
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});await w.loadFile(${JSON.stringify(join(directory,'index.html'))});
// Emulate focus without stealing OS focus; reduced motion makes steady-state style assertions deterministic.
w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
const result=await w.webContents.executeJavaScript(\`(async()=>{
const wait=()=>new Promise(r=>setTimeout(r,60));await wait();
const check=(name,condition,detail)=>{if(!condition)throw Error(name+': '+JSON.stringify(detail));return name};const passed=[];
const color=value=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]};
const lum=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=lum(color(a)),y=lum(color(b));return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
for(const theme of ['dark','light'])for(const[size,px]of[['small',13],['standard',14],['large',15]]){
window.setFixture({theme,size});await wait();const f=document.getElementById('fixture'),p=f.querySelector('[data-test=primary]'),d=f.querySelector('[data-test=danger]'),c=getComputedStyle(p);
passed.push(check(theme+'/'+size+' shared font and inverse contrast',getComputedStyle(f).fontSize===px+'px'&&contrast(c.color,c.backgroundColor)>=7&&contrast(getComputedStyle(d).color,getComputedStyle(d).backgroundColor)>=4.5,{font:getComputedStyle(f).fontSize,primary:contrast(c.color,c.backgroundColor),danger:contrast(getComputedStyle(d).color,getComputedStyle(d).backgroundColor)}));
const fields=f.querySelectorAll('input.my-input:not(.my-search-input),select.my-input');passed.push(check(theme+'/'+size+' field geometry',Math.abs(fields[0].getBoundingClientRect().height-fields[1].getBoundingClientRect().height)<.1&&c.borderRadius==='10px'&&getComputedStyle(f.querySelector('[data-test=composer]')).borderRadius==='20px'));
passed.push(check(theme+'/'+size+' transparent utility root',getComputedStyle(f.querySelector('[data-test=utility]')).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(f.querySelector('[data-test=utility]')).fontSize===px+'px',{background:getComputedStyle(f.querySelector('[data-test=utility]')).backgroundColor,font:getComputedStyle(f.querySelector('[data-test=utility]')).fontSize,expected:px}));}
window.setFixture({theme:'light',size:'standard'});await wait();[...document.querySelectorAll('button')].find(b=>b.textContent==='打开菜单').click();await wait();const m=document.querySelector('.my-menu'),rect=m.getBoundingClientRect();passed.push(check('actual shared menu radius and viewport clamp',getComputedStyle(m).borderRadius==='18px'&&rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight));
passed.push(check('selected and disabled menu states',[...m.querySelectorAll('button')].some(b=>b.dataset.selected==='true')&&[...m.querySelectorAll('button')].some(b=>b.disabled)));
document.querySelector('[data-test=field]').focus();await wait();passed.push(check('keyboard focus is visible',(getComputedStyle(document.activeElement).outlineStyle!=='none'||getComputedStyle(document.activeElement).boxShadow!=='none'),{tag:document.activeElement.tagName,outline:getComputedStyle(document.activeElement).outlineStyle,shadow:getComputedStyle(document.activeElement).boxShadow,focus:document.activeElement.matches(':focus'),hasFocus:document.hasFocus(),token:getComputedStyle(document.activeElement).getPropertyValue('--my-focus-shadow')}));
window.setFixture({theme:'dark',size:'large',modal:true});await wait();passed.push(check('shared modal has accessible viewport width',document.querySelector('.my-modal-panel').getBoundingClientRect().width<=innerWidth));
passed.push(check('font changes preserve live input value',document.querySelector('[aria-label="会话草稿"]').value==='保留的草稿'));
passed.push(check('reduced motion suppresses nonessential transitions',parseFloat(getComputedStyle(document.querySelector('[data-test=primary]')).transitionDuration)<.001));
return passed;})()\`);
for(const name of result)console.log('PASS '+name);
w.setContentSize(360,720);await w.webContents.executeJavaScript('new Promise(r=>setTimeout(r,60))');const narrow=await w.webContents.executeJavaScript('document.querySelector(".my-modal-panel").getBoundingClientRect().right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth');assert.ok(narrow,'narrow modal without document overflow');console.log('PASS 360px modal and native theme mapping');app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});setTimeout(()=>{console.error('design-system fixture timed out');app.exit(1)},30000);`)
  const require=createRequire(import.meta.url)
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const result=await promisify(execFile)(require('electron'),[join(directory,'main.cjs'),'--no-sandbox'],{env,windowsHide:true,timeout:40000,maxBuffer:1024*1024})
  process.stdout.write(result.stdout)
  console.log('Design-system smoke passed: 6 theme/font combinations, shared controls, native paint and brand resources.')
} catch(error) {
  if(error.stdout)process.stdout.write(error.stdout)
  if(error.stderr)process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith('tpanel-design-system-'))
  rmSync(directory,{recursive:true,force:true})
}
