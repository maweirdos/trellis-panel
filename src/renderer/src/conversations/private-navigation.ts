import { useMy } from '../my/store'
import { useApp } from '../store'
import type { ConversationKind } from './workspace'

export function showPrivateConversation(kind: ConversationKind): void {
  const code = kind === 'code'
  useMy.getState().setChatWorkdirMode(code ? 'directory' : 'default')
  useApp.getState().setPage('chat', { privateCodeChat: code })
}
