import { EventEmitter } from 'node:events'

import {
  ACP_PROTOCOL_ERROR_CODES,
  ACP_V2_METHODS,
  cancelRequestParamsSchema,
  cancelSessionSchema,
  clientNotificationSchemas,
  clientRequestSchemas,
  type AcpClientNotification,
  type AcpClientRequest,
  type AcpWireMessage,
} from './contract'
import { AcpProtocolError } from './errors'

export type WireStream = {
  readonly input: NodeJS.ReadableStream
  readonly output: NodeJS.WritableStream
}

export type WireRequest = {
  readonly id: string | number
  readonly method: string
  readonly params?: unknown
}

export type WireLimits = {
  readonly maxMessageBytes: number
  readonly requestTimeoutMs: number
  readonly maxPendingRequests: number
}

type PendingRequest = {
  readonly id: string | number
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: AcpProtocolError) => void
  readonly timer: NodeJS.Timeout
}

export class AcpJsonRpcWire extends EventEmitter {
  private static nextNumericId = 1

  private readonly pending = new Map<string | number, PendingRequest>()
  private readonly usedIds = new Set<string | number>()
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private buffer = ''
  private closed = false

  constructor(
    private readonly stream: WireStream,
    private readonly limits: WireLimits = {
      maxMessageBytes: 1024 * 1024,
      requestTimeoutMs: 15_000,
      maxPendingRequests: 64,
    },
  ) {
    super()
    this.stream.input.on('data', (chunk: Buffer | string) => this.receive(chunk))
    this.stream.input.resume()
    this.stream.input.on('error', (cause: Error) => this.close(new AcpProtocolError('E_DISCONNECTED', 'ACP input stream failed', { cause })))
    this.stream.input.on('close', () => this.close(new AcpProtocolError('E_DISCONNECTED', 'ACP input stream disconnected')))
    this.stream.input.on('end', () => this.close(new AcpProtocolError('E_DISCONNECTED', 'ACP input stream disconnected')))
    this.stream.output.on('error', (cause: Error) => this.close(new AcpProtocolError('E_DISCONNECTED', 'ACP output stream failed', { cause })))
  }

  onRequest(listener: (request: WireRequest) => void): this {
    return super.on('request', listener)
  }

  onNotification(listener: (notification: { readonly method: string; readonly params?: unknown }) => void): this {
    return super.on('notification', listener)
  }

  onClose(listener: (error: AcpProtocolError) => void): this {
    return super.on('close', listener)
  }

  request<T = unknown>({ method, params, id }: Omit<WireRequest, 'id'> & { readonly id?: string | number }): Promise<T> {
    this.assertNotClosed(method)
    if (this.pending.size >= this.limits.maxPendingRequests) throw new AcpProtocolError('E_PROTOCOL', 'ACP request capacity exceeded', { method })
    const requestId = id ?? AcpJsonRpcWire.nextNumericId++
    if (this.usedIds.has(requestId)) throw new AcpProtocolError('E_DUPLICATE_REQUEST_ID', 'ACP request ID was already used', { method, requestId })
    this.usedIds.add(requestId)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pendingRequest = this.pending.get(requestId)
        this.pending.delete(requestId)
        this.notify(ACP_V2_METHODS.protocolCancelRequest, { id: requestId })
          .then(() => {
            reject(new AcpProtocolError('E_TIMEOUT', `ACP request timed out after ${this.limits.requestTimeoutMs}ms: ${method}`, { method, requestId }))
            this.closeIfIdle()
          })
          .catch(() => {
            reject(new AcpProtocolError('E_TIMEOUT', `ACP request timed out after ${this.limits.requestTimeoutMs}ms: ${method}`, { method, requestId }))
            this.closeIfIdle()
          })
      }, this.limits.requestTimeoutMs)
      this.pending.set(requestId, { id: requestId, method, resolve: resolve as (result: unknown) => void, reject, timer })
      this.write({ jsonrpc: '2.0', id: requestId, method, params }).catch(() => undefined)
    })
  }

  notify(method: string, params?: unknown): Promise<void> {
    this.assertNotClosed(method)
    if (method === ACP_V2_METHODS.sessionCancel || method === ACP_V2_METHODS.protocolCancelRequest) {
      const schema = method === ACP_V2_METHODS.sessionCancel ? cancelSessionSchema : cancelRequestParamsSchema
      const parsed = schema.safeParse(params)
      if (!parsed.success) return Promise.reject(new AcpProtocolError('E_PROTOCOL', `ACP v2 notification is invalid: ${method}`, { method, cause: parsed.error }))
    }
    return this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: string | number, result: unknown): Promise<void> {
    this.assertNotClosed('response')
    return this.write({ jsonrpc: '2.0', id, result })
  }

  respondWithError(id: string | number, code: number, message: string, data?: unknown): Promise<void> {
    this.assertNotClosed('response')
    return this.write({ jsonrpc: '2.0', id, error: { code, message, data } })
  }

  cancel(method: string, requestId?: string | number): void {
    const targetId = requestId ?? [...this.pending.values()].find((pending) => pending.method === method)?.id
    if (targetId === undefined) return
    const pendingRequest = this.pending.get(targetId)
    if (pendingRequest === undefined || pendingRequest.method !== method) return
    this.pending.delete(targetId)
    clearTimeout(pendingRequest.timer)
    pendingRequest.reject(new AcpProtocolError('E_CANCELLED', `ACP request was cancelled: ${method}`, { method, requestId: targetId }))
  }

  close(error: AcpProtocolError = new AcpProtocolError('E_CLOSED', 'ACP wire was closed')): void {
    if (this.closed) return
    this.closed = true
    this.buffer = ''
    for (const pendingRequest of [...this.pending.values()]) {
      clearTimeout(pendingRequest.timer)
      pendingRequest.reject(new AcpProtocolError('E_DISCONNECTED', `ACP request failed on disconnect: ${pendingRequest.method}`, {
        method: pendingRequest.method,
        requestId: pendingRequest.id,
        cause: error,
      }))
    }
    this.pending.clear()
    this.emit('close', error)
  }

  private receive(chunk: Buffer | string): void {
    if (this.closed) return
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const frame = this.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (frame.length > 0) this.receiveFrame(frame)
      newlineIndex = this.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.limits.maxMessageBytes) {
      this.close(new AcpProtocolError('E_MESSAGE_TOO_LARGE', `ACP frame exceeds ${this.limits.maxMessageBytes} bytes`, {
        maxMessageBytes: this.limits.maxMessageBytes,
      }))
    }
  }

  private receiveFrame(frame: string): void {
    if (Buffer.byteLength(frame, 'utf8') > this.limits.maxMessageBytes) {
      this.close(new AcpProtocolError('E_MESSAGE_TOO_LARGE', `ACP frame exceeds ${this.limits.maxMessageBytes} bytes`, {
        maxMessageBytes: this.limits.maxMessageBytes,
      }))
      return
    }
    let message: unknown
    try {
      message = JSON.parse(frame)
    } catch (cause) {
      this.close(new AcpProtocolError('E_MALFORMED_FRAME', 'ACP frame is not valid JSON', { cause }))
      return
    }
    const parsed = this.validateMessage(message)
    if (parsed === undefined) return
    if ('method' in parsed) {
      if ('id' in parsed) this.emit('request', { id: parsed.id, method: parsed.method, params: parsed.params })
      else this.emit('notification', { method: parsed.method, params: parsed.params })
      return
    }
    const pendingRequest = this.pending.get(parsed.id)
    if (pendingRequest === undefined) return
    this.pending.delete(parsed.id)
    clearTimeout(pendingRequest.timer)
    const remoteError = parsed.error
    if (remoteError !== undefined && typeof remoteError.message === 'string') pendingRequest.reject(new AcpProtocolError('E_REMOTE', remoteError.message, {
      method: pendingRequest.method,
      requestId: pendingRequest.id,
      code: remoteError.code,
      cause: parsed.error,
    }))
    else pendingRequest.resolve(parsed.result)
  }

  private validateMessage(message: unknown): AcpWireMessage | undefined {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return this.rejectInvalidFrame('ACP frame is not a JSON-RPC object')
    const candidate = message as Record<string, unknown>
    if (candidate.jsonrpc !== '2.0') return this.rejectInvalidFrame('ACP frame is not JSON-RPC 2.0')
    const hasId = Object.prototype.hasOwnProperty.call(candidate, 'id')
    const validId = typeof candidate.id === 'string' || typeof candidate.id === 'number' && Number.isInteger(candidate.id)
    if (hasId && !validId) return this.rejectInvalidFrame('ACP JSON-RPC ID is invalid')
    if (typeof candidate.method === 'string') {
      if (!hasId && (candidate.result !== undefined || candidate.error !== undefined)) return this.rejectInvalidFrame('ACP JSON-RPC notification cannot be a response')
      return candidate as unknown as AcpWireMessage
    }
    if (!hasId) return this.rejectInvalidFrame('ACP JSON-RPC response lacks an ID')
    if (candidate.result === undefined && candidate.error === undefined) return this.rejectInvalidFrame('ACP JSON-RPC response lacks result and error')
    if (candidate.result !== undefined && candidate.error !== undefined) return this.rejectInvalidFrame('ACP JSON-RPC response has both result and error')
    const error = candidate.error
    if (error !== undefined) {
      const invalidError = typeof error !== 'object' || error === null || Array.isArray(error)
        || typeof (error as Record<string, unknown>).code !== 'number'
        || typeof (error as Record<string, unknown>).message !== 'string'
      if (invalidError) return this.rejectInvalidFrame('ACP JSON-RPC error is invalid')
    }
    return candidate as unknown as AcpWireMessage
  }

  private rejectInvalidFrame(message: string): undefined {
    this.close(new AcpProtocolError('E_MALFORMED_FRAME', message))
    return undefined
  }

  private write(message: AcpWireMessage): Promise<void> {
    const frame = JSON.stringify(message)
    const frameBytes = Buffer.byteLength(frame, 'utf8')
    if (frameBytes > this.limits.maxMessageBytes) {
      return Promise.reject(new AcpProtocolError('E_MESSAGE_TOO_LARGE', `ACP frame exceeds ${this.limits.maxMessageBytes} bytes`, {
        maxMessageBytes: this.limits.maxMessageBytes,
      }))
    }
    return new Promise((resolve, reject) => {
      const bytes = Buffer.concat([this.encoder.encode(`${frame}\n`), Buffer.alloc(0)])
      this.stream.output.write(bytes, (cause?: Error | null) => {
        if (cause === undefined || cause === null) resolve()
        else reject(new AcpProtocolError('E_DISCONNECTED', 'ACP frame write failed', { cause }))
      })
    })
  }

  private assertNotClosed(method: string): void {
    if (this.closed) throw new AcpProtocolError('E_CLOSED', `ACP wire is closed: ${method}`, { method })
  }

  private closeIfIdle(): void {
    if (this.pending.size === 0 && this.closed === false) {
      this.close(new AcpProtocolError('E_CLOSED', 'ACP wire became idle'))
    }
  }
}

export type WireClientRouter = {
  readonly onRequest?: (request: AcpClientRequest) => Promise<unknown>
  readonly onNotification?: (notification: AcpClientNotification) => void
}

const clientNotification = (method: string, params: unknown): AcpClientNotification | undefined => {
  const schema = clientNotificationSchemas[method as keyof typeof clientNotificationSchemas]
  if (schema === undefined) return undefined
  const parsed = schema.safeParse(params)
  if (!parsed.success) return undefined
  return { method, params: parsed.data } as AcpClientNotification
}

export const routeClientWire = (wire: AcpJsonRpcWire, router: WireClientRouter): void => {
  wire.onRequest(({ id, method, params }) => {
    void (async () => {
      if (method === ACP_V2_METHODS.clientRequestPermission || method === ACP_V2_METHODS.mcpMessage) {
        const schemas = clientRequestSchemas[method as keyof typeof clientRequestSchemas]
        if (router.onRequest === undefined || schemas === undefined) {
          await wire.respondWithError(id, ACP_PROTOCOL_ERROR_CODES.methodNotFound, `ACP client request routing is unavailable: ${method}`)
          return
        }
        const parsedParams = schemas.params.safeParse(params)
        if (!parsedParams.success) {
          await wire.respondWithError(id, ACP_PROTOCOL_ERROR_CODES.invalidParams, `Invalid ACP client request: ${method}`)
          return
        }
        const rawResponse = await router.onRequest({ method, params: parsedParams.data } as AcpClientRequest)
        const parsedResponse = schemas.result.safeParse(rawResponse)
        if (!parsedResponse.success) {
          await wire.respondWithError(id, ACP_PROTOCOL_ERROR_CODES.internalError, `Invalid ACP client response: ${method}`)
          return
        }
        await wire.respond(id, parsedResponse.data)
        return
      }
      await wire.respondWithError(id, ACP_PROTOCOL_ERROR_CODES.methodNotFound, `Unsupported ACP client request: ${method}`)
    })().catch(() => {
      void wire.respondWithError(id, ACP_PROTOCOL_ERROR_CODES.internalError, 'ACP client request failed').catch(() => undefined)
    })
  })
  wire.onNotification(({ method, params }) => {
    const notification = clientNotification(method, params)
    if (notification !== undefined) router.onNotification?.(notification)
  })
}

import type { UpdateSessionNotification } from '@agentclientprotocol/sdk/experimental/v2'
