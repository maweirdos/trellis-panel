import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkAcpxCompatibility, projectRoot } from './check-acpx-compat.mjs'

export async function prepareAcpx(root = projectRoot) {
  await checkAcpxCompatibility(root, { requirePatched: false })
  const request = createRequire(join(root, 'package.json'))
  const patchPackage = request('patch-package/package.json')
  if (patchPackage.version !== '8.0.1') throw new Error('Exact patch-package@8.0.1 is required for dependency preparation')
  const result = spawnSync(process.execPath, [request.resolve('patch-package/index.js'), '--error-on-fail'], {
    cwd: root, stdio: 'inherit', windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`patch-package failed (exit ${result.status ?? result.signal})`)
  return await checkAcpxCompatibility(root)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await prepareAcpx()
    console.log(`Prepared acpx ${result.version} compatibility v${result.compatVersion}`)
  } catch (error) {
    console.error(`ACP dependency preparation failed: ${error.message}`)
    process.exitCode = 1
  }
}
