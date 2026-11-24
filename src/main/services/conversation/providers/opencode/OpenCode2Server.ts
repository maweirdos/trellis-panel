import { randomBytes } from 'node:crypto'
import { statSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { OpenCodeClient } from '@opencode/client/effect'
import * as Effect from 'effect/Effect'
import { DaemonError } from '../../../../daemon/errors'
import { type CodexOwnedProcess, spawnCodexOwnedProcess } from '../codex/process-owner'
import { driverConfigurationKey } from '../core/catalog'
import type { ConversationDriverOpenInput } from '../registry'
import { makeOpenCodeClient } from './OpenCode2Client'

export function openCodeConfigurationKey(env: NodeJS.ProcessEnv = process.env): string {
  return driverConfigurationKey([env.CRUX_OPENCODE_SERVER_URL, env.OPENCODE_PASSWORD, env.OPENCODE_SERVER_PASSWORD,
    env.OPENCODE_EXECUTABLE, env.PATH ?? env.Path, env.OPENCODE_CONFIG, env.OPENCODE_CONFIG_DIR, env.OPENCODE_CONFIG_CONTENT])
}

function executable(env: NodeJS.ProcessEnv): string {
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(isAbsolute)
  const command = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const candidates = env.OPENCODE_EXECUTABLE ? [env.OPENCODE_EXECUTABLE] : directories.map(path => join(path, command))
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || (process.platform === 'win32' && !candidate.toLowerCase().endsWith('.exe'))) continue
    try { if (statSync(candidate).isFile()) return realpathSync.native(candidate) } catch { continue }
  }
  throw new DaemonError('E_UNAVAILABLE', '没有找到 OpenCode 原生 CLI，也未配置已授权的原生 HTTP 服务。')
}

function localUrl(value: string): string {
  let url: URL
  try { url = new URL(value) }
  catch { throw new DaemonError('E_INVALID_ARG', 'OpenCode 服务地址无效。') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash
    || url.username || url.password) throw new DaemonError('E_DENIED', 'OpenCode 服务须使用无凭据、固定端口的本机 127.0.0.1 原生 HTTP 地址。')
  return url.origin
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      server.close(error => {
        if (error) reject(error)
        else if (!addr || typeof addr === 'string') reject(new Error('OpenCode local port could not be reserved.'))
        else resolve(addr.port)
      })
    })
  })
}

export async function openCodeServer(
  input: ConversationDriverOpenInput,
  onOwned: (handle: CodexOwnedProcess) => void,
): Promise<{ client: OpenCodeClient; version: string; url: string; password: string }> {
  const env = input.env ?? process.env
  let url: string
  let password: string
  let owned: CodexOwnedProcess | undefined
  if (env.CRUX_OPENCODE_SERVER_URL) {
    url = localUrl(env.CRUX_OPENCODE_SERVER_URL)
    password = env.OPENCODE_PASSWORD ?? env.OPENCODE_SERVER_PASSWORD ?? ''
    if (!password) throw new DaemonError('E_UNAVAILABLE', '授权的 OpenCode v2 服务需要原生服务密码。')
  } else {
    const command = executable(env)
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    password = randomBytes(32).toString('base64url')
    const isolated: NodeJS.ProcessEnv = { ...env, OPENCODE_PASSWORD: password }
    delete isolated.OPENCODE_SERVER_PASSWORD
    owned = await spawnCodexOwnedProcess({
      ...input, ownerKind: 'opencode', command, args: ['serve', '--hostname=127.0.0.1', `--port=${port}`], env: isolated,
    })
    onOwned(owned)
    owned.child.stdout.resume()
    owned.child.stderr.resume()
    owned.child.on('error', () => undefined)
    await owned.ready
  }
  const client = await makeOpenCodeClient(url, password)
  const deadline = Date.now() + 20_000
  do {
    input.assertCanSpawn()
    const info = await Effect.runPromise(client.server.info().pipe(Effect.timeout('2 seconds'), Effect.option))
    if (info._tag === 'Some') {
      if (!/^2\.\d+\.\d+/.test(info.value.version)) throw new DaemonError('E_VERSION', '该服务没有报告 OpenCode v2 原生版本。')
      return { client, version: info.value.version, url, password }
    }
    if (!owned || owned.child.exitCode !== null || owned.child.signalCode !== null) break
    await delay(150)
  } while (Date.now() < deadline)
  throw new DaemonError('E_UNAVAILABLE', 'OpenCode 原生服务未返回经授权的 v2 server.info 响应。')
}
