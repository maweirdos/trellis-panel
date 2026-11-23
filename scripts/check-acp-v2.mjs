import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
const request = createRequire(import.meta.url)

async function installedVersion(name, entry) {
  let directory = dirname(request.resolve(entry))
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (metadata.name === name) return metadata.version
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    directory = dirname(directory)
  }
  throw new Error(`Cannot locate package metadata for ${name}`)
}

try {
  const [project, lock, expected] = await Promise.all([
    readJson('../package.json'),
    readJson('../package-lock.json'),
    readJson('../patches/acp-v2-sdk.json'),
  ])
  for (const [name, version, entry] of [
    ['@agentclientprotocol/sdk', expected.version, expected.entry],
    ['effect', expected.effectVersion, 'effect/Effect'],
  ]) {
    if (project.dependencies?.[name] !== version || lock.packages?.[`node_modules/${name}`]?.version !== version
      || await installedVersion(name, entry) !== version) {
      throw new Error(`${name} must be pinned, locked and installed at ${version}`)
    }
  }
  if (Object.keys(lock.packages ?? {}).some(path => /(?:^|\/)node_modules\/acpx$/.test(path))) {
    throw new Error('The ACP v2 dependency graph must exclude acpx')
  }
  const sdk = await import(expected.entry)
  if (expected.protocolVersion !== 2 || sdk.PROTOCOL_VERSION !== 2) throw new Error('The ACP SDK entry must expose protocol version 2')
  if (typeof request('effect/Effect').timeoutOption !== 'function') throw new Error('Electron must be able to load the Effect runtime used by the T3 ACP client')
  console.log(`ACP v2 SDK ${expected.version} and T3 ACP Effect ${expected.effectVersion} verified`)
} catch (error) {
  console.error(`ACP dependency verification failed: ${error.message}`)
  process.exitCode = 1
}
