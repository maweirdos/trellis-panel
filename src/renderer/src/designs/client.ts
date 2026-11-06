import type { DesignWorkspaceApi, DesignCreateConversation } from '@shared/design-workspace'
import { api, hasIpc } from '../api'
import { conversationValue } from '../conversations/client'
import { readConversation, requestComposerFocus, selectConversation } from '../conversations/workspace'
import { useMy } from '../my/store'
import { useApp } from '../store'

export function designClient(): DesignWorkspaceApi | null {
  return hasIpc ? api.designWorkspace ?? null : null
}

export function requireDesignClient(): DesignWorkspaceApi {
  const client = designClient()
  if (!client) throw new Error('本机设计接口当前不可用，请在桌面应用中重试。')
  return client
}

export async function startDesignConversation(input: DesignCreateConversation): Promise<void> {
  const read = conversationValue(await requireDesignClient().createConversation(input))
  const key = selectConversation(read.conversation)
  useMy.getState().setShellView(read.conversation.kind === 'code' ? 'development' : 'collaboration')
  useApp.getState().setPage('chat')
  await readConversation(key)
  requestComposerFocus(key)
}

export function notifyDesignChanged(origin = 'workspace'): void { window.dispatchEvent(new CustomEvent('trellis-design-changed', { detail: { origin } })) }
