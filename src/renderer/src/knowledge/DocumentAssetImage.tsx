import { createContext, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  KNOWLEDGE_DOCUMENT_IMAGE_MAX_COUNT, KNOWLEDGE_DOCUMENT_IMAGES_MAX_BYTES,
  KNOWLEDGE_DOCUMENT_IMAGE_MAX_DIMENSION, KNOWLEDGE_DOCUMENT_IMAGE_MAX_PIXELS, KNOWLEDGE_DOCUMENT_IMAGE_MAX_BYTES,
  type KnowledgeArtifactImage, type KnowledgeDocumentContext
} from '../../../shared/knowledge-document-assets'
import { knowledgeBridge, knowledgeError, knowledgeUnavailableFor, requireKnowledge, useKnowledgeOwner } from './bridge'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'

interface DocumentImageScope {
  context: KnowledgeDocumentContext
  requests: Map<string, Promise<KnowledgeArtifactImage>>
  bytes: number
  current: () => boolean
  interactive: boolean
  signal: AbortSignal
}
const ImageScope = createContext<DocumentImageScope | null>(null)
function OwnedDocumentAssetScope({ context, contentKey, children }: { context: KnowledgeDocumentContext; contentKey: string; children: ReactNode }): JSX.Element {
  const owner = useKnowledgeOwner(context.expectedRoot, context.sessionId)
  const canInteract = useInteractionGuard()
  const interactive = useInteractionActive()
  const signal = useInteractionSignal()
  const identity = JSON.stringify(context)
  const scope = useMemo<DocumentImageScope>(() => ({ context, requests: new Map(), bytes: 0, current: () => owner.current() && canInteract(), interactive, signal: signal ?? new AbortController().signal }), [identity, contentKey, owner.current, canInteract, interactive, signal])
  return <ImageScope.Provider value={scope}>{children}</ImageScope.Provider>
}
export function DocumentAssetScope({ context, contentKey, children }: { context?: KnowledgeDocumentContext; contentKey: string; children: ReactNode }): JSX.Element {
  return context ? <OwnedDocumentAssetScope context={context} contentKey={contentKey}>{children}</OwnedDocumentAssetScope> : <>{children}</>
}

const queue: Array<() => void> = []
let activeReads = 0
function queued<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = (): void => {
      if (signal.aborted) { reject(new Error('图片读取已取消。')); return }
      activeReads++
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, fail) => { timer = setTimeout(() => fail(new Error('图片读取超时，请重新打开文档。')), 5000) })
      void Promise.race([Promise.resolve().then(read), timeout]).then(resolve, reject).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
        activeReads--
        while (activeReads < 2 && queue.length) queue.shift()?.()
      })
    }
    if (activeReads < 2) run()
    else queue.push(run)
  })
}

function imageRequest(scope: DocumentImageScope, src: string): Promise<KnowledgeArtifactImage> {
  const previous = scope.requests.get(src)
  if (previous) return previous
  if (scope.requests.size >= KNOWLEDGE_DOCUMENT_IMAGE_MAX_COUNT) return Promise.reject(new Error('单份文档最多自动读取 8 张本地图片。'))
  const request = queued(async () => {
    if (!scope.current()) throw new Error('图片读取已取消。')
    const bridge = knowledgeBridge(['artifactImage'])
    if (!bridge) throw new Error(knowledgeUnavailableFor('文档图片阅读'))
    const result = requireKnowledge(await bridge.artifactImage({ ...scope.context, src }))
    if (!scope.current() || scope.signal.aborted) throw new Error('图片读取已取消。')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType) || typeof result.dataUrl !== 'string' || !result.dataUrl.startsWith(`data:${result.mimeType};base64,`) || result.dataUrl.length > Math.ceil(KNOWLEDGE_DOCUMENT_IMAGE_MAX_BYTES / 3) * 4 + 64 || result.resource !== 'current-local' || !Number.isSafeInteger(result.byteLength) || result.byteLength <= 0 || result.byteLength > KNOWLEDGE_DOCUMENT_IMAGE_MAX_BYTES || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 || result.width > KNOWLEDGE_DOCUMENT_IMAGE_MAX_DIMENSION || result.height > KNOWLEDGE_DOCUMENT_IMAGE_MAX_DIMENSION || result.width * result.height > KNOWLEDGE_DOCUMENT_IMAGE_MAX_PIXELS) throw new Error('图片读取结果无效，未展示未经验证的资源。')
    if (scope.bytes + result.byteLength > KNOWLEDGE_DOCUMENT_IMAGES_MAX_BYTES) throw new Error('文档图片合计超过 20 MiB，未继续展示。')
    scope.bytes += result.byteLength
    return result
  }, scope.signal)
  // Cache failures as well as in-flight/successful reads for this owned document.
  // A deliberate reopen, content/owner change or Settings return creates a new scope.
  scope.requests.set(src, request)
  return request
}

/** Only main-validated bytes become an img source; Markdown paths never do. */
export function DocumentAssetImage({ src, alt, title }: { src?: string; alt?: string; title?: string }): JSX.Element {
  const scope = useContext(ImageScope)
  const currentScope = useRef(scope)
  currentScope.current = scope
  const sequence = useRef(0)
  const [image, setImage] = useState<KnowledgeArtifactImage | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const token = ++sequence.current
    let alive = true
    const current = (): boolean => Boolean(alive && currentScope.current === scope && sequence.current === token && scope?.current() && !scope.signal.aborted)
    setImage(null); setError('')
    if (!scope?.interactive || !scope.current()) return () => { alive = false; sequence.current++ }
    const load = async (): Promise<void> => {
      try {
        if (!src) throw new Error('图片地址为空或已被安全过滤。')
        const result = await imageRequest(scope, src)
        if (!current()) return
        setImage(result)
      } catch (failure) { if (current()) setError(knowledgeError(failure, '文档图片阅读')) }
    }
    void load()
    return () => { alive = false; sequence.current++ }
  }, [scope, src])
  return <span className="my-3 block min-w-0 max-w-full" role="group" aria-label={alt || '文档图片'}>
    {image ? <><img src={image.dataUrl} alt={alt ?? ''} title={title} width={image.width} height={image.height} className="mx-auto block h-auto max-h-[60vh] max-w-full rounded-my-md object-contain" onLoad={event => {
      if (currentScope.current !== scope || !scope?.current()) return
      const node = event.currentTarget
      const sameSize = node.naturalWidth === image.width && node.naturalHeight === image.height || node.naturalWidth === image.height && node.naturalHeight === image.width
      if (!sameSize || node.naturalWidth > KNOWLEDGE_DOCUMENT_IMAGE_MAX_DIMENSION || node.naturalHeight > KNOWLEDGE_DOCUMENT_IMAGE_MAX_DIMENSION || node.naturalWidth * node.naturalHeight > KNOWLEDGE_DOCUMENT_IMAGE_MAX_PIXELS) { setImage(null); setError('图片实际尺寸与安全读取结果不符，未继续展示。') }
    }} onError={() => { if (currentScope.current === scope && scope?.current()) { setImage(null); setError('图片内容无法解码显示，请检查原始图片文件。') } }} /><span className="mt-1 block text-center text-my-xs text-my-tertiary" title={image.relativePath}>{alt ? `${alt} · ` : ''}本地图片 · 当前资源</span></>
      : error ? <span role="alert" className="block rounded-my-md border border-my-line p-3 text-my-sm text-my-secondary">{alt && <strong className="mb-1 block font-medium">{alt}</strong>}{error}</span>
      : scope?.interactive ? <span role="status" className="block py-3 text-my-xs text-my-tertiary">正在读取文档图片…</span> : null}
  </span>
}
