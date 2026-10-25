import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { readBounded } from '../../daemon/files'
import { acpConnectionTimingsSchema, type AcpConnectionTimings } from '../../../shared/acp-connection'
import { resolveAuthorizedDocumentPath } from '../documents/paths'

export function readConnectionTimings(directory: string, startedAt: number): AcpConnectionTimings | undefined {
  try {
    const target = resolveAuthorizedDocumentPath(dirname(directory), `${basename(directory)}/zcode-adapter-connection-timings.json`)
    if (!target.ok || !target.exists || dirname(target.canonicalPath) !== dirname(target.absPath)
      || statSync(target.canonicalPath).mtimeMs + 2 < startedAt) return undefined
    const parsed = acpConnectionTimingsSchema.safeParse(JSON.parse(readBounded(target.canonicalPath, 8192)))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}
