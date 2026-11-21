import { useEffect, useRef, useState, type JSX } from 'react'
import type { Editor } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { X } from 'lucide-react'
import type { CruxTask } from '@shared/crux'
import { MarkdownView } from '../../../components/MarkdownView'
import { Button, Modal } from '../../../my/ui'
import { useInteractionGuard } from '../../../utils/interaction-scope'
import { useCrux } from '../../store'
import { readTaskHandoffSource } from './task-handoff-source'
import { canReadTaskSpace, taskActorId } from './use-task-source'
import { resolvePostDocuments, taskDraftReferences, type PostDocument } from './task-post-documents'

const documentLinks = new PluginKey<DecorationSet>('taskPostDocuments')
type Preview = { entry: PostDocument; text?: string; error?: string }

function decorate(doc: Node, targets: Map<string, PostDocument> | undefined, open: (entry: PostDocument) => void) {
  const decorations: Decoration[] = []
  doc.descendants((node, position) => {
    if (node.type.spec.code) return false
    if (!node.text || node.marks.some(mark => mark.type.name === 'link')) return
    for (const { path, offset } of taskDraftReferences(node.text)) {
      const target = targets?.get(path)
      const start = position + offset
      decorations.push(Decoration.inline(start, start + path.length, { class: 'task-post-path-source', 'aria-hidden': 'true' }))
      decorations.push(Decoration.widget(start, () => {
        const label = document.createElement(target ? 'button' : 'span')
        label.className = 'task-post-path-label'
        label.contentEditable = 'false'
        label.textContent = target?.title ?? (targets ? '需求初稿（不可用）' : '需求初稿')
        label.title = target ? `${target.source}\n${path}` : targets ? `未找到当前可读的版本\n${path}` : path
        if (label instanceof HTMLButtonElement && target) {
          label.type = 'button'
          label.onclick = () => open(target)
        }
        return label
      }, { side: -1, stopEvent: () => true, ignoreSelection: true }))
    }
  })
  return DecorationSet.create(doc, decorations)
}

export function TaskPostDocumentLinks({ editor, task, body }: { editor: Editor | null; task: CruxTask; body: string }): JSX.Element | null {
  const context = useCrux(state => state.workspaceContext)
  const canInteract = useInteractionGuard()
  const [preview, setPreview] = useState<Preview | null>(null)
  const serial = useRef(0)
  const latest = useRef({ task, context })
  latest.current = { task, context }
  const actor = useCrux(state => taskActorId(state.snapshot, state.workspaceContext))
  const ownIds = new Set(task.conversations?.filter(link => link.actorId === actor).map(link => link.id))
  const origin = readTaskHandoffSource(context, task)
  if (origin) ownIds.add(origin.conversationId)
  const conversations = JSON.stringify([...ownIds])
  // Snapshot refreshes may rebuild every object while someone is reading. Only
  // changes to the authority or the actual source/version invalidate a preview.
  const sources = JSON.stringify([context.key, context.state, context.epoch, context.instanceId, actor, task.id, task.spaceId, task.createdAt,
    task.sharedMaterials?.map(item => [item.sourceDraftId, item.documentId, item.versionId, item.bodyDigest, item.title]),
    task.handoff?.sourceDraftId, task.handoff?.material])
  const paths = JSON.stringify([...new Set(taskDraftReferences(body).map(ref => ref.path))])
  useEffect(() => {
    if (!editor || editor.isDestroyed || paths === '[]') return
    const { task, context } = latest.current
    let live = true
    const current = () => {
      const state = useCrux.getState()
      return Boolean(live && canInteract() && state.snapshot && state.workspaceContext.key === context.key &&
        state.workspaceContext.instanceId === context.instanceId && state.workspaceContext.epoch === context.epoch &&
        state.workspaceContext.state === context.state &&
        taskActorId(state.snapshot, state.workspaceContext) === actor && canReadTaskSpace(state.snapshot, state.workspaceContext, task.spaceId) &&
        state.snapshot.tasks.some(item => item.id === task.id && item.spaceId === task.spaceId && item.createdAt === task.createdAt))
    }
    let targets: Map<string, PostDocument> | undefined
    const open = async (entry: PostDocument) => {
      if (!current()) return
      const request = ++serial.current
      setPreview({ entry })
      try {
        const text = await entry.read()
        if (current() && serial.current === request) setPreview({ entry, text })
      } catch (cause) {
        if (current() && serial.current === request) setPreview({ entry, error: cause instanceof Error ? cause.message : '文档读取失败。' })
      }
    }
    editor.registerPlugin(new Plugin<DecorationSet>({
      key: documentLinks,
      state: {
        init: (_, state) => decorate(state.doc, targets, open),
        apply: (tr, previous) => tr.docChanged || tr.getMeta(documentLinks) ? decorate(tr.doc, targets, open) : previous
      },
      props: { decorations: state => documentLinks.getState(state) }
    }))
    void resolvePostDocuments(JSON.parse(paths), task, context, JSON.parse(conversations), current).then(result => {
      if (current() && !editor.isDestroyed) {
        targets = result
        editor.view.dispatch(editor.state.tr.setMeta(documentLinks, true))
      }
    }).catch(() => { /* Unresolved references keep their unavailable label. */ })
    return () => {
      live = false
      serial.current++
      setPreview(null)
      if (!editor.isDestroyed) editor.unregisterPlugin(documentLinks)
    }
  }, [editor, sources, actor, conversations, paths, canInteract])
  if (!preview) return null
  const close = () => { serial.current++; setPreview(null) }
  return <Modal open ariaLabel={preview.entry.title} onClose={close} width={760}>
    <section className="flex max-h-[var(--my-modal-max-height)] flex-col">
    <header className="flex shrink-0 items-center gap-2 border-b border-my-line px-4 py-2">
      <h2 className="min-w-0 flex-1 break-words text-my-title font-semibold">{preview.entry.title}</h2>
      <span className="text-my-xs text-my-secondary">{preview.entry.source}</span>
      <Button size="sm" variant="ghost" aria-label="关闭文档" onClick={close}><X size={16} /></Button>
    </header>
    <div className="my-scrollbar my-chat-prose min-h-0 overflow-y-auto p-4">
      {preview.error ? <p role="alert">{preview.error}</p> : preview.text === undefined ? <p role="status">读取中…</p> :
        <MarkdownView content={preview.text} onOpenDocumentLink={async () => { throw Error('请在原会话中打开此文档的本机引用。') }} />}
    </div>
    </section>
  </Modal>
}
