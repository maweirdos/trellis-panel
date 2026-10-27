import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { AcpSessionMeta } from '../../../shared/types'
import type { AcpHistoryDeletePreview, AcpHistoryDeleteResult, AcpHistorySummary } from '../../../shared/acp-history'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { consumeNativeHistoryDeletion, deletionDigest, deletionFilesFence, deletionRoot, eraseHistoryFiles, historyDeletionTargets, readHistoryDeletion, saveHistoryDeletion } from './history-deletion'
import { removeSessionPreferences, readSessionPreferences } from './session-preferences'

interface DeletionPorts {
  userData: () => string
  capture: (root: string, id: string) => Promise<AcpHistorySummary | IpcFail>
  assertSafe: (root: string, id: string) => Promise<void>
  drain: () => Promise<void>
  eraseArchive: (root: string, id: string) => Promise<void>
}
interface Preview { root: string; id: string; fence: string; expires: number }
export class SessionDeletion {
  private previews = new Map<string, Preview>()
  private deleting = new Set<string>()
  constructor(private ports: DeletionPorts) {}
  isDeleting(id: string): boolean { return this.deleting.has(id) }
  private async capture(root: string, id: string): Promise<AcpHistorySummary | IpcFail> {
    const pending = readHistoryDeletion(join(this.ports.userData(), 'acp'), root, id)
    if (pending?.state === 'complete') return ipcFail(IpcErrorCode.NotFound, '此会话已永久删除')
    if (pending) return pendingDeletionSummary(pending.metadata)
    return this.ports.capture(root, id)
  }
  private fence(root: string, meta: AcpHistorySummary): string {
    const directory = deletionRoot(root), stat = statSync(directory)
    const userData = this.ports.userData()
    const preferences = readSessionPreferences(join(userData, 'acp'), root)
    return deletionDigest([directory, stat.dev, stat.ino, meta.sessionId, meta.projectRoot, meta.connectionGeneration, meta.backendSessionId,
      meta.acpxRecordId, meta.pi, meta.stateRevision, meta.eventCount, meta.lastActivityAt, meta.historyPersistence,
      preferences.sessions[meta.sessionId], deletionFilesFence(userData, historyDeletionTargets(userData, meta))])
  }
  async preview(root: string, id: string, current: () => boolean): Promise<AcpHistoryDeletePreview | IpcFail> {
    try {
      if (!current() || !root) return ipcFail(IpcErrorCode.Conflict, '项目已变化，请重新选择会话')
      if (this.isDeleting(id)) return ipcFail(IpcErrorCode.Conflict, '此会话正在清理，请稍后刷新')
      await this.ports.assertSafe(root, id)
      await this.ports.drain()
      const meta = await this.capture(root, id)
      if ('ok' in meta) return meta
      await this.ports.assertSafe(root, id)
      if (!current() || deletionRoot(meta.projectRoot) !== deletionRoot(root)) return ipcFail(IpcErrorCode.Conflict, '项目或会话已变化，请重试')
      const now = Date.now()
      for (const [token, value] of this.previews) if (value.expires < now) this.previews.delete(token)
      if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value ?? '')
      const token = randomUUID()
      this.previews.set(token, { root: deletionRoot(root), id, fence: this.fence(root, meta), expires: now + 5 * 60_000 })
      return { ok: true, sessionId: id, title: meta.title ?? '新对话', token,
        scope: ['本应用保存的会话正文、内嵌附件、兼容快照和原始记录备份', '本应用保存的标题、置顶、归档偏好和运行记录',
          ...(meta.engine === 'pi' ? ['此 Pi 会话专属目录内的原生会话、图片和附件'] : [])],
        excluded: ['项目源码及生成的网页、文档', '用户另存或导出的文件', '外部 CLI 的全局会话和日志', '已接续到其他会话的内容及其交付凭据'] }
    } catch (error) { return ipcFail(IpcErrorCode.Conflict, error instanceof Error ? error.message : '无法核对删除范围，请重试') }
  }
  async delete(root: string, id: string, token: string, current: () => boolean): Promise<AcpHistoryDeleteResult | IpcFail> {
    const preview = this.previews.get(token)
    this.previews.delete(token)
    if (!preview || preview.id !== id || preview.root !== deletionRoot(root) || preview.expires < Date.now() || !current()) return ipcFail(IpcErrorCode.Conflict, '删除确认已失效，请重新确认')
    if (this.isDeleting(id)) return ipcFail(IpcErrorCode.Conflict, '此会话正在清理，请稍后刷新')
    this.deleting.add(id)
    let admitted = false
    try {
      if (!consumeNativeHistoryDeletion(this.ports.userData(), root, id, token)) return ipcFail(IpcErrorCode.Denied, '缺少原生用户确认；请从会话菜单重新确认永久删除')
      await this.ports.assertSafe(root, id)
      await this.ports.drain()
      const meta = await this.capture(root, id)
      if ('ok' in meta) return meta
      await this.ports.assertSafe(root, id)
      if (!current() || this.fence(root, meta) !== preview.fence) return ipcFail(IpcErrorCode.Conflict, '确认期间会话或附件已变化，请重新确认')
      const filesFence = deletionFilesFence(this.ports.userData(), historyDeletionTargets(this.ports.userData(), meta))
      // Durable intent precedes every erase; all import/write paths fence this identity.
      saveHistoryDeletion(join(this.ports.userData(), 'acp'), meta, 'pending')
      admitted = true
      await this.ports.eraseArchive(root, id)
      // Once admitted, finish this captured identity even if the UI navigates away.
      eraseHistoryFiles(this.ports.userData(), meta, filesFence)
      removeSessionPreferences(join(this.ports.userData(), 'acp'), root, id)
      saveHistoryDeletion(join(this.ports.userData(), 'acp'), meta, 'complete')
      return { ok: true, sessionId: id, deleted: true }
    } catch (error) {
      return ipcFail(IpcErrorCode.Io, `${admitted ? '永久删除尚未完成，已阻止会话恢复；请重试永久删除。' : '未执行永久删除。'}${error instanceof Error ? error.message : String(error)}`,
        admitted ? { deletionPending: true, sessionId: id } : undefined)
    } finally { this.deleting.delete(id) }
  }
}
export function pendingDeletionSummary(meta: Pick<AcpSessionMeta, 'sessionId' | 'projectRoot'> & Partial<AcpSessionMeta>): AcpHistorySummary {
  return { ...meta, startedAt: meta.startedAt ?? 0, agentId: meta.agentId ?? 'unknown', agentName: meta.agentName ?? '会话', deletionState: 'pending', status: 'closed', canResume: false, historyKind: 'transcript', eventCount: 0, hasConversation: false,
    lastActivityAt: meta.startedAt ?? 0, historyCoverage: { state: 'unknown', capturedFrom: null },
    historyPersistence: { state: 'saved', pendingCount: 0, committedThroughEventId: null, committedThroughSeq: null }, pendingPermissions: [], stateRevision: 0 }
}
