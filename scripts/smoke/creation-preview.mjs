/** Run with node scripts/smoke/creation-preview.mjs; --unit-only skips Electron. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const directory = mkdtempSync(join(tmpdir(), 'tpanel-creation-preview-'))
const checks = []
const check = (name, action) => { action(); checks.push(name); console.log('PASS ' + name) }
let completed = false

try {
  await Promise.all([
    build({
      entryPoints: [join(root, 'src/renderer/src/creations/preview-bridge.ts')],
      outfile: join(directory, 'bridge.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'es2022',
      tsconfig: join(root, 'tsconfig.web.json'), logLevel: 'silent'
    }),
    build({
      entryPoints: [join(root, 'src/shared/creation-preview.ts'), join(root, 'src/shared/creations.ts')],
      outdir: join(directory, 'shared'), bundle: true, platform: 'node', format: 'cjs', target: 'es2022',
      outExtension: { '.js': '.cjs' }, logLevel: 'silent'
    })
  ])
  const bridge = require(join(directory, 'bridge.cjs'))
  const adapters = require(join(directory, 'shared/creation-preview.cjs'))
  const { creationTargetSchema } = require(join(directory, 'shared/creations.cjs'))
  const nonce = bridge.createPreviewNonce()
  const wrongNonce = (nonce[0] === 'a' ? 'b' : 'a') + nonce.slice(1)
  const peer = {}, other = {}
  const target = {
    kind: 'web', stableId: 'save', selector: 'main > button', tag: 'button', role: 'button', name: 'Save', text: 'Save',
    box: { x: .1, y: .2, width: .1, height: .2 },
    context: {
      route: '/', hash: '#settings', scroll: { x: 0, y: 200 }, viewport: { width: 640, height: 400 },
      fields: [{ selector: '#compact', name: 'compact', value: 'true' }]
    }
  }
  const event = (data) => ({ source: peer, origin: 'null', data: { channel: bridge.PREVIEW_CHANNEL, nonce, ...data } })

  check('protocol requires the exact frame, null origin, current nonce and an allowed message', () => {
    const selection = event({ type: 'selection', target })
    assert.deepEqual(bridge.parsePreviewMessage(selection, peer, nonce), { type: 'selection', target })
    for (const altered of [
      { source: other }, { origin: 'file://' }, { origin: 'https://example.invalid' },
      { data: { ...selection.data, nonce: wrongNonce } }
    ]) assert.equal(bridge.parsePreviewMessage({ ...selection, ...altered }, peer, nonce), null)
    assert.equal(bridge.parsePreviewMessage(selection, null, nonce), null)
    assert.equal(bridge.parsePreviewMessage(selection, peer, 'bad'), null)
    assert.equal(bridge.parsePreviewMessage(event({ type: 'command', command: 'delete' }), peer, nonce), null)
    assert.equal(bridge.parsePreviewMessage(event({ type: 'interaction', event: { kind: { toString: 'bad' } } }), peer, nonce), null)
  })

  check('protocol bounds DOM metadata and rejects markup, unexpected keys and invalid geometry', () => {
    for (const patch of [
      { name: 'x'.repeat(501) }, { text: '<script>' }, { selector: 'x'.repeat(501) }, { wholeDOM: 'secret' },
      { box: { x: .9, y: 0, width: .2, height: .1 } }, { box: { x: NaN, y: 0, width: 1, height: 1 } },
      { tag: 'BODY<svg>' }, { state: { toString: 'bad' } }
    ]) assert.equal(bridge.parsePreviewTarget({ ...target, ...patch }), null, JSON.stringify(patch))
    for (const value of [null, [], { kind: 'web' }]) assert.equal(bridge.parsePreviewTarget(value), null)
  })

  check('protocol excludes sensitive fields, credentials, storage and unbounded context', () => {
    for (const context of [
      { ...target.context, fields: [{ selector: '#password', value: 'secret' }] },
      { ...target.context, fields: [{ name: 'token', value: 'no' }] },
      { ...target.context, fields: [{ name: 'layout', value: 'x'.repeat(129) }] },
      { ...target.context, fields: Array.from({ length: 13 }, () => ({ name: 'layout', value: 'true' })) },
      { ...target.context, localStorage: {} }, { ...target.context, hash: '#access_token=abc' },
      { ...target.context, route: 'https://example.invalid' }, { ...target.context, viewport: { width: 20_000, height: 1 } }
    ]) assert.equal(bridge.parsePreviewTarget({ ...target, context }), null)
    assert.ok(bridge.parsePreviewTarget({ ...target, context: { fields: [{ name: 'compact', value: 'true' }] } }))
  })

  check('preview adapters preserve bounded state and satisfy the strict creation target schema', () => {
    const converted = adapters.previewTargetToCreationTarget({ ...target, selectedText: 'Save' })
    assert.deepEqual(creationTargetSchema.parse(converted), converted)
    assert.equal('tag' in converted, false)
    assert.equal('selectedText' in converted, false)
    assert.deepEqual(adapters.creationTargetToPreviewTarget(converted), converted)
    assert.equal(adapters.creationTargetToPreviewTarget({ kind: 'general' }), null)
    assert.ok(creationTargetSchema.safeParse(adapters.previewTargetToCreationTarget({ ...target, name: '标题', text: '实际正文' })).success)
  })

  check('generated documents put restrictive CSP first and safely escape plain text and script data', () => {
    const authored = '</head><script>window.authored=1</script><iframe src="https://example.invalid"></iframe>'
    const html = bridge.buildPreviewDocument(authored, nonce)
    assert.ok(html.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'))
    assert.ok(html.indexOf(bridge.PREVIEW_CSP) < html.indexOf('<script>'))
    assert.ok(html.indexOf('<script>') < html.indexOf(authored))
    for (const directive of [
      "default-src 'none'", "connect-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
      'img-src data: blob:', "form-action 'none'", "base-uri 'none'", "frame-src 'none'"
    ]) assert.ok(bridge.PREVIEW_CSP.includes(directive), directive)
    assert.equal(bridge.PREVIEW_CSP.includes('unsafe-eval'), false)
    assert.throws(() => bridge.buildPreviewDocument('ok', '</script><script>alert(1)</script>'))
    const text = bridge.buildPreviewDocument('a < 3 & "b"\u2028\u2029', nonce)
    assert.ok(text.includes('a &lt; 3 &amp; &quot;b&quot;'))
    assert.equal((text.match(/<script>/g) ?? []).length, 1)
    assert.throws(() => bridge.buildPreviewDocument('界'.repeat(100_000), nonce))
    const sdk = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    assert.ok(sdk)
    new Script(sdk) // Parse the generated SDK; never execute authored HTML in Node.
  })
  writeFileSync(join(directory, 'protocol-report.json'), JSON.stringify({ checks }, null, 2))

  if (!process.argv.includes('--unit-only')) {
    await build({
      entryPoints: [join(root, 'scripts/smoke/fixtures/creation-preview-ui.jsx')],
      outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome124',
      jsx: 'automatic', minify: true, tsconfig: join(root, 'tsconfig.web.json'), logLevel: 'silent'
    })
    const rendererHtml = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')
    const hostCsp = rendererHtml.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i)?.[0]
    assert.ok(hostCsp, 'use the actual renderer CSP rather than strengthening only the test host')
    const css = ['my-tokens.css', 'my-components.css'].map((file) => readFileSync(join(root, 'src/renderer/src/my', file), 'utf8')).join('\n')
    writeFileSync(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${hostCsp}<style>${css}html,body,#root{height:100%;margin:0}</style><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
    const env = { ...process.env, CREATION_PREVIEW_FIXTURE: directory }
    delete env.ELECTRON_RUN_AS_NODE
    await new Promise((done, reject) => {
      const child = execFile(require('electron'), [join(root, 'scripts/smoke/fixtures/creation-preview-host.cjs')], {
        env, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) { reject(new Error(`Isolated Electron failed: ${error.message}\n${stdout}\n${stderr}`)); return }
        if (!stdout.includes('CREATION_PREVIEW_ELECTRON_PASSED')) { reject(new Error('Electron exited without completing its checks')); return }
        done()
      })
      child.stdout.on('data', (bytes) => process.stdout.write(bytes))
      child.stderr.on('data', (bytes) => process.stderr.write(bytes))
    })
    const report = JSON.parse(readFileSync(join(directory, 'electron-report.json'), 'utf8'))
    assert.equal(report.errors.length, 0)
    assert.equal(report.requests.length, 0, 'CSP must block requests before the protective network interceptor')
    console.log(`Creation preview smoke passed: ${checks.length} protocol + ${report.checks.length} isolated Electron checks.`)
  } else console.log(`Creation preview protocol passed: ${checks.length} checks.`)
  completed = true
} finally {
  if (!completed || process.argv.includes('--keep-fixture')) console.log(`Creation preview fixture retained: ${directory}`)
  else {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('tpanel-creation-preview-'))
    rmSync(directory, { recursive: true, force: true })
  }
}
