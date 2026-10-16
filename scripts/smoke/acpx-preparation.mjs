import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { checkAcpxCompatibility, projectRoot } from '../check-acpx-compat.mjs'

const request = createRequire(join(projectRoot, 'package.json'))
const packageRoot = dirname(request.resolve('acpx/package.json'))
const manifest = JSON.parse(readFileSync(join(projectRoot, 'patches/acpx-compat.json'), 'utf8'))
const project = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const directory = mkdtempSync(join(tmpdir(), 'trellis-acpx-preparation-'))
const observations = []
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')

function fixture(name) {
  const root = join(directory, name)
  mkdirSync(join(root, 'node_modules/acpx'), { recursive: true })
  writeJson(join(root, 'package.json'), project)
  cpSync(join(projectRoot, 'patches'), join(root, 'patches'), { recursive: true })
  cpSync(join(packageRoot, 'package.json'), join(root, 'node_modules/acpx/package.json'))
  const sdk = join(root, 'node_modules/acpx/node_modules/@agentclientprotocol/sdk')
  mkdirSync(sdk, { recursive: true })
  writeJson(join(sdk, 'package.json'), { name: '@agentclientprotocol/sdk', version: '1.8.0', exports: './entry.js' })
  writeFileSync(join(sdk, 'entry.js'), '// Resolution-only SDK fixture; never imported.\n')
  for (const file of Object.keys(manifest.files)) {
    mkdirSync(dirname(join(root, 'node_modules/acpx', file)), { recursive: true })
    cpSync(join(packageRoot, file), join(root, 'node_modules/acpx', file))
  }
  return root
}
async function check(name, action) {
  await action()
  observations.push({ name, status: 'passed' })
  console.log(`PASS ${name}`)
}

await check('pinned public runtime and checksums match', async () => {
  assert.deepEqual(await checkAcpxCompatibility(), { version: '0.19.5', compatVersion: 1 })
})
await check('dependency preparation is available for production installs and standard entrypoints', async () => {
  assert.equal(project.dependencies.acpx, '0.19.5')
  assert.equal(project.dependencies['patch-package'], '8.0.1')
  assert.equal(project.overrides.acpx['@agentclientprotocol/sdk'], '1.8.0')
  assert.equal(project.scripts.postinstall, 'node scripts/prepare-acpx.mjs')
  for (const script of ['predev', 'prebuild', 'predist:dir', 'predist', 'pretypecheck']) assert.equal(project.scripts[script], 'npm run check:acpx')
})
await check('unpinned project or mismatched installed package fail before import', async () => {
  for (const target of ['package.json', 'node_modules/acpx/package.json']) {
    const root = fixture(`version-${target.includes('node_modules') ? 'installed' : 'requested'}`)
    const file = join(root, target)
    const value = json(file)
    if (target === 'package.json') value.dependencies.acpx = '^0.19.5'
    else value.version = '0.19.6'
    writeJson(file, value)
    await assert.rejects(checkAcpxCompatibility(root), /must be pinned and installed/)
  }
})
await check('missing or modified patch cannot be silently accepted', async () => {
  const root = fixture('patch-checksum')
  writeFileSync(join(root, 'patches', manifest.patch), 'modified patch\n')
  await assert.rejects(checkAcpxCompatibility(root, { requirePatched: false }), /patch checksum mismatch/)
  const missing = fixture('patch-missing')
  const value = json(join(missing, 'patches/acpx-compat.json'))
  value.patch = 'absent.patch'
  writeJson(join(missing, 'patches/acpx-compat.json'), value)
  await assert.rejects(checkAcpxCompatibility(missing, { requirePatched: false }), /ENOENT/)
})
await check('unreviewed SDK override or actual resolved SDK drift is rejected', async () => {
  for (const target of ['override', 'installed']) {
    const root = fixture(`sdk-${target}`)
    if (target === 'override') {
      const value = json(join(root, 'package.json'))
      value.overrides.acpx['@agentclientprotocol/sdk'] = '^1.8.0'
      writeJson(join(root, 'package.json'), value)
    } else {
      const file = join(root, 'node_modules/acpx/node_modules/@agentclientprotocol/sdk/package.json')
      writeJson(file, { ...json(file), version: '1.9.0' })
    }
    await assert.rejects(checkAcpxCompatibility(root), /ACP SDK must be pinned/)
  }
})
await check('unpatched marker and partially applied declaration patches fail clearly', async () => {
  for (const file of ['dist/runtime.js', 'dist/session-options-CkcvthCv.d.ts']) {
    const root = fixture(`partial-${file.endsWith('.js') ? 'runtime' : 'types'}`)
    writeFileSync(join(root, 'node_modules/acpx', file), 'unpatched\n')
    await assert.rejects(checkAcpxCompatibility(root), /absent or incomplete.*prepare:acpx/)
  }
})

if (process.argv.includes('--clean-install')) {
  await check('clean locked production install: skipped scripts reject, explicit preparation is idempotent, postinstall applies automatically', async () => {
    const root = join(directory, 'clean-install')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    for (const file of ['package.json', 'package-lock.json']) cpSync(join(projectRoot, file), join(root, file))
    cpSync(join(projectRoot, 'patches'), join(root, 'patches'), { recursive: true })
    for (const file of ['check-acpx-compat.mjs', 'prepare-acpx.mjs']) cpSync(join(projectRoot, 'scripts', file), join(root, 'scripts', file))
    const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const install = spawnSync(process.execPath, [npmCli, 'ci', '--legacy-peer-deps', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000
    })
    writeFileSync(join(root, 'install.log'), `${install.stdout ?? ''}\n${install.stderr ?? ''}`)
    assert.equal(install.status, 0, `Clean npm ci failed: ${install.error?.message ?? install.stderr}`)
    await assert.rejects(checkAcpxCompatibility(root), /absent or incomplete/)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prepared = spawnSync(process.execPath, [join(root, 'scripts/prepare-acpx.mjs')], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000
      })
      writeFileSync(join(root, `prepare-${attempt}.log`), `${prepared.stdout ?? ''}\n${prepared.stderr ?? ''}`)
      assert.equal(prepared.status, 0, prepared.error?.message ?? prepared.stderr)
    }
    assert.deepEqual(await checkAcpxCompatibility(root), { version: '0.19.5', compatVersion: 1 })
    const automatic = spawnSync(process.execPath, [npmCli, 'ci', '--legacy-peer-deps', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000
    })
    writeFileSync(join(root, 'automatic-install.log'), `${automatic.stdout ?? ''}\n${automatic.stderr ?? ''}`)
    assert.equal(automatic.status, 0, `Production postinstall failed: ${automatic.error?.message ?? automatic.stderr}`)
    assert.ok(automatic.stdout.includes('Prepared acpx 0.19.5 compatibility v1'))
    assert.deepEqual(await checkAcpxCompatibility(root), { version: '0.19.5', compatVersion: 1 })
  })
}
writeJson(join(directory, 'results.json'), { observations, cleanInstallRequested: process.argv.includes('--clean-install') })
console.log(`EVIDENCE ${join(directory, 'results.json')}`)
