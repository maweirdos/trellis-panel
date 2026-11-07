import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { cruxRemoteCommandSchema, cruxRemoteSnapshotSchema } from '../../../shared/crux-remote'

export const remoteBindingSchema = z.object({
  connectionId: z.string().uuid(), origin: z.string().url(), pairingId: z.string().uuid(),
  ownerId: z.string().uuid(), deviceId: z.string().uuid(), projectId: z.string().uuid()
}).strict()
export type CruxRemoteBinding = z.infer<typeof remoteBindingSchema>
export const remotePendingSchema = z.object({
  command: cruxRemoteCommandSchema,
  state: z.enum(['queued', 'dispatching', 'acknowledgement-unknown', 'conflict', 'access-revoked']),
  createdAt: z.number().int().nonnegative().safe(), attempts: z.number().int().nonnegative(),
  outcomeUnknown: z.boolean(), errorCode: z.string().max(100).nullable()
}).strict()
export type CruxRemotePending = z.infer<typeof remotePendingSchema>
const stateSchema = z.object({
  version: z.literal(2), binding: remoteBindingSchema,
  authority: z.object({ instanceId: z.string().uuid(), epoch: z.string().uuid(), authorizationRevision: z.number().int().nonnegative().safe(), revision: z.number().int().nonnegative().safe() }).strict().nullable(),
  retiredEpochs: z.array(z.string().uuid()), accessLocked: z.boolean(),
  cache: cruxRemoteSnapshotSchema.nullable(), observedAt: z.number().int().nonnegative().safe().nullable(),
  pending: remotePendingSchema.nullable()
}).strict()
export type CruxRemotePersisted = z.infer<typeof stateSchema>
const MAX_STATE_BYTES = 8 * 1024 * 1024

export function remoteScopeKey(binding: CruxRemoteBinding): string {
  return createHash('sha256').update(JSON.stringify([binding.origin, binding.ownerId, binding.deviceId, binding.projectId])).digest('hex')
}

/** Owns only the selected remote namespace. No local Crux store or credentials. */
export class CruxRemotePersistence {
  readonly file: string
  constructor(dataDir: string, private readonly binding: CruxRemoteBinding) {
    this.file = join(resolve(dataDir), 'crux-remote', remoteScopeKey(binding), 'state.json')
  }
  read(): CruxRemotePersisted {
    let bytes: Buffer
    try {
      if (statSync(this.file).size > MAX_STATE_BYTES) throw new Error('远程协作恢复文件超过限界')
      bytes = readFileSync(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, binding: this.binding, authority: null, retiredEpochs: [], accessLocked: false, cache: null, observedAt: null, pending: null }
      throw error
    }
    const state = stateSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (JSON.stringify(state.binding) !== JSON.stringify(remoteBindingSchema.parse(this.binding))) throw new Error('远程恢复记录不属于原连接身份，不能转用')
    if (state.cache && (state.cache.projectId !== this.binding.projectId || state.cache.actor.id !== this.binding.ownerId)) throw new Error('远程缓存身份与原连接不一致')
    if (state.cache && (!state.authority || state.cache.instanceId !== state.authority.instanceId || state.cache.epoch !== state.authority.epoch || state.cache.authorizationRevision !== state.authority.authorizationRevision || state.cache.revision !== state.authority.revision || state.retiredEpochs.includes(state.cache.epoch) || state.accessLocked)) throw new Error('远程缓存与原服务世代不一致')
    // A crash may have occurred anywhere after the durable dispatch marker.
    if (state.pending?.state === 'dispatching') state.pending = { ...state.pending, state: 'acknowledgement-unknown', outcomeUnknown: true }
    return state
  }
  write(raw: CruxRemotePersisted): CruxRemotePersisted {
    const state = stateSchema.parse(raw), body = JSON.stringify(state)
    if (JSON.stringify(state.binding) !== JSON.stringify(remoteBindingSchema.parse(this.binding))) throw new Error('远程命令绑定不能改变')
    if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error('远程协作恢复文件超过限界，未发送操作')
    const directory = join(this.file, '..')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.state-${randomUUID()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, body, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor); descriptor = undefined
      renameSync(temporary, this.file)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return state
  }
}
