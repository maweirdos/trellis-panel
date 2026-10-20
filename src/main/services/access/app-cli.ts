/** Embedded in the main bundle and installed beside userData; no global Node is required. */
export function appCliScript(): string {
  return APP_CLI_SCRIPT
}

export function appCliPowerShell(executable: string, client: string, descriptor: string): string {
  const launch = Buffer.from(JSON.stringify({ executable, client, descriptor }), 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${launch}')) | ConvertFrom-Json`,
    "  $env:ELECTRON_RUN_AS_NODE = '1'",
    '  & $launch.executable $launch.client --descriptor $launch.descriptor @args',
    '  exit $LASTEXITCODE',
    '} catch {',
    "  [Console]::Out.WriteLine('{\"ok\":false,\"error\":{\"code\":\"E_SETUP_REQUIRED\",\"message\":\"Reinstall the tpanel command from Trellis Panel Settings.\"}}')",
    '  exit 1',
    '}',
    ''
  ].join('\r\n')
}

const APP_CLI_SCRIPT = String.raw`'use strict'
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const MAX_RESPONSE_BYTES = 512 * 1024

function failure(code, message) {
  return { ok: false, error: { code, message } }
}
function print(result) {
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exitCode = result && result.ok === true ? 0 : 1
}
function readSmall(file, limit) {
  const handle = fs.openSync(file, 'r')
  try {
    if (fs.fstatSync(handle).size > limit) throw new Error('size')
    const data = Buffer.alloc(limit + 1)
    const count = fs.readSync(handle, data, 0, data.length, 0)
    if (count > limit) throw new Error('size')
    return data.subarray(0, count).toString('utf8')
  } finally { fs.closeSync(handle) }
}
function options(argv) {
  const result = { timeout: 15000 }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value.startsWith('--')) {
      const key = value.slice(2)
      if (!['descriptor', 'project', 'timeout', 'request-id', 'cursor'].includes(key) || result[key] !== undefined && key !== 'timeout') throw new Error('arguments')
      const next = argv[++i]
      if (typeof next !== 'string' || next.startsWith('--') || next.includes('\0')) throw new Error('arguments')
      result[key] = next
    } else positional.push(value)
  }
  if (positional[0] === 'app') positional.shift()
  result.operation = positional[0]
  result.id = positional[1]
  if (positional.length > 2 || !['list', 'status', 'start', 'stop', 'restart', 'logs'].includes(result.operation)) throw new Error('arguments')
  if (!result.project || !path.isAbsolute(result.project) || result.project.length > 4096) throw new Error('arguments')
  if (result.operation === 'list' ? result.id !== undefined : !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(result.id || '')) throw new Error('arguments')
  result.timeout = Number(result.timeout)
  if (!Number.isInteger(result.timeout) || result.timeout < 100 || result.timeout > 60000) throw new Error('arguments')
  if (result['request-id'] && !/^[A-Za-z0-9._:-]{1,64}$/.test(result['request-id'])) throw new Error('arguments')
  if (result.cursor !== undefined && (!/^\d{1,16}$/.test(result.cursor) || !Number.isSafeInteger(Number(result.cursor)))) throw new Error('arguments')
  if (!result.descriptor || !path.isAbsolute(result.descriptor)) throw new Error('arguments')
  return result
}
function discovery(file) {
  let descriptor
  try { descriptor = JSON.parse(readSmall(file, 4096)) } catch { return failure('E_SETUP_REQUIRED', 'Open Trellis Panel and enable the local access service in Settings.') }
  if (!descriptor || descriptor.version !== 1 || descriptor.enabled !== true || descriptor.running !== true || typeof descriptor.endpoint !== 'string') return failure('E_SETUP_REQUIRED', 'Open Trellis Panel and enable the local access service in Settings.')
  let endpoint
  try { endpoint = new URL(descriptor.endpoint) } catch { return failure('E_INVALID_ARG', 'Invalid local access descriptor.') }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/tpap/v1') return failure('E_DENIED', 'The application client accepts only the local loopback access service.')
  let token
  try { token = readSmall(path.join(path.dirname(file), 'access-token'), 256).trim() } catch { return failure('E_SETUP_REQUIRED', 'The local access credential is unavailable. Open Trellis Panel Settings.') }
  if (!/^[a-f0-9]{64}$/.test(token)) return failure('E_SETUP_REQUIRED', 'The local access credential is unavailable. Open Trellis Panel Settings.')
  return { endpoint, token }
}
async function request(config, settings) {
  const mutating = ['start', 'stop', 'restart'].includes(config.operation)
  const target = new URL(settings.endpoint.href)
  target.pathname += '/apps/' + config.operation
  const data = { project: path.resolve(config.project) }
  if (config.id) data.appId = config.id
  if (config.cursor !== undefined) data.after = Number(config.cursor)
  if (mutating) { data.confirm = true; data.requestId = config['request-id'] || crypto.randomUUID() }
  else for (const [key, value] of Object.entries(data)) target.searchParams.set(key, String(value))
  const body = mutating ? JSON.stringify(data) : undefined
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
    const req = http.request(target, {
      method: mutating ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + settings.token, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) }
    }, (res) => {
      let size = 0
      const chunks = []
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) { finish(failure('E_UPSTREAM', 'The local access response exceeded the client limit.')); res.destroy(); req.destroy(); return }
        chunks.push(chunk)
      })
      res.on('error', () => finish(failure('E_UPSTREAM', 'The local access response was interrupted.')))
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!result || typeof result.ok !== 'boolean' || res.statusCode < 200 || res.statusCode >= 300 && result.ok === true) finish(failure('E_UPSTREAM', 'The local access service returned an invalid response.'))
          else finish(result)
        } catch { finish(failure('E_UPSTREAM', 'The local access service returned an invalid response.')) }
      })
    })
    const timer = setTimeout(() => { finish(failure('E_TIMEOUT', 'The application request timed out. Check status before retrying.' + (mutating ? ' Retry this operation with --request-id ' + data.requestId + '.' : ''))); req.destroy() }, config.timeout)
    req.on('error', () => finish(failure('E_SETUP_REQUIRED', 'The local access service is unavailable. Open Trellis Panel and check Settings.')))
    if (body) req.write(body)
    req.end()
  })
}
async function main() {
  let config
  try { config = options(process.argv.slice(2)) } catch {
    print(failure('E_INVALID_ARG', 'Usage: tpanel app list|status|start|stop|restart|logs [appId] --project <absolute-root> [--timeout 15000] [--request-id id] [--cursor offset]'))
    return
  }
  const settings = discovery(config.descriptor)
  if (settings.ok === false) { print(settings); return }
  print(await request(config, settings))
}
main().catch(() => print(failure('E_UNKNOWN', 'The application client could not complete the request.')))
`
