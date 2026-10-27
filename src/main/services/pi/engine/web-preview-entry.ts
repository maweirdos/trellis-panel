import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { extname, isAbsolute, join, relative, sep, win32 } from 'node:path'

export const PI_WEB_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

/** Project-relative names are literal file paths, independent of the SDK cwd. */
export function inspectPiWebPreviewEntry(root: string, input: string): { path: string; file: string; stat: Stats } {
  if (!input || input.length > 8192 || input.trim() !== input || /[\u0000-\u001f\u007f:?#]/.test(input) || isAbsolute(input) || win32.isAbsolute(input)) {
    throw new Error('preview_web requires a project-relative HTML file path')
  }
  const parts = input.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.')
  if (!parts.length || parts.some(part => part === '..' || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('preview_web path contains an unsafe segment')
  }
  const path = parts.join('/')
  if (!['.html', '.htm'].includes(extname(path).toLowerCase())) throw new Error('preview_web requires an HTML entry (.html or .htm)')
  const physicalRoot = realpathSync(root)
  if (/^[/\\]{2}/.test(physicalRoot)) throw new Error('preview_web cannot read network shares')
  let file = physicalRoot
  // Check top-down before following a descendant link or junction to another root/share.
  for (const part of parts) {
    file = join(file, part)
    if (lstatSync(file).isSymbolicLink()) throw new Error('preview_web cannot follow symbolic links or directory junctions')
  }
  file = realpathSync(file)
  const local = relative(physicalRoot, file)
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || !['.html', '.htm'].includes(extname(file).toLowerCase())) {
    throw new Error('preview_web entry must remain inside the project')
  }
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > PI_WEB_PREVIEW_MAX_BYTES) {
    throw new Error('preview_web entry must be a nonempty regular HTML file of at most 8 MiB')
  }
  return { path, file, stat }
}

/** Read only bounded bytes from the checked entry; never execute code or prepare a server. */
export function readPiWebPreviewEntry(root: string, path: string): { path: string; revision: string } {
  const entry = inspectPiWebPreviewEntry(root, path)
  const fd = openSync(entry.file, 'r')
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.dev !== entry.stat.dev || before.ino !== entry.stat.ino || before.size !== entry.stat.size) {
      throw new Error('preview_web entry changed before reading')
    }
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    const current = inspectPiWebPreviewEntry(root, path)
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      current.file !== entry.file || current.stat.dev !== before.dev || current.stat.ino !== before.ino || current.stat.mtimeMs !== before.mtimeMs) {
      throw new Error('preview_web entry changed while reading; retry with the saved file')
    }
    const content = bytes.subarray(0, length)
    const html = new TextDecoder('utf-8', { fatal: true }).decode(content)
    if (!html.trim() || !/<(?:!doctype\s+html|html|head|body|[a-z][a-z0-9-]*(?:\s|\/?>))/i.test(html)) {
      throw new Error('preview_web entry does not contain an HTML document')
    }
    return { path: entry.path, revision: createHash('sha256').update(content).digest('hex') }
  } finally { closeSync(fd) }
}
