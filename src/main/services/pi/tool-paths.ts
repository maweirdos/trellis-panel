import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const unicodeSpaces = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g

/** Mirrors Pi 1.4's resolveToCwd options; home belongs to the SDK process. */
export function resolvePiToolPath(input: string, cwd: string, home: string): string {
  let value = input.replace(unicodeSpaces, ' ')
  if (value.trim() !== value) throw new Error('工具路径首尾空白无法安全验证')
  if (value.startsWith('@')) value = value.slice(1)
  if (process.platform === 'win32' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value)
    if (match) value = `${match[1].toUpperCase()}:\\${(match[2] ?? '').replaceAll('/', '\\')}`
  }
  if (value === '~') value = home
  else if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) value = join(home, value.slice(2))
  if (/^file:\/\//.test(value)) value = fileURLToPath(value)
  if (value.includes('\0') || value.trim() !== value) throw new Error('工具路径无效')
  // Drive-relative names depend on per-process drive state, which may differ in
  // the SDK child. Device namespaces and alternate streams are not ordinary files.
  if (process.platform === 'win32' && (/^[a-z]:(?![\\/])/i.test(value) || /^\\\\[?.]\\/.test(value) || value.replace(/^[a-z]:/i, '').includes(':'))) throw new Error('工具路径无效')
  if (process.platform === 'win32' && value.split(/[\\/]/).some(part => part !== '.' && part !== '..' && (/[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new Error('工具路径无效')
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

/** Check existing targets or their nearest existing ancestor without following a dangling link. */
function physicalTarget(root: string, path: string): string {
  if (!within(root, path)) throw new Error('工具路径超出当前项目的物理目录')
  let current = path
  for (;;) {
    try {
      lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (current === root || dirname(current) === current) throw new Error('工具路径无法验证')
      current = dirname(current)
      continue
    }
    // A dangling or inaccessible symlink must fail closed, not become a
    // "missing" leaf whose target could later appear outside the project.
    const physical = realpathSync(current)
    if (!within(root, physical)) throw new Error('工具路径超出当前项目的物理目录')
    return join(physical, relative(current, path))
  }
}

/** Select the same first existing read candidate as Pi 1.4, or the original if none exists. */
function selectReadPath(path: string): string {
  const candidates = [path, path.replace(/ (AM|PM)\./gi, '\u202f$1.'), path.normalize('NFD'), path.replace(/'/g, '\u2019'), path.normalize('NFD').replace(/'/g, '\u2019')]
  for (const candidate of new Set(candidates)) {
    try { accessSync(candidate, constants.F_OK); return candidate } catch { /* Pi tries the next candidate on access failure. */ }
  }
  return path
}

/** Re-select on every authorization check and retain both lexical and physical identity. */
export function assertPiToolPath(root: string, cwd: string, home: string, tool: string, input: string): string[] {
  const physicalRoot = realpathSync(root)
  const physicalCwd = realpathSync(cwd)
  if (!within(physicalRoot, physicalCwd)) throw new Error('Pi 工作目录超出当前项目的物理目录')
  const path = resolvePiToolPath(input, physicalCwd, home)
  const selected = tool === 'read' ? selectReadPath(path) : path
  return [selected, physicalTarget(physicalRoot, selected)]
}
