import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { dingExecutionSchema, dingInboxSchema, type DingAssistant, type DingInbox } from '../../../../shared/dingtalk-integration'
import type { IntegrationWorkPort } from '../work-ports'
import { IntegrationError } from '../types'
import { dingMessageSchema, digest, type StoredInbox, type DingMessage } from './repository'
import { createDingTalkTasks } from './tasks'
import { DingTalkRemoteError, type DingTalkRest } from './rest'
import type { DingTalkPorts } from './ports'

type Command = { kind: 'create'; text: string; run: boolean } | { kind: 'query' | 'cancel' | 'execution'; receipt: string } | { kind: 'update'; receipt: string; priority: 'P0' | 'P1' | 'P2' | 'P3'; title: string }
function command(text: string): Command {
  const value = text.trim()
  const ref = /^\/(task query|agent query|agent cancel) ([0-9a-f-]{36})$/i.exec(value)
  if (ref) return { kind: ref[1]?.toLowerCase() === 'task query' ? 'query' : ref[1]?.toLowerCase() === 'agent query' ? 'execution' : 'cancel', receipt: z.string().uuid().parse(ref[2]) }
  const update = /^\/task update ([0-9a-f-]{36}) (P[0-3]) ([\s\S]{1,500})$/.exec(value)
  if (update) return { kind: 'update', receipt: z.string().uuid().parse(update[1]), priority: update[2] as 'P0' | 'P1' | 'P2' | 'P3', title: update[3]!.trim() }
  const run = value.startsWith('/agent run '), create = value.startsWith('/task create ')
  if (value.startsWith('/') && !run && !create) throw new IntegrationError('支持 /task create 内容、/task query 回执ID、/task update 回执ID P2 标题、/agent run 内容、/agent query 或 /agent cancel 回执ID', 'invalid')
  const body = value.slice(run ? 11 : create ? 13 : 0).trim()
  if (!body) throw new IntegrationError('任务内容为空', 'invalid')
  return { kind: 'create', text: body, run }
}
export function allowed(assistant: DingAssistant, message: DingMessage): boolean {
  return assistant.policy.allowedSenders.includes(message.senderStaffId) && (message.conversationType === '1' ? assistant.policy.allowDirect : assistant.policy.allowedGroups.includes(message.conversationId))
}
export function createDingTalkInbox(ports: DingTalkPorts, remote: DingTalkRest) {
  const repository = ports.repository, tasks = createDingTalkTasks(ports.workspace.assertWorkspace.bind(ports.workspace))
  const active = new Map<string, Promise<unknown>>()
  let closed = false
  function row(id: string): StoredInbox {
    const result = repository.read().inbox.find(item => item.id === id)
    if (!result) throw new IntegrationError('钉钉消息回执不存在', 'conflict')
    return result
  }
  function publish(id: string, patch: Partial<DingInbox>): StoredInbox {
    const result = repository.change(state => { const found = state.inbox.find(item => item.id === id); if (!found) throw new IntegrationError('原消息回执不存在', 'conflict'); Object.assign(found, patch); return found })
    ports.changed?.(); return result
  }
  function assertAdmission(item: StoredInbox): DingAssistant {
    if (closed) throw new IntegrationError('钉钉接收器已停止新任务接入', 'denied')
    ports.workspace.assertWorkspace(item.workspace)
    const state = repository.read(), assistant = state.assistants.find(entry => entry.id === item.assistantId), app = state.apps.find(entry => entry.id === item.appId)
    if (!assistant?.enabled || assistant.revision !== item.assistantRevision || assistant.appRevision !== item.appRevision || app?.revision !== item.appRevision || app.state !== 'credentials-verified' || !allowed(assistant, item.message)) throw new IntegrationError('原助手配置、应用或权限已变更，停止新动作', 'denied')
    return assistant
  }
  function receive(appId: string, appRevision: number, raw: unknown): boolean {
    if (closed) return false
    const frame = z.object({ data: z.string().max(128 * 1024) }).parse(raw)
    const message = dingMessageSchema.parse(JSON.parse(frame.data))
    const state = repository.read(), app = state.apps.find(item => item.id === appId && item.revision === appRevision && item.state === 'credentials-verified')
    if (!app || message.chatbotCorpId !== app.corpId || message.senderCorpId !== app.corpId || message.robotCode !== app.robotCode) return false
    // The message identity is case-sensitive. Frame delivery IDs and session
    // webhooks may change on redelivery and are deliberately not the dedup key.
    const contentDigest = digest({ id: message.msgId, appId, corpId: message.chatbotCorpId, sender: message.senderStaffId, group: message.conversationId, kind: message.conversationType, text: message.text.content, createAt: message.createAt })
    const prior = state.inbox.find(item => item.appId === appId && item.originalMessageId === message.msgId)
    if (prior) { if (prior.digest !== contentDigest) throw new IntegrationError('同一原消息 ID 的内容冲突，已阻止重复接入', 'conflict'); return true }
    const candidates = state.assistants.filter(item => item.appId === appId && item.appRevision === appRevision && item.enabled)
    const accepted = candidates.filter(item => allowed(item, message))
    const assistant = accepted.length === 1 ? accepted[0] : candidates[0]
    if (!assistant) return false
    ports.workspace.assertWorkspace(assistant.workspace)
    const admitted = accepted.length === 1
    repository.change(next => {
      if (next.inbox.length >= 10000) throw new IntegrationError('消息去重账本已满，停止 ACK；请处理容量，不能清空后重复执行', 'io')
      const currentApp = next.apps.find(item => item.id === appId && item.revision === appRevision)
      if (!currentApp) throw new IntegrationError('原应用已变更', 'conflict')
      currentApp.observedCorpId = message.chatbotCorpId
      next.inbox.push({ id: randomUUID(), assistantId: assistant.id, assistantRevision: assistant.revision, appId, appRevision,
        originalMessageId: message.msgId, senderStaffId: message.senderStaffId, conversationId: message.conversationId, receivedAt: Date.now(),
        state: admitted ? 'received' : 'denied', taskRef: null, taskDir: null, execution: null, commandId: randomUUID(),
        taskOperationId: null, message, digest: contentDigest, deadline: Date.now() + assistant.policy.maxTurnMinutes * 60000,
        workspace: assistant.workspace, policy: assistant.policy, reply: assistant.policy.replyEnabled && admitted ? 'pending' : 'disabled',
        detail: admitted ? '原消息已持久化，等待本机处理' : accepted.length > 1 ? '多个助手权限范围重叠，已拒绝执行' : '发送者或会话未在助手允许范围内' })
      const current = next.assistants.find(item => item.id === assistant.id); if (current) current.lastMessageAt = Date.now()
    })
    ports.changed?.(); return true
  }
  async function execute(id: string): Promise<DingInbox> {
    const item = row(id)
    assertAdmission(item)
    if (!item.taskDir || !item.taskRef || !['task-created', 'pending'].includes(item.state)) throw new IntegrationError('仅已创建且等待执行的任务可以接入 Agent', 'conflict')
    if (item.execution) throw new IntegrationError('原执行命令已有回执，请查询原命令；不能重新发送', 'conflict')
    if (item.policy.execution === 'tasks-only') return dingInboxSchema.strip().parse(publish(id, { state: 'pending', detail: '此助手仅创建任务，未授权 Agent 执行' }))
    if (Date.now() >= item.deadline) return dingInboxSchema.strip().parse(publish(id, { state: 'denied', detail: '原消息执行期限已过，需要本机重新审阅' }))
    if (!ports.execution) return dingInboxSchema.strip().parse(publish(id, { state: 'pending', detail: '原生执行端口尚未接线，任务已保留等待本机处理' }))
    tasks.read(item.workspace, item.taskRef)
    // Persist the effect intent before native admission. An acknowledgement loss
    // is queried under this command UUID; it is never a new session/prompt.
    publish(id, { state: 'pending', execution: { commandId: item.commandId, state: 'unknown', sessionId: null, turnId: null, connectionGeneration: null, detail: '原生接入结果等待确认' } })
    try {
      assertAdmission(item)
      const result = dingExecutionSchema.parse(await ports.execution.admit({ commandId: item.commandId, workspace: item.workspace, runtimeId: item.policy.runtimeId, profileId: item.policy.profileId, taskDir: item.taskDir, text: command(item.message.text.content).kind === 'create' ? (command(item.message.text.content) as { text: string }).text : item.message.text.content, deadline: item.deadline, permissionPolicy: 'original-native-approvals', source: { provider: 'dingtalk', messageId: item.originalMessageId, senderStaffId: item.senderStaffId } }))
      if (result.commandId !== item.commandId) throw new IntegrationError('原生执行回执命令身份不匹配', 'uncertain')
      return dingInboxSchema.strip().parse(publish(id, { execution: result, state: result.state === 'denied' ? 'denied' : result.state === 'unknown' ? 'unknown' : result.state === 'pending' ? 'pending' : 'completed', detail: result.detail }))
    } catch { return dingInboxSchema.strip().parse(publish(id, { state: 'unknown', detail: '原生接入响应未确认，请查询原命令；没有自动重试' })) }
  }
  async function observeExecution(id: string, cancel: boolean): Promise<DingInbox> {
    const item = row(id)
    if (!item.execution || !ports.execution) throw new IntegrationError('没有可查询的原生执行回执', 'conflict')
    if (cancel) publish(id, { execution: { ...item.execution, detail: '原取消命令意图已持久化，等待原生确认' } })
    const result = dingExecutionSchema.parse(await (cancel ? ports.execution.cancel({ commandId: item.commandId, workspace: item.workspace, sessionId: item.execution.sessionId, turnId: item.execution.turnId, connectionGeneration: item.execution.connectionGeneration }) : ports.execution.query({ commandId: item.commandId, workspace: item.workspace, sessionId: item.execution.sessionId, turnId: item.execution.turnId, connectionGeneration: item.execution.connectionGeneration, deadline: item.deadline })))
    if (result.commandId !== item.commandId) throw new IntegrationError('执行查询返回了不同命令', 'conflict')
    return dingInboxSchema.strip().parse(publish(id, { execution: result, detail: result.detail }))
  }
  async function reply(id: string): Promise<void> {
    const item = row(id)
    if (item.reply !== 'pending') return
    const app = repository.read().apps.find(entry => entry.id === item.appId && entry.revision === item.appRevision && entry.state === 'credentials-verified')
    if (!app || !item.message.sessionWebhook || !item.message.sessionWebhookExpiredTime || item.message.sessionWebhookExpiredTime <= Date.now()) { publish(id, { reply: 'failed' }); return }
    assertAdmission(item)
    publish(id, { reply: 'dispatching' })
    try { await remote.reply(app, item.message.sessionWebhook, `${item.detail}\n回执 ID：${id}${item.taskRef ? `\n任务：${item.taskRef}` : ''}`); publish(id, { reply: 'delivered' }) }
    catch (error) { publish(id, { reply: error instanceof DingTalkRemoteError && error.definite ? 'failed' : 'unknown' }) }
  }
  async function process(id: string): Promise<void> {
    const item = row(id)
    if (item.state !== 'received') return
    let cmd: Command
    try { assertAdmission(item); cmd = command(item.message.text.content) } catch (error) { publish(id, { state: 'denied', detail: error instanceof IntegrationError ? error.message.slice(0, 400) : '消息命令无效' }); await reply(id); return }
    if (Date.now() >= item.deadline) { publish(id, { state: 'denied', detail: '消息处理期限已过，请在本机审阅' }); return }
    publish(id, { state: 'processing', detail: '动作意图已持久化' })
    try {
      if (cmd.kind === 'create') {
        const task = await tasks.create(item.workspace, item.appId, item.message, cmd.text)
        repository.change(state => { const target = state.inbox.find(entry => entry.id === id)!; target.taskRef = task.taskRef; target.taskDir = task.taskDir; target.taskOperationId = task.operationId; target.state = 'task-created'; target.detail = `任务已创建：${task.title}`.slice(0, 400) })
        if (cmd.run && item.policy.execution === 'native-approvals') await execute(id)
        else publish(id, { state: 'pending', detail: cmd.run ? item.policy.execution === 'tasks-only' ? '已创建任务；此助手未授权 Agent 执行' : '已创建任务；等待本机明确接入 Agent' : `任务已创建：${task.title}`.slice(0, 400) })
      } else {
        const target = row(cmd.receipt)
        if (target.assistantId !== item.assistantId || target.senderStaffId !== item.senderStaffId || target.conversationId !== item.conversationId || !target.taskRef) throw new IntegrationError('目标回执不属于当前发送者、助手和会话', 'denied')
        if (cmd.kind === 'execution' || cmd.kind === 'cancel') {
          const observed = await observeExecution(target.id, cmd.kind === 'cancel'); publish(id, { state: 'completed', detail: observed.execution?.detail ?? '没有已确认执行' })
        } else {
          const task = tasks.read(item.workspace, target.taskRef)
          if (cmd.kind === 'update') {
            if (!item.policy.allowTaskUpdates) throw new IntegrationError('助手未授权任务更新', 'denied')
            assertAdmission(item); tasks.update(item.workspace, target.taskRef, task.revision, cmd.title, cmd.priority)
            publish(id, { state: 'completed', taskRef: task.taskRef, taskDir: task.taskDir, detail: '任务标题和优先级已更新；工作流状态由本机工作流管理' })
          } else publish(id, { state: 'completed', taskRef: task.taskRef, taskDir: task.taskDir, detail: `${task.title}\n优先级：${task.priority}；本机状态：${task.status}${task.archived ? '（已归档）' : ''}`.slice(0, 400) })
        }
      }
    } catch (error) { publish(id, { state: error instanceof IntegrationError && ['invalid', 'denied'].includes(error.kind) ? 'denied' : 'unknown', detail: error instanceof IntegrationError ? error.message.slice(0, 400) : '动作结果未确认，请在本机核实原回执；未自动重试' }) }
    await reply(id)
  }
  function tick(): void {
    if (closed) return
    for (const item of repository.read().inbox) {
      if (active.size >= 2) break
      if (item.state !== 'received' || active.has(item.id)) continue
      const work = process(item.id).catch(() => { /* Durable processing intent remains visible for reconciliation. */ }).finally(() => active.delete(item.id))
      active.set(item.id, work)
    }
    // Reattach observations/deadlines to original commands after daemon restart;
    // this is query-only and cannot create another native session or prompt.
    for (const item of repository.read().inbox) {
      if (active.size >= 2) break
      if (!item.execution || !['unknown', 'admitted', 'pending'].includes(item.execution.state) || active.has(item.id)) continue
      const work = observeExecution(item.id, false).catch(() => {}).finally(() => active.delete(item.id))
      active.set(item.id, work)
    }
  }
  const work: IntegrationWorkPort = {
    supports: kind => kind === 'assistant',
    async dispatch({ job, workspace, signal }) {
      if (job.input.kind !== 'assistant') throw new IntegrationError('钉钉作业类型不支持', 'invalid')
      const item = row(job.input.inboxReceiptId)
      if (workspace.grantId !== item.workspace.grantId || workspace.revision !== item.workspace.revision || job.input.assistantId !== item.assistantId || job.input.assistantRevision !== item.assistantRevision || job.source.connectionId !== item.appId || job.source.connectionRevision !== item.appRevision) throw new IntegrationError('钉钉作业所有者不匹配', 'denied')
      if (signal.aborted) return { state: 'cancelled', evidenceRef: item.id, cursor: null, counts: { processed: 0, failed: 0, total: 1 } }
      if (item.state === 'received') await process(item.id)
      const latest = row(item.id)
      return { state: latest.state === 'unknown' || latest.state === 'processing' ? 'unknown' : latest.state === 'received' || latest.state === 'pending' ? 'paused' : latest.state === 'denied' || latest.state === 'failed' ? 'partially-failed' : 'completed', evidenceRef: latest.id, cursor: null, counts: { processed: 1, failed: latest.state === 'denied' || latest.state === 'failed' ? 1 : 0, total: 1 } }
    },
    async reconcile({ job, workspace }) {
      if (job.input.kind !== 'assistant') return { resolved: false, evidenceRef: null }
      const item = row(job.input.inboxReceiptId)
      if (workspace.workspaceId !== item.workspace.workspaceId || workspace.root !== item.workspace.root) throw new IntegrationError('作业工作区不匹配', 'denied')
      if (item.execution) await observeExecution(item.id, false)
      const latest = row(item.id)
      return { resolved: !['received', 'processing', 'unknown'].includes(latest.state) && latest.execution?.state !== 'unknown', evidenceRef: latest.id }
    }
  }
  return { receive, execute, observeExecution, row, tick, work, hasActiveWork: () => active.size > 0,
    recover() { repository.change(state => { for (const item of state.inbox) { if (item.state === 'processing') { item.state = 'unknown'; item.detail = '上次动作已派发但结果未确认；未自动重放' }; if (item.reply === 'dispatching') item.reply = 'unknown' }; for (const delivery of state.deliveries) if (delivery.state === 'dispatching' || delivery.state === 'prepared') { delivery.state = 'unknown'; delivery.detail = '上次发送结果未确认；禁止盲目重发' } }) },
    closeAdmission() { closed = true },
    async close() { closed = true; await Promise.allSettled([...active.values()]) }
  }
}
