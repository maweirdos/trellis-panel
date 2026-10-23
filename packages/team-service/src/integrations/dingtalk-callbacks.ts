import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { TeamServiceError } from '../errors'

/** DingTalk's documented encrypted callback format, independently implemented
 * from its wire contract. Protocol reference:
 * https://github.com/open-dingtalk/DingTalk-Callback-Crypto . */
export function createDingTalkCallbackCodec(config: { token: string; aesKey: string; ownerKey: string }) {
  if (!/^[A-Za-z0-9+/]{43}$/.test(config.aesKey) || !config.token || !config.ownerKey) throw new Error('Invalid protected DingTalk callback configuration')
  const key = Buffer.from(`${config.aesKey}=`, 'base64')
  if (key.length !== 32) throw new Error('Invalid DingTalk callback key')
  const signature = (timestamp: string, nonce: string, encrypted: string): string => createHash('sha1').update([config.token, timestamp, nonce, encrypted].sort().join('')).digest('hex')
  return {
    decrypt(input: { signature: string; timestamp: string; nonce: string; encrypt: string }): unknown {
      if (!/^[a-f0-9]{40}$/i.test(input.signature) || !/^\d{10,13}$/.test(input.timestamp) || input.nonce.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.encrypt) || input.encrypt.length > 350000) throw new TeamServiceError('FORBIDDEN', 'Invalid DingTalk callback', 403)
      const milliseconds = Number(input.timestamp) * (input.timestamp.length === 10 ? 1000 : 1)
      if (Math.abs(Date.now() - milliseconds) > 300000) throw new TeamServiceError('FORBIDDEN', 'Expired DingTalk callback', 403)
      const expected = signature(input.timestamp, input.nonce, input.encrypt)
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature.toLowerCase()))) throw new TeamServiceError('FORBIDDEN', 'Unverified DingTalk callback', 403)
      const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)); decipher.setAutoPadding(false)
      const padded = Buffer.concat([decipher.update(Buffer.from(input.encrypt, 'base64')), decipher.final()])
      const padding = padded[padded.length - 1]
      if (!padding || padding > 32 || padded.length < 20 + padding || !padded.subarray(padded.length - padding).every(value => value === padding)) throw new TeamServiceError('FORBIDDEN', 'Invalid DingTalk callback padding', 403)
      const content = padded.subarray(0, padded.length - padding), length = content.readUInt32BE(16)
      if (length > 256 * 1024 || content.length < 20 + length || content.subarray(20 + length).toString('utf8') !== config.ownerKey) throw new TeamServiceError('FORBIDDEN', 'Foreign DingTalk callback owner', 403)
      return JSON.parse(content.subarray(20, 20 + length).toString('utf8')) as unknown
    },
    encrypt(text: string) {
      const body = Buffer.from(text), size = Buffer.alloc(4); size.writeUInt32BE(body.length)
      const bytes = Buffer.concat([randomBytes(16), size, body, Buffer.from(config.ownerKey)]), padding = 32 - bytes.length % 32
      const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false)
      const encrypt = Buffer.concat([cipher.update(Buffer.concat([bytes, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64')
      const timeStamp = String(Date.now()), nonce = randomBytes(16).toString('hex')
      return { msg_signature: signature(timeStamp, nonce, encrypt), timeStamp, nonce, encrypt }
    }
  }
}

export interface DingTalkVerifiedCallbackPorts {
  codec: ReturnType<typeof createDingTalkCallbackCodec>
  /** Must durably record callback identity before ACK. Existing callback replay
   * returns the original saved response. Never use an in-memory Set. */
  record(input: { digest: string; verifiedEvent: unknown }): Promise<{ response: string }>
  /** Invoked only with a verified vendor check_url callback. A configured URL or
   * entered token cannot establish callback readiness. */
  verifiedSetup(): Promise<void>
}
/** Optional callback mount. Stream does not depend on this listener. A vendor-
 * specific link-preview decoder/response and exact published-content ACL must
 * be installed by record(); generic events confer no task/shell/team grants. */
export async function registerDingTalkVerifiedCallback(app: FastifyInstance, ports: DingTalkVerifiedCallbackPorts): Promise<void> {
  app.post('/api/integrations/dingtalk/vendor-callback', { bodyLimit: 400000, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const query = z.object({ signature: z.string().max(40), timestamp: z.string().max(13), nonce: z.string().min(1).max(256) }).strict().parse(request.query)
    const body = z.object({ encrypt: z.string().min(1).max(350000) }).strict().parse(request.body)
    const event = ports.codec.decrypt({ ...query, encrypt: body.encrypt })
    const type = z.object({ EventType: z.string().min(1).max(100) }).passthrough().parse(event)
    const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex')
    const result = await ports.record({ digest, verifiedEvent: event })
    if (type.EventType === 'check_url') await ports.verifiedSetup()
    return ports.codec.encrypt(result.response)
  })
}
