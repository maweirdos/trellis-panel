import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createTaskOutputNativeSchema, taskOutputBindingViewSchema, type TaskOutputComparison, type TaskOutputNativeInput, type TaskOutputPreview, type TaskOutputReply, type TaskOutputStatus } from '../../../../shared/crux-task-outputs'
import { taskProgressPinSchema, type TaskProgressPin } from '../../../../shared/crux-task-progress-native'
import { TEAM_MAX_REQUEST_BYTES } from '../../../../shared/team-platform'
import { taskOutputOriginSchema } from '../../../../shared/task-output-origin'
import type { TeamTaskMaterialReceipt } from '../../../../shared/team-task-materials'
import { readBounded, writeAtomic } from '../../../daemon/files'
import type { NativeTaskProgressSender } from '../task-progress-sender'
import { nativeRootKey } from '../task-workspace-records'
import { cruxWorkProjectIdentity } from '../work-project'
import { authorizeOutput, privateOutputRecord } from './authority'
import { outputFileStamp, outputHash, readOutputFile } from './files'
import { MAX_OUTPUT_BYTES, MAX_PENDING_BYTES, MAX_STATE_BYTES, OUTPUT_STABLE_MS, outputStoreSchema, TaskOutputError, type OutputBinding, type OutputCommand, type OutputStore } from './types'

export interface TaskOutputCoordinatorOptions {
  directory: string; userData: string
  sender(pin: TaskProgressPin): NativeTaskProgressSender | Promise<NativeTaskProgressSender>
  assertOwner(): void
  now?(): number
}
type HeldPreview = { value: TaskOutputPreview; input: Extract<TaskOutputNativeInput, { operation: 'outputs.preview' }>; record: Awaited<ReturnType<typeof authorizeOutput>>['record']; references: OutputBinding['references']; authority: string; compared: boolean; compareDocument: { documentId: string; versionId?: string; digest: string } | null }
type Review = { bindingId: string; interactionKey: string; localDigest: string; remoteDigest: string; revision: number; expiresAt: number }
const nativeSchema = createTaskOutputNativeSchema(taskProgressPinSchema)
const queryOf = (row: OutputBinding) => ({ workspaceKey: row.pin.workspaceKey, taskId: row.pin.taskId })
const materialScope = (row: OutputBinding) => ({ spaceId: row.pin.spaceId, taskCreatedAt: row.taskCreatedAt })
const samePin = (a: TaskProgressPin, b: TaskProgressPin): boolean => JSON.stringify(a) === JSON.stringify(b)
function failure(error: unknown): TaskOutputReply<never> {
  const value = error instanceof Error ? error as Error & { code?: string; reason?: string; outcomeUnknown?: boolean } : null
  return { ok: false, code: value?.code ?? value?.reason ?? 'OUTPUT_UNAVAILABLE', error: value?.message ?? '本机受管产物无法同步，原文件与命令已保留', ...(value?.outcomeUnknown ? { outcomeUnknown: true } : {}) }
}

/** Existing daemon owns polling and lifetime. No GUI-selected source or progress row is required. */
export class TaskOutputCoordinator {
  private store: OutputStore
  private readonly file: string
  private readonly previews = new Map<string, HeldPreview>()
  private readonly reviews = new Map<string, Review>()
  private readonly checked = new Map<string, number>()
  private readonly fileStamps = new Map<string, string>()
  private work: Promise<unknown> = Promise.resolve()
  private closed = false
  private pumping = false
  private offset = 0
  constructor(private readonly options: TaskOutputCoordinatorOptions) {
    options.assertOwner()
    const root = realpathSync.native(options.directory), directory = join(root, 'task-outputs')
    if (nativeRootKey(root) !== nativeRootKey(resolve(options.directory))) throw new TaskOutputError('OUTPUT_STORE_PATH', '产物同步目录被重定向')
    mkdirSync(directory, { recursive: true })
    if (nativeRootKey(realpathSync.native(directory)) !== nativeRootKey(directory)) throw new TaskOutputError('OUTPUT_STORE_PATH', '产物同步记录目录被重定向')
    this.file = join(directory, 'state.json')
    this.store = existsSync(this.file) ? outputStoreSchema.parse(JSON.parse(readBounded(this.file, MAX_STATE_BYTES))) : { version: 1, bindings: [] }
    if (this.store.bindings.some(row => row.pending?.state === 'dispatching')) this.commit(next => { for (const row of next.bindings) if (row.pending?.state === 'dispatching') { row.pending.state = 'unknown'; row.state = 'unknown'; row.error = '上次发送结果未确认，请核对原编号回执；未自动重发' } })
  }
  private now(): number { return this.options.now?.() ?? Date.now() }
  hasWork(): boolean { return !this.closed && this.store.bindings.some(row => row.state === 'active' || row.state === 'pending') }
  private commit(change: (state: OutputStore) => void): void {
    this.options.assertOwner()
    const next = structuredClone(this.store); change(next)
    const valid = outputStoreSchema.parse(next), body = JSON.stringify(valid)
    const pendingBytes = valid.bindings.reduce((bytes, row) => bytes + (row.pending && 'text' in row.pending.command ? Buffer.byteLength(row.pending.command.text) : 0), 0)
    if (pendingBytes > MAX_PENDING_BYTES || Buffer.byteLength(body) > MAX_STATE_BYTES) throw new TaskOutputError('OUTPUT_CAPACITY', '待发产物超过本机有界保留容量；原文件和既有队列已保留')
    writeAtomic(this.file, body); this.store = valid
  }
  private update(id: string, change: (row: OutputBinding) => void): void { this.commit(state => { const row = state.bindings.find(row => row.bindingId === id); if (!row) throw new TaskOutputError('OUTPUT_BINDING_MISSING', '原产物绑定不存在'); change(row) }) }
  private row(id: string): OutputBinding { const row = this.store.bindings.find(row => row.bindingId === id); if (!row) throw new TaskOutputError('OUTPUT_BINDING_MISSING', '原产物绑定不存在'); return row }
  private registered(row: OutputBinding, record: Awaited<ReturnType<typeof authorizeOutput>>['record']): void {
    if (record.sourceRevision !== row.sourceRevision || record.projectIdentity !== row.projectIdentity || record.localTaskId !== row.localTaskId
      || nativeRootKey(record.projectRoot) !== nativeRootKey(row.projectRoot) || record.relativeDir !== `.trellis/tasks/${row.taskDir}`) throw new TaskOutputError('OUTPUT_CONTEXT_CHANGED', '原纳管文件的固定输入、物理副本或本机任务已变化，未跟随同名路径改投')
  }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.work.catch(() => {}).then(() => { this.options.assertOwner(); if (this.closed) throw new TaskOutputError('OUTPUT_CLOSED', '产物同步所有者已关闭'); return run() })
    this.work = next; return next
  }
  async close(): Promise<void> { this.closed = true; await this.work.catch(() => {}); this.previews.clear(); this.reviews.clear() }
  async execute(raw: unknown): Promise<TaskOutputReply<TaskOutputStatus | TaskOutputPreview | TaskOutputComparison>> {
    try { const input = nativeSchema.parse(raw); return { ok: true, value: await this.exclusive(() => this.executeOwned(input)) } }
    catch (error) { return failure(error) }
  }
  private async authorized(input: Pick<TaskOutputNativeInput, 'pin' | 'query' | 'expected'>) {
    const sender = await this.options.sender(input.pin)
    const authority = await authorizeOutput(this.options.userData, input.pin, input.query, input.expected, sender)
    const key = outputHash(JSON.stringify([input.pin, input.expected]))
    if (this.checked.size >= 64 && !this.checked.has(key)) this.checked.delete(this.checked.keys().next().value ?? '')
    this.checked.set(key, this.now())
    return { ...authority, sender }
  }
  private async status(input: TaskOutputNativeInput): Promise<TaskOutputStatus> {
    const authority = await this.authorized(input), remote = await authority.sender.outputMaterials(authority.taskCreatedAt)
    const page = await remote.list({ spaceId: input.pin.spaceId, taskCreatedAt: authority.taskCreatedAt, limit: 50, ...('cursor' in input && input.cursor ? { cursor: input.cursor } : {}) })
    return { bindings: this.store.bindings.filter(row => row.pin.workspaceKey === input.pin.workspaceKey && row.pin.taskId === input.pin.taskId && samePin(row.pin, input.pin))
      .map(row => taskOutputBindingViewSchema.strip().parse({ ...row, inputOutdated: row.expected.contextId === input.expected.contextId && row.expected.generation === input.expected.generation ? authority.inputOutdated : row.inputOutdated,
        pending: row.pending ? { commandId: row.pending.command.commandId, digest: row.pending.command.expectedDigest, state: row.pending.state } : null })),
      documents: page.page.items, nextCursor: page.page.nextCursor, hasMore: page.page.hasMore }
  }
  private selected(input: Extract<TaskOutputNativeInput, { operation: 'outputs.compare' | 'outputs.recover' }>): OutputBinding {
    if (!input.bindingId) throw new TaskOutputError('OUTPUT_BINDING_MISSING', '请选择原产物绑定')
    const row = this.row(input.bindingId)
    if (!samePin(row.pin, input.pin) || row.pin.workspaceKey !== input.query.workspaceKey || row.pin.taskId !== input.query.taskId) throw new TaskOutputError('OUTPUT_SCOPE_CHANGED', '产物绑定属于另一原账号、任务或设备')
    return row
  }
  private async executeOwned(input: TaskOutputNativeInput): Promise<TaskOutputStatus | TaskOutputPreview | TaskOutputComparison> {
    for (const [key, preview] of this.previews) if (preview.value.expiresAt < this.now()) this.previews.delete(key)
    for (const [key, review] of this.reviews) if (review.expiresAt < this.now()) this.reviews.delete(key)
    if (input.operation === 'outputs.read') return this.status(input)
    if (input.operation === 'outputs.preview') {
      const authority = await this.authorized(input), record = authority.record
      const actual = readOutputFile(record.projectRoot, `${record.relativeDir}/${input.selection.file}`)
      if (!actual.text.trim() || this.now() - actual.mtime < OUTPUT_STABLE_MS) throw new TaskOutputError('OUTPUT_UNSTABLE', '正文为空或刚刚保存，请等待稳定后预览')
      if (input.selection.file === 'prd.md' && actual.digest === record.generatedPrdRevision) throw new TaskOutputError('OUTPUT_PRD_INDEX_ONLY', '当前 prd.md 是生成的阅读索引；完整冻结输入在 references/source-materials.json，不能将索引作为完整团队 PRD 上传。请编写并比较工作草稿后再纳管')
      const remote = await authority.sender.outputMaterials(authority.taskCreatedAt)
      const document = input.selection.documentId ? await remote.read(input.selection.documentId, { spaceId: input.pin.spaceId, taskCreatedAt: authority.taskCreatedAt }) : null
      if (document && (document.document.kind !== input.selection.kind || !document.document.editorIds.includes(input.pin.ownerId))) throw new TaskOutputError('OUTPUT_DOCUMENT_DENIED', '目标文档类型或当前编辑权限不匹配')
      const value: TaskOutputPreview = { previewId: randomUUID(), expiresAt: this.now() + 5 * 60_000, selection: input.selection,
        title: document?.document.draft.title ?? `${record.material.title} · ${input.selection.kind}`.slice(0, 300).replace(/[\uD800-\uDBFF]$/u, ''), text: actual.text, digest: actual.digest, byteLength: actual.byteLength,
        documentId: document?.document.documentId ?? null, draftRevision: document?.document.draftRevision ?? null,
        projectRoot: record.projectRoot, taskDir: basename(record.relativeDir ?? ''), taskId: input.pin.taskId, spaceId: input.pin.spaceId, approverIds: document?.document.approverIds ?? input.selection.approverIds ?? [],
        workingPrd: input.selection.file === 'prd.md', comparisonTitle: input.selection.file === 'prd.md' ? document ? '所选团队 PRD 草稿' : record.material.teamMaterialReferences?.some(ref => ref.kind === 'prd') ? '原采用的团队 PRD' : '原完整冻结任务输入（尚无所选团队 PRD）' : null }
      if (Buffer.byteLength(JSON.stringify(value)) > TEAM_MAX_REQUEST_BYTES) throw new TaskOutputError('OUTPUT_CAPACITY', '正文编码后的预览超过传输上限，请缩减正文')
      const fixedPrd = record.material.teamMaterialReferences?.find(ref => ref.kind === 'prd')
      // The actual main window has one current opt-in decision. A new preview revokes old tokens.
      this.previews.clear()
      this.previews.set(value.previewId, { value, input, record, references: document?.document.draft.references ?? [], authority: authority.authority, compared: false,
        compareDocument: document ? { documentId: document.document.documentId, digest: document.selected.bodyDigest } : fixedPrd ? { documentId: fixedPrd.documentId, versionId: fixedPrd.versionId, digest: fixedPrd.bodyDigest } : null })
      return value
    }
    if (input.operation === 'outputs.confirm') {
      const held = this.previews.get(input.previewId)
      if (!held || held.input.interactionKey !== input.interactionKey || !samePin(held.input.pin, input.pin) || JSON.stringify(held.input.expected) !== JSON.stringify(input.expected)) throw new TaskOutputError('OUTPUT_PREVIEW_STALE', '原预览已失效，请从当前任务重新预览')
      if (held.value.workingPrd && !held.compared) throw new TaskOutputError('OUTPUT_PRD_COMPARE_REQUIRED', '修改后的 PRD 仅是工作草稿；请先比较团队正文或完整冻结输入，再明确纳管')
      const authority = await this.authorized(input), actual = readOutputFile(authority.record.projectRoot, `${authority.record.relativeDir}/${held.value.selection.file}`)
      if (actual.digest !== held.value.digest || authority.authority !== held.authority || JSON.stringify(authority.record) !== JSON.stringify(held.record)) throw new TaskOutputError('OUTPUT_PREVIEW_STALE', '正文、原授权或开发上下文已变化，请重新预览')
      if (this.store.bindings.some(row => samePin(row.pin, input.pin) && row.expected.contextId === input.expected.contextId && row.file === held.value.selection.file && row.state !== 'stopped')) throw new TaskOutputError('OUTPUT_ALREADY_MANAGED', '该文件已纳管，请使用原绑定恢复或停止')
      const value = held.value, binding: OutputBinding = { bindingId: randomUUID(), pin: input.pin, expected: input.expected, file: value.selection.file, kind: value.selection.kind,
        documentId: value.documentId, title: value.title, state: 'active', lastConfirmed: null, pending: null, conflictVersionId: null, error: null, inputOutdated: authority.inputOutdated,
        taskCreatedAt: authority.taskCreatedAt, projectRoot: authority.record.projectRoot, taskDir: value.taskDir, localTaskId: authority.record.localTaskId ?? '', sourceRevision: authority.record.sourceRevision,
        projectIdentity: authority.record.projectIdentity ?? '', references: held.references, approverIds: value.approverIds, baselineDraftRevision: value.draftRevision,
        observation: { digest: value.digest, mtime: actual.mtime, at: this.now() - OUTPUT_STABLE_MS } }
      binding.pending = { command: this.command(binding, actual.text), state: 'queued', receipt: null }; binding.state = 'pending'
      this.commit(state => state.bindings.push(binding)); this.previews.delete(input.previewId)
      // Confirmation registers the durable intent; the existing daemon pump performs uploads.
      return this.status(input)
    }
    if (input.operation === 'outputs.compare') return this.compare(input)
    const row = this.selected(input)
    if (input.action === 'pause' || input.action === 'stop') {
      this.update(row.bindingId, next => { next.state = input.action === 'stop' ? 'stopped' : 'paused'; next.error = null })
    } else if (input.action === 'reconcile') await this.reconcile(row.bindingId)
    else if (input.action === 'retry') {
      if (!row.pending) throw new TaskOutputError('OUTPUT_NO_PENDING', '没有可重试的原命令')
      if (!await this.reconcile(row.bindingId)) await this.dispatch(row.bindingId)
    } else await this.resume(input)
    return this.status(input)
  }
  private command(row: OutputBinding, text: string): OutputCommand {
    const record = privateOutputRecord(this.options.userData, row.pin, row.expected, row.taskCreatedAt)
    this.registered(row, record)
    const bundle = record.material.governance
    const origin = taskOutputOriginSchema.parse({ kind: 'native-task-output', inputVersion: row.sourceRevision, attemptId: row.expected.contextId, generation: row.expected.generation, file: row.file,
      ...(bundle ? { inputBundle: { bundleId: bundle.bundleId, revision: bundle.revision, digest: bundle.digest } } : {}) })
    const common = { ...materialScope(row), commandId: randomUUID(), expectedEpoch: row.pin.epoch, title: row.title, text, expectedDigest: outputHash(text), references: row.references, origin }
    const command: OutputCommand = row.documentId && row.baselineDraftRevision ? { ...common, action: 'saveDraft', documentId: row.documentId, expectedDraftRevision: row.baselineDraftRevision }
      : { ...common, action: 'create', kind: row.kind, editorIds: [row.pin.ownerId], approverIds: row.approverIds }
    if (!text.trim() || Buffer.byteLength(text) > MAX_OUTPUT_BYTES || Buffer.byteLength(JSON.stringify(command)) > TEAM_MAX_REQUEST_BYTES) throw new TaskOutputError('OUTPUT_CAPACITY', '正文为空或超过单文件/传输上限，尚未上传')
    return command
  }
  private async prepareCommand(id: string, text: string): Promise<void> {
    const row = this.row(id)
    if (row.pending) return
    const command = this.command(row, text)
    this.update(id, next => { next.pending = { command, state: 'queued', receipt: null }; next.state = 'pending'; next.error = null })
  }
  private async receipt(id: string, receipt: TeamTaskMaterialReceipt, sender: NativeTaskProgressSender): Promise<void> {
    const row = this.row(id), pending = row.pending
    if (!pending || !('text' in pending.command) || receipt.commandId !== pending.command.commandId || !receipt.versionId) throw new TaskOutputError('OUTPUT_RECEIPT_MISMATCH', '回执不属于原产物正文')
    this.update(id, next => { if (next.pending) next.pending.receipt = receipt })
    const remote = await sender.outputMaterials(row.taskCreatedAt), version = await remote.read(receipt.documentId, { ...materialScope(row), versionId: receipt.versionId })
    if (version.selected.bodyDigest !== pending.command.expectedDigest || version.text !== pending.command.text) throw new TaskOutputError('OUTPUT_BODY_MISMATCH', '回执对应的真实正文未通过核对，原命令仍保留')
    this.update(id, next => {
      next.documentId = receipt.documentId; next.pending = null; next.observation = null
      if (receipt.outcome === 'conflict-preserved') { next.state = 'conflict'; next.conflictVersionId = receipt.versionId; next.error = '团队草稿已有新修改；本机候选已保留，请比较并在本机合并后恢复' }
      else { next.state = next.state === 'stopped' ? 'stopped' : 'active'; next.baselineDraftRevision = receipt.draftRevision; next.conflictVersionId = null; next.error = null;
        next.lastConfirmed = { at: receipt.committedAt, digest: pending.command.expectedDigest, versionId: receipt.versionId ?? '', draftRevision: receipt.draftRevision } }
    })
  }
  private async reconcile(id: string): Promise<boolean> {
    const row = this.row(id)
    if (!row.pending) return true
    const sender = await this.options.sender(row.pin), remote = await sender.outputMaterials(row.taskCreatedAt)
    const receipt = await remote.receipt(row.pending.command)
    if (!receipt) return false
    await this.receipt(id, receipt, sender); return true
  }
  private async dispatch(id: string): Promise<void> {
    const row = this.row(id), pending = row.pending
    if (!pending) return
    const authority = await this.authorized({ pin: row.pin, query: queryOf(row), expected: row.expected })
    this.registered(row, authority.record)
    if (this.closed) return
    this.update(id, next => { if (next.pending) next.pending.state = 'dispatching'; next.state = 'pending'; next.inputOutdated = authority.inputOutdated })
    try {
      const transport = await authority.sender.outputMaterials(row.taskCreatedAt)
      const reply = await transport.command(pending.command)
      this.update(id, next => { if (next.pending) next.pending.receipt = reply.result })
      privateOutputRecord(this.options.userData, row.pin, row.expected, row.taskCreatedAt)
      await this.receipt(id, reply.result, authority.sender)
    } catch (error) {
      const retained = this.row(id).pending
      const unknown = Boolean(retained?.receipt) || (error instanceof Error && 'outcomeUnknown' in error && Boolean(error.outcomeUnknown))
      this.update(id, next => { if (next.pending) next.pending.state = unknown ? 'unknown' : 'queued'; next.state = unknown ? 'unknown' : 'paused'; next.error = error instanceof Error ? error.message : '原发送结果待核对' })
    }
  }
  private async compare(input: Extract<TaskOutputNativeInput, { operation: 'outputs.compare' }>): Promise<TaskOutputComparison> {
    if (input.previewId) {
      if (input.bindingId || input.side !== 'remote') throw new TaskOutputError('OUTPUT_COMPARE_TARGET', '请选择单一原预览的比较来源')
      const held = this.previews.get(input.previewId)
      if (!held || held.input.interactionKey !== input.interactionKey || !samePin(held.input.pin, input.pin) || !held.value.workingPrd) throw new TaskOutputError('OUTPUT_PREVIEW_STALE', '原 PRD 预览已失效')
      const authority = await this.authorized(input), local = readOutputFile(authority.record.projectRoot, `${authority.record.relativeDir}/prd.md`)
      if (local.digest !== held.value.digest || authority.authority !== held.authority) throw new TaskOutputError('OUTPUT_PREVIEW_STALE', 'PRD 草稿或原授权已变化，请重新预览')
      let text: string, digest: string, versionId: string | null = null, draftRevision: number | null = null
      if (held.compareDocument) {
        const transport = await authority.sender.outputMaterials(authority.taskCreatedAt), view = await transport.read(held.compareDocument.documentId, { spaceId: input.pin.spaceId, taskCreatedAt: authority.taskCreatedAt, ...(held.compareDocument.versionId ? { versionId: held.compareDocument.versionId } : {}) })
        if (view.selected.bodyDigest !== held.compareDocument.digest) throw new TaskOutputError('OUTPUT_PREVIEW_STALE', '比较所用团队 PRD 已变化，请重新预览')
        text = view.text; digest = view.selected.bodyDigest; versionId = view.selected.versionId; draftRevision = view.document.draftRevision
      } else { const source = readOutputFile(authority.record.projectRoot, `${authority.record.relativeDir}/references/source-materials.json`, 256 * 1024); text = source.text; digest = source.digest }
      held.compared = true
      return { side: 'remote', text, digest, byteLength: Buffer.byteLength(text), title: held.value.comparisonTitle ?? '原输入', versionId, draftRevision }
    }
    const row = this.selected(input), sender = await this.options.sender(row.pin)
    const original = await this.authorized({ pin: row.pin, query: queryOf(row), expected: row.expected })
    this.registered(row, original.record)
    if (input.side === 'candidate' && row.pending) {
      const command = row.pending.command
      return { side: 'candidate', text: command.text, digest: command.expectedDigest, byteLength: Buffer.byteLength(command.text), title: command.title, versionId: null, draftRevision: row.baselineDraftRevision }
    }
    if (!row.documentId) throw new TaskOutputError('OUTPUT_DOCUMENT_MISSING', '首次创建结果尚未核对，请先查询原回执')
    const remote = await sender.outputMaterials(row.taskCreatedAt), view = await remote.read(row.documentId, { ...materialScope(row), ...(input.side === 'candidate' && row.conflictVersionId ? { versionId: row.conflictVersionId } : {}) })
    if (input.side === 'candidate' && !row.conflictVersionId) throw new TaskOutputError('OUTPUT_CANDIDATE_MISSING', '没有已确认的冲突候选')
    let text = view.text, digest = view.selected.bodyDigest, byteLength = view.selected.byteLength
    if (input.side === 'local') { const record = privateOutputRecord(this.options.userData, row.pin, row.expected, row.taskCreatedAt); this.registered(row, record); const actual = readOutputFile(record.projectRoot, `${record.relativeDir}/${row.file}`); text = actual.text; digest = actual.digest; byteLength = actual.byteLength }
    let reviewToken: string | undefined
    if (input.side === 'remote') {
      const record = privateOutputRecord(this.options.userData, row.pin, row.expected, row.taskCreatedAt), local = readOutputFile(record.projectRoot, `${record.relativeDir}/${row.file}`)
      this.registered(row, record)
      for (const [key, review] of this.reviews) if (review.bindingId === row.bindingId) this.reviews.delete(key)
      if (this.reviews.size >= 16) throw new TaskOutputError('OUTPUT_REVIEW_CAPACITY', '请先完成已有比较')
      reviewToken = randomUUID(); this.reviews.set(reviewToken, { bindingId: row.bindingId, interactionKey: input.interactionKey, localDigest: local.digest, remoteDigest: view.selected.bodyDigest, revision: view.document.draftRevision, expiresAt: this.now() + 5 * 60_000 })
    }
    return { side: input.side, text, digest, byteLength, title: row.title, versionId: input.side === 'local' ? null : view.selected.versionId, draftRevision: input.side === 'local' ? null : view.document.draftRevision, ...(reviewToken ? { reviewToken } : {}) }
  }
  private async resume(input: Extract<TaskOutputNativeInput, { operation: 'outputs.recover' }>): Promise<void> {
    const row = this.selected(input)
    if (row.pending) throw new TaskOutputError('OUTPUT_PENDING_RETAINED', '请先核对或重试原命令，不能用新正文替换待确认意图')
    const authority = await this.authorized({ pin: row.pin, query: queryOf(row), expected: row.expected }), local = readOutputFile(authority.record.projectRoot, `${authority.record.relativeDir}/${row.file}`)
    this.registered(row, authority.record)
    let revision = row.baselineDraftRevision, title = row.title, references = row.references
    if (row.documentId) {
      const remote = await authority.sender.outputMaterials(row.taskCreatedAt), view = await remote.read(row.documentId, materialScope(row))
      if (row.state === 'conflict' || view.document.draftRevision !== row.baselineDraftRevision) {
        const review = input.reviewToken && this.reviews.get(input.reviewToken)
        if (!review || review.bindingId !== row.bindingId || review.interactionKey !== input.interactionKey || review.localDigest !== local.digest || review.remoteDigest !== view.selected.bodyDigest || review.revision !== view.document.draftRevision) throw new TaskOutputError('OUTPUT_COMPARE_REQUIRED', '请先比较当前团队稿并在本机合并，再以所见修订恢复')
        revision = review.revision; title = view.selected.title; references = view.selected.references; this.reviews.delete(input.reviewToken ?? '')
      }
    }
    this.fileStamps.delete(row.bindingId)
    this.update(row.bindingId, next => { next.state = 'active'; next.error = null; next.baselineDraftRevision = revision; next.title = title; next.references = references; next.conflictVersionId = null; next.observation = null })
  }
  async pump(): Promise<void> {
    if (this.closed || this.pumping) return
    this.pumping = true
    try { await this.exclusive(async () => {
      const rows = this.store.bindings.filter(row => row.state === 'active' || row.state === 'pending')
      const picked = Array.from({ length: Math.min(2, rows.length) }, (_, i) => rows[(this.offset + i) % rows.length])
      this.offset = rows.length ? (this.offset + picked.length) % rows.length : 0
      for (const row of picked) {
        try {
          if (row.pending) { if (row.pending.state === 'queued') await this.dispatch(row.bindingId); continue }
          const key = outputHash(JSON.stringify([row.pin, row.expected]))
          if (this.now() - (this.checked.get(key) ?? 0) >= 30_000) {
            const current = await this.authorized({ pin: row.pin, query: queryOf(row), expected: row.expected })
            this.update(row.bindingId, next => { next.inputOutdated = current.inputOutdated })
          }
          if (cruxWorkProjectIdentity(row.projectRoot) !== row.projectIdentity) throw new TaskOutputError('OUTPUT_CONTEXT_CHANGED', '原物理工作副本已被替换，未读取同名目录的新文件')
          let stamp: string | undefined
          try { stamp = outputFileStamp(row.projectRoot, `.trellis/tasks/${row.taskDir}/${row.file}`) }
          catch { this.fileStamps.delete(row.bindingId) }
          if (stamp && this.fileStamps.get(row.bindingId) === stamp && row.observation === null) continue
          const record = privateOutputRecord(this.options.userData, row.pin, row.expected, row.taskCreatedAt)
          this.registered(row, record)
          let local: ReturnType<typeof readOutputFile>
          try {
            local = readOutputFile(record.projectRoot, `${record.relativeDir}/${row.file}`)
            if (!local.text.trim()) throw new TaskOutputError('OUTPUT_EMPTY', '文件正文为空，未上传；请完成保存后恢复同步')
          } catch (error) {
            if (!(error instanceof TaskOutputError) || !['OUTPUT_PATH_CHANGED', 'OUTPUT_UNSTABLE', 'OUTPUT_EMPTY'].includes(error.code)) throw error
            const marker = `waiting:${error.code}`
            if (row.observation?.digest !== marker) { this.update(row.bindingId, next => { next.observation = { digest: marker, at: this.now(), mtime: 0 }; next.error = '等待文件稳定保存，尚未上传本次改动' }); continue }
            if (this.now() - row.observation.at < OUTPUT_STABLE_MS) continue
            throw error
          }
          if (local.digest === row.lastConfirmed?.digest && row.lastConfirmed.draftRevision === row.baselineDraftRevision) {
            if (stamp) this.fileStamps.set(row.bindingId, stamp)
            if (row.observation) this.update(row.bindingId, next => { next.observation = null; next.error = null })
            continue
          }
          if (!row.observation || row.observation.digest !== local.digest || row.observation.mtime !== local.mtime) { this.update(row.bindingId, next => { next.observation = { digest: local.digest, mtime: local.mtime, at: this.now() }; next.error = null }); continue }
          if (this.now() - row.observation.at < OUTPUT_STABLE_MS || this.now() - local.mtime < OUTPUT_STABLE_MS) continue
          await this.prepareCommand(row.bindingId, local.text); await this.dispatch(row.bindingId)
        } catch (error) { this.update(row.bindingId, next => { next.state = 'paused'; next.error = error instanceof Error ? error.message : '产物同步暂停，原文件与命令已保留' }) }
      }
    }) } finally { this.pumping = false }
  }
}
