import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { DesignPage, DesignSelection } from '@shared/design-workspace'
import { Button } from '../my/ui'
import { readDesignPreviewMessage, type DesignElementPick } from './preview-bridge'
import { buildDesignPreviewDocument, DESIGN_PREVIEW_CHANNEL, type DesignPageRoute } from './preview-runtime'

export interface DesignPreviewPort { parent(): void; locate(): void; clear(): void; validate(pick: DesignElementPick): Promise<boolean> }
/** clientX/clientY are host-window CSS pixels; deltas are input CSS pixels, unaffected by canvas zoom. */
export interface DesignCanvasWheel { clientX: number; clientY: number; deltaX: number; deltaY: number; zoom: boolean }
export interface DesignPreviewProps {
  documentId: string; revision: string; frameId: string; page: DesignPage; pages: readonly DesignPageRoute[]
  mode: 'select' | 'interact' | 'read'; onPick?(pick: DesignElementPick | null): void
  onNavigate?(pageId: string): void; onBack?(): void
  onCanvasWheel?(wheel: DesignCanvasWheel): void
  restoreSelection?: DesignSelection; restoreSilently?: boolean
  onRestoreStatus?(status: 'located' | 'missing' | 'ambiguous'): void; onEscape?(): void; onReady?(): void
}

export const DesignPreview = forwardRef<DesignPreviewPort, DesignPreviewProps>(function DesignPreview(props, ref): JSX.Element {
  const [reload, setReload] = useState(0)
  const identity = useMemo(() => ({ documentId: props.documentId, pageId: props.page.id, frameId: props.frameId, revision: props.revision, nonce: crypto.randomUUID() }), [props.documentId, props.page.id, props.frameId, props.revision, props.page.html, reload])
  const srcDoc = useMemo(() => buildDesignPreviewDocument(props.page, identity, props.pages), [identity, props.pages])
  const frame = useRef<HTMLIFrameElement>(null), latest = useRef(props)
  latest.current = props
  const alive = useRef(false), ready = useRef(false), loads = useRef(0)
  const restoreRequest = useRef<{ id: string; selection: DesignSelection } | null>(null)
  const waiting = useRef(new Map<string, { resolve(valid: boolean): void; timer: ReturnType<typeof setTimeout> }>())
  const [status, setStatus] = useState('正在加载页面…'), [failed, setFailed] = useState(false)
  const post = (type: string, values: Record<string, unknown> = {}): void => { if (alive.current && ready.current) frame.current?.contentWindow?.postMessage({ channel: DESIGN_PREVIEW_CHANNEL, ...identity, type, ...values }, '*') }
  const restore = (): void => {
    const value = latest.current, selection = value.restoreSelection
    const previous = restoreRequest.current
    restoreRequest.current = null
    if (!selection || selection.pageId !== value.page.id || selection.revision !== identity.revision) { if (previous) post('clear'); return }
    const requestId = crypto.randomUUID()
    restoreRequest.current = { id: requestId, selection }
    post('restore', { requestId, selector: selection.selector, outerHTML: selection.outerHTML, notify: !value.restoreSilently })
  }
  useImperativeHandle(ref, () => ({ parent: () => post('parent'), locate: () => post('locate'), clear: () => post('clear'), validate: pick => new Promise(resolve => {
    if (!alive.current || !ready.current || pick.previewNonce !== identity.nonce || pick.revision !== identity.revision || pick.pageId !== identity.pageId) { resolve(false); return }
    const requestId = crypto.randomUUID()
    const timer = setTimeout(() => { waiting.current.delete(requestId); resolve(false) }, 2000)
    waiting.current.set(requestId, { resolve, timer })
    post('validate', { requestId, selector: pick.selector, outerHTML: pick.outerHTML })
  }) }), [identity])
  useLayoutEffect(() => {
    alive.current = true; ready.current = false; loads.current = 0; setFailed(false); setStatus('正在加载页面…')
    let count = 0, wheelCount = 0, since = performance.now()
    const timeout = setTimeout(() => { if (alive.current && !ready.current) { setStatus('页面未能加载，请重新载入。'); setFailed(true) } }, 10_000)
    const receive = (event: MessageEvent<unknown>): void => {
      if (!alive.current) return
      const value = latest.current, message = readDesignPreviewMessage(event, frame.current?.contentWindow ?? null, identity, value.page, value.frameId)
      if (!message) return
      const now = performance.now()
      if (now - since > 1000) { since = now; count = 0; wheelCount = 0 }
      if (message.type === 'wheel' ? ++wheelCount > 240 : ++count > 160) return
      if (message.type === 'ready') { if (ready.current) return; ready.current = true; clearTimeout(timeout); setStatus(''); post('configure', { mode: value.mode, canvasWheel: Boolean(value.onCanvasWheel) }); restore(); value.onReady?.() }
      else if (!ready.current) return
      else if (message.type === 'selection' && value.mode === 'select') { setStatus(''); value.onPick?.(message.pick) }
      else if (message.type === 'wheel' && value.mode === 'select' && value.onCanvasWheel) {
        const node = frame.current, wheel = message.wheel
        if (!node || !node.clientWidth || !node.clientHeight || wheel.x > node.clientWidth || wheel.y > node.clientHeight) return
        const box = node.getBoundingClientRect()
        value.onCanvasWheel({ clientX: box.left + wheel.x * box.width / node.clientWidth, clientY: box.top + wheel.y * box.height / node.clientHeight, deltaX: wheel.deltaX, deltaY: wheel.deltaY, zoom: wheel.zoom })
      }
      else if (message.type === 'clear') value.onPick?.(null)
      else if (message.type === 'navigate' && value.mode === 'interact' && value.pages.some(page => page.id === message.target)) value.onNavigate?.(message.target)
      else if (message.type === 'back' && value.mode === 'interact') value.onBack?.()
      else if (message.type === 'escape' && value.mode === 'select') value.onEscape?.()
      else if (message.type === 'restored' && message.requestId === restoreRequest.current?.id && value.restoreSelection === restoreRequest.current.selection) value.onRestoreStatus?.(message.status)
      else if (message.type === 'notice') setStatus(message.text)
      else if (message.type === 'validated') { const pending = waiting.current.get(message.requestId); if (pending) { clearTimeout(pending.timer); waiting.current.delete(message.requestId); pending.resolve(message.valid) } }
    }
    window.addEventListener('message', receive)
    return () => { alive.current = false; ready.current = false; restoreRequest.current = null; clearTimeout(timeout); window.removeEventListener('message', receive); for (const pending of waiting.current.values()) { clearTimeout(pending.timer); pending.resolve(false) }; waiting.current.clear(); latest.current.onPick?.(null) }
  }, [identity])
  useLayoutEffect(() => { post('configure', { mode: props.mode, canvasWheel: Boolean(props.onCanvasWheel) }); if (props.mode !== 'select') props.onPick?.(null) }, [identity, props.mode, Boolean(props.onCanvasWheel)])
  useLayoutEffect(() => { restore() }, [identity, props.restoreSelection, props.restoreSilently, props.mode])
  return <div className="design-preview" data-design-mode={props.mode}>
    {!failed && <iframe key={identity.nonce} ref={frame} className="design-preview-frame" title={props.page.title} srcDoc={srcDoc} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'" {...{ credentialless: '' }} onLoad={() => {
      if (++loads.current > 1 && alive.current) { ready.current = false; setFailed(true); setStatus('页面离开了原预览，请重新载入。'); latest.current.onPick?.(null); if (restoreRequest.current) latest.current.onRestoreStatus?.('missing') }
    }} />}
    {status && <div className="design-preview-status" role="status"><span>{status}</span>{failed && <Button size="sm" onClick={() => setReload(value => value + 1)}>重新载入</Button>}</div>}
  </div>
})
