/**
 * IPC 注册表冒烟（AC1/AC2 的机器验证）：
 * 在纯 node 下真实执行 registerIpc(deps)，双向断言：
 *   a) 注册的每个通道都在 shared/ipc-channels.ts 声明过（防"绕过注册表"）；
 *   b) 声明的每个 invoke 通道都被注册过（防"拆分时漏迁 handler"）。
 * 运行：node scripts/smoke/ipc-registry.mjs
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'

const workDir = mkdtempSync(join(tmpdir(), 'tpanel-ipc-smoke-'))
process.env.TPAP_SMOKE_DIR = workDir

const bundle = join(workDir, 'ipc-bundle.mjs')
const requireBanner = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
execFileSync(process.execPath, [
  join('node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/main/ipc/index.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  `--banner:js=${requireBanner}`,
  `--alias:electron=${join(process.cwd(), 'scripts', 'smoke', 'mock-electron.mjs').replace(/\\/g, '/')}`,
  `--outfile=${bundle}`
], { stdio: 'inherit' })

const { registerIpc } = await import(pathToFileURL(bundle).href)
const { ipcInvoke, allIpcChannels } = await import(pathToFileURL(join(process.cwd(), 'src/shared/ipc-channels.ts')).href)

const noop = () => undefined
registerIpc({
  getMain: () => null,
  getCapsule: () => null,
  showMain: noop,
  createMain: noop,
  capsule: { onTop: () => true, setOnTop: noop, shape: () => 'pill', setShape: noop, create: noop }
})

const registered = new Set([...globalThis.__TPANEL_IPC__.handle, ...globalThis.__TPANEL_IPC__.on])

let failures = 0
const undeclared = [...registered].filter((c) => !allIpcChannels.has(c))
if (undeclared.length > 0) {
  console.error('  ✗ 注册了未声明通道:', undeclared)
  failures += 1
} else {
  console.log('  ✓ 所有注册通道均已在注册表声明')
}

const declaredInvoke = Object.values(ipcInvoke).flatMap((domain) => Object.values(domain))
const missing = declaredInvoke.filter((c) => !registered.has(c))
if (missing.length > 0) {
  console.error('  ✗ 已声明但未注册的 invoke 通道:', missing)
  failures += 1
} else {
  console.log(`  ✓ 全部 ${declaredInvoke.length} 个 invoke 通道均已注册`)
}

rmSync(workDir, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('IPC registry smoke: 全部通过')
