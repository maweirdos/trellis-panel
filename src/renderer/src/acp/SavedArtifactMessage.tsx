import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { MarkdownView } from '../components/MarkdownView'
import { knowledgeBridge, knowledgeError, knowledgeUnavailableFor, requireKnowledge, useKnowledgeOwner } from '../knowledge/bridge'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { SavedArtifactModal } from './SavedArtifactModal'
import { savedArtifactForMessage } from './saved-artifact-links'
import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import type { KnowledgeArtifact } from '../../../shared/knowledge-access'
import { sameRelativeDocumentPath } from '../reader/reader-paths'

export function SavedArtifactMessage({ text, messageId, events, session }: { text: string; messageId: string; events: readonly TimelineEvent[]; session?: AcpSessionRecord }): JSX.Element {
  const root = session?.projectRoot ?? ''
  const owner = useKnowledgeOwner(root, session?.sessionId)
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const [reading, setReading] = useState<KnowledgeArtifact | null>(null)
  const [linkError, setLinkError] = useState('')
  const sequence = useRef(0)
  const view = useMemo(() => ({}), [owner.current, session?.sessionId, session?.connectionGeneration, messageId, interactionSignal])
  const selected = useRef(view)
  selected.current = view
  const valid = (): boolean => owner.current() && canInteract() && !interactionSignal?.aborted && selected.current === view
  useEffect(() => {
    setReading(null); setLinkError(''); sequence.current++
    return () => { sequence.current++ }
  }, [view, interactive])
  const openLink = async (href: string): Promise<boolean> => {
    if (!session) return false
    const receipt = savedArtifactForMessage(href, messageId, events, session)
    if (!receipt) return false
    if (!valid()) return true
    setLinkError('')
    if (receipt === 'ambiguous') { setLinkError('这个路径对应多个已保存版本，请点击对应保存回执中的文档名称。'); return true }
    const bridge = knowledgeBridge(['artifact'])
    if (!bridge) { setLinkError(knowledgeUnavailableFor('需求文档阅读')); return true }
    const token = ++sequence.current
    try {
      const result = await bridge.artifact({ ...owner.input, artifactId: receipt.artifactId, revision: receipt.revision })
      if (!valid() || token !== sequence.current) return true
      const artifact = requireKnowledge(result)
      if (artifact.id !== receipt.artifactId || artifact.revision !== receipt.revision || artifact.sessionId !== session.sessionId || !sameRelativeDocumentPath(root, artifact.relativePath, receipt.relativePath)) throw new Error('文档与本条消息的保存回执不一致，请从保存记录核对版本。')
      setReading(artifact)
      return true
    } catch (error) {
      if (!valid() || token !== sequence.current) return true
      setLinkError(knowledgeError(error, '需求文档阅读'))
      return true
    }
  }
  return <><MarkdownView content={text} onOpenDocumentLink={openLink} />{interactive && linkError && <p role="alert" className="mt-3 text-my-sm text-my-warning-text">{linkError}</p>}{interactive && reading && <SavedArtifactModal key={`${reading.id}:${reading.revision}:${session?.connectionGeneration}`} root={root} sessionId={session?.sessionId ?? ''} artifact={reading} isCurrent={valid} onClose={() => setReading(null)} />}</>
}
