/** Real Markdown/preload/IPC/filesystem; OS document/browser handlers are stubbed. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-local-document-links-'))
const absolute = path => resolve(path).replace(/\\/g, '/')
const renderer = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {flushSync} from '${absolute('node_modules/react-dom/index.js')}';
import {MarkdownView} from '${absolute('src/renderer/src/components/MarkdownView.tsx')}';
const root=createRoot(document.getElementById('root'));
window.unhandled=[];
addEventListener('unhandledrejection',event=>window.unhandled.push(String(event.reason)));
window.mountMarkdown=content=>flushSync(()=>root.render(<MarkdownView content={content} headingAnchorsByLine={new Map([[1,'heading']])}/>));
window.mountMarkdown('# Heading');`

async function nativeChecks() {
  const assert = require('node:assert/strict')
  const { app, BrowserWindow, shell, session } = require('electron')
  const fs = require('node:fs')
  const { join, resolve } = require('node:path')
  const { pathToFileURL } = require('node:url')
  const { registerFilesIpc, setProjectRoot, localDocumentLink } = require('./boundary.cjs')
  const calls = [], unhandled = [], requests = []
  let assertions = 0, failOpener = false
  const check = (condition, message) => { assert.ok(condition, message); assertions++ }
  const delay = ms => new Promise(done => setTimeout(done, ms))
  const until = async predicate => {
    const deadline = Date.now() + 4000
    while (!await predicate()) { if (Date.now() > deadline) throw Error('Timed out waiting for fixture condition'); await delay(15) }
  }
  app.setPath('userData', join(__dirname, 'profile'))
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('no-proxy-server')
  process.on('unhandledRejection', error => unhandled.push(String(error)))
  shell.openExternal = async url => { calls.push(url); if (failOpener) throw Error('Synthetic default application failure') }
  await app.whenReady()
  const project = join(__dirname, 'project')
  fs.mkdirSync(project)
  setProjectRoot(project)
  const document = join(__dirname, 'his-skin-test workflow-20261020.html')
  const relativeDocument = join(project, '流程 diagram.html')
  const deniedDocument = join(project, 'denied.html')
  for (const path of [document, relativeDocument, deniedDocument]) fs.writeFileSync(path, '<!doctype html><title>Owned document</title><h1>Flow</h1>')
  const canonicalDocument = await fs.promises.realpath(document)
  const canonicalRelativeDocument = await fs.promises.realpath(relativeDocument)
  const canonicalDeniedDocument = await fs.promises.realpath(deniedDocument)
  fs.mkdirSync(join(project, 'folder.html'))
  fs.writeFileSync(join(project, 'unsafe.exe'), 'not executable')
  const access = fs.promises.access
  fs.promises.access = async (path, mode) => {
    if (path === canonicalDeniedDocument) throw Object.assign(Error('Fixture denied'), { code: 'EACCES' })
    return access(path, mode)
  }
  registerFilesIpc()
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const blocked = !details.url.startsWith('file:')
    if (blocked) requests.push(details.url)
    done({ cancel: blocked })
  })
  const w = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true,
    nodeIntegration: false, sandbox: false, backgroundThrottling: false } })
  const js = code => w.webContents.executeJavaScript(code, true)
  try {
    for (const value of ['C:/Users/MAWEIR~1/AppData/Local/Temp/example.html', '/C:/Users/Test/example.html', 'C:\\Users\\Test\\example.htm', 'C:%5CUsers%5CTest%5Cexample.htm',
      'file:///C:/Users/Test/page%20one.html#part', '/tmp/diagram.html', './docs/plan.md', 'docs/flow%20chart.pdf', 'docs/说明.txt']) {
      check(localDocumentLink(value) !== null, 'supported local document syntax: ' + value)
    }
    check(localDocumentLink('/C:/Users/Test/page%20one.html').path === 'C:/Users/Test/page one.html', 'ACP slash-drive form and spaces normalized')
    check(localDocumentLink('file:///C:/Users/Test/page.html#part').fragment === 'part', 'file fragment retained separately')
    for (const value of [null, {}, '', '#heading', 'https://example.invalid/a.html', 'javascript:foo.html', 'data:text/html,test', 'vscode://file/x.md',
      'C:relative.html', 'file://server/share/page.html', 'file://localhost/C:/page.html', '//server/share/page.html', '\\\\server\\share\\page.html',
      'file:////server/share/page.html', 'file:///C:/page.html?query=1', 'C:/page.html\0.exe', 'C:/page%00.html', 'C:/page%0a.html',
      'C:/%2fserver/page.html', 'C:/page%xx.html', 'C:/page%252f.html', 'C:/page.html:evil', 'C:/file.exe', 'C:/file.cmd', 'C:/file.ps1',
      'C:/file.js', 'C:/file.lnk', 'C:/file.url', 'file:///C:/test.svg', 'C:/page.html#%0a']) {
      check(localDocumentLink(value) === null, 'unsafe or unsupported syntax rejected: ' + JSON.stringify(value))
    }
    await w.loadFile(join(__dirname, '../renderer/index.html'))
    await until(() => js('typeof window.mountMarkdown === "function"'))
    const initial = w.webContents.getURL()
    await js('document.getElementById("draft").value="Unsent draft remains"')
    const mount = content => js('window.mountMarkdown(' + JSON.stringify(content) + ')')
    const click = (label, auxiliary = false) => js('(()=>{const a=[...document.querySelectorAll(".md a")].find(a=>a.textContent===' + JSON.stringify(label) + ');' +
      (auxiliary ? 'a.dispatchEvent(new MouseEvent("auxclick",{bubbles:true,cancelable:true,button:1}))' : 'a.click()') + '})()')
    const localHref = process.platform === 'win32' ? '/' + document.replace(/\\/g, '/').replace(/ /g, '%20') : document.replace(/ /g, '%20')
    const driveHref = document.replace(/\\/g, '/').replace(/ /g, '%20')
    const nativeHref = document.replace(/ /g, '%20')
    const fileHref = pathToFileURL(document).href + '#flow'
    await mount('# Heading\n\n[Flow](' + localHref + ') [Drive](' + driveHref + ') [Native](<' + nativeHref + '>) [File URL](' + fileHref + ') [Relative](./%E6%B5%81%E7%A8%8B%20diagram.html) ' +
      '[Web](https://example.invalid/a%20b) [Anchor](#heading) [Unsafe](javascript:alert%281%29)\n\n<script>window.unsafe=true</script>')
    for (const label of ['Flow', 'Drive', 'Native', 'File URL']) {
      const displayed = await js('(()=>{const a=[...document.querySelectorAll(".md a")].find(a=>a.textContent===' + JSON.stringify(label) + ');return {attribute:a.getAttribute("href"),resolved:a.href}})()')
      check(displayed.attribute.startsWith('file:///') && displayed.attribute === displayed.resolved, 'copyable local href never resolves to app HTTP: ' + label)
      check(decodeURIComponent(new URL(displayed.attribute).pathname).replace(/^\/([a-z]:)/i, '$1') === document.replace(/\\/g, '/'), 'normalization preserves the actual native target: ' + label)
    }
    check(await js('new URL([...document.querySelectorAll(".md a")].find(a=>a.textContent==="File URL").href).hash === "#flow"'), 'local fragment survives sanitization and normalization')
    check(calls.length === 0, 'rendering documents never opens a file automatically')
    const expectOpen = async (label, expected, auxiliary = false) => {
      const before = calls.length
      await click(label, auxiliary)
      await until(() => calls.length > before)
      await delay(30)
      assert.deepEqual(calls.slice(before), [expected], 'one OS document dispatch per explicit click')
      assertions++
    }
    await expectOpen('Flow', pathToFileURL(canonicalDocument).href)
    await expectOpen('Flow', pathToFileURL(canonicalDocument).href, true)
    await expectOpen('Drive', pathToFileURL(canonicalDocument).href)
    await expectOpen('Native', pathToFileURL(canonicalDocument).href)
    await expectOpen('File URL', pathToFileURL(canonicalDocument).href + '#flow')
    await expectOpen('Relative', pathToFileURL(canonicalRelativeDocument).href)
    await expectOpen('Web', 'https://example.invalid/a%20b')
    await click('Anchor')
    await until(() => w.webContents.getURL().endsWith('#heading'))
    check(w.webContents.getURL().split('#')[0] === initial, 'same-document anchor retains app URL')
    check(await js('!window.unsafe && !document.querySelector(".md script")'), 'raw HTML and executable schemes remain sanitized')
    const result = value => js('window.trellis.openLocalDocument(' + JSON.stringify(value) + ')')
    const expectDenied = async (value, code) => {
      const before = calls.length
      const response = await result(value)
      check(!response.ok && response.code === code, 'main IPC rejects target with typed failure: ' + JSON.stringify({ value, response }))
      check(calls.length === before, 'denied local target never reaches OS')
    }
    await expectDenied(join(project, 'missing.html'), 'E_NOT_FOUND')
    await expectDenied(deniedDocument, 'E_DENIED')
    await expectDenied(join(project, 'folder.html'), 'E_DENIED')
    await expectDenied(join(project, 'unsafe.exe'), 'E_INVALID_ARG')
    await expectDenied('../his-skin-test%20workflow-20261020.html', 'E_DENIED')
    // Read-only reference to an existing document outside the fixture's trusted roots.
    await expectDenied(resolve('README.md'), 'E_DENIED')
    const linkDir = join(project, 'linked')
    const sourceDir = join(__dirname, 'source')
    fs.mkdirSync(sourceDir)
    fs.writeFileSync(join(sourceDir, 'diagram.html'), '<h1>Symlink fixture</h1>')
    fs.symlinkSync(sourceDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
    await expectDenied(join(linkDir, 'diagram.html'), 'E_DENIED')
    fs.symlinkSync(project, join(project, 'root-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expectDenied(join(project, 'root-link', '流程 diagram.html'), 'E_DENIED')
    if (process.platform !== 'win32') {
      fs.symlinkSync(document, join(project, 'link.html'))
      await expectDenied(join(project, 'link.html'), 'E_DENIED')
    }
    for (const value of [null, { href: document }, '//server/share/page.html', 'file://server/share/page.html', 'C:/page%00.html']) await expectDenied(value, 'E_INVALID_ARG')
    setProjectRoot(null)
    await expectDenied('./diagram.html', 'E_NO_PROJECT')
    setProjectRoot(project)
    await mount('[Missing](./missing.html)')
    await click('Missing')
    await until(() => js('document.querySelector("[role=alert]")?.textContent.includes("不存在")'))
    check(await js('document.querySelector("[role=alert]").textContent.includes("重新生成")'), 'missing document explains a usable next step')
    await mount('[Denied](./denied.html)')
    await click('Denied')
    await until(() => js('document.querySelector("[role=alert]")?.textContent.includes("权限")'))
    failOpener = true
    await mount('[Flow](' + localHref + ')')
    await click('Flow')
    await until(() => js('document.querySelector("[role=alert]")?.textContent.includes("默认应用")'))
    failOpener = false
    await mount('[Flow](' + localHref + ')')
    await click('Flow')
    await delay(40)
    check(await js('!document.querySelector("[role=alert]")'), 'retry can succeed without remounting the app')
    check(await js('document.getElementById("draft").value === "Unsent draft remains"'), 'unsent draft survives opening and failures')
    check(w.webContents.getURL().split('#')[0] === initial && !w.isVisible(), 'local links do not replace or show the hidden app')
    check(BrowserWindow.getAllWindows().length === 1, 'no privileged document popup created')
    const legacy = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../preload/legacy.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: false, backgroundThrottling: false } })
    try {
      const legacyJs = code => legacy.webContents.executeJavaScript(code, true)
      await legacy.loadFile(join(__dirname, '../renderer/index.html'))
      await until(() => legacyJs('typeof window.mountMarkdown === "function"'))
      const before = calls.length
      await legacyJs('window.mountMarkdown(' + JSON.stringify('[Flow](' + localHref + ')') + ')')
      await legacyJs('document.querySelector(".md a").click()')
      await until(() => legacyJs('document.querySelector("[role=alert]")?.textContent.includes("完整退出并重启")'))
      check(await legacyJs('window.legacyCalls() === 0'), 'old preload is not bypassed through arbitrary openFile/openExternal')
      check(calls.length === before, 'missing new IPC capability does not dispatch an OS action')
    } finally { legacy.destroy() }
    check(requests.length === 0, 'no renderer request to external networks: ' + requests.join(', '))
    check(unhandled.length === 0 && await js('window.unhandled.length === 0'), 'no unhandled rejection')
    console.log('LOCAL_DOCUMENT_LINKS_PASSED (' + assertions + ' assertions; real Markdown/preload/IPC/files; OS handlers stubbed)')
  } finally {
    fs.promises.access = access
    session.defaultSession.webRequest.onBeforeRequest(null)
    w.destroy()
  }
}

try {
  for (const path of ['main', 'preload', 'renderer']) mkdirSync(join(directory, path))
  writeFileSync(join(directory, 'renderer/index.html'), '<!doctype html><meta charset="utf-8"><textarea id="draft"></textarea><div id="root"></div><script src="./renderer.js"></script>')
  await build({ stdin: { contents: renderer, resolveDir: process.cwd(), loader: 'tsx' }, outfile: join(directory, 'renderer/renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning' })
  await build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload/index.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })
  writeFileSync(join(directory, 'preload/legacy.cjs'), 'const {contextBridge}=require("electron");let calls=0;contextBridge.exposeInMainWorld("legacyCalls",()=>calls);contextBridge.exposeInMainWorld("trellis",{openExternal:async()=>{calls++},openFile:async()=>{calls++}});')
  const stateFixture = `let root=null;export const setProjectRoot=value=>root=value;export const getProjectRoot=()=>root;export const writeSpecFile=()=>{},computeSpecBacklinks=()=>{},readTextWithMtime=()=>{},searchDocs=()=>{},sendSnapshot=()=>{},safeReadText=()=>{};`
  await build({ stdin: { contents: `export {registerFilesIpc} from '${absolute('src/main/ipc/files.ts')}';export {localDocumentLink} from '${absolute('src/shared/local-document-link.ts')}';export {setProjectRoot} from 'local-link-fixture';`, resolveDir: process.cwd() }, outfile: join(directory, 'main/boundary.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning', plugins: [{ name: 'unrelated-file-services', setup(builder) {
    builder.onResolve({ filter: /^(?:\.\.\/(?:state|services\/scan)|local-link-fixture)$/ }, () => ({ path: 'fixture', namespace: 'unused' }))
    builder.onLoad({ filter: /.*/, namespace: 'unused' }, () => ({ contents: stateFixture, loader: 'js' }))
  } }] })
  writeFileSync(join(directory, 'main/test.cjs'), '(' + nativeChecks.toString() + ')().then(()=>require("electron").app.exit(0),error=>{console.error(error);require("electron").app.exit(1)});setTimeout(()=>{console.error("local document fixture timed out");require("electron").app.exit(1)},60000);')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron')
  const result = await promisify(execFile)(electron, [join(directory, 'main/test.cjs')], { env, timeout: 75000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  assert.ok(result.stdout.includes('LOCAL_DOCUMENT_LINKS_PASSED'), result.stdout + result.stderr)
  console.log(result.stdout.trim())
} catch (error) {
  console.error(error.stdout ?? '')
  console.error(error.stderr ?? '')
  throw error
} finally {
  // Only this exact mkdtemp directory is removed; no user session/profile is touched.
  rmSync(directory, { recursive: true, force: true })
}
