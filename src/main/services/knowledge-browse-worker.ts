import { parentPort } from 'node:worker_threads'
import { kbBrowse, kbBrowseIndex, kbSearch, type KbBrowseIndex } from './knowledge'
import type { KbBrowseInput, KbLibrary, KbSearchScope } from '../../shared/types'

type BrowseRequest = { requestId: number; root: string; generation: number; kind?: 'browse'; input: KbBrowseInput } | { requestId: number; root: string; generation: number; kind: 'search'; library: KbLibrary | 'all'; query: string; scope: KbSearchScope }
let cached: { key: string; index: KbBrowseIndex } | undefined
const SNAPSHOT_TTL_MS = 15_000
parentPort?.on('message', (request: BrowseRequest) => {
  try {
    if (request.kind === 'search') {
      parentPort?.postMessage({ requestId: request.requestId, ok: true, result: kbSearch(request.root, request.library, request.query, request.scope) })
      return
    }
    const key = JSON.stringify([request.root, request.generation, request.input.library ?? 'all'])
    if (request.input.forceRefresh || !cached || cached.key !== key || Date.now() - cached.index.snapshotAt >= SNAPSHOT_TTL_MS) {
      cached = { key, index: kbBrowseIndex(request.root, request.input.library ?? 'all') }
    }
    parentPort?.postMessage({ requestId: request.requestId, ok: true, result: kbBrowse(request.root, request.input, cached.index) })
  } catch (error) {
    parentPort?.postMessage({ requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : '本地知识扫描失败' })
  }
})
