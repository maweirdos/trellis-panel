import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { api } from '../api'
import { useKnowledgeOwner } from '../knowledge/bridge'
import { Button } from '../my/ui'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import type { AcpSessionRecord } from '../../../shared/types'

export function PiGeneratedDocument({ path, session }: { path: string; session: AcpSessionRecord }): JSX.Element {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const operation = useRef<string | null>(null)
  const owner = useKnowledgeOwner(session.projectRoot, session.sessionId)
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  const generation = session.connectionGeneration

  useLayoutEffect(() => {
    setPending(false)
    setError('')
    const cancel = (): void => {
      const id = operation.current
      operation.current = null
      if (id && typeof api?.acpPiDocumentCancel === 'function') api.acpPiDocumentCancel(id)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    return () => { signal?.removeEventListener('abort', cancel); cancel() }
  }, [session.projectRoot, session.sessionId, generation, path, signal])

  const open = async (): Promise<void> => {
    if (operation.current || !owner.current() || !canInteract()) return
    setError('')
    if (!generation) { setError('会话连接信息不可用，请重新打开此会话后重试。'); return }
    if (typeof api?.acpPiDocumentOpen !== 'function' || typeof api.acpPiDocumentCancel !== 'function') {
      setError('本地文档打开功能尚未加载，请完整退出并重启应用后重试。'); return
    }
    const id = crypto.randomUUID()
    operation.current = id
    setPending(true)
    const current = (): boolean => operation.current === id && owner.current() && canInteract() && !signal?.aborted
    try {
      const result = await api.acpPiDocumentOpen({ operationId: id, expectedRoot: session.projectRoot, sessionId: session.sessionId, connectionGeneration: generation, path })
      if (current() && !result.ok) setError(result.error)
    } catch {
      if (current()) setError('无法打开本地文档，请检查系统默认应用后重试。')
    } finally {
      if (current()) { operation.current = null; setPending(false) }
    }
  }
  return <div className="space-y-1 text-my-sm">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="min-w-0 break-all font-mono text-my-secondary">{path}</span>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void open()}>{pending ? '正在打开…' : '打开文件'}</Button>
    </div>
    {error && <p role="alert" className="text-my-danger-text">{error}</p>}
  </div>
}
