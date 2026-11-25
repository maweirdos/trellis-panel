import { createContext } from 'react'
import { projectRootKey } from '../my/navigation'

export interface ChatProjectFile {
  readonly path: string
  readonly line?: number
}

export const ChatProjectFileLinks = createContext<{
  readonly root: string
  readonly open: (file: ChatProjectFile) => void
} | null>(null)

export function resolveChatProjectFile(href: string, root: string, inline = false): ChatProjectFile | null {
  if (!href || href.length > 8192 || /[\u0000-\u0020\u007f<>|"*?]/u.test(href)) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^(?:file:\/\/\/|[a-z]:[/\\])/i.test(href) &&
    !/^[a-z][a-z\d+.-]*:\d+(?::\d+)?(?:#.*)?$/i.test(href)) return null
  const hash = href.indexOf('#')
  const fragment = hash === -1 ? '' : href.slice(hash + 1)
  let path = (hash === -1 ? href : href.slice(0, hash)).replace(/^file:\/\//i, '')
  if (/%(?:2f|5c)/i.test(path)) return null
  try { path = decodeURIComponent(path).replace(/\\/g, '/') } catch { return null }
  if (path.includes('//')) return null
  if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1)
  const position = /:(\d+)(?::\d+)?$/u.exec(path)
  if (position) path = path.slice(0, position.index)
  const lineText = position?.[1] ?? /^(?:L|line=)(\d+)(?:-L\d+)?$/iu.exec(fragment)?.[1]
  if (fragment && !lineText) return null
  const line = lineText === undefined ? undefined : Number(lineText)
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null
  if (path.startsWith('/') || /^[a-z]:\//iu.test(path)) {
    const canonicalRoot = projectRootKey(root)
    const canonicalPath = projectRootKey(path)
    const prefix = canonicalRoot?.endsWith('/') ? canonicalRoot : `${canonicalRoot}/`
    if (!canonicalRoot || !canonicalPath?.startsWith(prefix)) return null
    path = path.slice(prefix.length)
  } else {
    path = path.replace(/^(?:\.\/)+/u, '')
  }
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f:<>|"*?%]/u.test(part))) return null
  const name = parts.at(-1) ?? ''
  if (!/\.[\p{L}\d_-]+$/u.test(name) && !/^(?:Dockerfile|Makefile|LICENSE|README)$/iu.test(name)) return null
  if (inline && line === undefined && parts.length === 1) return null
  return { path, ...(line !== undefined && { line }) }
}
