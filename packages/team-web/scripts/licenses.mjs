/** Retain the original installed notices for packages shipped in the browser build. */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const notices = [], metadata = []
mkdirSync('licenses', { recursive: true })
for (const [path, item] of Object.entries(lock.packages)) {
  if (!path || item.dev) continue
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  const files = readdirSync(path).filter((name) => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name))
  if (!files.length) throw Error(`Missing original license notice: ${pkg.name}@${pkg.version}`)
  const copied = []
  for (const name of files) {
    const original = join(path, name), body = readFileSync(original, 'utf8')
    const relative = `licenses/${pkg.name.replaceAll('/', '__').replaceAll('@', '')}-${pkg.version}-${name}`
    copyFileSync(original, relative); copied.push({ file: relative, digest: createHash('sha256').update(body).digest('hex') })
    notices.push(`${pkg.name}@${pkg.version} · ${pkg.license ?? item.license ?? 'see original notice'}\nSource: ${item.resolved ?? pkg.repository?.url ?? 'installed package'}\n${body}`)
  }
  metadata.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? item.license, integrity: item.integrity, notices: copied })
}
writeFileSync('THIRD-PARTY-LICENSES.txt', 'Trellis supplemental Web — installed runtime dependency notices\n\n' + notices.join('\n\n----------------------------------------\n\n'))
writeFileSync('dependency-notices.json', JSON.stringify(metadata, null, 2) + '\n')
console.log(`Retained ${metadata.length} installed runtime package notices`)
if (existsSync('dist')) { copyFileSync('THIRD-PARTY-LICENSES.txt', 'dist/THIRD-PARTY-LICENSES.txt'); copyFileSync('dependency-notices.json', 'dist/dependency-notices.json') }
