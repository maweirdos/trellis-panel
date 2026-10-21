import type { IpcFail } from './ipc-errors'

export type LocalDocumentOpenResult = { ok: true } | IpcFail
export interface LocalDocumentLink {
  path: string
  absolute: boolean
  fragment: string
}

export const LOCAL_DOCUMENT_EXTENSIONS = ['.html', '.htm', '.pdf', '.md', '.txt'] as const
export function supportedLocalDocumentPath(path: string): boolean {
  return LOCAL_DOCUMENT_EXTENSIONS.some(extension => path.toLowerCase().endsWith(extension))
}

/** Syntax only; main separately authorizes roots, real paths and actual files. */
export function localDocumentLink(value: unknown): LocalDocumentLink | null {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return null
  if (/%(?![\da-f]{2})/i.test(value)) return null
  // Markdown encodes native Windows backslashes; do not accept hidden UNC roots.
  const encodedDrive = /^(?:file:\/\/\/|\/)?[a-z]:(?:%2f|%5c)/i.test(value)
  if (/%2f|%5c/i.test(value) && !encodedDrive) return null
  const hash = value.indexOf('#')
  let path = hash < 0 ? value : value.slice(0, hash)
  const fragment = hash < 0 ? '' : value.slice(hash + 1)
  if (!path || path.includes('?')) return null
  if (/^file:/i.test(path)) {
    // No authority, including localhost: a document link must never touch SMB.
    if (!/^file:\/\/\//i.test(path)) return null
    path = path.slice('file://'.length)
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:(?:[/\\]|%2f|%5c)/i.test(path)) return null
  try {
    path = decodeURIComponent(path).replace(/\\/g, '/')
    const decodedFragment = decodeURIComponent(fragment)
    if (/[\u0000-\u001f\u007f]/.test(decodedFragment)) return null
  } catch {
    return null
  }
  if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
  if (/^\/\//.test(path) || /^[\u0000-\u001f\u007f]/.test(path) || /[\u0000-\u001f\u007f<>"|?*%]/.test(path)) return null
  if (path.includes(':') && !/^[a-z]:\/[^:]*$/i.test(path)) return null
  if (!supportedLocalDocumentPath(path)) return null
  return { path, absolute: path.startsWith('/') || /^[a-z]:\//i.test(path), fragment }
}

/** Absolute hrefs must not resolve against the dev server when copied. */
export function localDocumentHref(value: string): string | null {
  const link = localDocumentLink(value)
  if (!link) return null
  if (!link.absolute) return value
  const url = new URL('file:///')
  url.pathname = /^[a-z]:\//i.test(link.path) ? `/${link.path}` : link.path
  url.hash = link.fragment
  return url.href
}
