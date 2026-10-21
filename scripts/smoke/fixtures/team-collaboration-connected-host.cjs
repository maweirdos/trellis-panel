/** Actual desktop UI/preload/service + actual server Web in separate browser partitions. */
const { app, BrowserWindow, globalShortcut, ipcMain, session, shell, safeStorage } = require('electron')
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const {DatabaseSync}=require('node:sqlite')
const workerModule=require('node:worker_threads')
const assert = require('node:assert/strict')
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8')), phase = process.argv[3]
const sourceRoot = join(cfg.fixture, 'owned-project'), profile = join(cfg.fixture, 'desktop-profile')
for (const directory of [profile, join(cfg.fixture, 'app-data'), join(cfg.fixture, 'session-data'), join(cfg.fixture, 'logs'), join(sourceRoot, '.trellis/tasks/owned-task')]) mkdirSync(directory, { recursive: true })
if (!existsSync(join(sourceRoot, '.trellis/tasks/owned-task/task.json'))) writeFileSync(join(sourceRoot, '.trellis/tasks/owned-task/task.json'), JSON.stringify({ id: 'owned-task', title: 'Owned connected collaboration fixture', status: 'in_progress', priority: 'P2', description: 'Actual local accounts and service; no native model task' }))
app.setPath('userData', profile); app.setPath('appData', join(cfg.fixture, 'app-data')); app.setPath('sessionData', join(cfg.fixture, 'session-data')); app.setAppLogsPath(join(cfg.fixture, 'logs'))
app.setAsDefaultProtocolClient = () => false; app.setLoginItemSettings = () => {}
globalShortcut.register = () => false; globalShortcut.unregisterAll = () => {}
const external = [], checks = [], errors = [], windows = []
// Observers delegate to the real native methods/Worker; no result or persistence
// is fabricated. Do not retain or print plaintext credential values.
const protection={encryptCalls:0,decryptCalls:0,plaintextAbsent:true},ownedWorkers=[]
const encryptNative=safeStorage.encryptString.bind(safeStorage),decryptNative=safeStorage.decryptString.bind(safeStorage)
safeStorage.encryptString=value=>{const result=encryptNative(value);protection.encryptCalls++;assert.equal(result.includes(Buffer.from(value,'utf8')),false);return result}
safeStorage.decryptString=value=>{const result=decryptNative(value);protection.decryptCalls++;return result}
const NativeWorker=workerModule.Worker
workerModule.Worker=class ObservedNativeWorker extends NativeWorker {constructor(file,options){super(file,options);const row={file:String(file).replaceAll('\\','/').split('/').at(-1),exited:false,exitCode:null};ownedWorkers.push(row);this.once('exit',code=>{row.exited=true;row.exitCode=code})}}
const credentialProof=async connectionId=>{
 const path=join(profile,'team-platform/team-desktop.sqlite')
 return wait(()=>{let db;try{db=new DatabaseSync(path,{readOnly:true});const row=db.prepare('SELECT data FROM connections WHERE id=?').get(connectionId);assert.ok(row);const value=JSON.parse(row.data);assert.equal(typeof value.encryptedToken,'string');assert.equal('token'in value,false);assert.equal('deviceToken'in value,false);const bytes=Buffer.from(value.encryptedToken,'base64');assert.ok(bytes.length>32);assert.equal(/td_[A-Za-z0-9_-]{43}/.test(bytes.toString('utf8')),false);return{cipherDigest:createHash('sha256').update(bytes).digest('hex'),connectionId:value.connectionId}}
 catch(error){if(error.code==='SQLITE_BUSY'||error.code==='ERR_SQLITE_ERROR'&&String(error.message).includes('locked'))return false;throw error}finally{db?.close()}},'actual worker encrypted connection row')
}

// Explicit OS-browser boundary only. The enrollment itself is approved in the
// actual built Web UI with a real OIDC-authenticated browser cookie partition.
shell.openExternal = async (url) => { assert.equal(new URL(url).origin, cfg.origin); assert.ok(new URL(url).searchParams.has('pairing')); external.push(url) }
let bootstrapped = false, main
const registration = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => registration(channel, async (...args) => { const value = await listener(...args); if (channel === 'bridge:pullFocus') bootstrapped = true; return value })
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const run = (window, code) => window.webContents.executeJavaScript(code, true)
const wait = async (predicate, label, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const found = await predicate(); if (found) return found; await delay(60) } throw Error('Connected timeout: ' + label) }
const invoke = (method, ...args) => run(main, `window.trellis[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
const team = async (method, ...args) => {
  const reply = await run(main, `window.trellis.teamDesktop[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
  if (!reply.ok) throw Object.assign(Error(`${method}: ${reply.code} ${reply.error}`), { code: reply.code })
  return reply.value
}
const click = async (window, text, exact = true) => {
  await wait(() => run(window, `(()=>{const button=Array.from(document.querySelectorAll('button')).find(item=>${exact ? `(item.getAttribute('aria-label')||item.textContent.trim())===${JSON.stringify(text)}` : `(item.getAttribute('aria-label')||item.textContent).includes(${JSON.stringify(text)})`});if(!button||button.disabled)return false;button.click();return true})()`), 'click ' + text)
  await delay(60)
}
const fill = async (window, selector, value) => {
  await run(window, `(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing fixture field');const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  await delay(50)
}
const check = async (name, action) => { await action(); checks.push({ name, status: 'passed' }); console.log('PASS ' + name) }
const capture = async (window, name) => {
  const [width, height] = window.getContentSize()
  window.setContentSize(width + 1, height); await delay(40); window.setContentSize(width, height)
  await run(window, 'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  writeFileSync(join(cfg.evidence, name), (await window.webContents.capturePage()).toPNG())
}
async function web(name, url = cfg.origin) {
  const partition = session.fromPartition('connected-web-' + name)
  await partition.setProxy({ mode: 'direct' })
  for (const cookie of cfg.cookies[name]) await partition.cookies.set(cookie)
  const window = new BrowserWindow({ show: false, width: 1360, height: 960, webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  windows.push(window); await window.loadURL(url)
  window.webContents.on('console-message', (event) => { if (event.level === 'error' && !/Failed to load resource/.test(event.message)) errors.push(event.message) })
  return window
}
async function openWorkspace() {
  await click(main, '团队')
  await click(main, '团队共享')
  await wait(() => run(main, 'Boolean(document.querySelector("[aria-label=团队共享工作台]"))'), 'actual desktop shared workspace')
}
async function selectNative(materialId) {
  await click(main, '共享文档')
  await click(main, '刷新共享目录')
  await wait(() => run(main, `Boolean(document.querySelector('[data-material-id=${JSON.stringify(materialId)}]'))`), 'actual material directory')
  await run(main, `document.querySelector('[data-material-id=${JSON.stringify(materialId)}]').click();true`)
  await wait(() => run(main, 'Boolean(document.querySelector(".team-reader-body[data-document-version]"))'), 'actual selected fixed reader')
}
async function selectWeb(window, materialId, title = cfg.title) {
  await wait(() => run(window, `Boolean(document.querySelector('[aria-label="当前项目"] option[value=${JSON.stringify(cfg.projectId)}]'))`), 'actual authorized project')
  await fill(window, '[aria-label="当前项目"]', cfg.projectId)
  await click(window, '刷新资料列表')
  await click(window, title, false)
  await wait(() => run(window, 'Boolean(document.querySelector(".markdown"))'), 'actual Web fixed body')
}
async function publishFromUi(title, body, visibility) {
  await click(main, '发布文档')
  await wait(() => run(main, 'Boolean(document.querySelector("[aria-label=发布文档正文]"))'), 'actual publication form')
  await fill(main, '[aria-label="发布文档标题"]', title)
  await fill(main, '[aria-label="发布文档正文"]', body)
  if (visibility) await fill(main, '[aria-label="发布可见范围"]', visibility)
  await click(main, '保存并发布')
  await wait(() => run(main, 'document.body.textContent.includes("已保存原操作到本机队列")'), 'actual durable local intent')
  await click(main, '完成')
  return wait(async () => (await team('outbox', (await team('connections'))[0].connectionId, { limit: 100 })).items.find((item) => item.title === title), 'actual persisted publication row')
}
const watchdog = setTimeout(() => { writeFileSync(join(cfg.evidence, `phase-${phase}-timeout.json`), JSON.stringify({ checks, ownedShutdown: 'unconfirmed' })); app.exit(1) }, 145000)
require(resolve(cfg.snapshot, 'out/main/index.js'))
async function work() {
  await app.whenReady()
  assert.equal(safeStorage.isEncryptionAvailable(),true,'Actual native credential protection must be available')
  main = await wait(async () => { for (const window of BrowserWindow.getAllWindows()) { if (window.isDestroyed() || window.webContents.isLoading()) continue; const url = window.webContents.getURL(); if (!url || new URL(url).searchParams.has('mode')) continue; if (await run(window, 'Boolean(window.trellis?.teamDesktop)').catch(() => false)) return window } return false }, 'actual main preload')
  await wait(() => bootstrapped, 'initial actual bootstrap')
  main.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  if (phase === 'one') {
    await invoke('setSettings', { recentProjects: [sourceRoot], proxy: { enabled: false, url: '' } })
    bootstrapped = false; main.webContents.reload(); await wait(() => bootstrapped && !main.webContents.isLoading(), 'real project bootstrap')
  }
  assert.equal((await invoke('getSnapshot')).meta.root, sourceRoot)
  await openWorkspace()
  let ids
  if (phase === 'one') {
    let connection
    await check('actual desktop encrypts pending setup and actual Web approves the exact project/code', async () => {
      await fill(main, '[aria-label="团队服务地址"]', cfg.origin)
      await fill(main, '[aria-label="本机设备名称"]', 'Bob 真实桌面验收')
      await click(main, '保存配对并打开浏览器')
      connection = await wait(async () => (await team('connections')).find((item) => item.state === 'pending'), 'persisted actual pending')
      assert.ok(protection.encryptCalls>0,'Production enrollment must invoke actual native safeStorage');
      assert.equal(connection.projectId, null); assert.equal(connection.ownerId, null); assert.ok(external.length === 1)
      const browser = await web('bob', connection.verificationUri)
      await wait(() => run(browser, 'Boolean(document.querySelector("[aria-label=配对项目]"))'), 'actual pairing Web UI')
      await fill(browser, '[aria-label="配对项目"]', cfg.projectId)
      await fill(browser, '[aria-label="桌面配对码"]', connection.userCode)
      await click(browser, '批准连接这个项目', false)
      connection = await wait(async () => (await team('connections')).find((item) => item.connectionId === connection.connectionId && item.state === 'active'), 'actual active device')
      const context = await team('connectionContext', connection.connectionId)
      assert.equal(context.person.userId, cfg.bobUserId); assert.equal(context.project.projectId, cfg.projectId); assert.ok(context.project.roles.includes('developer'))
    })
    let a, alice
    await check('desktop project publication is read as exact A in actual desktop and product Web', async () => {
      a = await publishFromUi(cfg.title, cfg.bodyA, 'project')
      a = await wait(async () => (await team('outbox', connection.connectionId, { limit: 100 })).items.find((item) => item.commandId === a.commandId && item.state === 'committed'), 'actual published A receipt')
      assert.equal(a.receipt.version, 1)
      const exact=await team('readDocument',{connectionId:connection.connectionId,materialId:a.materialId,version:1});assert.equal(exact.document.text,cfg.bodyA);assert.equal(exact.document.material.bodyDigest,createHash('sha256').update(Buffer.from(cfg.bodyA,'utf8')).digest('hex'))
      await selectNative(a.materialId)
      await wait(() => run(main, 'document.querySelector(".team-document-prose")?.textContent.includes("基线 A")'), 'desktop body A')
      await team('refreshSharedSnapshot', connection.connectionId)
      alice = await web('alice'); await selectWeb(alice, a.materialId)
      assert.ok(await run(alice, 'document.querySelector(".markdown").textContent.includes("基线 A")'))
      await capture(main, 'desktop-online-A.png'); await capture(alice, 'product-web-A.png')
    })
    let privateDraft, nextCommand, feedbackCommand
    await check('native-only network outage keeps published A readable and records actual product quote feedback', async () => {
      await invoke('setSettings', { proxy: { enabled: true, url: cfg.deadProxy } })
      const offline = await run(main, `window.trellis.teamDesktop.heartbeat(${JSON.stringify(connection.connectionId)})`)
      assert.equal(offline.ok, false, 'Only the native client must observe the actual refused proxy')
      assert.equal(offline.code, 'NETWORK_UNAVAILABLE')
      await click(alice, '选择原文批注')
      await run(alice, `(()=>{const element=document.querySelector('[aria-label="用于批注的固定版本原文"]');const index=element.value.indexOf(${JSON.stringify(cfg.quote)});if(index<0)throw Error('Owned original quote absent');element.setSelectionRange(index,index+${cfg.quote.length});})()`)
      await click(alice, '引用所选文字（最多 4000 字）')
      await fill(alice, '[aria-label="反馈内容"]', cfg.productFeedback); await click(alice, '记录反馈')
      await wait(() => run(alice, `document.body.textContent.includes(${JSON.stringify(cfg.productFeedback)})`), 'actual recorded product feedback')
      assert.equal(await run(alice, 'document.querySelector(".source-reader").value'),cfg.bodyA)
      await capture(alice, 'product-web-publisher-offline.png')
    })
    await check('actual offline desktop form queues private text and original version feedback without replacing pairing', async () => {
      privateDraft = await publishFromUi(cfg.privateTitle, cfg.privateBody)
      assert.equal(privateDraft.state, 'queued')
      nextCommand = randomUUID(); feedbackCommand = randomUUID()
      await team('queueAuthoredPublication', { connectionId: connection.connectionId, commandId: nextCommand, materialId: a.materialId, title: cfg.title, visibility: 'project', expectedVersion: 1, kind: 'product-requirement', text: cfg.bodyB, sourceVersion: 'owned-B-' + randomUUID() })
      const start = cfg.bodyA.indexOf(cfg.quote)
      await team('queueFeedback', { connectionId: connection.connectionId, commandId: feedbackCommand, feedbackId: randomUUID(), materialId: a.materialId, version: 1, body: cfg.developerFeedback, quote: cfg.quote, anchor: { start, end: start + cfg.quote.length } })
      const rows = (await team('outbox', connection.connectionId, { limit: 100 })).items
      assert.ok([privateDraft.commandId, nextCommand, feedbackCommand].every((id) => rows.some((row) => row.commandId === id && row.state === 'queued')))
      assert.equal((await team('connections')).length, 1)
      await capture(main, 'desktop-offline-queue.png')
    })
    ids = { connectionId: connection.connectionId, materialId: a.materialId, initialCommand: a.commandId, privateMaterialId: privateDraft.materialId, privateCommand: privateDraft.commandId, nextCommand, feedbackCommand }
    writeFileSync(join(cfg.fixture, 'public-identities.json'), JSON.stringify(ids))
  } else if (phase === 'two') {
    ids = JSON.parse(readFileSync(join(cfg.fixture, 'public-identities.json'), 'utf8'))
    await check('actual Electron restart retains original encrypted identity, queued intents and cached A', async () => {
      const connections = await team('connections'); assert.equal(connections.length, 1); assert.equal(connections[0].connectionId, ids.connectionId)
      const rows = (await team('outbox', ids.connectionId, { limit: 100 })).items
      assert.ok([ids.privateCommand, ids.nextCommand, ids.feedbackCommand].every((id) => rows.some((row) => row.commandId === id && row.state === 'queued')))
      const cached = await team('readDocument', { connectionId: ids.connectionId, materialId: ids.materialId, version: 1, allowOffline: true })
      assert.equal(cached.document.text, cfg.bodyA); assert.equal(cached.authorization, 'last-observed'); assert.equal(cached.freshness, 'cached-offline')
      await click(main, '读取本机目录线索', false)
      await wait(() => run(main, `Boolean(document.querySelector('[data-material-id=${JSON.stringify(ids.materialId)}]'))`), 'persisted metadata cache clue')
      await run(main, `document.querySelector('[data-material-id=${JSON.stringify(ids.materialId)}]').click();true`)
      await wait(() => run(main, 'document.querySelector(".team-document-prose")?.textContent.includes("基线 A")'), 'actual restarted cached A reader')
      await capture(main, 'desktop-restarted-offline-A.png')
    })
    const alice = await web('alice'); await selectWeb(alice, ids.materialId)
    await check('reconnect commits original queued UUIDs without duplicate versions, retains A, and exposes exact recorded feedback', async () => {
      await invoke('setSettings', { proxy: { enabled: false, url: '' } })
      await wait(async () => { const rows = (await team('outbox', ids.connectionId, { limit: 100 })).items; return [ids.privateCommand, ids.nextCommand, ids.feedbackCommand].every((id) => rows.some((row) => row.commandId === id && row.state === 'committed')) }, 'actual original reconnect receipts', 60000)
      const versions = await team('listVersions', { connectionId: ids.connectionId, materialId: ids.materialId, limit: 100 })
      assert.deepEqual(versions.items.map((item) => item.version).sort(), [1, 2])
      const feedback = await team('listFeedback', { connectionId: ids.connectionId, materialId: ids.materialId, version: 1, limit: 100 })
      assert.ok(feedback.items.some((item) => item.body === cfg.productFeedback && item.authorId === cfg.aliceUserId && item.applied === false))
      assert.ok(feedback.items.some((item) => item.body === cfg.developerFeedback && item.authorId === cfg.bobUserId && item.applied === false))
      for(const body of [cfg.productFeedback,cfg.developerFeedback]){const entry=feedback.items.find(item=>item.body===body);assert.equal(entry.version,1);assert.equal(entry.materialId,ids.materialId);assert.equal(entry.quote,cfg.quote);assert.deepEqual(entry.anchor,{start:cfg.bodyA.indexOf(cfg.quote),end:cfg.bodyA.indexOf(cfg.quote)+cfg.quote.length})}
      assert.ok(await run(main, 'document.querySelector(".team-document-prose")?.textContent.includes("基线 A")'))
      assert.ok(await run(alice, 'document.querySelector(".markdown")?.textContent.includes("基线 A")'))
      const denied = await run(alice, `fetch('/api/materials/${ids.privateMaterialId}/versions/1').then(response=>response.status)`)
      assert.equal(denied, 403, 'Personal default stays inaccessible to product administrator')
      await capture(main, 'desktop-reconnected-keeps-A.png'); await capture(alice, 'product-web-keeps-A.png')
    })
  } else if (phase === 'reader') {
    ids = JSON.parse(readFileSync(join(cfg.fixture, 'public-identities.json'), 'utf8'))
    await check('actual native fixed reader publishes original BOM A while disk B is current, and product Web reads exact A', async () => {
      const relativePath = '.trellis/tasks/owned-task/prd.md'
      const textA = '\uFEFF# 固定阅读 A\n\n原始冻结正文，包含 BOM 与 Unicode 🙂。\n\n' + randomUUID() + '\n'
      const textB = '# 磁盘已更新 B\n\n不能用当前文件替换用户正在发布的 A。\n'
      writeFileSync(join(sourceRoot, relativePath), textA)
      const captured = await invoke('documentCaptureVersion', relativePath); assert.equal(captured.ok, true)
      writeFileSync(join(sourceRoot, relativePath), textB)
      const opened = await invoke('documentOpenWindow', { token: captured.version.token, origin: { taskDir: 'owned-task' } }); assert.equal(opened.ok, true)
      const reader = await wait(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getURL().includes(encodeURIComponent(opened.viewId))), 'actual independent fixed reader')
      reader.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
      await wait(() => run(reader, 'Array.from(document.querySelectorAll("h1")).some(element=>element.textContent==="固定阅读 A")'), 'actual original A heading')
      const sourceState = await run(reader, 'window.trellis.documentWindowSourceState()'); assert.deepEqual(sourceState, { ok: true, sourceActive: true })
      await click(reader, '发布此版本')
      await wait(() => run(reader, 'Boolean(document.querySelector("[aria-label=发布文档标题]"))'), 'actual selected-source publication form')
      assert.equal(await run(reader, 'Boolean(document.querySelector("[aria-label=发布文档正文]"))'), false, 'Selected source cannot be replaced by a renderer-authored body')
      const title = '固定阅读发布 ' + randomUUID().slice(0, 8)
      await fill(reader, '[aria-label="发布文档标题"]', title)
      await fill(reader, '[aria-label="发布可见范围"]', 'project')
      await click(reader, '保存并发布')
      await wait(() => run(reader, 'document.body.textContent.includes("已保存原操作到本机队列")'), 'actual fixed selected source queued')
      await click(reader, '完成')
      const published = await wait(async () => (await team('outbox', ids.connectionId, { limit: 100 })).items.find((item) => item.title === title && item.state === 'committed'), 'actual immutable reader source receipt')
      const document = await team('readDocument', { connectionId: ids.connectionId, materialId: published.materialId, version: 1 })
      assert.equal(document.document.material.bodyDigest,captured.version.digest);assert.equal(document.document.material.byteLength,Buffer.byteLength(textA,'utf8'));
      assert.equal(document.document.text, textA, 'Published bytes retain the original BOM, Unicode and fixed A')
      assert.equal(readFileSync(join(sourceRoot, relativePath), 'utf8'), textB)
      const alice = await web('alice'); await selectWeb(alice, published.materialId, title)
      await click(alice, '选择原文批注')
      assert.equal(await run(alice, 'document.querySelector(".source-reader").value'), textA)
      assert.ok(await run(reader, 'Array.from(document.querySelectorAll("h1")).some(element=>element.textContent==="固定阅读 A")'))
      await capture(reader, 'native-fixed-A-published.png'); await capture(alice, 'product-web-fixed-original-A.png')
      ids = { ...ids, readerMaterialId: published.materialId, readerCommand: published.commandId, readerDigest: captured.version.digest }
    })
  } else throw Error('Unknown connected fixture phase')
  const sealed=await credentialProof(ids.connectionId),credentialFile=join(cfg.fixture,'credential-proof.json')
  if(phase==='one')writeFileSync(credentialFile,JSON.stringify(sealed))
  else assert.deepEqual(sealed,JSON.parse(readFileSync(credentialFile,'utf8')),'Restart must preserve the original encrypted connection, not create a replacement')
  assert.ok(protection.decryptCalls>0,'Actual original native encrypted credential must be decrypted')
  assert.ok(ownedWorkers.some(worker=>worker.file==='team-desktop-worker.js'),'Production team store must start its actual compiled Worker')
  assert.equal((await invoke('acpSessions')).sessions.length, 0, 'Team collaboration never starts a native engine')
  assert.equal(errors.length, 0, 'Unexpected renderer console errors')
  const report = { status: 'passed-observed-connected-subset', phase, results: checks, publicIdentities: ids, sourceRoot, versions: process.versions, rendererErrors: errors, credentialProtection:{...protection,available:safeStorage.isEncryptionAvailable(),originalCipherPreserved:phase!=='one'},actualTeamWorkers:ownedWorkers.filter(worker=>worker.file==='team-desktop-worker.js').length, modelCalls: 0, osBoundary: 'Owned enrollment browser launch and unrelated OS registrations intercepted; authenticated test cookies injected after real OIDC HTTP login; safeStorage/Worker observers pass through actual native implementation; Web UI/HTTP/Windows encryption/SQLite are real' }
  writeFileSync(join(cfg.evidence, `phase-${phase}.json`), JSON.stringify(report, null, 2))
  app.once('will-quit', () => {const teamWorkers=ownedWorkers.filter(worker=>worker.file==='team-desktop-worker.js');const teamWorkersExited=teamWorkers.length>0&&teamWorkers.every(worker=>worker.exited);writeFileSync(join(cfg.evidence,`phase-${phase}-exit.json`),JSON.stringify({phase,willQuit:true,teamWorkersExited,teamWorkers},null,2));clearTimeout(watchdog);if(!teamWorkersExited){console.error('Actual team writer not confirmed exited at will-quit');process.exitCode=1;return}console.log(`TEAM_CONNECTED_${phase.toUpperCase()}_PASSED`)}); app.quit()
}
work().catch(async (error) => {
  if (main && !main.isDestroyed()) { await capture(main, `phase-${phase}-failure.png`).catch(() => {}); writeFileSync(join(cfg.evidence, `phase-${phase}-failure-screen.txt`), await run(main, 'document.body.innerText').catch(() => 'unavailable')) }
  writeFileSync(join(cfg.evidence, `phase-${phase}-failure-${Date.now()}.json`), JSON.stringify({ message: error.message, stack: error.stack, checks, errors }, null, 2))
  console.error(error.stack); app.quit()
})
