const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', join(cfg.directory, 'browser-user'))
app.setPath('sessionData', join(cfg.directory, 'browser-sessions'))
app.setPath('logs', join(cfg.directory, 'browser-logs'))
app.on('window-all-closed', () => {})
const windows = [], errors = []
const pause = () => new Promise((done) => setTimeout(done, 45))
const run = (window, code) => window.webContents.executeJavaScript(code, true)
async function until(window, code, label) {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) { if (await run(window, code)) return; await pause() }
  throw Error('Timed out: ' + label + '\n' + await run(window, 'document.body.innerText.slice(-2200)'))
}
async function click(window, label, selector = 'button') {
  assert.equal(await run(window, `(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.getClientRects().length && (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true })()`), true, 'Button ' + label)
  await pause()
}
async function fill(window, selector, value) {
  await run(window, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw Error('Missing input'); const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })()`)
  await pause()
}
async function fieldId(window, label) {
  const id = await run(window, `(() => { const dialog = document.querySelector('[role=dialog]'); return [...(dialog?.querySelectorAll('label') || [])].find(item => item.textContent.trim() === ${JSON.stringify(label)})?.htmlFor })()`)
  assert.ok(id, 'Labeled field ' + label)
  return id
}
async function fillLabel(window, label, value) {
  await fill(window, '[id=' + JSON.stringify(await fieldId(window, label)) + ']', value)
}
async function discussion(window) {
  assert.equal(await run(window, `(() => { const button = [...document.querySelectorAll('[role=dialog] button')].find(item => item.textContent.trim().startsWith('讨论')); if (!button || button.disabled) return false; button.click(); return true })()`), true, 'Discussion tab')
  await until(window, 'Boolean(document.querySelector("[aria-label=任务讨论] textarea"))', 'discussion editor')
}
async function screenshot(window, name) {
  const [width, height] = window.getContentSize()
  window.setContentSize(width + 1, height)
  await run(window, 'new Promise(done => requestAnimationFrame(done))')
  window.setContentSize(width, height)
  window.webContents.invalidate()
  await new Promise((done) => setTimeout(done, 400))
  await run(window, 'new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  writeFileSync(join(cfg.evidence, name + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
}
async function navigate(window, route, label) {
  const clicked = await run(window, `(() => { const nav = document.querySelector('[aria-label="协作模块"]'); if (!nav) return false; const button = nav.querySelector('[data-hifox-route="${route}"]') || [...nav.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(label)}); if (!button || button.disabled || !button.getClientRects().length) return false; button.click(); return true })()`)
  assert.equal(clicked, true, 'Navigation route ' + route)
  await until(window, `document.querySelector('[data-hifox-module]')?.dataset.hifoxModule === ${JSON.stringify(route)}`, 'module ' + route)
}
async function identity(window) {
  return run(window, `fetch('/api/session').then((r) => r.json()).then((r) => r.value.person.userId)`)
}
async function login(window, username, userId) {
  await until(window, 'Boolean(document.querySelector("[aria-label=登录独立账号]"))', 'local login form')
  assert.equal(await run(window, '[...document.querySelectorAll("button")].some((b) => b.textContent.includes("GitLab"))'), false)
  await fill(window, '[aria-label="账号用户名"]', username)
  await fill(window, '[aria-label="账号密码"]', cfg.password)
  await click(window, '登录')
  await until(window, 'Boolean(document.querySelector("[aria-label=当前项目]"))', 'authenticated Web')
  assert.equal(await identity(window), userId)
  await until(window, `Boolean(document.querySelector('[aria-label="当前项目"] option[value="${cfg.projectId}"]'))`, 'authorized project')
  await fill(window, '[aria-label="当前项目"]', cfg.projectId)
  await click(window, '团队', '[aria-label="团队导航"] button')
  await until(window, 'Boolean(document.querySelector(".collab-workspace"))', 'actual HiFox workspace')
  assert.equal(await run(window, 'typeof window.trellis'), 'undefined')
}
async function make(name, username, userId) {
  const partition = session.fromPartition('hifox-connected-' + name)
  const window = new BrowserWindow({ width: 1440, height: 1040, show: false, webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  windows.push(window)
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  await window.loadURL(cfg.origin)
  await login(window, username, userId)
  return window
}
async function openTask(window, title) {
  assert.equal(await run(window, `(() => { const b = [...document.querySelectorAll('.collab-main button, .collab-main [role=button]')].find((item) => item.getClientRects().length && item.textContent.includes(${JSON.stringify(title)})); if (!b) return false; b.click(); return true })()`), true, 'Task row ' + title)
  await until(window, `Boolean([...document.querySelectorAll('[role=dialog]')].find((d) => d.getAttribute('aria-label')?.includes(${JSON.stringify(title)})))`, 'real shared task detail')
}
app.whenReady().then(async () => {
  try {
    const alice = await make('alice', 'connected-alice', cfg.aliceId)
    const bob = await make('bob', 'connected-bob', cfg.bobId)
    assert.notEqual(alice.webContents.session, bob.webContents.session)
    const aliceCookie = await alice.webContents.session.cookies.get({ url: cfg.origin, name: 'tp_team_session' })
    const bobCookie = await bob.webContents.session.cookies.get({ url: cfg.origin, name: 'tp_team_session' })
    assert.equal(aliceCookie.length, 1); assert.equal(bobCookie.length, 1)
    assert.notEqual(aliceCookie[0].value, bobCookie[0].value)
    assert.ok(aliceCookie[0].httpOnly && bobCookie[0].httpOnly)
    for (const [route, label, content] of [['agents', 'Agent', '联通审阅 Agent'], ['crews', '小队', '联通交付小队'], ['iterations', '版本', '联通验收版本']]) {
      await navigate(bob, route, label)
      await until(bob, `document.querySelector('.collab-main')?.innerText.includes(${JSON.stringify(content)})`, 'shared ' + label)
    }
    for (const window of [alice, bob]) {
      await navigate(window, 'tasks', '全部任务')
      await until(window, 'document.querySelector(".collab-main")?.innerText.includes("跨账号共享任务")', 'shared HTTP task')
    }
    await click(alice, '新建任务', '.collab-main button')
    await until(alice, 'Boolean(document.querySelector("[role=dialog][aria-label^=新建]"))', 'production create task dialog')
    await fillLabel(alice, '标题', '浏览器创建的共享任务')
    const versionField = await fieldId(alice, '版本')
    const versionId = await run(alice, `(() => { const select = document.getElementById(${JSON.stringify(versionField)}); return [...select.options].find(option => option.textContent.includes('联通验收版本'))?.value })()`)
    assert.ok(versionId, 'Actual version option for direct planning')
    await fillLabel(alice, '版本', versionId)
    await click(alice, '创建任务', '[role=dialog] button')
    await until(alice, '!document.querySelector("[role=dialog][aria-label^=新建]")', 'create committed')
    await until(bob, 'document.querySelector(".collab-main")?.innerText.includes("浏览器创建的共享任务")', 'other client live update')
    for (const [name, window, theme] of [['alice', alice, 'light'], ['bob', bob, 'dark']]) {
      if (await run(window, `document.querySelector('.hifox-host').dataset.myTheme !== ${JSON.stringify(theme)}`)) await click(window, '切换主题')
      await until(window, `document.querySelector('.hifox-host')?.dataset.myTheme === ${JSON.stringify(theme)}`, name + ' theme')
      if (await run(window, 'Boolean(document.querySelector("[role=dialog] [aria-label=关闭详情]"))')) await click(window, '关闭详情')
      await until(window, '!document.querySelector("[role=dialog]")', name + ' main without modal')
      assert.equal(await run(window, 'document.documentElement.scrollWidth > innerWidth + 1'), false)
      const readButtonStyle = `(() => {
        const host = document.querySelector('.hifox-host')
        const button = host.querySelector('.collab-main .my-button-primary')
        if (!button) throw Error('Missing canonical primary button')
        const probe = document.createElement('span')
        probe.style.backgroundColor = 'var(--my-bg-accent-primary)'
        probe.style.color = 'var(--my-txt-on-accent)'
        host.append(probe)
        const actual = getComputedStyle(button), expected = getComputedStyle(probe)
        const result = { background: actual.backgroundColor, expectedBackground: expected.backgroundColor, color: actual.color, expectedColor: expected.color }
        probe.remove()
        return result
      })()`
      await until(window, `(() => { const style = ${readButtonStyle}; return style.background === style.expectedBackground && style.color === style.expectedColor })()`, theme + ' canonical button after theme transition')
      const buttonStyle = await run(window, readButtonStyle)
      assert.equal(buttonStyle.background, buttonStyle.expectedBackground, theme + ' primary button background')
      assert.equal(buttonStyle.color, buttonStyle.expectedColor, theme + ' primary button foreground')
      await screenshot(window, name + '-main')
      await openTask(window, '跨账号共享任务')
      await discussion(window)
      await until(window, 'document.querySelector("[role=dialog]")?.textContent.includes("Bob 的真实服务评论")', 'persisted comment')
    }
    await fillLabel(bob, '发表评论', '来自 Bob 浏览器的评论')
    await click(bob, '发送评论', '[role=dialog] button')
    await until(alice, 'document.querySelector("[role=dialog]")?.textContent.includes("来自 Bob 浏览器的评论")', 'browser comment reaches Alice')
    await until(bob, 'document.querySelector("[role=dialog]")?.textContent.includes("来自 Bob 浏览器的评论")', 'browser comment committed')
    await screenshot(alice, 'alice-shared-task'); await screenshot(bob, 'bob-shared-task')
    await click(bob, '关闭详情')
    await click(bob, '退出登录')
    await until(bob, 'Boolean(document.querySelector("[aria-label=登录独立账号]"))', 'logout clears old workspace')
    assert.equal(await run(bob, 'Boolean(document.querySelector(".collab-workspace"))'), false)
    await login(bob, 'connected-alice', cfg.aliceId)
    assert.equal(await identity(alice), cfg.aliceId)
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log('PASS two real local logins in isolated hidden Chromium partitions; actual UI task/comment writes and live synchronization; main/shared-task screenshots; logout/account switch')
  } catch (error) {
    console.error('Browser console errors:', errors.join('\n'))
    for (const [index, window] of windows.entries()) if (!window.isDestroyed()) await screenshot(window, 'failure-client-' + index)
    throw error
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
  }
  app.exit(0)
}).catch((error) => { console.error(error.stack); for (const window of windows) if (!window.isDestroyed()) window.destroy(); app.exit(1) })
