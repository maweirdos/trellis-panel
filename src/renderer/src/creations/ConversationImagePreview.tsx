import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { X } from 'lucide-react'
import { ACP_IMAGE_MIME_TYPES, ACP_IMAGE_MAX_BASE64, type AcpImageMimeType } from '@shared/acp-images'
import type { ConversationFile } from '@shared/private-conversations'
import { Button } from '../my/ui'
import { checkConversationImage } from './conversation-image-dimensions'
import './conversation-table-preview.css'
import './conversation-image-preview.css'

type ImageData = { name: string; revision: string; mimeType: AcpImageMimeType; data: string }
type State = { kind: 'loading' } | { kind: 'ready'; image: ImageData } | { kind: 'error'; message: string }
const motionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
const subscribeMotion = (notify: () => void): (() => void) => {
  motionQuery?.addEventListener('change', notify)
  return () => motionQuery?.removeEventListener('change', notify)
}

/** The reader is mounted only after an explicit user action. */
export function ConversationImagePreview({ file, load, onClose, onOpen }: {
  file: ConversationFile; load: (current: () => boolean) => Promise<ImageData>; onClose: () => void; onOpen: () => void
}): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const reducedMotion = useSyncExternalStore(subscribeMotion, () => motionQuery?.matches ?? true, () => true)
  const loadRef = useRef(load)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  loadRef.current = load

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    heading.current?.focus()
  }, [])

  useEffect(() => {
    let current = true
    setState({ kind: 'loading' })
    void loadRef.current(() => current).then(async image => {
      if (!current) return
      if (!ACP_IMAGE_MIME_TYPES.includes(image.mimeType) || !image.data || image.data.length > ACP_IMAGE_MAX_BASE64) {
        setState({ kind: 'error', message: '图片数据无效，请刷新文件或使用系统打开。' })
        return
      }
      const result = await checkConversationImage(image.data, image.mimeType, () => current)
      if (!current) return
      if (result !== 'valid') {
        setState({ kind: 'error', message: result === 'too-large' ? '图片像素尺寸超过预览限制，请使用系统打开。' : '无法确认图片尺寸或格式，请使用系统打开。' })
        return
      }
      setState({ kind: 'ready', image })
    }).catch(cause => {
      if (current) setState({ kind: 'error', message: cause instanceof Error ? cause.message : '无法读取所选图片。' })
    })
    return () => { current = false }
  }, [file.id, file.revision, file.sourceIdentity, attempt])

  const close = (): void => {
    onClose()
    if (opener.current?.isConnected) opener.current.focus()
  }
  return <section className="conversation-table-preview" aria-labelledby="conversation-image-preview-heading">
    <div className="flex flex-wrap items-center gap-2">
      <h2 ref={heading} id="conversation-image-preview-heading" tabIndex={-1} className="my-item-title min-w-0 flex-1 break-all">{file.name}</h2>
      <Button size="sm" variant="ghost" onClick={close} aria-label="关闭图片预览"><X size={14} />关闭</Button>
    </div>
    {state.kind === 'loading' && <p className="my-item-description" role="status">正在读取图片…</p>}
    {state.kind === 'error' && <div role="alert" className="flex flex-wrap items-center gap-2 text-my-sm text-my-danger-text">
      <span>{state.message}</span><Button size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button><Button size="sm" variant="ghost" onClick={onOpen}>系统打开</Button>
    </div>}
    {state.kind === 'ready' && state.image.mimeType === 'image/gif' && reducedMotion && <div className="flex flex-wrap items-center gap-2" role="status">
      <span className="my-item-description">已启用减少动态效果，GIF 预览已暂停。</span><Button size="sm" variant="ghost" onClick={onOpen}>系统打开</Button>
    </div>}
    {state.kind === 'ready' && !(state.image.mimeType === 'image/gif' && reducedMotion) && <div className="conversation-image-preview"><img src={`data:${state.image.mimeType};base64,${state.image.data}`} alt={file.name}
      onError={() => setState({ kind: 'error', message: '图片损坏或无法解码，请刷新文件或使用系统打开。' })} /></div>}
  </section>
}
