// Original bounded ACP fixture. No upstream implementation is copied.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback = '') => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const root = option('--root')
const nonce = option('--nonce')
const mode = option('--mode', 'normal')
const stage = option('--stage', 'main')
if (!root || !nonce) process.exit(90)
mkdirSync(root, { recursive: true })
const log = (kind, data = {}) => appendFileSync(join(root, 'fixture.jsonl'), `${JSON.stringify({ at: Date.now(), kind, pid: process.pid, parentPid: process.ppid, nonce, stage, ...data })}\n`)
if (args.includes('--grandchild')) {
  log('grandchild_started', { execPath: process.execPath })
  setTimeout(() => { log('grandchild_self_exit'); process.exit(0) }, 20_000)
} else {
  log('agent_started', { execPath: process.execPath, argv: args, restrictedPath: process.env.PATH === join(root, 'empty path'), marker: process.env.TPANEL_LIFECYCLE_MARKER })
  if (mode === 'protocol-control') {
    const peerPath = fileURLToPath(new URL('../protocol/strict-peer.mjs', import.meta.url))
    process.argv = [process.execPath, peerPath, root, 'normal', nonce]
    setTimeout(() => process.exit(0), 25_000).unref()
    await import(pathToFileURL(peerPath).href)
  } else {
  const send = (message) => { log('response_written', { message }); return process.stdout.write(`${JSON.stringify(message)}\n`) }
  const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
  let pendingPrompt = null
  let buffer = ''
  const respondInitialize = (id) => result(id, { protocolVersion: 1, agentInfo: { name: 'trellis-original-lifecycle-fixture', version: '1.0.0' }, agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: false }, mcpCapabilities: { http: false, sse: false } }, authMethods: [] })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (part) => {
    buffer += part
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '')
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { log('invalid_json'); continue }
      log('request', { method: message.method, id: message.id, remoteSessionId: message.params?.sessionId })
      if (message.method === 'initialize') {
        if (mode === 'init-error') send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'deliberate fixture initialization failure' } })
        else if (mode === 'slow-init' || existsSync(join(root, 'slow-initialize'))) setTimeout(() => respondInitialize(message.id), 2200)
        else respondInitialize(message.id)
      } else if (message.method === 'session/new') {
        if (mode === 'grandchild') {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--grandchild', '--root', root, '--nonce', nonce, '--stage', stage], { stdio: 'ignore', windowsHide: true })
          log('grandchild_spawned', { grandchildPid: child.pid })
          child.unref()
        }
        result(message.id, { sessionId: `remote-${nonce}`, configOptions: [] })
      } else if (message.method === 'session/load') {
        result(message.id, { configOptions: [] })
      } else if (message.method === 'session/prompt') {
        if (mode === 'busy') pendingPrompt = message.id
        else {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture reply' } } } })
          result(message.id, { stopReason: 'end_turn' })
        }
      } else if (message.method === 'session/cancel') {
        if (pendingPrompt !== null) { result(pendingPrompt, { stopReason: 'cancelled' }); pendingPrompt = null }
      } else if (message.method === 'session/close') result(message.id, {})
      else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'fixture method not implemented' } })
    }
  })
  process.stdin.on('end', () => { log('stdin_end'); process.exit(0) })
  setTimeout(() => { log('agent_self_exit'); process.exit(0) }, 25_000).unref()
  }
}
