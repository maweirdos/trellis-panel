/** Durable erasure intent and physical app-owned boundaries. No Electron dependency. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { AcpSessionMeta } from '../../../shared/types'

const safeId = z.string().min(1).max(200).regex(/^[\w.-]+$/).refine(value => value !== '.' && value !== '..')
const identitySchema = z.object({ sessionId: safeId, projectRoot: z.string().min(1), engine: z.enum(['pi', 'acp']).optional(), acpxRecordId: z.string().min(1).max(1000).optional(),
  backendSessionId: z.string().optional(), agentSessionId: z.string().optional(), cwd: z.string().optional(),
  connectionGeneration: z.string().optional(), startedAt: z.number().optional(), title: z.string().optional(), agentId: z.string().optional(), agentName: z.string().optional() }).strict()
const tombstoneSchema = z.object({ version: z.literal(1), root: z.string(), operationId: z.string().uuid(), state: z.enum(['pending', 'complete']), metadata: identitySchema, createdAt: z.number() }).strict()
export type HistoryDeletion = z.infer<typeof tombstoneSchema>
export const deletionDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const confirmationSchema = z.object({ version: z.literal(1), token: z.string().uuid(), root: z.string(), sessionId: safeId, expires: z.number() }).strict()
const pathKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
export function deletionRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error('项目目录必须是绝对路径')
  let value = resolve(root)
  try { value = realpathSync(value) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return pathKey(value)
}
function confirmationPath(userData: string, token: string): string {
  z.string().uuid().parse(token)
  const path = join(userData, 'acp', 'history-confirmations', `${token}.json`)
  assertDeletionBoundary(userData, path)
  return path
}
/** Native GUI only: called after an actual OS dialog and final GUI owner check.
 * No daemon RPC or renderer API can mint this app-private, single-use receipt.
 * Same-user filesystem access is already authority to erase these local files.
 */
export function approveNativeHistoryDeletion(userData: string, root: string, sessionId: string, token: string): void {
  const value = confirmationSchema.parse({ version: 1, token, root: deletionRoot(root), sessionId, expires: Date.now() + 2 * 60_000 })
  const path = confirmationPath(userData, token)
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
}
export function discardNativeHistoryDeletion(userData: string, token: string): void {
  const path = confirmationPath(userData, token)
  try { unlinkSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
export function consumeNativeHistoryDeletion(userData: string, root: string, sessionId: string, token: string): boolean {
  const path = confirmationPath(userData, token)
  let bytes: string
  try { bytes = readFileSync(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  const value = confirmationSchema.parse(JSON.parse(bytes))
  if (value.root !== deletionRoot(root) || value.sessionId !== sessionId || value.token !== token || value.expires <= Date.now()) return false
  unlinkSync(path)
  return true
}
function tombstonePath(directory: string, root: string, id: string): string {
  safeId.parse(id)
  return join(directory, 'history-deletions', `${deletionDigest([deletionRoot(root), id])}.json`)
}
/** Check every existing ancestor, including junctions. Missing descendants are safe to retry. */
export function assertDeletionBoundary(userData: string, target: string): void {
  if (!isAbsolute(userData) || !isAbsolute(target)) throw new Error('删除路径必须是绝对路径')
  const base = resolve(userData), absolute = resolve(target), local = relative(base, absolute)
  if (!local || local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(local)) throw new Error('删除路径超出应用数据目录')
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || pathKey(realpathSync(current)) !== pathKey(current)) throw new Error('删除路径含链接或物理目录已变化，请修复目录后重试')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error }
  }
}
export function readHistoryDeletion(directory: string, root: string, id: string): HistoryDeletion | undefined {
  const path = tombstonePath(directory, root, id)
  assertDeletionBoundary(dirname(directory), path)
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const value = tombstoneSchema.parse(JSON.parse(raw))
  if (value.root !== deletionRoot(root) || value.metadata.sessionId !== id || deletionRoot(value.metadata.projectRoot) !== value.root) throw new Error('删除记录归属不匹配')
  return value
}
export function listHistoryDeletions(directory: string, root: string): HistoryDeletion[] {
  const path = join(directory, 'history-deletions')
  assertDeletionBoundary(dirname(directory), path)
  if (!existsSync(path)) return []
  return readdirSync(path).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const file = join(path, name)
    assertDeletionBoundary(dirname(directory), file)
    return tombstoneSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  }).filter(value => value.root === deletionRoot(root))
}
export function saveHistoryDeletion(directory: string, meta: AcpSessionMeta, state: HistoryDeletion['state']): HistoryDeletion {
  const old = readHistoryDeletion(directory, meta.projectRoot, meta.sessionId)
  const value: HistoryDeletion = state === 'complete' ? { version: 1, root: deletionRoot(meta.projectRoot), operationId: old?.operationId ?? randomUUID(), state, createdAt: old?.createdAt ?? Date.now(),
    metadata: { sessionId: meta.sessionId, projectRoot: meta.projectRoot } } : old ? { ...old, state } : {
    version: 1, root: deletionRoot(meta.projectRoot), operationId: randomUUID(), state, createdAt: Date.now(),
    metadata: identitySchema.parse({ sessionId: meta.sessionId, projectRoot: meta.projectRoot, engine: meta.engine, acpxRecordId: meta.acpxRecordId,
      backendSessionId: meta.backendSessionId, agentSessionId: meta.agentSessionId, cwd: meta.cwd,
      connectionGeneration: meta.connectionGeneration, startedAt: meta.startedAt, title: meta.title, agentId: meta.agentId, agentName: meta.agentName })
  }
  const path = tombstonePath(directory, meta.projectRoot, meta.sessionId)
  assertDeletionBoundary(dirname(directory), path)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  return value
}
/** Derive targets only from verified app identity, never from pi.sessionFile/cwd/artifact links. */
export function historyDeletionTargets(userData: string, meta: AcpSessionMeta): string[] {
  safeId.parse(meta.sessionId)
  const targets = [join(userData, 'acp-sessions', `${meta.sessionId}.json`)]
  assertDeletionBoundary(userData, targets[0])
  if (existsSync(targets[0])) {
    const snapshot = JSON.parse(readFileSync(targets[0], 'utf8')) as { sessionId?: unknown; projectRoot?: unknown; cleanupRequired?: unknown }
    if (snapshot.sessionId !== meta.sessionId || typeof snapshot.projectRoot !== 'string' || deletionRoot(snapshot.projectRoot) !== deletionRoot(meta.projectRoot)) throw new Error('兼容快照归属已变化，未删除文件')
    if (snapshot.cleanupRequired === true) throw new Error('原会话清理未确认，请先恢复会话并重试“结束会话”')
  }
  if (meta.engine === 'pi') targets.push(join(userData, 'pi', 'sessions', createHash('sha256').update(meta.projectRoot).digest('hex'), meta.sessionId))
  if (meta.engine !== 'pi') {
    const runtimeId = meta.acpxRecordId ?? meta.sessionId
    const sessionDirectory = join(userData, 'acp', 'runtime-store', 'sessions')
    const path = join(sessionDirectory, `${encodeURIComponent(runtimeId)}.json`)
    assertDeletionBoundary(userData, path)
    const verifyRuntimeRecord = (record: Record<string, unknown>): boolean => record.schema === 'acpx.session.v1' && record.acpx_record_id === runtimeId
      && typeof record.cwd === 'string' && deletionRoot(record.cwd) === deletionRoot(meta.cwd ?? meta.projectRoot)
      && Boolean(meta.backendSessionId) && record.acp_session_id === meta.backendSessionId
      && (!meta.agentSessionId || record.agent_session_id === meta.agentSessionId) && record.name === meta.sessionId
    const assertNoProcess = (record: Record<string, unknown>): void => {
      if (typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0) {
        try { process.kill(record.pid, 0); throw new Error('原生运行记录仍指向存活进程，请先恢复并结束会话') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
    }
    if (existsSync(path)) {
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      if (!verifyRuntimeRecord(record)) throw new Error('原生 ACP 记录归属无法核对，已保留文件；请先恢复并检查原会话')
      assertNoProcess(record)
    }
    targets.push(path)
    if (existsSync(sessionDirectory)) for (const name of readdirSync(sessionDirectory)) {
      if (!/^acpx-write[\w.-]*$/.test(name)) continue
      const directory = join(sessionDirectory, name)
      assertDeletionBoundary(userData, directory)
      if (!lstatSync(directory).isDirectory()) continue
      const temporary = join(directory, 'record.json')
      assertDeletionBoundary(userData, temporary)
      if (!existsSync(temporary)) continue
      const record = JSON.parse(readFileSync(temporary, 'utf8')) as Record<string, unknown>
      if (!verifyRuntimeRecord(record)) continue
      assertNoProcess(record)
      targets.push(temporary)
    }
  }
  const snapshotDirectory = join(userData, 'acp-sessions')
  if (existsSync(snapshotDirectory)) for (const name of readdirSync(snapshotDirectory)) {
    if (name.startsWith(`${meta.sessionId}.json.`) && /^\d+\.tmp$/.test(name.slice(`${meta.sessionId}.json.`.length))) targets.push(join(snapshotDirectory, name))
  }
  const previewDirectory = join(userData, 'acp', 'handoffs', deletionDigest(deletionRoot(meta.projectRoot)), 'previews')
  assertDeletionBoundary(userData, previewDirectory)
  if (existsSync(previewDirectory)) for (const name of readdirSync(previewDirectory)) {
    if (!/^[\w.-]+\.json$/.test(name)) continue
    const path = join(previewDirectory, name)
    assertDeletionBoundary(userData, path)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { root?: unknown; preview?: { source?: { sessionId?: unknown } } }
    if (raw.preview?.source?.sessionId === meta.sessionId && typeof raw.root === 'string' && deletionRoot(raw.root) === deletionRoot(meta.projectRoot)) targets.push(path)
  }
  const operationDirectory = join(dirname(previewDirectory), 'operations')
  assertDeletionBoundary(userData, operationDirectory)
  if (existsSync(operationDirectory)) for (const name of readdirSync(operationDirectory)) {
    if (!/^[\w.-]+\.json$/.test(name)) continue
    const path = join(operationDirectory, name)
    assertDeletionBoundary(userData, path)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { root?: unknown; operation?: { sourceSessionId?: unknown; state?: unknown; delivery?: unknown }; deliveryAttempt?: { state?: unknown } }
    if (raw.operation?.sourceSessionId !== meta.sessionId || typeof raw.root !== 'string' || deletionRoot(raw.root) !== deletionRoot(meta.projectRoot)) continue
    if (raw.operation.delivery === 'sent') continue // Delivered context belongs to the successor's retained receipt.
    if (raw.operation.delivery === 'not_sent' && ['cancelled', 'failed'].includes(String(raw.operation.state)) && raw.deliveryAttempt?.state !== 'dispatching') targets.push(path)
    else throw new Error('源会话仍有未完成或结果不确定的 Runtime 接续，请先完成或取消接续后再删除')
  }
  // Abandoned preference writes can contain the old title. They are root-owned caches, not authority.
  const preferenceDirectory = join(userData, 'acp', 'session-preferences'), preferencePrefix = `${createHash('sha256').update(deletionRoot(meta.projectRoot)).digest('hex')}.json.`
  assertDeletionBoundary(userData, preferenceDirectory)
  if (existsSync(preferenceDirectory)) for (const name of readdirSync(preferenceDirectory)) {
    if (name.startsWith(preferencePrefix) && /^\d+\.[a-f0-9-]+\.tmp$/.test(name.slice(preferencePrefix.length))) targets.push(join(preferenceDirectory, name))
  }
  const deletionDirectory = join(userData, 'acp', 'history-deletions'), deletionPrefix = `${deletionDigest([deletionRoot(meta.projectRoot), meta.sessionId])}.json.`
  assertDeletionBoundary(userData, deletionDirectory)
  if (existsSync(deletionDirectory)) for (const name of readdirSync(deletionDirectory)) {
    if (name.startsWith(deletionPrefix) && /^[a-f0-9-]+\.tmp$/.test(name.slice(deletionPrefix.length))) targets.push(join(deletionDirectory, name))
  }
  const originals = join(userData, 'acp', 'history-originals')
  assertDeletionBoundary(userData, originals)
  if (existsSync(originals)) for (const name of readdirSync(originals)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const path = join(originals, name)
    assertDeletionBoundary(userData, path)
    // An unreadable backup prevents a false claim that all copies were erased.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessionId?: unknown; projectRoot?: unknown }
    if (raw.sessionId === meta.sessionId && typeof raw.projectRoot === 'string' && deletionRoot(raw.projectRoot) === deletionRoot(meta.projectRoot)) targets.push(path)
  }
  for (const path of targets) assertDeletionBoundary(userData, path)
  return targets
}
/** Includes inodes and content, so a replacement after the native confirmation needs a new preview. */
export function deletionFilesFence(userData: string, targets: string[]): string {
  const values: unknown[] = []
  const visit = (path: string): void => {
    if (values.length > 20_000) throw new Error('会话文件过多，请先检查应用数据目录')
    assertDeletionBoundary(userData, path)
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { values.push([path, 'missing']); return }; throw error }
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('会话目录包含非普通文件')
    let hash = 'directory'
    if (stat.isFile()) {
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const before = fstatSync(fd)
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) throw new Error('文件在校验前已变化，请重新确认')
        const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024)
        let total = 0, count: number
        while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) { total += count; digest.update(buffer.subarray(0, count)) }
        const after = fstatSync(fd), named = lstatSync(path)
        if (total !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size || named.mtimeMs !== before.mtimeMs || named.isSymbolicLink()) throw new Error('文件在校验时已变化，请重新确认')
        hash = digest.digest('hex')
      } finally { closeSync(fd) }
    }
    values.push([path, stat.dev, stat.ino, stat.size, stat.mtimeMs, hash])
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  targets.forEach(visit)
  return deletionDigest(values)
}
export function eraseHistoryFiles(userData: string, meta: AcpSessionMeta, expectedFence?: string): void {
  const targets = historyDeletionTargets(userData, meta)
  const fence = deletionFilesFence(userData, targets)
  if (expectedFence !== undefined && fence !== expectedFence) throw new Error('确认后的会话文件已变化，请重新确认永久删除')
  for (const path of targets) {
    assertDeletionBoundary(userData, path)
    if (!existsSync(path)) continue
    const recursive = lstatSync(path).isDirectory()
    // Boundary and link checks stay adjacent to the destructive operation.
    if (recursive) deletionFilesFence(userData, [path])
    rmSync(path, { recursive, force: false })
    if (existsSync(path)) throw new Error('会话文件清理未确认，请重试永久删除')
  }
}
