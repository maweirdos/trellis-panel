import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { broadcastToWindows } from './bridge'
import { getSettings } from './store'
import { aiChatStream, decryptKeyOf, type AgentLoopMessage, type StreamTarget } from './ai'
import { GatewayManager } from './gateway/manager'
import { getProjectRoot, getSnapshot } from '../state'
import { noteUpsert } from './knowledge'
import { ipcEvent } from '../../shared/ipc-channels'
import type {
  AgentStep,
  FlowDef,
  FlowRunEvent,
  FlowRunRecord,
  GateStep,
  ToolStep
} from '../../shared/types'

/**
 * 工作流运行时：展平 phases 为步骤序列顺序执行；
 * agent 步骤带工具循环（检索→生成），gate 步骤做确定性检查并支持 goto 带反馈重试；
 * 事件走 flow:output / flow:done（runId 关联成对），运行记录持久化 userData/flow-runs/。
 */

interface ActiveRun {
  runId: string
  flowId: string
  controller: AbortController
}

const activeRuns = new Map<string, ActiveRun>()

function runsDir(): string {
  const dir = join(app.getPath('userData'), 'flow-runs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function recordPath(runId: string): string {
  return join(runsDir(), `${runId}.json`)
}

function persistRecord(rec: FlowRunRecord): void {
  const p = recordPath(rec.runId)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf-8')
  renameSync(tmp, p)
}

export function listRunRecords(limit = 20): FlowRunRecord[] {
  const out: FlowRunRecord[] = []
  try {
    for (const f of readdirSync(runsDir())) {
      if (!f.endsWith('.json') || f.endsWith('.tmp.json')) continue
      try {
        out.push(JSON.parse(readFileSync(join(runsDir(), f), 'utf-8')) as FlowRunRecord)
      } catch {
        // skip
      }
    }
  } catch {
    return []
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

export function abortRun(runId: string): { ok: boolean; error?: string } {
  const run = activeRuns.get(runId)
  if (!run) return { ok: false, error: '运行不存在或已结束' }
  run.controller.abort()
  return { ok: true }
}

/** 变量插值：{{input.x}} / {{vars.x}} */
function interpolate(text: string, input: Record<string, string>, vars: Record<string, string>): string {
  return String(text ?? '').replace(/\{\{\s*(input|vars)\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, kind: string, name: string) => {
    if (kind === 'input') return input[name] ?? ''
    return vars[name] ?? ''
  })
}

function resolveTarget(): StreamTarget | null {
  const cfg = getSettings().ai
  const provider = cfg.providers?.find((p) => p.id === cfg.activeProviderId) || cfg.providers?.[0]
  if (!provider) return null
  const modelId = provider.models?.find((m) => m.enabled)?.id || provider.models?.[0]?.id || ''
  if (!modelId) return null
  return {
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
    apiKey: decryptKeyOf(provider.apiKey, provider.apiKeyEncrypted),
    model: modelId,
    temperature: 0.4
  }
}

/** agent 步骤的工具循环：检索/读证 → 生成最终回答 */
async function runAgentStep(
  target: StreamTarget,
  step: AgentStep,
  input: Record<string, string>,
  vars: Record<string, string>,
  root: string,
  extraContext: string[],
  controller: AbortController
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const systemParts = [step.persona ?? '你是尽职的AI助理。']
  const hooks = currentHooks
  if (hooks?.onStart) systemParts.push(hooks.onStart)
  if (currentPhaseName && hooks?.onPhase?.[currentPhaseId ?? '']) systemParts.push(hooks.onPhase[currentPhaseId ?? ''])
  const instruction = [extraContext.join('\n\n'), interpolate(step.instruction, input, vars)].filter(Boolean).join('\n\n')

  const ctx: AgentLoopMessage[] = [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: instruction }
  ]
  const allTools = GatewayManager.toOpenAiTools()
  const allowed = step.tools?.length ? allTools.filter((t) => step.tools!.includes(String((t as { function: { name: string } }).function?.name))) : []
  const maxRounds = Math.max(1, Math.min(step.maxRounds ?? 3, 5))

  for (let round = 1; round <= maxRounds; round += 1) {
    const res = await aiChatStream(target, ctx, {
      signal: controller.signal,
      tools: allowed,
      onDelta: () => {}
    })
    if (res.aborted) return { ok: false, error: '已中止' }
    if (!res.ok) return { ok: false, error: res.error ?? '模型调用失败' }
    if (!res.toolCalls?.length) return { ok: true, content: res.content ?? '' }
    ctx.push({
      role: 'assistant',
      content: res.content ?? '',
      tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.argsJson } }))
    })
    for (const call of res.toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>
      } catch {
        args = {}
      }
      // args 变量插值（tool 步骤同规则）
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string') args[k] = interpolate(v, input, vars)
      }
      const exec = await GatewayManager.executeTool(call.name, args, root)
      emit(currentRunId!, currentFlowId!, 'log', { text: `工具 ${call.name} ${exec.ok ? '✓' : '✗'}（${exec.elapsedMs}ms）` })
      ctx.push({ role: 'tool', tool_call_id: call.id, content: (exec.ok ? exec.preview : JSON.stringify({ error: exec.error }))?.slice(0, 8000) ?? '{}' })
    }
  }
  // 轮次耗尽：最后再要一次纯生成
  const final = await aiChatStream(target, ctx, { signal: controller.signal, onDelta: () => {} })
  if (final.aborted) return { ok: false, error: '已中止' }
  if (!final.ok) return { ok: false, error: final.error ?? '模型调用失败' }
  return { ok: true, content: final.content ?? '' }
}

/* 引擎执行期单例上下文（一次只有一个 current run per service instance —— 用局部变量传递更清晰，
   但 agent 循环回调需要访问；简单起见用模块级当前运行态） */
let currentRunId: string | null = null
let currentFlowId: string | null = null
let currentHooks: FlowDef['hooks'] | undefined
let currentPhaseId: string | null = null
let currentPhaseName: string | null = null

function emit(runId: string, flowId: string, kind: FlowRunEvent['kind'], extra: Partial<FlowRunEvent>): void {
  const ev: FlowRunEvent = {
    runId,
    flowId,
    kind,
    ts: Date.now(),
    phaseId: currentPhaseId ?? undefined,
    ...extra
  }
  broadcastToWindows(ipcEvent.flowOutput, ev)
  const rec = runningRecord
  if (rec && rec.runId === runId) {
    rec.events.push(ev)
  }
}

let runningRecord: FlowRunRecord | null = null

export function startFlowRun(def: FlowDef, inputValues: Record<string, string>): { ok: boolean; runId?: string; error?: string } {
  const root = getProjectRoot()
  if (!root) return { ok: false, error: '未打开项目' }
  const target = resolveTarget()
  if (!target) return { ok: false, error: '未配置模型供应商（设置 → AI 模型）' }
  if (activeRuns.size >= 3) return { ok: false, error: '同时最多运行 3 个工作流，请等待或中止现有运行' }

  const runId = `frun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const controller = new AbortController()
  activeRuns.set(runId, { runId, flowId: def.id, controller })

  // 输入缺省值合并 + 必填校验
  const input: Record<string, string> = {}
  for (const i of def.inputs ?? []) {
    const v = String(inputValues?.[i.name] ?? '').trim()
    if (!v && i.required) {
      activeRuns.delete(runId)
      return { ok: false, error: `缺少必填输入：${i.label}` }
    }
    input[i.name] = v || String(i.default ?? '')
  }

  const record: FlowRunRecord = {
    runId,
    flowId: def.id,
    flowName: def.name,
    status: 'running',
    startedAt: Date.now(),
    inputs: input,
    events: [],
    vars: {}
  }
  runningRecord = record
  currentRunId = runId
  currentFlowId = def.id
  currentHooks = def.hooks

  void executeFlow(runId, def, input, target, controller, root, record)
  return { ok: true, runId }
}

async function executeFlow(
  runId: string,
  def: FlowDef,
  input: Record<string, string>,
  target: StreamTarget,
  controller: AbortController,
  root: string,
  record: FlowRunRecord
): Promise<void> {
  const vars: Record<string, string> = {}
  const outputs = new Map<string, string>() // stepId → output（gate 检查用）
  const gateRetries = new Map<string, number>()
  const extraFeedback = new Map<string, string[]>() // stepId → 门禁反馈队列

  // 展平步骤序列（保留 phase 信息）
  interface FlatStep { phaseId: string; phaseName: string; step: AgentStep | ToolStep | GateStep }
  const flat: FlatStep[] = []
  for (const p of def.phases) for (const s of p.steps) flat.push({ phaseId: p.id, phaseName: p.name, step: s })
  const indexOfStep = (id: string): number => flat.findIndex((f) => f.step.id === id)

  let status: FlowRunRecord['status'] = 'completed'
  let errorMsg: string | undefined
  let lastPhase = ''

  try {
    let i = 0
    while (i < flat.length) {
      if (controller.signal.aborted) {
        status = 'aborted'
        break
      }
      const { phaseId, phaseName, step } = flat[i]
      if (phaseId !== lastPhase) {
        lastPhase = phaseId
        currentPhaseId = phaseId
        currentPhaseName = phaseName
        emit(runId, def.id, 'phase-start', { phaseId, text: phaseName })
      }

      if (step.kind === 'gate') {
        emit(runId, def.id, 'step-start', { stepId: step.id, text: step.name })
        const target_output = outputs.get(step.check.stepId) ?? ''
        let pass = true
        if (step.check.contains && !target_output.includes(interpolate(step.check.contains, input, vars))) pass = false
        if (step.check.notContains && target_output.includes(interpolate(step.check.notContains, input, vars))) pass = false
        if (typeof step.check.minLength === 'number' && target_output.length < step.check.minLength) pass = false
        if (pass) {
          emit(runId, def.id, 'gate-pass', { stepId: step.id, text: step.name })
          i += 1
          continue
        }
        const used = gateRetries.get(step.id) ?? 0
        emit(runId, def.id, 'gate-fail', { stepId: step.id, text: `${step.name}：未通过（第 ${used + 1} 次）` })
        if (step.onFail === 'abort') {
          status = 'error'
          errorMsg = `门禁未通过：${step.name}`
          break
        }
        if (step.onFail === 'continue') {
          i += 1
          continue
        }
        // goto：带反馈重试
        if (used >= (step.maxRetries ?? 1)) {
          status = 'error'
          errorMsg = `门禁「${step.name}」重试后仍未通过`
          break
        }
        gateRetries.set(step.id, used + 1)
        const feedbackTo = step.feedbackTo ?? step.gotoStepId
        if (feedbackTo) {
          const list = extraFeedback.get(feedbackTo) ?? []
          list.push(`上一次输出未通过「${step.name}」检查（要求：${[step.check.contains ? `包含「${step.check.contains}」` : '', typeof step.check.minLength === 'number' ? `长度≥${step.check.minLength}` : ''].filter(Boolean).join('、')}）。请针对该问题改进后重新输出。`)
          extraFeedback.set(feedbackTo, list)
        }
        const targetIdx = indexOfStep(step.gotoStepId ?? '')
        i = targetIdx >= 0 ? targetIdx : i + 1
        continue
      }

      emit(runId, def.id, 'step-start', { stepId: step.id, text: step.name })
      let output = ''
      if (step.kind === 'agent') {
        const feedback = extraFeedback.get(step.id) ?? []
        extraFeedback.delete(step.id)
        const res = await runAgentStep(target, step, input, vars, root, feedback, controller)
        if (!res.ok) {
          if (controller.signal.aborted) {
            status = 'aborted'
            break
          }
          status = 'error'
          errorMsg = `步骤「${step.name}」失败：${res.error}`
          emit(runId, def.id, 'step-error', { stepId: step.id, text: errorMsg })
          break
        }
        output = res.content ?? ''
      } else {
        const toolStep = step as ToolStep
        const args: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(toolStep.args ?? {})) args[k] = interpolate(v, input, vars)
        const exec = await GatewayManager.executeTool(toolStep.tool, args, root)
        if (!exec.ok) {
          status = 'error'
          errorMsg = `工具步骤「${toolStep.name}」失败：${exec.error}`
          emit(runId, def.id, 'step-error', { stepId: toolStep.id, text: errorMsg })
          break
        }
        output = String(exec.preview ?? '')
      }
      outputs.set(step.id, output)
      if ((step as AgentStep | ToolStep).saveOutputAs) {
        vars[(step as AgentStep | ToolStep).saveOutputAs as string] = output
        record.vars = { ...vars }
      }
      emit(runId, def.id, 'step-done', { stepId: step.id, text: step.name, output: output.slice(0, 400) })
      i += 1
    }
    if (lastPhase && status === 'completed') {
      currentPhaseId = lastPhase
      emit(runId, def.id, 'phase-done', { phaseId: lastPhase, text: '全部阶段完成' })
    }
  } catch (e) {
    status = 'error'
    errorMsg = (e as Error).message
  }

  // 完成钩子：沉淀笔记
  if (status === 'completed' && def.hooks?.onComplete?.saveNote) {
    try {
      const finalOutput = Object.entries(vars).map(([k, v]) => `## ${k}\n\n${v.slice(0, 4000)}`).join('\n\n')
      const summary = `# ${def.name} 运行产物\n\n运行时间：${new Date().toLocaleString('zh-CN')}\n输入：${JSON.stringify(input)}\n\n${finalOutput}`
      noteUpsert(root, `flow-${Date.now().toString(36)}-${def.id}`, summary)
    } catch {
      // best-effort
    }
  }

  record.status = status
  record.endedAt = Date.now()
  record.error = errorMsg
  persistRecord(record)
  activeRuns.delete(runId)
  if (runningRecord?.runId === runId) runningRecord = null
  currentRunId = null
  currentFlowId = null
  currentHooks = undefined
  currentPhaseId = null
  currentPhaseName = null
  broadcastToWindows(ipcEvent.flowDone, {
    runId,
    flowId: def.id,
    status,
    error: errorMsg,
    flowName: def.name,
    taskTitle: getSnapshot()?.meta.name
  })
}
