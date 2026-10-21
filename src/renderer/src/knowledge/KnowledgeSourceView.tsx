import { useEffect, useRef, useState, type JSX } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { Button } from '../my/ui'
import { MarkdownView } from '../components/MarkdownView'
import { useInteractionGuard } from '../utils/interaction-scope'
import { knowledgeBridge, knowledgeError, knowledgeStatusLabel, knowledgeUnavailableFor, requireKnowledge, useKnowledgeOwner } from './bridge'
import type { KnowledgeSource } from '../../../shared/knowledge-access'

export function KnowledgeSourceView({ root, sessionId, initial }: { root: string; sessionId?: string; initial: KnowledgeSource }): JSX.Element {
  const owner = useKnowledgeOwner(root, sessionId)
  const canInteract = useInteractionGuard()
  const [source, setSource] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  useEffect(() => { setSource(initial); setBusy(false); setError(''); running.current = false }, [initial, owner.current])
  const read = async (): Promise<void> => {
    const bridge = knowledgeBridge(['read'])
    if (running.current || !owner.current() || !canInteract()) return
    if (!bridge) { setError(knowledgeUnavailableFor('知识正文读取')); return }
    running.current = true; setBusy(true); setError('')
    try {
      const result = requireKnowledge(await bridge.read({ ...owner.input, requestId: crypto.randomUUID(), sourceHandle: source.sourceHandle }))
      if (!owner.current() || !canInteract()) return
      if (result.source) setSource(result.source)
      if (result.status !== 'ok') setError(`${knowledgeStatusLabel[result.status]}：${result.detail}`)
      if (result.persistence === 'degraded') setError((text) => `${text} · 来源保存降级，不保证重开可读`)
    } catch (failure) { if (owner.current()) setError(knowledgeError(failure)) }
    finally { running.current = false; if (owner.current()) setBusy(false) }
  }
  return <article aria-label={`知识来源：${source.title}`} className="space-y-3 rounded-my-md border border-my-line bg-my-layer-1 p-3">
    <div className="flex items-center gap-2"><FileText size={14} className="shrink-0 text-my-icon-accent" /><h3 className="min-w-0 flex-1 break-words text-my-sm font-medium">{source.title}</h3></div>
    <p className="text-my-2xs leading-5 text-my-tertiary">{source.historical ? '历史快照' : '本次读取'} · {source.mode === 'full' ? '全文' : source.mode === 'excerpt' ? '摘录' : '格式不支持'}{source.truncated ? ' · 已截断，不是完整文档' : ''} · {source.suppliedToAgent ? '已提供给 Agent' : '仅检索/阅读'}</p>
    {source.text ? <div className="my-scrollbar max-h-96 overflow-y-auto break-words"><MarkdownView content={source.text} /></div> : <p className="text-my-xs text-my-secondary">当前格式无可读取的文本；没有将其视为已读全文。</p>}
    <Button size="sm" variant="outline" disabled={busy || source.kind !== 'weknora'} onClick={() => void read()}>{busy && <Loader2 size={12} className="animate-spin" />}从当前授权范围读取正文</Button>
    <details className="text-my-2xs text-my-tertiary"><summary className="cursor-pointer">来源与版本详情</summary><p className="mt-2 break-all leading-5">{source.kind === 'weknora' ? `WeKnora · ${source.instanceId || '实例未知'} · 库 ${source.collectionId || '未知'}` : source.relativePath} · 文档 {source.documentId}<br />快照 {source.contentHash} · {new Date(source.fetchedAt).toLocaleString()}<br />{source.suppliedToAgent ? '已提供给 Agent；不等于输出已引用' : '仅检索/阅读，不声称模型已使用'}{source.turnId ? ` · 轮次 ${source.turnId}` : ''}</p></details>
    {error && <p role="alert" className="text-my-xs text-my-warning-text">{error}</p>}
  </article>
}
