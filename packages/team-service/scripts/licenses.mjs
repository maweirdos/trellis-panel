/** Retain actual installed production dependency notices; no third-party application source copied. */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
const root = resolve('.')
const start = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const queue = Object.keys(start.dependencies).map((name) => ({ name, from: root }))
const visited = new Set(); const records = []
while (queue.length) {
  const { name, from } = queue.shift()
  const resolver = createRequire(join(from, 'package.json'))
  let entry
  try { entry = resolver.resolve(name + '/package.json') } catch { entry = resolver.resolve(name) }
  let directory = dirname(entry)
  for (;;) {
    const file = join(directory, 'package.json')
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) break
    const parent = dirname(directory); if (parent === directory) throw Error(`Installed package root missing: ${name}`); directory = parent
  }
  if (visited.has(directory)) continue
  visited.add(directory)
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const licenses = readdirSync(directory).filter((file) => /^(?:licen[cs]e|copying|copyright)(?:\.|$)/i.test(file))
  const override = join(root, 'licenses', `${metadata.name.replaceAll('/', '__')}-${metadata.version}.txt`)
  if (!licenses.length && !existsSync(override)) throw Error(`Missing installed license notice: ${metadata.name}@${metadata.version}`)
  records.push({ name: metadata.name, version: metadata.version, license: metadata.license, notices: licenses.length ? licenses.map((file) => ({ file, text: readFileSync(join(directory, file), 'utf8') })) : [{ file: `licenses/${metadata.name.replaceAll('/', '__')}-${metadata.version}.txt`, text: readFileSync(override, 'utf8') }] })
  queue.push(...Object.keys(metadata.dependencies ?? {}).map((dependency) => ({ name: dependency, from: directory })))
}
records.sort((a, b) => (a.name + '@' + a.version).localeCompare(b.name + '@' + b.version))
writeFileSync('THIRD-PARTY-LICENSES.txt', ['Trellis team-service production dependency notices', 'Installed versions from package-lock.json; native Node runtime has its own license.', '', ...records.flatMap((record) => [`=== ${record.name}@${record.version} (${record.license}) ===`, ...record.notices.map((notice) => notice.text), ''])].join('\n'))
writeFileSync('dependency-notices.json', JSON.stringify(records.map(({ notices, ...record }) => ({ ...record, files: notices.map(({ file }) => file) })), null, 2) + '\n')
console.log(`Retained ${records.length} installed production dependency notices`)
