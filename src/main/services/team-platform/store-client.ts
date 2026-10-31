import { Worker } from 'node:worker_threads'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { neighborWorkerFile } from '../worker-path'
import { DesktopTeamError, MAX_PENDING_BYTES, MAX_PENDING_COUNT, MAX_RPC_BYTES, type WorkerOperation, type WorkerResponse } from './types'

type Pending = { resolve(value: unknown): void; reject(error: Error): void; bytes: number; timer: NodeJS.Timeout; write: boolean }
const reads = new Set(['health', 'accounts', 'account', 'invitation-intent', 'connections', 'connection', 'connection-by-approval-command', 'command', 'outbox', 'cached-document', 'sync-read', 'snapshot-read'])
export class DesktopTeamStore {
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()
  private pendingBytes = 0
  private serial = 0
  private lockPath: string | null = null
  private lockBytes: string | null = null
  private closed = false
  private closingTask: Promise<void> | null = null
  private constructor(private readonly dataDir: string, private readonly workerFile: string, private readonly timeoutMs: number) {}
  static async open(input: { dataDir: string; workerFile?: string; requestTimeoutMs?: number }): Promise<DesktopTeamStore> {
    const timeout = input.requestTimeoutMs ?? 15000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new DesktopTeamError('INVALID_INPUT', '团队存储等待时限无效')
    const store = new DesktopTeamStore(resolve(input.dataDir), input.workerFile ?? neighborWorkerFile('team-desktop-worker.js', 'TRELLIS_TEAM_DESKTOP_WORKER_FILE'), timeout)
    await store.acquire()
    try { await store.start(); return store } catch (error) { if (store.worker) await store.worker.terminate(); await store.release(); throw error }
  }
  private async acquire(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    const info = await fs.lstat(this.dataDir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new DesktopTeamError('STORE_PATH', '团队存储目录无法核实')
    this.lockPath = join(await fs.realpath(this.dataDir), 'owner.lock')
    const bytes = JSON.stringify({ pid: process.pid, nonce: randomUUID() })
    const create = async (): Promise<void> => {
      const handle = await fs.open(this.lockPath ?? '', 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      this.lockBytes = bytes
    }
    try { await create(); return } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error }
    const guard = join(this.dataDir, 'owner-recovery.lock')
    let handle: Awaited<ReturnType<typeof fs.open>>
    try { handle = await fs.open(guard, 'wx', 0o600) } catch { throw new DesktopTeamError('STORE_OWNED', '团队存储归属正在核对或上次核对尚未完成') }
    try {
      const lock = await fs.lstat(this.lockPath)
      if (!lock.isFile() || lock.isSymbolicLink() || lock.size > 8192) throw new DesktopTeamError('STORE_OWNED', '团队存储归属记录无法核实')
      const previous = await fs.readFile(this.lockPath, 'utf8'), owner = z.object({ pid: z.number().int().positive(), nonce: z.string().uuid() }).strict().parse(JSON.parse(previous))
      let dead = false
      try { process.kill(owner.pid, 0) } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') dead = true; else throw new DesktopTeamError('STORE_OWNED', '团队存储原进程状态未知') }
      if (!dead) throw new DesktopTeamError('STORE_OWNED', '团队存储仍由原主进程持有；写入器退出不代表可以接管')
      if (await fs.readFile(this.lockPath, 'utf8') !== previous) throw new DesktopTeamError('STORE_OWNED', '团队存储归属已改变')
      await fs.rename(this.lockPath, join(this.dataDir, `owner-${owner.nonce}.stale`))
      await create()
    } finally { await handle.close(); await fs.unlink(guard) }
  }
  private async release(): Promise<void> {
    if (this.lockPath && this.lockBytes) {
      try { if (await fs.readFile(this.lockPath, 'utf8') === this.lockBytes) await fs.unlink(this.lockPath) } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
      this.lockBytes = null
    }
  }
  private async start(): Promise<void> {
    const worker = new Worker(this.workerFile)
    this.worker = worker
    worker.on('message', (message: WorkerResponse) => {
      if (this.worker !== worker) return
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.pending.delete(message.requestId); this.pendingBytes -= pending.bytes; clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.value); else pending.reject(new DesktopTeamError(message.code, message.error))
    })
    const lost = (): void => {
      if (this.worker !== worker) return
      this.worker = null
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DesktopTeamError(pending.write ? 'ACKNOWLEDGEMENT_UNKNOWN' : 'STORE_UNAVAILABLE', pending.write ? '团队存储写入确认丢失，请核对原命令' : '团队存储写入器不可用', pending.write)) }
      this.pending.clear(); this.pendingBytes = 0
      // Lock stays with the live main owner; never let another service steal it.
    }
    worker.on('error', lost); worker.on('exit', lost)
    await this.call({ op: 'init', input: { dataDir: this.dataDir } })
    worker.unref()
  }
  call<T>(operation: WorkerOperation): Promise<T> {
    const worker = this.worker
    if (!worker || this.closed) return Promise.reject(new DesktopTeamError('STORE_UNAVAILABLE', '团队本地存储不可用'))
    const bytes = Buffer.byteLength(JSON.stringify(operation))
    if (bytes > MAX_RPC_BYTES || this.pending.size >= MAX_PENDING_COUNT || this.pendingBytes + bytes > MAX_PENDING_BYTES) return Promise.reject(new DesktopTeamError('CAPACITY_EXCEEDED', '团队存储队列已达限界，请稍后核对'))
    const requestId = ++this.serial, write = !reads.has(operation.op)
    return new Promise<T>((resolveResult, reject) => {
      const timer = setTimeout(() => { reject(new DesktopTeamError(write ? 'ACKNOWLEDGEMENT_UNKNOWN' : 'STORE_UNAVAILABLE', '团队存储确认超时；原请求和限额保留至实际回复或退出', write)) }, this.timeoutMs)
      this.pending.set(requestId, { resolve: (value) => resolveResult(value as T), reject, timer, bytes, write }); this.pendingBytes += bytes
      try { worker.postMessage({ ...operation, requestId }) }
      catch { this.pending.delete(requestId); this.pendingBytes -= bytes; clearTimeout(timer); reject(new DesktopTeamError('STORE_UNAVAILABLE', '团队存储请求未能派发')) }
    })
  }
  async close(): Promise<void> {
    if (this.closed) return
    if (this.closingTask) return this.closingTask
    this.closingTask = (async () => {
      const worker = this.worker
      try { if (worker) await this.call({ op: 'close' }) }
      finally {
        this.closed = true; this.worker = null
        if (worker) await worker.terminate()
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DesktopTeamError('ACKNOWLEDGEMENT_UNKNOWN', '团队存储在确认前关闭', pending.write)) }
        this.pending.clear(); this.pendingBytes = 0
        await this.release()
      }
    })()
    return this.closingTask
  }
}
