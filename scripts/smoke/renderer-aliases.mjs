import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cache = mkdtempSync(join(tmpdir(), 'tpanel-renderer-aliases-'))
let server
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(root, 'electron.vite.config.ts'))
  assert.ok(loaded?.config.renderer, 'load the actual Electron renderer configuration')
  server = await createServer({
    ...loaded.config.renderer,
    configFile: false,
    cacheDir: cache,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...loaded.config.renderer.server, host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }
  })
  await server.listen()
  const url = server.resolvedUrls?.local[0]
  assert.ok(url, 'isolated development server is listening')
  const importer = join(root, 'src/renderer/src/applications/ApplicationConfigDialog.tsx')
  const shared = await server.pluginContainer.resolveId('@shared/app-runtime', importer)
  const renderer = await server.pluginContainer.resolveId('@/api', importer)
  assert.equal(shared?.id.replaceAll('\\', '/'), join(root, 'src/shared/app-runtime.ts').replaceAll('\\', '/'))
  assert.equal(renderer?.id.replaceAll('\\', '/'), join(root, 'src/renderer/src/api.ts').replaceAll('\\', '/'))
  const response = await fetch(new URL('src/applications/ApplicationConfigDialog.tsx', url))
  const module = await response.text()
  assert.equal(response.status, 200, 'actual config dialog passes Vite development import analysis')
  assert.ok(module.includes('applicationSaveSchema'), 'runtime schema import is preserved')
  assert.ok(!module.includes('Failed to resolve import'))
  const sharedModule = await fetch(new URL('/@fs/' + shared.id.replaceAll('\\', '/'), url))
  assert.equal(sharedModule.status, 200, 'shared runtime module is readable through the development server')
  console.log('PASS actual renderer dev server: @shared and @ resolution, configuration dialog HTTP 200 and shared runtime module HTTP 200')
} finally {
  await server?.close()
  assert.equal(dirname(resolve(cache)), resolve(tmpdir()))
  assert.ok(basename(cache).startsWith('tpanel-renderer-aliases-'))
  rmSync(cache, { recursive: true, force: true })
}
