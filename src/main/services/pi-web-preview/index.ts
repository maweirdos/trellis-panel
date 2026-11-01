import { randomBytes, createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, relative } from 'node:path'
import type { Socket } from 'node:net'
import { piWebPreviewOpenSchema, type PiWebPreviewOpenResult, type PiWebPreviewStatusResult } from '../../../shared/pi-web-preview'
import { IpcErrorCode, ipcFail, type IpcFail } from '../../../shared/ipc-errors'
import { MAX_TRACKED_BYTES, PreviewError, clearPreviewMetadata, previewEntry, readPreviewFile, resourcePath, samePath } from './paths'

const MAX_LEASES = 8
const MAX_OWNER_LEASES = 4
const MAX_FILES = 128
const MAX_REQUESTS = 16
const MAX_LEASE_REQUESTS = 8
const IDLE_MS = 30 * 60 * 1000
const LIFETIME_MS = 2 * 60 * 60 * 1000
const token = (): string => randomBytes(32).toString('hex')
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)

export interface PiWebPreviewSession {
  sessionId: string
  engine?: string
  projectRoot: string
  cwd?: string
  connectionGeneration?: string
}
export interface PiWebPreviewDependencies {
  getProject: (sessionId?: string) => { root: string | null; generation: number }
  readSession: (root: string, sessionId: string) => Promise<{ ok: true; session: PiWebPreviewSession } | IpcFail>
}
export interface PiWebPreviewOwner { id: number; isCurrent: () => boolean }
interface TrackedFile { hash: string; size: number; observation: number }
interface Lease {
  id: string; capability: string; owner: PiWebPreviewOwner; root: string; generation: number
  session: PiWebPreviewSession; cwd: string; entry: string; directory: string
  server: Server; host: string; sockets: Set<Socket>; files: Map<string, TrackedFile>
  revision: string; createdAt: number; accessedAt: number; requests: number; closed: boolean; observation: number
  status?: Promise<PiWebPreviewStatusResult>
  ownerCheck?: Promise<void>; ownerCheckedAt: number
}
type CloseResult = { ok: true } | IpcFail

function failure(error: unknown): IpcFail {
  if (error instanceof PreviewError) return ipcFail(error.code, error.message)
  const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
  if (code === 'ENOENT' || code === 'ENOTDIR') return ipcFail(IpcErrorCode.NotFound, '预览文件不存在，请重新生成或刷新。')
  if (code === 'EACCES' || code === 'EPERM') return ipcFail(IpcErrorCode.Denied, '没有读取预览文件的权限。')
  return ipcFail(IpcErrorCode.Io, '无法读取静态预览，请重试。')
}

/** Main owns the dependencies; this service has no Electron import and never launches a project. */
export class PiWebPreviewService {
  private readonly leases = new Map<string, Lease>()
  private readonly pending = new Map<number, number>()
  private readonly sweep: ReturnType<typeof setInterval>
  private requests = 0
  private disposed = false

  constructor(private readonly deps: PiWebPreviewDependencies) {
    this.sweep = setInterval(() => {
      for (const lease of this.leases.values()) {
        if (!this.current(lease)) this.release(lease)
        else if (!lease.ownerCheck && Date.now() - lease.ownerCheckedAt >= 5000) {
          lease.ownerCheckedAt = Date.now()
          lease.ownerCheck = this.assertSession(lease).catch(() => this.release(lease)).finally(() => { lease.ownerCheck = undefined })
        }
      }
    }, 1000)
    this.sweep.unref()
  }

  async open(owner: PiWebPreviewOwner, input: unknown): Promise<PiWebPreviewOpenResult> {
    const parsed = piWebPreviewOpenSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '静态预览请求无效。')
    const project = this.deps.getProject(parsed.data.sessionId)
    if (!project.root) return ipcFail(IpcErrorCode.NoProject, '未打开项目。')
    const root = project.root
    if (!samePath(root, parsed.data.expectedRoot)) return ipcFail(IpcErrorCode.Conflict, '项目已变化，请重新打开预览。')
    const ownerCount = [...this.leases.values()].filter(lease => lease.owner.id === owner.id).length + (this.pending.get(owner.id) ?? 0)
    const pendingCount = [...this.pending.values()].reduce((sum, count) => sum + count, 0)
    if (this.disposed || !owner.isCurrent()) return ipcFail(IpcErrorCode.Conflict, '预览窗口已关闭。')
    if (ownerCount >= MAX_OWNER_LEASES || this.leases.size + pendingCount >= MAX_LEASES)
      return ipcFail(IpcErrorCode.Busy, '预览数量已达上限，请先关闭其他预览。')
    this.pending.set(owner.id, (this.pending.get(owner.id) ?? 0) + 1)
    let lease: Lease | undefined
    const current = (): boolean => {
      const latest = this.deps.getProject(parsed.data.sessionId)
      return !this.disposed && owner.isCurrent() && latest.root === root && latest.generation === project.generation
    }
    try {
      const first = await this.deps.readSession(root, parsed.data.sessionId)
      if (!current()) throw new PreviewError(IpcErrorCode.Conflict, '项目或窗口已变化。')
      if (!first.ok) return first
      const session = first.session
      if (session.engine !== 'pi' || session.sessionId !== parsed.data.sessionId || !samePath(root, session.projectRoot) ||
        parsed.data.connectionGeneration !== undefined && session.connectionGeneration !== parsed.data.connectionGeneration)
        throw new PreviewError(IpcErrorCode.Conflict, '项目或 Pi 会话连接已变化。')
      const cwd = session.cwd ?? root
      const { entry, directory } = await previewEntry(root, cwd, parsed.data.artifact.path)
      const file = await readPreviewFile(root, directory, entry)
      const id = token(), capability = token()
      const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
        if (!lease) { response.writeHead(503, { 'Cache-Control': 'no-store' }).end(); return }
        void this.serve(lease, request, response).catch(() => response.destroy())
      })
      lease = { id, capability, owner, root, generation: project.generation, session: { ...session }, cwd, entry, directory,
        server, host: '', sockets: new Set(), files: new Map([[entry, { hash: digest(file.bytes), size: file.bytes.length, observation: 0 }]]),
        revision: digest(file.bytes), createdAt: Date.now(), accessedAt: Date.now(), requests: 0, closed: false, observation: 0, ownerCheckedAt: Date.now() }
      const listeningLease = lease
      server.on('connection', socket => {
        if (listeningLease.closed || listeningLease.sockets.size >= 32) { socket.destroy(); return }
        listeningLease.sockets.add(socket)
        socket.on('close', () => listeningLease.sockets.delete(socket))
      })
      server.requestTimeout = 10000
      server.headersTimeout = 5000
      server.keepAliveTimeout = 1000
      server.maxRequestsPerSocket = 100
      await new Promise<void>((done, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); done() })
      })
      server.on('error', () => this.release(listeningLease))
      const address = server.address()
      if (!address || typeof address === 'string') throw new PreviewError(IpcErrorCode.Io, '无法启动本机静态预览。')
      lease.host = `127.0.0.1:${address.port}`
      await this.assertSession(lease)
      if (!current()) throw new PreviewError(IpcErrorCode.Conflict, '项目或窗口已变化。')
      this.leases.set(id, lease)
      return { ok: true, preview: { id, url: `http://${lease.host}/${capability}/${encodeURIComponent(basename(entry))}`, path: entry, revision: lease.revision } }
    } catch (error) {
      if (lease) this.release(lease)
      return failure(error)
    } finally {
      const remaining = (this.pending.get(owner.id) ?? 1) - 1
      if (remaining > 0) this.pending.set(owner.id, remaining)
      else this.pending.delete(owner.id)
    }
  }

  async status(ownerId: number, id: unknown): Promise<PiWebPreviewStatusResult> {
    const found = this.owned(ownerId, id)
    if (!('id' in found)) return found
    const lease = found
    if (lease.status) return lease.status
    lease.status = this.checkStatus(lease).finally(() => { lease.status = undefined })
    return lease.status
  }

  async externalUrl(ownerId: number, id: unknown): Promise<{ ok: true; url: string } | IpcFail> {
    const found = this.owned(ownerId, id)
    if (!('id' in found)) return found
    try {
      await this.assertSession(found)
      await readPreviewFile(found.root, found.directory, found.entry)
      await this.assertSession(found)
      if (!this.current(found)) return ipcFail(IpcErrorCode.Conflict, '项目或预览已变化，请重新打开。')
      return { ok: true, url: `http://${found.host}/${found.capability}/${encodeURIComponent(basename(found.entry))}` }
    } catch (error) { return failure(error) }
  }

  /** Final synchronous source/window fence after asynchronous external URL validation. */
  ownsCurrent(ownerId: number, id: unknown): boolean {
    return 'id' in this.owned(ownerId, id)
  }

  close(ownerId: number, id: unknown): CloseResult {
    if (!validId(id)) return ipcFail(IpcErrorCode.InvalidArg, '预览 ID 无效。')
    const lease = this.leases.get(id)
    if (!lease) return { ok: true }
    if (lease.owner.id !== ownerId) return ipcFail(IpcErrorCode.Denied, '此预览不属于当前窗口。')
    this.release(lease)
    return { ok: true }
  }

  closeOwner(ownerId: number): void {
    for (const lease of this.leases.values()) if (lease.owner.id === ownerId) this.release(lease)
  }

  /** Synchronous Electron navigation fence; HTTP independently rechecks session and filesystem ownership. */
  navigationLease(ownerId: number, value: string): string | null {
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' || url.username || url.password || url.hostname !== '127.0.0.1') return null
      for (const lease of this.leases.values()) {
        if (lease.owner.id !== ownerId || !this.current(lease) || url.host !== lease.host || !url.pathname.startsWith(`/${lease.capability}/`)) continue
        resourcePath(lease.directory, url.pathname.slice(lease.capability.length + 2).split('/').map(segment => decodeURIComponent(segment)))
        return lease.id
      }
    } catch { /* Malformed/unsafe destinations never grant navigation. */ }
    return null
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.sweep)
    for (const lease of this.leases.values()) this.release(lease)
  }

  private current(lease: Lease): boolean {
    const project = this.deps.getProject(lease.session.sessionId)
    return !lease.closed && !this.disposed && lease.owner.isCurrent() && project.root === lease.root && project.generation === lease.generation &&
      Date.now() - lease.accessedAt < IDLE_MS && Date.now() - lease.createdAt < LIFETIME_MS
  }

  private async assertSession(lease: Lease): Promise<void> {
    if (!this.current(lease)) throw new PreviewError(IpcErrorCode.Conflict, '项目或预览窗口已变化。')
    const latest = await this.deps.readSession(lease.root, lease.session.sessionId)
    if (!this.current(lease) || !latest.ok || latest.session.engine !== 'pi' || latest.session.sessionId !== lease.session.sessionId ||
      !samePath(latest.session.projectRoot, lease.root) || !samePath(latest.session.cwd ?? lease.root, lease.cwd) ||
      latest.session.connectionGeneration !== lease.session.connectionGeneration) {
      this.release(lease)
      throw new PreviewError(IpcErrorCode.Conflict, '项目或 Pi 会话连接已变化，请重新打开预览。')
    }
  }

  private owned(ownerId: number, id: unknown): Lease | IpcFail {
    if (!validId(id)) return ipcFail(IpcErrorCode.InvalidArg, '预览 ID 无效。')
    const lease = this.leases.get(id)
    if (!lease) return ipcFail(IpcErrorCode.NotFound, '预览已关闭，请重新打开。')
    if (lease.owner.id !== ownerId) return ipcFail(IpcErrorCode.Denied, '此预览不属于当前窗口。')
    if (!this.current(lease)) { this.release(lease); return ipcFail(IpcErrorCode.Conflict, '预览已失效，请重新打开。') }
    return lease
  }

  private remember(lease: Lease, path: string, file: TrackedFile): void {
    const old = lease.files.get(path)
    if (old && old.observation > file.observation) return
    if (!old && lease.files.size >= MAX_FILES) throw new PreviewError(IpcErrorCode.Busy, '预览资源数量超过上限。')
    const total = [...lease.files.values()].reduce((sum, item) => sum + item.size, 0) - (old?.size ?? 0) + file.size
    if (total > MAX_TRACKED_BYTES) throw new PreviewError(IpcErrorCode.Busy, '预览资源总大小超过 64 MiB 上限。')
    lease.files.set(path, file)
    // Adding a first-seen resource establishes a baseline; it must not trigger a reload loop.
    if (old && old.hash !== file.hash) lease.revision = digest(`${lease.revision}\0${relative(lease.directory, path)}\0${file.hash}`)
  }

  private async checkStatus(lease: Lease): Promise<PiWebPreviewStatusResult> {
    try {
      await this.assertSession(lease)
      for (const path of [...lease.files.keys()].sort()) {
        const observation = ++lease.observation
        let file: TrackedFile
        try {
          const result = await readPreviewFile(lease.root, lease.directory, path)
          file = { hash: digest(result.bytes), size: result.bytes.length, observation }
        } catch (error) {
          if (path === lease.entry) throw error
          file = { hash: 'unavailable', size: 0, observation }
        }
        if (!this.current(lease)) throw new PreviewError(IpcErrorCode.Conflict, '预览已失效。')
        this.remember(lease, path, file)
      }
      await this.assertSession(lease)
      lease.accessedAt = Date.now()
      return { ok: true, revision: lease.revision }
    } catch (error) { this.release(lease); return failure(error) }
  }

  private headers(lease: Lease): Record<string, string> {
    const base = `http://${lease.host}/${lease.capability}/`
    return {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=()',
      // Opaque sandbox origins cannot rely on CSP self for modules, fonts or fetch.
      'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' ${base}; style-src 'unsafe-inline' ${base}; img-src ${base} data: blob:; font-src ${base} data:; connect-src ${base}; worker-src ${base} blob:; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`
    }
  }

  private async serve(lease: Lease, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const headers = this.headers(lease)
    const reject = (status: number): void => { response.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('Preview unavailable') }
    if (!this.current(lease)) { this.release(lease); reject(410); return }
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== lease.host ||
      request.headers.origin !== undefined && request.headers.origin !== 'null') { reject(403); return }
    const raw = request.url ?? ''
    if (raw.length > 8192 || !raw.startsWith(`/${lease.capability}/`)) { reject(404); return }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '')) { reject(405); return }
    if (this.requests >= MAX_REQUESTS || lease.requests >= MAX_LEASE_REQUESTS) { reject(429); return }
    this.requests += 1
    lease.requests += 1
    let counted = true
    const finished = (): void => {
      if (!counted) return
      counted = false
      this.requests -= 1
      lease.requests -= 1
    }
    response.once('finish', finished)
    response.once('close', finished)
    response.on('error', () => response.destroy())
    response.setTimeout(10000, () => response.destroy())
    let path: string | undefined
    let observation = 0
    try {
      const rawPath = raw.split('?')[0].slice(lease.capability.length + 2)
      const segments = rawPath.split('/').map(segment => decodeURIComponent(segment))
      path = resourcePath(lease.directory, segments)
      observation = ++lease.observation
      await this.assertSession(lease)
      const file = await readPreviewFile(lease.root, lease.directory, path)
      await this.assertSession(lease)
      if (!this.current(lease)) { reject(410); return }
      this.remember(lease, path, { hash: digest(file.bytes), size: file.bytes.length, observation })
      lease.accessedAt = Date.now()
      if (request.method === 'OPTIONS') { response.writeHead(204, headers).end(); return }
      response.writeHead(200, { ...headers, 'Content-Type': file.mime, 'Content-Length': file.bytes.length })
      response.end(request.method === 'HEAD' ? undefined : file.bytes)
    } catch (error) {
      let result = failure(error)
      if (result.code === IpcErrorCode.NotFound && path && this.current(lease)) {
        try {
          await this.assertSession(lease)
          this.remember(lease, path, { hash: 'unavailable', size: 0, observation })
        } catch (trackingError) { result = failure(trackingError) }
      }
      reject(result.code === IpcErrorCode.NotFound ? 404 : result.code === IpcErrorCode.Busy ? 429 : result.code === IpcErrorCode.Conflict ? 409 : 403)
    }
  }

  private release(lease: Lease): void {
    if (lease.closed) return
    lease.closed = true
    this.leases.delete(lease.id)
    for (const socket of lease.sockets) socket.destroy()
    lease.sockets.clear()
    lease.files.clear()
    clearPreviewMetadata(lease.root)
    lease.server.close()
  }
}
