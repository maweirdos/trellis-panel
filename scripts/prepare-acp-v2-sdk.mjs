import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const request = createRequire(join(root, 'package.json'))
const entry = request.resolve('@agentclientprotocol/sdk/experimental/v2')
const localNodeModules = resolve(root, 'node_modules')
let packageDirectory = dirname(entry)
for (let depth = 0; depth < 5; depth += 1) {
  const packagePath = join(packageDirectory, 'package.json')
  if (await access(packagePath).then(() => true, () => false)) break
  packageDirectory = dirname(packageDirectory)
}
const packageRelation = relative(localNodeModules, packageDirectory)
if (!packageRelation || packageRelation === '..' || packageRelation.startsWith(`..${sep}`)) {
  throw new Error('ACP v2 SDK must resolve inside this project installation')
}
const source = join(packageDirectory, 'dist', 'v2', 'schema', 'zod.gen.js')
const types = source.replace(/\.js$/, '.d.ts')
const targetDirectory = join(root, 'src', 'main', 'services', 'acp', 'v2', 'generated')
const target = join(targetDirectory, 'zod.gen.js')
const targetTypes = target.replace(/\.js$/, '.d.ts')

await mkdir(targetDirectory, { recursive: true })
await copyFile(source, target)
await copyFile(types, targetTypes)
const sourceText = await readFile(source, 'utf8')
await writeFile(target, sourceText.replaceAll('../../schema-deserialize.js', '../../../../../../node_modules/@agentclientprotocol/sdk/dist/schema-deserialize.js'))
const exported = await import(pathToFileURL(target).href)
if (typeof exported.zInitializeResponse !== 'object') throw new Error('Generated ACP v2 schemas are unavailable')
