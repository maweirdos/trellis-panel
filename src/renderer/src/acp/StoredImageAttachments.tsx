import { useEffect, useRef, useState, type JSX } from 'react'
import { api } from '../api'
import type { AcpImageAttachment, AcpStoredImage } from '../../../shared/acp-images'
import { ImageAttachments } from './ImageAttachments'
import { useDocumentSource, type DocumentSourceClient } from '../reader/document-source'
import { useInteractionActive } from '../utils/interaction-scope'
import { Button } from '../my/ui'

// Bound native history reads across rows; duplicate mounts share both results and failures.
const sources = new WeakMap<DocumentSourceClient, number>()
let sourceNumber = 0, reading = 0
const waiting: Array<() => void> = []
interface CachedImage { promise: Promise<AcpImageAttachment>; bytes: number; settled: boolean; failed: boolean }
const cache = new Map<string, CachedImage>()
const MAX_CACHE_BYTES = 28 * 1024 * 1024
function trimCache(): void {
  let bytes = [...cache.values()].reduce((total, value) => total + value.bytes, 0)
  for (const [key, value] of cache) {
    if (bytes <= MAX_CACHE_BYTES && cache.size <= 64) break
    if (!value.settled) continue
    bytes -= value.bytes; cache.delete(key)
  }
}
async function scheduled<T>(read: () => Promise<T>): Promise<T> {
  await new Promise<void>(resolve => {
    const start = (): void => { reading++; resolve() }
    if (reading < 2) start(); else waiting.push(start)
  })
  try { return await read() } finally { reading--; waiting.shift()?.() }
}
function imageKey(source: DocumentSourceClient | null, sessionId: string, id: string, projectRoot: string): string {
  if (source && !sources.has(source)) sources.set(source, ++sourceNumber)
  return JSON.stringify([source ? sources.get(source) : 'native', projectRoot, sessionId, id])
}
function storedImage(source: DocumentSourceClient | null, sessionId: string, entry: AcpStoredImage, retry: boolean, projectRoot: string): Promise<AcpImageAttachment> {
  const key = imageKey(source, sessionId, entry.id, projectRoot), existing = cache.get(key)
  if (existing && !(retry && existing.failed)) return existing.promise
  const value: CachedImage = { bytes: 0, settled: false, failed: false, promise: Promise.resolve({ ...entry, data: '' }) }
  value.promise = scheduled(async () => {
    if (source && !source.isCurrent()) throw Object.assign(new Error('图片读取所属界面已变化'), { name: 'AbortError' })
    const image = source ? await source.readImage(entry.id) : await api.acpPiImage(sessionId, entry.id).then(result => {
      if (!result.ok) throw Object.assign(new Error(result.error), result)
      return { ...entry, ...result.image }
    })
    if (image.mimeType !== entry.mimeType) throw new Error('图片类型已变化')
    return { ...entry, data: image.data }
  }).then(image => { value.bytes = image.data.length * 2; return image }, cause => {
    value.failed = true
    if (cause instanceof Error && cause.name === 'AbortError' && cache.get(key) === value) cache.delete(key)
    throw cause
  }).finally(() => { value.settled = true; trimCache() })
  cache.set(key, value)
  return value.promise
}

export function StoredImageAttachments({ images, sessionId, projectRoot }: { images: AcpStoredImage[]; sessionId: string; projectRoot: string }): JSX.Element {
  const source = useDocumentSource(), active = useInteractionActive(), host = useRef<HTMLDivElement>(null)
  const lastAttempt = useRef(0)
  const [visible, setVisible] = useState(false), [loaded, setLoaded] = useState<AcpImageAttachment[]>([])
  const [resultOwner, setResultOwner] = useState('')
  const [errors, setErrors] = useState<string[]>([]), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0)
  const identity = JSON.stringify([...new Map(images.map(image => [image.id, image])).values()])
  const owner = imageKey(source, sessionId, identity, projectRoot)
  useEffect(() => {
    const element = host.current
    if (!active || !element) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '160px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [active, identity, source])
  useEffect(() => {
    let current = true
    if (!active || !visible) return
    setLoading(true)
    const retry = attempt > lastAttempt.current; lastAttempt.current = attempt
    const entries = JSON.parse(identity) as AcpStoredImage[]
    void Promise.allSettled(entries.map(entry => storedImage(source, sessionId, entry, retry, projectRoot))).then(results => {
      if (!current || source && !source.isCurrent()) return
      setResultOwner(owner)
      setLoaded(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))
      setErrors([...new Set(results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : '图片读取失败'] : []))])
      setLoading(false)
    })
    return () => { current = false }
  }, [owner, identity, sessionId, projectRoot, attempt, source, active, visible])
  const currentErrors = resultOwner === owner ? errors : []
  const retryable = currentErrors.some(message => /queue is full|E_BUSY|暂时|繁忙|disconnected|connection was lost|timed out|超时|连接.*(?:中断|断开)/i.test(message))
  return <div ref={host} className="acp-stored-images">
    {resultOwner === owner && loaded.length > 0 && <ImageAttachments images={loaded} onSave={async id => { if (source) return source.saveImage(id); const result = await api.acpPiImageSave(sessionId, id); if (!result.ok) throw new Error(result.error) }} />}
    {loading && <span className="my-item-description" role="status">正在读取图片预览…</span>}
    {currentErrors.length > 0 && <details className="my-activity-note"><summary>部分图片预览不可用</summary><p className="my-item-description">消息正文仍可阅读。</p>{currentErrors.map(error => <p key={error} className="my-item-description">{error}</p>)}{retryable && <Button size="sm" variant="ghost" disabled={loading} title="只读取失败的图片，不重发消息或修改会话" onClick={() => setAttempt(value => value + 1)}>{loading ? '正在读取…' : '重新读取图片'}</Button>}</details>}
  </div>
}
