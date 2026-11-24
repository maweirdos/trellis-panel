import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import type {
  DynamicToolCallParams, DynamicToolCallResponse, ToolRequestUserInputParams, ToolRequestUserInputResponse,
  V2ThreadStartParams__DynamicToolSpec,
} from './app-server/schema'
import type { ConversationDelegationCall } from '../../../../../shared/conversation/thread-relations'
import type { ConversationRuntimeQuestion } from '../../../../../shared/conversation/command-runtime'
import type { ConversationDriverEventListener, ConversationRespondToRuntimeRequestInput, ConversationStartTurnContext } from '../registry'
import { DaemonError } from '../../../../daemon/errors'

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
  readonly nativeThreadId: string
  readonly turnId: string
  readonly questions: readonly ConversationRuntimeQuestion[]
  readonly answer: Deferred.Deferred<ToolRequestUserInputResponse>
}

function isDelegationTool(tool: string): tool is ConversationDelegationCall['tool'] {
  return codexDelegationTools.some(entry => entry.name === tool)
}

export class CodexTurnTools {
  private readonly questions = new Map<string, PendingQuestion>()

  constructor(private readonly active: (threadId: string) => CodexToolTurn | undefined) {}

  readonly delegate = (input: DynamicToolCallParams): Effect.Effect<DynamicToolCallResponse> =>
    Effect.promise(async () => {
      const { threadId, turnId, callId, tool } = input
      const active = this.active(threadId)
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
      for (const { id, question, options, isSecret, isOther } of input.questions) {
        if (isSecret || !id || id.length > 200 || !question.trim() || questions.some(existing => existing.id === id)) return emptyAnswers
        const choices = options?.slice(0, 32).map(option => option.label.trim()).filter(label => label && label.length <= 512)
        questions.push({ id, prompt: question.trim().slice(0, 4_000),
          ...(choices?.length && !isOther ? { choices: Array.from(new Set(choices), label => ({ value: label, label })) } : {}) })
      }
      const id = key(threadId, itemId)
      if (tools.questions.has(id)) return emptyAnswers
      const answer = yield* Deferred.make<ToolRequestUserInputResponse>()
      tools.questions.set(id, { nativeThreadId: threadId, turnId, questions, answer })
      return yield* Effect.sync(() => {
        active.context?.assertCurrent()
        active.notify({ type: 'runtime-request', nativeRequestId: itemId, turnId, request: {
          kind: 'user-input', title: '模型需要你补充信息', questions,
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
      const pending = this.questions.get(key(nativeThreadId, nativeRequestId))
      if (!pending || pending.turnId !== turnId || this.active(nativeThreadId)?.turnId !== turnId
        || response.kind !== 'user-input' || response.attachments?.contents.length) {
        return Effect.fail(new DaemonError('E_CONFLICT', '此回复不属于当前 Codex 原问题。'))
      }
      const answers = new Map<string, { answers: string[] }>()
      for (const { id, choices } of pending.questions) {
        const value = response.answers[id]
        const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
        if (!entries.length || entries.length > 32 || entries.some(entry => typeof entry !== 'string' || !entry.trim() ||
          entry.length > 4_000 || choices && !choices.some(choice => choice.value === entry))) {
          return Effect.fail(new DaemonError('E_INVALID_ARG', 'Codex 的原问题需要有效答复。'))
        }
        answers.set(id, { answers: entries })
      }
      if (answers.size !== Object.keys(response.answers).length) return Effect.fail(new DaemonError('E_INVALID_ARG', '答复含有未经请求的字段。'))
      return Deferred.succeed(pending.answer, { answers: Object.fromEntries(answers) }).pipe(Effect.flatMap(accepted => accepted
        ? Effect.void : Effect.fail(new DaemonError('E_CONFLICT', '此问题的原答复已完成。'))))
    })

  settle(threadId: string, turnId?: string): void {
    for (const pending of this.questions.values()) {
      if (pending.nativeThreadId === threadId && (!turnId || pending.turnId === turnId)) {
        Effect.runSync(Deferred.succeed(pending.answer, emptyAnswers))
      }
    }
  }
}
