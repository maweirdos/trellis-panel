import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ConversationFile } from '@shared/private-conversations'
import { localDocumentLink } from '@shared/local-document-link'
import type { DocumentSourceClient } from '../reader/document-source'
import { projectRootKey } from '../my/navigation'
import { useMy } from '../my/store'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { conversationClient, conversationValue } from './client'
import { baseScopeKey, scopeKey, useConversations } from './workspace'

export function isPrivateEntrySelected(entryKey: string): boolean {
  const state = useConversations.getState(), value = state.entries[entryKey]
  const kind = useMy.getState().shellView === 'development' ? 'code' : 'work'
  return Boolean(value && !value.locked && state.selected[scopeKey(kind, state.projectScopes[baseScopeKey(kind)] ?? undefined)] === entryKey)
}

export interface PrivateDocumentPreview { file: ConversationFile; body: string; pending?: boolean; error?: string; conversationId: string; ownerKey: string }
export function usePrivateDocumentSource(entryKey: string, onRead?: (document: PrivateDocumentPreview) => void): DocumentSourceClient & { cancelRead(): void } {
  const current = useConversations((state) => state.entries[entryKey]), canInteract = useInteractionGuard(), active = useInteractionActive()
  const id = current?.conversation?.id, root = current?.conversation?.workspace.root, cwd = current?.session?.cwd
  const identity = JSON.stringify([entryKey, current?.owner, id, root, current?.session?.connectionGeneration, current?.locked])
  const latest = useRef(identity); latest.current = identity
  const reader = useRef(onRead); reader.current = onRead
  const readSerial = useRef(0)
  useLayoutEffect(() => { readSerial.current++; return () => { readSerial.current++ } }, [identity, active])
  return useMemo(() => {
    const isCurrent = (): boolean => {
      return isPrivateEntrySelected(entryKey) && latest.current === identity && canInteract()
    }
    return {
      isCurrent,
      cancelRead() { readSerial.current++ },
      async openDocument(path: string) {
        const ticket = ++readSerial.current, client = conversationClient()
        const current = (): boolean => isCurrent() && readSerial.current === ticket
        if (!client || !id || !current()) throw new Error('原会话文件当前不可用。')
        const files = conversationValue(await client.files(id))
        if (!current()) return
        const parsed = localDocumentLink(path), normalized = parsed?.path ?? path.replaceAll('\\', '/')
        if (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^[a-z]:\//i.test(normalized)) throw new Error('此链接不是原会话的本机文件。')
        const relative = normalized.replace(/^\.\//, '')
        const file = files.find((candidate) => candidate.relativePath.replaceAll('\\', '/') === relative || projectRootKey(`${root}/${candidate.relativePath}`) === projectRootKey(normalized) || Boolean(cwd && projectRootKey(`${cwd}/${candidate.relativePath}`) === projectRootKey(normalized)))
        if (!file) throw new Error('此路径不在原会话的可读取文件中，请刷新文件面板。')
        if (/\.(md|txt|csv|tsv)$/i.test(file.name) && reader.current) {
          if (typeof client.readFile !== 'function') throw new Error('文档阅读功能尚未加载，请通过正常入口重新启动应用。')
          const preview = { file, body: '', conversationId: id, ownerKey: identity }
          reader.current({ ...preview, pending: true })
          try {
            const document = conversationValue(await client.readFile(id, { fileId: file.id, expectedRevision: file.revision, expectedSourceIdentity: file.sourceIdentity }))
            if (!current()) return
            if (document.revision !== file.revision) throw new Error('文档版本已变化，请重新读取。')
            reader.current({ ...preview, body: document.body })
          } catch (cause) {
            if (current()) reader.current({ ...preview, error: cause instanceof Error ? cause.message : '文档读取未完成' })
          }
        } else conversationValue(await client.openFile(id, { fileId: file.id, action: 'open' }))
      },
      async readImage(imageId: string) {
        const client = conversationClient()
        if (!isCurrent()) throw Object.assign(new Error('图片读取所属界面已变化。'), { name: 'AbortError' })
        if (!client || !id) throw new Error('原会话图片当前不可用。')
        const image = conversationValue(await client.image(id, imageId))
        if (!isCurrent()) throw Object.assign(new Error('会话来源已改变。'), { name: 'AbortError' })
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
