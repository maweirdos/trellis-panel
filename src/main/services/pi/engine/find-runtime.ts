import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import release from './find-runtime-release.json'

/** Keep the SDK's fd implementation and semantics; only this child gets the managed tool on PATH. */
export function configurePiFindRuntime(engineUrl: string): void {
  if (process.platform !== 'win32') return
  if (process.arch !== release.arch) throw new Error('The bundled Pi find runtime requires Windows x64')
  const directory = join(dirname(fileURLToPath(engineUrl)), 'node_modules', 'trellis-pi-tools')
  try {
    const physical = realpathSync(directory)
    if (physical !== directory) throw new Error('Redirected Pi tools directory')
    for (const [name, digest] of Object.entries(release.files)) {
      const file = join(directory, name)
      if (realpathSync(file) !== file || createHash('sha256').update(readFileSync(file)).digest('hex') !== digest) {
        throw new Error('Invalid Pi find runtime asset')
      }
    }
  } catch {
    throw new Error('Pi find runtime is missing or invalid. Run npm run prepare:pi-tools in development, or reinstall the application.')
  }
  const inherited = process.env.PATH ?? process.env.Path ?? ''
  delete process.env.Path
  process.env.PATH = [directory, inherited].filter(Boolean).join(delimiter)
}
