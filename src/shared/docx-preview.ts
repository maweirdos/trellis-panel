/** Only these bounded codes cross the isolated DOCX preview bridge. */
export const DOCX_PREVIEW_ERRORS = {
  'input-limit': 'DOCX 超过 8 MiB 预览大小上限，请使用系统打开。',
  'entry-count-limit': 'DOCX 包含超过 512 个文件条目，请使用系统打开。',
  'entry-size-limit': 'DOCX 中单个文件解压后超过 6 MiB，请使用系统打开。',
  'archive-size-limit': 'DOCX 解压后总大小超过 24 MiB，请使用系统打开。',
  'html-size-limit': 'DOCX 转换结果超过 2 MiB 预览上限，请使用系统打开。',
  'node-count-limit': 'DOCX 内容结构超过 20000 个节点，请使用系统打开。',
  'text-size-limit': 'DOCX 文本超过预览长度上限，请使用系统打开。',
  'output-size-limit': 'DOCX 预览内容超过 2 MiB 上限，请使用系统打开。',
  'invalid-document': '无法预览此 DOCX，请使用系统打开。'
} as const
export type DocxPreviewErrorCode = keyof typeof DOCX_PREVIEW_ERRORS
export function isDocxPreviewErrorCode(value: unknown): value is DocxPreviewErrorCode {
  return typeof value === 'string' && Object.hasOwn(DOCX_PREVIEW_ERRORS, value)
}
export class DocxPreviewLimitError extends Error {
  constructor(readonly code: DocxPreviewErrorCode) { super(DOCX_PREVIEW_ERRORS[code]) }
}
