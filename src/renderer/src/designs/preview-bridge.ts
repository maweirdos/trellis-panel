import { designSelectionSchema, type DesignPage, type DesignSelection } from '@shared/design-workspace'
import { designGenerationPageIdSchema } from '@shared/design-generation'
import { DESIGN_PREVIEW_CHANNEL, type DesignPreviewIdentity } from './preview-runtime'

export interface DesignElementPick extends DesignSelection { canEditText: boolean; hasParent: boolean; path: string; previewNonce: string }
/** Point is in iframe CSS pixels; deltas are normalized input CSS pixels. */
export interface DesignPreviewWheel { x: number; y: number; deltaX: number; deltaY: number; zoom: boolean }
export type DesignPreviewMessage =
  | { type: 'ready' | 'clear' | 'back' | 'escape' }
  | { type: 'selection'; pick: DesignElementPick }
  | { type: 'navigate'; target: string }
  | { type: 'wheel'; wheel: DesignPreviewWheel }
  | { type: 'notice'; text: string }
  | { type: 'validated'; requestId: string; valid: boolean }
  | { type: 'restored'; requestId: string; status: 'located' | 'missing' | 'ambiguous' }

export function readDesignPreviewMessage(event: MessageEvent<unknown>, source: Window | null, identity: DesignPreviewIdentity, page: DesignPage, frameId: string): DesignPreviewMessage | null {
  if (!source || event.source !== source || event.origin !== 'null' || !event.data || typeof event.data !== 'object') return null
  const data = event.data as Record<string, unknown>
  if (identity.frameId !== frameId || page.id !== identity.pageId || data.channel !== DESIGN_PREVIEW_CHANNEL || data.documentId !== identity.documentId || data.pageId !== identity.pageId || data.frameId !== frameId || data.revision !== identity.revision || data.nonce !== identity.nonce) return null
  if (data.type === 'ready' || data.type === 'clear' || data.type === 'back' || data.type === 'escape') return { type: data.type }
  if (data.type === 'notice' && typeof data.text === 'string' && data.text.length <= 200) return { type: 'notice', text: data.text }
  if (data.type === 'navigate' && typeof data.target === 'string' && designGenerationPageIdSchema.safeParse(data.target).success) return { type: 'navigate', target: data.target }
  if (data.type === 'wheel' && typeof data.x === 'number' && Number.isFinite(data.x) && data.x >= 0 && data.x <= 16384 && typeof data.y === 'number' && Number.isFinite(data.y) && data.y >= 0 && data.y <= 16384 && typeof data.deltaX === 'number' && Number.isFinite(data.deltaX) && Math.abs(data.deltaX) <= 4096 && typeof data.deltaY === 'number' && Number.isFinite(data.deltaY) && Math.abs(data.deltaY) <= 4096 && typeof data.zoom === 'boolean') return { type: 'wheel', wheel: { x: data.x, y: data.y, deltaX: data.deltaX, deltaY: data.deltaY, zoom: data.zoom } }
  if (data.type === 'validated' && typeof data.requestId === 'string' && /^[a-f0-9-]{36}$/.test(data.requestId) && typeof data.valid === 'boolean') return { type: 'validated', requestId: data.requestId, valid: data.valid }
  if (data.type === 'restored' && typeof data.requestId === 'string' && /^[a-f0-9-]{36}$/.test(data.requestId) && (data.status === 'located' || data.status === 'missing' || data.status === 'ambiguous')) return { type: 'restored', requestId: data.requestId, status: data.status }
  if (data.type !== 'selection' || !data.selection || typeof data.selection !== 'object') return null
  const value = data.selection as Record<string, unknown>
  const parsed = designSelectionSchema.safeParse({ pageId: identity.pageId, frameId, revision: identity.revision, selector: value.selector, tagName: value.tagName, text: value.text, outerHTML: value.outerHTML })
  if (!parsed.success || typeof value.canEditText !== 'boolean' || typeof value.hasParent !== 'boolean' || typeof value.path !== 'string' || value.path.length > 2000) return null
  // A frame can report DOM facts; it cannot assert that those facts match saved
  // source. Dynamic or ambiguous elements cannot become editable source targets.
  if (!resolveSourceElement(page, parsed.data)) return null
  return { type: 'selection', pick: { ...parsed.data, canEditText: value.canEditText, hasParent: value.hasParent, path: value.path, previewNonce: identity.nonce } }
}

function resolveSourceElement(page: DesignPage, selection: DesignSelection): { document: Document; element: Element } | null {
  if (page.id !== selection.pageId || !selection.outerHTML) return null
  try {
    const document = new DOMParser().parseFromString(page.html, 'text/html')
    const nodes = document.querySelectorAll(selection.selector)
    const element = nodes[0]
    if (nodes.length !== 1 || !element || element.closest('head,script,style,iframe,object,embed,input,textarea,select,[contenteditable="true"]') || element === document.documentElement || element.tagName.toLowerCase() !== selection.tagName || element.outerHTML !== selection.outerHTML) return null
    return { document, element }
  } catch { return null }
}

export function sourceSelection(selection: DesignElementPick): DesignSelection {
  return { pageId: selection.pageId, ...(selection.frameId ? { frameId: selection.frameId } : {}), revision: selection.revision, selector: selection.selector, tagName: selection.tagName, text: selection.text, outerHTML: selection.outerHTML }
}

export function replaceDesignElementText(page: DesignPage, selection: DesignElementPick, text: string): DesignPage {
  const resolved = resolveSourceElement(page, selection)
  if (!resolved || !selection.canEditText || resolved.element.childElementCount || ['body', 'html', 'svg', 'path', 'img', 'video', 'audio', 'canvas'].includes(resolved.element.tagName.toLowerCase())) throw new Error('元素内容已变化，请重新选择后编辑。')
  if (text.length > 4000) throw new Error('文字超过 4000 字符，请缩短后保存。')
  resolved.element.textContent = text
  return { ...page, html: `${resolved.document.doctype ? '<!DOCTYPE html>\n' : ''}${resolved.document.documentElement.outerHTML}` }
}
