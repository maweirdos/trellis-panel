import { useEffect, useRef, useState, type JSX } from 'react'
import { FileUp, Loader2, RefreshCw } from 'lucide-react'
import { TASK_OUTPUT_FILES, TASK_OUTPUT_KINDS, type TaskOutputComparison, type TaskOutputPreview, type TaskOutputScope, type TaskOutputStatus, type TaskOutputsApi } from '@shared/hifox-task-outputs'
import { api as nativeApi } from '../../api'
import { Select } from '../../components/Select'
import { Button, Modal } from '../../my/ui'
import { useInteractionActive, useInteractionGuard } from '../../utils/interaction-scope'

type Props = TaskOutputScope & { contextKey: string; api?: TaskOutputsApi; members?: { id: string; name: string }[] }
const labels = { prd: '需求说明', design: '设计说明', implement: '实施计划', 'delivery-note': '交付说明' }
const states = { active: '自动同步', pending: '待发送', unknown: '原结果待核对', conflict: '冲突候选已保留', paused: '已暂停', stopped: '已停止纳管' }
function capability(value: unknown): value is TaskOutputsApi {
  if (!value || typeof value !== 'object') return false
  return ['read', 'preview', 'confirm', 'compare', 'recover'].every(key => key in value && typeof (value as Record<string, unknown>)[key] === 'function')
}
export function TaskOutputs(props: Props): JSX.Element {
  const candidate = nativeApi && 'taskOutputs' in nativeApi ? nativeApi.taskOutputs : undefined
  const client = props.api ?? (capability(candidate) ? candidate : undefined)
  return <OutputsPanel key={JSON.stringify([props.contextKey, props.query, props.expected])} {...props} api={client} />
}
function OutputsPanel({ query, expected, api, members = [] }: Props): JSX.Element {
  const active = useInteractionActive(), ownsInteraction = useInteractionGuard(), mounted = useRef(false), request = useRef(0), locked = useRef(false)
  const root = useRef<HTMLElement>(null), lastRead = useRef(0), currentStatus = useRef<TaskOutputStatus | null>(null)
  const [status, setStatus] = useState<TaskOutputStatus | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const [file, setFile] = useState<typeof TASK_OUTPUT_FILES[number]>('delivery.md'), [documentId, setDocumentId] = useState(''), [approvers, setApprovers] = useState<string[]>([])
  const [preview, setPreview] = useState<TaskOutputPreview | null>(null)
  const [comparedPreview, setComparedPreview] = useState('')
  const [comparison, setComparison] = useState<{ bindingId?: string; previewId?: string; value: TaskOutputComparison; reviewToken?: string } | null>(null)
  const scope = { query, expected }, live = (): boolean => mounted.current && ownsInteraction()
  currentStatus.current = status
  const refresh = async (cursor?: string): Promise<void> => {
    if (!api || !live()) return
    const ticket = ++request.current
    lastRead.current = Date.now()
    try {
      const result = await api.read({ ...scope, ...(cursor ? { cursor } : {}) })
      if (!live() || request.current !== ticket) return
      if (!result.ok) { setStatus(null); setError(result.error); return }
      setStatus(previous => cursor && previous ? { ...result.value, documents: [...new Map([...previous.documents, ...result.value.documents].map(doc => [doc.documentId, doc])).values()].slice(-200) } : result.value)
      setError('')
    } catch (cause) { if (live() && request.current === ticket) { setStatus(null); setError(cause instanceof Error ? cause.message : '产物同步状态无法读取') } }
  }
  useEffect(() => {
    mounted.current = true
    if (!locked.current) setBusy('')
    if (!active) { setPreview(null); setComparison(null) }
    const visible = (): boolean => Boolean(root.current?.getClientRects().length)
    if (active && visible()) void refresh()
    const opened = (event: Event): void => { if (active && !locked.current && event.target instanceof HTMLDetailsElement && event.target.contains(root.current) && visible()) void refresh() }
    document.addEventListener('toggle', opened, true)
    const timer = setInterval(() => {
      const interval = currentStatus.current?.bindings.some(row => row.state === 'pending') ? 3000 : 60_000
      if (active && visible() && !locked.current && Date.now() - lastRead.current >= interval) void refresh()
    }, 3000)
    return () => { mounted.current = false; request.current++; clearInterval(timer); document.removeEventListener('toggle', opened, true) }
  }, [active, api])
  const operate = async (name: string, run: (current: () => boolean) => Promise<void>): Promise<void> => {
    if (!api || !live() || locked.current) return
    locked.current = true; const ticket = ++request.current; setBusy(name); setError('')
    const current = (): boolean => live() && request.current === ticket
    try { await run(current) } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '原产物操作未确认，请刷新核对') }
    finally { locked.current = false; if (live()) setBusy('') }
  }
  const showPreview = (): void => { void operate('preview', async current => {
    if (!api) return
    const result = await api.preview({ ...scope, selection: { file, kind: TASK_OUTPUT_KINDS[file], ...(documentId ? { documentId } : { approverIds: approvers }) } })
    if (!current()) return
    if (result.ok) { setPreview(result.value); setComparedPreview('') } else setError(result.error)
  }) }
  const confirm = (): void => { void operate('confirm', async current => {
    if (!api || !preview) return
    const result = await api.confirm({ ...scope, previewId: preview.previewId })
    if (!current()) return
    if (result.ok) { setStatus(result.value); setPreview(null) } else setError(result.error)
  }) }
  const recover = (bindingId: string, action: 'reconcile' | 'retry' | 'pause' | 'stop' | 'resume', reviewToken?: string): void => { void operate(bindingId, async current => {
    if (!api) return
    const result = await api.recover({ ...scope, bindingId, action, ...(reviewToken ? { reviewToken } : {}) })
    if (!current()) return
    if (result.ok) { setStatus(result.value); if (action === 'resume') setComparison(null) } else setError(result.error)
  }) }
  const compare = (bindingId: string, side: 'local' | 'remote' | 'candidate'): void => { void operate('compare', async current => {
    if (!api) return
    const result = await api.compare({ ...scope, bindingId, side })
    if (!current()) return
    if (result.ok) setComparison(previous => ({ bindingId, value: result.value, reviewToken: result.value.reviewToken ?? (previous?.bindingId === bindingId ? previous.reviewToken : undefined) })); else setError(result.error)
  }) }
  const comparePreview = (): void => { void operate('compare', async current => {
    if (!api || !preview) return
    const result = await api.compare({ ...scope, previewId: preview.previewId, side: 'remote' })
    if (!current()) return
    if (result.ok) { setComparedPreview(preview.previewId); setComparison({ previewId: preview.previewId, value: result.value }) } else setError(result.error)
  }) }
  if (!api) return <section className="text-my-sm text-my-tertiary">此客户端尚未接入本机产物回传，请完整重启后核对。</section>
  const docs = status?.documents.filter(doc => doc.kind === TASK_OUTPUT_KINDS[file]) ?? []
  return <section ref={root} aria-label="本机受管产物" className="min-w-0 space-y-3 text-my-sm">
    <div className="flex items-center justify-between gap-2"><h4 className="flex items-center gap-2 font-medium text-my-primary"><FileUp size={16} />本机产物回传</h4><Button size="sm" disabled={!!busy || !active} onClick={() => void refresh()}><RefreshCw size={14} />刷新</Button></div>
    <p className="text-my-tertiary">明确纳管后，后续稳定保存同步为原任务的共享草稿。审批、采纳和交接仍在团队材料中完成。</p>
    {error && <p role="alert" className="break-words text-my-danger-text">{error}</p>}
    {status?.bindings.map(row => <div className="space-y-2 rounded-my-md border border-my-line p-3" key={row.bindingId}>
      <div className="flex flex-wrap items-center justify-between gap-2"><strong>{row.file} · {labels[row.kind]} · 开发尝试 {row.expected.generation}</strong><span>{states[row.state]}</span></div>
      <p className="break-words text-my-secondary">{row.title}{row.documentId ? ` · ${row.documentId}` : ' · 首次创建待确认'}</p>
      <p className="text-my-tertiary">{row.lastConfirmed ? `最后确认 ${new Date(row.lastConfirmed.at).toLocaleString()} · 草稿 R${row.lastConfirmed.draftRevision}` : '尚无已核对的团队保存回执'}</p>
      {row.inputOutdated && <p className="text-my-tertiary">团队已采用其他输入；本机固定输入未移动，可直接按已批准产物交接。</p>}
      {row.error && <p className="break-words text-my-warning-text">{row.error}</p>}
      {row.pending && <details><summary className="cursor-pointer">原待发意图</summary><p className="mt-1 break-all font-mono text-my-xs">{row.pending.commandId} · {row.pending.digest}</p></details>}
      <div className="flex flex-wrap gap-2">
        {row.pending && <><Button size="sm" disabled={!!busy} onClick={() => compare(row.bindingId, 'candidate')}>查看原正文</Button><Button size="sm" disabled={!!busy} onClick={() => recover(row.bindingId, 'reconcile')}>核对原结果</Button><Button size="sm" disabled={!!busy} onClick={() => recover(row.bindingId, 'retry')}>以原编号重试</Button></>}
        {row.documentId && <Button size="sm" disabled={!!busy} onClick={() => compare(row.bindingId, 'remote')}>比较与恢复</Button>}
        {!row.pending && row.state === 'paused' && <Button size="sm" disabled={!!busy} onClick={() => recover(row.bindingId, 'resume')}>恢复同步</Button>}
        {(row.state === 'active' || row.state === 'pending') && <Button size="sm" disabled={!!busy} onClick={() => recover(row.bindingId, 'pause')}>暂停</Button>}
        {row.state !== 'stopped' && <Button size="sm" disabled={!!busy} onClick={() => recover(row.bindingId, 'stop')}>停止纳管</Button>}
      </div>
    </div>)}
    <div className="space-y-3 rounded-my-md border border-my-line p-3">
      <label className="block space-y-1"><span>任务目录中的文件</span><Select ariaLabel="受管产物文件" disabled={!!busy} value={file} onChange={value => { setFile(value); setDocumentId(''); setPreview(null) }} options={TASK_OUTPUT_FILES.map(value => ({ value, label: `${value} · ${labels[TASK_OUTPUT_KINDS[value]]}` }))} /></label>
      <label className="block space-y-1"><span>团队草稿</span><Select ariaLabel="产物目标文档" disabled={!!busy} value={documentId} onChange={setDocumentId} options={[{ value: '', label: `首次创建${labels[TASK_OUTPUT_KINDS[file]]}` }, ...docs.map(doc => ({ value: doc.documentId, label: `${doc.draft.title} · R${doc.draftRevision}` }))]} /></label>
      {!documentId && <fieldset className="space-y-2"><legend>首次创建的审批人</legend>{members.length ? members.map(member => <label className="flex items-center gap-2" key={member.id}><input type="checkbox" disabled={!!busy} checked={approvers.includes(member.id)} onChange={event => setApprovers(previous => event.target.checked ? [...previous, member.id] : previous.filter(id => id !== member.id))} />{member.name}</label>) : <p className="text-my-tertiary">请先取得原空间的成员列表，或选择已有团队文档。</p>}</fieldset>}
      {status?.hasMore && <Button size="sm" disabled={!!busy} onClick={() => void refresh(status.nextCursor ?? undefined)}>更多团队文档</Button>}
      <Button size="sm" variant="primary" disabled={!!busy || !status || !active || (!documentId && !approvers.length)} onClick={showPreview}>{busy === 'preview' && <Loader2 size={14} className="animate-spin" />}预览并纳管</Button>
    </div>
    {preview && <Modal open ariaLabel="确认纳管本机文件" onClose={() => { if (!busy) setPreview(null) }}><div className="space-y-3"><p className="break-all">{preview.projectRoot} / {preview.taskDir} / {preview.selection.file}</p><p>{preview.title} · {preview.byteLength} 字节 · {preview.documentId ? `原草稿 R${preview.draftRevision}` : '首次创建共享草稿'}</p>{preview.workingPrd && <div className="space-y-2"><p className="text-my-warning-text">这是本机修改后的 PRD 工作草稿，尚未获产品批准。</p><Button size="sm" disabled={!!busy} onClick={comparePreview}>{comparedPreview === preview.previewId ? '重新比较' : '先比较'}：{preview.comparisonTitle}</Button></div>}<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-my-md border border-my-line p-3 text-my-sm">{preview.text}</pre><p className="break-all font-mono text-my-xs text-my-tertiary">SHA-256 {preview.digest}</p>{error && <p role="alert" className="text-my-danger-text">{error}</p>}<div className="flex justify-end gap-2"><Button disabled={!!busy} onClick={() => setPreview(null)}>取消</Button><Button variant="primary" disabled={!!busy || preview.workingPrd && comparedPreview !== preview.previewId} onClick={confirm}>本机确认纳管</Button></div></div></Modal>}
    {comparison && <Modal open ariaLabel="比较受管产物" onClose={() => { if (!busy) setComparison(null) }}><div className="space-y-3">{comparison.bindingId && <div className="flex flex-wrap gap-2">{(['local', 'remote', 'candidate'] as const).map(side => <Button size="sm" key={side} disabled={!!busy} onClick={() => { if (comparison.bindingId) compare(comparison.bindingId, side) }}>{side === 'local' ? '本机正文' : side === 'remote' ? '当前团队草稿' : '原待发或冲突候选'}</Button>)}</div>}<p>{comparison.value.title} · {comparison.value.byteLength} 字节{comparison.value.draftRevision ? ` · 团队草稿 R${comparison.value.draftRevision}` : ''}</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-my-md border border-my-line p-3 text-my-sm">{comparison.value.text}</pre>{error && <p role="alert" className="text-my-danger-text">{error}</p>}{comparison.bindingId && <p className="text-my-tertiary">在本机合并所需内容后，重新读取当前团队草稿，再明确恢复同步。</p>}<div className="flex justify-end gap-2"><Button disabled={!!busy} onClick={() => setComparison(null)}>关闭</Button>{comparison.bindingId && <Button variant="primary" disabled={!!busy || !comparison.reviewToken} onClick={() => { if (comparison.bindingId) recover(comparison.bindingId, 'resume', comparison.reviewToken) }}>以所见草稿为基线恢复</Button>}</div></div></Modal>}
  </section>
}
