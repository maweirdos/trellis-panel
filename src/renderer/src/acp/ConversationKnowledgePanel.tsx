import type { JSX } from 'react'
import { X } from 'lucide-react'
import { Button, Modal } from '../my/ui'
import { KnowledgeScopeControl } from '../knowledge/KnowledgeScopeControl'
import { ConversationKnowledge } from '../knowledge/ConversationKnowledge'
import { projectRootKey } from '../my/navigation'
import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { currentKnowledgeObservation, knowledgeObservation, knowledgeObservationLabel } from './conversation-convenience'

export function ConversationKnowledgePanel({ root, session, events, onClose }: {
  root: string
  session: AcpSessionRecord
  events: TimelineEvent[]
  onClose: () => void
}): JSX.Element {
  const current = currentKnowledgeObservation(events, session)
  const observations = events.filter((event) => event.sessionId === session.sessionId && projectRootKey(event.projectRoot) === projectRootKey(root) && knowledgeObservation(event))
  const connected = ['ready', 'busy', 'awaiting_permission', 'cancelling'].includes(session.status)
  return <Modal open onClose={onClose} width={760} ariaLabel="项目知识与来源">
    <header className="flex items-center gap-3 border-b border-my-line px-4 py-3"><h2 className="min-w-0 flex-1 text-my-md font-semibold">项目知识与来源</h2><Button size="sm" variant="ghost" aria-label="关闭知识与来源" onClick={onClose}><X size={16} /></Button></header>
    <div className="my-scrollbar max-h-[70vh] space-y-4 overflow-y-auto p-4">
        <KnowledgeScopeControl root={root} sessionId={session.sessionId} busy={['busy', 'awaiting_permission', 'cancelling'].includes(session.status)} />
        <details className="rounded-my-md border border-my-line px-3 py-2 text-my-xs text-my-secondary"><summary className="cursor-pointer">{current ? `${connected ? '' : '上次连接记录：'}${knowledgeObservationLabel(current)}` : '尚未收到本次连接的知识工具状态'}</summary><p className="mt-2 text-my-tertiary">工具连接与实际检索是分别记录的；参考资料展示实际返回的来源。</p><div className="mt-2 space-y-2">{observations.slice(-20).map((event) => {
          const observation = knowledgeObservation(event)
          if (!observation) return null
          return <div key={event.id} className="rounded-my-sm bg-my-layer-1 p-2"><p>{event.connectionGeneration && event.connectionGeneration === session.connectionGeneration ? '本次连接' : '历史记录'} · {knowledgeObservationLabel(observation)}</p><pre className="mt-1 whitespace-pre-wrap break-words text-my-tertiary">{observation.detail || event.text}</pre></div>
        })}</div></details>
      <ConversationKnowledge root={root} sessionId={session.sessionId} refreshKey={`${session.status}:${session.turnId || ''}:${current?.operationId || ''}`} />
    </div>
  </Modal>
}
