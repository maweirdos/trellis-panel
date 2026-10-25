import { randomUUID } from 'node:crypto'
import type { AcpAgentConfig, AcpSessionRecord } from '../../../shared/types'
import { ACP_HANDOFF_CONTEXT_BYTE_LIMIT, acpHandoffCancelInputSchema, acpHandoffCreateInputSchema, acpHandoffPreviewInputSchema,
  acpHandoffPreviewSchema, type AcpHandoffOrigin, type AcpHandoffOperationResult, type AcpHandoffPreviewResult } from '../../../shared/acp-handoff'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { HandoffStore, handoffDigest, type HandoffOperationRecord, type HandoffPreviewRecord } from './handoff-store'
import type { HandoffArchive } from './handoff-history'
import { errorMessage, idSchema } from './types'

export interface HandoffSource { meta: AcpSessionRecord; archive: HandoffArchive; fence: string }
export interface HandoffTargetPlan { config: AcpAgentConfig; argv: string[]; fingerprint: string }
export interface HandoffPorts {
  directory(): string
  canonical(root: string): string
  rootIdentity(root: string): string
  source(root: string, id: string, allowArchived: boolean): Promise<HandoffSource>
  target(runtimeId: string): Promise<HandoffTargetPlan>
  metadata(root: string, id: string): AcpSessionRecord | undefined
  updateMetadata(root: string, id: string, update: (meta: AcpSessionRecord) => AcpSessionRecord): void
  createTarget(root: string, id: string, source: AcpSessionRecord, plan: HandoffTargetPlan, origin: AcpHandoffOrigin,
    assertCurrent: () => void, beforeNativeCreate: () => void): Promise<AcpSessionRecord>
  verifyTarget(root: string, id: string, identity: NonNullable<HandoffOperationRecord['nativeReady']>): Promise<boolean>
  stopTarget(root: string, id: string, operationId: string): Promise<void>
  warning(root: string, id: string, message: string): void
  closing(): boolean
}
export interface PreparedHandoff {
  operationId: string
  resource: { uri: string; mimeType: 'text/markdown'; text: string }
  assertCurrent(): void
}
const PREVIEW_LIFETIME_MS = 15 * 60_000
const result = (record: HandoffOperationRecord): AcpHandoffOperationResult => ({ ok: true, version: 1, operation: { ...record.operation } })

export function portableSourceReferences(meta: AcpSessionRecord): string[] {
  const references = new Map<string, string>()
  for (const source of meta.materialSnapshot?.sources ?? []) references.set(source.relativePath, source.sourceRevision ?? 'unavailable')
  for (const source of meta.materialSnapshot?.sourceReferences ?? []) references.set(source.relativePath, source.displayedRevision)
  return [...references].slice(0, 11).map(([path, revision]) => path.length > 240
    ? '[Long source path omitted; inspect the original source conversation]'
    : `${path} (saved revision ${revision}; re-read and verify current contents before use)`)
}

/** Continue In provenance (pattern, not a claim of native state cloning):
 * VS Code 1.107, 618725e67565b290ba4da6fe2d29f8fa1d4e3622,
 * src/vs/workbench/contrib/chat/browser/actions/chatContinueInAction.ts#L59-L68 (idle guard).
 * Copilot Chat 0.35.0, bfba65da1009f779dace69cf07454abe970baf0d,
 * src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts#L922-L982
 * (explicit summary/context -> target configuration -> new session resource).
 * https://github.com/microsoft/vscode/blob/618725e67565b290ba4da6fe2d29f8fa1d4e3622/src/vs/workbench/contrib/chat/browser/actions/chatContinueInAction.ts
 * https://github.com/microsoft/vscode-copilot-chat/blob/bfba65da1009f779dace69cf07454abe970baf0d/src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts
 */
export class AcpHandoffs {
  private creating = new Map<string, { digest: string; promise: Promise<AcpHandoffOperationResult | IpcFail> }>()
  private sourceLocks = new Map<string, string>()
  private liveDeliveries = new Set<string>()
  private sentReceipts = new Map<string, NonNullable<HandoffOperationRecord['deliveryAttempt']>>()
  constructor(private ports: HandoffPorts) {}
  private store(): HandoffStore { return new HandoffStore(this.ports.directory()) }
  private key(root: string, id: string): string { return `${this.ports.canonical(root)}\0${id}` }
  private assertCurrent(root: string, identity: string, valid: () => boolean): void {
    if (!valid() || this.ports.closing() || this.ports.rootIdentity(root) !== identity) throw new Error('项目、工作目录或后台连接已改变，请重新预览')
  }
  private touch(record: HandoffOperationRecord): void { record.operation.updatedAt = Date.now(); this.store().save(record) }
  private lineage(record: HandoffOperationRecord): void {
    const operation = record.operation
    if (!operation.targetSessionId) return
    this.ports.updateMetadata(record.root, operation.sourceSessionId, meta => ({ ...meta,
      handoffTargets: [...(meta.handoffTargets ?? []).filter(link => link.operationId !== operation.id),
        { operationId: operation.id, targetSessionId: operation.targetSessionId ?? '', runtimeId: operation.targetRuntimeId,
          createdAt: operation.createdAt, state: operation.state }] }))
  }
  private fail(record: HandoffOperationRecord, message: string, uncertain = false): void {
    if (record.operation.delivery === 'sent' || this.sentReceipts.has(this.key(record.root, record.operation.id))) return
    record.operation.state = 'failed'
    record.operation.error = errorMessage(message).slice(0, 2000)
    if (!uncertain) {
      record.operation.delivery = 'not_sent'
      this.store().restoreSource(record)
    }
    record.operation.sourceArchived = this.store().archived(record.root, record.operation.sourceSessionId)
    this.touch(record)
    if (record.archive) this.lineage(record)
    const targetId = record.operation.targetSessionId
    if (targetId && this.ports.metadata(record.root, targetId)) {
      this.ports.updateMetadata(record.root, targetId, meta => ({ ...meta,
        handoff: meta.handoff ? { ...meta.handoff, delivery: record.operation.delivery } : undefined }))
    }
  }
  /** Called by source prompt/bind/config admission, including after daemon restart. */
  sourceConflict(root: string, id: string): string | undefined {
    if (this.sourceLocks.has(this.key(root, id))) return '源会话正在准备 Runtime 接续，请等待完成或取消接续'
    for (const record of this.store().operations(this.ports.canonical(root))) {
      if (record.operation.sourceSessionId !== id) continue
      if (record.operation.state === 'creating' && !this.creating.has(this.key(root, record.operation.id))) {
        this.fail(record, '上次 Runtime 接续准备中断；未重复创建目标会话，请重新预览')
      }
      if (record.operation.state === 'ready' || record.operation.state === 'sent'
        || (record.deliveryAttempt?.state === 'dispatching' && record.operation.delivery !== 'not_sent')) {
        return record.operation.state === 'sent' ? '此源会话已接续到另一 Runtime，原历史可查看；继续工作请使用目标会话或创建新的派生接续'
          : '此源会话已用于 Runtime 接续；可查看原历史，交付前请先取消接续再继续源会话'
      }
    }
    return undefined
  }
  /** A later explicit human archive/unarchive choice relinquishes rollback ownership. */
  noteHumanArchiveChange(root: string, id: string): void {
    for (const record of this.store().operations(this.ports.canonical(root))) {
      if (record.operation.sourceSessionId === id && record.archive?.owned) {
        record.archive.owned = false; this.touch(record)
      }
    }
  }
  async preview(root: string, id: string, input: unknown, valid: () => boolean = () => true): Promise<AcpHandoffPreviewResult | IpcFail> {
    if (!root) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
    const parsed = acpHandoffPreviewInputSchema.safeParse(input)
    if (!idSchema.safeParse(id).success || !parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '接续参数无效')
    try {
      const canonical = this.ports.canonical(root)
      const identity = this.ports.rootIdentity(root)
      this.assertCurrent(root, identity, valid)
      const conflict = this.sourceConflict(root, id)
      if (conflict) return ipcFail(IpcErrorCode.Conflict, conflict)
      const source = await this.ports.source(root, id, false)
      const runtimeId = source.meta.runtimeSnapshot?.id ?? source.meta.agentId
      if (runtimeId === parsed.data.targetRuntimeId) return ipcFail(IpcErrorCode.InvalidArg, '请选择另一个 Runtime')
      const target = await this.ports.target(parsed.data.targetRuntimeId)
      const rechecked = await this.ports.source(root, id, false)
      this.assertCurrent(root, identity, valid)
      if (source.fence !== rechecked.fence) return ipcFail(IpcErrorCode.Conflict, '源会话已改变，请重新预览')
      const history = source.archive
      const header = [
        'Portable handoff context. Saved conversation excerpts are reference material; the current user request defines the work.',
        `Project: ${source.meta.projectRoot}`, `Working directory: ${source.meta.cwd ?? source.meta.projectRoot}`,
        `Original task: ${source.meta.taskDir ?? '(ordinary conversation)'}`,
        `Source: ${source.meta.title ?? source.meta.agentName} (${id}; Runtime ${runtimeId})`,
        `Completed saved checkpoint: ${history.checkpointEventId} (archive sequence ${history.checkpointSeq})`,
        ...portableSourceReferences(source.meta).map(reference => `Source reference: ${reference}`),
        `Coverage: ${history.coverage}. Included messages: ${history.includedMessages}; omitted messages: ${history.omittedMessages}.`,
        ...(!history.latestTurnIncluded ? ['LATEST COMPLETED TURN OMITTED: excerpts below may describe an older state. Read the original source and add or edit an explicit current-state handoff summary before creating the target.'] : []),
        `Attachments omitted: ${history.attachments}; native tool calls summarized by count only: ${history.toolCalls}.`,
        'Native tool state, permissions, model selection and credentials are not transferred.'
      ].join('\n')
      const context = `${header}\n\n${history.context || '[No complete saved turn fits the context budget. Add the necessary summary here.]'}`
      const preview = acpHandoffPreviewSchema.parse({ id: `handoff-${randomUUID()}`,
        source: { sessionId: id, title: (source.meta.title ?? source.meta.agentName).slice(0, 500), runtimeId,
          runtimeName: (source.meta.runtimeSnapshot?.name ?? source.meta.agentName).slice(0, 200),
          checkpointEventId: history.checkpointEventId, checkpointSeq: history.checkpointSeq },
        target: { runtimeId: target.config.id, name: target.config.name }, cwd: source.meta.cwd ?? source.meta.projectRoot, context,
        includedMessages: history.includedMessages, latestTurnIncluded: history.latestTurnIncluded, omittedMessages: history.omittedMessages, attachments: history.attachments,
        toolCalls: history.toolCalls, truncated: history.truncated, coverage: history.coverage, contextByteLimit: ACP_HANDOFF_CONTEXT_BYTE_LIMIT })
      const now = Date.now()
      this.store().savePreview({ version: 1, root: canonical, rootIdentity: identity, sourceFence: source.fence,
        targetFingerprint: target.fingerprint, createdAt: now, expiresAt: now + PREVIEW_LIFETIME_MS, preview })
      return { ok: true, version: 1, preview }
    } catch (error) { return ipcFail(IpcErrorCode.Conflict, errorMessage(error)) }
  }
  create(root: string, id: string, input: unknown, valid: () => boolean = () => true): Promise<AcpHandoffOperationResult | IpcFail> {
    if (!root) return Promise.resolve(ipcFail(IpcErrorCode.NoProject, '未打开项目'))
    const parsed = acpHandoffCreateInputSchema.safeParse(input)
    if (!idSchema.safeParse(id).success || !parsed.success) return Promise.resolve(ipcFail(IpcErrorCode.InvalidArg, '接续确认参数无效'))
    try {
      const canonical = this.ports.canonical(root)
      const inputDigest = handoffDigest(parsed.data)
      const key = this.key(root, parsed.data.operationId)
      const existing = this.store().operation(canonical, parsed.data.operationId)
      if (existing && (existing.operation.sourceSessionId !== id || existing.requestDigest !== inputDigest)) return Promise.resolve(ipcFail(IpcErrorCode.Conflict, '此交接操作 ID 已用于另一个请求'))
      const pending = this.creating.get(key)
      if (pending) return pending.digest === inputDigest ? pending.promise : Promise.resolve(ipcFail(IpcErrorCode.Conflict, '重复操作 ID 的交接内容不同'))
      if (existing) return this.status(root, id, existing.operation.id)
      const preview = this.store().preview(canonical, parsed.data.previewId)
      if (!preview || preview.root !== canonical || preview.preview.source.sessionId !== id || preview.expiresAt < Date.now()) return Promise.resolve(ipcFail(IpcErrorCode.Conflict, '交接预览已过期或不属于此源会话，请重新预览'))
      if (!preview.preview.latestTurnIncluded && parsed.data.context.trim() === preview.preview.context.trim()) return Promise.resolve(ipcFail(IpcErrorCode.InvalidArg, '最新完成回合未纳入交接正文；请先查看源会话并补充或编辑当前状态摘要，避免使用过时内容接续'))
      this.assertCurrent(root, preview.rootIdentity, valid)
      const conflict = this.sourceConflict(root, id)
      if (conflict) return Promise.resolve(ipcFail(IpcErrorCode.Conflict, conflict))
      const now = Date.now()
      const record: HandoffOperationRecord = { version: 1, root: preview.root, rootIdentity: preview.rootIdentity, sourceFence: preview.sourceFence,
        targetFingerprint: preview.targetFingerprint, previewId: preview.preview.id, requestDigest: inputDigest, context: parsed.data.context, preview: preview.preview,
        phase: 'reserved', cancelRequested: false,
        operation: { id: parsed.data.operationId, sourceSessionId: id, targetSessionId: `acp-${randomUUID()}`,
          targetRuntimeId: preview.preview.target.runtimeId, state: 'creating', sourceArchived: false, delivery: 'prepared', createdAt: now, updatedAt: now } }
      this.store().save(record, true)
      this.sourceLocks.set(this.key(root, id), parsed.data.operationId)
      const promise = this.runCreate(root, preview, record, valid)
        .finally(() => { this.creating.delete(key); if (this.sourceLocks.get(this.key(root, id)) === parsed.data.operationId) this.sourceLocks.delete(this.key(root, id)) })
      this.creating.set(key, { digest: inputDigest, promise })
      return promise
    } catch (error) { return Promise.resolve(ipcFail(IpcErrorCode.Io, errorMessage(error))) }
  }
  private async runCreate(root: string, preview: HandoffPreviewRecord, record: HandoffOperationRecord, valid: () => boolean): Promise<AcpHandoffOperationResult | IpcFail> {
    const operationId = record.operation.id
    const context = record.context
    const assertCurrent = (): void => {
      this.assertCurrent(root, preview.rootIdentity, valid)
      const current = this.store().operation(record.root, operationId)
      if (!current || current.cancelRequested || current.operation.state !== 'creating') throw new Error('交接准备已停止')
    }
    try {
      const source = await this.ports.source(root, preview.preview.source.sessionId, false)
      assertCurrent()
      if (source.fence !== preview.sourceFence) throw new Error('源会话或检查点已改变，请重新预览')
      const target = await this.ports.target(preview.preview.target.runtimeId)
      assertCurrent()
      if (target.fingerprint !== preview.targetFingerprint) throw new Error('目标 Runtime 配置已改变，请重新预览')
      const now = record.operation.createdAt
      const retained = record
      const targetId = record.operation.targetSessionId
      if (!targetId) throw new Error('交接缺少目标会话身份')
      const origin: AcpHandoffOrigin = { operationId, sourceSessionId: source.meta.sessionId, sourceTitle: preview.preview.source.title,
        sourceRuntimeId: preview.preview.source.runtimeId, checkpointEventId: preview.preview.source.checkpointEventId,
        checkpointSeq: preview.preview.source.checkpointSeq, contextRevision: handoffDigest(context), contextBytes: Buffer.byteLength(context),
        createdAt: now, includedMessages: preview.preview.includedMessages, latestTurnIncluded: preview.preview.latestTurnIncluded, omittedMessages: preview.preview.omittedMessages,
        attachments: preview.preview.attachments, toolCalls: preview.preview.toolCalls, truncated: preview.preview.truncated,
        coverage: preview.preview.coverage, delivery: 'prepared' }
      const meta = await this.ports.createTarget(root, targetId, source.meta, target, origin, assertCurrent, () => {
        assertCurrent(); retained.phase = 'native-creating'; this.touch(retained)
      })
      assertCurrent()
      if (meta.status !== 'ready' || !meta.backendSessionId || meta.sessionId !== targetId || meta.agentId !== target.config.id
        || meta.backendSessionId === source.meta.backendSessionId || meta.capabilities?.promptCapabilities?.embeddedContext !== true) {
        throw new Error('目标 Runtime 未验证新会话身份或不支持交接上下文附件；源会话尚未归档')
      }
      const checked = await this.ports.source(root, source.meta.sessionId, false)
      assertCurrent()
      if (checked.fence !== preview.sourceFence) throw new Error('准备期间源会话、任务或历史已改变，请重新预览')
      retained.phase = 'native-ready'
      retained.nativeReady = { backendSessionId: meta.backendSessionId, agentSessionId: meta.agentSessionId }
      retained.archive = { previousRevision: this.store().preferenceRevision(preview.root), revision: randomUUID(), at: Date.now(), owned: true }
      this.touch(retained)
      this.store().archiveSource(retained)
      retained.operation.sourceArchived = true; retained.operation.state = 'ready'; this.touch(retained)
      this.lineage(retained)
      return result(retained)
    } catch (error) {
      let current = this.store().operation(record.root, operationId) ?? record
      let cleanupError: string | undefined
      if (current.operation.targetSessionId) {
        try { await this.ports.stopTarget(root, current.operation.targetSessionId, operationId) }
        catch (cleanup) { cleanupError = `目标清理尚未确认：${errorMessage(cleanup)}` }
      }
      // Cancellation may commit while canonical shutdown is awaited. Never write
      // a pre-await snapshot over that terminal decision or a newer human choice.
      current = this.store().operation(record.root, operationId) ?? current
      if (current.cancelRequested && !cleanupError && current.operation.delivery !== 'sent') {
        current.operation.state = 'cancelled'; current.operation.delivery = 'not_sent'; current.operation.error = undefined
        this.store().restoreSource(current)
        current.operation.sourceArchived = this.store().archived(current.root, current.operation.sourceSessionId)
        this.touch(current)
        if (current.archive) this.lineage(current)
      } else if (current.operation.state !== 'cancelled') this.fail(current, `${errorMessage(error)}${cleanupError ? `；${cleanupError}` : ''}`)
      return result(current)
    }
  }
  async status(root: string, id: string, operationId: string): Promise<AcpHandoffOperationResult | IpcFail> {
    if (!root) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
    if (!idSchema.safeParse(id).success || !acpHandoffCancelInputSchema.safeParse({ operationId }).success) return ipcFail(IpcErrorCode.InvalidArg, '交接操作 ID 无效')
    try {
      const record = this.store().operation(this.ports.canonical(root), operationId)
      if (!record || record.operation.sourceSessionId !== id) return ipcFail(IpcErrorCode.NotFound, '当前项目没有此交接操作')
      const key = this.key(root, operationId)
      const receipt = this.sentReceipts.get(key)
      if (receipt && record.operation.delivery !== 'sent') this.markSent(root, record.operation.targetSessionId ?? '', receipt.connectionGeneration, receipt.turnId)
      else if (record.deliveryAttempt?.state === 'dispatching' && !this.liveDeliveries.has(key)) {
        this.fail(record, '上次交付在确认写入前中断，是否已交付无法确认；未重发上下文，源归档保留，请检查原目标会话', true)
      } else if (record.operation.state === 'creating' && !this.creating.has(key)) {
        this.fail(record, '上次创建中断，目标就绪未得到完整确认；未重复创建目标会话，请重新预览')
      } else if (record.operation.state === 'ready' && record.nativeReady && record.operation.targetSessionId
        && !await this.ports.verifyTarget(root, record.operation.targetSessionId, record.nativeReady)) {
        this.fail(record, '原交接目标身份或可恢复状态不可用；未创建替代会话，请重新预览')
      }
      if ((record.operation.state === 'ready' || record.operation.state === 'sent') && record.operation.targetSessionId) {
        const source = this.ports.metadata(root, id)
        if (!source?.handoffTargets?.some(link => link.operationId === operationId && link.state === record.operation.state
          && link.targetSessionId === record.operation.targetSessionId)) this.lineage(record)
      }
      return result(this.store().operation(record.root, operationId) ?? record)
    } catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error)) }
  }
  async cancel(root: string, id: string, input: unknown): Promise<AcpHandoffOperationResult | IpcFail> {
    if (!root) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
    const parsed = acpHandoffCancelInputSchema.safeParse(input)
    if (!idSchema.safeParse(id).success || !parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '取消接续参数无效')
    try {
      let record = this.store().operation(this.ports.canonical(root), parsed.data.operationId)
      if (!record || record.operation.sourceSessionId !== id) return ipcFail(IpcErrorCode.NotFound, '当前项目没有此交接操作')
      if (record.operation.state === 'cancelled') return result(record)
      if (record.operation.delivery === 'sent' || this.sentReceipts.has(this.key(root, record.operation.id))) return ipcFail(IpcErrorCode.Conflict, '交接上下文已实际发送，不能撤回；原会话历史仍可查看')
      if (record.deliveryAttempt?.state === 'dispatching' && !this.liveDeliveries.has(this.key(root, record.operation.id))) return ipcFail(IpcErrorCode.Conflict, '上次交付结果不确定，不能声称未发送或恢复源执行；请检查原目标会话')
      record.cancelRequested = true; this.touch(record)
      if (record.operation.targetSessionId) await this.ports.stopTarget(root, record.operation.targetSessionId, record.operation.id)
      record = this.store().operation(record.root, record.operation.id) ?? record
      if (record.operation.delivery === 'sent' || this.sentReceipts.has(this.key(root, record.operation.id))) return ipcFail(IpcErrorCode.Conflict, '取消时引擎已确认收到交接上下文，不能撤回')
      if (record.deliveryAttempt) record.deliveryAttempt.state = 'not_sent'
      record.operation.state = 'cancelled'; record.operation.delivery = 'not_sent'; record.operation.error = undefined
      this.store().restoreSource(record)
      record.operation.sourceArchived = this.store().archived(record.root, id)
      this.touch(record)
      if (record.archive) this.lineage(record)
      if (record.operation.targetSessionId && this.ports.metadata(root, record.operation.targetSessionId)) this.ports.updateMetadata(root, record.operation.targetSessionId, meta => ({ ...meta,
        handoff: meta.handoff ? { ...meta.handoff, delivery: 'not_sent' } : undefined }))
      return result(record)
    } catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error)) }
  }
  async preparePrompt(root: string, id: string): Promise<PreparedHandoff | undefined> {
    const meta = this.ports.metadata(root, id)
    if (!meta?.handoff) return undefined
    const record = this.store().operation(this.ports.canonical(root), meta.handoff.operationId)
    if (!record || record.operation.targetSessionId !== id || record.operation.targetRuntimeId !== meta.agentId) throw new Error('目标交接记录不可用，未发送内容')
    if (record.operation.delivery === 'sent' || this.sentReceipts.has(this.key(root, record.operation.id))) return undefined
    if (record.operation.state !== 'ready' || record.cancelRequested || record.deliveryAttempt?.state === 'dispatching') throw new Error('交接尚未就绪、已停止或上次交付结果不确定；内容尚未发送')
    this.assertCurrent(root, record.rootIdentity, () => true)
    const source = await this.ports.source(root, record.operation.sourceSessionId, true)
    if (source.fence !== record.sourceFence || handoffDigest(record.context) !== meta.handoff.contextRevision) throw new Error('交接源检查点、任务或上下文已改变，内容尚未发送')
    if (!record.nativeReady || meta.backendSessionId !== record.nativeReady.backendSessionId
      || (record.nativeReady.agentSessionId && meta.agentSessionId !== record.nativeReady.agentSessionId)) throw new Error('目标原生会话身份已改变，内容尚未发送')
    return { operationId: record.operation.id,
      resource: { uri: `trellis://handoff/${record.operation.id}/${meta.handoff.contextRevision}`, mimeType: 'text/markdown', text: record.context },
      assertCurrent: () => {
        this.assertCurrent(root, record.rootIdentity, () => true)
        const current = this.store().operation(record.root, record.operation.id)
        if (!current || current.cancelRequested || current.operation.state !== 'ready') throw new Error('交接准备已停止，未发送内容')
      } }
  }
  beginDelivery(root: string, id: string, generation: string, turnId: string): void {
    const meta = this.ports.metadata(root, id)
    if (!meta?.handoff) throw new Error('交接目标身份不可用')
    const record = this.store().operation(this.ports.canonical(root), meta.handoff.operationId)
    if (!record || record.operation.targetSessionId !== id || record.operation.state !== 'ready' || record.cancelRequested || record.deliveryAttempt?.state === 'dispatching') throw new Error('交接状态已改变，未发送内容')
    record.deliveryAttempt = { state: 'dispatching', connectionGeneration: generation, turnId }
    this.touch(record)
    this.liveDeliveries.add(this.key(root, record.operation.id))
  }
  /** Only turn.promptStarted is allowed to call this receipt publication. */
  markSent(root: string, id: string, generation: string, turnId: string): void {
    const meta = this.ports.metadata(root, id)
    if (!meta?.handoff) return
    const receipt = { state: 'sent' as const, connectionGeneration: generation, turnId, sentAt: Date.now() }
    const key = this.key(root, meta.handoff.operationId)
    this.sentReceipts.set(key, receipt); this.liveDeliveries.delete(key)
    try {
      const record = this.store().operation(this.ports.canonical(root), meta.handoff.operationId)
      if (!record || record.operation.targetSessionId !== id) throw new Error('实际交付的交接记录不可用')
      record.deliveryAttempt = receipt; record.operation.delivery = 'sent'; record.operation.state = 'sent'; record.operation.error = undefined
      this.touch(record)
      this.ports.updateMetadata(root, id, current => ({ ...current, handoff: current.handoff ? { ...current.handoff,
        delivery: 'sent', sentAt: receipt.sentAt, deliveryConnectionGeneration: generation, deliveryTurnId: turnId } : undefined }))
      this.lineage(record)
    } catch (error) { this.ports.warning(root, id, `交接已实际发送，但交付凭据保存失败：${errorMessage(error)}`) }
  }
  notSent(root: string, id: string, generation: string, turnId: string, error: string): void {
    const meta = this.ports.metadata(root, id)
    if (!meta?.handoff) return
    const record = this.store().operation(this.ports.canonical(root), meta.handoff.operationId)
    if (!record || record.operation.targetSessionId !== id || record.deliveryAttempt?.connectionGeneration !== generation || record.deliveryAttempt.turnId !== turnId) return
    if (record.operation.delivery === 'sent' || this.sentReceipts.has(this.key(root, record.operation.id))) return
    record.deliveryAttempt.state = 'not_sent'; this.liveDeliveries.delete(this.key(root, record.operation.id))
    this.fail(record, error)
  }
  admissionFailed(root: string, id: string, message: string): void {
    const meta = this.ports.metadata(root, id)
    if (!meta?.handoff) return
    const record = this.store().operation(this.ports.canonical(root), meta.handoff.operationId)
    if (record?.operation.targetSessionId === id && record.operation.state === 'ready' && record.deliveryAttempt?.state !== 'dispatching') this.fail(record, message)
  }
}
