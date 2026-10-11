/**
 * 文档服务（S0 G2 地基）：限界读取、revision、定向失效与解析数据层；
 * G2 第二片增加行级版本比较（jsdiff worker）与 Git 最近提交基线。
 * 详见 controller.ts / parse.ts / paths.ts / diff-service.ts / git-baseline.ts 头注与 design.md §5.1/§5.2/§6.2。
 */
export {
  MAX_DOCUMENT_READ_RETRIES,
  clearDocumentCache,
  computeRevision,
  invalidateDocument,
  readDocument
} from './controller'
export { parseContextManifest, parseTaskJsonText } from './parse'
export { PANEL_RUNTIME_PATH_RE, isPanelRuntimePath, resolveAuthorizedDocumentPath } from './paths'
export {
  clearReaderDocuments,
  onReaderDocumentChanged,
  routeReaderDocumentChange,
  unwatchReaderDocument,
  watchReaderDocument,
  READER_SETTLE_MS_ENV
} from './change-bridge'
export { computeDocumentDiff, stopDiffWorker, DIFF_WORKER_FILE_ENV, type DiffComputeOverrides } from './diff-service'
// 注意：不要从本入口 re-export diff-worker 的运行时值——diff-worker 是独立 rollup 入口，
// 若进入 index 依赖图，rollup 会让 worker 产物 require 主 bundle（worker 线程内加载 electron 即崩）。
// 其纯函数（computeUnifiedDiff/sanitizeDiffLine）由冒烟直接从 diff-worker.ts 引用。
export { latestCommitBaseline, headShortCommit, type GitBaseline, type GitBaselineFailureStatus } from './git-baseline'
