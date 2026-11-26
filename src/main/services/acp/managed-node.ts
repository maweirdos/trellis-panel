import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import release from './node-runtime-release.json'

export type NodeExecutable = { path: string; version: string }
export type NodeRuntime = NodeExecutable & { source: 'explicit' | 'managed' | 'path' }
type NodeRunner = (path: string, args: string[]) => Promise<string>

const NODE_BYTES = 150 * 1024 * 1024
const LICENSE_BYTES = 1024 * 1024
type VerifiedDigest = { sha256: string; stamp: string }
const verifiedFiles = new Map<string, { stamp: string; digest: Promise<VerifiedDigest> }>()
const fingerprint = (entry: BigIntStats): string => [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs, entry.birthtimeNs].join(':')

function assetEntry(path: string, maxBytes: number): BigIntStats {
  const entry = lstatSync(path, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Node runtime asset is not a physical regular file')
  if (entry.size <= 0n || entry.size > BigInt(maxBytes)) throw new Error('Node runtime asset exceeds its size limit')
  return entry
}

async function digestFile(path: string, maxBytes: number): Promise<VerifiedDigest> {
  const stamp = fingerprint(assetEntry(path, maxBytes))
  const previous = verifiedFiles.get(path)
  if (previous?.stamp === stamp) return previous.digest
  const digest = (async (): Promise<VerifiedDigest> => {
    const handle = await open(path, 'r')
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || fingerprint(before) !== stamp) throw new Error('Node runtime asset changed while opening')
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
      const limit = Number(before.size)
      let bytes = 0
      while (true) {
        // One byte beyond the captured size detects growth without following an
        // unbounded append. All reads belong to this one physical descriptor.
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - bytes + 1), bytes)
        if (!bytesRead) break
        bytes += bytesRead
        if (bytes > limit) throw new Error('Node runtime asset grew while hashing')
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await handle.stat({ bigint: true })
      const current = assetEntry(path, maxBytes)
      if (BigInt(bytes) !== before.size || fingerprint(after) !== stamp || fingerprint(current) !== stamp) throw new Error('Node runtime asset changed while hashing')
      return { sha256: hash.digest('hex'), stamp }
    } finally { await handle.close() }
  })()
  verifiedFiles.set(path, { stamp, digest })
  try { return await digest } catch (error) {
    if (verifiedFiles.get(path)?.digest === digest) verifiedFiles.delete(path)
    throw error
  }
}

/** Packaged resources only; development does not download or use the build cache. */
export async function managedNodePath(resourcesPath: string | undefined, platform: NodeJS.Platform = process.platform, arch: string = process.arch): Promise<string | undefined> {
  if (!resourcesPath || !isAbsolute(resourcesPath) || platform !== release.platform || arch !== release.arch) return undefined
  try {
    const root = realpathSync(join(resourcesPath, 'node-runtime', 'win-x64'))
    const resources = realpathSync(resourcesPath)
    const inside = (base: string, path: string): boolean => {
      const local = relative(base, path)
      return !!local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
    }
    if (!inside(resources, root)) return undefined
    const executable = realpathSync(join(root, release.executable))
    const license = realpathSync(join(root, 'LICENSE'))
    if (!inside(root, executable) || !inside(root, license)) return undefined
    const [binaryDigest, licenseDigest] = await Promise.all([digestFile(executable, NODE_BYTES), digestFile(license, LICENSE_BYTES)])
    // Recheck the pair, including warm cache hits: one asset may have changed
    // while the other was being read, or while a shared verification was pending.
    if (fingerprint(assetEntry(executable, NODE_BYTES)) !== binaryDigest.stamp || fingerprint(assetEntry(license, LICENSE_BYTES)) !== licenseDigest.stamp) return undefined
    return binaryDigest.sha256 === release.sha256 && licenseDigest.sha256 === release.licenseSha256 ? executable : undefined
  } catch { return undefined }
}

function runNode(path: string, args: string[]): Promise<string> {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  return new Promise((resolve, reject) => execFile(path, args, { env, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())))
}

/** Validation never persists a candidate and never enables Electron's Node mode. */
export async function validateNodeExecutable(path: string, { sqlite = false, run = runNode }: { sqlite?: boolean; run?: NodeRunner } = {}): Promise<NodeExecutable> {
  if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error('Node.js 路径不是有效的独立可执行文件')
  if (process.versions.electron && realpathSync(path).toLowerCase() === realpathSync(process.execPath).toLowerCase()) throw new Error('请选择独立 Node.js，不能使用 Electron 可执行文件')
  // 单次子进程同时校验独立 Node 身份、版本号与可选 node:sqlite 能力，避免每次探测起 2 个 node.exe。
  const script = `if (process.versions.electron || process.release.name !== 'node') process.exit(1); ${sqlite ? 'try { const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); db.close() } catch { process.exit(2) }; ' : ''}process.stdout.write(process.version)`
  let version: string
  try {
    version = await run(path, ['--input-type=commonjs', '-e', script])
  } catch (error) {
    const exitCode = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
    if (sqlite && exitCode === 2) throw new Error('ZCode 需要支持 node:sqlite 的独立 Node.js（>=22.13）')
    // 兼容被测试/自定义 runner 仅模拟 --version + -e 两段调用的场景
    if (run !== runNode) {
      const legacyVersion = await run(path, ['--version'])
      const legacyMatch = /^v(\d+)\.(\d+)\.(\d+)$/.exec(legacyVersion)
      if (!legacyMatch || Number(legacyMatch[1]) < 22 || Number(legacyMatch[1]) === 22 && Number(legacyMatch[2]) < 13) throw new Error(`Node ${legacyVersion.slice(0, 60)} 不兼容，需要 >=22.13`)
      try {
        await run(path, ['--input-type=commonjs', '-e', `if (process.versions.electron || process.release.name !== 'node') process.exit(1); ${sqlite ? 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); db.close()' : ''}`])
      } catch { throw new Error(sqlite ? 'ZCode 需要支持 node:sqlite 的独立 Node.js（>=22.13）' : '该程序不是可用的独立 Node.js') }
      return { path, version: legacyVersion }
    }
    throw new Error(sqlite ? 'ZCode 需要支持 node:sqlite 的独立 Node.js（>=22.13）' : '该程序不是可用的独立 Node.js')
  }
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match || Number(match[1]) < 22 || Number(match[1]) === 22 && Number(match[2]) < 13) throw new Error(`Node ${version.slice(0, 60)} 不兼容，需要 >=22.13`)
  return { path, version }
}

export async function resolveNodeRuntime({ explicitPath, resourcesPath, pathNode, sqlite = false, accepts, validate = validateNodeExecutable }: {
  explicitPath?: string
  resourcesPath?: string
  pathNode?: string
  sqlite?: boolean
  accepts?: (path: string) => boolean
  validate?: typeof validateNodeExecutable
}): Promise<NodeRuntime> {
  const candidates: [NodeRuntime['source'], () => string | undefined | Promise<string | undefined>][] = [
    ['explicit', () => explicitPath], ['managed', () => managedNodePath(resourcesPath)], ['path', () => pathNode]
  ]
  const failures: string[] = []
  for (const [source, candidate] of candidates) {
    const path = await candidate()
    if (!path) continue
    try {
      const node = await validate(path, { sqlite })
      if (accepts && !accepts(path)) throw new Error('安装执行引擎需要包含 npm 的 Node.js')
      return { ...node, source }
    } catch (error) { failures.push(error instanceof Error ? error.message : 'Node.js 验证失败') }
  }
  throw new Error(failures.at(-1) ?? '未找到可用的 Node.js；请重新安装应用以恢复随包运行环境')
}
