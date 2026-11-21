import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DaemonError } from './errors'

export function readBounded(file: string, limit: number): string {
  return readBoundedBytes(file, limit).toString('utf8')
}
export function readBoundedBytes(file: string, limit: number): Buffer {
  const entry = lstatSync(file)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new DaemonError('E_DENIED', 'Daemon state must be a regular file without redirection.')
  const fd = openSync(file, 'r')
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) throw new DaemonError('E_DENIED', 'Daemon state changed identity while opening it.')
    if (opened.size > limit) throw new DaemonError('E_IO', 'Daemon state exceeds its size limit; the original file is preserved.')
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length > limit) throw new DaemonError('E_IO', 'Daemon state changed beyond its size limit.')
    return bytes.subarray(0, length)
  } finally { closeSync(fd) }
}
export function writeExclusive(file: string, text: string): void {
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
}
/** Publish complete immutable state without replacing an existing winner.
 * Same-directory hard-link publication is atomic on supported Windows volumes;
 * unsupported filesystems fail closed rather than exposing a partial key. */
export function writeExclusiveAtomic(file: string, text: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeExclusive(temporary, text); linkSync(temporary, file) }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
/** Same-directory publication; fsync before rename. No success is returned before publication. */
export function writeAtomic(file: string, text: string, options?: { retryWindowsRename?: boolean }): void {
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new DaemonError('E_DENIED', 'Daemon state cannot replace a symbolic link.')
  const temporary = `${file}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    const retryDelays = process.platform === 'win32' && options?.retryWindowsRename ? [5, 10, 20, 40] : []
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, file); break }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const delay = retryDelays[attempt]
        if (delay === undefined || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
        // The caller must keep the commit synchronous before native spawn.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
