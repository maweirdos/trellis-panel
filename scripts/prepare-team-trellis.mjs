import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTeamTrellisPayload } from './install-team-trellis.mjs'

const root = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const key = value => process.platform === 'win32' ? value.toLowerCase() : value
const sha = body => createHash('sha256').update(body).digest('hex')

function directory(path) {
  const parts = relative(root, path).split(/[\\/]/)
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid team adapter build path')
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if (!existsSync(current)) mkdirSync(current)
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory() || key(realpathSync.native(current)) !== key(current)) throw new Error('Team adapter build directory is redirected')
  }
}
function write(path, body) {
  directory(dirname(path))
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new Error('Team adapter build target is not a regular file')
  const temporary = join(dirname(path), `.team-adapter-${randomUUID()}.tmp`)
  writeFileSync(temporary, body, { flag: 'wx', mode: 0o644 })
  try { renameSync(temporary, path) }
  finally { if (existsSync(temporary) && sha(readFileSync(temporary)) === sha(body)) unlinkSync(temporary) }
}

/** Build the same validated six-file payload used by the source installer. */
export function prepareTeamTrellisBundle() {
  const { manifest, sources } = readTeamTrellisPayload()
  const output = join(root, 'out', 'team-trellis')
  const files = manifest.files.map(entry => {
    const body = sources.get(entry.path)
    if (!body || !/^(?:task\.py|common\/(?:io|task_store|task_utils|task_authority)\.py|hooks\/linear_sync\.py)$/.test(entry.path)) throw new Error('Invalid team adapter payload entry')
    write(join(output, 'scripts', entry.path), body)
    return { ...entry, sha256: sha(body) }
  })
  write(join(output, 'installer.mjs'), readFileSync(join(root, 'scripts', 'install-team-trellis.mjs')))
  write(join(output, 'manifest.json'), JSON.stringify({ ...manifest, files }, null, 2) + '\n')
  return { output, files: files.length }
}

if (process.argv[1] && key(resolve(process.argv[1])) === key(fileURLToPath(import.meta.url))) {
  const result = prepareTeamTrellisBundle()
  console.log(`Prepared Trellis team adapter v1 (${result.files} files): ${result.output}`)
}
