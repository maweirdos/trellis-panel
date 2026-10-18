import { useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type JSX } from 'react'
import { ACP_IMAGE_MAX_BYTES, ACP_IMAGE_MAX_COUNT, ACP_IMAGE_MIME_TYPES, ACP_IMAGES_MAX_BYTES, acpImageBytes, detectAcpImageMime, type AcpImageAttachment } from '../../../shared/acp-images'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'

function readImage(file: File): Promise<AcpImageAttachment> {
  if (!file.size || file.size > ACP_IMAGE_MAX_BYTES) return Promise.reject(new Error('每张图片最大 10 MB'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`))
    reader.onabort = () => reject(new Error('图片读取已取消'))
    reader.onload = () => {
      try {
        const data = typeof reader.result === 'string' ? reader.result.split(',')[1] ?? '' : ''
        const header = Uint8Array.from(atob(data.slice(0, 32)), (character) => character.charCodeAt(0))
        const mimeType = detectAcpImageMime(header)
        if (!mimeType) throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片')
        resolve({ id: crypto.randomUUID(), name: (file.name || '图片').slice(0, 255), mimeType, data })
      } catch (error) { reject(error instanceof Error ? error : new Error(`无法读取图片：${file.name}`)) }
    }
    reader.readAsDataURL(file)
  })
}

/** Bytes are source-owned memory, never localStorage preferences or another session's draft. */
export function useComposerImages({ root, sessionId, generation, isCurrent }: {
  root: string; sessionId?: string; generation?: string; isCurrent: () => boolean
}) {
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const source = useMemo(() => ({ drafts: new Map<string, AcpImageAttachment[]>(), errors: new Map<string, string>(), pending: new Map<string, number>() }), [root])
  const sourceRef = useRef(source)
  sourceRef.current = source
  const owner = useMemo(() => ({ source, sessionId, generation, live: true }), [source, sessionId, generation, interactive])
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  useLayoutEffect(() => { owner.live = true; return () => { owner.live = false } }, [owner])
  const [, refresh] = useState(0)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  const pickerOwner = useRef(owner)
  const validOwner = (candidate: typeof owner): boolean => candidate.live && ownerRef.current === candidate && canInteract() && isCurrent()
  const notify = (): void => { if (sourceRef.current === source && ownerRef.current.live) refresh((version) => version + 1) }
  useLayoutEffect(() => { depth.current = 0; setDragging(false) }, [owner])

  const addFiles = async (files: File[], candidate = owner): Promise<void> => {
    const id = candidate.sessionId
    if (!id || !files.length || !validOwner(candidate)) return
    const checkBounds = (count: number, bytes: number): void => {
      const current = source.drafts.get(id) ?? []
      if (current.length + count > ACP_IMAGE_MAX_COUNT) throw new Error('一条消息最多添加 8 张图片')
      if (current.reduce((total, image) => total + acpImageBytes(image.data), 0) + bytes > ACP_IMAGES_MAX_BYTES) throw new Error('一条消息的图片总大小最多 20 MB')
    }
    let reading = false
    try {
      checkBounds(files.length, files.reduce((total, file) => total + file.size, 0))
      source.errors.delete(id)
      source.pending.set(id, (source.pending.get(id) ?? 0) + 1); reading = true; notify()
      const loaded = await Promise.all(files.map(readImage))
      if (!validOwner(candidate)) return
      checkBounds(loaded.length, loaded.reduce((total, image) => total + acpImageBytes(image.data), 0))
      source.drafts.set(id, [...(source.drafts.get(id) ?? []), ...loaded])
    } catch (error) {
      if (validOwner(candidate)) source.errors.set(id, error instanceof Error ? error.message : '添加图片失败')
    } finally {
      if (reading) source.pending.set(id, Math.max(0, (source.pending.get(id) ?? 0) - 1))
      notify()
    }
  }
  const hasFiles = (event: DragEvent<HTMLElement>): boolean => event.dataTransfer.types.includes('Files')
  const dragHandlers = {
    onDragEnter: (event: DragEvent<HTMLElement>): void => { if (hasFiles(event) && validOwner(owner)) { event.preventDefault(); depth.current += 1; setDragging(true) } },
    onDragOver: (event: DragEvent<HTMLElement>): void => { if (hasFiles(event) && validOwner(owner)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } },
    onDragLeave: (event: DragEvent<HTMLElement>): void => { if (hasFiles(event)) { event.preventDefault(); depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false) } },
    onDrop: (event: DragEvent<HTMLElement>): void => {
      if (!hasFiles(event)) return
      event.preventDefault(); depth.current = 0; setDragging(false)
      void addFiles(Array.from(event.dataTransfer.files))
    }
  }
  const onPaste = (event: ClipboardEvent<HTMLElement>): void => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    if (!files.length || !validOwner(owner)) return
    // Keep ordinary mixed clipboard text insertion, without inserting a duplicate image path.
    if (!event.clipboardData.getData('text/plain')) event.preventDefault()
    void addFiles(files)
  }
  const fileInput: JSX.Element = <input ref={picker} type="file" accept={ACP_IMAGE_MIME_TYPES.join(',')} multiple hidden aria-label="添加图片" onChange={(event) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    void addFiles(files, pickerOwner.current)
  }} />
  return {
    images: sessionId ? source.drafts.get(sessionId) ?? [] : [],
    error: sessionId ? source.errors.get(sessionId) ?? '' : '',
    pending: sessionId ? (source.pending.get(sessionId) ?? 0) > 0 : false,
    dragging, dragHandlers, onPaste, fileInput,
    choose: (): void => { if (validOwner(owner)) { pickerOwner.current = owner; picker.current?.click() } },
    remove: (imageId: string): void => {
      if (!sessionId || !validOwner(owner)) return
      source.drafts.set(sessionId, (source.drafts.get(sessionId) ?? []).filter((image) => image.id !== imageId))
      source.errors.delete(sessionId); notify()
    },
    consume: (id: string, submitted: AcpImageAttachment[]): void => {
      if (sourceRef.current !== source) return
      const sent = new Set(submitted.map((image) => image.id))
      source.drafts.set(id, (source.drafts.get(id) ?? []).filter((image) => !sent.has(image.id))); notify()
    }
  }
}
