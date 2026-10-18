/** Focused image admission/wire/history regression. No provider or desktop UI. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build, transform } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-acp-images-'))
process.env.TPAP_SMOKE_DIR = temporary
const root = join(temporary, 'project')
mkdirSync(root)
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6P1sAAAAASUVORK5CYII='
const image = { id: 'fixture-png', name: '截图.png', mimeType: 'image/png', data: png }
let acp
const until = async (predicate, label) => {
  const end = Date.now() + 10000
  while (Date.now() < end) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 15)) }
  throw new Error(`Deadline: ${label}`)
}
try {
  const request = createRequire(import.meta.url)
  await build({ stdin: { contents: `export * from './src/main/services/acp'; export {setSettings} from './src/main/services/store'; export {promptImagesSchema} from './src/main/services/acp/images'; export {compileItems} from './src/renderer/src/acp/timeline';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', external: ['acpx', 'acpx/*'],
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(pathToFileURL(resolve('package.json')).href)});` },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') },
    plugins: [{ name: 'public-runtime', setup(builder) { builder.onResolve({ filter: /^acpx\// }, (args) => ({ path: pathToFileURL(request.resolve(args.path)).href, external: true })) } }],
    outfile: join(temporary, 'images.mjs'), logLevel: 'silent' })
  acp = await import(pathToFileURL(join(temporary, 'images.mjs')).href)
  assert.equal(acp.promptImagesSchema.safeParse([image]).success, true)
  for (const images of [
    [{ ...image, mimeType: 'image/jpeg' }], [{ ...image, data: '<svg>unsafe</svg>' }],
    [{ ...image, data: `${png}\n` }], [image, image],
    Array.from({ length: 9 }, (_, index) => ({ ...image, id: `image-${index}` })),
    [{ ...image, data: Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(10 * 1024 * 1024)]).toString('base64') }],
    Array.from({ length: 3 }, (_, index) => ({ ...image, id: `large-${index}`, data: Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(7 * 1024 * 1024)]).toString('base64') }))
  ]) assert.equal(acp.promptImagesSchema.safeParse(images).success, false)
  console.log('PASS MIME/signature/base64, duplicate IDs, count and byte bounds')

  const wire = join(temporary, 'images-wire.jsonl')
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [{ id: 'image-fixture', name: 'Image fixture', command: 'controlled peer', enabled: true, executable: process.execPath, args: [resolve('scripts/smoke/fixtures/acp-image-peer.mjs'), wire, 'yes'] }] } })
  const created = await acp.newAcpSession(root, { agentId: 'image-fixture' })
  assert.equal(created.ok, true, created.error)
  const current = () => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === created.sessionId)
  await until(() => current()?.status === 'ready', 'image session ready')
  assert.equal(current().capabilities.promptCapabilities.image, true)
  const generation = current().connectionGeneration
  const prompts = () => readFileSync(wire, 'utf8').trim().split('\n').map(JSON.parse).filter((event) => event.method === 'session/prompt')
  assert.equal((await acp.promptAcpSession(root, created.sessionId, '', { images: [image], expectedConnectionGeneration: 'stale' })).ok, false)
  assert.equal((await acp.promptAcpSession(root, created.sessionId, '', { images: [{ ...image, mimeType: 'image/jpeg' }] })).ok, false)
  assert.equal(prompts().length, 0, 'Invalid/stale input must not reach session/prompt')
  const sent = await acp.promptAcpSession(root, created.sessionId, '', { images: [image], expectedConnectionGeneration: generation })
  assert.equal(sent.ok, true, sent.error)
  await until(() => current()?.status === 'ready', 'image turn settled')
  assert.deepEqual(prompts()[0].params.prompt, [{ type: 'image', mimeType: 'image/png', data: png }])
  assert.deepEqual(current().events.find((event) => event.payload?.role === 'user').payload.images, [image])
  const userItem = acp.compileItems(current().events).find((item) => item.type === 'user')
  assert.equal(userItem.text, '')
  assert.deepEqual(userItem.images, [image])
  const second = await acp.promptAcpSession(root, created.sessionId, '看这两张图片', { images: [image, { ...image, id: 'second' }] })
  assert.equal(second.ok, true, second.error)
  await until(() => current()?.status === 'ready', 'second turn settled')
  assert.deepEqual(prompts()[1].params.prompt.map((block) => block.type), ['text', 'image', 'image'])
  assert.equal((await acp.killAcpSession(root, created.sessionId)).ok, true)
  assert.deepEqual(acp.listAcpSessions(root).sessions.find((session) => session.sessionId === created.sessionId).events.find((event) => event.payload?.role === 'user').payload.images, [image], 'Disk history retains the attachment')
  console.log('PASS real ACP image-only/mixed wire content, next turn, timeline and saved history')

  const unsupportedWire = join(temporary, 'unsupported-wire.jsonl')
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [{ id: 'text-fixture', name: 'Text fixture', command: 'controlled peer', enabled: true, executable: process.execPath, args: [resolve('scripts/smoke/fixtures/acp-image-peer.mjs'), unsupportedWire, 'no'] }] } })
  const unsupported = await acp.newAcpSession(root, { agentId: 'text-fixture' })
  assert.equal(unsupported.ok, true, unsupported.error)
  await until(() => acp.listAcpSessions(root).sessions.find((session) => session.sessionId === unsupported.sessionId)?.status === 'ready', 'text session ready')
  const denied = await acp.promptAcpSession(root, unsupported.sessionId, '', { images: [image] })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /未声明支持图片/)
  assert.ok(!readFileSync(unsupportedWire, 'utf8').includes('session/prompt'))
  console.log('PASS unsupported capability rejects before publishing a turn or sending bytes')

  // Parse only the changed TSX sources, without a production build or broad typecheck.
  for (const name of ['ConsoleWorkspace', 'ImageAttachments', 'useComposerImages', 'TranscriptRow']) {
    await transform(readFileSync(`src/renderer/src/acp/${name}.tsx`, 'utf8'), { loader: 'tsx' })
  }
  console.log('PASS changed renderer TSX syntax')
} finally {
  await acp?.shutdownAcp()
  // temporary is created above under the OS temp directory and owns only this test's files.
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('trellis-acp-images-'))
  rmSync(temporary, { recursive: true, force: true })
}
