import { lstatSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const loader = fileURLToPath(new URL('./managed-zcode-launch.cjs', import.meta.url))

/** Fixed bundled bootstrap only. Unknown native versions fall back inside it. */
export function managedZcodeLaunch(nodePath, zcodeBin, args, cacheDirectory) {
  if (typeof cacheDirectory !== 'string' || !isAbsolute(cacheDirectory) || cacheDirectory.includes('\0')
    || extname(zcodeBin).toLowerCase() !== '.cjs') return undefined
  try {
    const entry = lstatSync(loader)
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined
  } catch { return undefined }
  return { command: nodePath, args: [loader, zcodeBin, ...args] }
}
