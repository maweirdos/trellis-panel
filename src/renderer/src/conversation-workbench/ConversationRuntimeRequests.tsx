import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { Paperclip, ShieldAlert, X } from 'lucide-react'
import type { StagedConversationAttachment } from '../../../shared/conversation/attachments'
import type { ConversationRuntimeRequest } from '../../../shared/conversation/command-runtime'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import { api } from '../api'
import { Button } from '../my/ui'
import type { ConversationApplyResult, ConversationThreadController } from './useConversationThread'

export interface ConversationRuntimeRequestsProps {
  readonly controller: ConversationThreadController
  readonly requests: readonly ConversationRuntimeRequest[]
  readonly disabled: boolean
  readonly cwd: string
  readonly threadId: string
  readonly task?: ConversationTaskLocator
  readonly onCommandResult?: (result: ConversationApplyResult) => void
}

type CommandFailure = Extract<ConversationApplyResult, { ok: false }>

/**
 * The daemon rejects any decision the original request did not offer, so only
 * `payload.options` is rendered. A request without options has no answer here.
 */
const PRIMARY_DECISIONS: readonly string[] = ['decline', 'accept']

export function ConversationRuntimeRequests(props: ConversationRuntimeRequestsProps): JSX.Element {
  return <ScopedRuntimeRequests key={props.controller.scope} {...props} />
}

function ScopedRuntimeRequests({
  controller,
  requests,
  disabled,
  cwd,
  threadId,
  task,
  onCommandResult,
}: ConversationRuntimeRequestsProps): JSX.Element | null {
  const [responding, setResponding] = useState<ReadonlySet<string>>(new Set())
  const [failures, setFailures] = useState<ReadonlyMap<string, CommandFailure>>(new Map())
  const inFlight = useRef(new Set<string>())
  const alive = useRef(true)
  const headingId = useId()
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function execute(
    key: string,
    invoke: () => Promise<ConversationApplyResult>,
  ): Promise<void> {
    if (disabled || inFlight.current.has(key)) return
    inFlight.current.add(key)
    setResponding((current) => new Set(current).add(key))
    try {
      const result = await invoke()
      if (!alive.current) return
      onCommandResult?.(result)
      setFailures((current) => {
        const next = new Map(current)
        if (result.ok) next.delete(key)
        else next.set(key, result)
        return next
      })
    } finally {
      inFlight.current.delete(key)
      if (alive.current) {
        setResponding((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    }
  }

  const pending = requests.filter((request) => request.status === 'pending')
  const active = pending[0]
  const activeKey = active ? requestKey(active) : undefined
  const failuresToShow = [...failures].filter(([key, failure]) => key === activeKey || failure.uncertain)
  if (!active && failuresToShow.length === 0) return null

  function respond(request: ConversationRuntimeRequest, response: Parameters<ConversationThreadController['respond']>[1]): Promise<void> {
    const key = requestKey(request)
    if (failures.get(key)?.uncertain) return Promise.resolve()
    return execute(key, () => controller.respond(request, response))
  }

  const responseDisabled = disabled || (activeKey !== undefined &&
    (responding.has(activeKey) || failures.get(activeKey)?.uncertain === true))

  return (
    <section className="conversation-request" aria-labelledby={headingId}>
      <h2 id={headingId} className="my-item-title">
        <ShieldAlert size={14} aria-hidden="true" />
        {active?.payload.kind === 'approval' ? '等待你的批准'
          : active ? '模型需要你的回答' : '请求结果待核对'}
      </h2>
      {pending.length > 1 && (
        <p className="my-item-description conversation-request-count">还有 {pending.length - 1} 个请求</p>
      )}
      {active && (active.payload.kind === 'approval' ? (
        <ApprovalRequest request={active} disabled={responseDisabled} onRespond={respond} />
      ) : (
        <UserInputRequest key={activeKey} request={active} disabled={responseDisabled} onRespond={respond}
          cwd={cwd} threadId={threadId} task={task} />
      ))}
      {failuresToShow.map(([key, failure]) => (
        <div key={key} className="conversation-request-actions">
          <p className="conversation-request-failure" role="status">
            {failure.uncertain ? '提交结果待核对。' : failure.reason}
          </p>
          {failure.uncertain && (
            <Button size="sm" variant="ghost" disabled={disabled || responding.has(key)}
              onClick={() => void execute(key, () => controller.checkCommand(failure.commandId))}>
              {responding.has(key) ? '正在查询…' : '查询原回复回执'}
            </Button>
          )}
        </div>
      ))}
    </section>
  )
}

function requestKey(request: ConversationRuntimeRequest): string {
  return JSON.stringify([request.requestId, request.generation])
}

function ApprovalRequest({
  request,
  disabled,
  onRespond,
}: {
  readonly request: ConversationRuntimeRequest
  readonly disabled: boolean
  readonly onRespond: (
    request: ConversationRuntimeRequest,
    response: Parameters<ConversationThreadController['respond']>[1],
  ) => Promise<void>
}): JSX.Element {
  const payload = request.payload
  if (payload.kind !== 'approval') return <></>
  const options = payload.options
  const primary = options.filter((option) => (PRIMARY_DECISIONS as readonly string[]).includes(option.decision))
  const more = options.filter((option) => !(PRIMARY_DECISIONS as readonly string[]).includes(option.decision))
  return (
    <div className="conversation-request-body" role="group" aria-label={payload.title}>
      {payload.title && <p className="conversation-request-title">{payload.title}</p>}
      {payload.details && <pre className="conversation-request-detail my-scrollbar">{payload.details}</pre>}
      <div className="conversation-request-actions">
        {primary.map((option) => (
          <Button
            key={option.decision}
            size="sm"
            variant={option.decision === 'accept' ? 'primary' : 'outline'}
            disabled={disabled}
            onClick={() => void onRespond(request, { decision: option.decision })}
          >
            {option.label}
          </Button>
        ))}
        {more.map((option) => (
          <Button
            key={option.decision}
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => void onRespond(request, { decision: option.decision })}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function UserInputRequest({
  request,
  disabled,
  onRespond,
  cwd,
  threadId,
  task,
}: {
  readonly request: ConversationRuntimeRequest
  readonly disabled: boolean
  readonly cwd: string
  readonly threadId: string
  readonly task?: ConversationTaskLocator
  readonly onRespond: (
    request: ConversationRuntimeRequest,
    response: Parameters<ConversationThreadController['respond']>[1],
  ) => Promise<void>
}): JSX.Element {
  const payload = request.payload
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [position, setPosition] = useState(0)
  const formId = useId()
  const [filesByQuestion, setFilesByQuestion] = useState<ReadonlyMap<string, readonly StagedConversationAttachment[]>>(new Map())
  const [attachmentError, setAttachmentError] = useState('')
  const [loadingFiles, setLoadingFiles] = useState(false)
  const editingFiles = useRef(false)
  const [busyFiles, setBusyFiles] = useState(false)
  const targets = useMemo(() => payload.kind === 'user-input'
    ? new Map(payload.questions.flatMap((question, index) => question.acceptsTextAttachments && !question.choices?.length
      ? [[question.id, { cwd, threadId, requestId: request.requestId, generation: request.generation,
        draftId: `${request.requestId}.${request.generation}.${index}`, ...(task && { task }) }] as const]
      : []))
    : new Map(), [cwd, payload, request.generation, request.requestId, task, threadId])

  useEffect(() => {
    if (!targets.size) return
    let current = true
    setLoadingFiles(true)
    void Promise.all([...targets].map(async ([id, target]) => {
      const result = await api.conversationAttachmentList(target)
      if (!result.ok) throw new Error(result.error)
      return [id, result.attachments] as const
    })).then(entries => { if (current) setFilesByQuestion(new Map(entries)) })
      .catch(error => { if (current) setAttachmentError(error instanceof Error ? error.message : '无法读取提问附件。') })
      .finally(() => { if (current) setLoadingFiles(false) })
    return () => { current = false }
  }, [targets])

  async function editFiles(questionId: string, attachmentId?: string): Promise<void> {
    const target = targets.get(questionId)
    if (!target || disabled || editingFiles.current || loadingFiles) return
    editingFiles.current = true
    setBusyFiles(true)
    setAttachmentError('')
    try {
      if (attachmentId) {
        const result = await api.conversationAttachmentRelease({ ...target, attachmentId })
        if (!result.ok) throw new Error(result.error)
        setFilesByQuestion(current => new Map(current)
          .set(questionId, (current.get(questionId) ?? []).filter(file => file.id !== attachmentId)))
      } else {
        const result = await api.conversationAttachmentPick(target)
        if (!result.ok) throw new Error(result.error)
        setFilesByQuestion(current => new Map(current)
          .set(questionId, [...(current.get(questionId) ?? []), ...result.attachments]))
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '无法准备提问附件。')
    } finally {
      editingFiles.current = false
      setBusyFiles(false)
    }
  }

  if (payload.kind !== 'user-input') return <></>
  const question = payload.questions[position]
  if (!question) return <></>
  const files = filesByQuestion.get(question.id) ?? []
  const attachmentQuestion = [...filesByQuestion].find(([, items]) => items.length > 0)
  const attachmentTarget = attachmentQuestion && targets.get(attachmentQuestion[0])
  const attachmentsAvailable = targets.has(question.id)
  const attachmentInOtherQuestion = attachmentQuestion && attachmentQuestion[0] !== question.id
  const selected = answers[question.id]
  const canAdvance = position < payload.questions.length - 1
  const answered = Array.isArray(selected) ? selected.length > 0 : Boolean(selected?.trim())
  const submit = (): void => {
    if (!answered || loadingFiles || editingFiles.current) return
    if (canAdvance) setPosition((value) => value + 1)
    else void onRespond(request, {
      answers,
      ...(attachmentTarget && attachmentQuestion && {
        draftId: attachmentTarget.draftId, attachmentQuestionId: attachmentQuestion[0],
        attachmentIds: attachmentQuestion[1].map(file => file.id),
      }),
    })
  }
  const choose = (value: string): void => {
    setAnswers((current) => ({ ...current, [question.id]: value }))
  }
  return (
    <div className="conversation-request-body" role="group" aria-label={payload.title}>
      {payload.title && <p className="conversation-request-title">{payload.title}</p>}
      <fieldset className="conversation-request-question" disabled={disabled}>
        <legend className="my-item-title">
          {question.prompt}
          <span className="my-item-description conversation-request-progress">
            {position + 1} / {payload.questions.length}
          </span>
        </legend>
        {question.choices && question.choices.length > 0 ? (
          <div className="conversation-request-choices" id={`${formId}-choices`}>
            {question.choices.map((choice) => {
              const activeChoice = selected === choice.value || (Array.isArray(selected) && selected.includes(choice.value))
              return (
                <button
                  key={choice.value}
                  type="button"
                  className="conversation-request-choice"
                  aria-pressed={activeChoice}
                  onClick={() => choose(choice.value)}
                >
                  {choice.label}
                </button>
              )
            })}
          </div>
        ) : (
          <textarea
            className="my-scrollbar conversation-request-answer"
            rows={3}
            value={Array.isArray(selected) ? selected.join('\n') : selected ?? ''}
            placeholder="输入回答…"
            aria-label={question.prompt}
            onChange={(event) => choose(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submit()
              }
            }}
          />
        )}
      </fieldset>
      {attachmentsAvailable && <div className="acp-source-references">
        {files.map(file => <div className="acp-source-chip" key={file.id}>
          <span title={file.name}>{file.name}</span>
          <button type="button" className="my-icon-control" aria-label={`移除提问附件 ${file.name}`}
            disabled={disabled || loadingFiles || busyFiles} onClick={() => void editFiles(question.id, file.id)}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>)}
        <button type="button" className="my-icon-control" title="添加回答附件" aria-label="添加回答附件"
          disabled={disabled || loadingFiles || busyFiles || Boolean(attachmentInOtherQuestion)}
          onClick={() => void editFiles(question.id)}><Paperclip size={14} aria-hidden="true" /></button>
      </div>}
      {attachmentError && <p className="conversation-request-failure" role="alert">{attachmentError}</p>}
      <div className="conversation-request-actions">
        {position > 0 && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setPosition((value) => value - 1)}>
            上一步
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={disabled || !answered || loadingFiles || busyFiles} onClick={submit}>
          {canAdvance ? '下一步' : '提交回答'}
        </Button>
      </div>
    </div>
  )
}
