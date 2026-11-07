import { createHash } from 'node:crypto'
import { dialog, type BrowserWindow } from 'electron'
import type { CruxDevelopmentRef, CruxWorkLocal, CruxWorkQuery } from '../../shared/crux-work'
import type { TaskProgressPin } from '../../shared/crux-task-progress-native'
import { taskOutputReadInputSchema, taskOutputPreviewInputSchema, taskOutputConfirmInputSchema, taskOutputCompareInputSchema, taskOutputRecoverInputSchema,
  taskOutputStatusSchema, taskOutputPreviewSchema, taskOutputComparisonSchema,
  type TaskOutputNativeInput, type TaskOutputPreview, type TaskOutputReply } from '../../shared/crux-task-outputs'
import { handle } from './registry'

type ResolvedContext = { local: CruxWorkLocal; ownerId: string; spaceId: string; authority?: string; selectionGeneration?: number }
export interface TaskOutputsIpcDependencies {
  getMain(): BrowserWindow | null
  channels: Record<'read' | 'preview' | 'confirm' | 'compare' | 'recover', string>
  resolveContext(query: CruxWorkQuery, expected: CruxDevelopmentRef): Promise<ResolvedContext>
  captureOriginalPin(query: CruxWorkQuery): Promise<{ pin: TaskProgressPin; assertCurrent(): Promise<void> }>
  call<T>(input: TaskOutputNativeInput): Promise<TaskOutputReply<T>>
  confirmNative?(preview: { title: string; detail: string }, window: BrowserWindow): Promise<boolean>
}

/** Channels, original-source capture and daemon transport are supplied by the existing native composition. */
export function registerCruxTaskOutputsIpc(deps: TaskOutputsIpcDependencies): void {
  const schemas = { read: taskOutputReadInputSchema, preview: taskOutputPreviewInputSchema, confirm: taskOutputConfirmInputSchema, compare: taskOutputCompareInputSchema, recover: taskOutputRecoverInputSchema }
  const previews = new Map<string, { value: TaskOutputPreview; key: string }>()
  const documents = new WeakMap<Electron.WebContents, { generation: number }>()
  for (const operation of ['read', 'preview', 'confirm', 'compare', 'recover'] as const) handle(deps.channels[operation], async (event, raw: unknown) => {
    let admitted = false
    try {
      const window = deps.getMain(), frame = event.senderFrame
      if (!window || window.isDestroyed() || window.webContents !== event.sender || frame !== event.sender.mainFrame) throw new Error('产物纳管只能从当前真正主窗口的主界面操作')
      let document = documents.get(event.sender)
      if (!document) {
        document = { generation: 0 }; documents.set(event.sender, document)
        const owner = document
        event.sender.on('did-start-navigation', (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) { owner.generation++; previews.clear() } })
        event.sender.once('destroyed', () => { owner.generation++; previews.clear() })
      }
      const generation = document.generation
      const ownsWindow = (): boolean => !window.isDestroyed() && !event.sender.isDestroyed() && deps.getMain() === window && window.webContents === event.sender && event.sender.mainFrame === frame && document.generation === generation
      const input = schemas[operation].parse(raw), initial = await deps.resolveContext(input.query, input.expected)
      const captured = await deps.captureOriginalPin(input.query), pin = captured.pin
      if (!initial.local.development || initial.ownerId !== pin.ownerId || initial.spaceId !== pin.spaceId || initial.local.development.contextId !== input.expected.contextId || initial.local.development.generation !== input.expected.generation) throw new Error('原任务上下文与产物身份不一致')
      const identity = (value: ResolvedContext): string => JSON.stringify([value.ownerId, value.spaceId, value.authority, value.selectionGeneration, value.local.projectRoot, value.local.taskId, value.local.development, event.sender.id, generation])
      const signature = identity(initial), interactionKey = createHash('sha256').update(signature).digest('hex')
      const current = async (): Promise<void> => { await captured.assertCurrent(); if (!ownsWindow() || identity(await deps.resolveContext(input.query, input.expected)) !== signature || !ownsWindow()) throw new Error('原产物操作来源或主窗口已变化，请重新预览；返回原空间不会恢复旧操作权') }
      await current()
      if (operation === 'confirm' && 'previewId' in input && input.previewId) {
        const held = previews.get(input.previewId)
        if (!held || held.key !== interactionKey || held.value.expiresAt < Date.now()) throw new Error('原产物预览已失效，请重新预览')
        const preview = held.value
        const accepted = await (deps.confirmNative ?? (async (value, ownerWindow) => (await dialog.showMessageBox(ownerWindow, { type: 'question', title: value.title, message: '纳管此文件并将后续稳定保存同步为团队草稿？', detail: value.detail, buttons: ['取消', '确认纳管'], defaultId: 0, cancelId: 0, noLink: true })).response === 1))({ title: '确认本机产物回传', detail: [
          `任务：${preview.taskId} / ${preview.spaceId}`, `目录：${preview.projectRoot} / ${preview.taskDir}`, `文件：${preview.selection.file}`, `团队文档：${preview.title}（${preview.documentId ?? '首次创建'}）`,
          `审批人：${preview.approverIds.join('、')}`, `完整正文：${preview.byteLength} 字节；SHA-256 ${preview.digest}`, ...(preview.workingPrd ? ['PRD 是修改后的工作草稿；已要求比较原团队稿或完整冻结输入，不代表产品批准。'] : []), '仅回传共享草稿；审批、采纳和任务交接仍需明确操作。GUI 切换后仍按此原任务同步。'
        ].join('\n') }, window)
        await current()
        if (!accepted) return { ok: false, code: 'OUTPUT_CANCELLED', error: '已取消纳管，未上传正文' }
      }
      if (operation === 'recover' && 'action' in input && input.action === 'resume') {
        const accepted = await (deps.confirmNative ?? (async (value, ownerWindow) => (await dialog.showMessageBox(ownerWindow, { type: 'question', title: value.title, message: value.detail, buttons: ['取消', '恢复同步'], defaultId: 0, cancelId: 0, noLink: true })).response === 1))({ title: '恢复受管文件同步', detail: '将按原任务、原团队文档继续发送后续本机保存。冲突恢复只允许使用刚刚比较的团队修订和本机正文。' }, window)
        await current(); if (!accepted) return { ok: false, code: 'OUTPUT_CANCELLED', error: '已取消恢复同步' }
      }
      const request = { ...input, pin, interactionKey, operation: `outputs.${operation}` } as TaskOutputNativeInput
      admitted = operation === 'confirm' || operation === 'recover'
      const reply = await deps.call<unknown>(request)
      await current()
      const result = reply.ok ? { ok: true as const, value: (operation === 'preview' ? taskOutputPreviewSchema : operation === 'compare' ? taskOutputComparisonSchema : taskOutputStatusSchema).parse(reply.value) } : reply
      if (operation === 'preview' && result.ok) {
        const value = result.value as TaskOutputPreview
        if (previews.size >= 8) previews.delete(previews.keys().next().value ?? '')
        previews.set(value.previewId, { value, key: interactionKey })
      }
      if (operation === 'confirm' && 'previewId' in input && input.previewId && result.ok) previews.delete(input.previewId)
      return result
    } catch (error) { return { ok: false, code: 'OUTPUT_ADMISSION_FAILED', error: error instanceof Error ? error.message : '产物操作无法核对，原文件与命令已保留', ...(admitted ? { outcomeUnknown: true } : {}) } }
  })
}
