import { randomUUID } from 'node:crypto'
import type { AcpHistorySummary, AcpHistoryUpdateResult } from '../../../shared/acp-history'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { compareAndSetSessionTitle, readSessionPreferences } from './session-preferences'

export interface TitleMaterial { question: string; delivery: string; digest: string }
interface TitlePorts {
  directory: () => string
  session: (root: string, id: string) => Promise<{ ok: true; session: AcpHistorySummary } | IpcFail>
  material: (root: string, id: string) => Promise<TitleMaterial | null>
  request: (meta: AcpHistorySummary, material: TitleMaterial) => Promise<{ title: string; model: string }>
}
/** One bounded, tool-free request per initial delivery or explicit regeneration. */
export class SessionTitles {
  private requests = new Set<string>()
  constructor(private ports: TitlePorts) {}
  async generate(root: string, id: string, current: () => boolean, explicit = true): Promise<AcpHistoryUpdateResult | IpcFail> {
    const key = JSON.stringify([root, id])
    if (this.requests.has(key)) return ipcFail(IpcErrorCode.Conflict, '标题正在生成，请稍后重试')
    this.requests.add(key)
    try {
      const existing = await this.ports.session(root, id)
      if (!existing.ok) return existing
      const meta = existing.session
      if (!current() || meta.deletionState) return ipcFail(IpcErrorCode.Conflict, '会话或项目已变化')
      const old = readSessionPreferences(this.ports.directory(), root).sessions[id]
      if (old?.customTitle) return ipcFail(IpcErrorCode.Conflict, '此会话使用手动标题；请通过重命名修改')
      if (!explicit && old?.titleProvenance && !(old.titleProvenance.source === 'fallback' && old.titleProvenance.state === 'pending')) return { ok: true, version: 1, session: meta }
      const material = await this.ports.material(root, id)
      if (!material?.question.trim() || !material.delivery.trim()) return ipcFail(IpcErrorCode.Conflict, '需要实际首问和回复内容后才能生成标题')
      const revision = randomUUID()
      if (!current() || !compareAndSetSessionTitle(this.ports.directory(), root, id, old?.titleProvenance?.revision,
        old?.automaticTitle ?? (meta.titleProvenance ? undefined : '对话摘要待生成'), { source: old?.titleProvenance?.source ?? 'fallback', revision, state: 'pending', sourceDigest: material.digest })) {
        return ipcFail(IpcErrorCode.Conflict, '标题已变化，请刷新后重试')
      }
      let generated: { title: string; model: string } | undefined
      let error = ''
      try {
        generated = await this.ports.request(meta, material)
        const title = generated.title.trim().replace(/^["“”「」]+|["“”「」。.!！]+$/g, '').trim()
        if (!title || title.length > 48 || /[\r\n]/.test(title) || title === meta.agentName || title === meta.profileSnapshot?.name) throw new Error('模型未返回有效的短语义标题')
        generated.title = title
      } catch (reason) { error = reason instanceof Error ? reason.message.slice(0, 500) : '标题生成失败' }
      const latest = await this.ports.session(root, id)
      const fresh = await this.ports.material(root, id)
      if (!current() || !latest.ok || latest.session.deletionState || latest.session.connectionGeneration !== meta.connectionGeneration || fresh?.digest !== material.digest) {
        return ipcFail(IpcErrorCode.Conflict, '标题来源或会话连接已变化，未应用旧标题')
      }
      const applied = compareAndSetSessionTitle(this.ports.directory(), root, id, revision, error ? undefined : generated?.title,
        { source: error ? old?.titleProvenance?.source ?? 'fallback' : 'generated', state: error ? 'failed' : 'ready', revision: randomUUID(), sourceDigest: material.digest,
          ...(error ? { error } : { model: generated?.model, generatedAt: Date.now() }) })
      if (!applied) return ipcFail(IpcErrorCode.Conflict, '标题已被更新，未覆盖新标题')
      if (error) return ipcFail(IpcErrorCode.Upstream, `标题生成失败，已保留现有标题。${error}`)
      const result = await this.ports.session(root, id)
      return result.ok ? { ok: true, version: 1, session: result.session } : result
    } catch (error) { return ipcFail(IpcErrorCode.Io, error instanceof Error ? error.message : '标题保存失败') }
    finally { this.requests.delete(key) }
  }
}
