import { useState, type JSX } from 'react'
import type { CruxTask, CruxTaskSharedMaterial } from '@shared/crux'
import { conversationClient, conversationValue } from '../../../conversations/client'
import { showPrivateConversation } from '../../../conversations/private-navigation'
import { selectConversation } from '../../../conversations/workspace'
import { Button } from '../../../my/ui'
import { MarkdownView } from '../../../components/MarkdownView'
import { useCrux } from '../../store'
import { readTaskPostMaterial } from './task-post-documents'
import { readTaskHandoffSource } from './task-handoff-source'
import { useTaskSource, type TaskSourceOwner } from './use-task-source'

export function TaskHandoffProvenance({ task, source: parentSource, onOpenConversation }: {
  task: CruxTask
  source?: TaskSourceOwner
  onOpenConversation?(conversationId: string): void
}): JSX.Element | null {
  const context = useCrux(state => state.workspaceContext)
  const ownSource = useTaskSource({ spaceId: task.spaceId, taskId: task.id, embedded: Boolean(parentSource) })
  const owner = parentSource ?? ownSource
  const [body, setBody] = useState<string | null>(null)
  const [openedMaterial, setOpenedMaterial] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const privateSource = readTaskHandoffSource(context, task)
  if (!task.handoff && !task.conversations?.length && !task.sharedMaterials?.length) return null
  const material = task.handoff?.material
  const open = async (kind: 'material' | 'conversation', boundId?: string, sharedMaterial?: CruxTaskSharedMaterial): Promise<void> => {
    if (busy || !owner.owns()) return
    const ticket = owner.ticket()
    setBusy(true); setError('')
    try {
      const selected = sharedMaterial ?? material
      if (kind === 'material' && selected) {
        const text = await readTaskPostMaterial(task, context, selected)
        if (!owner.owns(ticket)) return
        setOpenedMaterial(sharedMaterial ? `${sharedMaterial.title} · ${sharedMaterial.versionLabel}` : `交接需求 · ${task.handoff?.versionLabel}`)
        setBody(text)
      } else if (kind === 'conversation' && (boundId || privateSource)) {
        const client = conversationClient()
        if (!client) throw Error('请在桌面应用中打开原会话。')
        const conversationId = boundId ?? privateSource!.conversationId
        const read = conversationValue(await client.read(conversationId))
        if (!owner.owns(ticket)) return
        if (read.conversation.id !== conversationId || !boundId && read.conversation.creatorId !== privateSource?.creatorId) throw Error('原会话身份不匹配。')
        if (onOpenConversation) onOpenConversation(read.conversation.id)
        else {
          useCrux.getState().openTask(null)
          selectConversation(read.conversation)
          showPrivateConversation(read.conversation.kind)
        }
      }
    } catch (cause) { if (owner.owns(ticket)) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (owner.owns(ticket)) setBusy(false) }
  }
  return <section className="flex flex-col gap-2" aria-label="交接来源">
    <div className="flex flex-wrap items-center gap-2">
      {conversationClient() && !onOpenConversation && task.conversations?.filter(link => link.actorId === context.actorId && !link.id.startsWith('thr_')).map(link => <Button key={link.id} size="sm" variant="ghost" disabled={busy} onClick={() => void open('conversation', link.id)}>任务对话 · {link.title}</Button>)}
      {material ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void open('material')}>交接需求 · {task.handoff?.versionLabel}</Button> :
        task.handoff?.versionLabel && <span className="text-my-sm text-my-secondary">{context.state === 'local' ? '首次正文' : '需求材料待补挂'} · {task.handoff.versionLabel}</span>}
      {task.sharedMaterials?.map(shared => <Button key={`${shared.documentId}:${shared.versionId}`} size="sm" variant="ghost" disabled={busy} onClick={() => void open('material', undefined, shared)}>{shared.title} · {shared.versionLabel}</Button>)}
      {privateSource && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void open('conversation')}>回看原会话</Button>}
    </div>
    {body !== null && <details open><summary className="cursor-pointer text-my-xs text-my-secondary">{openedMaterial} · 固定需求版本</summary><div className="mt-2 my-chat-prose"><MarkdownView content={body} /></div></details>}
    {error && <p role="alert" className="collab-inline-error">{error}</p>}
  </section>
}
