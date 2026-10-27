import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../api'
import { Button } from '../my/ui'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import type { AcpSessionRecord } from '../../../shared/types'
import type { PiWebPreviewArtifact, PiWebPreviewLease } from '../../../shared/pi-web-preview'
import { PreviewToolbar } from './PreviewToolbar'

/** Tab visibility does not own the lease. Workspace/project/session lifetime does. */
export function PiWebPreview({ artifact, session, expanded, onToggleExpanded, onClose, active = true }: {
  artifact: PiWebPreviewArtifact; session: AcpSessionRecord; expanded: boolean
  onToggleExpanded: () => void; onClose?: () => void; active?: boolean
}): JSX.Element {
  const root = useApp(state => state.snapshot?.meta.root ?? '')
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  const [attempt, setAttempt] = useState(0)
  const ownerKey = JSON.stringify([session.projectRoot, session.sessionId, session.connectionGeneration, artifact.path])
  const ownerRef = useRef(ownerKey)
  ownerRef.current = ownerKey
  const activeRef = useRef(active)
  activeRef.current = active
  const refreshStatus = useRef<() => void>(() => undefined)
  const [opened, setOpened] = useState<{ ownerKey: string; lease: PiWebPreviewLease } | null>(null)
  const lease = opened?.ownerKey === ownerKey ? opened.lease : null
  const [error, setError] = useState('')
  const [fileRevision, setFileRevision] = useState('')
  const [renderedRevision, setRenderedRevision] = useState('')
  const [externalError, setExternalError] = useState('')
  const [openingExternal, setOpeningExternal] = useState(false)
  const externalRequest = useRef(0)
  const enabled = interactive && !signal?.aborted && projectRootKey(root) === projectRootKey(session.projectRoot)
  useEffect(() => {
    let current = true, owned: PiWebPreviewLease | null = null, polling = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ownsSource = (): boolean => current && ownerRef.current === ownerKey && !signal?.aborted && projectRootKey(useApp.getState().snapshot?.meta.root ?? '') === projectRootKey(session.projectRoot)
    setOpened(null); setError(''); setFileRevision(''); setRenderedRevision(''); setExternalError(''); setOpeningExternal(false)
    externalRequest.current += 1
    if (!enabled) return
    const release = (): void => { if (owned) { const id = owned.id; owned = null; void api.acpPiWebPreviewClose(id).catch(() => undefined) } }
    const stop = (): void => { current = false; if (timer) clearTimeout(timer); release() }
    signal?.addEventListener('abort', stop, { once: true })
    // Fence synchronous root transitions, including a batched A -> B -> A.
    const unsubscribe = useApp.subscribe(state => {
      if (projectRootKey(state.snapshot?.meta.root ?? '') !== projectRootKey(session.projectRoot)) { stop(); setOpened(null); setError('项目已切换，请重新打开预览。') }
    })
    const poll = (): void => {
      if (!ownsSource() || !owned || polling) return
      if (timer) clearTimeout(timer)
      polling = true
      void api.acpPiWebPreviewStatus(owned.id).then(status => {
        if (!ownsSource() || !owned) return
        if (!status.ok) { setError(status.error); return }
        setFileRevision(status.revision); setError('')
      }).catch(() => { if (ownsSource()) setError('无法检查预览更新，请重新加载。') }).finally(() => {
        polling = false
        if (ownsSource()) timer = setTimeout(poll, activeRef.current ? 1500 : 15000)
      })
    }
    refreshStatus.current = poll
    void (async () => {
      try {
        if (typeof api?.acpPiWebPreviewOpen !== 'function') throw new Error('网页预览尚未加载，请完整退出并重启应用。')
        const result = await api.acpPiWebPreviewOpen({ expectedRoot: session.projectRoot, sessionId: session.sessionId, connectionGeneration: session.connectionGeneration, artifact })
        if (!result.ok) throw new Error(result.error)
        owned = result.preview
        if (!ownsSource()) { release(); return }
        const url = new URL(result.preview.url)
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || !/^\/[a-f0-9]{64}\//.test(url.pathname)) throw new Error('预览地址无效')
        setFileRevision(result.preview.revision); setRenderedRevision(result.preview.revision)
        setOpened({ ownerKey, lease: result.preview })
        poll()
      } catch (failure) { release(); if (ownsSource()) setError(failure instanceof Error ? failure.message : '无法打开预览') }
    })()
    return () => { unsubscribe(); signal?.removeEventListener('abort', stop); stop(); refreshStatus.current = () => undefined; externalRequest.current += 1 }
  }, [enabled, session.projectRoot, session.sessionId, session.connectionGeneration, artifact.path, ownerKey, attempt, signal])
  // Hidden tabs collect revisions without disturbing their frame. Activation only
  // reloads when actual file bytes changed, never because visibility changed.
  useLayoutEffect(() => {
    if (active && lease && fileRevision) setRenderedRevision(fileRevision)
  }, [active, lease?.id, fileRevision])
  useEffect(() => { if (active) refreshStatus.current() }, [active])
  const openExternal = async (): Promise<void> => {
    if (!lease || error || openingExternal || !activeRef.current || !canInteract() || !enabled) return
    const request = ++externalRequest.current
    const owner = ownerKey
    const ownsRequest = (): boolean => request === externalRequest.current && ownerRef.current === owner && activeRef.current && canInteract() && projectRootKey(useApp.getState().snapshot?.meta.root ?? '') === projectRootKey(session.projectRoot)
    setOpeningExternal(true); setExternalError('')
    try {
      const result = await api.acpPiWebPreviewOpenExternal(lease.id)
      if (ownsRequest() && !result.ok) setExternalError(result.error)
    } catch { if (ownsRequest()) setExternalError('无法用本机浏览器打开，请重试。') }
    finally { if (request === externalRequest.current) setOpeningExternal(false) }
  }
  const externalAvailable = typeof api?.acpPiWebPreviewOpenExternal === 'function'
  return <section className="acp-web-preview" aria-label={`网页预览：${artifact.title}`}>
    <PreviewToolbar address={lease?.url ?? artifact.path} addressLabel={lease ? '预览入口地址（只读）' : '本地产物来源（只读）'} expanded={expanded} disabled={!enabled} updated={fileRevision !== renderedRevision} openingExternal={openingExternal} onReload={() => setAttempt(value => value + 1)} onToggleExpanded={onToggleExpanded} onClose={onClose} onOpenExternal={lease && !error && externalAvailable ? () => void openExternal() : undefined} externalDisabledReason={!externalAvailable ? '本机浏览器打开尚未加载，请重启应用' : !lease || error ? '预览就绪后可用' : undefined} />
    {enabled && !lease && !error && <div className="acp-web-preview-state" role="status"><Loader2 size={22} className="animate-spin" aria-hidden="true" /><span>正在加载预览…</span></div>}
    {error && <div className={lease ? 'acp-preview-notice' : 'acp-web-preview-state'}><p role="alert" className="text-my-danger-text">{error}</p><Button size="sm" variant="outline" disabled={!enabled} onClick={() => setAttempt(value => value + 1)}>重新加载</Button></div>}
    {externalError && <p role="alert" className="acp-preview-notice text-my-danger-text">{externalError}</p>}
    {lease && enabled && <iframe key={`${lease.id}:${renderedRevision}`} title={artifact.title} src={lease.url} sandbox="allow-scripts" referrerPolicy="no-referrer" className="acp-web-preview-frame" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'" />}
  </section>
}
