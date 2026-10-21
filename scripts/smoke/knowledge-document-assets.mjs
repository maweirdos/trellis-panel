/** Artifact-bound images and local open through real registered IPC/preload; no external apps. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-knowledge-document-assets-'))
const absolute = path => resolve(path).replace(/\\/g, '/')
const renderer = `import React,{useState}from'${absolute('node_modules/react/index.js')}';
import{createRoot}from'${absolute('node_modules/react-dom/client.js')}';
import{flushSync}from'${absolute('node_modules/react-dom/index.js')}';
import{MarkdownView}from'${absolute('src/renderer/src/components/MarkdownView.tsx')}';
import{InteractionScope}from'${absolute('src/renderer/src/utils/interaction-scope.tsx')}';
import{useApp}from'${absolute('src/renderer/src/store/index.ts')}';
window.unhandled=[];addEventListener('unhandledrejection',e=>window.unhandled.push(String(e.reason)));
window.handledHrefs=[];window.linkMode='false';
const link=href=>{window.handledHrefs.push(href);if(window.linkMode==='true')return true;if(window.linkMode==='error')throw Error('Synthetic known receipt rejected');if(window.linkMode==='defer')return new Promise(resolve=>{window.releaseLink=()=>resolve(false)});return false};
function Fixture(){const[state,set]=useState({context:null,content:'',active:true});window.mountDocument=(context,content)=>{useApp.setState({snapshot:{meta:{root:context.expectedRoot},tasks:[],archived:[]}});flushSync(()=>set(s=>({...s,context,content})))};window.readingActive=active=>flushSync(()=>set(s=>({...s,active})));window.readingRoot=root=>useApp.setState({snapshot:{meta:{root},tasks:[],archived:[]}});return <InteractionScope active={state.active}>{state.context&&<MarkdownView content={state.content} documentAssetContext={state.context} onOpenDocumentLink={link}/>}</InteractionScope>};createRoot(document.getElementById('root')).render(<Fixture/>);`

async function nativeChecks() {
  const assert = require('node:assert/strict')
  const fs = require('node:fs')
  const { app, BrowserWindow, nativeImage, shell, session } = require('electron')
  const { join } = require('node:path')
  const { pathToFileURL } = require('node:url')
  app.setPath('userData', join(__dirname, 'profile'))
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('no-proxy-server')
  const opened = [], requests = [], errors = []
  let failOpener = false, assertions = 0
  const check = (condition, message) => { assert.ok(condition, message); assertions++ }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async predicate => { const deadline = Date.now() + 5000; while (!await predicate()) { if (Date.now() > deadline) throw Error('Fixture condition timed out'); await delay(15) } }
  shell.openExternal = async url => { opened.push(url); if (failOpener) throw Error('Owned OS opener failure') }
  process.on('unhandledRejection', error => errors.push(String(error)))
  await app.whenReady()
  const boundary = require('./boundary.cjs')
  const project = join(__dirname, 'project'), other = join(__dirname, 'other'), outside = join(__dirname, 'outside')
  for (const root of [project, other, outside]) fs.mkdirSync(root)
  const notes = join(project, '.trellis', 'notes'), images = join(notes, 'images')
  fs.mkdirSync(images, { recursive: true })
  const body = '# Saved revision A\n\n![Flow](./images/chart%20one.png)'
  const artifact = { id: 'artifact-a', title: 'Saved A', relativePath: '.trellis/notes/requirements.md', body, sessionId: 'session-a', turnId: 'turn-a', createdAt: 1, kind: 'product-requirements', sourceIds: [], confirmed: false }
  artifact.revision = boundary.hash(body)
  fs.writeFileSync(join(notes, 'requirements.md'), body)
  boundary.setProjectRoot(project)
  boundary.addArtifact(project, artifact)
  const context = { expectedRoot: project, sessionId: artifact.sessionId, artifactId: artifact.id, revision: artifact.revision }
  const png = nativeImage.createFromBitmap(Buffer.from([255, 80, 0, 255]), { width: 1, height: 1 }).toPNG()
  fs.writeFileSync(join(images, 'chart one.png'), png)
  fs.writeFileSync(join(images, 'chart.jpg'), nativeImage.createFromBuffer(png).toJPEG(90))
  fs.writeFileSync(join(images, 'fake.png'), Buffer.from('This is not an image'))
  fs.writeFileSync(join(images, 'wrong-extension.png'), nativeImage.createFromBuffer(png).toJPEG(90))
  const fakeHeader = Buffer.alloc(24); png.copy(fakeHeader, 0, 0, 24)
  fs.writeFileSync(join(images, 'header-only.png'), fakeHeader)
  const giant = Buffer.from(fakeHeader); giant.writeUInt32BE(65535, 16); giant.writeUInt32BE(65535, 20)
  fs.writeFileSync(join(images, 'huge-pixels.png'), giant)
  fs.writeFileSync(join(images, 'too-big.png'), Buffer.alloc(boundary.maxBytes + 1))
  fs.mkdirSync(join(images, 'folder.png'))
  fs.writeFileSync(join(outside, 'outside.png'), png)
  fs.symlinkSync(outside, join(images, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir')
  fs.symlinkSync(images, join(images, 'inside-link'), process.platform === 'win32' ? 'junction' : 'dir')
  boundary.registerKnowledgeAccessIpc()
  boundary.registerFilesIpc()
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const allowed = details.url.startsWith('file:') || details.url.startsWith('data:')
    if (!allowed) requests.push(details.url)
    done({ cancel: !allowed })
  })
  const makeWindow = preload => new BrowserWindow({ show: false, webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: false, backgroundThrottling: false } })
  const w = makeWindow(join(__dirname, 'preload.cjs'))
  const js = code => w.webContents.executeJavaScript(code, true)
  const windows = [w]
  try {
    await w.loadFile(join(__dirname, 'index.html'))
    await until(() => js('typeof window.mountDocument === "function"'))
    const webp = await js('(()=>{const c=document.createElement("canvas");c.width=1;c.height=1;c.getContext("2d").fillRect(0,0,1,1);return c.toDataURL("image/webp").split(",")[1]})()')
    fs.writeFileSync(join(images, 'chart.webp'), Buffer.from(webp, 'base64'))
    const invalidWebp = Buffer.alloc(34)
    invalidWebp.write('RIFF', 0); invalidWebp.writeUInt32LE(26, 4); invalidWebp.write('WEBPVP8 ', 8); invalidWebp.writeUInt32LE(14, 16)
    invalidWebp.set([0xf0, 0xff, 0xff, 0x9d, 1, 0x2a, 1, 0, 1, 0], 20)
    fs.writeFileSync(join(images, 'invalid-stream.webp'), invalidWebp)
    const image = input => js('window.trellis.knowledgeAccess.artifactImage(' + JSON.stringify({ ...context, ...input }) + ')')
    const open = input => js('window.trellis.knowledgeAccess.artifactOpenLocal(' + JSON.stringify({ ...context, ...input }) + ')')
    for (const [src, mime] of [['./images/chart%20one.png', 'image/png'], ['images/chart.jpg', 'image/jpeg'], ['images/chart.webp', 'image/webp']]) {
      const result = await image({ src })
      check(result.ok && result.data.mimeType === mime && result.data.dataUrl.startsWith('data:' + mime + ';base64,'), 'real registered IPC returns validated raster: ' + JSON.stringify({ src, result: result.ok ? result.data.mimeType : result }))
      check(result.data.width === 1 && result.data.height === 1 && result.data.resource === 'current-local' && result.data.contentHash.length === 64, 'actual dimensions/hash/current-resource metadata')
    }
    const rejectImage = async (input, code) => { const result = await image(input); check(!result.ok && result.code === code, 'typed image rejection: ' + JSON.stringify({ input, result })) }
    for (const src of ['https://example.invalid/a.png', 'file:///C:/a.png', 'data:image/png;base64,AAAA', 'blob:fake', '//server/share/a.png', '\\\\server\\share\\a.png', '/etc/a.png', 'C:/a.png', '../images/%2fserver/a.png', 'images/%xx.png', 'images/a%00.png', 'images/a.png?x=1', 'images/a.svg', 'images/a.gif', 'images/a.png#part']) await rejectImage({ src }, 'E_INVALID_ARG')
    await rejectImage({ src: '../../../outside/outside.png' }, 'E_DENIED')
    await rejectImage({ src: 'images/missing.png' }, 'E_NOT_FOUND')
    await rejectImage({ src: 'images/folder.png' }, 'E_DENIED')
    await rejectImage({ src: 'images/fake.png' }, 'E_INVALID_ARG')
    await rejectImage({ src: 'images/header-only.png' }, 'E_INVALID_ARG')
    await rejectImage({ src: 'images/wrong-extension.png' }, 'E_INVALID_ARG')
    await rejectImage({ src: 'images/huge-pixels.png' }, 'E_INVALID_ARG')
    await rejectImage({ src: 'images/too-big.png' }, 'E_DENIED')
    await rejectImage({ src: 'images/outside-link/outside.png' }, 'E_DENIED')
    await rejectImage({ src: 'images/inside-link/chart one.png' }, 'E_DENIED')
    await rejectImage({ src: 'images/chart one.png', expectedRoot: other }, 'E_CONFLICT')
    boundary.setProjectRoot('\\\\fixture.invalid\\share')
    await rejectImage({ src: 'images/chart one.png', expectedRoot: '\\\\fixture.invalid\\share' }, 'E_DENIED')
    boundary.setProjectRoot(project)
    await rejectImage({ src: 'images/chart one.png', sessionId: 'foreign-session' }, 'E_DENIED')
    await rejectImage({ src: 'images/chart one.png', artifactId: 'missing' }, 'E_INVALID_ARG')
    const access = fs.promises.access
    fs.promises.access = async (path, mode) => {
      if (String(path).endsWith('chart one.png')) throw Object.assign(Error('Fixture denied'), { code: 'EACCES' })
      return access(path, mode)
    }
    await rejectImage({ src: 'images/chart one.png' }, 'E_DENIED')
    fs.promises.access = access
    const openFile = fs.promises.open
    let drift = true
    fs.promises.open = async (...args) => {
      if (drift && String(args[0]).endsWith('chart one.png')) { drift = false; boundary.setProjectRoot(other); boundary.setProjectRoot(project) }
      return openFile(...args)
    }
    await rejectImage({ src: 'images/chart one.png' }, 'E_CONFLICT')
    fs.promises.open = openFile
    const pending = []
    fs.promises.open = (...args) => String(args[0]).endsWith('chart one.png') ? new Promise(resolve => pending.push(() => resolve(openFile(...args)))) : openFile(...args)
    const reads = [image({ src: 'images/chart one.png' }), image({ src: 'images/chart one.png' }), image({ src: 'images/chart one.png' })]
    await until(() => pending.length === 3)
    await rejectImage({ src: 'images/chart one.png' }, 'E_DENIED')
    pending.splice(0).forEach(release => release())
    check((await Promise.all(reads)).every(result => result.ok), 'bounded concurrent image reads finish and release slots')
    fs.promises.open = openFile
    const accessBeforeOpen = fs.promises.access
    let accessCount = 0
    fs.promises.access = async (path, mode) => {
      if (String(path).endsWith('requirements.md') && ++accessCount === 3) { boundary.setProjectRoot(other); boundary.setProjectRoot(project) }
      return accessBeforeOpen(path, mode)
    }
    const countBeforeDrift = opened.length
    const staleOpen = await open({})
    check(!staleOpen.ok && staleOpen.code === 'E_CONFLICT' && opened.length === countBeforeDrift, 'last-moment project generation change blocks OS dispatch, not merely its response')
    fs.promises.access = accessBeforeOpen
    const initialOpen = await open({})
    check(initialOpen.ok && !initialOpen.data.differsFromPreview && opened.length === 1, 'current saved Markdown opens only on explicit action')
    check(opened[0] === pathToFileURL(await fs.promises.realpath(join(notes, 'requirements.md'))).href, 'OS receives main-derived artifact file URL')
    fs.writeFileSync(join(notes, 'requirements.md'), '# Current B')
    const mismatch = await open({})
    check(!mismatch.ok && mismatch.code === 'E_CONFLICT' && opened.length === 1, 'historical A does not silently open current B')
    check(fs.readFileSync(join(notes, 'requirements.md'), 'utf8') === '# Current B', 'preview conflict never overwrites current file')
    const acknowledged = await open({ acknowledgeChangedFile: true })
    check(acknowledged.ok && acknowledged.data.differsFromPreview && acknowledged.data.currentRevision === boundary.hash('# Current B') && opened.length === 2, 'explicit follow-up acknowledges opening current local file')
    failOpener = true
    const failed = await open({ acknowledgeChangedFile: true })
    check(!failed.ok && failed.code === 'E_IO', 'OS association failure is a visible typed failure')
    failOpener = false
    const foreign = await open({ sessionId: 'foreign-session', acknowledgeChangedFile: true })
    check(!foreign.ok && foreign.code === 'E_DENIED', 'foreign session cannot open a known artifact')
    fs.unlinkSync(join(notes, 'requirements.md'))
    check((await open({ acknowledgeChangedFile: true })).code === 'E_NOT_FOUND', 'missing local current file is not a false successful open')
    fs.writeFileSync(join(notes, 'requirements.md'), body)
    const mount = content => js('window.mountDocument(' + JSON.stringify(context) + ',' + JSON.stringify(content) + ')')
    await mount('![Project image](./images/chart%20one.png)')
    await until(() => js('Boolean(document.querySelector(".md img")?.complete && document.querySelector(".md img")?.naturalWidth)'))
    check(await js('document.querySelector(".md img").src.startsWith("data:image/png;base64,") && document.querySelector(".md img").alt==="Project image"'), 'production Markdown custom image uses validated data, not raw relative URL')
    check(await js('document.querySelector(".md").textContent.includes("当前资源")'), 'image provenance does not assert archived image fidelity')
    await mount('![Static WebP](./images/chart.webp)')
    await until(() => js('Boolean(document.querySelector(".md img")?.naturalWidth)'))
    check(await js('document.querySelector(".md img").naturalWidth===1'), 'bounded static WebP actually decodes in the production image host')
    await js('document.querySelector(".md img").dispatchEvent(new Event("error"))')
    await until(() => js('Boolean(document.querySelector(".md [role=alert]"))'))
    check(!await js('Boolean(document.querySelector(".md img"))'), 'browser decode errors become readable failures instead of a broken image')
    await mount('![Invalid WebP](./images/invalid-stream.webp)')
    await until(() => js('Boolean(document.querySelector(".md [role=alert]"))'))
    check(!await js('Boolean(document.querySelector(".md img"))'), 'failed browser decode has a readable error instead of retaining a broken image')
    await mount('![Missing diagram](./images/not-found.png)')
    await until(() => js('Boolean(document.querySelector(".md [role=alert]"))'))
    check(await js('!document.querySelector(".md img") && document.querySelector(".md").textContent.includes("Missing diagram")'), 'missing image has readable alt/error, not blank or external fallback')
    await mount('![Untrusted remote](https://example.invalid/track.png)')
    await until(() => js('Boolean(document.querySelector(".md [role=alert]"))'))
    check(requests.length === 0 && !await js('Boolean(document.querySelector(".md img"))'), 'raw external image is never assigned or fetched')
    let release
    fs.promises.open = (...args) => String(args[0]).endsWith('chart one.png') ? new Promise(resolve => { release = () => resolve(openFile(...args)) }) : openFile(...args)
    await mount('![Late local](./images/chart%20one.png)')
    await until(() => typeof release === 'function')
    await js('window.readingActive(false)')
    release(); fs.promises.open = openFile
    await delay(40)
    check(!await js('Boolean(document.querySelector(".md img"))'), 'Settings suspension rejects a late image completion')
    await js('window.readingActive(true)')
    await until(() => js('Boolean(document.querySelector(".md img")?.naturalWidth)'))
    check(await js('document.querySelector(".md img").naturalWidth===1'), 'visible reader can perform a fresh owned read after returning')
    const bPng = nativeImage.createFromBitmap(Buffer.from([0, 255, 0, 255]), { width: 1, height: 1 }).toPNG()
    fs.writeFileSync(join(images, 'version-b.png'), bPng)
    const bArtifact = { ...artifact, id: 'artifact-b', body: '# B\n\n![B](./images/version-b.png)' }
    bArtifact.revision = boundary.hash(bArtifact.body)
    boundary.addArtifact(project, bArtifact)
    const bContext = { ...context, artifactId: bArtifact.id, revision: bArtifact.revision }
    release = null
    fs.promises.open = (...args) => String(args[0]).endsWith('chart one.png') ? new Promise(resolve => { release = () => resolve(openFile(...args)) }) : openFile(...args)
    await mount('![Old artifact pending](./images/chart%20one.png)')
    await until(() => typeof release === 'function')
    await js('window.mountDocument(' + JSON.stringify(bContext) + ',' + JSON.stringify(bArtifact.body) + ')')
    await until(() => js('Boolean(document.querySelector(".md img")?.naturalWidth)'))
    release(); fs.promises.open = openFile
    await delay(40)
    check(await js('document.querySelector(".md img").src.endsWith(' + JSON.stringify(bPng.toString('base64')) + ')'), 'a delayed artifact A image cannot replace the selected artifact B image')
    const duplicatePending = []
    fs.promises.open = (...args) => String(args[0]).endsWith('chart one.png') ? new Promise(resolve => duplicatePending.push(() => resolve(openFile(...args)))) : openFile(...args)
    await mount(Array.from({ length: 20 }, (_, index) => '![Duplicate ' + index + '](./images/chart%20one.png)').join('\n\n'))
    await until(() => duplicatePending.length > 0)
    await delay(40)
    check(duplicatePending.length === 1, 'duplicate in-flight sources share one per-document IPC read')
    duplicatePending.splice(0).forEach(done => done()); fs.promises.open = openFile
    await until(() => js('[...document.querySelectorAll(".md img")].filter(img=>img.naturalWidth===1).length===20'))
    const lstat = fs.promises.lstat
    let failedReads = 0
    fs.promises.lstat = async (...args) => { if (String(args[0]).endsWith('dedup-missing.png')) failedReads++; return lstat(...args) }
    const duplicateFailures = Array.from({ length: 20 }, (_, index) => '![Missing ' + index + '](./images/dedup-missing.png)').join('\n\n') + '\n\n[Receipt](' + pathToFileURL(join(notes, 'requirements.md')).href + ')'
    await mount(duplicateFailures)
    await until(() => js('document.querySelectorAll(".md [role=alert]").length===20'))
    check(failedReads === 1, 'duplicate failed references share one cached rejection, not repeated IPC reads')
    await js('window.linkMode="error";document.querySelector(".md a").click()')
    await until(() => js('document.querySelector(".md").textContent.includes("Synthetic known receipt rejected")'))
    await delay(40)
    check(failedReads === 1, 'unrelated Markdown rerender does not retry a cached failed reference')
    await js('window.readingRoot(' + JSON.stringify(other) + ')'); await delay(20)
    await js('window.readingRoot(' + JSON.stringify(project) + ')')
    await until(() => failedReads === 2)
    check(failedReads === 2, 'a new root owner can perform a fresh bounded read after returning')
    fs.promises.lstat = lstat
    const many = []
    for (let index = 0; index < 9; index++) { fs.writeFileSync(join(images, 'bounded-' + index + '.png'), png); many.push('![Bounded ' + index + '](./images/bounded-' + index + '.png)') }
    await mount(many.join('\n\n'))
    await until(() => js('document.querySelectorAll(".md img").length===8 && Boolean(document.querySelector(".md [role=alert]"))'))
    check(await js('document.querySelector(".md").textContent.includes("最多自动读取 8 张")'), 'document auto-load count is bounded, with a readable limit instead of unbounded work')
    const localLink = '[Saved document](' + pathToFileURL(join(notes, 'requirements.md')).href + ')'
    const clickLink = () => js('document.querySelector(".md a").click()')
    const beforeLink = opened.length
    await js('window.linkMode="true"')
    await mount(localLink)
    await clickLink(); await delay(30)
    check(opened.length === beforeLink && await js('window.handledHrefs.length>0'), 'handled receipt-backed link never falls through to OS')
    const beforeAux = await js('window.handledHrefs.length')
    await js('document.querySelector(".md a").dispatchEvent(new MouseEvent("auxclick",{bubbles:true,cancelable:true,button:1}))'); await delay(30)
    check(opened.length === beforeLink && await js('window.handledHrefs.length') === beforeAux + 1, 'middle-click can use the same handled saved-document route once')
    await js('window.linkMode="error"')
    await clickLink()
    await until(() => js('document.querySelector(".md").textContent.includes("Synthetic known receipt rejected")'))
    check(opened.length === beforeLink, 'rejected known receipt link is visible and never falls through')
    await js('window.linkMode="defer";window.releaseLink=null')
    await clickLink()
    await until(() => js('typeof window.releaseLink==="function"'))
    await mount('# Replaced content')
    await js('window.releaseLink()'); await delay(30)
    check(opened.length === beforeLink, 'late unhandled result after content replacement cannot dispatch an OS open')
    await mount(localLink)
    await js('window.releaseLink=null')
    await clickLink(); await until(() => js('typeof window.releaseLink==="function"'))
    await js('window.readingActive(false);window.releaseLink()'); await delay(30)
    check(opened.length === beforeLink, 'Settings suspension cancels a delayed unhandled saved-link route before OS fallback')
    await js('window.readingActive(true)')
    await js('window.linkMode="false"')
    await mount(localLink)
    await clickLink()
    await until(() => opened.length > beforeLink)
    check(opened.length === beforeLink + 1, 'unhandled valid local link retains its existing explicit OS route')
    await js('window.linkMode="error";window.handledHrefs=[]')
    await mount('[Web](https://example.invalid/reference)')
    await clickLink()
    await until(() => opened.length > beforeLink + 1)
    check(await js('window.handledHrefs.length===0'), 'HTTP links do not enter saved-document routing hook')
    await mount('[Heading](#heading)')
    await clickLink(); await delay(30)
    check(await js('window.handledHrefs.length===0') && opened.length === beforeLink + 2, 'same-document anchors do not enter routing hook or OS')
    const legacy = makeWindow(join(__dirname, 'legacy.cjs')); windows.push(legacy)
    await legacy.loadFile(join(__dirname, 'index.html'))
    const oldJs = code => legacy.webContents.executeJavaScript(code, true)
    await until(() => oldJs('typeof window.mountDocument === "function"'))
    await oldJs('window.mountDocument(' + JSON.stringify(context) + ',"![Old preload](./images/chart%20one.png)")')
    await until(() => oldJs('Boolean(document.querySelector("[role=alert]"))'))
    check(await oldJs('document.body.textContent.includes("完整退出") && !document.querySelector("img")'), 'old preload gives feature-specific restart guidance without unsafe fallback')
    check(await js('window.unhandled.length===0') && errors.length === 0, 'image and opener failures do not escape as unhandled rejections')
    console.log('PASS ' + assertions + ' artifact image/local-open assertions with actual preload, registered IPC, binary files and production Markdown')
  } finally { windows.forEach(window => { if (!window.isDestroyed()) window.destroy() }) }
  app.quit()
}

try {
  const entry = join(directory, 'boundary.ts')
  writeFileSync(entry, `export{registerKnowledgeAccessIpc}from'${absolute('src/main/ipc/knowledge-access.ts')}';
export{registerFilesIpc}from'${absolute('src/main/ipc/files.ts')}';
export{knowledgeHash as hash,updateKnowledgeState}from'${absolute('src/main/services/knowledge-access/repository.ts')}';
export{KNOWLEDGE_DOCUMENT_IMAGE_MAX_BYTES as maxBytes}from'${absolute('src/shared/knowledge-document-assets.ts')}';
import{updateKnowledgeState}from'${absolute('src/main/services/knowledge-access/repository.ts')}';
export{setProjectRoot}from'${absolute('src/main/state.ts')}';
export function addArtifact(root,artifact){updateKnowledgeState(root,state=>state.artifacts.push(artifact))}`)
  await build({ entryPoints: [entry], outfile: join(directory, 'boundary.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [{ name: 'owned-project-fixture', setup(builder) {
    builder.onLoad({ filter: /src[\\/]main[\\/]state\.ts$/ }, () => ({ loader: 'ts', contents: `let root=null,generation=0;export const getProjectRoot=()=>root;export const getProjectGeneration=()=>generation;export function setProjectRoot(value){root=value;generation++}export const sendSnapshot=()=>{};export const safeReadText=()=>({ok:false,error:'Fixture unused'})` }))
    builder.onLoad({ filter: /src[\\/]main[\\/]services[\\/]scan\.ts$/ }, () => ({ loader: 'ts', contents: `export const writeSpecFile=()=>{};export const computeSpecBacklinks=()=>({});export const readTextWithMtime=()=>({mtime:0});export const searchDocs=()=>({hits:[]})` }))
    builder.onLoad({ filter: /knowledge-access[\\/]service\.ts$/ }, () => ({ loader: 'ts', contents: `export const knowledgeAccess={};export function knowledgeFailure(error){const code=error.kind==='conflict'?'E_CONFLICT':error.kind==='denied'?'E_DENIED':error.kind==='io'?'E_IO':'E_INVALID_ARG';return{ok:false,code,error:error.message||'Fixture failure'}}` }))
    builder.onLoad({ filter: /local-task[\\/]prd\.ts$/ }, () => ({ loader: 'ts', contents: `import{writeFileSync,mkdirSync,renameSync}from'node:fs';import{dirname}from'node:path';export function atomicWriteText(path,body){mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',body,'utf8');renameSync(path+'.tmp',path)}` }))
  } }] })
  await build({ entryPoints: [resolve('src/preload/index.ts')], outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  writeFileSync(join(directory, 'legacy.cjs'), `require('electron').contextBridge.exposeInMainWorld('trellis',{knowledgeAccess:{}})`)
  writeFileSync(join(directory, 'renderer.tsx'), renderer)
  await build({ entryPoints: [join(directory, 'renderer.tsx')], outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [absolute('node_modules')] })
  writeFileSync(join(directory, 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'"><div id="root"></div><script src="renderer.js"></script>`)
  writeFileSync(join(directory, 'main.cjs'), '(' + nativeChecks.toString() + ')().catch(error=>{console.error(error.stack);require("electron").app.exit(1)})')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [join(directory, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })
  process.stdout.write(result.stdout)
  assert.ok(result.stdout.includes('PASS '))
} catch (error) { if (error.stdout) process.stdout.write(error.stdout); if (error.stderr) process.stderr.write(error.stderr); throw error }
finally { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('tpanel-knowledge-document-assets-')); rmSync(directory, { recursive: true, force: true }) }
