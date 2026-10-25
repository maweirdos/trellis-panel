/** Actual Console + history hook over isolated delayed IPC. No native providers. */
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
import config from '../../tailwind.config.js'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-conversation-switching-'))
const absolute = path => resolve(path).replaceAll('\\', '/')
try {
  const store = `import{create}from'${absolute('node_modules/zustand/esm/index.mjs')}';export const useApp=create(set=>({snapshot:{meta:{root:'D:/switching-fixture'},tasks:[]},page:'acp',pushToast(){},setPage:page=>set({page}),showTask(){},openArtifact(){}}));`
  const my = `import{create}from'${absolute('node_modules/zustand/esm/index.mjs')}';export const useMy=create(set=>({sidebarWidth:260,sidebarCollapsed:false,fontSize:'standard',setSidebarWidth:sidebarWidth=>set({sidebarWidth}),toggleSidebar:()=>set(s=>({sidebarCollapsed:!s.sidebarCollapsed})),requestAgentView:agentTarget=>set({agentTarget}),setAgentSessionTarget:agentSessionTarget=>set({agentSessionTarget}),setSettingsView(){}}));`
  await build({ entryPoints: [resolve('tests/agent-runtime/fixtures/conversation-switching-ui.jsx')], outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: resolve('tsconfig.web.json'), loader: { '.svg': 'dataurl', '.png': 'dataurl' }, plugins: [{ name: 'isolated-switching-host', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const path = absolute(resolve(dirname(args.importer || '.'), args.path))
      if (path === absolute('src/renderer/src/api')) return { path: 'api', namespace: 'fixture' }
      if ([absolute('src/renderer/src/store'), absolute('src/renderer/src/store/index.ts')].includes(path)) return { path: 'store', namespace: 'fixture' }
      if ([absolute('src/renderer/src/my/store'), absolute('src/renderer/src/my/store.ts')].includes(path)) return { path: 'my', namespace: 'fixture' }
      if (args.path.endsWith('.css')) return { path: 'css', namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: process.cwd(), contents: args.path === 'store' ? store : args.path === 'my' ? my : args.path === 'api' ? 'export const hasIpc=true;export const api=new Proxy({},{get:(_target,key)=>window.fixtureApi?.[key]});' : '' }))
  } }] })
  const css = (await postcss([tailwind(config)]).process(['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'styles.css', 'acp/workspace.css'].map(file => readFileSync('src/renderer/src/' + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body,#root,.my-root{height:100%;margin:0}[hidden]{display:none!important}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  writeFileSync(join(directory, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('switchingBridge',{invoke:(name,args)=>ipcRenderer.invoke('switching:'+name,args),on:(name,callback)=>{const listener=(_event,payload)=>callback(payload);ipcRenderer.on('switching:'+name,listener);return()=>ipcRenderer.removeListener('switching:'+name,listener)}});`)
  const host = readFileSync('tests/agent-runtime/fixtures/conversation-switching-host.cjs', 'utf8')
  writeFileSync(join(directory, 'main.cjs'), host)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [join(directory, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith('tpanel-conversation-switching-'))
  rmSync(directory, { recursive: true, force: true })
}
