import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import { DAEMON_LIMITS, processOwnerSchema, type ProcessOwner } from '../../shared/daemon'
import { nativeResource, powershellPath } from './native'
import { DaemonError } from './errors'

export interface NativePeer {
  id: number
  clientPid: number
  owner: ProcessOwner
  isAlive(): boolean
  send(value: unknown): void
  close(): void
  onFrame: (value: unknown) => void
  onClose: () => void
}
export interface NativeServer { close(): Promise<void> }
const bridgeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }), z.object({ type: z.literal('fatal') }),
  z.object({ type: z.literal('connected'), id: z.number().int().positive(), clientPid: z.number().int().positive(), owner: processOwnerSchema }).refine(value => value.clientPid === value.owner.pid, 'Pipe owner must match its actual client PID'),
  z.object({ type: z.literal('closed'), id: z.number().int().positive() }),
  z.object({ type: z.literal('frame'), id: z.number().int().positive(), data: z.string().max(350000) })
])
/** Windows user-DACL adapter. No TCP listener or unrestricted pipe fallback. */
export async function listenNativePipe(name: string, connected: (peer: NativePeer) => void, fatal: () => void, cacheDir?: string): Promise<NativeServer> {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeResource('windows-pipe.ps1'), '-Name', name]
  if (cacheDir) args.push('-CacheDir', cacheDir)
  const child: ChildProcessWithoutNullStreams = spawn(powershellPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const peers = new Map<number, NativePeer>()
  let closing = false
  let buffer = ''
  let ready = false
  let failed = false
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const write = (value: unknown): void => {
    const line = JSON.stringify(value) + '\n'
    if (child.stdin.destroyed || child.stdin.writableLength + Buffer.byteLength(line) > DAEMON_LIMITS.pendingBytes) throw new DaemonError('E_BUSY', 'Daemon transport output is saturated.')
    child.stdin.write(line)
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => fail(), DAEMON_LIMITS.handshakeMs)
    const fail = (): void => {
      if (failed) return
      failed = true
      clearTimeout(timer)
      for (const peer of peers.values()) peer.onClose()
      peers.clear(); child.stdin.end()
      if (!ready) reject(new DaemonError('E_UNAVAILABLE', 'The private Windows pipe adapter failed. No unrestricted fallback was opened.'))
      else if (!closing) fatal()
    }
    child.once('error', fail)
    child.once('exit', fail)
    child.stderr.on('data', () => { /* Native diagnostics may contain paths; only the bounded failure code is exposed. */ })
    child.stdin.on('error', fail)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (failed) return
      try {
        buffer += chunk
        if (Buffer.byteLength(buffer) > DAEMON_LIMITS.pendingBytes) throw new Error('bridge overflow')
        let boundary: number
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary).replace(/^\uFEFF/, '').trim()
          buffer = buffer.slice(boundary + 1)
          if (!line) continue
          const event = bridgeEventSchema.parse(JSON.parse(line))
          if (event.type === 'ready') { if (ready) throw new Error('duplicate ready'); ready = true; clearTimeout(timer); resolve(); continue }
          if (event.type === 'fatal') { fail(); return }
          if (event.type === 'connected') {
            if (peers.has(event.id)) throw new Error('duplicate peer')
            if (peers.size >= DAEMON_LIMITS.connections) { write({ id: event.id, close: true }); continue }
            let alive = true
            const peer: NativePeer = { id: event.id, clientPid: event.clientPid, owner: event.owner, isAlive: () => alive && !failed && !closing && peers.has(event.id), onFrame: () => {}, onClose: () => {}, send(value) {
              if (failed || closing || !peers.has(event.id)) throw new DaemonError('E_UNAVAILABLE', 'The original daemon transport peer is closed.')
              const data = Buffer.from(JSON.stringify(value))
              if (data.length > DAEMON_LIMITS.frameBytes) throw new DaemonError('E_BUSY', 'Daemon response exceeds the frame limit.')
              write({ id: event.id, data: data.toString('base64') })
            }, close() {
              alive = false
              if (!peers.delete(event.id)) return
              peer.onClose()
              try { write({ id: event.id, close: true }) } catch { fail() }
            } }
            peers.set(peer.id, peer); connected(peer)
          } else if (event.type === 'closed') {
            const peer = peers.get(event.id); peers.delete(event.id); peer?.onClose()
          } else {
            const data = Buffer.from(event.data, 'base64')
            if (!data.length || data.length > DAEMON_LIMITS.frameBytes || data.toString('base64') !== event.data) throw new Error('invalid bridge frame')
            const peer = peers.get(event.id)
            if (peer) { try { peer.onFrame(JSON.parse(utf8.decode(data))) } catch { peer.close() } }
          }
        }
      } catch { fail() }
    })
  })
  return { async close() {
    closing = true
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      // Pipe helper closes cleanly on stdin EOF; bound wait to 1.5s before SIGKILL so quit never stalls.
      let timer = setTimeout(onDeadline, Math.min(DAEMON_LIMITS.requestMs, 1500))
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.stdin.end()
      function onDeadline(): void {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
        timer = setTimeout(() => resolve(), 1000)
        timer.unref()
      }
    })
  } }
}
