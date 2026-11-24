import { useState, type JSX } from 'react'
import type { CruxTask, CruxTaskSharedMaterial } from '@shared/crux'
import { Button } from '../../../my/ui'
import { MarkdownView } from '../../../components/MarkdownView'
import { useCrux } from '../../store'
import { readTaskPostMaterial } from './task-post-documents'
import { useTaskSource, type TaskSourceOwner } from './use-task-source'

export function TaskHandoffProvenance({ task, source: parentSource }: {
  task: CruxTask
  source?: TaskSourceOwner
}): JSX.Element | null {
  const context = useCrux(state => state.workspaceContext)
  const ownSource = useTaskSource({ spaceId: task.spaceId, taskId: task.id, embedded: Boolean(parentSource) })
  const owner = parentSource ?? ownSource
  const [body, setBody] = useState<string | null>(null)
  const [openedMaterial, setOpenedMaterial] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (!task.handoff && !task.sharedMaterials?.length) return null
  const material = task.handoff?.material
  const open = async (sharedMaterial?: CruxTaskSharedMaterial): Promise<void> => {
    const selected = sharedMaterial ?? material
    if (!selected || busy || !owner.owns()) return
    const ticket = owner.ticket()
    setBusy(true); setError('')
    try {
      const text = await readTaskPostMaterial(task, context, selected)
      if (!owner.owns(ticket)) return
      setOpenedMaterial(sharedMaterial ? `${sharedMaterial.title} · ${sharedMaterial.versionLabel}` : `交接需求 · ${task.handoff?.versionLabel}`)
      setBody(text)
    } catch (cause) { if (owner.owns(ticket)) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (owner.owns(ticket)) setBusy(false) }
  }
  return <section className="flex flex-col gap-2" aria-label="交接来源">
    <div className="flex flex-wrap items-center gap-2">
      {material ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void open()}>交接需求 · {task.handoff?.versionLabel}</Button> :
        task.handoff?.versionLabel && <span className="text-my-sm text-my-secondary">{context.state === 'local' ? '首次正文' : '需求材料待补挂'} · {task.handoff.versionLabel}</span>}
      {task.sharedMaterials?.map(shared => <Button key={`${shared.documentId}:${shared.versionId}`} size="sm" variant="ghost" disabled={busy} onClick={() => void open(shared)}>{shared.title} · {shared.versionLabel}</Button>)}
    </div>
    {body !== null && <details open><summary className="cursor-pointer text-my-xs text-my-secondary">{openedMaterial} · 固定需求版本</summary><div className="mt-2 my-chat-prose"><MarkdownView content={body} /></div></details>}
    {error && <p role="alert" className="collab-inline-error">{error}</p>}
  </section>
}
