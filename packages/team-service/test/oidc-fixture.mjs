/** A real standards-based OIDC server, owned test accounts/keys only. Never imported by production. */
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import Provider from 'oidc-provider'

export async function freePort() {
  const server = createTcpServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Owned listener did not return a port')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

export async function createOidcFixture(teamOrigin) {
  const issuer = `http://127.0.0.1:${await freePort()}`
  const accounts = new Map([['alice', { password: 'alice-owned-fixture', name: 'Alice Product and PM' }], ['bob', { password: 'bob-owned-fixture', name: 'Bob Development and QA' }]])
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'owned-fixture-key', use: 'sig', alg: 'RS256' }
  const provider = new Provider(issuer, {
    clients: [{ client_id: 'team-owned-fixture', redirect_uris: [`${teamOrigin}/auth/callback`], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' }],
    cookies: { keys: [randomBytes(32).toString('hex')] }, jwks: { keys: [jwk] },
    features: { devInteractions: { enabled: false } },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    claims: { openid: ['sub'], profile: ['name'] },
    findAccount: async (_ctx, accountId) => accounts.has(accountId) ? { accountId, claims: async () => ({ sub: accountId, name: accounts.get(accountId).name }) } : undefined
  })
  const callback = provider.callback()
  const observations = { logins: [], grants: [], authorizationRequests: [] }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', issuer)
      if (!url.pathname.startsWith('/interaction/')) { if (url.pathname === '/auth') observations.authorizationRequests.push({ challengeMethod: url.searchParams.get('code_challenge_method'), hasChallenge: !!url.searchParams.get('code_challenge'), hasState: !!url.searchParams.get('state'), hasNonce: !!url.searchParams.get('nonce') }); return callback(request, response) }
      const interaction = await provider.interactionDetails(request, response)
      if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ uid: interaction.uid, prompt: interaction.prompt.name })) }
      if (request.method !== 'POST') { response.statusCode = 405; return response.end() }
      let body = ''; for await (const chunk of request) { body += chunk.toString(); if (body.length > 1024) throw Error('Fixture input too large') }
      const form = new URLSearchParams(body)
      if (interaction.prompt.name === 'login') {
        const accountId = form.get('account'); const account = accounts.get(accountId)
        if (!account || form.get('password') !== account.password) { response.statusCode = 403; return response.end('Fixture account rejected') }
        const grant = new provider.Grant({ accountId, clientId: String(interaction.params.client_id) }); grant.addOIDCScope('openid profile')
        const grantId = await grant.save(); observations.logins.push(accountId); observations.grants.push(grantId)
        return provider.interactionFinished(request, response, { login: { accountId }, consent: { grantId } }, { mergeWithLastSubmission: false })
      }
      if (interaction.prompt.name === 'consent') {
        const accountId = interaction.session?.accountId
        if (!accountId || form.get('approve') !== 'yes') { response.statusCode = 403; return response.end('Fixture consent rejected') }
        const grant = interaction.grantId ? await provider.Grant.find(interaction.grantId) : new provider.Grant({ accountId, clientId: String(interaction.params.client_id) })
        if (!grant) throw Error('Fixture grant unavailable')
        grant.addOIDCScope('openid profile'); const grantId = await grant.save(); observations.grants.push(grantId)
        return provider.interactionFinished(request, response, { consent: { grantId } }, { mergeWithLastSubmission: true })
      }
      throw Error('Unexpected fixture interaction')
    })().catch((error) => { response.statusCode = 500; response.end('Owned identity fixture failed'); console.error(error) })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(new URL(issuer).port, '127.0.0.1', resolve) })
  return { issuer: provider.issuer, observations, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) } }
}

export class BrowserAccount {
  cookies = new Map()
  csrf = null
  constructor(origin, account) { this.origin = origin; this.account = account }
  async request(url, init = {}) {
    const address = new URL(url, this.origin); const headers = new Headers(init.headers)
    const stored = this.cookies.get(address.hostname) ?? new Map()
    if (stored.size) headers.set('cookie', [...stored].map(([key, value]) => `${key}=${value}`).join('; '))
    const response = await fetch(address, { ...init, headers, redirect: 'manual' })
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(';', 1)[0]; const split = first.indexOf('='); const key = first.slice(0, split); const value = first.slice(split + 1)
      if (/max-age=0(?:;|$)/i.test(cookie)) stored.delete(key); else stored.set(key, value)
    }
    this.cookies.set(address.hostname, stored)
    return response
  }
  async signIn() {
    let url = new URL('/auth/login?returnTo=/', this.origin)
    let response = await this.request(url)
    for (let count = 0; count < 20; count++) {
      const location = response.headers.get('location')
      if (location && response.status >= 300 && response.status < 400) { url = new URL(location, url); response = await this.request(url); continue }
      if (url.pathname.startsWith('/interaction/') && response.status === 200) {
        const details = await response.json()
        const form = details.prompt === 'login' ? { account: this.account, password: `${this.account}-owned-fixture` } : { approve: 'yes' }
        response = await this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }); continue
      }
      if (url.origin === this.origin && response.status === 200) {
        const session = await this.api('/api/session')
        if (session.status !== 200 || !session.body.ok) throw Error(`Fixture sign-in failed at session: ${JSON.stringify(session.body)}`)
        this.csrf = session.body.value.csrfToken
        return session.body.value
      }
      throw Error(`Fixture OIDC flow failed at ${url.pathname}: ${response.status} ${await response.text()}`)
    }
    throw Error('Fixture OIDC flow exceeded redirect bound')
  }
  async api(path, body, headers = {}) {
    const response = await this.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: this.origin, 'X-CSRF-Token': this.csrf ?? '' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
}
