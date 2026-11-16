import { useEffect, useRef, useState, type JSX } from 'react'
import { Columns2, ExternalLink, X } from 'lucide-react'
import type { FixedDocumentComparison, FixedDocumentVersion, ReaderOrigin } from '../../../shared/document-windows'
import { api } from '../api'
import { Button, Modal } from '../my/ui'
import { Select } from '../components/Select'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { DocumentDiffPanel } from './DocumentDiffPanel'

const kinds: Record<FixedDocumentVersion['kind'], string> = { 'product-requirement': '产品需求', 'trellis-prd': '开发 PRD', design: '设计', spec: '规范', code: '代码', feedback: '反馈', other: '文档' }
const label = (version: FixedDocumentVersion): string => `${kinds[version.kind]} · ${version.relativePath} · ${version.revision.slice(0, 10)} · ${new Date(version.capturedAt).toLocaleString()}`

/** Exact displayed versions only. Opening/comparing never sends content to an agent. */
export function FixedDocumentActions({ version, origin, unavailable }: { version?: FixedDocumentVersion; origin?: ReaderOrigin; unavailable?: string }): JSX.Element {
  const canInteract = useInteractionGuard()
  const interactionActive = useInteractionActive()
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<FixedDocumentVersion[]>([])
  const [candidates, setCandidates] = useState<Array<{ relativePath: string; title: string }>>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [comparison, setComparison] = useState<FixedDocumentComparison | null>(null)
  const sequence = useRef(0)
  const anchor = version?.token
  const currentAnchor = useRef(anchor)
  currentAnchor.current = anchor
  useEffect(() => { sequence.current++; setOpen(false); setComparison(null); setError(null); setBusy(false) }, [anchor])
  useEffect(() => () => { sequence.current++ }, [])
  useEffect(() => {
    if (!interactionActive) { sequence.current++; setOpen(false); setBusy(false) }
  }, [interactionActive])
  const active = (ticket: number, token: string | undefined): boolean => sequence.current === ticket && currentAnchor.current === token && canInteract()
  const catalog = async (more = false): Promise<void> => {
    if (!version || !canInteract()) return
    const ticket = ++sequence.current
    setOpen(true); setBusy(true); setError(null)
    if (!more) { setLeft(version.token); setRight(''); setComparison(null); setVersions([version]) }
    try {
      const result = await api.documentVersions(version.token, more ? cursor ?? undefined : undefined)
      if (!active(ticket, version.token)) return
      if (!result.ok) { setError(result.error); return }
      setVersions((previous) => [...new Map([...(more ? previous : [version]), ...result.versions].map((item) => [item.token, item])).values()])
      setCandidates(result.candidates); setCursor(result.nextCursor)
    } catch (cause) { if (active(ticket, version.token)) setError(cause instanceof Error ? cause.message : '无法列出固定版本') }
    finally { if (active(ticket, version.token)) setBusy(false) }
  }
  const capture = async (relativePath: string): Promise<void> => {
    if (!version || !canInteract()) return
    const ticket = ++sequence.current; setBusy(true); setError(null)
    try {
      const result = await api.documentCaptureVersion(relativePath)
      if (!active(ticket, version.token)) return
      if (!result.ok) { setError(result.error); return }
      setVersions((previous) => [...new Map([...previous, result.version].map((item) => [item.token, item])).values()]); setRight(result.version.token); setComparison(null)
    } catch (cause) { if (active(ticket, version.token)) setError(cause instanceof Error ? cause.message : '读取失败') }
    finally { if (active(ticket, version.token)) setBusy(false) }
  }
  const compare = async (): Promise<void> => {
    if (!version || !left || !right || !canInteract()) return
    const ticket = ++sequence.current; setBusy(true); setError(null)
    try {
      const result = await api.documentCompareVersions({ left, right, requestId: crypto.randomUUID() })
      if (!active(ticket, version.token)) return
      if (result.ok) setComparison(result); else setError(result.error)
    } catch (cause) { if (active(ticket, version.token)) setError(cause instanceof Error ? cause.message : '对照失败') }
    finally { if (active(ticket, version.token)) setBusy(false) }
  }
  const close = (): void => { sequence.current++; setOpen(false); setBusy(false) }
  return <>
    <Button size="sm" variant="ghost" disabled={!version || busy} title={version ? '将当前展示版本作为独立窗口打开' : unavailable ?? '当前正文尚无固定版本'} onClick={() => {
      if (!version || !canInteract()) return
      const token = version.token; const ticket = ++sequence.current
      void api.documentOpenWindow({ token, ...(origin ? { origin } : {}) }).then((result) => { if (active(ticket, token)) setError(result.ok ? null : result.error) }).catch((cause: unknown) => { if (active(ticket, token)) setError(cause instanceof Error ? cause.message : '独立窗口未能打开') })
    }}><ExternalLink size={12} /> 独立窗口</Button>
    <Button size="sm" variant="ghost" disabled={!version || busy} onClick={() => void catalog()}><Columns2 size={12} /> 文档对照</Button>
    {!open && error && <span role="status" className="text-my-xs text-my-danger-text">{error}</span>}
    <Modal open={open} onClose={close} width={1080} ariaLabel="选择两个文档版本对照">
      <div className="flex items-center gap-2 border-b border-my-line px-4 py-3"><h2 className="min-w-0 flex-1 text-my-md font-semibold">选择两份材料或两个版本</h2><Button size="sm" variant="ghost" title="关闭" onClick={close}><X size={14} /></Button></div>
      <div className="my-scrollbar max-h-[70vh] space-y-3 overflow-auto p-4">
        <p className="my-item-description">左侧是基准，右侧是对照版本。已保存版本保留原文；读取当前文件会另存一个版本。</p>
        <div className="grid gap-3 sm:grid-cols-2">{(['left', 'right'] as const).map((side) => <label key={side} className="min-w-0 space-y-1"><span className="my-item-title block">{side === 'left' ? '左：基准材料 / 版本' : '右：对照材料 / 版本'}</span><Select ariaLabel={side === 'left' ? '基准版本' : '对照版本'} className="w-full" value={side === 'left' ? left : right} onChange={(val) => { sequence.current++; setBusy(false); (side === 'left' ? setLeft : setRight)(val); setComparison(null) }} options={[{ value: '', label: '请选择固定版本' }, ...versions.map((item) => ({ value: item.token, label: label(item) }))]} /></label>)}</div>
        <div className="flex flex-wrap items-center gap-2">{candidates.map((item) => <Button key={item.relativePath} size="sm" variant="outline" disabled={busy} onClick={() => void capture(item.relativePath)}>读取{item.title}</Button>)}{version && <Button size="sm" variant="outline" disabled={busy} onClick={() => void capture(version.relativePath)}>读取当前文件版本</Button>}{cursor && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void catalog(true)}>更多历史版本</Button>}</div>
        <div className="flex gap-2"><input className="my-input min-w-0 flex-1" aria-label="其他材料的项目相对路径" placeholder="其他材料：输入项目相对路径，例如 docs/product-requirements.md" value={path} onChange={(event) => setPath(event.target.value)} /><Button size="sm" variant="outline" disabled={busy || !path.trim()} onClick={() => void capture(path.trim())}>读取材料</Button></div>
        <div className="flex items-center gap-3"><Button size="sm" variant="primary" disabled={busy || !left || !right} onClick={() => void compare()}>{busy ? '处理中…' : '对照所选版本'}</Button>{error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}</div>
        {comparison && <DocumentDiffPanel state={{ mode: 'selected-versions', loading: false, outcome: comparison.outcome, comparisonLabels: { left: label(comparison.left), right: label(comparison.right) } }} displayedRevision={comparison.left.revision} latestRevision={comparison.right.revision} onClose={() => setComparison(null)} />}
      </div>
    </Modal>
  </>
}
