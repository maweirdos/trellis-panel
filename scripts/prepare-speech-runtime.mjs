import { access, cp, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packages = {
  'transcribe-cpp': ['0.4.1', 'LICENSE', 'dist/index.js'],
  '@transcribe-cpp/win32-x64-cpu-vulkan': [
    '0.4.1', 'licenses/LICENSE', 'licenses/LICENSE.ggml', 'licenses/LICENSE.miniz', 'licenses/LICENSE.silero_vad',
    'contract.json', 'transcribe.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-x64.dll', 'ggml-vulkan.dll',
  ],
  koffi: ['3.3.6', 'LICENSE.txt'],
  '@koromix/koffi-win32-x64': ['3.3.6', 'win32_x64/koffi.node'],
}

export async function prepareSpeechRuntime(root = fileURLToPath(new URL('..', import.meta.url))) {
  if (process.platform !== 'win32' || process.arch !== 'x64') return
  const target = resolve(root, 'out', 'speech')
  const sources = await Promise.all(Object.entries(packages).map(async ([name, [version, ...assets]]) => {
    const source = join(root, 'node_modules', name)
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Expected ${name}@${version}`)
    await Promise.all(assets.map(asset => access(join(source, asset))))
    return { source, destination: join(target, 'node_modules', name) }
  }))
  await mkdir(target, { recursive: true })
  await cp(join(root, 'resources', 'speech', 'worker.mjs'), join(target, 'worker.mjs'))
  for (const { source, destination } of sources) {
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true, dereference: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await prepareSpeechRuntime()
}
