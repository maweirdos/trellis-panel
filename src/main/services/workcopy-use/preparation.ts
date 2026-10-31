import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema } from '../../../shared/daemon'
import { workcopyLeaseSchema, type WorkcopyLease } from '../../../shared/workcopy-use'
import { DaemonError } from '../../daemon/errors'
import { readBounded, writeAtomic } from '../../daemon/files'
import { processIdentity, sameOwner } from '../../daemon/native'
import { daemonClientContext } from '../daemon-client/manager'
import { acquireWorkcopyUse, releaseWorkcopyUse } from './client'
import { resolveWorkcopy } from './identity'
import { cleanupNativeWorkcopyCommands } from './native-command'

const schema = z.object({
  version: z.literal(1), operationId: z.string().min(1).max(200), root: z.string().min(1).max(4096), host: processOwnerSchema,
  lease: workcopyLeaseSchema, state: z.enum(['acquiring', 'running', 'unknown', 'released'])
}).strict()
type Preparation = z.infer<typeof schema>
const running = new Set<string>()
const read = (file: string): Preparation => schema.parse(JSON.parse(readBounded(file, 32 * 1024)))
const save = (file: string, record: Preparation): void => writeAtomic(file, JSON.stringify(schema.parse(record)))
async function location(root: string, operationId: string): Promise<string> {
  schema.shape.operationId.parse(operationId)
  const context = await daemonClientContext()
  return join(context.directory, 'workcopy-preparations', `${createHash('sha256').update(JSON.stringify([root.toLowerCase(), operationId])).digest('hex')}.json`)
}
/** Verify the original native host is gone, then reconcile every enclosed job. */
export async function recoverNativeWorkcopyPreparation(root: string, operationId: string): Promise<boolean> {
  const file = await location(root, operationId)
  if (!existsSync(file)) return true
  if (running.has(file)) return false
  running.add(file)
  try { return await recoverPreparation(file) }
  finally { running.delete(file) }
}
async function recoverPreparation(file: string): Promise<boolean> {
  const record = read(file)
  if (record.state === 'released') return true
  const current = await processIdentity(record.host.pid)
  if (current && sameOwner(current, record.host) && record.host.pid !== process.pid) return false
  if (!await cleanupNativeWorkcopyCommands(record.lease)) return false
  await releaseWorkcopyUse(record.root, record.lease, 'cleanup-confirmed')
  if (read(file).lease.token !== record.lease.token) throw new DaemonError('E_CONFLICT', '准备操作已进入新的原生代次，原恢复不会改写新登记。')
  save(file, { ...record, state: 'released' })
  return true
}
/**
 * Callback effects must be awaited filesystem work or contained commands using
 * this exact lease. No raw spawn, detached promise or external background writer.
 * A completed retry gets a distinct generation; uncertain old work reconciles first.
 */
export async function withNativeWorkcopyPreparation<T>(root: string, operationId: string, action: (lease: WorkcopyLease) => Promise<T>): Promise<T> {
  const file = await location(root, operationId)
  if (running.has(file)) throw new DaemonError('E_BUSY', '原任务准备仍在执行，请等待原操作。')
  running.add(file)
  let record: Preparation | undefined
  try {
    if (existsSync(file) && read(file).state !== 'released' && !await recoverPreparation(file)) throw new DaemonError('E_UNKNOWN', '原任务准备或子进程尚未核对清理，请恢复原操作。', 'unknown')
    const identity = resolveWorkcopy(root), context = await daemonClientContext(), generation = randomUUID()
    const planned: WorkcopyLease = { token: randomUUID(), identity, owner: { kind: 'git', id: operationId, generation, label: '准备任务开发环境' }, kind: 'tree-change', state: 'held', acquiredAt: Date.now() }
    record = { version: 1, operationId, root, host: context.owner, lease: planned, state: 'acquiring' }
    save(file, record)
    const lease = await acquireWorkcopyUse(root, { kind: planned.kind, owner: planned.owner, token: planned.token, expected: identity })
    record = { ...record, lease, state: 'running' }; save(file, record)
    return await action(lease)
  } finally {
    try {
      if (record) {
        const confirmed = await cleanupNativeWorkcopyCommands(record.lease)
        await releaseWorkcopyUse(root, record.lease, confirmed ? 'cleanup-confirmed' : 'unknown')
        save(file, { ...record, state: confirmed ? 'released' : 'unknown' })
        if (!confirmed) throw new DaemonError('E_UNKNOWN', '原任务准备子进程清理尚未确认，登记与原操作已保留。', 'unknown')
      }
    } finally { running.delete(file) }
  }
}
