// Native data-root regression: current desktop bootstrap beats stale home legacy config.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProviderEnvironment } from '../../adapters/zcode-acp/src/provider-config.mjs'
import { appServerEnv } from '../../adapters/zcode-acp/src/zcode-backend.mjs'

const root = mkdtempSync(join(tmpdir(), 'trellis-zcode-provider-source-'))
const home = join(root, 'home')
const active = join(root, 'active desktop data')
const isolated = join(root, 'isolated')
for (const directory of [home, active, isolated]) mkdirSync(join(directory, '.zcode', 'v2'), { recursive: true })
const bootstrap = join(home, '.zcode', 'v2', 'setting.json')
const primary = join(active, '.zcode', 'v2', 'provider_config.json')
const document = { schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: 'active-kimi', enabled: true }] },
  modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }
writeFileSync(primary, JSON.stringify(document))
const stalePath = join(home, '.zcode', 'v2', 'config.json')
writeFileSync(stalePath, JSON.stringify({ provider: { 'stale-mimo': { options: { apiKey: 'SECRET-FIXTURE' } } } }))
writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: active }))
const envFor = () => ({ USERPROFILE: home, HOME: home })
try {
  const env = envFor()
  const resolved = resolveProviderEnvironment(env)
  assert.equal(resolved.source, 'bootstrap')
  assert.equal(env.ZCODE_DATA_BASE_DIR, active)
  assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, primary)
  assert.equal(JSON.parse(readFileSync(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8')).config.providerConfigRules.providerRules[0].providerId, 'active-kimi')
  assert.ok(!JSON.stringify(env).includes('SECRET-FIXTURE'))
  resolved.verify()
  resolved.assertCurrent()
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: active, desktopZoomLevel: 1.1 }))
  resolved.assertCurrent() // Unrelated live UI settings must not change the captured source.
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: active }))
  assert.equal(JSON.parse(readFileSync(stalePath, 'utf8')).provider['stale-mimo'].options.apiKey, 'SECRET-FIXTURE')

  const explicit = { ...envFor(), ZCODE_DATA_BASE_DIR: isolated, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: primary }
  assert.equal(resolveProviderEnvironment(explicit).source, 'environment')
  assert.equal(explicit.ZCODE_DATA_BASE_DIR, isolated)
  assert.equal(explicit.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, primary)
  const isolation = { ...env }
  resolveProviderEnvironment(isolation, { isolatedDir: isolated })
  assert.equal(isolation.ZCODE_DATA_BASE_DIR, isolated)
  assert.equal(isolation.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, join(isolated, '.zcode', 'v2', 'provider_config.json'))
  const zcodeHome = { ...envFor(), ZCODE_HOME: join(active, '.zcode') }
  assert.equal(resolveProviderEnvironment(zcodeHome).dataBaseDir, active)

  writeFileSync(bootstrap, '{ malformed')
  assert.throws(() => resolveProviderEnvironment(envFor()), /invalid.*no legacy fallback/)
  const overrideMalformed = { ...envFor(), ZCODE_DATA_BASE_DIR: active }
  assert.equal(resolveProviderEnvironment(overrideMalformed).source, 'environment')
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: 'relative' }))
  assert.throws(() => resolveProviderEnvironment(envFor()), /absolute/)
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: join(root, 'missing-root') }))
  assert.throws(() => resolveProviderEnvironment(envFor()), /unavailable.*no legacy fallback/)
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: active }))
  const drift = resolveProviderEnvironment(envFor())
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: isolated }))
  assert.throws(() => drift.verify(), /bootstrap changed/)
  assert.throws(() => drift.assertCurrent(), /配置数据目录已变化/)
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: active }))
  unlinkSync(bootstrap)
  const formerHome = resolveProviderEnvironment(envFor())
  assert.equal(formerHome.source, 'home')
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: active }))
  assert.throws(() => formerHome.assertCurrent(), /配置数据目录已变化/)
  const providerDrift = resolveProviderEnvironment(envFor())
  writeFileSync(primary, JSON.stringify({ ...document, changed: true }))
  assert.throws(() => providerDrift.verify(), /provider configuration changed/)
  assert.throws(() => providerDrift.assertCurrent(), /原生模型配置已变化/)
  writeFileSync(primary, '{ malformed SECRET-FIXTURE')
  assert.throws(() => resolveProviderEnvironment(envFor()), /invalid.*no legacy fallback/)
  writeFileSync(primary, JSON.stringify({ ...document, schemaVersion: 99 }))
  assert.throws(() => resolveProviderEnvironment(envFor()), /schema.*unsupported.*no legacy fallback/)
  writeFileSync(primary, JSON.stringify(document))

  // appServerEnv must preserve explicit paired overrides; isolated mode redirects OS state.
  const beforeBuiltin = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  try {
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = join(root, 'explicit-builtin.json')
    assert.equal(appServerEnv('not-a-real-cli', isolated).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE)
  } finally {
    if (beforeBuiltin === undefined) delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
    else process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = beforeBuiltin
  }
  console.log('PASS provider source: active custom root, stale legacy exclusion, explicit/isolation precedence, malformed/missing/drifting source rejection; no credential copying')
} finally { rmSync(root, { recursive: true, force: true }) }
