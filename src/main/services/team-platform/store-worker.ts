import { parentPort } from 'node:worker_threads'
import { z } from 'zod'
import { DesktopTeamStoreCore } from './store-core'
import { DesktopTeamError, MAX_RPC_BYTES, type WorkerRequest, type WorkerResponse } from './types'
const port = parentPort
if (!port) throw new Error('Team desktop writer needs its owned worker port')
let core: DesktopTeamStoreCore | null = null
port.on('message', (raw: WorkerRequest) => {
  const requestId = Number.isSafeInteger(raw?.requestId) ? raw.requestId : -1
  let response: WorkerResponse
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_RPC_BYTES) throw new DesktopTeamError('CAPACITY_EXCEEDED', '团队存储请求超过限界')
    const request = z.object({ requestId: z.number().int().positive(), op: z.string().max(100), input: z.unknown().optional() }).strict().parse(raw)
    let value: unknown
    if (request.op === 'init') {
      if (core) throw new DesktopTeamError('STORE_CONFLICT', '团队写入器已初始化')
      const input = z.object({ dataDir: z.string().min(1).max(8192) }).strict().parse(request.input)
      core = new DesktopTeamStoreCore(input.dataDir); value = core.dispatch({ op: 'health' })
    } else if (request.op === 'close') { core?.close(); core = null; value = null }
    else { if (!core) throw new DesktopTeamError('STORE_UNAVAILABLE', '团队写入器尚未就绪'); value = core.dispatch(request) }
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_RPC_BYTES) throw new DesktopTeamError('CAPACITY_EXCEEDED', '团队存储响应超过限界')
    response = { requestId, ok: true, value }
  } catch (error) {
    response = { requestId, ok: false, code: error instanceof DesktopTeamError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'STORE_UNAVAILABLE', error: error instanceof DesktopTeamError ? error.message : error instanceof z.ZodError ? '团队存储数据未通过验证' : '团队本地存储不可用，原记录已保留' }
  }
  port.postMessage(response)
})
