import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { DesignPrototypeBundle } from '@shared/design-prototype'
import type { PreviewAnchorStatus, PrototypePreviewProps } from '@shared/creation-preview'
import type { DesignSelection } from '@shared/design-workspace'
import { parsePreviewTarget, PREVIEW_LIMITS } from '../creations/preview-bridge'
import { Button } from '../my/ui'
import { Select } from '../components/Select'
import { DesignPreview } from './DesignPreview'
import './design-workspace.css'

/** Reads only the fixed public body; no personal workspace lookup or command. */
export function DesignPublishedPreview({ bundle, previewProps }: { bundle: DesignPrototypeBundle; previewProps?: PrototypePreviewProps }): JSX.Element {
  const [pageId, setPageId] = useState(bundle.pages[0].id), [history, setHistory] = useState<string[]>([])
  const [anchorStatus, setAnchorStatus] = useState<PreviewAnchorStatus | null>(null), [issue, setIssue] = useState('')
  const latest = useRef(previewProps); latest.current = previewProps
  const page = bundle.pages.find(page => page.id === pageId) ?? bundle.pages[0]
  const routes = useMemo(() => bundle.pages.map(page => ({ id: page.id, title: page.title })), [bundle])
  const targetKey = JSON.stringify(previewProps?.selectedTarget ?? null)
  const target = useMemo(() => parsePreviewTarget(previewProps?.selectedTarget), [targetKey])
  const routePage = (route?: string): string | null => {
    if (!route) return null
    const matches = bundle.pages.filter(page => route === `/${page.id}.html`)
    return matches.length === 1 ? matches[0].id : null
  }
  const selectedPage = routePage(target?.context?.route)
  const restoration = useMemo<{ selection?: DesignSelection; status?: PreviewAnchorStatus; reason?: string }>(() => {
    if (!target) return { status: 'missing' }
    if (target.role || target.name || target.context?.hash || target.context?.fields?.length || target.state && target.state !== 'default') return { status: 'missing', reason: '此批注依赖页面状态或其他定位方式，请在设计页面重新选择元素。' }
    const source = bundle.pages.find(page => page.id === selectedPage)
    if (!source || !target.selector) return { status: 'missing' }
    try {
      const parsed = new DOMParser().parseFromString(source.html, 'text/html'), elements = parsed.querySelectorAll(target.selector)
      if (elements.length > 1) return { status: 'ambiguous' }
      const element = elements[0]
      const text = (element?.textContent ?? '').replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
      if (!element || element.outerHTML.length > 16000 || target.tag && element.tagName.toLowerCase() !== target.tag || target.stableId && element.id !== target.stableId && element.getAttribute('data-preview-id') !== target.stableId || target.text && !text.includes(target.text) || target.selectedText && !text.includes(target.selectedText)) return { status: 'missing' }
      return { selection: { pageId: source.id, revision: bundle.revision, selector: target.selector, tagName: element.tagName.toLowerCase(), text: element.textContent?.slice(0, 4000), outerHTML: element.outerHTML } }
    } catch { return { status: 'missing' } }
  }, [bundle, target, selectedPage])
  useEffect(() => {
    setIssue(''); setAnchorStatus(null)
    if (!latest.current?.selectedTarget) return
    if (selectedPage) setPageId(selectedPage)
    if (restoration.status) { setAnchorStatus(restoration.status); latest.current.onAnchorStatus?.(restoration.status) }
  }, [targetKey, selectedPage, restoration])
  const navigate = (id: string): void => { if (id === pageId || !bundle.pages.some(page => page.id === id)) return; setHistory(values => [...values, pageId]); setPageId(id) }
  const back = (): void => { const id = history.at(-1); if (id) { setHistory(values => values.slice(0, -1)); setPageId(id) } }
  const exitAnnotate = (): void => { if (previewProps?.mode === 'annotate') { previewProps.onInteraction?.({ kind: 'escape' }); previewProps.onExitAnnotate?.() } }
  const style = previewProps?.minHeight !== undefined && Number.isFinite(previewProps.minHeight) && previewProps.minHeight >= 0 ? { '--prototype-preview-min-height': `${previewProps.minHeight}px` } as CSSProperties : undefined
  const status = issue || (anchorStatus === 'missing' ? restoration.reason || '未找到批注目标，页面内容或状态可能已变化。' : anchorStatus === 'ambiguous' ? '存在多个匹配目标，请重新选择。' : previewProps?.mode === 'annotate' ? '点击元素添加批注，按 Esc 退出。' : '')
  return <section className={`design-published-preview${previewProps ? ` prototype-preview${previewProps.className ? ` ${previewProps.className}` : ''}` : ''}`} style={style} data-preview-mode={previewProps?.mode} aria-label={previewProps?.title || '设计原型'} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && previewProps?.mode === 'annotate') { event.preventDefault(); event.stopPropagation(); exitAnnotate() } }}>
    <div className="design-toolbar"><Button size="sm" variant="ghost" disabled={!history.length} onClick={back}><ArrowLeft size={14} />返回</Button><Select size="sm" ariaLabel="原型页面" value={page.id} onChange={navigate} options={bundle.pages.map(page => ({ value: page.id, label: page.title }))} /><span className="my-item-description">{bundle.pages.length} 页</span>{(previewProps?.markers ?? []).slice(0, PREVIEW_LIMITS.markers).filter(marker => routePage(marker.target.context?.route) === page.id).map(marker => <Button size="sm" key={marker.id} aria-label={`查看批注 ${marker.label}`} onClick={() => { previewProps?.onMarkerClick?.(marker.id); previewProps?.onInteraction?.({ kind: 'marker-click', markerId: marker.id }) }}>{marker.label}</Button>)}</div>
    <DesignPreview key={page.id} documentId={bundle.id} revision={bundle.revision} frameId={page.id} page={page} pages={routes} mode={previewProps?.mode === 'annotate' ? 'select' : 'interact'} onNavigate={navigate} onBack={back} restoreSelection={restoration.selection} restoreSilently onReady={() => previewProps?.onInteraction?.({ kind: 'ready' })} onRestoreStatus={status => { if (latest.current?.selectedTarget) { setAnchorStatus(status); latest.current.onAnchorStatus?.(status) } }} onEscape={exitAnnotate} onPick={pick => {
      if (!pick || previewProps?.mode !== 'annotate') return
      const target = parsePreviewTarget({ kind: 'web', selector: pick.selector, tag: pick.tagName, text: (pick.text ?? '').replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LIMITS.text), context: { route: `/${page.id}.html` } })
      if (!target) { setIssue('此元素无法用批注目标定位，请选择其他元素。'); return }
      setIssue(''); previewProps.onSelect(target)
    }} />
    {status && <div className="prototype-preview-status" role="status" aria-live="polite">{status}</div>}
  </section>
}
