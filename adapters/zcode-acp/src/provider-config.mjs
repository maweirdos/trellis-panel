/** Resolve ZCode's native data root. Never import legacy providers or copy credentials. */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize } from 'node:path'

const MAX_BOOTSTRAP_BYTES = 256 * 1024
const MAX_PRIMARY_BYTES = 2 * 1024 * 1024
const record = value => value && typeof value === 'object' && !Array.isArray(value)

function readDocument(path, maximum, label) {
  let fd
  try {
    fd = openSync(path, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maximum) throw new Error()
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1))
    let size = 0
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null)
      if (!count) break
      size += count
    }
    if (size > stat.size || size > maximum) throw new Error()
    const parsed = JSON.parse(buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, ''))
    if (!record(parsed)) throw new Error()
    return parsed
  } catch { throw new Error(`ZCode ${label} is invalid or unavailable; no legacy fallback was used`) }
  finally { if (fd !== undefined) closeSync(fd) }
}

function fileIdentity(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error()
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch { throw new Error('ZCode native configuration source is unavailable') }
}

export function resolveProviderEnvironment(env, { isolatedDir } = {}) {
  const home = env.USERPROFILE || env.HOME || homedir()
  let dataBaseDir = isolatedDir || env.ZCODE_DATA_BASE_DIR
  let source = isolatedDir ? 'isolated' : dataBaseDir ? 'environment' : 'home'
  let bootstrap
  let bootstrapIdentity
  if (!dataBaseDir && env.ZCODE_HOME) {
    const configured = normalize(env.ZCODE_HOME)
    if (!/[\\/]\.zcode[\\/]?$/i.test(configured)) throw new Error('ZCODE_HOME must identify the native .zcode directory')
    dataBaseDir = dirname(configured)
    source = 'ZCODE_HOME'
  }
  if (!dataBaseDir) {
    bootstrap = join(home, '.zcode', 'v2', 'setting.json')
    if (existsSync(bootstrap)) {
      bootstrapIdentity = fileIdentity(bootstrap)
      const settings = readDocument(bootstrap, MAX_BOOTSTRAP_BYTES, 'bootstrap setting.json')
      if (settings.dataBaseDir !== undefined) {
        if (typeof settings.dataBaseDir !== 'string' || !settings.dataBaseDir.trim()) throw new Error('ZCode bootstrap dataBaseDir is invalid')
        dataBaseDir = settings.dataBaseDir
        source = 'bootstrap'
      }
    }
    dataBaseDir ??= home
  }
  if (!isAbsolute(dataBaseDir)) throw new Error('ZCode dataBaseDir must be an absolute directory')
  try { if (!statSync(dataBaseDir).isDirectory()) throw new Error() }
  catch { throw new Error('ZCode configured dataBaseDir is unavailable; no legacy fallback was used') }
  const personalPath = !isolatedDir && env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(dataBaseDir, '.zcode', 'v2', 'provider_config.json')
  if (!isAbsolute(personalPath)) throw new Error('ZCode personal provider configuration path must be absolute')
  const personalIdentity = existsSync(personalPath) ? fileIdentity(personalPath) : undefined
  if (personalIdentity) {
    const primary = readDocument(personalPath, MAX_PRIMARY_BYTES, 'native provider configuration')
    if (primary.schemaVersion !== 1 || !record(primary.config) ||
      !Array.isArray(primary.config.providerConfigRules?.providerRules) ||
      !Array.isArray(primary.config.modelConfigRules?.providerModelRules) ||
      !Array.isArray(primary.config.modelConfigRules?.manualProviderModelRules)) {
      throw new Error('ZCode native provider schema is unsupported; no legacy fallback was used')
    }
  }
  env.ZCODE_DATA_BASE_DIR = dataBaseDir
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalPath
  return { dataBaseDir, source, personalPath, bootstrapPath: bootstrap,
    verify() {
      if (bootstrapIdentity && fileIdentity(bootstrap) !== bootstrapIdentity) throw new Error('ZCode bootstrap changed during launch; retry explicitly')
      if (personalIdentity ? fileIdentity(personalPath) !== personalIdentity : existsSync(personalPath)) throw new Error('ZCode provider configuration changed during launch; retry explicitly')
    },
    assertCurrent() {
      // UI preferences may change independently. Only a different effective data
      // root invalidates this owner; never rebind a live process to another root.
      if (source === 'bootstrap' || source === 'home') {
        const selected = existsSync(bootstrap) ? readDocument(bootstrap, MAX_BOOTSTRAP_BYTES, 'bootstrap setting.json').dataBaseDir ?? home : home
        if (selected !== dataBaseDir) throw new Error('ZCode 配置数据目录已变化，请重新连接；当前进程不会切换到其他配置来源')
      }
      if (personalIdentity ? fileIdentity(personalPath) !== personalIdentity : existsSync(personalPath)) {
        throw new Error('ZCode 原生模型配置已变化，请重新连接以重新获取模型目录')
      }
    } }
}
