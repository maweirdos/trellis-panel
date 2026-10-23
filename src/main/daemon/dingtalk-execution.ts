import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { WorkspaceGrant } from '../../shared/daemon'
import type { RuntimeBodyMethod } from '../../shared/daemon-runtime'
import { dingExecutionSchema, type DingExecution } from '../../shared/dingtalk-integration'
import type { DingTalkExecutionPort } from '../services/integrations/dingtalk-workspace/ports'
import { IntegrationError } from '../services/integrations/types'
import { canonicalDirectory } from '../services/acp/metadata'
import type { DaemonRuntime } from './runtime'

/** RFC4122 UUIDv5: original inbox command is the namespace; each native effect
 * has a distinct stable command ID in RuntimeHost's existing receipt store. */
export function dingTalkRuntimeCommand(commandId: string, stage: 'new' | 'prompt' | 'cancel'): string {
  z.string().uuid().parse(commandId)
  const bytes = createHash('sha1').update(Buffer.from(commandId.replace(/-/g, ''), 'hex')).update(`dingtalk:${stage}`).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 15) | 80; bytes[8] = ((bytes[8] ?? 0) & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const sessionSchema = z.object({ sessionId: z.string(), projectRoot: z.string(), agentId: z.string(), taskDir: z.string().optional(), status: z.string(), connectionGeneration: z.string().optional(), turnId: z.string().optional(), connectionOwned: z.boolean().optional(), profileSnapshot: z.object({ id: z.string(), runtimeId: z.string(), maxTurnMinutes: z.number() }).passthrough().optional(), pendingPermissions: z.array(z.unknown()).optional() }).passthrough()
type Evidence = { commandId: string; workspace: WorkspaceGrant; sessionId?: string | null; turnId?: string | null; connectionGeneration?: string | null; deadline?: number }
const failure = z.object({ ok: z.literal(false), code: z.string().optional() }).passthrough()

/** Only an adapter to the real RuntimeHost. No ACP constructor, process owner,
 * transcript store, permission responder or second execution ledger exists here. */
export function createDingTalkExecution(runtime: DaemonRuntime, assertGrant: (grant: WorkspaceGrant) => void): DingTalkExecutionPort & { close(): void } {
  const deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  const admitting = new Map<string, Promise<DingExecution>>()
  function result(input: Evidence, state: DingExecution['state'], detail: string, extra: Partial<DingExecution> = {}): DingExecution {
    return dingExecutionSchema.parse({ commandId: input.commandId, sessionId: input.sessionId ?? null, turnId: input.turnId ?? null, connectionGeneration: input.connectionGeneration ?? null, state, detail, ...extra })
  }
  async function body<M extends RuntimeBodyMethod>(method: M, input: unknown, workspace: WorkspaceGrant, commandId?: string): Promise<unknown> {
    assertGrant(workspace)
    const request = runtime.pack(workspace.root, input)
    const wire = await runtime.dispatch(method, request, { workspace, ...(commandId ? { commandId } : {}) })
    try { return runtime.unpack(workspace.root, wire) }
    finally { if (!commandId && 'blob' in wire) await runtime.dispatch('runtime.blob.release', { id: wire.blob.id }, { workspace }) }
  }
  async function receipt(workspace: WorkspaceGrant, id: string) {
    assertGrant(workspace)
    const entry = await runtime.dispatch('runtime.command', { commandId: id }, { workspace })
    return { state: entry.state, value: entry.result ? runtime.unpack(workspace.root, entry.result) : undefined }
  }
  async function session(workspace: WorkspaceGrant, sessionId: string) {
    const raw = await body('runtime.historySession', { sessionId }, workspace)
    return z.object({ ok: z.literal(true), session: sessionSchema }).parse(raw).session
  }
  async function validate(workspace: WorkspaceGrant, runtimeId: string, profileId: string): Promise<void> {
    const status = await runtime.status()
    if (status.authority !== 'daemon' || status.admission !== 'open' || status.released) throw new IntegrationError('原生运行时尚未完成后台接管或接入已关闭', 'denied')
    const [profilesRaw, agentsRaw] = await Promise.all([body('runtime.profiles', {}, workspace), body('runtime.agents', { refresh: false }, workspace)])
    const profiles = z.object({ ok: z.literal(true), profiles: z.array(z.object({ id: z.string(), runtimeId: z.string(), cwd: z.string().optional(), maxTurnMinutes: z.number() }).passthrough()) }).parse(profilesRaw)
    const agents = z.object({ ok: z.literal(true), agents: z.array(z.object({ id: z.string(), enabled: z.boolean(), available: z.boolean() }).passthrough()) }).parse(agentsRaw)
    const profile = profiles.profiles.find(item => item.id === profileId)
    if (!profile || profile.runtimeId !== runtimeId || canonicalDirectory(profile.cwd || workspace.root) !== canonicalDirectory(workspace.root) || !agents.agents.some(agent => agent.id === runtimeId && agent.enabled && agent.available)) throw new IntegrationError('原生 Runtime/Profile 不匹配、不可用或工作目录不属于授权工作区', 'denied')
    assertGrant(workspace)
  }
  function arm(input: Evidence): void {
    const old = deadlines.get(input.commandId); if (old) clearTimeout(old)
    if (!input.deadline || !input.sessionId || !input.turnId) { deadlines.delete(input.commandId); return }
    const timer = setTimeout(() => { deadlines.delete(input.commandId); void port.cancel({ commandId: input.commandId, workspace: input.workspace, sessionId: input.sessionId ?? null, turnId: input.turnId ?? null, connectionGeneration: input.connectionGeneration }).catch(() => { /* The native command receipt remains the reconciliation authority. */ }) }, Math.max(1, input.deadline - Date.now()))
    timer.unref(); deadlines.set(input.commandId, timer)
  }
  async function inspect(input: Evidence, armDeadline = true): Promise<DingExecution> {
    const newReceipt = await receipt(input.workspace, dingTalkRuntimeCommand(input.commandId, 'new'))
    const created = z.object({ ok: z.literal(true), sessionId: z.string() }).safeParse(newReceipt.value)
    const nativeSessionId = created.success ? created.data.sessionId : input.sessionId
    if (!nativeSessionId) return result(input, newReceipt.state === 'absent' ? 'pending' : 'unknown', newReceipt.state === 'absent' ? '尚无原生接入回执' : '原会话创建结果未确认；未重新创建')
    if (input.sessionId && nativeSessionId !== input.sessionId) return result(input, 'unknown', '原会话身份冲突，已停止后续动作')
    const prompt = await receipt(input.workspace, dingTalkRuntimeCommand(input.commandId, 'prompt'))
    const sent = z.object({ ok: z.literal(true), turnId: z.string() }).safeParse(prompt.value)
    const nativeTurnId = sent.success ? sent.data.turnId : input.turnId
    if (input.turnId && nativeTurnId !== input.turnId) return result(input, 'unknown', '原轮次身份冲突')
    const current = await session(input.workspace, nativeSessionId)
    if (canonicalDirectory(current.projectRoot) !== canonicalDirectory(input.workspace.root)) return result(input, 'denied', '原会话不属于授权工作区')
    const generation = input.connectionGeneration ?? current.connectionGeneration ?? null
    const evidence = { ...input, sessionId: nativeSessionId, turnId: nativeTurnId ?? null, connectionGeneration: generation }
    if (!nativeTurnId || !generation) return result(evidence, failure.safeParse(prompt.value).success ? 'denied' : prompt.state === 'absent' ? 'pending' : 'unknown', '会话存在，但尚无原始 promptStarted/轮次回执；未重发指令')
    // Terminal facts come from actual archived native events, never from idle
    // session status or a model's claim that a task has been completed.
    const archive = z.object({ ok: z.literal(true), events: z.array(z.object({ sessionId: z.string().optional(), connectionGeneration: z.string().optional(), turnId: z.string().optional(), kind: z.string(), payload: z.record(z.string(), z.unknown()).optional() }).passthrough()) }).safeParse(await body('runtime.historyEvents', { sessionId: nativeSessionId, input: { limit: 100 } }, input.workspace))
    const settled = archive.success ? archive.data.events.find(event => event.sessionId === nativeSessionId && event.turnId === nativeTurnId && event.connectionGeneration === generation && event.kind === 'turn-done') : undefined
    if (settled) {
      const native = z.object({ status: z.enum(['completed', 'cancelled', 'failed']) }).passthrough().safeParse(settled.payload?.result)
      if (native.success) { const timer = deadlines.get(input.commandId); if (timer) clearTimeout(timer); deadlines.delete(input.commandId); return result(evidence, native.data.status, native.data.status === 'completed' ? '原生轮次已结束；任务业务验收仍独立' : native.data.status === 'cancelled' ? '原生轮次已确认取消' : '原生轮次已失败') }
    }
    if (current.connectionGeneration !== generation || current.turnId !== nativeTurnId) return result(evidence, 'unknown', '会话连接或轮次已变更，原执行结果需要查看历史；不会操作后续轮次')
    if (!sent.success && !input.turnId) return result(evidence, 'unknown', '原指令提交结果未确认')
    if (['busy', 'awaiting_permission', 'cancelling'].includes(current.status)) {
      if (armDeadline) arm(evidence)
      return result(evidence, 'admitted', current.status === 'awaiting_permission' ? '等待原生审批；界面关闭也不会自动批准' : current.status === 'cancelling' ? '原生正在取消，尚未确认完成' : '原生已确认指令写入与执行轮次')
    }
    return result(evidence, 'unknown', '原轮次终态证据尚未读取；未重新发送或推断完成')
  }
  const port: DingTalkExecutionPort & { close(): void } = {
    validate,
    admit(input) {
      const prior = admitting.get(input.commandId); if (prior) return prior
      const operation = (async (): Promise<DingExecution> => {
        let evidence: Evidence = { commandId: input.commandId, workspace: input.workspace, deadline: input.deadline }
        try {
          assertGrant(input.workspace)
          if (Date.now() >= input.deadline || input.permissionPolicy !== 'original-native-approvals') return result(evidence, 'denied', '原执行期限已过或审批策略不符合原生契约')
          await validate(input.workspace, input.runtimeId, input.profileId)
          const newId = dingTalkRuntimeCommand(input.commandId, 'new'), promptId = dingTalkRuntimeCommand(input.commandId, 'prompt')
          const existing = await receipt(input.workspace, newId)
          if (existing.state !== 'absent') return await inspect(evidence)
          let created: unknown
          if (existing.state === 'absent') created = await body('runtime.new', { input: { agentId: input.runtimeId, profileId: input.profileId, taskDir: input.taskDir } }, input.workspace, newId)
          else if (existing.state === 'completed') created = existing.value
          else return result(evidence, 'unknown', '原会话创建命令需要核实，未重新创建')
          if (failure.safeParse(created).success) return result(evidence, 'denied', '原生会话接入被拒绝，请在本机检查运行时、配置和目录占用')
          const createdSession = z.object({ ok: z.literal(true), sessionId: z.string() }).parse(created)
          evidence = { ...evidence, sessionId: createdSession.sessionId }
          const readyBy = Math.min(input.deadline, Date.now() + 30000)
          let current = await session(input.workspace, createdSession.sessionId)
          while (current.status === 'starting' && Date.now() < readyBy) { await new Promise<void>(resolve => setTimeout(resolve, 250)); assertGrant(input.workspace); current = await session(input.workspace, createdSession.sessionId) }
          evidence = { ...evidence, connectionGeneration: current.connectionGeneration ?? null }
          if (current.agentId !== input.runtimeId || current.profileSnapshot?.id !== input.profileId || current.taskDir !== input.taskDir || !current.connectionGeneration) return result(evidence, 'unknown', '原生会话与固定配置不匹配，未发送指令')
          if (current.status !== 'ready' || Date.now() >= input.deadline) return result(evidence, current.status === 'starting' ? 'pending' : 'denied', '会话尚未就绪或原期限已过；未发送指令')
          assertGrant(input.workspace)
          const oldPrompt = await receipt(input.workspace, promptId)
          if (Date.now() >= input.deadline) return result(evidence, 'denied', '原执行期限已过，未发送指令')
          let prompted: unknown
          if (oldPrompt.state === 'absent') prompted = await body('runtime.prompt', { sessionId: current.sessionId, text: input.text, options: { expectedConnectionGeneration: current.connectionGeneration } }, input.workspace, promptId)
          else if (oldPrompt.state === 'completed') prompted = oldPrompt.value
          else return result(evidence, 'unknown', '原指令命令结果未确认，未重新发送')
          if (failure.safeParse(prompted).success) return result(evidence, 'denied', '原生指令接入未成功；没有已确认的 promptStarted 回执')
          // The production facade returns ok+turnId only after awaiting the
          // runtime's real promptStarted checkpoint, inspected in source.
          const prompt = z.object({ ok: z.literal(true), turnId: z.string() }).parse(prompted)
          evidence = { ...evidence, turnId: prompt.turnId }
          arm(evidence)
          return result(evidence, 'admitted', '原生已确认指令写入和轮次；审批保持原始选项与期限')
        } catch (error) { return result(evidence, error instanceof IntegrationError && error.kind === 'denied' && !evidence.sessionId ? 'denied' : 'unknown', error instanceof IntegrationError ? error.message : '原生执行结果未确认，请查询原命令；未自动重放') }
      })().finally(() => admitting.delete(input.commandId))
      admitting.set(input.commandId, operation); return operation
    },
    async query(input) { try { return await inspect(input) } catch { return result(input, 'unknown', '原生回执或历史当前不可读；原执行身份已保留') } },
    async cancel(input) {
      try {
        const observed = await inspect(input, false)
        if (['completed', 'failed', 'cancelled', 'denied'].includes(observed.state)) return observed
        if (!observed.sessionId || !observed.turnId || !observed.connectionGeneration) return result({ ...input, ...observed }, 'unknown', '缺少原生轮次身份，未取消其他会话')
        const current = await session(input.workspace, observed.sessionId)
        if (current.connectionGeneration !== observed.connectionGeneration || current.turnId !== observed.turnId) return result(observedAsInput(input, observed), 'unknown', '原会话轮次已变更；未取消后续轮次')
        await body('runtime.cancel', { sessionId: observed.sessionId }, input.workspace, dingTalkRuntimeCommand(input.commandId, 'cancel'))
        return await inspect({ ...input, ...observed }, false)
      } catch { return result(input, 'unknown', '原生取消结果未确认，需查询原取消命令；没有替换执行') }
    },
    close() { for (const timer of deadlines.values()) clearTimeout(timer); deadlines.clear() }
  }
  return port
}
function observedAsInput(input: Evidence, observed: DingExecution): Evidence { return { ...input, sessionId: observed.sessionId, turnId: observed.turnId, connectionGeneration: observed.connectionGeneration } }
