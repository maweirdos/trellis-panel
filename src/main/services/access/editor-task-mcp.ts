import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { JSONRPCNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { withDesktopTeamService } from '../team-desktop'
import { teamTaskProgressStateSchema } from '../../../shared/team-task-progress'
import { cruxTransitionTaskInputSchema } from '../../../shared/crux-schema'
import { teamExecutionWorkflowRefSchema, teamExecutionExecutorSchema, teamExecutionSourceRefSchema, teamExecutionNativeStateSchema, teamExecutionFinalizationSchema } from '../../../shared/team-task-execution'
import { executionInputCommandSchema, executionInputSelectionIdSchema } from '../../../shared/team-execution-input'
import { executionArtifactKindSchema, executionCodeSourceSchema, executionSourceObservationSchema, executionOutputRefSchema } from '../../../shared/team-execution-artifacts'
import type { TeamTaskRef } from '../../../shared/team-task-execution'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_SESSIONS = 16
const MAX_TASKS = 200
const MAX_TEXT_BYTES = 1024 * 1024
const taskInput = z.object({ taskId: z.string().min(1).max(200), spaceId: z.string().min(1).max(200), taskCreatedAt: z.string().min(1).max(100) }).strict()
const taskIdInput = z.object({ taskId: z.string().min(1).max(200) }).strict()
const workflowRef = teamExecutionWorkflowRefSchema
const executorRef = teamExecutionExecutorSchema
const outputScope = taskInput.extend({ executionId: z.string().uuid(), generation: z.number().int().positive().safe(), nodeId: z.string().min(1).max(200), attempt: z.number().int().positive().safe(), commandId: z.string().uuid().optional() }).strict()
const reportInput = outputScope.extend({ seq: z.number().int().positive().safe(), state: teamTaskProgressStateSchema, step: z.string().trim().max(500).nullable(), blockingReason: z.string().trim().max(500).nullable(), nativeState: teamExecutionNativeStateSchema }).strict()
const releaseInput = taskInput.extend({ executionId: z.string().uuid(), generation: z.number().int().positive().safe(), nativeState: teamExecutionNativeStateSchema }).strict()
const claimInput = taskInput.extend({ workflow: workflowRef, executor: executorRef, nodeId: z.string().min(1).max(200), attempt: z.number().int().positive().safe().default(1), predecessorExecutionId: z.string().uuid().nullable().default(null), source: teamExecutionSourceRefSchema.nullable().default(null) }).strict()
const captureInput = taskInput.extend({ executionId: z.string().uuid(), generation: z.number().int().positive().safe(), commandId: z.string().uuid(), roles: executionInputCommandSchema.shape.roles, selections: executionInputCommandSchema.shape.selections }).strict()
const readInput = taskInput
const historyInput = taskInput.extend({ executionId: z.string().uuid() }).strict()
const artifactInput = outputScope.extend({ outputId: z.string().min(1).max(200), artifactId: z.string().uuid(), artifactKind: executionArtifactKindSchema, title: z.string().trim().min(1).max(300), text: z.string().max(MAX_TEXT_BYTES), previousVersionId: z.string().uuid().nullable().default(null), disposition: z.enum(['draft', 'confirmed']).default('confirmed') }).strict()
const sealInput = outputScope.extend({ previousVersionId: z.string().uuid().nullable().default(null), previousDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null), entries: z.array(z.union([z.object({ outputId: z.string().min(1).max(200), ref: executionOutputRefSchema }).strict(), z.object({ outputId: z.string().min(1).max(200), artifactId: z.string().uuid(), versionId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()])).min(1).max(16) }).strict()
const checkpointInput = outputScope.extend({ manifestVersionId: z.string().uuid(), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), remainingWork: z.string().max(8192), source: executionCodeSourceSchema, observation: executionSourceObservationSchema.nullable().default(null) }).strict()
const completeInput = taskInput.extend({ executionId: z.string().uuid(), generation: z.number().int().positive().safe(), commandId: z.string().uuid(), finalization: teamExecutionFinalizationSchema }).strict()
const transitionInput = taskInput.extend({ commandId: z.string().uuid(), executionId: z.string().uuid().nullable(), generation: z.number().int().nonnegative().safe(), expectedRevision: z.number().int().nonnegative().safe(), transition: cruxTransitionTaskInputSchema }).strict()

type EditorBinding = {
  connectionId: string
  origin: string
  pairingId: string
  deviceId: string
  ownerId: string
  projectId: string
  instanceId: string
  epoch: string
  authorizationRevision: number
}
type EditorSession = { binding: EditorBinding; abort: AbortController }

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function taskRef(binding: EditorBinding, input: z.infer<typeof taskInput>): TeamTaskRef {
  return { instanceId: binding.instanceId, projectId: binding.projectId, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt }
}
function result(value: unknown): { content: [{ type: 'text'; text: string }]; structuredContent: Record<string, unknown>; isError: false } {
  const safe = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value }
  return { content: [{ type: 'text', text: JSON.stringify(safe) }], structuredContent: safe, isError: false }
}
function failure(error: unknown): { content: [{ type: 'text'; text: string }]; structuredContent: Record<string, unknown>; isError: true } {
  const message = error instanceof Error ? error.message : '编辑器任务工具未完成，请检查原任务回执与当前权限'
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], structuredContent: { ok: false, error: message }, isError: true }
}

export class EditorTaskMcpBridge {
  private readonly sessions = new Map<string, EditorSession>()
  private withService: typeof withDesktopTeamService = withDesktopTeamService

  configure(withService: typeof withDesktopTeamService): void { this.withService = withService }

  async handle(request: IncomingMessage, response: ServerResponse, sessionKey: string): Promise<void> {
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.origin !== undefined) { this.reply(response, 403); request.resume(); return }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); request.resume(); return }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' || request.headers['content-encoding']) { this.reply(response, 415); request.resume(); return }
    let body: unknown
    try { body = await this.readBody(request) } catch { this.reply(response, 413); return }
    const parsed = JSONRPCNotificationSchema.safeParse(body)
    if (parsed.success && parsed.data.method === 'notifications/initialized') { /* The SDK handles the notification below. */ }
    let server: McpServer | undefined
    let transport: StreamableHTTPServerTransport | undefined
    try {
      server = this.server(sessionKey)
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      await transport.handleRequest(request, response, body)
    } catch {
      if (!response.headersSent && !response.destroyed) this.reply(response, 400)
    } finally {
      await server?.close().catch(() => {})
      await transport?.close().catch(() => {})
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.abort.abort()
    this.sessions.clear()
  }

  private server(sessionKey: string): McpServer {
    const server = new McpServer({ name: 'trellis-editor-tasks', version: '1.0.0' }, { maxToolInputElements: 128 })
    const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    server.registerTool('team_tasks_list', { description: '列出当前账号和设备可见的团队任务。返回的是当前团队服务快照，不代表已领取或拥有写入权。', inputSchema: z.object({ includeClosed: z.boolean().optional().default(false) }).strict(), annotations: readOnly }, async input => this.call(sessionKey, async binding => this.withService(async service => {
      const snapshot = await service.cruxSnapshot(binding.connectionId, { expectedInstanceId: binding.instanceId })
      this.assertSnapshot(binding, snapshot)
      const items = snapshot.snapshot.tasks.filter(task => input.includeClosed || !['done', 'cancelled'].includes(snapshot.snapshot.taskStatuses.find(status => status.id === task.statusId)?.category ?? ''))
        .slice(0, MAX_TASKS).map(task => ({ id: task.id, spaceId: task.spaceId, createdAt: task.createdAt, title: task.title, statusId: task.statusId, priority: task.priority, assigneeIds: task.assigneeIds, handlerId: task.workflow?.handlerId ?? task.assigneeIds[0] ?? null, workflowStage: task.workflow?.stage ?? null, executor: task.executor ?? null }))
      return { binding: this.publicBinding(binding), tasks: items, truncated: snapshot.snapshot.tasks.length > items.length }
    })))
    server.registerTool('team_task_context', { description: '读取一个团队任务的固定开发上下文，包括 T03 输入绑定、代码资源和可读产物索引。读取不会领取任务。', inputSchema: taskIdInput, annotations: readOnly }, async input => this.call(sessionKey, async binding => this.withService(async service => {
      const context = await service.taskDevelopmentContext(binding.connectionId, input.taskId, binding.instanceId)
      this.assertSnapshot(binding, context.snapshot)
      return { binding: this.publicBinding(binding), context }
    })))
    server.registerTool('team_task_execution_read', { description: '读取一个任务当前的执行代次和写入者。', inputSchema: readInput, annotations: readOnly }, async input => this.call(sessionKey, async binding => this.withService(async service => {
      const task = taskRef(binding, input)
      const view = await service.executionRead({ connectionId: binding.connectionId, task })
      if (view.task.projectId !== binding.projectId || view.epoch !== binding.epoch) throw new Error('执行视图已切换到另一服务世代')
      return { binding: this.publicBinding(binding), view }
    })))
    server.registerTool('team_task_execution_history', { description: '读取当前团队服务保存的指定执行历史和回执。', inputSchema: historyInput, annotations: readOnly }, async input => this.call(sessionKey, async binding => this.withService(async service => ({ binding: this.publicBinding(binding), history: await service.executionHistory({ connectionId: binding.connectionId, task: taskRef(binding, input), executionId: input.executionId }) }))))
    server.registerTool('team_task_execution_input', { description: '读取原 execution 已捕获的固定输入 digest、规则与资料 refs；传 selectionId 读取同一输入的固定资源正文。不会领取、捕获输入或授权本机目录。', inputSchema: historyInput.extend({ selectionId: executionInputSelectionIdSchema.optional() }).strict(), annotations: readOnly }, async input => this.call(sessionKey, async binding => this.withService(async service => ({ binding: this.publicBinding(binding), input: await service.executionInputRead({ connectionId: binding.connectionId, task: taskRef(binding, input), executionId: input.executionId, selectionId: input.selectionId }) }))))
    server.registerTool('team_task_claim', { description: '以 editor-owned 身份领取一个当前固定任务节点。服务端执行账号、设备、代次和竞争领取校验；重复 commandId 可安全重试。', inputSchema: claimInput, annotations: mutation }, async input => this.call(sessionKey, async binding => this.withService(async service => {
      const task = taskRef(binding, input)
      const context = await service.taskDevelopmentContext(binding.connectionId, input.taskId, binding.instanceId)
      this.assertSnapshot(binding, context.snapshot)
      if (!context.inputs.current || context.inputs.admission.status !== 'ready') throw new Error('任务固定输入尚未就绪，不能领取')
      const currentInput = context.inputs.current
      const view = await service.executionRead({ connectionId: binding.connectionId, task })
      const makeCommand = (expectedGeneration: number) => ({
        contractVersion: 2 as const, commandId: randomUUID(), task, expectedEpoch: binding.epoch, expectedActorId: binding.ownerId, expectedDeviceId: binding.deviceId,
        expectedGeneration, expectedExecutionId: null, kind: 'claim' as const, ownership: 'editor-owned' as const, workflow: input.workflow, executor: input.executor,
        inputBundle: { bundleId: currentInput.bundleId, revision: currentInput.revision, digest: currentInput.digest }, predecessorExecutionId: input.predecessorExecutionId, source: input.source, nodeId: input.nodeId, attempt: input.attempt
      })
      let command = makeCommand(view.generation)
      let reply
      const candidates = [view.generation, Math.max(0, view.generation - 1), view.generation + 1]
      let lastError: unknown
      for (const generation of candidates) {
        command = makeCommand(generation)
        try { reply = await service.executionCommand({ connectionId: binding.connectionId, task, command }); lastError = undefined; break }
        catch (error) {
          lastError = error
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
          if (code !== 'EXECUTION_GENERATION_CONFLICT') throw error
          const fresh = await service.executionRead({ connectionId: binding.connectionId, task })
          if (fresh.active || fresh.epoch !== binding.epoch) throw error
        }
      }
      if (lastError || !reply) throw lastError ?? new Error('任务领取没有返回团队服务回执')
      return { binding: this.publicBinding(binding), reply }
    })))
    server.registerTool('team_task_capture_input', { description: '领取后固定原执行的已采用工作流、Agent 摘要和输入选择。先生成并保留 commandId、roles 和 selections，回执不明时重试完全相同的参数；输入固定后只能读取，不能替换。', inputSchema: captureInput, annotations: mutation }, async input => this.call(sessionKey, async binding => this.withService(async service => {
      const task = taskRef(binding, input)
      const command = executionInputCommandSchema.parse({ contractVersion: 2, kind: 'capture', commandId: input.commandId, task,
        expectedEpoch: binding.epoch, expectedActorId: binding.ownerId, expectedDeviceId: binding.deviceId,
        expectedExecutionId: input.executionId, expectedGeneration: input.generation, roles: input.roles, selections: input.selections })
      return { binding: this.publicBinding(binding), reply: await service.executionInputCapture({ connectionId: binding.connectionId, task, command }) }
    })))
    server.registerTool('team_task_progress', { description: '上报当前 editor-owned 执行的进度。进度命令使用原任务执行代次和服务回执。', inputSchema: reportInput, annotations: mutation }, async input => this.command(sessionKey, input, 'report', command => ({ ...command, seq: input.seq, state: input.state, step: input.step, blockingReason: input.blockingReason, nativeState: input.nativeState })))
    server.registerTool('team_task_save_artifact', { description: '保存当前执行的新产物版本。编辑器先生成并保留 artifactId；产物正文和摘要由同一命令绑定，不能复用旧文件或其他执行。', inputSchema: artifactInput, annotations: mutation }, async input => this.command(sessionKey, input, 'save-artifact', command => ({ ...command, artifactId: input.artifactId, previousVersionId: input.previousVersionId, artifactKind: input.artifactKind, title: input.title, text: input.text, expectedDigest: digest(input.text), disposition: input.disposition })))
    server.registerTool('team_task_seal_delivery', { description: '按已确认的产物或固定文档 ref 形成 T04 交付清单。数据库交付同时选择 implement 文档、selected-file SQL 与 check-report 的原始版本；check-report 的设备报告不代表服务器读取过本机文件或验证数据库上传。', inputSchema: sealInput, annotations: mutation }, async input => this.command(sessionKey, input, 'seal-delivery', command => ({ ...command, previous: input.previousVersionId && input.previousDigest ? { versionId: input.previousVersionId, digest: input.previousDigest } : null, entries: input.entries.map(entry => ({ outputId: entry.outputId, ref: 'ref' in entry ? entry.ref : { kind: 'confirmed-artifact' as const, executionId: input.executionId, artifactId: entry.artifactId, versionId: entry.versionId, bodyDigest: entry.digest } })) })))
    server.registerTool('team_task_checkpoint', { description: '保存当前节点的 T04 接力检查点和剩余工作。', inputSchema: checkpointInput, annotations: mutation }, async input => this.command(sessionKey, input, 'checkpoint', command => ({ ...command, previous: null, manifest: { versionId: input.manifestVersionId, digest: input.manifestDigest }, remainingWork: input.remainingWork, source: input.source, observation: input.observation })))
    server.registerTool('team_task_complete', { description: '提交当前 editor-owned 执行的完成证据、固定 outputs、manifest 和 checkpoint。使用保留的原 commandId；完成执行后仍需显式业务流转，服务统一校验交付门禁。', inputSchema: completeInput, annotations: mutation }, async input => this.command(sessionKey, input, 'finalize', command => ({ ...command, finalization: input.finalization })))
    server.registerTool('team_task_release', { description: '协作释放 editor-owned 写入权。释放只改变团队执行权，不宣称外部编辑器进程已经停止。', inputSchema: releaseInput, annotations: mutation }, async input => this.command(sessionKey, input, 'release', command => ({ ...command, nativeState: input.nativeState })))
    server.registerTool('team_task_transition', { description: '执行受团队 ACL 和任务版本保护的业务流转。首次 execution_read 后保留 generation、active.executionId（无 active 时为 null）及自行生成的 commandId；回执不明时重试完全相同参数，工具先核对原回执。', inputSchema: transitionInput, annotations: mutation }, async input => this.call(sessionKey, async binding => this.withService(async service => {
      const task = taskRef(binding, input)
      const command = { contractVersion: 2 as const, commandId: input.commandId, task, expectedEpoch: binding.epoch, expectedActorId: binding.ownerId, expectedDeviceId: binding.deviceId, expectedGeneration: input.generation, expectedExecutionId: input.executionId, kind: 'transition' as const, expectedRevision: input.expectedRevision, transition: input.transition }
      const receipt = await service.executionReconcile({ connectionId: binding.connectionId, task, command })
      const reply = receipt ? { status: 'duplicate' as const, commandId: command.commandId, result: receipt } : await service.executionCommand({ connectionId: binding.connectionId, task, command })
      return { binding: this.publicBinding(binding), reply }
    })))
    server.registerTool('team_task_command_reconcile', { description: '核对原命令的团队服务回执。只接受同一任务、同一代次和同一命令正文，不会换 UUID 重发。', inputSchema: z.object({ task: taskInput, command: z.record(z.string(), z.unknown()) }).strict(), annotations: readOnly }, async input => this.call(sessionKey, async binding => this.withService(async service => ({ binding: this.publicBinding(binding), receipt: await service.executionReconcile({ connectionId: binding.connectionId, task: taskRef(binding, input.task), command: input.command as never }) }))))
    return server
  }

  private async call<T>(key: string, action: (binding: EditorBinding) => Promise<T>): Promise<ReturnType<typeof result> | ReturnType<typeof failure>> {
    try {
      const session = await this.session(key)
      return result(await action(session.binding))
    } catch (error) { return failure(error) }
  }

  private async command<T extends z.infer<typeof taskInput> & { executionId: string; generation: number; nodeId?: string; attempt?: number; commandId?: string }>(key: string, input: T, kind: 'report' | 'save-artifact' | 'seal-delivery' | 'checkpoint' | 'release' | 'finalize', build: (command: Record<string, unknown>) => Record<string, unknown>): Promise<ReturnType<typeof result> | ReturnType<typeof failure>> {
    return this.call(key, async binding => {
      const task = taskRef(binding, input)
      const producer = kind === 'release' || kind === 'finalize' ? {} : kind === 'report' ? { nodeId: input.nodeId, attempt: input.attempt } : { expectedNodeId: input.nodeId, expectedAttempt: input.attempt }
      const base = { contractVersion: 2 as const, commandId: input.commandId ?? randomUUID(), task, expectedEpoch: binding.epoch, expectedActorId: binding.ownerId, expectedDeviceId: binding.deviceId, expectedGeneration: input.generation, expectedExecutionId: input.executionId, kind, ...producer }
      const command = build(base)
      const reply = await this.withService(service => service.executionCommand({ connectionId: binding.connectionId, task, command: command as never }))
      return { binding: this.publicBinding(binding), reply }
    })
  }

  private async session(key: string): Promise<EditorSession> {
    const existing = this.sessions.get(key)
    if (existing) { await this.assertCurrent(existing.binding); return existing }
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('编辑器 MCP 连接数已达到上限')
    const binding = await this.withService(async service => {
      const connection = (await service.connections()).find(item => item.state === 'active' && !item.accessLocked && item.ownerId && item.projectId)
      if (!connection || !connection.ownerId || !connection.projectId) throw new Error('当前没有可用于编辑器领取的团队连接')
      const snapshot = await service.cruxSnapshot(connection.connectionId)
      this.assertSnapshotValues(connection.connectionId, connection.projectId, connection.ownerId, connection.deviceId, snapshot)
      return { connectionId: connection.connectionId, origin: connection.origin, pairingId: connection.pairingId, deviceId: connection.deviceId, ownerId: connection.ownerId, projectId: connection.projectId, instanceId: snapshot.instanceId, epoch: snapshot.epoch, authorizationRevision: snapshot.authorizationRevision }
    })
    const session = { binding, abort: new AbortController() }
    this.sessions.set(key, session)
    return session
  }

  private async assertCurrent(binding: EditorBinding): Promise<void> {
    await this.withService(async service => {
      const connection = (await service.connections()).find(item => item.connectionId === binding.connectionId)
      if (!connection || connection.state !== 'active' || connection.accessLocked || connection.deviceId !== binding.deviceId || connection.ownerId !== binding.ownerId || connection.projectId !== binding.projectId) throw new Error('编辑器原设备或账号权限已撤销')
      const snapshot = await service.cruxSnapshot(binding.connectionId, { expectedInstanceId: binding.instanceId })
      this.assertSnapshot(binding, snapshot)
    })
  }

  private assertSnapshot(binding: EditorBinding, snapshot: { projectId: string; instanceId: string; epoch: string; authorizationRevision: number; actor: { id: string } }): void {
    this.assertSnapshotValues(binding.connectionId, binding.projectId, binding.ownerId, binding.deviceId, snapshot)
    if (snapshot.instanceId !== binding.instanceId || snapshot.epoch !== binding.epoch || snapshot.authorizationRevision !== binding.authorizationRevision) throw new Error('编辑器固定任务服务代次或授权版本已变化')
  }

  private assertSnapshotValues(_connectionId: string, projectId: string, actorId: string, _deviceId: string, snapshot: { projectId: string; instanceId: string; epoch: string; authorizationRevision: number; actor: { id: string } }): void {
    if (snapshot.projectId !== projectId || snapshot.actor.id !== actorId) throw new Error('团队快照不属于当前编辑器账号或项目')
  }

  private publicBinding(binding: EditorBinding): Record<string, unknown> { return { connectionId: binding.connectionId, projectId: binding.projectId, ownerId: binding.ownerId, deviceId: binding.deviceId, instanceId: binding.instanceId, epoch: binding.epoch, authorizationRevision: binding.authorizationRevision } }
  private async readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > MAX_BODY_BYTES) throw new Error('request too large'); chunks.push(Buffer.from(chunk)) }
    const raw = Buffer.concat(chunks).toString('utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid JSON body')
    return parsed
  }
  private reply(response: ServerResponse, status: number): void { if (!response.headersSent && !response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: 'editor MCP request rejected' })) } }
}
