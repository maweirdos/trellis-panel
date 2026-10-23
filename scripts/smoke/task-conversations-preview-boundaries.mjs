/** Independent preview identity boundaries; temporary native-format files only. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const temporaryBase = resolve(tmpdir())
const directory = mkdtempSync(join(temporaryBase, 'tpanel-preview-boundaries-'))
const require = createRequire(import.meta.url)
const source = await build({ stdin: { contents: "export {nativePreview} from './src/main/services/task-conversations/lib/preview'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], logLevel: 'silent' })
const bundled = { exports: {} }
new Function('require', 'module', 'exports', source.outputFiles[0].text)(require, bundled, bundled.exports)
const { nativePreview } = bundled.exports
const root = join(directory, 'project'), sourceRoot = join(directory, 'native')
mkdirSync(root); mkdirSync(sourceRoot)
const file = join(sourceRoot, 'history.jsonl'), sessionId = randomUUID()
const descriptor = { sourceRoot, file, conversation: { id: 'candidate', sessionId, source: 'codex', cwd: root,
  title: 'Isolated preview boundary', titleSource: 'native', updatedAt: 0, capability: 'session', role: 'unknown' } }
const metadata = (id = sessionId, cwd = root, extra = {}) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, ...extra } }) + '\n'
const message = (text, role = 'assistant', channel = 'final') => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, channel, content: [{ type: 'output_text', text }] } }) + '\n'
const outcomes = []
const check = async (name, action) => {
  try { await action(); outcomes.push({ name, passed: true }); console.log('PASS ' + name) }
  catch (error) { outcomes.push({ name, passed: false, error: error.message }); console.error('FAIL ' + name + ': ' + error.message) }
}
const refused = result => { assert.equal(result.messages.length, 0); assert.ok(result.unavailableReason) }
try {
  await check('verified unknown native role permits visible text without inferring a child', async () => {
    writeFileSync(file, metadata() + message('VISIBLE_CONTROL'))
    assert.deepEqual((await nativePreview(root, 'candidate', descriptor)).messages, [{ role: 'assistant', text: 'VISIBLE_CONTROL' }])
  })
  await check('explicit native thread_spawn child overrides unknown index role', async () => {
    writeFileSync(file, metadata(sessionId, root, { source: { subagent: { thread_spawn: { parent_thread_id: randomUUID() } } } }) + message('CHILD_MUST_NOT_APPEAR'))
    refused(await nativePreview(root, 'candidate', descriptor))
  })
  await check('explicit native thread_source subagent conflicts with a user-role descriptor', async () => {
    writeFileSync(file, metadata(sessionId, root, { thread_source: 'subagent' }) + message('CHILD_MUST_NOT_APPEAR'))
    refused(await nativePreview(root, 'candidate', { ...descriptor, conversation: { ...descriptor.conversation, role: 'user' } }))
  })
  await check('same path replaced before opening cannot lend a foreign session body', async () => {
    writeFileSync(file, metadata(randomUUID(), sourceRoot) + message('FOREIGN_BEFORE_READ'))
    refused(await nativePreview(root, 'candidate', descriptor))
  })
  await check('in-place identity rewrite between verified head and tail cannot lend foreign text', async () => {
    const padding = JSON.stringify({ type: 'padding', payload: { value: 'x'.repeat(800000) } }) + '\n'
    writeFileSync(file, metadata() + padding + message('ORIGINAL_VISIBLE'))
    const io = require('node:fs/promises'), originalOpen = io.open
    let switched = false
    io.open = async (...args) => {
      const handle = await originalOpen(...args), originalRead = handle.read.bind(handle)
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs)
        if (args[0] === file && !switched && readArgs[3] === 0) {
          switched = true
          writeFileSync(file, metadata(randomUUID(), sourceRoot) + padding + message('FOREIGN_AFTER_HEAD'))
        }
        return result
      }
      return handle
    }
    try {
      const result = await nativePreview(root, 'candidate', descriptor)
      assert.ok(switched, 'mutation barrier must actually run')
      refused(result)
    } finally { io.open = originalOpen }
  })
  await check('atomic replacement after opening invalidates the original path snapshot', async () => {
    const padding = JSON.stringify({ type: 'padding', payload: { value: 'x'.repeat(800000) } }) + '\n'
    writeFileSync(file, metadata() + padding + message('OPEN_INODE_VISIBLE'))
    const replacement = join(sourceRoot, 'replacement.jsonl')
    writeFileSync(replacement, metadata(randomUUID(), sourceRoot) + padding + message('REPLACEMENT_VISIBLE'))
    const io = require('node:fs/promises'), originalOpen = io.open
    let switched = false
    io.open = async (...args) => {
      const handle = await originalOpen(...args), originalRead = handle.read.bind(handle)
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs)
        if (args[0] === file && !switched && readArgs[3] === 0) {
          switched = true
          assert.equal(dirname(replacement), sourceRoot)
          assert.equal(dirname(file), sourceRoot)
          renameSync(replacement, file)
        }
        return result
      }
      return handle
    }
    try {
      const result = await nativePreview(root, 'candidate', descriptor)
      assert.ok(switched, 'replacement barrier must actually run')
      refused(result)
    } finally { io.open = originalOpen }
  })
  console.log(JSON.stringify({ ok: outcomes.every(item => item.passed), checks: outcomes.length, outcomes,
    scope: 'production preview against temporary native-format identity/role/race fixtures; no real source or control writes' }))
  if (outcomes.some(item => !item.passed)) process.exitCode = 1
} finally {
  assert.equal(dirname(directory), temporaryBase)
  assert.ok(directory.startsWith(join(temporaryBase, 'tpanel-preview-boundaries-')))
  rmSync(directory, { recursive: true, force: true })
}
