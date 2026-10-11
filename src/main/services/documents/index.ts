/**
 * 文档服务（S0 G2 地基）：限界读取、revision、定向失效与解析数据层。
 * 详见 controller.ts / parse.ts / paths.ts 头注与 design.md §5.1/§5.2。
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
