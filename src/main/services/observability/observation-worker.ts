import { parentPort } from 'node:worker_threads'
import {
  ObservationStoreCore,
  type StoreBindingContext,
  type StoreLimits,
  type StoreQueryRequest,
  type VerifyAliasesInput
} from './store-core'

/**
 * 观测存储 worker 入口（S0 G3 第一片，参照 diff-worker 模式）：
 * 专用 worker 线程承担全部同步 SQLite 调用，主进程不跑长事务（design §4.1）。
 *
 * 消息协议：请求-响应，requestId 关联；不主动推送（订阅轮询在主进程服务层）。
 * worker 侧不 import electron；本文件经 electron.vite.config.ts 单独 esbuild 打包
 * 为 out/main/observation-worker.js（CJS，邻位定位），冒烟可用
 * TRELLIS_OBSERVATION_WORKER_FILE 指定 ESM 产物。
 */

export interface ObservationWorkerInit {
  runtimeDir: string
  binding: StoreBindingContext | null
  /** 冒烟/试验用限额覆盖（生产走 design §4.3 默认值）。 */
  limits?: Partial<StoreLimits>
}

export type ObservationWorkerRequest =
  | { requestId: number; op: 'init'; args: ObservationWorkerInit }
  | { requestId: number; op: 'insert'; args: { event: unknown; receivedAtMs: number } }
  | {
      requestId: number
      op: 'query'
      args: { scope: { workspaceId: string; taskRef?: string }; request: StoreQueryRequest }
    }
  | { requestId: number; op: 'health'; args: null }
  | { requestId: number; op: 'cleanup'; args: null }
  | { requestId: number; op: 'clearAll'; args: null }
  | { requestId: number; op: 'rebuild'; args: null }
  | { requestId: number; op: 'close'; args: null }
  | { requestId: number; op: 'reopen'; args: null }
  | { requestId: number; op: 'recordAlias'; args: { taskRef: string; trellisTaskId: string | null; dir: string } }
  | { requestId: number; op: 'verifyAliases'; args: { known: VerifyAliasesInput[] } }
  | { requestId: number; op: 'listAliases'; args: null }
  | { requestId: number; op: 'diagnostics'; args: null }

export type ObservationWorkerResponse =
  | { requestId: number; ok: true; result: unknown }
  | { requestId: number; ok: false; error: string }

/** 核心实例句柄（worker 线程内单例；导出仅供冒烟直接驱动消息处理）。 */
let core: ObservationStoreCore | null = null

export function handleWorkerMessage(msg: ObservationWorkerRequest): unknown {
  switch (msg.op) {
    case 'init': {
      const { runtimeDir, binding, limits } = msg.args
      // 重复 init（如重新绑定后换门禁）：先收口旧实例连接再重建
      if (core !== null) {
        try {
          core.close()
        } catch {
          /* best-effort */
        }
      }
      core = new ObservationStoreCore(runtimeDir, limits ?? {})
      core.setBinding(binding)
      core.open()
      return core.health()
    }
    case 'insert': {
      if (core === null) throw new Error('store not initialized')
      return core.insertEvent(msg.args.event, msg.args.receivedAtMs)
    }
    case 'query': {
      if (core === null) throw new Error('store not initialized')
      // 一次往返带回 health（shared ObservationQuerySuccess 口径；库未打开时 health 由服务层兜底）
      return { ...core.queryEvents(msg.args.scope, msg.args.request), health: core.health() }
    }
    case 'health':
      return core === null
        ? { state: 'not_initialized', pauseReason: null, dbVersion: null, storeEpoch: null, logicalCount: 0, logicalPayloadBytes: 0, physicalBytes: 0, controlState: 'not_initialized' }
        : core.health()
    case 'cleanup': {
      if (core === null) throw new Error('store not initialized')
      return core.cleanupRetention()
    }
    case 'clearAll': {
      if (core === null) throw new Error('store not initialized')
      return core.clearAllObservations()
    }
    case 'rebuild': {
      if (core === null) throw new Error('store not initialized')
      return core.rebuildObservations()
    }
    case 'close': {
      core?.close()
      return { closed: true }
    }
    case 'reopen': {
      if (core === null) throw new Error('store not initialized')
      core.close()
      core.open()
      return core.health()
    }
    case 'recordAlias': {
      if (core === null) throw new Error('store not initialized')
      return core.recordTaskAlias(msg.args.taskRef, msg.args.trellisTaskId, msg.args.dir)
    }
    case 'verifyAliases': {
      if (core === null) throw new Error('store not initialized')
      return core.verifyTaskAliases(msg.args.known)
    }
    case 'listAliases': {
      if (core === null) throw new Error('store not initialized')
      return core.listTaskAliases()
    }
    case 'diagnostics': {
      if (core === null) throw new Error('store not initialized')
      return core.listDiagnostics()
    }
    default:
      throw new Error(`unknown op: ${(msg as { op?: unknown }).op}`)
  }
}

/* 线程消息循环（仅 worker 线程内激活；主线程 import 无副作用，冒烟可直接调 handleWorkerMessage） */
if (parentPort !== null) {
  parentPort.on('message', (msg: ObservationWorkerRequest) => {
    let response: ObservationWorkerResponse
    try {
      response = { requestId: msg.requestId, ok: true, result: handleWorkerMessage(msg) }
    } catch (e) {
      response = {
        requestId: msg.requestId,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      }
    }
    parentPort?.postMessage(response)
  })
}
