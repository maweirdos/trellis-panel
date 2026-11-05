import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { teamRelativePathSchema } from '../../../../shared/team-platform'
import { IMPORT_LIMITS } from '../../../../shared/team-import'
import { TrellisImportError, type NativeImportIdentity } from '../types'

function fail(message: string): never { throw new TrellisImportError('IMPORT_SOURCE_CHANGED', message) }
export function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink }
export function captureRoot(selected: string): NativeImportIdentity {
  const root = realpathSync(resolve(selected)), stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Selected root must be a real directory')
  return { root, device: stat.dev, inode: stat.ino }
}
export function assertRoot(identity: NativeImportIdentity): void {
  const stat = lstatSync(identity.root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(identity.root) !== identity.root || stat.dev !== identity.device || stat.ino !== identity.inode) fail('Selected native root was replaced')
}
/** Check each component and repeat after IO. Never use a renderer path as authority. */
export function checkedPath(identity: NativeImportIdentity, path: string): { path: string; components: Array<{ path: string; stat: Stats }> } {
  teamRelativePathSchema.parse(path)
  if (path.includes('\\')) fail('Source paths must use canonical forward slashes')
  assertRoot(identity)
  const target = join(identity.root, ...path.split('/')), rel = relative(identity.root, target)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) fail('Source path escaped its selected root')
  const components: Array<{ path: string; stat: Stats }> = []
  let current = identity.root
  for (const part of path.split('/')) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || realpathSync(current) !== current) fail('Linked source paths are not followed')
    components.push({ path: current, stat })
  }
  return { path: target, components }
}
export function assertComponents(identity: NativeImportIdentity, components: Array<{ path: string; stat: Stats }>): void {
  assertRoot(identity)
  for (const component of components) {
    const stat = lstatSync(component.path)
    if (stat.isSymbolicLink() || realpathSync(component.path) !== component.path || stat.dev !== component.stat.dev || stat.ino !== component.stat.ino) fail('A source path component changed during reading')
  }
}
export function readSource(identity: NativeImportIdentity, path: string): Buffer {
  const source = checkedPath(identity, path), before = source.components.at(-1)?.stat
  if (!before || !before.isFile() || before.nlink !== 1) fail('Source must be a regular file with no link aliases')
  if (before.size > IMPORT_LIMITS.fileBytes) throw new TrellisImportError('IMPORT_FILE_LIMIT', 'Source exceeds the visible per-file byte limit')
  const fd = openSync(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameFile(before, fstatSync(fd))) fail('Source was replaced before reading')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n }
    const after = fstatSync(fd)
    assertComponents(identity, source.components)
    if (offset !== before.size || !sameFile(before, after) || !sameFile(before, lstatSync(source.path))) fail('Source bytes changed during reading')
    return bytes.subarray(0, offset)
  } finally { closeSync(fd) }
}
