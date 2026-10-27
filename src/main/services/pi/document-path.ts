import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Mirror Pi's native tool path normalization before applying the document root fence. */
export function piDocumentHref(path: string, cwd: string, projectRoot: string): string | null {
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || path.includes('[redacted]')) return null
  let value = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
  if (value.startsWith('@')) value = value.slice(1)
  if (process.platform === 'win32' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value)
    if (match) value = `${match[1].toUpperCase()}:\\${(match[2] ?? '').replaceAll('/', '\\')}`
  }
  if (value === '~') value = homedir()
  else if (value.startsWith('~/') || process.platform === 'win32' && value.startsWith('~\\')) value = join(homedir(), value.slice(2))
  if (/^file:\/\//.test(value)) {
    try { value = fileURLToPath(value) } catch { return null }
  }
  if (/^[/\\]{2}/.test(value)) return null
  if (!value || !/\.(?:html?|svg)$/i.test(value)) return null
  const absolute = isAbsolute(value)
  const target = resolve(cwd, value)
  // Pi relative paths are project files; do not broaden them into other allowed absolute roots.
  if (!absolute) {
    const rel = relative(resolve(projectRoot), target)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  }
  return pathToFileURL(target).href
}
