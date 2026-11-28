import { useEffect, useState, type JSX } from 'react'
import type { DesignDocument } from '@shared/design-workspace'
import type { TimelineEvent } from '@shared/types'
import { conversationClient, conversationError, conversationValue } from '../conversations/client'
import { Button, Modal } from '../my/ui'
import { requireDesignClient } from './client'

export function DesignSourceDialog({ document, onClose }: { document: DesignDocument; onClose(): void }): JSX.Element {
  const [messages, setMessages] = useState<TimelineEvent[]>()
  const [issue, setIssue] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    setMessages(undefined); setIssue('')
    async function read(): Promise<void> {
      try {
        const design = conversationValue(await requireDesignClient().get({ documentId: document.id }))
        if (cancelled) return
        if (design.id !== document.id || design.conversationId !== document.conversationId || design.sourceError) {
          throw Error(design.sourceError || '无法核对原设计会话。')
        }
        const client = conversationClient()
        if (!client) throw Error('原设计会话读取端口不可用。')
        const source = conversationValue(await client.read(design.conversationId))
        if (cancelled) return
        if (source.conversation.id !== design.conversationId || !source.conversation.nativeRef) throw Error('原设计会话不可用。')
        const page = conversationValue(await client.events(design.conversationId, { limit: 80 }))
        if (cancelled) return
        setMessages((page?.events ?? []).filter(event => event.sessionId === source.conversation.nativeRef?.sessionId &&
          event.kind === 'message' && (event.payload?.role === 'user' || event.payload?.role === 'assistant') && event.text))
      } catch (cause) { if (!cancelled) setIssue(conversationError(cause)) }
    }
    void read()
    return () => { cancelled = true }
  }, [document.id, document.conversationId, revision])
  return <Modal open width={680} placement="center" ariaLabel="设计来源会话" onClose={onClose}>
    <section className="flex max-h-[70vh] min-h-0 flex-col gap-3 p-4">
      <h2 className="my-item-title">设计来源会话</h2>
      <p className="my-item-description">{document.title}</p>
      {issue ? <p role="alert" className="my-item-description">{issue}</p>
        : !messages ? <p role="status" className="my-item-description">正在核对原会话…</p>
          : !messages.length ? <p className="my-item-description">原会话当前没有可展示的消息。</p>
            : <ol aria-label="原设计会话近期消息" className="my-scrollbar min-h-0 space-y-3 overflow-auto">
              {messages.map(message => <li key={message.id}>
                <p className="my-item-title">{message.payload?.role === 'user' ? '你' : '设计助手'}</p>
                <p className="whitespace-pre-wrap break-words text-my-sm text-my-secondary">{message.text}</p>
              </li>)}
            </ol>}
      <div className="flex justify-end gap-2">
        {issue && <Button size="sm" variant="ghost" onClick={() => setRevision(value => value + 1)}>重新核对</Button>}
        <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
      </div>
    </section>
  </Modal>
}
