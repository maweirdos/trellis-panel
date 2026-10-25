const { app, BrowserWindow, session } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', join(cfg.directory, 'browser-user'))
app.setPath('sessionData', join(cfg.directory, 'browser-session'))
app.setPath('logs', join(cfg.directory, 'browser-logs'))
app.on('window-all-closed', () => {})
const windows = []
const pause = () => new Promise((done) => setTimeout(done, 30))
const run = (window, code) => window.webContents.executeJavaScript(code, true)
async function until(window, code, label) { const end = Date.now() + 10000; while (Date.now() < end) { if (await run(window, code)) return; await pause() }; throw Error('Timed out: ' + label) }
async function click(window, label) {
  assert.equal(await run(window, `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.getClientRects().length && getComputedStyle(item).visibility === 'visible' && !item.matches(':disabled') && (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(label)}); if (!button) return false; button.click(); return true })()`), true, 'Button ' + label)
  await pause()
}
async function fill(window, selector, value) {
  await run(window, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw Error('Input missing'); const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })()`)
  await pause()
}
async function make(name, cookies = []) {
  const partition = session.fromPartition('invitation-' + name)
  for (const cookie of cookies) await partition.cookies.set(cookie)
  const window = new BrowserWindow({ width: 1360, height: 980, show: false, webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  windows.push(window); await window.loadURL(cfg.origin); return window
}
app.whenReady().then(async () => {
  try {
    const alice = await make('alice', cfg.aliceCookies), bob = await make('bob', cfg.bobCookies)
    await until(alice, `document.querySelector('[aria-label="团队导航"]') !== null`, 'Alice signed in')
    await click(alice, '团队与成员')
    await until(alice, `document.body.textContent.includes('邀请加入团队和项目')`, 'invitation controls')
    await click(alice, '邀请加入团队和项目')
    await until(alice, `document.querySelector('[aria-label="邀请项目"] option[value="${cfg.projectId}"]') !== null`, 'authorized project')
    await fill(alice, '[aria-label="邀请项目"]', cfg.projectId)
    await fill(alice, '[aria-label="邀请账号类型"]', 'oidc-subject')
    await fill(alice, '[aria-label="邀请接收账号"]', 'bob')
    await click(alice, '创建邀请链接')
    await until(alice, `Boolean(document.querySelector('[aria-label="邀请链接"]')?.value)`, 'created link')
    const link = await run(alice, `document.querySelector('[aria-label="邀请链接"]').value`)
    const url = new URL(link); assert.equal(url.origin, cfg.origin); assert.ok(url.searchParams.get('invitation')); assert.ok(/^#token=ti_/.test(url.hash))
    await bob.loadURL(link)
    await until(bob, `document.body.textContent.includes('确认以当前账号加入')`, 'explicit accept action')
    assert.equal(await run(bob, `document.querySelector('[aria-label="当前项目"]').options.length`), 1)
    assert.equal(await run(bob, `document.querySelector('dialog').textContent.includes(${JSON.stringify(cfg.bobId)})`), true)
    await click(bob, '确认以当前账号加入')
    await until(bob, `document.body.textContent.includes('邀请已接受') && document.querySelector('[aria-label="当前项目"] option[value="${cfg.projectId}"]') !== null`, 'membership after explicit acceptance')
    await alice.loadURL(link)
    await until(alice, `document.querySelector('dialog [role="alert"]') !== null`, 'wrong account rejection')
    assert.equal(await run(alice, `[...document.querySelectorAll('dialog button')].some((button) => button.textContent.includes('确认以当前账号加入'))`), false)
    assert.equal(await run(alice, `document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth + 1`), true)
    console.log('PASS invitation create/link fragment/explicit acceptance/current identity/wrong account in two signed Chromium partitions')
  } finally { for (const window of windows) if (!window.isDestroyed()) window.destroy() }
  app.exit(0)
}).catch((error) => { console.error(error.message); for (const window of windows) if (!window.isDestroyed()) window.destroy(); app.exit(1) })
