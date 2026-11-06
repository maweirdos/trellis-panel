import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { PrototypePreviewProps } from '@shared/creation-preview'
import { parseDesignPrototype } from '@shared/design-prototype'
import { DesignPublishedPreview } from '../designs/DesignPublishedPreview'
import { Button } from '../my/ui'
import {
  PREVIEW_CHANNEL,
  PREVIEW_LIMITS,
  buildPreviewDocument,
  createPreviewNonce,
  parsePreviewMessage,
  parsePreviewTarget,
  readPreviewTheme,
  validatePreviewConfiguration
} from './preview-bridge'
import './prototype-preview.css'

export type { PrototypePreviewProps, PreviewTarget, PreviewMarker, PreviewInteraction, PreviewAnchorStatus } from '@shared/creation-preview'

interface PreviewDocument {
  nonce: string
  srcDoc: string
  error: string | null
}

/** Changing the body creates a fresh frame, nonce, listeners, and restore ownership. */
export function PrototypePreview(props: PrototypePreviewProps): JSX.Element {
  const design = useMemo(() => ({ bundle: parseDesignPrototype(props.body), nonce: createPreviewNonce() }), [props.body])
  return design.bundle ? <DesignPublishedPreview key={design.nonce} bundle={design.bundle} previewProps={props} /> : <LegacyPrototypePreview {...props} />
}

function LegacyPrototypePreview(props: PrototypePreviewProps): JSX.Element {
  const [reload, setReload] = useState(0)
  const document = useMemo<PreviewDocument>(() => {
    const nonce = createPreviewNonce()
    try { return { nonce, srcDoc: buildPreviewDocument(props.body, nonce), error: null } }
    catch { return { nonce, srcDoc: '', error: '内容超过预览大小限制，请缩短后重试。' } }
  }, [props.body, reload])
  return <PreviewSession key={document.nonce} {...props} document={document} onReload={() => setReload((value) => value + 1)} />
}

function PreviewSession({ document: preview, onReload, ...props }: PrototypePreviewProps & { document: PreviewDocument; onReload(): void }): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef(props)
  const session = useRef({ ready: false, active: true, failed: false, requestId: 0, targetKey: '', invalidTarget: false, loads: 0 })
  const configure = useRef<() => void>(() => undefined)
  const [isReady, setReady] = useState(false)
  const [error, setError] = useState<string | null>(preview.error)
  const [resourceBlocked, setResourceBlocked] = useState(false)
  const [navigationBlocked, setNavigationBlocked] = useState(false)
  const [anchorStatus, setAnchorStatus] = useState<'located' | 'missing' | 'ambiguous' | null>(null)
  const title = props.title || '原型预览'

  useLayoutEffect(() => {
    latest.current = props
  })

  useLayoutEffect(() => {
    const target = props.selectedTarget ? parsePreviewTarget(props.selectedTarget) : null
    const key = JSON.stringify(target)
    if (key !== session.current.targetKey) {
      session.current.targetKey = key
      session.current.requestId++
      setAnchorStatus(null)
    }
    if (props.selectedTarget && !target && !session.current.invalidTarget) {
      setAnchorStatus('missing')
      props.onAnchorStatus?.('missing')
    }
    if (!props.selectedTarget && session.current.invalidTarget) setAnchorStatus(null)
    session.current.invalidTarget = Boolean(props.selectedTarget && !target)
    if (session.current.ready) configure.current()
  }, [props.selectedTarget, props.markers, props.mode])

  useLayoutEffect(() => {
    const current = session.current
    current.active = true
    if (preview.error) return () => { current.active = false }
    let messageCount = 0, messageWindow = performance.now()
    const fail = (message: string) => {
      current.ready = false
      current.failed = true
      setError(message)
      setReady(false)
    }
    const timeout = window.setTimeout(() => {
      if (!current.ready && current.active) fail('预览未能启动，请重新加载。')
    }, 10_000)
    configure.current = () => {
      const element = root.current, destination = frame.current?.contentWindow
      if (!element || !destination || !current.active || !current.ready || current.failed) return
      const value = latest.current
      const target = value.selectedTarget ? parsePreviewTarget(value.selectedTarget) : null
      const markers = (value.markers ?? []).slice(0, PREVIEW_LIMITS.markers).flatMap((marker) => {
        const markerTarget = parsePreviewTarget(marker.target)
        return markerTarget ? [{ ...marker, target: markerTarget }] : []
      })
      const configuration = validatePreviewConfiguration({ channel: PREVIEW_CHANNEL, type: 'configure', nonce: preview.nonce, mode: value.mode, target, markers, requestId: current.requestId, theme: readPreviewTheme(element) })
      if (!configuration) { fail('预览配置无效，请检查批注目标后重试。'); return }
      // The opaque child cannot be addressed with a named origin. Send only to this exact frame.
      destination.postMessage(configuration, '*')
    }
    const receive = (event: MessageEvent<unknown>) => {
      if (!current.active || current.failed) return
      const message = parsePreviewMessage(event, frame.current?.contentWindow ?? null, preview.nonce)
      if (!message) return
      const now = performance.now()
      if (now - messageWindow >= 1000) { messageWindow = now; messageCount = 0 }
      if (++messageCount > 120) return
      const value = latest.current
      if (message.type === 'selection') {
        if (current.ready && value.mode === 'annotate') value.onSelect(message.target)
      } else if (message.type === 'anchor-status') {
        if (current.ready && value.selectedTarget && message.requestId === current.requestId) {
          setAnchorStatus(message.status)
          value.onAnchorStatus?.(message.status)
        }
      } else {
        const interaction = message.event
        if (interaction.kind === 'ready') {
          if (current.ready) return
          current.ready = true
          clearTimeout(timeout)
          setReady(true)
          setError(null)
          configure.current()
        } else if (interaction.kind === 'resource-blocked') setResourceBlocked(true)
        else if (interaction.kind === 'navigation-blocked') setNavigationBlocked(true)
        else if (interaction.kind === 'marker-click') {
          if (!current.ready || !value.markers?.some((marker) => marker.id === interaction.markerId)) return
          if (interaction.markerId) value.onMarkerClick?.(interaction.markerId)
        } else if (interaction.kind === 'escape' && value.mode === 'annotate') value.onExitAnnotate?.()
        value.onInteraction?.(interaction)
      }
    }
    window.addEventListener('message', receive)
    const observer = new MutationObserver(() => configure.current())
    const themeRoot = root.current?.closest('.my-root') ?? window.document.documentElement
    observer.observe(themeRoot, { attributes: true, attributeFilter: ['data-my-theme', 'data-my-font-size', 'class', 'style'] })
    return () => {
      current.active = false
      current.ready = false
      clearTimeout(timeout)
      configure.current = () => undefined
      window.removeEventListener('message', receive)
      observer.disconnect()
    }
  }, [preview.nonce])

  const statusText = error || (!isReady ? '正在加载预览…' : anchorStatus === 'missing' ? '未找到批注目标，页面内容或状态可能已变化。' : anchorStatus === 'ambiguous' ? '存在多个匹配目标，请重新选择。' : navigationBlocked ? '此预览仅支持页内导航。' : resourceBlocked ? '已阻止外部脚本或资源；请将内容内嵌到 HTML。' : props.mode === 'annotate' ? '点击元素或选择文字添加批注，按 Esc 退出。' : '')
  const style = props.minHeight !== undefined && Number.isFinite(props.minHeight) && props.minHeight >= 0 ? { '--prototype-preview-min-height': `${props.minHeight}px` } as CSSProperties : undefined
  return (
    <div ref={root} className={`prototype-preview${props.className ? ' ' + props.className : ''}`} style={style} data-preview-mode={props.mode} aria-label={title} onKeyDown={(event) => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing && props.mode === 'annotate') {
        event.preventDefault()
        event.stopPropagation()
        props.onInteraction?.({ kind: 'escape' })
        props.onExitAnnotate?.()
      }
    }}>
      {!error && <iframe
        ref={frame}
        title={title}
        className="prototype-preview-frame"
        srcDoc={preview.srcDoc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'"
        {...{ credentialless: '' }}
        aria-busy={!isReady}
        onLoad={() => {
          const current = session.current
          if (++current.loads > 1 && current.active) {
            current.ready = false
            current.failed = true
            setReady(false)
            setError('页面离开了原预览，请重新加载。')
          }
        }}
      />}
      {statusText && <div className="prototype-preview-status" role="status" aria-live="polite">
        <span>{statusText}</span>
        {error && !preview.error && <Button variant="ghost" size="sm" onClick={onReload}>重新加载</Button>}
      </div>}
    </div>
  )
}
