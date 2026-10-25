import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import { NODE_RELEASE, prepareNodeRuntime, projectRoot } from '../../scripts/prepare-node-runtime.mjs'

const binary = Buffer.from('standalone-node-test-fixture')
const license = Buffer.from('Node license test fixture')
const hash = value => createHash('sha256').update(value).digest('hex')
const release = { ...NODE_RELEASE, sha256: hash(binary), licenseSha256: hash(license) }
const options = root => ({ root, platform: 'win32', arch: 'x64', release })
const fixture = async name => mkdtemp(join(tmpdir(), `trellis-node-${name}-`))
const assets = url => new Response(url === release.url ? binary : license)

if (process.argv.includes('--child')) {
  const root = process.argv.at(-1)
  await prepareNodeRuntime({ ...options(root), fetchImpl: async url => {
    await appendFile(join(root, 'requests.log'), `${process.pid}\n`)
    await new Promise(done => setTimeout(done, 120))
    return assets(url)
  } })
} else {
  const project = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  const builder = load(await readFile(join(projectRoot, 'electron-builder.yml'), 'utf8'))
  assert.equal(NODE_RELEASE.version, '24.12.0')
  assert.equal(NODE_RELEASE.url, 'https://nodejs.org/dist/v24.12.0/win-x64/node.exe')
  assert.equal(NODE_RELEASE.sha256, '2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8')
  assert.equal(NODE_RELEASE.licenseUrl, 'https://raw.githubusercontent.com/nodejs/node/v24.12.0/LICENSE')
  assert.equal(NODE_RELEASE.licenseSha256, '537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34')
  assert.equal(project.scripts.postinstall, 'node scripts/prepare-acpx.mjs')
  for (const script of ['predev', 'prebuild', 'pretypecheck']) assert.equal(project.scripts[script], 'npm run check:acpx')
  for (const script of ['predist:dir', 'predist']) assert.equal(project.scripts[script], 'npm run check:acpx && node scripts/prepare-node-runtime.mjs')
  assert.deepEqual(builder.extraResources.find(item => item.to === 'node-runtime/win-x64'), {
    from: `node_modules/.cache/trellis-node/dist/${NODE_RELEASE.directory}`, to: 'node-runtime/win-x64', filter: ['node.exe', 'LICENSE']
  })
  assert.deepEqual(builder.win.target[0].arch, ['x64'])
  console.log('PASS packaging-only preparation, pinned official sources and resource layout')

  const cached = await fixture('offline')
  let requests = 0
  const directory = await prepareNodeRuntime({ ...options(cached), fetchImpl: async url => { requests++; return assets(url) } })
  assert.equal(requests, 2)
  assert.deepEqual(await readdir(directory), ['LICENSE', 'node.exe'])
  assert.equal(await hash(await readFile(join(directory, 'node.exe'))), release.sha256)
  assert.equal(await prepareNodeRuntime({ ...options(cached), fetchImpl: () => { throw new Error('offline') } }), directory)
  console.log('PASS both verified assets publish together; cached dist works without network')

  const broken = await fixture('failure')
  const original = join(broken, 'node_modules/.cache/trellis-node/dist', release.directory)
  await mkdir(original, { recursive: true })
  await writeFile(join(original, 'node.exe'), 'keep-original')
  await writeFile(join(original, 'LICENSE'), 'keep-original-license')
  for (const failure of ['checksum', 'http', 'offline', 'oversized', 'license']) {
    await assert.rejects(prepareNodeRuntime({ ...options(broken), fetchImpl: async url => {
      if (failure === 'offline') throw new Error('offline')
      if (failure === 'http') return new Response('', { status: 503 })
      if (failure === 'oversized') return new Response(binary, { headers: { 'content-length': String(160 * 1024 * 1024) } })
      if (failure === 'license' && url === release.licenseUrl || failure === 'checksum') return new Response('tampered')
      return assets(url)
    } }))
    assert.equal(await readFile(join(original, 'node.exe'), 'utf8'), 'keep-original')
    assert.equal(await readFile(join(original, 'LICENSE'), 'utf8'), 'keep-original-license')
    assert.deepEqual(await readdir(join(broken, 'node_modules/.cache/trellis-node/dist')), [release.directory])
    assert.deepEqual(await readdir(join(broken, 'node_modules/.cache/trellis-node')), ['dist'])
  }
  console.log('PASS checksum/license/HTTP/network/size failure preserves original dist and releases lock')

  const originalRename = fsPromises.rename
  fsPromises.rename = async (source, target) => {
    if (String(source).includes('.node-stage-') && target === join(await realpath(dirname(original)), basename(original))) throw new Error('fixture publish rename failure')
    return originalRename(source, target)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(prepareNodeRuntime({ ...options(broken), fetchImpl: assets }), /publish rename failure/)
    assert.equal(await readFile(join(original, 'node.exe'), 'utf8'), 'keep-original')
    assert.equal(await readFile(join(original, 'LICENSE'), 'utf8'), 'keep-original-license')
    assert.deepEqual(await readdir(join(broken, 'node_modules/.cache/trellis-node/dist')), [release.directory])
  } finally {
    fsPromises.rename = originalRename
    syncBuiltinESMExports()
  }
  console.log('PASS final publication failure restores the original dist')

  await prepareNodeRuntime({ ...options(broken), fetchImpl: assets })
  assert.equal(hash(await readFile(join(original, 'node.exe'))), release.sha256)
  console.log('PASS damaged cache is replaced only by a fully verified pair')

  for (const [platform, arch] of [['win32', 'arm64'], ['linux', 'x64'], ['darwin', 'x64']]) {
    await assert.rejects(prepareNodeRuntime({ ...options(cached), platform, arch, fetchImpl: () => { throw new Error('must not download') } }), /only Windows x64/)
  }
  console.log('PASS unsupported targets reject before download')

  for (const bad of [{ directory: '../outside' }, { directory: 'nested/version' }, { executable: '../node.exe' }]) {
    await assert.rejects(prepareNodeRuntime({ ...options(cached), release: { ...release, ...bad }, fetchImpl: () => { throw new Error('must not download') } }), /Invalid managed Node asset path/)
  }
  console.log('PASS managed Node publication paths cannot escape the owned dist directory')

  const concurrent = await fixture('concurrent')
  const run = promisify(execFile)
  await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, [fileURLToPath(import.meta.url), '--child', concurrent], { windowsHide: true, timeout: 15_000 })))
  const lines = (await readFile(join(concurrent, 'requests.log'), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(new Set(lines).size, 1)
  console.log('PASS four concurrent processes perform exactly one download pair')

  const recovered = await fixture('dead-lock')
  const lock = join(recovered, 'node_modules/.cache/trellis-node/prepare-win-x64.lock')
  await mkdir(resolve(lock, '..'), { recursive: true })
  await writeFile(lock, JSON.stringify({ pid: 2147483647, token: 'abandoned-owner' }))
  await prepareNodeRuntime({ ...options(recovered), fetchImpl: assets, lockTimeoutMs: 500 })
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'live-owner' }))
  await assert.rejects(prepareNodeRuntime({ ...options(recovered), fetchImpl: assets, lockTimeoutMs: 100 }), /Timed out/)
  assert.equal(JSON.parse(await readFile(lock)).token, 'live-owner')
  console.log('PASS dead owner recovery and live owner lock protection')
}
