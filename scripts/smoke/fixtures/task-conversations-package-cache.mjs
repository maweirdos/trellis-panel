import assert from 'node:assert/strict'

export async function exercisePackageCache(api) {
  const { createCodexPackageProbeCache: createCache, CODEX_PACKAGE_FAMILY: family,
    CODEX_PACKAGE_PROBE_POSITIVE_TTL_MS: positiveTtl, CODEX_PACKAGE_PROBE_NEGATIVE_TTL_MS: negativeTtl } = api
  let checks = 0, now = 1000, reads = 0
  const completions = []
  const cache = createCache(() => { reads++; return new Promise((resolve, reject) => completions.push({ resolve, reject })) }, () => now)
  const first = cache.read(), concurrent = cache.read()
  assert.equal(first, concurrent, 'concurrent capability reads coalesce'); checks++
  await Promise.resolve()
  assert.equal(reads, 1); checks++
  completions.shift().resolve({ packageFamilyName: family })
  const verified = await first
  assert.equal(verified.packageFamilyName, family); checks++
  assert.equal(Reflect.set(verified, 'packageFamilyName', 'arbitrary.app'), false, 'cached identity cannot be changed by a consumer'); checks++
  now += positiveTtl - 1
  assert.equal(await cache.read(), verified); checks++
  assert.equal(reads, 1, 'five-second polling does not repeat package/signature checks during positive TTL'); checks++
  now++
  const expired = cache.read()
  await Promise.resolve()
  assert.equal(reads, 2, 'positive TTL expires at its bound'); checks++
  completions.shift().resolve(null)
  assert.equal(await expired, null); checks++
  now += negativeTtl - 1
  assert.equal(await cache.read(), null); checks++
  assert.equal(reads, 2, 'negative cache prevents repeated failed helper calls'); checks++
  now++
  const failing = cache.read()
  await Promise.resolve()
  completions.shift().reject(Error('missing package'))
  assert.equal(await failing, null, 'probe exceptions become bounded negative results'); checks++
  assert.equal(await cache.read(), null); checks++
  assert.equal(reads, 3); checks++
  cache.invalidate()
  const oldRead = cache.read()
  await Promise.resolve()
  cache.invalidate()
  assert.equal(cache.read(), oldRead, 'invalidation never starts a second simultaneous helper'); checks++
  completions.shift().resolve({ packageFamilyName: family })
  assert.equal(await oldRead, null, 'invalidated in-flight success is discarded'); checks++
  const newRead = cache.read()
  await Promise.resolve()
  completions.shift().resolve({ packageFamilyName: 'arbitrary.app' })
  assert.equal(await newRead, null, 'a loader cannot cache a different package identity'); checks++
  assert.equal(reads, 5); checks++
  return checks
}

/** Uses a bundled child_process replacement; never starts PowerShell or a client. */
export async function exercisePackageBroker(api) {
  let checks = 0, probes = 0, launches = 0
  const { CODEX_PACKAGE_FAMILY: family } = api
  let response = JSON.stringify({ launched: true })
  let fail = false
  const calls = []
  globalThis.__taskConversationsPackageExecute = async (executable, args, options) => {
    const script = Buffer.from(args[4], 'base64').toString('utf16le')
    calls.push({ executable, args, options, script })
    if (script.includes('::LaunchUriAsync(')) {
      launches++
      if (fail) throw Error('package uninstalled or broker rejected')
      return { stdout: response, stderr: '' }
    }
    probes++
    return { stdout: JSON.stringify({ packageFamilyName: family, verified: true }), stderr: '' }
  }
  try {
    await Promise.all([api.probeCodexPackage(), api.probeCodexPackage(), api.probeCodexPackage()])
    assert.equal(probes, 1, 'production probe wiring coalesces its actual helper boundary'); checks++
    await api.probeCodexPackage()
    assert.equal(probes, 1, 'production probe wiring reuses positive cache'); checks++
    const target = { kind: 'packaged-protocol', source: 'codex', packageFamilyName: family, cwd: 'C:\\project', url: 'codex://threads/11111111-2222-3333-4444-555555555555' }
    await api.launchCodexPackage(target)
    assert.equal(launches, 1); checks++
    const acceptedCall = calls.at(-1)
    assert.equal(acceptedCall.options.timeout, 8000); checks++
    assert.equal(acceptedCall.options.windowsHide, true); checks++
    assert.ok(acceptedCall.script.includes("TargetApplicationPackageFamilyName='" + family + "'")); checks++
    response = JSON.stringify({ launched: false })
    await assert.rejects(() => api.launchCodexPackage(target), error => error.code === 'E_UNAVAILABLE'); checks++
    await api.probeCodexPackage()
    assert.equal(probes, 2, 'broker false invalidates an optimistic cached read capability'); checks++
    fail = true
    await assert.rejects(() => api.launchCodexPackage(target), error => error.code === 'E_UNAVAILABLE'); checks++
    await api.probeCodexPackage()
    assert.equal(probes, 3, 'missing/uninstalled package errors invalidate cached capability'); checks++
    fail = false; response = '{}'
    await assert.rejects(() => api.launchCodexPackage(target), error => error.code === 'E_UNAVAILABLE'); checks++
    const beforeInvalid = calls.length
    await assert.rejects(() => api.launchCodexPackage({ ...target, packageFamilyName: 'arbitrary.app' }), error => error.code === 'E_INVALID_ARG'); checks++
    assert.equal(calls.length, beforeInvalid, 'wrong package identity fails before any helper dispatch'); checks++
    return checks
  } finally { delete globalThis.__taskConversationsPackageExecute }
}
