import { useEffect, useRef, useState, type JSX } from 'react'
import { z } from 'zod'
import { designSendSchema, type DesignSelection, type DesignTurnStatus } from '@shared/design-workspace'
import { conversationError, conversationValue } from '../conversations/client'
import { useCrux } from '../crux/store'
import { Button, Modal } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import { designClient, notifyDesignChanged, requireDesignClient } from './client'
import { openDesign } from './navigation'

export type DesignMedium = 'web' | 'app' | 'prototype'
export interface DesignTurnTarget {
  conversationId: string
  documentId: string
  revision: string
  title: string
  selection?: DesignSelection
  validate?: () => Promise<boolean>
}

const draftSchema = z.object({
  text: z.string().max(16_000),
  conversationId: z.string().uuid().optional(),
  request: designSendSchema.optional(),
  turnId: z.string().min(1).max(200).optional(),
})
type Draft = z.infer<typeof draftSchema>
const volatileDrafts = new Map<string, Draft>()

function identity() {
  const { key, actorId, instanceId, epoch } = useCrux.getState().workspaceContext
  return JSON.stringify([key, actorId, instanceId, epoch])
}

function readDraft(key: string): Draft {
  const memory = volatileDrafts.get(key)
  if (memory) return memory
  try {
    const result = draftSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'))
    if (result.success) return result.data
  } catch {}
  return { text: '' }
}

type Props = { onClose(): void } & ({ medium: DesignMedium; target?: never } | { target: DesignTurnTarget; medium?: never })

export function DesignTurnDialog(props: Props): JSX.Element {
  const owner = useCrux(() => identity())
  const target = props.target
  const key = `crux.design.draft:${JSON.stringify([owner, target?.documentId ?? props.medium])}`
  return <DesignTurnForm key={key} owner={owner} draftKey={key} {...props} />
}

function DesignTurnForm({ owner, draftKey, medium, target, onClose }: Props & { owner: string; draftKey: string }): JSX.Element {
  const title = target ? '让助手修改设计' : '新建设计'
  const [draft, setDraft] = useState(() => readDraft(draftKey))
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState('')
  const [observed, setObserved] = useState<DesignTurnStatus>()
  const [checkRevision, setCheckRevision] = useState(0)
  const lock = useRef(false)
  const mounted = useRef(false)
  const canInteract = useInteractionGuard()
  const current = (): boolean => mounted.current && canInteract() && identity() === owner
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  function save(next: Draft): void {
    if (!current()) return
    volatileDrafts.set(draftKey, next)
    try { localStorage.setItem(draftKey, JSON.stringify(next)) } catch {}
    setDraft(next)
  }

  async function send(): Promise<void> {
    if (!current() || lock.current || (!draft.request && !draft.text.trim())) return
    lock.current = true
    setBusy(true); setIssue('')
    try {
      const client = requireDesignClient()
      let conversationId = draft.conversationId ?? target?.conversationId
      if (!conversationId) {
        const created = conversationValue(await client.createConversation({ kind: medium, text: draft.text }))
        if (!current()) return
        conversationId = created.conversation.id
        save({ ...draft, conversationId })
      }
      if (!draft.request && target?.validate && !await target.validate()) {
        if (current()) setIssue('原选区已变化。输入已保留，请重新选择元素。')
        return
      }
      if (!current()) return
      const next = { requestId: crypto.randomUUID(), text: draft.text.trim() }
      const request = draft.request ?? (target
        ? { ...next, documentId: target.documentId, expectedRevision: target.revision, ...(target.selection && { selection: target.selection }) }
        : { ...next, conversationId })
      save({ text: draft.text, conversationId, request })
      const result = await client.send(request)
      if (!current()) return
      if (!result.ok) {
        if (result.requestId === request.requestId && result.notSent && !result.outcomeUnknown) save({ text: draft.text, conversationId })
        setIssue(result.error)
        return
      }
      const receipt = result.value
      if (receipt.requestId !== request.requestId || receipt.conversationId !== conversationId || !receipt.turnId) {
        setIssue('回执与原设计请求不匹配，请核对原请求。')
        return
      }
      setObserved(undefined)
      save({ text: draft.text, conversationId, request, turnId: receipt.turnId })
    } catch (cause) {
      if (current()) setIssue(conversationError(cause))
    } finally {
      lock.current = false
      if (current()) setBusy(false)
    }
  }

  const { conversationId, turnId } = draft
  const requestId = draft.request?.requestId

  async function respond(permissionRequestId: string, optionId: string): Promise<void> {
    if (!current() || lock.current || !conversationId || !requestId || !turnId) return
    lock.current = true
    setBusy(true); setIssue('')
    try {
      conversationValue(await requireDesignClient().respond({ conversationId, requestId, turnId, permissionRequestId, optionId }))
      if (current()) setObserved(undefined)
    } catch (cause) {
      if (current()) setIssue(conversationError(cause))
    } finally {
      lock.current = false
      if (current()) { setBusy(false); setCheckRevision(value => value + 1) }
    }
  }

  useEffect(() => {
    if (!conversationId || !requestId || !turnId) return
    const source = designClient()
    if (!source) {
      setIssue('专用设计端口当前不可用，原请求已保留。')
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let attempts = 0
    const check = async (): Promise<void> => {
      if (cancelled || !current()) return
      try {
        const status = conversationValue(await source.status({ conversationId, requestId, turnId }))
        if (cancelled || !current()) return
        setObserved({ permissions: status.permissions })
        if (status.permissions.length) {
          attempts = 0
          timer = setTimeout(() => void check(), 1_000)
          return
        }
        const documents = conversationValue(await source.sync({ conversationId, turnId }))
        if (cancelled || !current()) return
        const document = documents.find(item => item.conversationId === conversationId && (!target || target.documentId === item.id))
        if (document) {
          save({ text: '' })
          notifyDesignChanged()
          onClose()
          openDesign(document.id, target ? document.candidates.at(-1)?.id : undefined)
          return
        }
        if (status.terminal) {
          setObserved(status)
          setIssue(status.terminal === 'failed' ? '原设计回合失败，输入已保留。'
            : status.terminal === 'cancelled' ? '原设计回合已取消，输入已保留。' : '原回合已结束，未生成设计。')
          return
        }
        if (++attempts < 40) timer = setTimeout(() => void check(), 1_500)
        else setIssue('暂未读取到这次生成的设计，可稍后重新打开查看。')
      } catch (cause) {
        if (!cancelled && current()) { setObserved(undefined); setIssue(conversationError(cause)) }
      }
    }
    void check()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [conversationId, requestId, turnId, checkRevision])

  return <Modal open width={520} placement="center" onClose={() => { if (!lock.current) onClose() }} ariaLabel={title}>
    <form className="space-y-3 p-4" onSubmit={event => { event.preventDefault(); void send() }}>
      <h2 className="my-item-title">{title}</h2>
      {target && <p className="my-item-description break-words">{target.title}{target.selection ? ` · ${target.selection.text || target.selection.selector}` : ''}</p>}
      <textarea className="my-input min-h-28 w-full" aria-label="设计要求" autoFocus maxLength={16_000}
        value={draft.text} disabled={busy || Boolean(draft.request)}
        onChange={event => save({ ...draft, text: event.target.value })} />
      {turnId && !issue && !observed?.permissions.length && <p role="status" className="my-item-description">已受理，正在读取本次生成的设计…</p>}
      {observed?.permissions.map(permission => <section key={permission.requestId} className="space-y-2" aria-label="设计操作授权">
        <p className="my-item-title">等待授权</p>
        <p className="my-item-description max-h-32 overflow-auto whitespace-pre-wrap break-words">{permission.toolCall?.title ?? '设计回合请求工具权限'}</p>
        <div className="flex flex-wrap gap-2">
          {permission.options.map(option => <Button key={option.optionId} type="button" size="sm" variant="outline"
            disabled={busy} onClick={() => void respond(permission.requestId, option.optionId)}>{option.name}</Button>)}
        </div>
      </section>)}
      {issue && <p role="alert" className="my-item-description">{issue}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>关闭</Button>
        {turnId && issue && <Button type="button" size="sm" onClick={() => { setIssue(''); setCheckRevision(value => value + 1) }}>核对原输出</Button>}
        {observed?.terminal && <Button type="button" size="sm" onClick={() => {
          setObserved(undefined); setIssue(''); save({ text: draft.text, conversationId })
        }}>继续编辑输入</Button>}
        {!turnId && <Button type="submit" size="sm" variant="primary" disabled={busy || !draft.text.trim()}>
          {busy ? '正在核对…' : draft.request ? '核对原请求' : '发送设计要求'}
        </Button>}
      </div>
    </form>
  </Modal>
}
