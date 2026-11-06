import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, unlinkSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { checkedDirectory, directoryIdentity, FileSizeLimitError, hash, pathKey, readRegular } from '../private-conversations/files'
import { readOptional } from '../private-conversations/requirement-files'
import { DesignWorkspaceError } from './types'

type DesignRecordFile = { bytes: Buffer; finishPublication?: (current: () => void) => void }
const temporaryName = /^\.requirement-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/
const DIRECTORY_ENTRY_LIMIT = 5000

function sameFile(actual: BigIntStats, expected: BigIntStats, links: bigint): boolean {
  return actual.isFile() && !actual.isSymbolicLink() && actual.nlink === links &&
    actual.dev === expected.dev && actual.ino === expected.ino && actual.birthtimeNs === expected.birthtimeNs &&
    actual.size === expected.size && actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs
}

/** Only design metadata may read the exact two-name state left by writeRevision. */
export function readDesignRecord(root: string, file: string, limit: number): DesignRecordFile | null {
  try {
    const actual = readOptional(root, file, limit)
    return actual ? { bytes: actual.bytes } : null
  } catch (error) {
    return interruptedPublication(root, file, limit, error)
  }
}

function interruptedPublication(root: string, file: string, limit: number, originalError: unknown): DesignRecordFile {
  const base = checkedDirectory(root)
  if (!file || isAbsolute(file) || file.includes('\0') || file.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..' || part.includes(':') || /[ .]$/.test(part))) throw originalError
  const target = resolve(base, file), part = relative(base, target)
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw originalError
  const directory = checkedDirectory(dirname(target)), rootIdentity = directoryIdentity(base), parentIdentity = directoryIdentity(directory)
  const named = lstatSync(target, { bigint: true })
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 2n || pathKey(realpathSync.native(target)) !== pathKey(target)) throw originalError
  if (named.size > BigInt(limit)) throw new FileSizeLimitError()

  let temporary: string | undefined
  const stream = opendirSync(directory)
  try {
    let count = 0
    for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
      if (++count > DIRECTORY_ENTRY_LIMIT) throw new DesignWorkspaceError('设计保存目录超过读取上限', IpcErrorCode.Busy)
      if (!temporaryName.test(entry.name)) continue
      const candidate = join(directory, entry.name)
      if (pathKey(candidate) === pathKey(target)) continue
      let info: BigIntStats
      try { info = lstatSync(candidate, { bigint: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      if (info.dev !== named.dev || info.ino !== named.ino) continue
      if (temporary || !sameFile(info, named, 2n)) throw originalError
      temporary = candidate
    }
  } finally { stream.closeSync() }
  if (!temporary) throw originalError
  const orphan = temporary
  const assertDirectories = (): void => {
    if (directoryIdentity(base) !== rootIdentity || directoryIdentity(directory) !== parentIdentity) throw new DesignWorkspaceError('设计保存目录已变化，原文件已保留')
  }
  const assertPair = (): void => {
    assertDirectories()
    for (const path of [target, orphan]) {
      if (!sameFile(lstatSync(path, { bigint: true }), named, 2n) || pathKey(realpathSync.native(path)) !== pathKey(path)) throw originalError
    }
  }
  assertPair()
  const descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let bytes: Buffer
  try {
    if (!sameFile(fstatSync(descriptor, { bigint: true }), named, 2n)) throw originalError
    const buffer = Buffer.alloc(Number(named.size) + 1)
    let count = 0
    while (count < buffer.length) {
      const size = readSync(descriptor, buffer, count, buffer.length - count, null)
      if (!size) break
      count += size
    }
    if (BigInt(count) !== named.size || !sameFile(fstatSync(descriptor, { bigint: true }), named, 2n)) throw originalError
    assertPair()
    bytes = buffer.subarray(0, count)
  } finally { closeSync(descriptor) }

  // Reads remain read-only. A write may remove only this proven redundant name,
  // after its caller has validated the record, expected digest and current owner.
  // saveSelectedFile uses rename: its independent export temp is never adopted.
  return { bytes, finishPublication: current => {
    current()
    assertPair()
    unlinkSync(orphan)
    assertDirectories()
    const actual = readRegular(base, file, limit), final = lstatSync(target, { bigint: true })
    if (final.dev !== named.dev || final.ino !== named.ino || final.birthtimeNs !== named.birthtimeNs || hash(actual.bytes) !== hash(bytes)) throw new DesignWorkspaceError('设计保存文件已变化，未继续写入')
    current()
  } }
}
