import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { basename, extname, relative, sep } from 'path'
import {
  DOCUMENT_READ_LIMIT_BYTES,
  documentReadRequestSchema,
  documentReadScopeSchema,
  type DocumentDiagnostic,
  type DocumentReadOutcome,
  type DocumentReadSuccess,
  type DocumentSource
} from '../../../shared/documents'
import { IpcErrorCode, ipcFail } from '../../../shared/ipc-errors'
import { TEXT_EXTS } from '../scan'
import { resolveAuthorizedDocumentPath, realRootOf } from './paths'
import { parseContextManifest, parseTaskJsonText } from './parse'

/**
 * DocumentController（S0 G2 地基，design §5.1/§5.2）：
 * 限界读取 + 内容 revision + 坏文件/写入中有限重试 + 按 canonicalPath+revision 定向失效。
 *
 * - revision = 文件字节 sha256 前 16 hex（文档版本标识；完整观测摘要规则在 shared/observability）。
 * - 读取默认上限 5MiB，超限不装载全文，返回带实际大小与本机打开提示数据的诊断。
 * - 原地写入中的文件做有限稳定性重试（≤2 次、间隔短）：stat/read 失败、读取长度与
 *   stat 不符（torn read）或结构化解析失败都重读；重试后仍失败保留诊断
 *   （"文件暂不可读"/"解析失败"），由调用方保留旧版本内容。
 * - 缓存按 canonicalPath+revision 定向失效，不依赖 task 对象引用变化；
 *   缓存条目数有界，不无界缓存全文。
 */

/** 原地写入稳定性的有限重试上限（design §5.2：有限重试 ≤2 次）。 */
export const MAX_DOCUMENT_READ_RETRIES = 2
const RETRY_DELAY_MS = 40
/** 有界缓存：超出后按插入序淘汰最旧条目（不无界缓存全文）。 */
const CACHE_MAX_ENTRIES = 16

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/** 文件字节的前 16 hex 摘要，作为文档 revision 标识。 */
export function computeRevision(buf: Buffer): string {
  return sha256Hex(buf).slice(0, 16)
}

interface CacheEntry {
  revision: string
  /** 与 revision 对应的成功载荷（不含 requestId，按请求回填）。 */
  payload: Omit<DocumentReadSuccess, 'ok' | 'requestId'>
}

const cache = new Map<string, CacheEntry>()

const cacheKey = (workspaceId: string, taskRef: string | null, canonicalPath: string): string =>
  `${workspaceId}::${taskRef ?? ''}::${canonicalPath}`

function cacheStore(key: string, entry: CacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * 定向失效（design §5.2）：按 canonicalPath（+可选 revision）失效缓存。
 * 给出 revision 时只失效该版本；不给时失效该路径全部缓存条目。
 * 返回是否实际移除了条目。
 */
export function invalidateDocument(canonicalPath: string, revision?: string): boolean {
  let removed = false
  for (const [key, entry] of cache) {
    if (!key.endsWith(`::${canonicalPath}`)) continue
    if (revision !== undefined && entry.revision !== revision) continue
    cache.delete(key)
    removed = true
  }
  return removed
}

export function clearDocumentCache(): void {
  cache.clear()
}

function sourceOf(
  root: string,
  canonicalPath: string,
  sizeBytes: number | null,
  mtimeMs: number | null,
  workspaceId: string,
  taskRef: string | null
): DocumentSource {
  let relativePath = relative(root, canonicalPath)
  if (sep !== '/') relativePath = relativePath.split(sep).join('/')
  return { relativePath, canonicalPath, sizeBytes, mtimeMs, workspaceId, taskRef }
}

const retriedDiagnostic = (attempts: number): DocumentDiagnostic => ({
  code: 'read_retried',
  severity: 'neutral',
  message: `读取期间文件在变化，重读 ${attempts - 1} 次后取得稳定版本`,
  data: { attempts }
})

/**
 * 读取一个文档。scope/input 未通过校验或路径越界 → ipcFail（请求级失败）；
 * 文档级事实（缺失/暂不可读/超限/解析失败/坏行）→ ok:true + 诊断。
 */
export async function readDocument(root: string, scope: unknown, input: unknown): Promise<DocumentReadOutcome> {
  const scopeParsed = documentReadScopeSchema.safeParse(scope ?? {})
  if (scopeParsed.success === false) {
    return ipcFail(IpcErrorCode.InvalidArg, 'documentRead scope 非法：workspaceId 必填且为非空字符串')
  }
  const reqParsed = documentReadRequestSchema.safeParse(input ?? {})
  if (reqParsed.success === false) {
    const first = reqParsed.error.issues[0]?.message ?? '参数不合法'
    return ipcFail(IpcErrorCode.InvalidArg, `documentRead 参数非法：${first}`)
  }
  const { workspaceId, taskRef } = scopeParsed.data
  const { relativePath, requestId } = reqParsed.data

  const auth = resolveAuthorizedDocumentPath(root, relativePath)
  if (!auth.ok) return ipcFail(IpcErrorCode.InvalidArg, '路径超出已打开工作区范围（含软链接逃逸拒绝）')
  const { canonicalPath } = auth
  /** 条目可读性与 relativePath 都以 realpath 后的项目根为基准，避免根路径含软链/大小写歧义。 */
  const realRoot = realRootOf(root)

  const ext = extname(canonicalPath).toLowerCase()
  if (auth.exists && !TEXT_EXTS.has(ext)) {
    return ipcFail(IpcErrorCode.InvalidArg, `不支持的文件类型 ${ext || '(无扩展名)'}`)
  }
  const key = cacheKey(workspaceId, taskRef ?? null, canonicalPath)

  let attempt = 0
  /** 只保留 errno（如 EPERM/EBUSY）；fs message 含本机绝对路径，不进 wire 契约。 */
  let lastErrorCode: string = 'UNKNOWN'
  /** 读取不稳定（torn/read-error）次数——与解析失败分开计数。 */
  let unstableReads = 0

  while (attempt <= MAX_DOCUMENT_READ_RETRIES) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS)
    attempt += 1
    try {
      const st = statSync(canonicalPath)
      if (st.isDirectory()) {
        return {
          ok: true,
          requestId,
          revision: null,
          rawText: null,
          parsed: null,
          diagnostics: [
            { code: 'not_a_file', severity: 'warning', message: '目标是目录，不是可读文档', data: { relativePath } }
          ],
          source: sourceOf(realRoot, canonicalPath, null, st.mtimeMs, workspaceId, taskRef ?? null)
        }
      }
      if (st.size > DOCUMENT_READ_LIMIT_BYTES) {
        return {
          ok: true,
          requestId,
          revision: null,
          rawText: null,
          parsed: null,
          diagnostics: [
            {
              code: 'document_too_large',
              severity: 'warning',
              message: `文件 ${(st.size / 1024 / 1024).toFixed(1)}MiB 超过读取上限 ${DOCUMENT_READ_LIMIT_BYTES / 1024 / 1024}MiB，未装载全文；可在本机编辑器打开查看`,
              data: {
                sizeBytes: st.size,
                limitBytes: DOCUMENT_READ_LIMIT_BYTES,
                /** UI 据此提供"在本机打开"入口（shell.openInEditor）。 */
                openLocally: true
              }
            }
          ],
          source: sourceOf(realRoot, canonicalPath, st.size, st.mtimeMs, workspaceId, taskRef ?? null)
        }
      }
      const buf = readFileSync(canonicalPath)
      if (buf.byteLength !== st.size) {
        // 原地写入中：读到的是撕裂版本，短间隔后重读
        unstableReads += 1
        continue
      }
      const revision = computeRevision(buf)
      const cached = cache.get(key)
      if (cached !== undefined && cached.revision === revision) {
        cacheStore(key, cached)
        const diagnostics =
          unstableReads > 0 ? [retriedDiagnostic(unstableReads + 1), ...cached.payload.diagnostics] : cached.payload.diagnostics
        return { ok: true, requestId, ...cached.payload, diagnostics }
      }

      let rawText = buf.toString('utf-8')
      if (rawText.charCodeAt(0) === 0xfeff) rawText = rawText.slice(1)
      const diagnostics: DocumentDiagnostic[] = []
      let parsed: DocumentReadSuccess['parsed'] = null
      const name = basename(canonicalPath).toLowerCase()
      if (name === 'task.json') {
        const r = parseTaskJsonText(rawText)
        if (r.parsed === null) {
          lastErrorCode = 'PARSE_FAILED'
          if (attempt <= MAX_DOCUMENT_READ_RETRIES) continue
          diagnostics.push({
            ...r.diagnostic,
            data: { ...r.diagnostic.data, attempts: MAX_DOCUMENT_READ_RETRIES }
          })
        } else {
          parsed = r.parsed
        }
      } else if (ext === '.jsonl') {
        const r = parseContextManifest(realRoot, rawText)
        parsed = r.parsed
        diagnostics.push(...r.diagnostics)
      }
      // read_retried 只描述"读取不稳定后重读成功"；解析失败由 parse_failed 自带尝试次数
      if (unstableReads > 0 && parsed !== null) diagnostics.unshift(retriedDiagnostic(unstableReads + 1))

      const payload: Omit<DocumentReadSuccess, 'ok' | 'requestId'> = {
        revision,
        rawText,
        parsed,
        diagnostics,
        source: sourceOf(realRoot, canonicalPath, st.size, st.mtimeMs, workspaceId, taskRef ?? null)
      }
      cacheStore(key, { revision, payload })
      return { ok: true, requestId, ...payload }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') {
        // 明确空态：文件尚未创建
        return {
          ok: true,
          requestId,
          revision: null,
          rawText: null,
          parsed: null,
          diagnostics: [
            { code: 'file_missing', severity: 'neutral', message: '文件尚未创建', data: { relativePath } }
          ],
          source: sourceOf(realRoot, canonicalPath, null, null, workspaceId, taskRef ?? null)
        }
      }
      unstableReads += 1
      lastErrorCode = code ?? 'UNKNOWN'
    }
  }

  // 读取重试耗尽（撕裂/IO 错误）：保留旧版本内容由调用方负责，这里给出诚实诊断。
  // （解析失败的终态在循环内返回：原文保留 + parse_failed 诊断。）
  return {
    ok: true,
    requestId,
    revision: null,
    rawText: null,
    parsed: null,
    diagnostics: [
      {
        code: 'file_unreadable',
        severity: 'warning',
        message: `文件暂不可读（已重试 ${attempt - 1} 次，可能正在写入），已保留调用方旧版本`,
        data: { attempts: attempt - 1, detail: lastErrorCode }
      }
    ],
    source: sourceOf(realRoot, canonicalPath, null, null, workspaceId, taskRef ?? null)
  }
}
