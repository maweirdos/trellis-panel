import { useRef, useState, type JSX } from 'react'
import { FileText, Paperclip } from 'lucide-react'
import { api } from '../../api'
import { Button } from '../../my/ui'
import type { useRequirementIntake } from './use-requirement-intake'

type Reference = { documentId: string; versionId: string; title: string; digest: string; byteLength: number }
export function IntakeReferences({ intake, disabled = false }: { intake: ReturnType<typeof useRequirementIntake>; disabled?: boolean }): JSX.Element {
  const [items, setItems] = useState<Reference[]>([]), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [cursor, setCursor] = useState<string | undefined>()
  const uploading = useRef(false)
  const controls = useRef({ disabled, intake })
  controls.current = { disabled, intake }
  const canEdit = (): boolean => !controls.current.disabled && controls.current.intake.canEditInputs()
  const load = async (): Promise<void> => {
    if (!api.teamContent || busy || !canEdit()) return
    setBusy(true)
    try {
      const reply = await api.teamContent.listReferences({ ...intake.scope, cursor })
      if (!intake.source.owns()) return
      if (!reply.ok) { intake.setError(reply.error); return }
      setItems(previous => [...previous, ...reply.data.items.filter(item => !previous.some(old => old.documentId === item.documentId && old.versionId === item.versionId))]); setLoaded(true); setCursor(reply.data.hasMore ? reply.data.nextCursor : undefined)
    } catch (reason) { if (intake.source.owns()) intake.setError(reason instanceof Error ? reason.message : '团队资料读取失败，请稍后重试。') }
    finally { if (intake.source.owns()) setBusy(false) }
  }
  const upload = async (files: FileList | null): Promise<void> => {
    if (!files || uploading.current || !canEdit()) return
    if (intake.files.length + files.length > 4) { intake.setError('一次最多附加4份文本资料。'); return }
    uploading.current = true
    try {
      const selected: { name: string; text: string }[] = []
      for (const file of Array.from(files)) {
        if (!/\.(md|txt|json|csv)$/i.test(file.name) || file.size > 16 * 1024) { intake.setError('请选择16KB以内的Markdown、TXT、JSON或CSV文件。'); return }
        const text = await file.text()
        if (!canEdit()) return
        if (new TextEncoder().encode(text).byteLength > 16 * 1024) { intake.setError('资料解码后超过16KB，请精简文件。'); return }
        selected.push({ name: file.name, text })
      }
      if (canEdit()) intake.setFiles(previous => previous.length + selected.length <= 4 ? [...previous, ...selected] : previous)
    } catch (reason) { if (intake.source.owns()) intake.setError(reason instanceof Error ? reason.message : '文件读取失败，请重新选择。') }
    finally { uploading.current = false }
  }
  return <details className="intake-references"><summary><Paperclip size={14} />结合资料{intake.files.length + intake.references.length ? ` · 已选${intake.files.length + intake.references.length}份` : ''}</summary>
    <div className="intake-reference-body">
      <label className="intake-upload"><span>上传文本资料</span><input type="file" multiple accept=".md,.txt,.json,.csv" disabled={disabled || intake.running || intake.busy} onChange={event => { void upload(event.currentTarget.files); event.currentTarget.value = '' }} /></label>
      {intake.files.map((file, index) => <div className="intake-reference-row" key={`${file.name}:${index}`}><FileText size={13} /><span>{file.name}</span><Button size="sm" variant="ghost" disabled={disabled || intake.running || intake.busy} onClick={() => { if (canEdit()) intake.setFiles(previous => previous.filter((_, current) => current !== index)) }}>移除</Button></div>)}
      <Button size="sm" variant="outline" disabled={disabled || busy || intake.running || intake.busy} onClick={() => void load()}>{busy ? '正在读取资料…' : !loaded ? '选择团队已发布资料' : cursor ? '加载更多资料' : '刷新资料'}</Button>
      {loaded && !items.length && <p>当前工作区没有可引用的已发布资料。可先上传产品说明或客户记录。</p>}
      {items.map(item => <label className="intake-reference-row" key={`${item.documentId}:${item.versionId}`}><input type="checkbox" disabled={disabled || intake.running || intake.busy} checked={intake.references.some(reference => reference.documentId === item.documentId && reference.versionId === item.versionId)} onChange={event => { const checked = event.target.checked; if (canEdit()) intake.setReferences(previous => checked ? previous.length < 8 && !previous.some(reference => reference.documentId === item.documentId && reference.versionId === item.versionId) ? [...previous, { documentId: item.documentId, versionId: item.versionId }] : previous : previous.filter(reference => reference.documentId !== item.documentId || reference.versionId !== item.versionId)) }} /><span>{item.title} · v{item.versionId}</span></label>)}
    </div>
  </details>
}
