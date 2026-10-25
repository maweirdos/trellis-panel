const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const directory = process.env.CREATION_PREVIEW_FIXTURE
if (!directory) throw new Error('CREATION_PREVIEW_FIXTURE must name the isolated generated fixture')
mkdirSync(join(directory, 'profile'), { recursive: true })
app.setPath('userData', join(directory, 'profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-prefers-reduced-motion')

const checks = [], errors = [], requests = [], securityMessages = []
const debugSessions = new Map()
let window, phase = 'startup', popupAttempts = 0, fileChooserAttempts = 0
const settle = (ms = 70) => new Promise((done) => setTimeout(done, ms))
const run = (code) => window.webContents.executeJavaScript(code, true)
const childFrame = () => window.webContents.mainFrame.frames.find((frame) => frame.url.startsWith('about:srcdoc'))
const inside = (code) => {
  const frame = childFrame()
  assert.ok(frame, 'the current opaque srcdoc frame exists')
  return frame.executeJavaScript(code, true)
}

async function wait(code, label, timeout = 6000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await run(code)) return
    await settle(25)
  }
  throw new Error(`Renderer timeout: ${label}`)
}

async function waitValue(read, accepts, label, timeout = 6000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accepts(value)) return value
    await settle(25)
  }
  throw new Error(`Renderer timeout: ${label}; last value: ${JSON.stringify(value)}`)
}

const ready = () => wait(`document.querySelector('iframe')?.getAttribute('aria-busy') === 'false'`, 'current document ready')
async function configure(patch) {
  const changedBody = await run(`(() => {
    const patch = ${JSON.stringify(patch)}, changed = patch.body !== undefined && patch.body !== window.previewFixture.config.body
    window.previewPreviousFrame = document.querySelector('iframe')
    window.previewFixture.set(value => ({ ...value, ...patch }))
    return changed
  })()`)
  await wait(`Object.entries(${JSON.stringify(patch)}).every(([key, value]) => JSON.stringify(window.previewFixture.config[key]) === JSON.stringify(value))`, 'fixture configuration commit')
  if (changedBody) await wait(`document.querySelector('iframe') && document.querySelector('iframe') !== window.previewPreviousFrame`, 'new iframe committed')
  await settle()
}
async function fresh(body) {
  await run('window.previewEvents = []')
  await configure({ body, selectedTarget: null, markers: [], mode: 'browse' })
  await ready()
  // Hidden native fixtures need a layout before measuring an out-of-process child.
  await run(`document.querySelector('iframe').getBoundingClientRect().height`)
  await settle()
}
async function check(name, action) {
  phase = name
  await action()
  checks.push(name)
  console.log('PASS ' + name)
}
const events = () => run('window.previewEvents')
const contrast = (foreground, background) => {
  const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
    value /= 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

async function childDebugSession() {
  const { targetInfos } = await window.webContents.debugger.sendCommand('Target.getTargets')
  const target = targetInfos.find((item) => item.type === 'iframe' && item.url.startsWith('about:srcdoc'))
  if (!target) return undefined
  let sessionId = debugSessions.get(target.targetId)
  if (!sessionId) {
    const attached = await window.webContents.debugger.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    sessionId = attached.sessionId
    debugSessions.set(target.targetId, sessionId)
    await window.webContents.debugger.sendCommand('DOM.enable', {}, sessionId)
  }
  return sessionId
}

async function markerRect(activate = false) {
  const sessionId = await childDebugSession()
  const { nodes } = await window.webContents.debugger.sendCommand('DOM.getFlattenedDocument', { depth: -1, pierce: true }, sessionId)
  const marker = nodes.find((node) => node.nodeName === 'BUTTON' && node.attributes?.some((value, index) =>
    index % 2 === 0 && value === 'class' && node.attributes[index + 1] === 'marker'))
  assert.ok(marker, 'a real marker button exists in the closed overlay shadow')
  const { object } = await window.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId: marker.nodeId }, sessionId)
  const { result, exceptionDetails } = await window.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function(activate) {
      if (activate) { this.focus(); this.click() }
      const rect = this.getBoundingClientRect(), style = getComputedStyle(this)
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, hidden: this.hidden,
        color: style.color, background: style.backgroundColor, fontSize: style.fontSize, tabIndex: this.tabIndex }
    }`,
    arguments: [{ value: activate }], returnByValue: true
  }, sessionId)
  assert.equal(exceptionDetails, undefined)
  return result.value
}

async function fail(error) {
  console.error(`FAIL ${phase}\n${error.stack ?? error}`)
  writeFileSync(join(directory, 'electron-failure.json'), JSON.stringify({ phase, error: error.stack ?? String(error), checks, errors, requests, securityMessages }, null, 2))
  if (window && !window.isDestroyed()) window.destroy()
  app.exit(1)
}
const watchdog = setTimeout(() => { void fail(new Error('Isolated Electron exceeded 45 seconds')) }, 45_000)

app.whenReady().then(async () => {
  // Record before cancelling: a CSP regression fails the test without making a real request.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (details, done) => {
    requests.push(details.url)
    done({ cancel: true })
  })
  window = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  window.webContents.setWindowOpenHandler(() => { popupAttempts++; return { action: 'deny' } })
  window.webContents.on('console-message', ({ level, message }) => {
    if (level !== 'error') return
    if (message.includes('Content Security Policy') || /^(Blocked form submission|Blocked opening|Unsafe attempt to initiate navigation)/.test(message)) securityMessages.push(message)
    else errors.push(message)
  })
  window.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)))
  await window.loadFile(join(directory, 'index.html'))
  // The debugger belongs only to this hidden fixture, never an existing app or browser.
  window.webContents.debugger.attach('1.3')
  window.webContents.debugger.on('message', (_event, method) => {
    if (method === 'Page.fileChooserOpened') fileChooserAttempts++
  })
  await window.webContents.debugger.sendCommand('DOM.enable')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await ready()

  await check('StrictMode mounts a credentialless opaque iframe with scripts as its only sandbox grant', async () => {
    assert.equal(await run(`document.querySelector('iframe').getAttribute('sandbox')`), 'allow-scripts')
    assert.equal(await run(`document.querySelector('iframe').contentDocument`), null)
    assert.equal(await run(`document.querySelector('iframe').credentialless`), true)
    const actual = await inside(`(() => {
      let parentBlocked = false, storageBlocked = false
      try { void parent.document.body } catch { parentBlocked = true }
      try { localStorage.setItem('fixture', 'value') } catch { storageBlocked = true }
      return { origin: self.origin, parentBlocked, storageBlocked, node: typeof require, preload: typeof window.api }
    })()`)
    assert.deepEqual(actual, { origin: 'null', parentBlocked: true, storageBlocked: true, node: 'undefined', preload: 'undefined' })
  })

  await check('browse executes the authored button action; annotation captures without executing it', async () => {
    await inside(`document.querySelector('#save').click()`)
    assert.equal(await inside(`document.querySelector('#save').textContent`), 'Saved')
    await configure({ mode: 'annotate' })
    assert.doesNotMatch(await run(`document.querySelector('.prototype-preview-status').textContent`), /拖拽|拖动|框选|drag/i)
    await inside(`document.querySelector('#save').setAttribute('onclick', "this.textContent='Wrong'"); document.querySelector('#save').click()`)
    await wait(`window.previewEvents.some(event => event.type === 'selection')`, 'annotation selection')
    assert.equal(await inside(`document.querySelector('#save').textContent`), 'Saved')
    const target = (await events()).filter((event) => event.type === 'selection').at(-1).target
    assert.equal(target.kind, 'web')
    assert.equal(target.stableId, 'save')
    assert.equal(target.tag, 'button')
    assert.equal(target.name, 'Saved')
    assert.ok(target.box.x >= 0 && target.box.x + target.box.width <= 1.000001)
  })

  await check('keyboard annotation prevents activation and Escape invokes the exit callback', async () => {
    await run('window.previewEvents = []')
    await inside(`(() => {
      const button = document.querySelector('#save'); button.focus()
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })()`)
    await wait(`window.previewEvents.some(event => event.type === 'exit')`, 'Escape callback')
    assert.ok((await events()).some((event) => event.type === 'selection'))
    assert.equal(await inside(`document.querySelector('#save').textContent`), 'Saved')
  })

  await check('numbered DOM markers follow scroll, focus comments and retain light/dark contrast', async () => {
    await fresh('<style>body{margin:32px;font:16px sans-serif}main{height:1800px;padding-top:850px}</style><main><button id="anchor">Review this</button></main>')
    const target = { kind: 'web', stableId: 'anchor', selector: '#anchor', role: 'button', name: 'Review this' }
    await configure({ mode: 'annotate', selectedTarget: target, markers: [{ id: 'comment-1', label: '1', target }] })
    await wait(`window.previewEvents.some(event => event.type === 'status' && event.status === 'located')`, 'located marker')
    assert.equal(await inside(`document.querySelector('[data-preview-overlay]').shadowRoot`), null)
    const before = await waitValue(() => markerRect(), (rect) => !rect.hidden && rect.height > 0, 'visible marker')
    assert.equal(before.hidden, false)
    assert.ok(before.width >= 24)
    assert.equal(before.tabIndex, 0)
    assert.equal(before.fontSize, '14px')
    assert.ok(contrast(before.color, before.background) >= 4.5)
    await inside('scrollBy(0, 40)')
    const after = await waitValue(() => markerRect(), (rect) => Math.abs(before.y - rect.y - 40) < 2, 'marker follows scroll')
    assert.ok(Math.abs(before.y - after.y - 40) < 2, JSON.stringify({ before, after }))
    await markerRect(true)
    await wait(`window.previewEvents.some(event => event.type === 'marker' && event.id === 'comment-1')`, 'marker callback')
    await configure({ theme: 'dark', font: 'large' })
    const dark = await waitValue(() => markerRect(), (rect) => rect.fontSize === '15px', 'marker theme/font update')
    assert.equal(dark.fontSize, '15px')
    assert.notEqual(dark.background, before.background)
    assert.ok(contrast(dark.color, dark.background) >= 4.5)
  })

  await check('capture excludes sensitive inputs and native setters restore a conditional form target', async () => {
    await fresh(`<style>body{padding:16px}label{display:block;margin:12px}</style>
      <label><input id="compact" name="compact" type="checkbox" onchange="document.querySelector('#details').hidden=!this.checked">Show details</label>
      <label>Layout<select id="layout" name="layout" onchange="window.changed=(window.changed||0)+1"><option value="basic">Basic</option><option value="detail">Detail</option></select></label>
      <label>Title<input id="title" name="title" data-preview-state="true" value="Hello"></label>
      <input id="password" type="password" value="DO_NOT_CAPTURE"><input name="token" value="DO_NOT_CAPTURE">
      <input id="free-text" value="DO_NOT_CAPTURE"><textarea name="notes">DO_NOT_CAPTURE</textarea>
      <div id="details" hidden><button id="conditional">Details action</button><p id="copy">Select this precise sentence for feedback.</p></div>`)
    await inside(`(() => {
      document.querySelector('#compact').click()
      const select = document.querySelector('#layout'); select.value = 'detail'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await configure({ mode: 'annotate' })
    await inside(`document.querySelector('#conditional').click()`)
    await wait(`window.previewEvents.some(event => event.type === 'selection')`, 'form target capture')
    const target = (await events()).find((event) => event.type === 'selection').target
    assert.equal(target.context.fields.length, 3)
    assert.equal(JSON.stringify(target).includes('DO_NOT_CAPTURE'), false)
    assert.equal(target.context.fields.find((field) => field.name === 'compact').value, 'true')
    await configure({ mode: 'browse' })
    await inside(`document.querySelector('#compact').click(); document.querySelector('#layout').value = 'basic'; document.querySelector('#title').value = 'Changed'`)
    assert.equal(await inside(`document.querySelector('#details').hidden`), true)
    await run('window.previewEvents = []')
    await configure({ selectedTarget: target })
    await wait(`window.previewEvents.some(event => event.type === 'status' && event.status === 'located')`, 'conditional target restore')
    assert.equal(await inside(`document.querySelector('#compact').checked`), true)
    assert.equal(await inside(`document.querySelector('#details').hidden`), false)
    assert.equal(await inside(`document.querySelector('#layout').value`), 'detail')
    assert.equal(await inside(`document.querySelector('#title').value`), 'Hello')
    assert.equal(await inside('window.changed'), 2, 'restore dispatches the real change handler')
    await configure({ mode: 'annotate' })
    await run('window.previewEvents = []')
    await inside(`(() => {
      const paragraph = document.querySelector('#copy'), range = document.createRange()
      range.selectNodeContents(paragraph)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
      paragraph.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })()`)
    await wait(`window.previewEvents.some(event => event.type === 'selection' && event.target.selectedText)`, 'text selection capture')
    assert.equal((await events()).filter((event) => event.type === 'selection').at(-1).target.selectedText, 'Select this precise sentence for feedback.')
  })

  await check('missing/ambiguous anchors are explicit and an older lookup cannot replace a newer target', async () => {
    await fresh('<button id="unique">Unique</button><button>Same</button><button>Same</button>')
    await configure({ selectedTarget: { kind: 'web', selector: 'button', role: 'button', name: 'Same' } })
    await wait(`window.previewEvents.some(event => event.type === 'status' && event.status === 'ambiguous')`, 'ambiguous anchor')
    await run('window.previewEvents = []')
    await configure({ selectedTarget: { kind: 'web', stableId: 'gone', name: 'Gone', box: { x: 0, y: 0, width: .5, height: .5 } } })
    await wait(`window.previewEvents.some(event => event.type === 'status' && event.status === 'missing')`, 'missing anchor without pixel fallback')
    await run('window.previewEvents = []')
    await configure({ selectedTarget: { kind: 'web', stableId: 'another-missing', name: 'Missing' } })
    await configure({ selectedTarget: { kind: 'web', stableId: 'unique', name: 'Unique' } })
    await wait(`window.previewEvents.some(event => event.type === 'status' && event.status === 'located')`, 'newest anchor')
    await settle(600)
    assert.equal((await events()).filter((event) => event.type === 'status').at(-1).status, 'located')
  })

  await check('same-document hash routes restore authored conditional content', async () => {
    await fresh(`<a id="route" href="#panel">Panel</a><button id="panel" hidden>Panel action</button>
      <script>addEventListener('hashchange',()=>{document.querySelector('#panel').hidden=location.hash!=='#panel'})</script>`)
    await inside(`document.querySelector('#route').click()`)
    await settle()
    assert.equal(await inside('location.hash'), '#panel')
    assert.equal(await inside(`document.querySelector('#panel').hidden`), false)
    await configure({ mode: 'annotate' })
    await inside(`document.querySelector('#panel').click()`)
    await wait(`window.previewEvents.some(event => event.type === 'selection')`, 'route target')
    const target = (await events()).filter((event) => event.type === 'selection').at(-1).target
    assert.equal(target.context.hash, '#panel')
    await inside(`location.hash = ''`)
    await settle()
    await configure({ selectedTarget: target })
    await wait(`window.previewEvents.some(event => event.type === 'status' && event.status === 'located')`, 'hash restore')
    assert.equal(await inside(`document.querySelector('#panel').hidden`), false)
  })

  await check('plain text remains escaped and follows host light/dark typography', async () => {
    await fresh('Readable < 3 & selected text')
    for (const theme of ['light', 'dark']) {
      await configure({ theme, font: 'large' })
      const hostFont = await run(`getComputedStyle(document.querySelector('#fixture')).fontSize`)
      const actual = await inside(`(() => {
        const root = document.documentElement, style = getComputedStyle(root)
        return { ink: root.style.color, surface: root.style.backgroundColor, font: style.fontSize,
          text: document.querySelector('pre').textContent, scheme: style.colorScheme }
      })()`)
      assert.equal(actual.font, hostFont)
      assert.equal(actual.scheme, theme)
      assert.notEqual(actual.ink, actual.surface)
      assert.equal(actual.text, 'Readable < 3 & selected text')
    }
  })

  await check('file pickers, popups and top navigation receive no capability', async () => {
    await fresh('<input id="file" type="file"><button id="stay">Stay</button>')
    const sessionId = await childDebugSession()
    // A future picker regression must fail without ever opening a native OS dialog.
    await window.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId)
    await inside(`document.querySelector('#file').showPicker(); window.open('https://example.invalid/popup'); try { top.location.href = 'https://example.invalid/top' } catch {}`)
    await settle()
    assert.equal(fileChooserAttempts, 0)
    assert.equal(popupAttempts, 0)
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    assert.ok(window.webContents.getURL().endsWith('/index.html'))
    assert.equal(await inside(`document.querySelector('#stay').textContent`), 'Stay')
  })

  await check('external resources, eval, forms, nested frames and outbound clicks make no requests', async () => {
    await fresh(`<script src="https://example.invalid/external.js"></script><link rel="stylesheet" href="https://example.invalid/style.css">
      <img src="https://example.invalid/image.png"><iframe src="https://example.invalid/frame"></iframe>
      <a id="external" href="https://example.invalid/page">External</a><form action="https://example.invalid/submit"><button id="submit">Submit</button></form>
      <script>fetch('https://example.invalid/api').catch(()=>{});try{eval('window.evalRan=true')}catch{};window.inlineRan=true</script>`)
    assert.equal(await inside('window.inlineRan'), true)
    assert.equal(await inside('typeof window.evalRan'), 'undefined')
    assert.ok((await events()).some((event) => event.type === 'interaction' && event.event.kind === 'resource-blocked'))
    await inside(`document.querySelector('#external').click(); document.querySelector('#submit').click()`)
    await settle()
    assert.ok((await events()).some((event) => event.type === 'interaction' && event.event.kind === 'navigation-blocked'))
    assert.deepEqual(requests, [])
    assert.ok(await run(`document.querySelector('.prototype-preview-status').textContent.includes('页内导航')`))
  })

  await check('replacement documents reject stale frames/nonces, wrong origins and command messages', async () => {
    await fresh('<button id="previous">Previous</button>')
    await run(`window.oldPeer = document.querySelector('iframe').contentWindow; window.oldNonce = document.querySelector('iframe').srcdoc.match(/"nonce":"([a-f0-9]{48})"/)[1]`)
    await fresh('<button id="candidate">Candidate version</button>')
    await configure({ mode: 'annotate' })
    await run(`(() => {
      const frame = document.querySelector('iframe'), nonce = frame.srcdoc.match(/"nonce":"([a-f0-9]{48})"/)[1]
      const base = { channel: 'creation-preview/v1', type: 'selection', target: { kind: 'web', stableId: 'fake' } }
      for (const [source, origin, documentNonce] of [
        [window.oldPeer, 'null', window.oldNonce], [frame.contentWindow, 'null', window.oldNonce],
        [frame.contentWindow, 'https://wrong.invalid', nonce], [window, 'null', nonce]
      ]) window.dispatchEvent(new MessageEvent('message', { source, origin, data: { ...base, nonce: documentNonce } }))
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'null',
        data: { channel: 'creation-preview/v1', nonce, type: 'command', command: 'run' } }))
    })()`)
    await settle()
    assert.equal((await events()).filter((event) => event.type === 'selection').length, 0)
    await inside(`document.querySelector('#candidate').click()`)
    await wait(`window.previewEvents.some(event => event.type === 'selection' && event.target.stableId === 'candidate')`, 'live candidate selection')
  })

  await check('forced navigation fails closed without a request and supports a fresh reload', async () => {
    await fresh('<p id="stay">Keep preview</p>')
    // Changing location can destroy this diagnostic JS context even when CSP blocks the load.
    try { await inside(`location.href = 'https://example.invalid/script-navigation'`) } catch (error) {
      assert.match(error.message, /destroyed|disposed|Execution context|frame/i)
    }
    await wait(`!document.querySelector('iframe') && document.querySelector('.prototype-preview-status')?.textContent.includes('重新加载')`, 'closed navigation')
    assert.deepEqual(requests, [])
    await run(`window.previewEvents = []; [...document.querySelectorAll('button')].find(button => button.textContent === '重新加载').click()`)
    await ready()
    assert.equal(await inside(`document.querySelector('#stay').textContent`), 'Keep preview')
  })

  assert.deepEqual(errors, [], 'no unexpected renderer errors')
  assert.deepEqual(requests, [], 'no HTTP request reached even the protective interceptor')
  writeFileSync(join(directory, 'electron-report.json'), JSON.stringify({ checks, errors, requests, securityMessages }, null, 2))
  console.log(`CREATION_PREVIEW_ELECTRON_PASSED ${checks.length}`)
  clearTimeout(watchdog)
  window.destroy()
  app.quit()
}).catch((error) => { clearTimeout(watchdog); void fail(error) })
