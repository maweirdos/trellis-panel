/** Real Vite/Oxc HMR + Chromium: changing a .ts hook must remount safely. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'tpanel-hook-refresh-')))
const require = createRequire(import.meta.url)
const before = `import {useState,useEffect} from 'react';
export function useProbe(){const[draft,setDraft]=useState(()=>localStorage.getItem('draft')??'');useEffect(()=>{localStorage.setItem('draft',draft)},[draft]);return{draft,setDraft,version:'before'}}`
const after = before.replace("const[draft,setDraft]", "const[archive]=useState('active');const[draft,setDraft]").replace("version:'before'", "version:'after'")
let server
try {
  await build({ entryPoints: ['scripts/vite-hook-refresh.ts'], outfile: join(directory, 'plugin.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['vite'], logLevel: 'silent' })
  // The bundled plugin lives outside node_modules; resolve Vite explicitly there.
  const pluginFile = join(directory, 'plugin.mjs')
  writeFileSync(pluginFile, readFileSync(pluginFile, 'utf8').replace('from "vite"', `from ${JSON.stringify(pathToFileURL(require.resolve('vite')).href)}`))
  const { reactHookRefresh } = await import(pathToFileURL(pluginFile).href)
  for (const fixed of [false, true]) {
    const root = join(directory, fixed ? 'fixed' : 'baseline')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(root)
    const hook = join(root, 'useProbe.ts')
    writeFileSync(hook, before)
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>')
    writeFileSync(join(root, 'Fixture.tsx'), `import React from 'react';import{useProbe}from'./useProbe';export function Fixture(){const{draft,setDraft,version}=useProbe();return <><input aria-label="draft" value={draft} onChange={event=>setDraft(event.target.value)}/><output>{version}</output></>}`)
    writeFileSync(join(root, 'main.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{Fixture}from'./Fixture';import{ErrorBoundary as Boundary}from'/@fs/${resolve('src/renderer/src/components/ErrorBoundary.tsx').replace(/\\/g, '/')}';
window.__errors=[];window.addEventListener('error',event=>window.__errors.push(String(event.error??event.message)));
createRoot(document.getElementById('root')).render(<React.StrictMode><Boundary><Fixture/></Boundary></React.StrictMode>);`)
    const hookPlugin = reactHookRefresh(root)
    assert.equal(hookPlugin.apply, 'serve', 'hook instrumentation must never enter production builds')
    server = await createServer({ root, configFile: false, cacheDir: join(root, '.vite'), logLevel: 'silent',
      plugins: [...(fixed ? [hookPlugin] : []), react()],
      resolve: { alias: [{ find: 'react-dom', replacement: resolve('node_modules/react-dom') }, { find: 'react', replacement: resolve('node_modules/react') }] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, process.cwd()] } } })
    await server.listen()
    const address = server.httpServer.address()
    const url = `http://127.0.0.1:${address.port}`
    const transformed = (await server.transformRequest('/useProbe.ts')).code
    assert.equal(transformed.includes('__tpanelHookSignature'), fixed, 'plain TypeScript hooks receive refresh signatures only with the fix')
    assert.equal(transformed.includes('createSignatureFunctionForTransform'), fixed, 'signatures use the real refresh runtime rather than the no-op preamble')
    const main = join(root, 'electron.cjs')
    writeFileSync(main, `const{app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(root, 'profile'))});app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:800,height:600,webPreferences:{contextIsolation:false,nodeIntegration:false}});
const wait=async(test,label)=>{for(let i=0;i<200;i++){if(await test())return;await new Promise(r=>setTimeout(r,30))}throw Error('timeout '+label)};
const evaluate=code=>win.webContents.executeJavaScript(code);
try{await win.loadURL(${JSON.stringify(url)});await wait(()=>evaluate("document.querySelector('output')?.textContent==='before'"),'initial mount');
await evaluate("(()=>{const field=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'retained draft');field.dispatchEvent(new Event('input',{bubbles:true}))})()");
await wait(()=>evaluate("localStorage.getItem('draft')==='retained draft'"),'draft saved');console.log('HOOK_REFRESH_READY');
await wait(()=>evaluate("document.querySelector('output')?.textContent==='after'||!!document.querySelector('[role=alert] pre')"),'hook update');
const state=await evaluate("({error:document.querySelector('[role=alert] pre')?.textContent,errors:window.__errors,version:document.querySelector('output')?.textContent,draft:document.querySelector('input')?.value})");
${fixed ? "if(state.error||state.errors.length||state.version!=='after'||state.draft!=='retained draft')throw Error(JSON.stringify(state));await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload()});await wait(()=>evaluate(\"document.querySelector('output')?.textContent==='after'\"),'cold reload');if(!await evaluate(\"document.querySelector('input').value==='retained draft'\"))throw Error('cold reload lost draft');console.log('PASS signed .ts hook structural HMR and cold reload preserve persisted draft without a render error');" : "if(!/Should have a queue|Rendered more hooks|Rendered fewer hooks/.test(state.error??''))throw Error('baseline did not reproduce hook mismatch '+JSON.stringify(state));if(!await evaluate(\"document.querySelector('[role=alert] details').open===false&&!document.body.innerText.includes('preload')\"))throw Error('error details must default closed without guessed cause');await evaluate(\"[...document.querySelectorAll('button')].find(button=>button.textContent==='重试页面').click()\");await wait(()=>evaluate(\"document.querySelector('output')?.textContent==='after'\"),'retry page');console.log('PASS baseline reproduces unsigned .ts hook crash; actual boundary has collapsed details and working page retry');"}
app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}});setTimeout(()=>app.exit(1),20000);`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    await new Promise((done, reject) => {
      const child = spawn(require('electron'), [main, '--no-sandbox'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const timeout = setTimeout(() => { child.kill(); reject(new Error('hook refresh probe timed out')) }, 25000)
      let output = '', errors = '', changed = false
      child.stdout.on('data', bytes => {
        output += String(bytes)
        if (!changed && output.includes('HOOK_REFRESH_READY')) { changed = true; writeFileSync(hook, after) }
      })
      child.stderr.on('data', bytes => { errors += String(bytes) })
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? (process.stdout.write(output), done()) : reject(new Error(output + errors)) })
    })
    await server.close(); server = undefined
  }
} finally {
  await server?.close()
  assert.equal(dirname(resolve(directory)), realpathSync.native(tmpdir()))
  assert.ok(basename(directory).startsWith('tpanel-hook-refresh-'))
  rmSync(directory, { recursive: true, force: true })
}
