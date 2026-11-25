import { useImperativeHandle, useRef, useState, type JSX, type RefObject } from 'react'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { Button } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import type { OpenAssistantCitation } from './AssistantCitationChip'
import { insertAssistantCitationIntoDraft, type CitationDraftHandle } from './assistantCitationDraft'
import type { ComposerPromptEditorHandle } from './ComposerPromptEditorTiptap'
import { ConversationComposer } from './ConversationComposer'
import { useComposerSend } from './useComposerSend'
import type { ConversationModelCatalog } from './useConversationModelCatalog'
import { isActiveRun, type ConversationApplyResult, type ConversationThreadController } from './useConversationThread'

export function sideThreadDraftScope(scopeKey: string, root: string, hostThreadId: string): string {
  return JSON.stringify([scopeKey, root, hostThreadId])
}

export function ConversationSideThreadComposer({ root, task, scopeKey, threadId, controller, catalog, writable, citationDraftRef, onOpenCitation }: {
  root: string; task?: ConversationTaskLocator; scopeKey: string; threadId: string
  controller: ConversationThreadController; catalog: ConversationModelCatalog; writable: boolean
  citationDraftRef?: RefObject<CitationDraftHandle | null>
  onOpenCitation?: OpenAssistantCitation
}): JSX.Element {
  const projection = controller.active?.projection
  const activeRun = projection?.activeRun
  const running = Boolean(activeRun && isActiveRun(activeRun))
  const selection = projection?.thread.modelSelection
  const instance = catalog.instances.find(item => item.instanceId === selection?.instanceId)
  const descriptor = instance?.read?.status === 'ready' ? instance.read.descriptor : undefined
  const canSteer = Boolean(running && descriptor?.actions.steer.state === 'verified')
  const send = useComposerSend({ root, task, scopeKey, threadId, running, canSteer, interactive: writable,
    onAccepted: () => controller.reload() })
  const editorRef = useRef<ComposerPromptEditorHandle>(null)
  const canInteract = useInteractionGuard()
  useImperativeHandle(citationDraftRef, () => ({
    insert: citation => {
      if (writable && citation.threadId === threadId) insertAssistantCitationIntoDraft(citation, send, editorRef, canInteract)
    },
  }))
  const selected = send.model ?? (selection ? {
    instanceId: selection.instanceId, id: selection.model, options: selection.options,
    displayName: catalog.models.find(model => model.instanceId === selection.instanceId && model.id === selection.model)?.displayName
      ?? selection.model,
  } : null)
  const [issue, setIssue] = useState<Extract<ConversationApplyResult, { ok: false }>>()
  const settle = (result: ConversationApplyResult): void => setIssue(result.ok ? undefined : result)
  return <>
    {issue && <FeedbackNotice variant="inline" tone={issue.uncertain ? 'warning' : 'error'}
      title={issue.uncertain ? '侧聊操作结果待核对' : '侧聊操作未完成'} description={issue.reason}
      actions={issue.uncertain && <Button size="sm" variant="ghost" disabled={controller.pendingCommands.has(issue.commandId)}
        onClick={() => void controller.checkCommand(issue.commandId).then(settle)}>查询回执</Button>} />}
    <ConversationComposer interactive={writable} root={root} send={send} catalog={catalog} model={selected}
      editorRef={editorRef} onOpenCitation={onOpenCitation}
      onModelChange={send.setModel} lockedInstanceId={selection?.instanceId} running={running}
      canStop={running && descriptor?.actions.cancel.state !== 'unsupported' && !issue?.uncertain}
      onStop={() => { if (activeRun) void controller.stop(activeRun.id).then(settle) }}
      queuePaused={Boolean(projection?.queuePaused)} canSteer={canSteer && activeRun?.modelSelection.model === selected?.id} />
  </>
}
