import { createServer, createConnection } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { execFile } from 'node:child_process'
import type { ApplicationPort, ApplicationPortState, ApplicationReadiness } from '../../../../shared/app-runtime'
import { AppRuntimeError } from '../types'
import { IpcErrorCode } from '../../../../shared/ipc-errors'

export async function checkPort(port: ApplicationPort, timeoutMs = 1500): Promise<ApplicationPortState> {
  return new Promise((accept) => {
    const server = createServer()
    let settled = false
    const timer = setTimeout(() => finish({ ...port, state: 'unknown', message: '端口核验超时' }), timeoutMs)
    const finish = (result: ApplicationPortState): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close(() => accept(result))
      if (!server.listening) accept(result)
    }
    server.once('error', (error: NodeJS.ErrnoException) => finish({ ...port, state: error.code === 'EADDRINUSE' ? 'external-conflict' : 'unknown', message: error.code === 'EADDRINUSE' ? '端口已被占用，未停止外部进程' : '端口不可用或无权限' }))
    server.listen({ host: port.host, port: port.port, exclusive: true }, () => finish({ ...port, state: 'available' }))
  })
}
export async function checkPorts(ports: ApplicationPort[], timeoutMs = 1500): Promise<ApplicationPortState[]> { return Promise.all(ports.map((port) => checkPort(port, timeoutMs))) }
export async function diagnosePorts(ports: ApplicationPort[], ownedPids: number[] = []): Promise<ApplicationPortState[]> {
  const results = await checkPorts(ports)
  if (process.platform !== 'win32' || !results.some((port) => port.state === 'external-conflict')) return results
  let lines: string[]
  try {
    const output = await new Promise<string>((accept, reject) => execFile('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : accept(stdout)))
    lines = output.split(/\r?\n/)
  } catch { return results }
  return results.map((port) => {
    if (port.state !== 'external-conflict') return port
    const owners = lines.flatMap((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields[0] !== 'TCP' || fields[3] !== 'LISTENING' || !fields[1]?.endsWith(`:${port.port}`)) return []
      const address = fields[1].slice(0, -(String(port.port).length + 1)).replace(/^\[|\]$/g, '')
      const matches = address === port.host || address === '0.0.0.0' || address === '::' || port.host === '0.0.0.0' || port.host === '::'
      return matches && /^\d+$/.test(fields[4] ?? '') ? [Number(fields[4])] : []
    })
    const owned = owners.find((pid) => ownedPids.includes(pid))
    return owned !== undefined ? { ...port, state: 'owned', pid: owned, message: undefined } : owners.length === 1 ? { ...port, pid: owners[0] } : port
  })
}
export function validateReadiness(probe: ApplicationReadiness): void {
  if (probe.kind !== 'http') return
  const url = new URL(probe.url)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', '::1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new AppRuntimeError('就绪检查只支持无凭据的本机 HTTP 地址', IpcErrorCode.InvalidArg)
}
export async function probeOnce(probe: ApplicationReadiness, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (probe.kind === 'none') return false
  return new Promise((accept) => {
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    const finish = (ready: boolean): void => { if (!settled) { settled = true; if (deadline) clearTimeout(deadline); signal.removeEventListener('abort', abort); accept(ready) } }
    const abort = (): void => { target.destroy(); finish(false) }
    const target = probe.kind === 'tcp'
      ? createConnection({ host: probe.host, port: probe.port }, () => { target.destroy(); finish(true) })
      : (new URL(probe.url).protocol === 'https:' ? httpsRequest : httpRequest)(probe.url, { method: 'GET' }, (response) => { const ready = (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300; response.destroy(); target.destroy(); finish(ready) })
    target.once('error', () => finish(false))
    // A trickling HTTP header can keep an idle timeout alive indefinitely.
    deadline = setTimeout(() => { target.destroy(); finish(false) }, Math.min(1500, probe.timeoutMs))
    signal.addEventListener('abort', abort, { once: true })
    if (probe.kind === 'http') target.end()
  })
}
