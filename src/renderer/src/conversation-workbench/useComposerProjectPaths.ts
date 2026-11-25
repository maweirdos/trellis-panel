import { useEffect, useState } from 'react'
import type { ProjectWorkbenchFileEntry, ProjectWorkbenchInput } from '../../../shared/conversation/project-workbench'
import { api } from '../api'
import { useInteractionGuard } from '../utils/interaction-scope'
import type { ComposerTrigger } from './useComposerMenuItems'

export type ComposerProjectPathTarget = Omit<ProjectWorkbenchInput, 'action'>

const noEntries: readonly ProjectWorkbenchFileEntry[] = []

export function useComposerProjectPaths(target: ComposerProjectPathTarget | undefined, trigger: ComposerTrigger | null) {
  const canInteract = useInteractionGuard()
  const query = trigger?.kind === 'path' ? trigger.query.replace(/\\/gu, '/') : undefined
  const boundary = query?.lastIndexOf('/') ?? -1
  const directory = boundary > 0 ? query?.slice(0, boundary) : undefined
  const request = target && query !== undefined && !query.startsWith('/') && !query.split('/').includes('..')
    ? JSON.stringify({ ...target, action: { kind: 'files', directory } } satisfies ProjectWorkbenchInput)
    : null
  const [read, setRead] = useState<{ request: string; entries: readonly ProjectWorkbenchFileEntry[]; error?: string }>()
  useEffect(() => {
    if (!request || !canInteract()) return
    let current = true
    void api.conversationProjectWorkbench(JSON.parse(request)).then(result => {
      if (!current || !canInteract()) return
      setRead(result.ok && result.kind === 'files' ? { request, entries: result.entries }
        : { request, entries: noEntries, error: result.ok ? '原工程没有返回目录。' : result.error })
    }).catch(() => {
      if (current && canInteract()) setRead({ request, entries: noEntries, error: '暂时无法读取原工程目录。' })
    })
    return () => { current = false }
  }, [request, canInteract])
  return {
    entries: request && read?.request === request ? read.entries : noEntries,
    query: query?.slice(boundary + 1) ?? '',
    pending: Boolean(request && read?.request !== request),
    error: request && read?.request === request ? read.error : undefined,
  }
}
