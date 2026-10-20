/** Real hidden Electron + real Markdown/preload/IPC. The OS browser is always stubbed. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import ts from 'typescript'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-external-links-'))
const absolute = file => resolve(file).replace(/\\/g, '/')
const source = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const loader = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadAppWindow')
assert.ok(loader, 'all app windows share the protected loader')
for (const name of ['createWindow', 'openDocWindow', 'createCapsule', 'ensureQuickTodo']) {
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(fn?.getText(source).includes('loadAppWindow('), `${name} must install the boundary before loading`)
}

const renderer = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {flushSync} from '${absolute('node_modules/react-dom/index.js')}';
import {MarkdownView} from '${absolute('src/renderer/src/components/MarkdownView.tsx')}';
const root=createRoot(document.getElementById('root'));
window.fixture={clicks:[],unhandled:[],ping:0};
document.getElementById('ping').onclick=()=>window.fixture.ping++;
addEventListener('unhandledrejection',event=>window.fixture.unhandled.push(String(event.reason)));
document.addEventListener('click',event=>{const anchor=event.target.closest('a');if(anchor)window.fixture.clicks.push({text:anchor.textContent,prevented:event.defaultPrevented})});
window.mountMarkdown=content=>flushSync(()=>root.render(<MarkdownView content={content} headingAnchorsByLine={new Map([[1,'heading']])}/>));
window.mountMarkdown('# Heading');`

async function nativeChecks() {
  const assert = require('node:assert/strict')
  const { app, BrowserWindow, shell, session } = require('electron')
  const { createServer } = require('node:http')
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const { loadAppWindow } = require('./loader.cjs')
  const { registerFilesIpc, externalHttpUrl, openExternalHttpUrl } = require('./boundary.cjs')
  const calls = [], unhandled = [], escaped = [], requests = [], warnings = []
  let failOpener = false, redirectNext = false, origin = '', popups = 0, assertions = 0
  const check = (value, message) => { assert.ok(value, message); assertions++ }
  const delay = ms => new Promise(done => setTimeout(done, ms))
  const until = async predicate => {
    const deadline = Date.now() + 4000
    while (!predicate()) { if (Date.now() > deadline) throw Error('Timed out waiting for native event'); await delay(15) }
  }
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)
  process.on('unhandledRejection', error => unhandled.push(String(error)))
  shell.openExternal = async url => {
    calls.push(url)
    if (failOpener) throw Error('Synthetic OS browser failure')
  }
  app.setPath('userData', join(__dirname, 'profile'))
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('no-proxy-server')
  await app.whenReady()
  registerFilesIpc()
  app.on('browser-window-created', () => { popups++ })
  const server = createServer((req, res) => {
    requests.push(req.url)
    const path = new URL(req.url, origin).pathname
    if (path === '/redirect' || (path === '/index.html' && redirectNext)) {
      redirectNext = false
      res.writeHead(302, { Location: origin + '/outside?from=redirect' }).end()
    } else if (path === '/renderer.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(readFileSync(join(__dirname, '../renderer/renderer.js')))
    } else if (path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(readFileSync(join(__dirname, '../renderer/index.html')))
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1 id="foreign">Foreign page</h1>')
    }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  origin = 'http://127.0.0.1:' + server.address().port
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url)
    const outside = url.protocol !== 'file:' && url.origin !== origin
    if (outside) escaped.push(details.url)
    done({ cancel: outside })
  })
  try {
    const invalid = [null, {}, 4, '', '/outside', '//example.invalid', 'https:', 'http://',
      'https:///example.invalid', 'https://[broken]', 'https://example.invalid:99999',
      'https://example.invalid/\\file', 'https://example.invalid/a\nb', 'https://example.invalid/%xx',
      'https://user:password@example.invalid/', 'javascript:alert(1)', 'data:text/html,test',
      'file:///C:/test', 'mailto:test@example.invalid', 'trellis-panel://open', 'vscode://file/C:/test']
    for (const url of invalid) {
      check(externalHttpUrl(url) === null, 'invalid URL rejected: ' + JSON.stringify(url))
      await openExternalHttpUrl(url)
    }
    check(calls.length === 0, 'invalid values never reach the OS opener')
    for (const url of [origin + '/web?a=1#part', 'HTTPS://EXAMPLE.INVALID/a%20b?q=hello#part', 'https://例子.测试/文档']) {
      check(externalHttpUrl(url) === new URL(url).href, 'valid web URL parsed and normalized')
    }

    const modes = [undefined,
      { mode: 'doc', path: 'D:/owned/文档 with # & ?.md', title: 'Title # & ? 文档', theme: 'light' },
      { mode: 'capsule', shape: 'card', pinned: 'true', theme: 'dark' },
      { mode: 'quicktodo', theme: 'light' }]
    for (const dev of [false, true]) for (const query of modes) {
      if (dev) process.env.ELECTRON_RENDERER_URL = origin + '/index.html'
      else delete process.env.ELECTRON_RENDERER_URL
      const w = new BrowserWindow({ show: false, frame: false, width: 700, height: 500,
        webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true,
          nodeIntegration: false, sandbox: false, backgroundThrottling: false } })
      const countBefore = popups
      const js = code => w.webContents.executeJavaScript(code, true)
      const loaded = new Promise(done => w.webContents.once('did-finish-load', done))
      loadAppWindow(w, query)
      await loaded
      await js('new Promise(done=>{const timer=setInterval(()=>{if(window.fixture){clearInterval(timer);done()}},10)})')
      const initial = w.webContents.getURL()
      const initialUrl = new URL(initial)
      for (const [key, value] of Object.entries(query ?? {})) check(initialUrl.searchParams.get(key) === value, 'initial mode/query preserved: ' + key)
      check(!w.isVisible(), 'fixture window stays hidden')
      const prefs = w.webContents.getLastWebPreferences()
      check(prefs.contextIsolation && !prefs.nodeIntegration, 'isolated preload, no Node integration')
      check(await js('typeof require === "undefined" && typeof process === "undefined"'), 'no Node exposed to renderer')
      const sameApp = async () => {
        check(w.webContents.getURL().split('#')[0] === initial.split('#')[0], 'app document was not replaced')
        check(await js('!!document.getElementById("ping") && !document.getElementById("foreign")'), 'app content survives')
        check(popups === countBefore && BrowserWindow.getAllWindows().length === 1, 'no app popup was created')
      }
      const expectOpen = async (action, expected) => {
        const before = calls.length
        await action()
        await until(() => calls.length > before)
        await delay(35)
        assert.deepEqual(calls.slice(before), [expected], 'one validated OS opener call')
        assertions++
        await sameApp()
      }
      const content = '# Heading\n\n[Web](' + origin + '/outside?via=markdown#part)\n\n' +
        '[Secure](https://example.invalid/a%20b?q=x#part)\n\n[Anchor](#heading)\n\n' +
        '[Relative](./other.md) [Mail](mailto:test@example.invalid) [Script](javascript:alert%281%29) ' +
        '[Data](data:text/html,test) [File](file:///C:/test) [Malformed](http://)\n\n' +
        '| One | Two |\n| --- | --- |\n| **bold** | `code` |\n\n<script>window.__unsafe=true</script>'
      await js('window.mountMarkdown(' + JSON.stringify(content) + ')')
      check(await js('document.querySelector(".md a").getAttribute("href") === ' + JSON.stringify(origin + '/outside?via=markdown#part')), 'Markdown URL remains copyable')
      check(await js('!!document.querySelector("table strong") && !!document.querySelector("table code") && !window.__unsafe && !document.querySelector(".md script")'), 'sanitized Markdown, tables and inline code preserved')
      const clickMarkdown = label => js('[...document.querySelectorAll(".md a")].find(a=>a.textContent===' + JSON.stringify(label) + ').click()')
      await expectOpen(() => clickMarkdown('Web'), origin + '/outside?via=markdown#part')
      check(await js('window.fixture.clicks.at(-1).prevented'), 'Markdown click explicitly prevents default navigation')
      await expectOpen(() => clickMarkdown('Secure'), 'https://example.invalid/a%20b?q=x#part')
      await expectOpen(() => js('document.querySelector(".md a").dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,ctrlKey:true}))'), origin + '/outside?via=markdown#part')
      await expectOpen(() => js('document.querySelector(".md a").dispatchEvent(new MouseEvent("auxclick",{bubbles:true,cancelable:true,button:1}))'), origin + '/outside?via=markdown#part')
      const beforeInvalid = calls.length
      for (const label of ['Relative', 'Mail', 'Script', 'Data', 'File', 'Malformed']) await clickMarkdown(label)
      check(calls.length === beforeInvalid, 'unsupported Markdown links never reach IPC opener')
      await clickMarkdown('Anchor')
      await delay(40)
      check(w.webContents.getURL().endsWith('#heading'), 'same-document anchor navigates natively')
      check(await js('!window.fixture.clicks.at(-1).prevented'), 'anchor default behavior is retained')
      check(calls.length === beforeInvalid, 'anchor does not call OS browser')

      // Bypass Markdown entirely: plain native links must still hit the window boundary.
      const rawClick = (url, target = '') => js('(()=>{const a=document.createElement("a");a.href=' + JSON.stringify(url) + ';a.target=' + JSON.stringify(target) + ';document.body.append(a);a.click();a.remove()})()')
      await expectOpen(() => rawClick(origin + '/outside?via=raw'), origin + '/outside?via=raw')
      await expectOpen(() => rawClick('https://example.invalid/blank', '_blank'), 'https://example.invalid/blank')
      await expectOpen(() => js('window.open(' + JSON.stringify(origin + '/outside?via=window-open') + ',"_blank") === null'), origin + '/outside?via=window-open')
      const beforeBlocked = calls.length
      await rawClick('file:///C:/not-an-app.html')
      await rawClick('data:text/html,foreign', '_blank')
      await js('window.open("about:blank", "_blank") === null')
      await delay(40)
      check(calls.length === beforeBlocked, 'unsupported boundary URLs and blank popups are denied')
      await sameApp()
      for (const url of invalid) await js('window.trellis.openExternal(' + JSON.stringify(url) + ')')
      check(calls.length === beforeBlocked, 'actual registered IPC rejects malformed and unsupported values')

      // An exact trusted-document reload is allowed, including loadFile %20 query encoding.
      const reload = new Promise(done => w.webContents.once('did-finish-load', done))
      await rawClick(initial + '#reload')
      // A fragment-only click does not reload. Force reload through the native API instead.
      w.webContents.reload()
      await reload
      await delay(40)
      await sameApp()
      check(calls.length === beforeBlocked, 'trusted app-document link/reload is not opened externally')
      if (dev) {
        await expectOpen(() => rawClick(origin + '/index.html?untrusted=1'), origin + '/index.html?untrusted=1')
        // Reloading the exact trusted URL can redirect even though loadURL bypasses will-navigate.
        redirectNext = true
        await expectOpen(async () => { await w.loadURL(initial).catch(error => check(['ERR_ABORTED', 'ERR_FAILED'].includes(error.code), 'redirect load cancelled: ' + error.message)) }, origin + '/outside?from=redirect')
      }
      failOpener = true
      const warningCount = warnings.length
      await expectOpen(() => rawClick(origin + '/outside?failure=boundary'), origin + '/outside?failure=boundary')
      await expectOpen(() => js('window.trellis.openExternal(' + JSON.stringify(origin + '/outside?failure=ipc') + ')'), origin + '/outside?failure=ipc')
      check(warnings.length === warningCount + 2, 'OS failures handled for boundary and IPC')
      failOpener = false
      check(await js('document.getElementById("ping").click();window.fixture.ping === 1'), 'app remains interactive after failures')
      check(await js('window.fixture.unhandled.length === 0'), 'renderer has no unhandled promise rejection')
      w.setSize(720, 520)
      const [width, height] = w.getSize()
      // Windows DIP/physical-pixel round trips can differ by one pixel at fractional scale.
      check(Math.abs(width - 720) <= 1 && Math.abs(height - 520) <= 1 && !w.isVisible(), 'basic native resizing works while hidden: ' + JSON.stringify({ width, height, visible: w.isVisible() }))
      const closed = new Promise(done => w.once('closed', done))
      w.close()
      await closed
      check(BrowserWindow.getAllWindows().length === 0, 'native close remains functional')
      console.log('PASS ' + (dev ? 'loadURL' : 'loadFile') + '/' + (query?.mode ?? 'main') + ': Markdown, native links, popup denial, IPC validation, continuity')
    }
    check(unhandled.length === 0, 'main process has no unhandled promise rejection: ' + unhandled.join(', '))
    check(escaped.length === 0, 'no request left the owned server: ' + escaped.join(', '))
    check(!requests.some(url => url.startsWith('/outside')), 'foreign content was never requested or executed')
    console.log('EXTERNAL_LINKS_PASSED (' + assertions + ' assertions; OS opener stubbed; no external network)')
  } finally {
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    session.defaultSession.webRequest.onBeforeRequest(null)
    await new Promise(done => server.close(done))
    console.warn = originalWarn
  }
}

try {
  for (const path of ['main', 'preload', 'renderer']) mkdirSync(join(directory, path))
  writeFileSync(join(directory, 'renderer/index.html'), '<!doctype html><meta charset="utf-8"><button id="ping">App still works</button><div id="root"></div><script src="./renderer.js"></script>')
  await build({ stdin: { contents: renderer, resolveDir: process.cwd(), loader: 'tsx' }, outfile: join(directory, 'renderer/renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning' })
  await build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload/index.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })
  await build({ stdin: { contents: `import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {installWindowNavigation} from '${absolute('src/main/services/window-navigation.ts')}';${loader.getText(source)};export {loadAppWindow};`, resolveDir: process.cwd(), loader: 'ts' }, outfile: join(directory, 'main/loader.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })
  await build({ stdin: { contents: `export {registerFilesIpc} from '${absolute('src/main/ipc/files.ts')}';export {externalHttpUrl} from '${absolute('src/shared/external-url.ts')}';export {openExternalHttpUrl} from '${absolute('src/main/services/window-navigation.ts')}';`, resolveDir: process.cwd() }, outfile: join(directory, 'main/boundary.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning', plugins: [{ name: 'unrelated-file-services', setup(builder) {
    builder.onResolve({ filter: /^\.\.\/(state|services\/scan)$/ }, args => ({ path: args.path, namespace: 'unused' }))
    builder.onLoad({ filter: /.*/, namespace: 'unused' }, () => ({ contents: 'export const writeSpecFile=()=>{},computeSpecBacklinks=()=>{},readTextWithMtime=()=>{},searchDocs=()=>{},getProjectRoot=()=>null,sendSnapshot=()=>{},safeReadText=()=>{};', loader: 'js' }))
  } }] })
  writeFileSync(join(directory, 'main/test.cjs'), '(' + nativeChecks.toString() + ')().then(()=>require("electron").app.exit(0),error=>{console.error(error);require("electron").app.exit(1)});setTimeout(()=>{console.error("external links fixture timed out");require("electron").app.exit(1)},60000);')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron')
  const result = await promisify(execFile)(electron, [join(directory, 'main/test.cjs')], { env, timeout: 75000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  assert.ok(result.stdout.includes('EXTERNAL_LINKS_PASSED'), result.stdout + result.stderr)
  console.log(result.stdout.trim())
} catch (error) {
  console.error(error.stdout ?? '')
  console.error(error.stderr ?? '')
  throw error
} finally {
  // Only the exact directory returned by mkdtempSync is removed; no app profile is touched.
  rmSync(directory, { recursive: true, force: true })
}
