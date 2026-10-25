const { app, BrowserWindow, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8')), windows = [], errors = [], commands = []
app.setPath('userData', join(cfg.directory, 'browser-user'))
app.setPath('sessionData', join(cfg.directory, 'browser-session'))
app.setPath('logs', join(cfg.directory, 'browser-logs'))
app.on('window-all-closed', () => {})
const pause = () => new Promise((done) => setTimeout(done, 40))
const run = (window, code) => window.webContents.executeJavaScript(code, true)
async function until(window, code, label) {
  const end = Date.now() + 12_000
  while (Date.now() < end) { if (await run(window, code)) return; await pause() }
  throw Error('Timed out: ' + label + '\n' + await run(window, 'document.body.innerText.slice(-2500)'))
}
async function click(window, label, selector = 'button') {
  const labels = Array.isArray(label) ? label : [label]
  assert.equal(await run(window, `(() => { const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => ${JSON.stringify(labels)}.includes(item.textContent.trim()) || ${JSON.stringify(labels)}.includes(item.getAttribute('aria-label'))); if (!button || button.disabled) return false; button.click(); return true })()`), true, 'Button ' + labels.join('/'))
  await pause()
}
async function fill(window, selector, value) {
  await run(window, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw Error('Input missing'); const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })()`)
  await pause()
}
async function make(name, cookies) {
  const partition = session.fromPartition('hifox-web-' + name)
  partition.webRequest.onBeforeRequest({ urls: [cfg.origin + '/api/projects/*/hifox/commands'] }, (details, callback) => {
    const bytes = details.uploadData?.map((part) => part.bytes).filter(Boolean)
    if (bytes?.length) {
      const body = JSON.parse(Buffer.concat(bytes).toString('utf8'))
      commands.push({ operation: body.operation, expectedEpoch: body.expectedEpoch, commandId: body.commandId })
    }
    callback({})
  })
  for (const cookie of cookies) await partition.cookies.set(cookie)
  const window = new BrowserWindow({ width: 1440, height: 1024, show: false, webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message) })
  windows.push(window); await window.loadURL(cfg.origin)
  await until(window, 'document.querySelector("[aria-label=当前项目]") !== null', name + ' signed in')
  await fill(window, '[aria-label="当前项目"]', cfg.projectId)
  await click(window, '团队', '[aria-label="团队导航"] button')
  await until(window, 'document.querySelector(".collab-workspace") !== null', name + ' real workspace')
  assert.equal(await run(window, 'typeof window.trellis'), 'undefined')
  return window
}
app.whenReady().then(async () => {
  try {
    const alice = await make('alice', cfg.aliceCookies), bob = await make('bob', cfg.bobCookies)
    for (const [name, text] of [['Agent', '审阅 Agent'], ['小队', '交付小队'], ['版本', '网页版版本']]) {
      await click(alice, name, '.collab-sidebar button')
      await until(alice, `document.querySelector('.collab-main').innerText.includes(${JSON.stringify(text)})`, 'actual ' + name)
    }
    await click(alice, '同事', '.collab-sidebar button')
    assert.equal(await run(alice, 'document.querySelector(".collab-main").innerText.includes("添加同事")'), false)
    await click(alice, ['全部任务', '任务'], '.collab-sidebar button')
    await click(bob, ['全部任务', '任务'], '.collab-sidebar button')
    await click(alice, '新建任务', '.collab-main button')
    await until(alice, 'document.querySelector("[role=dialog][aria-label=新建任务]") !== null', 'canonical modal')
    await fill(alice, '[role="dialog"] input[placeholder="一句话说清要做什么"]', '双账号真实任务')
    assert.equal(await run(alice, 'document.querySelector("[role=dialog]").closest(".hifox-host") !== null'), true)
    await click(alice, '创建', '[role="dialog"] button')
    await until(alice, '!document.querySelector("[role=dialog][aria-label=新建任务]")', 'task committed')
    await until(bob, 'document.querySelector(".collab-main").innerText.includes("双账号真实任务")', 'other account long poll')
    assert.ok(commands.some((command) => command.operation === 'createTask' && command.expectedEpoch === cfg.workspaceHead.epoch))
    for (const [theme, window] of [['light', alice], ['dark', bob]]) {
      await run(window, `if (document.querySelector('.hifox-host').dataset.myTheme !== ${JSON.stringify(theme)}) document.querySelector('.topbar [aria-label="切换主题"]').click()`)
      await until(window, `document.querySelector('.hifox-host').dataset.myTheme === ${JSON.stringify(theme)}`, 'theme follows outer navigation')
      const metrics = await run(window, `(() => { const host = document.querySelector('.hifox-host'), workspace = document.querySelector('.collab-workspace'), sidebar = document.querySelector('.collab-sidebar'), button = document.querySelector('.collab-sidebar nav button'), outer = document.querySelector('.topbar'); return { workspaceDisplay: getComputedStyle(workspace).display, font: getComputedStyle(button).fontSize, sidebar: sidebar.getBoundingClientRect().width, background: getComputedStyle(host).backgroundColor, outerHeight: outer.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth + 1 } })()`)
      assert.equal(metrics.workspaceDisplay, 'flex'); assert.ok(metrics.sidebar >= 220); assert.equal(metrics.font, '13px'); assert.equal(metrics.overflow, false); assert.equal(metrics.outerHeight, await run(window, `parseFloat(getComputedStyle(document.querySelector('.topbar')).getPropertyValue('--my-shell-chrome-size'))`))
      writeFileSync(join(cfg.evidence, theme + '.png'), (await window.webContents.capturePage()).toPNG())
      writeFileSync(join(cfg.evidence, theme + '-metrics.json'), JSON.stringify(metrics, null, 2))
    }
    await click(alice, '同事', '.collab-sidebar button')
    await click(alice, '管理团队与邀请')
    await until(alice, 'location.hash === "#people" && document.querySelector("[aria-label=团队导航] [aria-current=page]")?.getAttribute("aria-label") === "团队与成员"', 'real team management route')
    await click(alice, '团队', '[aria-label="团队导航"] button')
    await until(alice, 'document.querySelector(".collab-workspace") !== null', 'workspace returns')
    await fill(alice, '[aria-label="当前项目"]', cfg.otherProjectId)
    await until(alice, 'document.querySelector(".hifox-host") && !document.querySelector(".hifox-host").innerText.includes("双账号真实任务")', 'project fence clears old tasks')
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log('PASS actual Web bundle: no native bridge, two authenticated accounts, tasks/squads/agents/versions, long polling, team management, themed canonical dialogs, project fencing')
  } catch (error) {
    if (windows[0] && !windows[0].isDestroyed()) writeFileSync(join(cfg.evidence, 'failure.png'), (await windows[0].webContents.capturePage()).toPNG())
    throw error
  } finally { for (const window of windows) if (!window.isDestroyed()) window.destroy() }
  app.exit(0)
}).catch((error) => { console.error(error.stack); for (const window of windows) if (!window.isDestroyed()) window.destroy(); app.exit(1) })
