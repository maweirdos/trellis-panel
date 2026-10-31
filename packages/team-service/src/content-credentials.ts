import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { TeamServiceError } from './errors'

const envelopeSchema = z.object({ version: z.literal(1), iv: z.string(), tag: z.string(), ciphertext: z.string() }).strict()
function protectionError(): never {
  throw new TeamServiceError('CONTENT_PROTECTION_UNAVAILABLE', 'The administrator must supply the external content encryption key; no plaintext credentials can be saved', 503)
}
function key(): Buffer {
  const value = process.env.TEAM_CONTENT_ENCRYPTION_KEY?.trim()
  const path = process.env.TEAM_CONTENT_ENCRYPTION_KEY_FILE?.trim()
  if (value && path) protectionError()
  let raw = value
  if (path) {
    if (!isAbsolute(path)) protectionError()
    let fd: number | undefined
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = fstatSync(fd)
      if (!info.isFile() || info.size > 1024 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) protectionError()
      raw = readFileSync(fd, 'utf8').trim()
    } catch { protectionError() }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) protectionError()
  const result = Buffer.from(raw, 'base64')
  if (result.length !== 32 || result.toString('base64') !== raw) protectionError()
  return result
}
export function encryptContentCredential(teamId: string, secret: string): string {
  const material = key()
  try {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', material, iv)
    cipher.setAAD(Buffer.from(`team-content:${teamId}:v1`))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })
  } finally { material.fill(0) }
}
export function decryptContentCredential(teamId: string, envelope: string): string {
  const material = key()
  try {
    const saved = envelopeSchema.parse(JSON.parse(envelope))
    const decipher = createDecipheriv('aes-256-gcm', material, Buffer.from(saved.iv, 'base64'))
    decipher.setAAD(Buffer.from(`team-content:${teamId}:v1`))
    decipher.setAuthTag(Buffer.from(saved.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()])
    try { return plain.toString('utf8') } finally { plain.fill(0) }
  } catch { return protectionError() }
  finally { material.fill(0) }
}
export function contentCredentialAvailable(teamId: string, envelope: string): boolean {
  try { decryptContentCredential(teamId, envelope); return true } catch { return false }
}
/** Only an administrator configures the exact text endpoint; no redirects or URL credentials. */
export function validateContentEndpoint(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new TeamServiceError('CONTENT_ENDPOINT_INVALID', 'A complete chat/completions endpoint is required') }
  const allowedHttp = (process.env.TEAM_CONTENT_ALLOWED_HTTP_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/chat/completions') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowedHttp.includes(url.origin)))) {
    throw new TeamServiceError('CONTENT_ENDPOINT_INVALID', 'Use an exact HTTPS chat/completions endpoint without credentials, query or fragment; HTTP requires a deployment allowlist')
  }
  return url.href
}
