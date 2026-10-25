import { parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { TeamStoreCore } from './store-core'
import { TeamServiceError } from './errors'
import type { StoreOptions, StoreRequest, StoreResponse } from './store-types'
import { TEAM_MAX_RESPONSE_BYTES } from '../../../src/shared/team-platform'

if (!parentPort) throw new Error('Team store must run in its owned worker')
const port = parentPort
const failure = (error: unknown): TeamServiceError => error instanceof TeamServiceError ? error : error instanceof z.ZodError ? new TeamServiceError('INVALID_INPUT', error.issues[0]?.message ?? 'Invalid team request') : new TeamServiceError('STORE_UNAVAILABLE', 'Team storage failed; retain original command identity for inspection', 503)
const core = (() => {
  try {
    const options = z.object({ dataDir: z.string(), issuer: z.string(), bootstrapSubject: z.string(), identityProvider: z.enum(['oidc', 'gitlab']).optional(), sessionTtlMs: z.number().positive(), pairingTtlMs: z.number().positive(), onlineTtlMs: z.number().positive() }).strict().parse(workerData) satisfies StoreOptions
    return new TeamStoreCore(options)
  } catch (error) {
    const value = failure(error)
    port.postMessage({ id: 0, ok: false, error: { code: value.code, message: value.message, statusCode: value.statusCode } } satisfies StoreResponse)
    port.close()
    return null
  }
})()
let queue: Promise<void> = Promise.resolve()
if (core) port.on('message', (request: StoreRequest) => {
  queue = queue.then(async () => {
    let response: StoreResponse
    try {
      const parsed = z.object({ id: z.number().int().positive(), operation: z.string().min(1).max(100), input: z.unknown() }).strict().parse(request)
      if (Buffer.byteLength(JSON.stringify(parsed)) > 2 * 1024 * 1024) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Writer request exceeds byte limit', 413)
      response = { id: parsed.id, ok: true, value: await core.dispatch(parsed.operation as StoreRequest['operation'], parsed.input) }
    } catch (error) {
      const value = failure(error)
      response = { id: request.id, ok: false, error: { code: value.code, message: value.message, statusCode: value.statusCode } }
    }
    if (Buffer.byteLength(JSON.stringify(response)) > TEAM_MAX_RESPONSE_BYTES) response = { id: request.id, ok: false, error: { code: 'CAPACITY_EXCEEDED', message: 'Writer response exceeds its bounded limit; retain original command identity', statusCode: 413 } }
    port.postMessage(response)
    if (request.operation === 'close' && response.ok) port.close()
  })
})
