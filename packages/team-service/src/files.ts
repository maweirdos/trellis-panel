import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { TeamServiceError } from './errors'

/** Constant-memory checksum for operator backup databases; never used as an HTTP file opener. */
export function fileDigest(path: string): string {
  const descriptor = openSync(path, 'r')
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile()) throw new TeamServiceError('INVALID_BACKUP', 'Backup source is not a regular file', 409)
    const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(128 * 1024)
    for (;;) { const bytes = readSync(descriptor, buffer, 0, buffer.length, null); if (!bytes) break; hash.update(buffer.subarray(0, bytes)) }
    const after = fstatSync(descriptor)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new TeamServiceError('INVALID_BACKUP', 'Backup source changed while verifying; preserve and inspect it', 409)
    return hash.digest('hex')
  } finally { closeSync(descriptor) }
}
