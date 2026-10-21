/** Actual built application + native BrowserWindows; isolated OS integration/profile. */
const { app, BrowserWindow, globalShortcut, screen, ipcMain } = require('electron')
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const assert = require('node:assert/strict')
const fixture = process.env.TPANEL_NATIVE_FIXTURE_ROOT
const reportDir = process.env.TPANEL_NATIVE_REPORT_DIR
const repo = process.env.TPANEL_NATIVE_REPO_ROOT
if (!fixture || !reportDir || !repo) throw Error('Native fixture paths missing')
for (const name of ['profile', 'app-data', 'session-data', 'logs']) mkdirSync(join(fixture, name), { recursive: true })
app.setPath('userData', join(fixture, 'profile'))
app.setPath('appData', join(fixture, 'app-data'))
app.setPath('sessionData', join(fixture, 'session-data'))
app.setAppLogsPath(join(fixture, 'logs'))
// Only unrelated OS registration is disabled. Native readers, IPC and rendering are real.
app.setAsDefaultProtocolClient = () => false
app.setLoginItemSettings = () => {}
globalShortcut.register = () => false
globalShortcut.unregisterAll = () => {}
delete process.env.ELECTRON_RENDERER_URL
delete process.env.TPANEL_DEBUG_PORT
const results = []
const warnings = []
const startedAt = Date.now()
const memorySamples = []
const sampleMemory = (phase) => memorySamples.push({ phase, elapsedMs: Date.now() - startedAt, processes: app.getAppMetrics().map(({ pid, type, name, memory }) => ({ pid, type, name, memory })) })
let bootstrapFocusRead = false
const registerHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => registerHandle(channel, async (...args) => {
  const result = await listener(...args)
  if (channel === 'bridge:pullFocus') bootstrapFocusRead = true
  return result
})
const wait = async (test, label, ms = 20000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { const found = await test(); if (found) return found; await new Promise((done) => setTimeout(done, 30)) } throw Error(`Native timeout: ${label}`) }
const invoke = (window, method, ...args) => window.webContents.executeJavaScript(`window.trellis[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
const check = async (name, fn) => { await fn(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`) }
const heading = (window) => window.webContents.executeJavaScript("Array.from(document.querySelectorAll('h1')).map(element=>element.textContent)")
const source = '.trellis/tasks/task-native/prd.md'
const rootA = join(fixture, 'project-a'); const rootB = join(fixture, 'project-b')
for (const root of [rootA, rootB]) {
  const directory = join(root, '.trellis/tasks/task-native'); mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'task.json'), JSON.stringify({ id: 'native-task', title: 'Native reader acceptance fixture', status: 'in_progress', priority: 'P2', assignee: '', description: 'Isolated owned files only' }))
  writeFileSync(join(directory, 'prd.md'), '# Requirements A\n\nSelected immutable A.\n\n| Field | Rule |\n| --- | --- |\n| owner | verified |\n\n' + 'Retained reader paragraph.\n\n'.repeat(60))
}
const watchdog = setTimeout(() => { console.error('Native application fixture exceeded deadline'); app.exit(1) }, 100000)
require(resolve(repo, 'out/main/index.js'))

async function run() {
  await app.whenReady()
  const main = await wait(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isLoading()) continue
      const url = window.webContents.getURL()
      if (!url || new URL(url).searchParams.has('mode')) continue
      if (await window.webContents.executeJavaScript('Boolean(window.trellis?.documentCaptureVersion)').catch(() => false)) return window
    }
    return false
  }, 'actual main renderer/preload')
  await wait(() => bootstrapFocusRead, 'actual renderer initial bootstrap completion')
  const bootstrapReadyMs = Date.now() - startedAt
  sampleMemory('main-renderer-bootstrap-ready')
  main.webContents.on('console-message', (event) => { if (event.level === 'error') warnings.push(event.message) })
  assert.equal((await invoke(main, 'openProject', rootA)).ok, true)
  const a = await invoke(main, 'documentCaptureVersion', source); assert.equal(a.ok, true, JSON.stringify(a))
  writeFileSync(join(rootA, source), '# Requirements B\n\nNew current file B must not replace selected A.\n')
  const b = await invoke(main, 'documentCaptureVersion', source); assert.equal(b.ok, true, JSON.stringify(b))
  const openedA = await invoke(main, 'documentOpenWindow', { token: a.version.token, origin: { taskDir: 'task-native' } }); assert.equal(openedA.ok, true)
  const openedB = await invoke(main, 'documentOpenWindow', { token: b.version.token, origin: { taskDir: 'task-native' } }); assert.equal(openedB.ok, true)
  const findView = (id) => wait(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getURL().includes(encodeURIComponent(id))), 'actual source window')
  const left = await findView(openedA.viewId); const right = await findView(openedB.viewId)
  await check('built main/preload/reader open two independent native pinned versions after disk changes', async () => {
    await wait(async () => (await heading(left)).includes('Requirements A'), 'version A heading')
    await wait(async () => (await heading(right)).includes('Requirements B'), 'version B heading')
    assert.equal((await heading(left)).includes('Requirements B'), false)
    assert.notEqual(left.id, right.id)
    const boot = await invoke(left, 'documentWindowBootstrap')
    assert.equal(boot.version.digest, a.version.digest)
    assert.equal(boot.document.rawText.includes('Selected immutable A'), true)
    sampleMemory('two-native-readers-open')
  })
  await check('actual native pin is sender-bound and independently reversible', async () => {
    assert.equal(left.isAlwaysOnTop(), true); assert.equal(right.isAlwaysOnTop(), true)
    assert.equal((await invoke(main, 'docSetPin', false)).ok, false)
    const off = await invoke(left, 'docSetPin', false); assert.equal(off.ok, true)
    assert.equal(left.isAlwaysOnTop(), false); assert.equal(right.isAlwaysOnTop(), true)
    assert.equal((await invoke(left, 'docSetPin', true)).ok, true); assert.equal(left.isAlwaysOnTop(), true)
  })
  await check('actual native minimize/maximize/restore operate on originating reader only', async () => {
    await invoke(left, 'windowMinimize'); await wait(() => left.isMinimized(), 'native minimized')
    assert.equal(right.isMinimized(), false); left.restore(); await wait(() => !left.isMinimized(), 'native restored')
    await invoke(left, 'windowMaximize'); await wait(() => left.isMaximized(), 'native maximized')
    assert.equal(right.isMaximized(), false)
    await invoke(left, 'windowMaximize'); await wait(() => !left.isMaximized(), 'native unmaximized')
    left.setSize(840, 700); await wait(() => left.getBounds().width === 840, 'native resize')
    assert.equal((await heading(left)).includes('Requirements A'), true)
  })
  await check('return restores hidden source main and delivers exact recorded origin', async () => {
    await main.webContents.executeJavaScript('window.__nativeReaderReturns=[];window.trellis.onDocumentOriginReturn(origin=>window.__nativeReaderReturns.push(origin));true')
    main.hide(); assert.equal(main.isVisible(), false)
    const returned = await invoke(left, 'documentWindowReturn'); assert.equal(returned.ok, true)
    await wait(() => main.isVisible(), 'source main visible')
    const origin = await wait(async () => (await main.webContents.executeJavaScript('window.__nativeReaderReturns')).at(-1), 'exact origin event')
    assert.equal(origin.projectRoot, rootA); assert.equal(origin.taskDir, join(rootA, '.trellis/tasks/task-native'))
  })
  await check('same-named foreign project cannot retarget a pinned native source or return action', async () => {
    assert.equal((await invoke(main, 'openProject', rootB)).ok, true)
    assert.equal((await invoke(left, 'documentWindowBootstrap')).sourceActive, false)
    assert.equal((await heading(left)).includes('Requirements A'), true)
    assert.equal((await invoke(left, 'documentWindowReturn')).ok, true)
    assert.equal((await invoke(main, 'getSnapshot')).meta.root, rootA)
    assert.equal((await invoke(left, 'documentWindowReturn')).ok, true)
  })
  await check('source close/reopen preserves selected immutable document and independent native view', async () => {
    const token = a.version.token; left.close(); await wait(() => left.isDestroyed(), 'source reader closed')
    const reopened = await invoke(main, 'documentOpenWindow', { token, origin: { taskDir: 'task-native' } }); assert.equal(reopened.ok, true)
    const next = await findView(reopened.viewId)
    await wait(async () => (await heading(next)).includes('Requirements A'), 'reopened exact version')
    assert.equal((await heading(right)).includes('Requirements B'), true)
    const image = await next.webContents.capturePage(); writeFileSync(join(reportDir, 'native-reader-A.png'), image.toPNG())
    const other = await right.webContents.capturePage(); writeFileSync(join(reportDir, 'native-reader-B.png'), other.toPNG())
  })
  const displays = screen.getAllDisplays().map(({ id, bounds, workArea, scaleFactor }) => ({ id, bounds, workArea, scaleFactor }))
  const report = {
    status: 'passed-observed-native-subset', packaged: app.isPackaged, versions: process.versions,
    scope: 'Actual built production main, preload, renderer, document IPC/material registry and real Electron BrowserWindows in isolated development instance',
    osBoundariesDisabled: ['protocol registration', 'global shortcut registration', 'login item configuration'],
    results, displays, rendererConsoleErrors: warnings,
    measurements: { bootstrapReadyMs, memoryUnit: 'Electron ProcessMetric.memory KB fields; shared pages across processes are not deduplicated', memorySamples, qualification: 'Instrumented isolated development instance, synthetic documents; not packaged cold-start or multi-native-session benchmark' },
    notRun: ['installed/packaged application', 'human OS stacking/focus acceptance', 'human visual acceptance', 'actual mixed-DPI/cross-display move', 'OS restart placement'],
    artifacts: ['native-reader-A.png', 'native-reader-B.png'],
    builtMainSha256: createHash('sha256').update(readFileSync(resolve(repo, 'out/main/index.js'))).digest('hex'),
    builtPreloadSha256: createHash('sha256').update(readFileSync(resolve(repo, 'out/preload/index.js'))).digest('hex')
  }
  writeFileSync(join(reportDir, 'native-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('READING_WINDOW_NATIVE_APP_PASSED')
  clearTimeout(watchdog); app.quit()
}
run().catch((error) => { writeFileSync(join(reportDir, 'native-failure.json'), JSON.stringify({ status: 'failed', message: error.message, stack: error.stack, results }, null, 2)); console.error(error.stack); clearTimeout(watchdog); app.exit(1) })
