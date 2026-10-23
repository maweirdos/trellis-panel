import { execFile } from 'node:child_process'
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { nativeResource, powershellPath } from './native'
import { readBounded, writeExclusiveAtomic } from './files'
import { DaemonError } from './errors'
import type { ProtectedStoragePort } from './protected-storage'

const MAX_WRAPPED_KEY_BYTES = 16384
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024
// The DingTalk repository admits 16 MiB of clear JSON, plus this envelope.
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 32
const keyFileSchema = z.object({ version: z.literal(1), profileId: z.string().regex(/^[a-f0-9]{64}$/), ciphertext: z.string().min(1).max(24000) }).strict()
const resultSchema = z.object({ version: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{64}$/), operation: z.enum(['protect', 'unprotect']), ok: z.literal(true), value: z.string().min(1).max(24000) }).strict()
const MARKER = Buffer.from('TPD1')
const LEGACY_MARKER = Buffer.from('v10')
export function decodeProtectedCiphertext(value: string, limit = MAX_CIPHERTEXT_BYTES): Buffer {
  if (value.length > Math.ceil(limit / 3) * 4) throw new DaemonError('E_DENIED', 'Native protection encoding exceeds its capacity.')
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== value) {
    bytes.fill(0)
    throw new DaemonError('E_DENIED', 'Native protection encoding is invalid; preserve the original data.')
  }
  return bytes
}
/** Tiny private stdin/stdout channel for OS protection of 32-byte keys only. */
async function dpapi(operation: 'protect' | 'unprotect', value: Buffer, entropy: string): Promise<Buffer> {
  if (process.platform !== 'win32' || !/^(?:[a-f0-9]{64})?$/.test(entropy) || !value.length || value.length > MAX_WRAPPED_KEY_BYTES || (operation === 'protect' && (value.length !== 32 || !entropy))) throw new DaemonError('E_DENIED', 'Invalid native key protection request.')
  const nonce = randomBytes(32).toString('hex')
  return new Promise((resolve, reject) => {
    const child = execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeResource('windows-protection.ps1'), '-Operation', operation], { windowsHide: true, timeout: 7000, maxBuffer: 32 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(new DaemonError('E_DENIED', 'Windows CurrentUser key protection failed; no credential was replaced.')); return }
      try {
        const frame = stdout.replace(/^\uFEFF/, '')
        if (!/^\{"version":1,"nonce":"[a-f0-9]{64}","operation":"(?:protect|unprotect)","ok":true,"value":"[A-Za-z0-9+/]+={0,2}"\}(?:\r?\n)?(?![\s\S])/.test(frame)) throw new Error('Invalid protection frame')
        const result = resultSchema.parse(JSON.parse(frame))
        if (result.nonce !== nonce || result.operation !== operation) throw new Error('Mismatched protection response')
        const bytes = decodeProtectedCiphertext(result.value, MAX_WRAPPED_KEY_BYTES)
        if (operation === 'unprotect' && bytes.length !== 32) { bytes.fill(0); throw new Error('Invalid key length') }
        resolve(bytes)
      }
      catch { reject(new DaemonError('E_DENIED', 'The native key protection acknowledgement is invalid.')) }
    })
    child.stdin?.on('error', () => { /* Completion remains owned by the exec callback. */ })
    const request = Buffer.from(JSON.stringify({ version: 1, nonce, operation, value: value.toString('base64'), entropy }) + '\n', 'utf8')
    if (!child.stdin) { request.fill(0); child.kill(); reject(new DaemonError('E_UNAVAILABLE', 'The private native protection channel is unavailable.')); return }
    child.stdin.end(request, () => { request.fill(0) })
    child.once('close', () => { request.fill(0) })
  })
}

/** Clear even unauthenticated update output when GCM final rejects a tag. */
function decryptGcm(key: Buffer, nonce: Buffer, tag: Buffer, ciphertext: Buffer, aad?: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  if (aad) decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  const first = decipher.update(ciphertext)
  let last: Buffer | undefined
  try { last = decipher.final(); return Buffer.concat([first, last]) }
  finally { first.fill(0); last?.fill(0) }
}

type ProfileKeys = { key?: Buffer; fingerprint?: string; compromised?: true; loading?: Promise<void>; publishing?: Promise<void>; legacyLoading?: Promise<void>; legacy: Map<string, Buffer> }
// Context recreation in a process must not unwrap the same immutable key again.
const profiles = new Map<string, ProfileKeys>()

/** One immutable per-profile key, OS wrapped independently of Electron's role
 * Local State. Historical keys are read-only compatibility inputs, never copied. */
export class NativeProtection implements ProtectedStoragePort {
  private readonly keys: ProfileKeys
  constructor(private readonly directory: string, private readonly userData: string, private readonly profileId: string) {
    if (!/^[a-f0-9]{64}$/.test(profileId)) throw new DaemonError('E_DENIED', 'Native protection requires a canonical profile identity.')
    const id = `${directory}\0${profileId}`
    const cached = profiles.get(id)
    this.keys = cached ?? { legacy: new Map<string, Buffer>() }
    if (!cached) profiles.set(id, this.keys)
  }
  async initialize(): Promise<void> { await this.refresh() }
  async refresh(): Promise<void> {
    this.assertAuthority()
    if (this.keys.loading) return this.keys.loading
    this.keys.loading = (async () => {
      const file = join(this.directory, 'native-protection-key-v1.json')
      if (!existsSync(file)) {
        if (this.keys.fingerprint) this.closeAuthority()
        return
      }
      let text: string
      try { text = readBounded(file, 32 * 1024) }
      catch (error) { if (this.keys.fingerprint) this.closeAuthority(); throw error }
      const digest = createHash('sha256').update(text).digest('hex')
      if (this.keys.fingerprint) {
        if (this.keys.fingerprint !== digest) this.closeAuthority()
        return
      }
      const stored = keyFileSchema.parse(JSON.parse(text))
      if (stored.profileId !== this.profileId) throw new DaemonError('E_DENIED', 'The protected key belongs to another native profile.')
      const sealed = decodeProtectedCiphertext(stored.ciphertext, MAX_WRAPPED_KEY_BYTES)
      let key: Buffer | undefined
      try {
        key = await dpapi('unprotect', sealed, this.profileId)
        if (readBounded(file, 32 * 1024) !== text) throw new DaemonError('E_CONFLICT', 'The protected key changed during native preparation.')
        this.keys.key = key; this.keys.fingerprint = digest; key = undefined
      } finally { sealed.fill(0); key?.fill(0) }
    })()
    try { await this.keys.loading } finally { this.keys.loading = undefined }
  }
  async ensure(assertOwner: () => void): Promise<void> {
    assertOwner()
    await this.refresh()
    assertOwner()
    if (this.keys.key) return
    if (this.keys.publishing) { await this.keys.publishing; assertOwner(); return }
    this.keys.publishing = (async () => {
      const key = randomBytes(32)
      let sealed: Buffer | undefined
      try {
        sealed = await dpapi('protect', key, this.profileId)
        const text = JSON.stringify(keyFileSchema.parse({ version: 1, profileId: this.profileId, ciphertext: sealed.toString('base64') }))
        assertOwner()
        writeExclusiveAtomic(join(this.directory, 'native-protection-key-v1.json'), text)
        this.keys.key = Buffer.from(key); this.keys.fingerprint = createHash('sha256').update(text).digest('hex')
      } finally { key.fill(0); sealed?.fill(0) }
    })()
    try { await this.keys.publishing } finally { this.keys.publishing = undefined }
  }
  /** Async admission only for actual v10 ciphertext; synchronous consumers run
   * after this barrier. Modern projection reads never open historical metadata. */
  async prepare(value: Buffer): Promise<void> {
    this.assertCiphertext(value)
    if (value.subarray(0, 4).equals(MARKER)) {
      if (!this.keys.key) throw new DaemonError('E_UNAVAILABLE', 'The shared native key is not prepared.')
      return
    }
    if (this.canDecryptLegacy(value)) return
    if (this.keys.legacyLoading) { await this.keys.legacyLoading; return this.prepare(value) }
    this.keys.legacyLoading = this.loadLegacy(value)
    try { await this.keys.legacyLoading } finally { this.keys.legacyLoading = undefined }
  }
  private async loadLegacy(value: Buffer): Promise<void> {
    const files = [join(this.userData, 'Local State'), join(this.directory, 'gui', 'Local State'), join(this.directory, 'daemon', 'Local State')]
    for (const file of files) {
      if (!existsSync(file)) continue
      // A broken unrelated role key must not prevent an authenticated match in
      // another role. No successful match still fails closed below.
      try {
        const raw = z.object({ os_crypt: z.object({ encrypted_key: z.string().max(24000).optional() }).passthrough().optional() }).passthrough().parse(JSON.parse(readBounded(file, 2 * 1024 * 1024)))
        if (!raw.os_crypt?.encrypted_key) continue
        const sealed = decodeProtectedCiphertext(raw.os_crypt.encrypted_key, MAX_WRAPPED_KEY_BYTES + 5)
        try {
          if (!sealed.subarray(0, 5).equals(Buffer.from('DPAPI'))) continue
          const digest = createHash('sha256').update(sealed).digest('hex')
          if (!this.keys.legacy.has(digest)) {
            const key = await dpapi('unprotect', sealed.subarray(5), '')
            try { this.assertAuthority(); this.keys.legacy.set(digest, key) }
            catch (error) { key.fill(0); throw error }
          }
        } finally { sealed.fill(0) }
        if (this.canDecryptLegacy(value)) return
      } catch { /* Only a verified GCM match can authorize this credential. */ }
    }
    throw new DaemonError('E_DENIED', 'No authorized historical key can decrypt this credential; preserve its ciphertext and original Local State files for recovery.')
  }
  private canDecryptLegacy(value: Buffer): boolean {
    for (const key of this.keys.legacy.values()) {
      try { const plaintext = decryptGcm(key, value.subarray(3, 15), value.subarray(-16), value.subarray(15, -16)); plaintext.fill(0); return true }
      catch { /* Try only known historical keys. */ }
    }
    return false
  }
  private assertCiphertext(value: Buffer): void {
    this.assertAuthority()
    if (value.length > MAX_CIPHERTEXT_BYTES || !((value.subarray(0, 4).equals(MARKER) && value.length >= 32) || (value.subarray(0, 3).equals(LEGACY_MARKER) && value.length >= 31))) throw new DaemonError('E_DENIED', 'Native ciphertext header or capacity is invalid; no plaintext fallback is allowed.')
  }
  private assertAuthority(): void {
    if (this.keys.compromised) throw new DaemonError('E_CONFLICT', 'The native protection key changed or disappeared; cached credential authority is closed until process restart and explicit recovery.')
  }
  private closeAuthority(): never {
    this.keys.compromised = true
    this.keys.key?.fill(0); this.keys.key = undefined
    for (const key of this.keys.legacy.values()) key.fill(0)
    this.keys.legacy.clear()
    throw new DaemonError('E_CONFLICT', 'The native protection key changed or disappeared; cached credential authority is closed until process restart and explicit recovery.')
  }
  available(): boolean { return !this.keys.compromised && Boolean(this.keys.key) }
  encrypt(value: string): Buffer {
    this.assertAuthority()
    if (!this.keys.key) throw new DaemonError('E_UNAVAILABLE', 'The shared native protection owner is not ready; no plaintext fallback is allowed.')
    if (Buffer.byteLength(value, 'utf8') > MAX_CIPHERTEXT_BYTES - 32) throw new DaemonError('E_INVALID_ARG', 'Native plaintext exceeds its protected capacity.')
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.keys.key, nonce)
    cipher.setAAD(Buffer.from(this.profileId, 'ascii'))
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([MARKER, nonce, cipher.getAuthTag(), encrypted])
  }
  decrypt(value: Buffer): string {
    this.assertCiphertext(value)
    if (value.subarray(0, 4).equals(MARKER)) {
      if (!this.keys.key) throw new DaemonError('E_DENIED', 'The shared native ciphertext/key is unavailable; preserve its original owner.')
      try {
        const plaintext = decryptGcm(this.keys.key, value.subarray(4, 16), value.subarray(16, 32), value.subarray(32), Buffer.from(this.profileId, 'ascii'))
        try { return plaintext.toString('utf8') } finally { plaintext.fill(0) }
      } catch { throw new DaemonError('E_DENIED', 'Native ciphertext authentication failed; no alternate plaintext/key was accepted.') }
    }
    // Chromium Windows v10: prefix + nonce(12) + ciphertext + tag(16).
    if (value.subarray(0, 3).equals(LEGACY_MARKER)) {
      for (const key of this.keys.legacy.values()) {
        try {
          const plaintext = decryptGcm(key, value.subarray(3, 15), value.subarray(-16), value.subarray(15, -16))
          try { return plaintext.toString('utf8') } finally { plaintext.fill(0) }
        } catch { /* Try only known historical keys; authenticated plaintext only. */ }
      }
    }
    throw new DaemonError('E_DENIED', 'No authorized native key can decrypt this historical credential; preserve it for recovery.')
  }
}
