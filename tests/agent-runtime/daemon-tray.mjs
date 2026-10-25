import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { build } from 'esbuild'

// Actual tray controller, mocked Electron/manager only. No native app, profile,
// process, daemon transport, task runner or OS startup registration is used.
const temporary = mkdtempSync(join(tmpdir(), 'trellis-daemon-tray-'))
const require = createRequire(import.meta.url)
const key = `__daemonTray${randomUUID().replaceAll('-', '')}`
let serial = 0
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
const failure = (outcome = 'not-admitted') => ({ ok: false, code: 'E_UNAVAILABLE', error: 'fixture unavailable', outcome, ...(outcome === 'unknown' ? { commandId: randomUUID() } : {}) })
const running = () => ({
  protocol: 1, epoch: randomUUID(), owner: { pid: 1, startedAt: 'fixture-generation', userId: 'fixture', executable: 'fixture.exe' },
  state: 'running', activeJobs: 0, unknownJobs: 0,
  preferences: { revision: 7, keepRunning: true, startup: 'manual' }
})
async function fixture() {
  const state = {
    current: running(), absent: false, closing: false, dialogs: [], calls: [], changed: 0, opened: 0,
    reply: { response: 1 }, parent: null,
    async status() { this.calls.push('status'); return this.read ? this.read() : this.current ? { ok: true, data: structuredClone(this.current) } : failure() },
    async isAbsent() { this.calls.push('absent'); if (this.absenceError) throw Error('unverified'); return this.absent },
    async message(...args) { this.dialogs.push(args); return this.dialog ? this.dialog(...args) : this.reply },
    async mutate(kind) { this.calls.push(kind); return this.control ? this.control(kind) : { ok: true, data: kind === 'stop' ? null : structuredClone(this.current) } }
  }
  globalThis[key] = state
  const file = join(temporary, `fixture-${serial++}.cjs`)
  await build({
    entryPoints: ['src/main/services/daemon-tray.ts'], outfile: file, bundle: true, format: 'cjs', platform: 'node',
    plugins: [{ name: 'isolated-tray-ports', setup(builder) {
      builder.onResolve({ filter: /^electron$|^\.\/daemon-client\/manager$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
        const prelude = `const s=globalThis[${JSON.stringify(key)}];`
        return { contents: prelude + (args.path === 'electron'
          ? 'export const dialog={showMessageBox:(...args)=>s.message(...args)};'
          : 'export const daemonIsAbsent=()=>s.isAbsent();export const daemonManager={status:()=>s.status(),start:()=>s.mutate("start"),stop:()=>s.mutate("stop"),restart:()=>s.mutate("restart")};') }
      })
    } }]
  })
  const api = require(file)
  const controller = api.createDaemonTray({
    getMain: () => state.parent, changed: () => { state.changed++ }, openSettings: () => { state.opened++ }, isClosing: () => state.closing
  })
  return { state, controller, api }
}
const item = (controller, label) => controller.menu().find(value => value.label === label)
const controls = state => state.calls.filter(kind => ['start', 'stop', 'restart'].includes(kind))
const flush = () => new Promise(resolve => setImmediate(resolve))
async function check(name, action) { await action(); console.log(`PASS ${name}`) }

try {
  await check('only confirmed absence says stopped; status errors and unverified owners stay unavailable', async () => {
    const { state, controller } = await fixture()
    assert.ok(item(controller, '后台服务 · 状态不可用'))
    state.current = null
    await controller.refresh()
    assert.ok(item(controller, '后台服务 · 状态不可用'))
    assert.equal(item(controller, '启动后台服务').enabled, false)
    state.absenceError = true; state.absent = true
    await controller.refresh()
    assert.ok(item(controller, '后台服务 · 状态不可用'))
    state.absenceError = false
    await controller.refresh()
    assert.ok(item(controller, '后台服务 · 已停止'))
    assert.equal(item(controller, '启动后台服务').enabled, true)
    assert.deepEqual(controls(state), [])
    controller.dispose()
  })

  await check('concurrent status refreshes share a read and disposal drops late projections', async () => {
    const { state, controller } = await fixture(), read = deferred()
    state.read = () => read.promise
    const first = controller.refresh(), second = controller.refresh()
    assert.equal(first, second)
    assert.deepEqual(state.calls, ['status'])
    controller.dispose(); read.resolve({ ok: true, data: running() }); await first
    assert.equal(state.changed, 0)
    assert.equal(item(controller, '启动后台服务').enabled, false)
  })

  await check('start is explicit and one in-flight start is joined; preferences are untouched', async () => {
    const { state, controller } = await fixture(), release = deferred()
    state.current = null; state.absent = true
    state.control = () => release.promise
    const first = controller.run('start'), second = controller.run('start')
    assert.equal(first, second)
    await flush()
    assert.deepEqual(controls(state), ['start'])
    assert.equal(item(controller, '停止后台服务…').enabled, false)
    state.current = running(); state.absent = false
    release.resolve({ ok: true, data: state.current }); await first
    assert.ok(item(controller, '后台服务 · 运行中'))
    assert.deepEqual(state.current.preferences, { revision: 7, keepRunning: true, startup: 'manual' })
    assert.equal(state.dialogs.length, 0)
    await controller.run('start')
    assert.deepEqual(controls(state), ['start'])
    controller.dispose()
  })

  await check('zero activeJobs still requires explicit all-owned-task confirmation, and cancel does nothing', async () => {
    const { state, controller } = await fixture()
    state.parent = { isDestroyed: () => false, isVisible: () => false, isMinimized: () => false }
    state.reply = { response: 0 }
    await controller.run('stop')
    assert.deepEqual(controls(state), [])
    const [options] = state.dialogs[0]
    assert.equal(state.dialogs[0].length, 1, 'hidden main must not parent the native dialog')
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
    assert.match(options.message, /所有 Agent 与集成任务/)
    assert.equal(options.buttons[1], '停止所有后台任务并继续')
    controller.dispose()
  })

  await check('visible main parents native dialogs; minimized main uses an independent dialog', async () => {
    const { state, controller, api } = await fixture()
    let minimized = false
    state.parent = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => minimized }
    await api.showDaemonTrayMessage(() => state.parent, { message: 'fixture' })
    assert.equal(state.dialogs[0][0], state.parent)
    minimized = true
    await api.showDaemonTrayMessage(() => state.parent, { message: 'fixture' })
    assert.equal(state.dialogs[1].length, 1)
    controller.dispose()
  })

  await check('repeat stop clicks join the confirmation and original canonical stop', async () => {
    const { state, controller } = await fixture(), confirm = deferred()
    state.dialog = () => confirm.promise
    state.control = () => { state.current = null; state.absent = true; return { ok: true, data: null } }
    const first = controller.run('stop'), second = controller.run('restart')
    assert.equal(first, second); await flush()
    assert.equal(state.dialogs.length, 1)
    assert.deepEqual(controls(state), [])
    confirm.resolve({ response: 1 }); await first
    assert.deepEqual(controls(state), ['stop'])
    assert.ok(item(controller, '后台服务 · 已停止'))
    controller.dispose()
  })

  await check('restart uses the existing manager only after confirmation and preserves launch/retention choices', async () => {
    const { state, controller } = await fixture()
    await controller.run('restart')
    assert.deepEqual(controls(state), ['restart'])
    assert.equal(state.dialogs.length, 1)
    assert.deepEqual(state.current.preferences, { revision: 7, keepRunning: true, startup: 'manual' })
    controller.dispose()
  })

  await check('owner changes during confirmation block stop before a command is submitted', async () => {
    const { state, controller } = await fixture()
    state.dialog = options => { if (options.buttons?.length === 2) state.current = running(); return { response: 1 } }
    await controller.run('restart')
    assert.deepEqual(controls(state), [])
    assert.equal(state.dialogs.length, 2)
    assert.equal(state.dialogs[1][0].title, '后台所有者已改变')
    controller.dispose()
  })

  await check('unknown stop keeps the original receipt and never reissues on clicks, reads or apparent absence', async () => {
    const { state, controller } = await fixture(), original = failure('unknown')
    state.control = () => original
    await controller.run('restart')
    assert.deepEqual(controls(state), ['restart'])
    assert.match(state.dialogs[1][0].detail, new RegExp(original.commandId))
    assert.ok(item(controller, '原操作结果待核对'))
    await controller.run('restart'); await controller.run('stop'); await controller.refresh()
    state.current = null; state.absent = true; await controller.refresh(); await controller.run('start')
    assert.deepEqual(controls(state), ['restart'])
    assert.equal(item(controller, '启动后台服务').enabled, false)
    item(controller, '打开后台设置…').click()
    assert.equal(state.opened, 1)
    controller.dispose()
  })

  await check('not-admitted stop can be explicitly retried with a fresh confirmation', async () => {
    const { state, controller } = await fixture()
    state.control = () => failure()
    await controller.run('stop')
    assert.equal(item(controller, '停止后台服务…').enabled, true)
    await controller.run('stop')
    assert.deepEqual(controls(state), ['stop', 'stop'])
    assert.equal(state.dialogs.filter(args => args[0].buttons.length === 2).length, 2)
    controller.dispose()
  })

  await check('quit/disposal during native confirmation prevents a late mutation', async () => {
    for (const mode of ['quit', 'dispose']) {
      const { state, controller } = await fixture(), confirm = deferred()
      state.dialog = () => confirm.promise
      const work = controller.run('stop'); await flush()
      if (mode === 'quit') state.closing = true
      else controller.dispose()
      confirm.resolve({ response: 1 }); await work
      assert.deepEqual(controls(state), [])
      assert.equal(item(controller, '重启后台服务…').enabled, false)
      controller.dispose()
    }
  })
} finally {
  delete globalThis[key]
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep))
  rmSync(temporary, { recursive: true, force: true })
}
