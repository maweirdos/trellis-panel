import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'trellis-runtime-seal-'))
try {
  await build({ entryPoints: ['src/main/daemon/runtime/blobs.ts'], outfile: join(directory, 'blobs.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const { RuntimeBlobs } = await import(pathToFileURL(join(directory, 'blobs.mjs')).href)
  const blobs = new RuntimeBlobs(join(directory, 'spool'))
  const value = { text: '项目上下文😀'.repeat(12_000) }
  const packed = blobs.pack('owned-root', value)
  assert.ok(packed.blob, 'The case must exercise writable-file flush and sealed bulk transport')
  assert.deepEqual(blobs.unpack('owned-root', packed), value)
  const chunks = []
  let offset = 0
  while (true) {
    const page = blobs.read('owned-root', packed.blob, offset)
    chunks.push(Buffer.from(page.data, 'base64'))
    offset = page.next
    if (page.done) break
  }
  const bytes = Buffer.concat(chunks)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), packed.blob.sha256)
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), value)
  assert.throws(() => blobs.bytes('foreign-root', packed.blob))
  assert.throws(() => blobs.bytes('owned-root', { ...packed.blob, sha256: '0'.repeat(64) }))
  blobs.release('owned-root', packed.blob.id)
  assert.throws(() => blobs.bytes('owned-root', packed.blob))
  console.log('PASS Windows-compatible sealing, exact bulk bytes/hash, chunk paging, root/identity fences and release')
} finally {
  assert.ok(directory.startsWith(join(tmpdir(), 'trellis-runtime-seal-')))
  rmSync(directory, { recursive: true, force: true })
}
