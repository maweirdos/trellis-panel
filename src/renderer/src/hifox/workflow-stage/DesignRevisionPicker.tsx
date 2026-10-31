import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { FileText, RefreshCw } from 'lucide-react'
import type { HifoxTask } from '@shared/hifox'
import type { TeamTaskMaterialMetadata, TeamTaskMaterialView } from '@shared/team-task-materials'
import { api } from '../../api'
import { Button } from '../../my/ui'
import { TeamMarkdown } from '../../team/TeamMarkdown'
import { useHifox } from '../store'
import { useInteractionActive } from '../../utils/interaction-scope'
import { useTaskSource } from '../pages/task-detail/use-task-source'
import { Field, inputClass } from '../ui'
import { matchesDesignReference, type DesignReference } from './design-reference'

export function DesignRevisionPicker({ task, purpose, value, onChange, disabled = false }: {
  task: HifoxTask
  purpose: 'submit' | 'approve' | 'read'
  value: DesignReference | null
  onChange?(value: DesignReference | null): void
  disabled?: boolean
}): JSX.Element | null {
  const context = useHifox((state) => state.workspaceContext)
  const source = useTaskSource({ spaceId: task.spaceId, taskId: task.id })
  const latest = useRef(source); latest.current = source
  const active = useInteractionActive()
  const bridge = api && Object.hasOwn(api, 'hifoxMaterials') ? api.hifoxMaterials : undefined
  const scope = useMemo(() => ({ workspaceKey: context.key, spaceId: task.spaceId, taskId: task.id, taskCreatedAt: task.createdAt }), [context.key, task.spaceId, task.id, task.createdAt])
  const [documents, setDocuments] = useState<TeamTaskMaterialMetadata[] | null>(null)
  const [view, setView] = useState<TeamTaskMaterialView | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const requests = useRef(0)
  const selectedKey = value ? JSON.stringify(value) : ''
  useEffect(() => {
    if (!active || !bridge || context.state === 'local' || !latest.current.owns()) return
    const ticket = ++requests.current
    let cancelled = false
    setLoading(true); setError(''); setView(null)
    void (async () => {
      try {
        if (purpose === 'read' && !value) return
        if (purpose !== 'read') {
          const result = await bridge.list({ ...scope, limit: 100 })
          if (cancelled || ticket !== requests.current || !latest.current.owns()) return
          if (!result.ok) throw Error(result.error)
          if (result.value.taskId !== task.id || result.value.taskCreatedAt !== task.createdAt || result.value.spaceId !== task.spaceId || result.value.epoch !== context.epoch) throw Error('材料目录不属于原任务，请重新核对。')
          setDocuments(result.value.page.items.filter((item) => item.kind === 'design')); setHasMore(result.value.page.hasMore)
        }
        if (value) {
          const result = await bridge.read({ ...scope, documentId: value.documentId, versionId: value.versionId })
          if (cancelled || ticket !== requests.current || !latest.current.owns()) return
          if (!result.ok) throw Error(result.error)
          if (!matchesDesignReference(result.value, task, value) || result.value.epoch !== context.epoch) throw Error('设计版本或正文摘要不匹配，请重新选择。')
          setView(result.value)
        }
      } catch (cause) { if (!cancelled && ticket === requests.current && latest.current.owns()) { setDocuments(null); setError(cause instanceof Error ? cause.message : '设计材料未能读取。') } }
      finally { if (!cancelled && ticket === requests.current && latest.current.owns()) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [active, bridge, scope, context.state, context.epoch, context.authorizationRevision, selectedKey, purpose, refresh, task.updatedAt])
  if (context.state === 'local' || !bridge || purpose === 'read' && !value) return null
  const options = (documents ?? []).flatMap((document) => {
    const candidates = purpose === 'approve' ? (document.approved ? [document.approved] : []) : [document.draft, document.latestSubmission, document.approved].filter((item) => item !== null)
    const unique = new Map(candidates.map((item) => [item.versionId, item]))
    return [...unique.values()].map((item) => ({ reference: { documentId: document.documentId, versionId: item.versionId, bodyDigest: item.bodyDigest },
      label: `${document.draft.title} · ${'number' in item ? `v${item.number}` : '固定评审版'} · ${document.approved?.versionId === item.versionId ? '已批准' : document.latestSubmission?.versionId === item.versionId ? document.latestSubmission.status === 'rejected' ? '已退回' : '待评审' : '草稿'}` }))
  })
  return <section className="workflow-design-reference space-y-3" aria-label="共享设计固定版本">
    {purpose !== 'read' && <Field label={purpose === 'approve' ? '关联已批准的共享设计版本（选填）' : '选择共享设计固定版本（选填）'}><select className={inputClass} value={selectedKey} disabled={disabled || loading} onChange={(event) => { if (!latest.current.owns()) return; const selected = options.find((option) => JSON.stringify(option.reference) === event.target.value); onChange?.(selected?.reference ?? null) }}>
      <option value="">使用人工设计说明</option>{value && !options.some((option) => JSON.stringify(option.reference) === selectedKey) && <option value={selectedKey}>原选定固定版本 · 请核对正文</option>}{options.map((option) => <option key={JSON.stringify(option.reference)} value={JSON.stringify(option.reference)}>{option.label}</option>)}
    </select></Field>}
    <div className="flex flex-wrap items-center gap-2 text-my-xs text-my-tertiary"><span className="min-w-0 flex-1">{loading ? '正在核对设计版本…' : purpose === 'read' ? '交接采用的固定设计版本' : documents?.length === 0 ? '尚无共享设计，可先在设计工作区创建。' : purpose === 'approve' ? '文档批准后，在此关联版本并确认开发交接。' : '固定版本随交接保留，后续编辑不会替换本次版本。'}</span><Button size="sm" variant="ghost" disabled={loading || disabled} aria-label="刷新设计版本" onClick={() => setRefresh((current) => current + 1)}><RefreshCw size={13} /></Button></div>
    {hasMore && <p className="text-my-xs text-my-warning-text">目录尚未全部载入；可在共享材料中核对其余设计。</p>}
    {error && <p role="alert" className="collab-inline-error">{error}</p>}
    {view && <details className="rounded-my-md border border-my-line p-3" open={purpose === 'read'}><summary className="cursor-pointer text-my-sm font-medium"><FileText size={14} className="mr-1 inline" />{view.selected.title} · v{view.selected.number}{view.document.approved?.versionId === view.selected.versionId ? ' · 已批准' : ' · 未批准'}</summary><div className="my-scrollbar mt-3 max-h-64 overflow-auto"><TeamMarkdown text={view.text} identity={`${view.document.documentId}:${view.selected.versionId}:${view.selected.bodyDigest}`} /></div><details className="mt-2 text-my-2xs text-my-tertiary"><summary className="cursor-pointer">版本核对信息</summary><p className="mt-1 break-all">版本：{view.selected.versionId} · SHA-256：{view.selected.bodyDigest}</p></details></details>}
  </section>
}
