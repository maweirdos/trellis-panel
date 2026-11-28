import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import type {
  CommandExecutionRequestApprovalParams, CommandExecutionRequestApprovalResponse,
  DynamicToolCallParams, DynamicToolCallResponse,
  FileChangeRequestApprovalParams, FileChangeRequestApprovalResponse,
  ToolRequestUserInputParams, ToolRequestUserInputResponse,
  V2ThreadStartParams__DynamicToolSpec,
} from './app-server/schema'
import type { ConversationDelegationCall } from '../../../../../shared/conversation/thread-relations'
import type { ConversationRuntimeQuestion } from '../../../../../shared/conversation/command-runtime'
import type { ConversationDriverEventListener, ConversationRespondToRuntimeRequestInput, ConversationStartTurnContext } from '../registry'
import { DaemonError } from '../../../../daemon/errors'
import { callArtifactMcpTool, type OpenArtifactMcpToolName } from '../../../open-artifact/mcp-client'

const taskId = { type: 'string', minLength: 1, maxLength: 200 } as const
export const codexDelegationTools: readonly V2ThreadStartParams__DynamicToolSpec[] = [
  {
    type: 'function', name: 'delegate_task',
    description: 'Start a scoped child task. Shared is read-only. Choose worktree when the user requests a separate writable checkout. Use mode wait only if this turn needs the result. A question or approval ends the wait; timeout leaves the child running.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['task'], properties: {
      task: { type: 'string', minLength: 1, maxLength: 16_000 }, title: { type: 'string', maxLength: 200 },
      isolation: { type: 'string', enum: ['shared', 'worktree'], default: 'shared',
        description: 'Worktree starts from the committed parent revision. Uncommitted changes stay out.' },
      mode: { type: 'string', enum: ['async', 'wait'], default: 'async' },
      timeoutMs: { type: 'number', description: 'Wait mode only. The wait is capped at 45 seconds.' },
    } },
  },
  {
    type: 'function', name: 'task_status',
    description: 'Read the status, pending question, or available result of an original child task.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId } },
  },
  {
    type: 'function', name: 'task_cancel', description: 'Stop the original child task.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId } },
  },
  {
    type: 'function', name: 'task_respond', description: 'Answer a currently pending question on the original child task.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'requestId', 'generation', 'answers'], properties: {
      taskId, requestId: taskId, generation: { type: 'integer', minimum: 1 },
      answers: { type: 'object', additionalProperties: { anyOf: [{ type: 'string', maxLength: 4_000 },
        { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 4_000 } }] } },
    } },
  },
]

const emptyAnswers: ToolRequestUserInputResponse = { answers: {} }
const reply = (success: boolean, text: string): DynamicToolCallResponse => ({ success, contentItems: [{ type: 'inputText', text }] })
const key = (threadId: string, itemId: string): string => JSON.stringify([threadId, itemId])

interface CodexToolTurn {
  readonly turnId?: string
  readonly notify: ConversationDriverEventListener
  readonly context?: ConversationStartTurnContext
}

interface PendingQuestion {
  readonly kind: 'user-input'
  readonly nativeThreadId: string
  readonly turnId: string
  readonly questions: readonly ConversationRuntimeQuestion[]
  readonly answer: Deferred.Deferred<ToolRequestUserInputResponse>
}

interface PendingApproval {
  readonly kind: 'approval'
  readonly nativeThreadId: string
  readonly turnId: string
  readonly answer: Deferred.Deferred<'accept' | 'acceptForSession' | 'decline' | 'cancel'>
}

const buildScopeKey = (prefix: string, detail?: string | null): string =>
  `${prefix}:${(detail ?? 'default').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase()}`

export const codexArtifactTools: readonly V2ThreadStartParams__DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'Artifact',
    description: 'Create, inspect, update, call actions on, or open Open Artifact rich interactive items (docs, slides, whiteboard, design, design-system, sheets, data, motion, page). Call action="quickstart" with intent first.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        action: { type: 'string', enum: ['quickstart', 'list', 'publish', 'read', 'open', 'call', 'adopt', 'delete', 'share'] },
        intent: { type: 'string' },
        type_url: { type: 'string' },
        type: { type: 'string' },
        title: { type: 'string' },
        url: { type: 'string' },
        files: { type: 'object', additionalProperties: true },
        name: { type: 'string' },
        args: { type: 'object', additionalProperties: true },
        location: { type: 'string', enum: ['home', 'workspace'] },
        open: { type: 'string', enum: ['after_first_write', 'now', 'never'] }
      }
    }
  },
  {
    type: 'function',
    name: 'ArtifactData',
    description: 'Read, query, and update live-store collections inside an Open Artifact (whiteboard, data dashboard, motion).',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['action', 'url'],
      properties: {
        action: { type: 'string', enum: ['get', 'list', 'query', 'set', 'update', 'delete', 'str_replace', 'batch'] },
        url: { type: 'string' }
      }
    }
  },
  {
    type: 'function',
    name: 'ArtifactComments',
    description: 'Read, reply to, resolve, or reopen user comments anchored to an Open Artifact.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['read', 'reply', 'resolve', 'reopen', 'wait'] },
        url: { type: 'string' }
      }
    }
  }
]

const ARTIFACT_TOOL_NAMES = new Set<OpenArtifactMcpToolName>(['Artifact', 'ArtifactData', 'ArtifactComments'])
function isArtifactTool(tool: string): tool is OpenArtifactMcpToolName {
  return ARTIFACT_TOOL_NAMES.has(tool as OpenArtifactMcpToolName)
}

function isDelegationTool(tool: string): tool is ConversationDelegationCall['tool'] {
  return codexDelegationTools.some(entry => entry.name === tool)
}

export class CodexTurnTools {
  private readonly questions = new Map<string, PendingQuestion>()
  private readonly approvals = new Map<string, PendingApproval>()

  constructor(private readonly active: (threadId: string) => CodexToolTurn | undefined) {}

  readonly approveCommand = (input: CommandExecutionRequestApprovalParams): Effect.Effect<CommandExecutionRequestApprovalResponse> => {
    const tools = this
    return Effect.gen(function* () {
      const { threadId, turnId, itemId, approvalId, command, reason } = input
      const active = tools.active(threadId)
      const requestId = approvalId ?? itemId
      if (!active || active.turnId !== turnId || !requestId || requestId.length > 512) {
        return { decision: 'cancel' }
      }
      const id = key(threadId, requestId)
      if (tools.approvals.has(id)) return { decision: 'cancel' }
      const answer = yield* Deferred.make<'accept' | 'acceptForSession' | 'decline' | 'cancel'>()
      tools.approvals.set(id, { kind: 'approval', nativeThreadId: threadId, turnId, answer })
      const cleanCommand = typeof command === 'string' && command.trim() ? command.trim().slice(0, 512) : undefined
      const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 512) : undefined
      return yield* Effect.sync(() => {
        active.context?.assertCurrent()
        active.notify({
          type: 'runtime-request',
          nativeRequestId: requestId,
          turnId,
          request: {
            kind: 'approval',
            requestKind: 'command',
            approvalScopeKey: buildScopeKey('codex:cmd', cleanCommand),
            title: cleanCommand ? `运行命令：${cleanCommand}` : 'Codex 请求执行命令',
            ...(cleanReason ? { details: cleanReason } : {}),
            options: [
              { decision: 'accept', label: '允许本次' },
              { decision: 'acceptForSession', label: '本会话允许' },
              { decision: 'decline', label: '拒绝' },
              { decision: 'cancel', label: '取消回合' },
            ],
          },
        })
      }).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.timeout('10 minutes'),
        Effect.catch(() => Effect.succeed('cancel' as const)),
        Effect.catchDefect(() => Effect.succeed('cancel' as const)),
        Effect.map((decision): CommandExecutionRequestApprovalResponse => ({ decision })),
        Effect.ensuring(Effect.sync(() => { tools.approvals.delete(id) })),
      )
    })
  }

  readonly approveFileChange = (input: FileChangeRequestApprovalParams): Effect.Effect<FileChangeRequestApprovalResponse> => {
    const tools = this
    return Effect.gen(function* () {
      const { threadId, turnId, itemId, reason, grantRoot } = input
      const active = tools.active(threadId)
      if (!active || active.turnId !== turnId || !itemId || itemId.length > 512) {
        return { decision: 'cancel' }
      }
      const id = key(threadId, itemId)
      if (tools.approvals.has(id)) return { decision: 'cancel' }
      const answer = yield* Deferred.make<'accept' | 'acceptForSession' | 'decline' | 'cancel'>()
      tools.approvals.set(id, { kind: 'approval', nativeThreadId: threadId, turnId, answer })
      const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 512) : undefined
      const scopeHint = typeof grantRoot === 'string' && grantRoot.trim() ? grantRoot.trim() : cleanReason
      return yield* Effect.sync(() => {
        active.context?.assertCurrent()
        active.notify({
          type: 'runtime-request',
          nativeRequestId: itemId,
          turnId,
          request: {
            kind: 'approval',
            requestKind: 'file-change',
            approvalScopeKey: buildScopeKey('codex:file', scopeHint),
            title: 'Codex 请求修改文件',
            ...(cleanReason ? { details: cleanReason } : typeof grantRoot === 'string' && grantRoot.trim() ? { details: grantRoot.trim() } : {}),
            options: [
              { decision: 'accept', label: '允许本次' },
              { decision: 'acceptForSession', label: '本会话允许' },
              { decision: 'decline', label: '拒绝' },
              { decision: 'cancel', label: '取消回合' },
            ],
          },
        })
      }).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.timeout('10 minutes'),
        Effect.catch(() => Effect.succeed('cancel' as const)),
        Effect.catchDefect(() => Effect.succeed('cancel' as const)),
        Effect.map((decision): FileChangeRequestApprovalResponse => ({ decision })),
        Effect.ensuring(Effect.sync(() => { tools.approvals.delete(id) })),
      )
    })
  }

  readonly delegate = (input: DynamicToolCallParams): Effect.Effect<DynamicToolCallResponse> =>
    Effect.promise(async () => {
      const { threadId, turnId, callId, tool } = input
      const active = this.active(threadId)
      if (!input.namespace && isArtifactTool(tool)) {
        if (active?.turnId !== turnId || !active.context?.artifactMcp) {
          return reply(false, '当前会话尚未授权启用 /artifacts 工具，请先通过 /artifacts 命令或确认卡片启用。')
        }
        try {
          active.context.assertCurrent()
          const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
            ? input.arguments as Record<string, unknown>
            : {}
          const result = await callArtifactMcpTool(active.context.artifactMcp, tool, args)
          return reply(result.success, result.text)
        } catch {
          return reply(false, 'Open Artifact 工具执行未完成，请稍后重试。')
        }
      }
      if (input.namespace || !isDelegationTool(tool) || active?.turnId !== turnId || !active?.context?.delegation) {
        return reply(false, '当前原生回合没有此委派权限。')
      }
      try {
        active.context.assertCurrent()
        const result = await active.context.delegation({ nativeThreadId: threadId, nativeTurnId: turnId, callId, tool, arguments: input.arguments })
        return reply(result.success, result.text)
      } catch { return reply(false, '原会话的委派调用未受理。') }
    })

  readonly ask = (input: ToolRequestUserInputParams): Effect.Effect<ToolRequestUserInputResponse> => {
    const tools = this
    return Effect.gen(function* () {
      const { threadId, turnId, itemId } = input
      const active = tools.active(threadId)
      if (!active || active.turnId !== turnId || !itemId || itemId.length > 512 || input.questions.length === 0 || input.questions.length > 32) {
        return emptyAnswers
      }
      const questions: ConversationRuntimeQuestion[] = []
      for (const { id, header, question, options, isSecret, isOther } of input.questions) {
        if (isSecret || !id || id.length > 200 || !question.trim() || questions.some(existing => existing.id === id)) return emptyAnswers
        const seen = new Set<string>()
        const choices: Array<{ readonly value: string; readonly label: string; readonly description?: string }> = []
        for (const option of (options ?? []).slice(0, 32)) {
          const label = option.label.trim()
          if (!label || label.length > 512 || seen.has(label)) continue
          seen.add(label)
          const rawDescription = typeof option.description === 'string' ? option.description.trim() : ''
          const description = rawDescription && rawDescription !== label ? rawDescription.slice(0, 512) : undefined
          choices.push({ value: label, label, ...(description ? { description } : {}) })
        }
        const cleanHeader = typeof header === 'string' ? header.trim().slice(0, 120) : ''
        questions.push({
          id,
          ...(cleanHeader ? { header: cleanHeader } : {}),
          prompt: question.trim().slice(0, 4_000),
          ...(choices.length ? { choices } : {}),
          ...(isOther ? { allowCustom: true } : {}),
        })
      }
      const id = key(threadId, itemId)
      if (tools.questions.has(id)) return emptyAnswers
      const answer = yield* Deferred.make<ToolRequestUserInputResponse>()
      tools.questions.set(id, { kind: 'user-input', nativeThreadId: threadId, turnId, questions, answer })
      return yield* Effect.sync(() => {
        active.context?.assertCurrent()
        active.notify({ type: 'runtime-request', nativeRequestId: itemId, turnId, request: {
          kind: 'user-input', title: '模型需要你确认方向', responseMode: 'live', questions,
        } })
      }).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.timeout('3 minutes'),
        Effect.catch(() => Effect.succeed(emptyAnswers)),
        Effect.catchDefect(() => Effect.succeed(emptyAnswers)),
        Effect.ensuring(Effect.sync(() => { tools.questions.delete(id) })),
      )
    })
  }

  readonly respond = (input: ConversationRespondToRuntimeRequestInput): Effect.Effect<void, Error> =>
    Effect.suspend(() => {
      const { response, nativeThreadId, turnId, nativeRequestId } = input
      const pendingApproval = this.approvals.get(key(nativeThreadId, nativeRequestId))
      if (pendingApproval) {
        if (pendingApproval.turnId !== turnId || this.active(nativeThreadId)?.turnId !== turnId || response.kind !== 'approval') {
          return Effect.fail(new DaemonError('E_CONFLICT', '此审批回复不属于当前 Codex 原回合。'))
        }
        const mapped = response.decision === 'acceptAlways' ? 'acceptForSession' : response.decision
        return Deferred.succeed(pendingApproval.answer, mapped).pipe(Effect.flatMap(accepted => accepted
          ? Effect.void : Effect.fail(new DaemonError('E_CONFLICT', '此审批请求已响应。'))))
      }
      const pending = this.questions.get(key(nativeThreadId, nativeRequestId))
      if (!pending || pending.turnId !== turnId || this.active(nativeThreadId)?.turnId !== turnId
        || response.kind !== 'user-input' || response.attachments?.contents.length) {
        return Effect.fail(new DaemonError('E_CONFLICT', '此回复不属于当前 Codex 原问题。'))
      }
      const answers = new Map<string, { answers: string[] }>()
      for (const { id, choices, allowCustom } of pending.questions) {
        const value = response.answers[id]
        const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
        if (!entries.length || entries.length > 32 || entries.some(entry => typeof entry !== 'string' || !entry.trim() ||
          entry.length > 4_000 || (choices && !allowCustom && !choices.some(choice => choice.value === entry)))) {
          return Effect.fail(new DaemonError('E_INVALID_ARG', 'Codex 的原问题需要有效答复。'))
        }
        answers.set(id, { answers: entries })
      }
      if (answers.size !== Object.keys(response.answers).length) return Effect.fail(new DaemonError('E_INVALID_ARG', '答复含有未经请求的字段。'))
      return Deferred.succeed(pending.answer, { answers: Object.fromEntries(answers) }).pipe(Effect.flatMap(accepted => accepted
        ? Effect.void : Effect.fail(new DaemonError('E_CONFLICT', '此问题的原答复已完成。'))))
    })

  settle(threadId: string, turnId?: string): void {
    for (const pending of this.approvals.values()) {
      if (pending.nativeThreadId === threadId && (!turnId || pending.turnId === turnId)) {
        Effect.runSync(Deferred.succeed(pending.answer, 'cancel'))
      }
    }
    for (const pending of this.questions.values()) {
      if (pending.nativeThreadId === threadId && (!turnId || pending.turnId === turnId)) {
        Effect.runSync(Deferred.succeed(pending.answer, emptyAnswers))
      }
    }
  }
}
