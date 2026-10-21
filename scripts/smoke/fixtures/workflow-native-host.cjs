/** Actual production app; only unrelated global OS registration is disabled. */
const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron')
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const fixture = process.env.TPANEL_WORKFLOW_FIXTURE, snapshot = process.env.TPANEL_WORKFLOW_SNAPSHOT, reportDir = process.env.TPANEL_WORKFLOW_REPORT
if (!fixture || !snapshot || !reportDir) throw Error('Missing isolated paths')
for (const name of ['profile', 'app-data', 'session-data', 'logs']) mkdirSync(join(fixture, name), { recursive: true })
app.setPath('userData', join(fixture, 'profile')); app.setPath('appData', join(fixture, 'app-data')); app.setPath('sessionData', join(fixture, 'session-data')); app.setAppLogsPath(join(fixture, 'logs'))
app.setAsDefaultProtocolClient = () => false; app.setLoginItemSettings = () => {}
globalShortcut.register = () => false; globalShortcut.unregisterAll = () => {}
const results = [], permissions = [], errors = [], observed = []
let bootstrapped = false, main, finalSnapshot, origin, started
const registration = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => registration(channel, async (...args) => { const value = await listener(...args); if (channel === 'bridge:pullFocus') bootstrapped = true; return value })
const wait = async (predicate, label, ms = 20000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { const found = await predicate(); if (found) return found; await new Promise((done) => setTimeout(done, 80)) } throw Error(`Native workflow timeout: ${label}`) }
const invoke = (method, ...args) => main.webContents.executeJavaScript(`window.trellis[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
const managed = (method, ...args) => main.webContents.executeJavaScript(`window.trellis.managedWorkflow[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
const check = async (name, work) => { await work(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`) }
const root = join(fixture, 'project'), taskDir = 'native-integration', task = join(root, '.trellis/tasks', taskDir), nonce = randomUUID()
mkdirSync(task, { recursive: true }); mkdirSync(join(root, '.trellis/spec/backend'), { recursive: true }); mkdirSync(join(root, '.trellis/flows'), { recursive: true })
writeFileSync(join(task, 'task.json'), JSON.stringify({ id: 'native-integration', title: 'Isolated actual desktop workflow acceptance', status: 'in_progress', priority: 'P2', description: 'Explicitly authorized owned semantic integration test only' }))
const requirement = `Build greeting.mjs exporting greet(name). Require string input or throw TypeError. Trim whitespace. Return Hello, <name>! for nonempty trimmed names, otherwise Hello, world!. No network/dependencies. Source nonce: ${nonce}.`
writeFileSync(join(task, 'source.md'), '# Owned requirement\n\n' + requirement)
writeFileSync(join(root, '.trellis/spec/backend/greeting.md'), '# Greeting contract\n\n' + requirement + '\nPreserve source nonce in PRD and design. Only modify this owned fixture project.')
writeFileSync(join(task, 'implement.jsonl'), JSON.stringify({ file: '.trellis/spec/backend/greeting.md', reason: 'Exact semantic contract and source nonce' }) + '\n')
writeFileSync(join(root, 'AGENTS.md'), 'This is an isolated integration fixture. The task is authorized and in_progress. Follow the provided stage instruction and exact greeting spec. Do not create unrelated tasks, contact services, install packages or modify other projects.\n')
const stages = [
  { id: 'prd', name: '需求文档', file: `.trellis/tasks/${taskDir}/prd.md`, kind: 'trellis-prd', instruction: `Read the supplied exact greeting specification. Write a concise PRD with the source nonce to .trellis/tasks/${taskDir}/prd.md. Do not implement code or design yet.` },
  { id: 'design', name: '技术设计', file: `.trellis/tasks/${taskDir}/design.md`, kind: 'design', instruction: `Use the provided PRD and greeting spec. Write a concise design with the source nonce to .trellis/tasks/${taskDir}/design.md. Do not implement code yet.` },
  { id: 'implement', name: '功能实现', file: `.trellis/tasks/${taskDir}/implementation.md`, kind: 'other', instruction: `Implement greeting.mjs exactly according to the supplied greeting spec, PRD and design. Export greet. Keep it small, with no imports or external side effects. Also write a concise implementation note to .trellis/tasks/${taskDir}/implementation.md. Do not modify other files.` }
]
writeFileSync(join(root, '.trellis/flows/native-acceptance.flow.json'), JSON.stringify({ version: 1, id: 'native-acceptance', name: '实际桌面链路验证', description: 'Owned PRD, design and semantic code scenario', inputs: [], phases: stages.map((stage) => ({ id: stage.id, name: stage.name, steps: [{ id: stage.id, name: stage.name, kind: 'agent', instruction: stage.instruction, workflowOutput: { files: [{ path: stage.file, kind: stage.kind, required: true }], maxRepairTurns: 1 } }] })) }))
require(resolve(snapshot, 'out/main/index.js'))
const watchdog = setTimeout(() => { writeFileSync(join(reportDir, 'native-workflow-timeout.json'), JSON.stringify({ results, ownedShutdown: 'unconfirmed', fixture }, null, 2)); app.exit(1) }, 340000)
async function run() {
  await app.whenReady()
  main = await wait(async () => { for (const window of BrowserWindow.getAllWindows()) { if (window.isDestroyed() || window.webContents.isLoading()) continue; const url = window.webContents.getURL(); if (!url || new URL(url).searchParams.has('mode')) continue; if (await window.webContents.executeJavaScript('Boolean(window.trellis?.managedWorkflow)').catch(() => false)) return window } return false }, 'production main')
  await wait(() => bootstrapped, 'production bootstrap')
  main.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  // Native IPC alone does not set React's project snapshot. Exercise the actual
  // persisted recent-project bootstrap, without importing or replacing UI stores.
  await invoke('setSettings', { recentProjects: [root], acp: { nodePath: process.env.TPANEL_WORKFLOW_NODE } })
  bootstrapped = false
  main.webContents.reload()
  await wait(() => bootstrapped && !main.webContents.isLoading(), 'actual persisted project bootstrap')
  assert.equal((await invoke('getSnapshot')).meta.root, root)
  if (process.env.TPANEL_WORKFLOW_RECOVERY_ONLY === '1') {
    await main.webContents.executeJavaScript('document.querySelector("button[aria-label=智能体]").click();true')
    await wait(() => main.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).some(button=>button.textContent.includes("检查保留记录"))'), 'project recovery without native session')
    await main.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find(button=>button.textContent.includes("检查保留记录")).click();true')
    await check('actual project recovery opens and inspects retained ownership with no selected or installed native adapter', async () => {
      await wait(() => main.webContents.executeJavaScript('document.querySelector("[aria-label=保留的工作流运行记录]")?.textContent.includes("没有可展示的保留运行")'), 'actual empty retained owner')
      assert.equal((await invoke('acpSessions')).sessions.length, 0)
      writeFileSync(join(reportDir, 'native-recovery-launcher.png'), (await main.webContents.capturePage()).toPNG())
    })
    writeFileSync(join(reportDir, 'native-recovery-launcher-report.json'), JSON.stringify({ status: 'passed-observed-native-subset', scenario: 'Owned source project with no retained run', nativeTransport: 'No adapter installed into isolated profile and no native session/model request', versions: process.versions, results, qualification: 'Actual production recovery launcher/main retained-owner empty read, not native unknown-stop recovery or release proof', builtMainSha256: createHash('sha256').update(readFileSync(resolve(snapshot, 'out/main/index.js'))).digest('hex') }, null, 2))
    clearTimeout(watchdog); app.once('will-quit', () => console.log('WORKFLOW_NATIVE_APP_PASSED')); app.quit(); return
  }
  await main.webContents.executeJavaScript('window.__nativeWorkflowPermissions=[];window.trellis.onAcpPermission(value=>window.__nativeWorkflowPermissions.push({requestId:value.requestId,sessionId:value.sessionId,connectionGeneration:value.connectionGeneration}));true')
  const connected = await invoke('acpSessionNew', { agentId: 'codex', taskDir }); assert.equal(connected.ok, true, JSON.stringify(connected)); origin = connected.sessionId
  const session = await wait(async () => { const page = await invoke('acpSessions', 20); if (!page.ok) return false; const current = page.sessions.find((item) => item.sessionId === origin); if (current && ['error', 'disconnected', 'closed'].includes(current.status)) throw Error(current.error ?? current.status); return current?.status === 'ready' ? current : false }, 'actual managed Codex origin ready', 60000)
  const source = await invoke('documentCaptureVersion', `.trellis/tasks/${taskDir}/source.md`); assert.equal(source.ok, true, JSON.stringify(source))
  const opened = await invoke('documentOpenWindow', { token: source.version.token, origin: { taskDir, sessionId: origin, connectionGeneration: session.connectionGeneration } }); assert.equal(opened.ok, true, JSON.stringify(opened))
  const reader = await wait(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getURL().includes(encodeURIComponent(opened.viewId))), 'real origin reader')
  await wait(async () => !reader.webContents.isLoading() && await reader.webContents.executeJavaScript('Boolean(window.trellis?.documentWindowReturn)'), 'reader bootstrap')
  assert.equal((await reader.webContents.executeJavaScript('window.trellis.documentWindowReturn()')).ok, true)
  if (process.env.TPANEL_WORKFLOW_SELECT_ORIGIN === '1') {
    // Explicit real sidebar selection isolates native-chain acceptance from the
    // separately recorded first-mount return-target defect. Never hide that gate.
    await wait(() => main.webContents.executeJavaScript(`Boolean(document.querySelector('[data-acp-session=${JSON.stringify(origin)}]'))`), 'exact origin sidebar entry')
    await main.webContents.executeJavaScript(`document.querySelector('[data-acp-session=${JSON.stringify(origin)}]').click();true`)
  }
  await wait(() => main.webContents.executeJavaScript('Boolean(document.querySelector(".wf-panel"))'), 'actual conversation workflow panel')
  if (process.env.TPANEL_WORKFLOW_NAVIGATION_ONLY === '1') {
    await check('actual first-mount native document return selects exact ready original conversation without sidebar fallback', async () => {
      assert.ok(!process.env.TPANEL_WORKFLOW_SELECT_ORIGIN)
      const selected = await main.webContents.executeJavaScript('document.querySelector("[data-acp-session][aria-current=page]")?.getAttribute("data-acp-session")')
      assert.equal(selected, origin)
      assert.equal((await invoke('acpSessions')).sessions.length, 1, 'Reading return must not create another native session')
      writeFileSync(join(reportDir, 'native-navigation-corrected.png'), (await main.webContents.capturePage()).toPNG())
    })
    writeFileSync(join(reportDir, 'native-navigation-report.json'), JSON.stringify({ status: 'passed-observed-native-subset', scenario: 'owned synthetic source project', nativeTransport: 'Actual managed Codex initialization; no model prompt dispatched', versions: process.versions, results, selectedSession: origin, navigation: 'Actual reader return, no sidebar fallback', builtMainSha256: createHash('sha256').update(readFileSync(resolve(snapshot, 'out/main/index.js'))).digest('hex') }, null, 2))
    clearTimeout(watchdog); app.once('will-quit', () => console.log('WORKFLOW_NATIVE_APP_PASSED')); app.quit(); return
  }
  await main.webContents.executeJavaScript('const button=document.querySelector(".wf-disclosure");if(button?.getAttribute("aria-expanded")==="false")button.click();true')
  const preview = await managed('preview', root, { taskDir, flowId: 'native-acceptance', origin: { sessionId: origin, connectionGeneration: session.connectionGeneration } }); assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.value.graph.nodes.length, 3)
  started = await managed('start', root, { taskDir, commandId: randomUUID(), previewId: preview.value.previewId }); assert.equal(started.ok, true, JSON.stringify(started))
  let lastRevision = null
  finalSnapshot = await wait(async () => {
    const requests = await main.webContents.executeJavaScript('window.__nativeWorkflowPermissions'); if (requests.length) { permissions.push(...requests); throw Error('Original native permission requires a person; no automatic approval performed') }
    const current = await managed('snapshot', root, { taskDir }); assert.equal(current.ok, true, JSON.stringify(current))
    const value = current.value, run = value.snapshot?.run
    if (run && lastRevision !== run.run.revision) { lastRevision = run.run.revision; observed.push({ run: run.run, state: run.state, nodes: value.nodes.map((node) => ({ nodeId: node.nodeId, state: node.state, sessionId: node.sessionId, turnId: node.turnId, historyCommitted: node.historyCommitted })) }); writeFileSync(join(reportDir, `native-stage-${lastRevision}.png`), (await main.webContents.capturePage()).toPNG()); console.log(`OBSERVED revision ${lastRevision}: ${run.state}`) }
    if (run && ['failed', 'stopped', 'cancelled', 'outcome-unknown'].includes(run.state)) throw Error(`Actual workflow did not verify: ${run.state}`)
    return run?.state === 'verified' && value.composer.target === 'ordinary' ? value : false
  }, 'three actual native stages', 240000)
  await check('actual main IPC/controller/managed Codex completes three distinct material-pinned stages', async () => {
    assert.equal(finalSnapshot.nodes.length, 3); assert.ok(finalSnapshot.nodes.every((node) => node.state === 'verified' && node.turnId && node.historyCommitted && node.outputRefs.length))
    assert.equal(new Set(finalSnapshot.nodes.map((node) => node.turnId)).size, 3)
    assert.ok(readFileSync(join(task, 'prd.md'), 'utf8').includes(nonce)); assert.ok(readFileSync(join(task, 'design.md'), 'utf8').includes(nonce))
    const module = await import(pathToFileURL(join(root, 'greeting.mjs')).href)
    assert.equal(module.greet(' Alice '), 'Hello, Alice!'); assert.equal(module.greet('  '), 'Hello, world!'); assert.equal(module.greet(''), 'Hello, world!'); assert.throws(() => module.greet(null), TypeError)
  })
  await check('actual production conversation graph consumes committed verified stage facts', async () => {
    await wait(() => main.webContents.executeJavaScript('document.querySelectorAll(".wf-stage[data-state=verified]").length===3'), 'committed live graph')
    const text = await main.webContents.executeJavaScript('document.querySelector(".wf-panel").innerText')
    assert.ok(text.includes('需求文档') && text.includes('技术设计') && text.includes('功能实现'))
    writeFileSync(join(reportDir, 'native-workflow-complete.png'), (await main.webContents.capturePage()).toPNG())
  })
  await check('actual committed spec receipts identify emitted immutable source for every stage', async () => {
    const events = []; let cursor = null
    for (let index = 0; index < 40; index++) {
      const page = await managed('events', root, { taskDir, cursor, limit: 200 }); assert.equal(page.ok, true, JSON.stringify(page))
      events.push(...page.value.items.map((item) => item.event)); cursor = page.value.cursor
      if (!page.value.hasMore) break
      assert.ok(index < 39, 'Explicit event read limit reached')
    }
    const receipts = events.filter((event) => event.type === 'workflow.context-emitted-to-host' && event.payload.material?.source?.relativePath === '.trellis/spec/backend/greeting.md')
    assert.equal(new Set(receipts.map((event) => event.attribution.run.revision)).size, 3)
    assert.ok(receipts.every((event) => event.payload.includedDigest && event.payload.material.sourceDigest))
    writeFileSync(join(reportDir, 'native-spec-receipts.json'), JSON.stringify(receipts, null, 2))
  })
  await check('fixed PRD body remains actual generated A after working file is replaced', async () => {
    const node = finalSnapshot.nodes[0], version = await managed('artifact', root, { taskDir, run: node.run, ref: node.outputRefs[0] }); assert.equal(version.ok, true, JSON.stringify(version))
    writeFileSync(join(task, 'prd.md'), '# New disk B\nThis must not replace pinned generated A.\n')
    const view = await invoke('documentOpenWindow', { token: version.value.token, origin: { taskDir, sessionId: origin, connectionGeneration: session.connectionGeneration } }); assert.equal(view.ok, true)
    const window = await wait(() => BrowserWindow.getAllWindows().find((entry) => !entry.isDestroyed() && entry.webContents.getURL().includes(encodeURIComponent(view.viewId))), 'fixed actual PRD reader')
    const bootstrap = await wait(async () => { if (window.webContents.isLoading()) return false; return window.webContents.executeJavaScript('window.trellis.documentWindowBootstrap()').catch(() => false) }, 'fixed PRD bootstrap')
    assert.equal(bootstrap.ok, true); assert.ok(bootstrap.document.rawText.includes(nonce)); assert.equal(bootstrap.document.rawText.includes('New disk B'), false)
    writeFileSync(join(reportDir, 'native-fixed-prd.png'), (await window.webContents.capturePage()).toPNG())
  })
  const report = { status: 'passed-observed-native-subset', fixture: false, packaged: app.isPackaged, scope: 'Actual production main/preload/controller/driver/material/history and live renderer graph using installed managed Codex in isolated owned project; actions invoked through actual preload API', navigation: process.env.TPANEL_WORKFLOW_SELECT_ORIGIN === '1' ? 'Explicit exact-session sidebar selection; first-mount source-return defect remains separately open' : 'Actual reader return selected original conversation', versions: process.versions, results, observed, final: { scope: finalSnapshot.scope, run: finalSnapshot.snapshot.run, nodes: finalSnapshot.nodes }, codeEvidence: { source: 'greeting.mjs', digest: createHash('sha256').update(readFileSync(join(root, 'greeting.mjs'))).digest('hex'), qualification: 'Actual independently tested working code; immutable workflow outputs are task PRD/design/implementation documents' }, permissions, rendererErrors: errors, hooks: 'unobserved', internalChildren: 'unobserved', notRun: ['human permission approval', 'revision/feedback UI', 'company Jira/SSO', 'native crash/drain recovery', 'parallel branches', 'installed/mixed-display/human acceptance'], builtMainSha256: createHash('sha256').update(readFileSync(resolve(snapshot, 'out/main/index.js'))).digest('hex') }
  writeFileSync(join(reportDir, 'native-workflow-report.json'), JSON.stringify(report, null, 2))
  clearTimeout(watchdog)
  // Success marker requires the actual application quit protocol, not app.exit.
  app.once('will-quit', () => console.log('WORKFLOW_NATIVE_APP_PASSED'))
  app.quit()
}
run().catch(async (error) => {
  const failure = JSON.stringify({ status: 'failed', message: error.message, stack: error.stack, results, observed, permissions, fixture, ownedShutdown: 'unconfirmed' }, null, 2)
  writeFileSync(join(reportDir, `native-workflow-failure-${Date.now()}.json`), failure)
  writeFileSync(join(reportDir, 'native-workflow-failure.json'), failure)
  if (main && !main.isDestroyed()) {
    writeFileSync(join(reportDir, 'native-workflow-failed-screen.png'), (await main.webContents.capturePage()).toPNG())
    writeFileSync(join(reportDir, 'native-workflow-failed-screen.txt'), await main.webContents.executeJavaScript('document.body.innerText'))
  }
  console.error(error.stack); app.quit()
})
