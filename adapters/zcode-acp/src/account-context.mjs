/**
 * ZCode 0.16.9 / desktop 3.15.3 BigModel individual-account host port.
 * Reuses only the current desktop account's existing native API key. No login,
 * key creation, credential/config writes, legacy hydration or auth substitution.
 * The subscription GET is authoritative; coding-plan-cache.json is not.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { homedir, platform, userInfo } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const PROVIDER = 'account:bigmodel-individual-coding-plan'
const METHOD = 'interaction/requestProviderRuntimeHeaders'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const VALIDATION_TTL_MS = 30_000
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value.trim() : ''
const hash = value => createHash('sha256').update(value).digest('hex')
const failure = code => Object.assign(new Error(`ZCode BigModel account unavailable (${code})`), { code })

async function readJson(path, optional = false) {
  let file
  try {
    file = await open(path, 'r')
    if (!(await file.stat()).isFile()) throw failure('account_file_invalid')
    // Bound the read itself, including a file which grows after stat().
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_FILE_BYTES) throw failure('account_file_oversized')
    const result = JSON.parse(bytes.subarray(0, length).toString('utf8').replace(/^\uFEFF/, ''))
    if (!record(result)) throw failure('account_file_invalid')
    return result
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return {}
    // Never retain JSON parse errors, filesystem paths, raw keys, or causes.
    throw failure('account_file_unavailable')
  } finally { await file?.close() }
}

function cipherKey(env) {
  let username = 'unknown'
  try { username = userInfo().username } catch { /* Native cipher's documented fallback. */ }
  return createHash('sha256').update(env.ZCODE_CREDENTIAL_SECRET ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${username}`).digest()
}

function decrypt(value, key) {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw failure('credential_invalid')
  if (!value.startsWith('enc:')) return value
  if (!value.startsWith('enc:v1:')) throw failure('credential_invalid')
  const parts = value.slice(7).split('.')
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw failure('credential_invalid')
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, 'base64url'))
  if (iv.length !== 12 || tag.length !== 16) throw failure('credential_invalid')
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, iv)
    cipher.setAuthTag(tag)
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8')
  } catch { throw failure('credential_invalid') }
}

function assertNotExpired(token, now) {
  if (!token || /[\r\n]/.test(token)) throw failure('credential_missing')
  // Native stored API keys and login tokens may be opaque. JWT expiry, when
  // present, can reject a cache; absence of exp cannot establish entitlement.
  if (token.split('.').length !== 3) return
  let payload
  try { payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) }
  catch { throw failure('credential_invalid') }
  if (payload.exp !== undefined && (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp * 1000 <= now)) {
    throw failure('credential_expired')
  }
}

function settingsScope(settings) {
  if (settings.providerFamilyDomain !== 'bigmodel' || settings.providerFamilyConnectionSelections?.bigmodel?.kind !== 'individual-coding-plan') {
    throw failure('account_not_current')
  }
  return ['bigmodel', 'individual-coding-plan', null]
}

async function material(dataBaseDir, settingsPath, env, now) {
  const settings = await readJson(settingsPath, true)
  const scope = settingsScope(settings)
  const credentials = await readJson(join(dataBaseDir, '.zcode', 'v2', 'credentials.json'), true)
  const key = cipherKey(env)
  const load = name => text(decrypt(credentials[name], key))
  if (load('oauth:active_provider') !== 'bigmodel') throw failure('account_not_current')
  const oauth = load('oauth:bigmodel:access_token')
  const jwt = load('zcodejwttoken')
  assertNotExpired(oauth, now)
  if (oauth === jwt) throw failure('credential_invalid')
  let profile
  try { profile = JSON.parse(load('oauth:bigmodel:user_info')) }
  catch { throw failure('account_profile_invalid') }
  if (!record(profile) || !text(profile.id) || typeof profile.username !== 'string' || typeof profile.displayName !== 'string') {
    throw failure('account_profile_invalid')
  }
  const apiKey = load(`account-provider:coding-plan:${PROVIDER}:account:${encodeURIComponent(profile.id)}:api-key`)
  assertNotExpired(apiKey, now)
  // Same exact scope construction as the installed desktop request-auth port.
  const accountScope = hash(JSON.stringify([...scope, oauth, jwt || null]))
  return { apiKey, accountScope, fingerprint: hash(JSON.stringify([profile.id, accountScope, apiKey])) }
}

async function catalogue(builtinPath, builtinActivePath) {
  const value = await readJson(builtinPath)
  const rules = value.config?.providerConfigRules?.providerRules
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(rules)) {
    throw failure('builtin_schema_unsupported')
  }
  const accounts = rules.filter(rule => record(rule) && rule.config?.access?.type === 'zhipu-account')
  if (accounts.length > 64 || new Set(accounts.map(rule => rule.providerId)).size !== accounts.length || accounts.some(rule => !text(rule.providerId))) {
    throw failure('builtin_schema_unsupported')
  }
  const supported = accounts.find(rule => rule.providerId === PROVIDER)
  if (supported && (supported.config.access.accountType !== 'bigmodel' || supported.config.access.mode !== 'individual-coding-plan')) {
    throw failure('builtin_schema_unsupported')
  }
  return { accounts, supported: !!supported, signature: hash(JSON.stringify(value)),
    revision: `zcode-builtin:${value.revision}:${hash(resolve(builtinActivePath))}` }
}

function originFromEnv(env) {
  // Only documented BigModel API overrides; never a model API/proxy endpoint.
  const test = text(env.ZCODE_ENV).toLowerCase() === 'test'
  const url = new URL(env.BIGMODEL_API_BASE_URL ||
    (test ? env.BIGMODEL_TEST_API_BASE_URL : env.BIGMODEL_PRODUCTION_API_BASE_URL) ||
    (test ? 'https://dev.bigmodel.cn' : 'https://bigmodel.cn'))
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw failure('account_endpoint_invalid')
  }
  return url.origin
}

async function verifySubscription(apiKey, env, signal) {
  let response
  try {
    response = await fetch(`${originFromEnv(env)}/api/biz/subscription/list`, {
      method: 'GET', headers: { Authorization: apiKey }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    })
    if (!response.ok) throw failure('subscription_unavailable')
    const reader = response.body?.getReader()
    if (!reader) throw failure('subscription_invalid')
    const chunks = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_RESPONSE_BYTES) throw failure('subscription_invalid')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!record(envelope) || envelope.success === false ||
      (envelope.code !== undefined && envelope.code !== 0 && envelope.code !== 200) || !Array.isArray(envelope.data)) {
      throw failure('subscription_invalid')
    }
    // Exact installed personal-plan predicate. A cache status/key alone never
    // activates a provider; unknown/malformed products do not become entitled.
    return envelope.data.some(item => record(item) && item.status === 'VALID' && item.inCurrentPeriod === true &&
      [item.productId, item.productName].some(name => typeof name === 'string' && name.toLowerCase().includes('coding')))
  } catch { throw failure('subscription_unavailable') }
}

/**
 * sync() must run after native storage readiness and before session/create/load.
 * bindSession() admits the acknowledged native ID/workspace before a turn.
 * handleRequest() returns synchronously so the transport does not also reply.
 * Never log reply results: requestAuth contains the native credential.
 */
export function createAccountContext({ dataBaseDir, builtinPath, builtinActivePath = builtinPath, env = process.env, settingsPath } = {}) {
  if (!isAbsolute(dataBaseDir || '') || !isAbsolute(builtinPath || '')) throw failure('account_paths_invalid')
  if (!isAbsolute(builtinActivePath || '')) throw failure('account_paths_invalid')
  settingsPath ??= join(env.ZCODE_DESKTOP_HOME_DIR || env.HOME || env.USERPROFILE || homedir(), '.zcode', 'v2', 'setting.json')
  if (!isAbsolute(settingsPath)) throw failure('account_paths_invalid')
  const environment = { ...env }
  const sessions = new Map()
  const abort = new AbortController()
  let state
  let disposed = false
  let syncing
  let epoch = 0

  const assertCurrent = version => { if (disposed || version !== epoch) throw failure('account_scope_changed') }
  const denied = () => ({ headersApplied: false, errorMessage: 'ZCode BigModel account is unavailable; refresh the current account explicitly.' })

  async function sync(backend) {
    if (disposed) throw failure('account_disposed')
    if (syncing) return syncing
    const version = ++epoch
    state = undefined
    syncing = (async () => {
      const config = await catalogue(builtinPath, builtinActivePath)
      let current
      let entitled = false
      let reason = 'account_unsupported'
      if (config.supported) {
        try {
          current = await material(dataBaseDir, settingsPath, environment, Date.now())
          entitled = await verifySubscription(current.apiKey, environment, abort.signal)
          const latest = await material(dataBaseDir, settingsPath, environment, Date.now())
          if (latest.fingerprint !== current.fingerprint) throw failure('account_scope_changed')
          reason = entitled ? 'verified' : 'not_entitled'
        } catch (error) { current = undefined; entitled = false; reason = error?.code || 'account_unavailable' }
      }
      assertCurrent(version)
      const latestConfig = await catalogue(builtinPath, builtinActivePath)
      if (latestConfig.revision !== config.revision || latestConfig.signature !== config.signature) throw failure('builtin_changed')
      const providers = Object.fromEntries(config.accounts.map(rule => [rule.providerId,
        { access: { type: 'zhipu-account', entitled: entitled && rule.providerId === PROVIDER } }]))
      const states = Object.fromEntries(config.accounts.map(rule => [rule.providerId, {
        availability: entitled && rule.providerId === PROVIDER ? 'available' : 'unavailable',
        entitled: entitled && rule.providerId === PROVIDER,
        current: !!current && rule.providerId === PROVIDER
      }]))
      const snapshot = { revision: `trellis-account:${hash(JSON.stringify([config.revision, providers, states, current?.fingerprint]))}`,
        basedOnZCodeBuiltinRevision: config.revision, providers, states }
      let acknowledgement
      try { acknowledgement = await backend.request('provider/updateAccountConfig', snapshot) }
      catch { throw failure('account_sync_failed') }
      assertCurrent(version)
      if (acknowledgement?.receivedRevision !== snapshot.revision || !['received', 'unchanged'].includes(acknowledgement?.status)) {
        throw failure('account_sync_unacknowledged')
      }
      state = entitled && current ? { ...current, configSignature: config.signature, checkedAt: Date.now() } : undefined
      return { status: state ? 'verified' : 'unavailable', reason }
    })()
    try { return await syncing } finally { syncing = undefined }
  }

  async function runtimeAuth(params) {
    const version = epoch
    const active = state
    const bound = sessions.get(params?.sessionId)
    if (!active || !bound || syncing || !record(params) || params.providerId !== PROVIDER ||
      params.modelSelection?.providerId !== PROVIDER || !text(params.modelSelection?.modelId) ||
      !record(params.workspace) || resolve(params.workspace.workspacePath || '') !== bound.path || params.workspace.workspaceKey !== bound.key ||
      params.accountAccess?.type !== 'zhipu-account' || params.accountAccess.accountType !== 'bigmodel' ||
      params.accountAccess.mode !== 'individual-coding-plan' || params.accountAccess.entitled !== true ||
      (params.expectedAccountScope !== undefined && params.expectedAccountScope !== active.accountScope) ||
      (params.rejectedProjectTokenFingerprint !== undefined &&
        (!params.expectedAccountScope || params.rejectedProjectTokenFingerprint === hash(active.apiKey)))) return denied()
    const latest = await material(dataBaseDir, settingsPath, environment, Date.now())
    if (latest.fingerprint !== active.fingerprint) throw failure('account_scope_changed')
    if ((await catalogue(builtinPath, builtinActivePath)).signature !== active.configSignature) throw failure('builtin_changed')
    if (Date.now() - active.checkedAt >= VALIDATION_TTL_MS) {
      if (!await verifySubscription(latest.apiKey, environment, abort.signal)) throw failure('not_entitled')
      active.checkedAt = Date.now()
    }
    const after = await material(dataBaseDir, settingsPath, environment, Date.now())
    assertCurrent(version)
    if (after.fingerprint !== active.fingerprint || state !== active || sessions.get(params.sessionId) !== bound) throw failure('account_scope_changed')
    return { headersApplied: true, requestAuth: { apiKey: latest.apiKey, accountScope: latest.accountScope } }
  }

  return {
    sync,
    bindSession(sessionId, workspace) {
      if (disposed || !text(sessionId) || !isAbsolute(workspace?.workspacePath || '') || !text(workspace.workspaceKey)) throw failure('account_session_invalid')
      sessions.clear() // One native session per adapter/backend owner.
      sessions.set(sessionId, { path: resolve(workspace.workspacePath), key: workspace.workspaceKey })
    },
    unbindSession(sessionId) { sessions.delete(sessionId) },
    handleRequest(method, params, reply, _replyError) {
      if (method !== METHOD) return false
      void Promise.resolve().then(() => runtimeAuth(params)).catch(() => denied()).then(reply).catch(() => {})
      return true
    },
    dispose() { disposed = true; ++epoch; state = undefined; sessions.clear(); abort.abort() }
  }
}
