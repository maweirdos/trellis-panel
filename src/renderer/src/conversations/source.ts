import { useMemo, useRef } from 'react'
import { localDocumentLink } from '@shared/local-document-link'
import type { DocumentSourceClient } from '../reader/document-source'
import { projectRootKey } from '../my/navigation'
import { useMy } from '../my/store'
import { useInteractionGuard } from '../utils/interaction-scope'
import { conversationClient, conversationValue } from './client'
import { baseScopeKey, scopeKey, useConversations } from './workspace'

export function isPrivateEntrySelected(entryKey: string): boolean {
  const state = useConversations.getState(), value = state.entries[entryKey]
  const kind = useMy.getState().shellView === 'development' ? 'code' : 'work'
  return Boolean(value && !value.locked && state.selected[scopeKey(kind, state.projectScopes[baseScopeKey(kind)] ?? undefined)] === entryKey)
}

export function usePrivateDocumentSource(entryKey: string): DocumentSourceClient {
  const current = useConversations((state) => state.entries[entryKey]), canInteract = useInteractionGuard()
  const id = current?.conversation?.id, root = current?.conversation?.workspace.root, cwd = current?.session?.cwd
  const identity = JSON.stringify([entryKey, current?.owner, id, root, current?.session?.connectionGeneration, current?.locked])
  const latest = useRef(identity); latest.current = identity
  return useMemo(() => {
    const isCurrent = (): boolean => {
      return isPrivateEntrySelected(entryKey) && latest.current === identity && canInteract()
    }
    return {
      isCurrent,
      async openDocument(path: string) {
        const client = conversationClient()
        if (!client || !id || !isCurrent()) throw new Error('原会话文件当前不可用。')
        const files = conversationValue(await client.files(id))
        if (!isCurrent()) return
        const parsed = localDocumentLink(path), normalized = parsed?.path ?? path.replaceAll('\\', '/')
        if (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^[a-z]:\//i.test(normalized)) throw new Error('此链接不是原会话的本机文件。')
        const relative = normalized.replace(/^\.\//, '')
        const file = files.find((candidate) => candidate.relativePath.replaceAll('\\', '/') === relative || projectRootKey(`${root}/${candidate.relativePath}`) === projectRootKey(normalized) || Boolean(cwd && projectRootKey(`${cwd}/${candidate.relativePath}`) === projectRootKey(normalized)))
        if (!file) throw new Error('此路径不在原会话的可读取文件中，请刷新文件面板。')
        conversationValue(await client.openFile(id, { fileId: file.id, action: 'open' }))
      },
      async readImage(imageId: string) {
        const client = conversationClient()
        if (!client || !id || !isCurrent()) throw new Error('原会话图片当前不可用。')
        const image = conversationValue(await client.image(id, imageId))
        if (!isCurrent()) throw new Error('会话来源已改变。')
        return { id: imageId, name: imageId, ...image }
      },
      async saveImage(imageId: string) {
        const client = conversationClient()
        if (!client || !id || !isCurrent()) throw new Error('原会话图片当前不可用。')
        conversationValue(await client.saveImage(id, imageId))
      }
    }
  }, [identity, id, root, cwd, entryKey, canInteract])
}
