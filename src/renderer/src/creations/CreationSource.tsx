import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, FileText, Loader2, RefreshCw } from 'lucide-react'
import type { CreationPrivateSource } from '@shared/creations'
import { conversationClient, conversationError, conversationValue } from '../conversations/client'
import { showPrivateConversation } from '../conversations/private-navigation'
import { selectConversation } from '../conversations/workspace'
import { useCrux } from '../crux/store'
import { Button } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'

/** This owner-only clue never grants access; resolve the original conversation again. */
export function CreationSource({ source, disabled }: { source: CreationPrivateSource; disabled: boolean }): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const identity = JSON.stringify([context.key, context.actorId, context.epoch, context.authorizationRevision, context.state])
  const current = useRef(true)
  const blocked = useRef(disabled)
  blocked.current = disabled
  const request = useRef(0)
  const lifetime = useRef(0)
  const canInteract = useInteractionGuard()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  useLayoutEffect(() => {
    current.current = true
    request.current++
    lifetime.current++
    setBusy(false); setError(''); setStatus('')
    return () => { current.current = false; request.current++; lifetime.current++ }
  }, [identity, source.conversationId, source.fileId, source.revision, source.sourceIdentity])

  const check = async (): Promise<void> => {
    if (busy || !canInteract()) return
    const owner = lifetime.current
    setError('')
    setStatus('正在核对原文件…')
    const valid = (): boolean => current.current && lifetime.current === owner && canInteract()
    if (!source.sourceIdentity) { setStatus('旧来源缺少目录身份，无法核实原文件。'); return }
    const client = conversationClient()
    if (!client) { setStatus('请在桌面应用中核对原文件。'); return }
    setBusy(true)
    try {
      const files = conversationValue(await client.files(source.conversationId))
      if (!valid()) return
      const file = files.find(item => item.id === source.fileId)
      setStatus(!file ? '当前扫描未发现原文件，或文件不可访问。' : file.sourceIdentity !== source.sourceIdentity ? '原会话来源或文件身份已变化；当前创作保留已保存的版本。' : file.revision !== source.revision ? '原文件已修改；当前创作保留已保存的版本。' : '原文件与保存时一致。')
    } catch (cause) { if (valid()) setStatus(`无法核对原文件：${conversationError(cause)}`) }
    finally { if (valid()) setBusy(false) }
  }

  const open = async (): Promise<void> => {
    if (busy || disabled || !canInteract()) return
    const client = conversationClient()
    if (!client) { setError('请在桌面应用中打开关联会话。'); return }
    const ticket = ++request.current
    const valid = (): boolean => {
      const live = useCrux.getState().workspaceContext
      return current.current && !blocked.current && request.current === ticket && canInteract() &&
        identity === JSON.stringify([live.key, live.actorId, live.epoch, live.authorizationRevision, live.state]) && live.state !== 'access-revoked'
    }
    setBusy(true); setError('')
    try {
      const read = conversationValue(await client.read(source.conversationId))
      if (!valid()) return
      if (read.conversation.id !== source.conversationId) throw new Error('关联会话身份不匹配。')
      if (!source.sourceIdentity) throw new Error('旧来源缺少目录身份，无法安全打开关联会话。')
      const files = conversationValue(await client.files(source.conversationId))
      if (!valid()) return
      const file = files.find(item => item.id === source.fileId)
      if (!file) throw new Error('当前扫描未发现原文件，或文件不可访问。')
      if (file.sourceIdentity !== source.sourceIdentity) throw new Error('原会话来源或文件身份已变化，无法打开关联会话。')
      conversationValue(await client.readFile(source.conversationId, { fileId: file.id, expectedRevision: file.revision, expectedSourceIdentity: source.sourceIdentity }))
      if (!valid()) return
      selectConversation(read.conversation)
      showPrivateConversation(read.conversation.kind)
    } catch (cause) {
      if (valid()) setError(conversationError(cause))
    } finally {
      if (current.current && request.current === ticket) setBusy(false)
    }
  }

  return <div className="flex flex-wrap items-center gap-2">
    <FileText size={14} aria-hidden="true" />
    <span className="my-item-description min-w-0 flex-1 break-all">选自会话文件 · {source.fileName}</span>
    <Button size="sm" variant="ghost" onClick={() => void check()} disabled={busy}><RefreshCw size={14} />核对文件</Button>
    <Button size="sm" variant="ghost" onClick={() => void open()} disabled={busy || disabled} title={disabled ? '请先保存当前修改' : undefined}>
      {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpRight size={14} />}打开关联会话
    </Button>
    {status && <p className="my-item-description w-full" role="status">{status}</p>}
    {error && <p role="alert" className="w-full text-my-sm text-my-danger-text">{error}</p>}
  </div>
}
