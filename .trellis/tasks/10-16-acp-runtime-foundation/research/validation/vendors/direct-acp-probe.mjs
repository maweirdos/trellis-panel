// Clean-room diagnostic: official ACP client -> official Claude adapter, no acpx.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
const [dependencyRoot, adapterRoot, cwd, executable, outputPath] = process.argv.slice(2)
const requireDependency = createRequire(join(resolve(dependencyRoot), 'package.json'))
const acp = await import(pathToFileURL(requireDependency.resolve('@agentclientprotocol/sdk')).href)
const adapterPackage = join(resolve(adapterRoot), 'node_modules/@agentclientprotocol/claude-agent-acp')
const manifest = JSON.parse(await readFile(join(adapterPackage, 'package.json'), 'utf8'))
const adapterEntry = resolve(adapterPackage, typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin)[0])
const report = { probe: 'direct-official-acp-client', adapterVersion: manifest.version, authMethodIds: [], sessionCreated: false, expectedMatched: false, protocolVersion: null, error: null, exitCode: null, foreignUpdates: 0 }
const child = spawn(process.execPath, [adapterEntry], { cwd: resolve(cwd), env: { ...process.env, CLAUDE_CODE_EXECUTABLE: resolve(executable) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.resume()
let agentSessionId
let text = ''
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
const conn = new acp.ClientSideConnection(() => ({
  requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  sessionUpdate: async (params) => {
    if (agentSessionId && params.sessionId !== agentSessionId) { report.foreignUpdates++; return }
    if (params.update.sessionUpdate === 'agent_message_chunk' && params.update.content?.type === 'text') text += params.update.content.text
  },
}), stream)
let timer
try {
  const operation = async () => {
    const initialized = await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'trellis-isolated-probe', version: '1' } })
    report.protocolVersion = initialized.protocolVersion
    report.authMethodIds = (initialized.authMethods ?? []).map(({ id }) => id)
    const session = await conn.newSession({ cwd: resolve(cwd), mcpServers: [] })
    agentSessionId = session.sessionId
    report.sessionCreated = Boolean(agentSessionId)
    report.initialModelId = session.models?.currentModelId
    const result = await conn.prompt({ sessionId: agentSessionId, prompt: [{ type: 'text', text: 'Reply exactly CLAUDE_VALIDATION_READY. Do not use any tools or external resources.' }] })
    report.stopReason = result.stopReason
    report.expectedMatched = text.includes('CLAUDE_VALIDATION_READY')
  }
  await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('direct ACP deadline')), 45_000) })])
} catch (error) {
  report.error = { code: error.code, message: String(error.message).replace(/(?:sk-|sk_)[A-Za-z0-9_-]{8,}/g, '[redacted-key]').slice(0, 300) }
} finally {
  clearTimeout(timer)
  child.stdin.end()
  let closeTimer
  await Promise.race([new Promise((done) => { if (child.exitCode !== null) return done(); child.once('exit', done) }), new Promise((done) => { closeTimer = setTimeout(done, 10_000) })])
  clearTimeout(closeTimer)
  if (child.exitCode === null && child.signalCode === null) {
    // The ChildProcess handle still owns this live PID; never enumerate/kill unrelated processes.
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      await new Promise((done) => killer.once('exit', done))
    } else child.kill('SIGTERM')
    report.forcedOwnedStop = true
  }
  report.exitCode = child.exitCode
  await writeFile(resolve(outputPath), JSON.stringify(report, null, 2), 'utf8')
  process.stdout.write(JSON.stringify(report) + '\n')
}
