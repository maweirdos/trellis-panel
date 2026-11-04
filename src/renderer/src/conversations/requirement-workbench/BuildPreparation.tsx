import { useEffect, useRef, useState, type JSX } from 'react'
import { CircleAlert, FolderOpen, Loader2, X } from 'lucide-react'
import { requirementTargetSelectionSchema, type RequirementTargetSelection, type RequirementView } from '@shared/conversation-requirements'
import { Button, Modal } from '../../my/ui'
import { useInteractionGuard } from '../../utils/interaction-scope'
import { projectRootKey } from '../../my/navigation'
import { useApp } from '../../store'
import { conversationClient, conversationError, conversationValue } from '../client'
import { isPrivateEntrySelected } from '../source'
import { openConversationSettings } from '../Conversation'
import { useConversations } from '../workspace'
import type { RequirementBuildPreparation } from './useRequirementWorkbench'
import './execution.css'

export type RequirementBuildChoice = { agentId: string; root: string; targetId?: string; selection?: RequirementTargetSelection }

/** Collect choices only; the owning workbench persists and submits the original command. */
export function BuildPreparation({ entryKey, request, initialAgentId, onResolve }: { entryKey: string; request: RequirementBuildPreparation; initialAgentId?: string; onResolve(value: RequirementBuildChoice | null): void }): JSX.Element {
  const entry = useConversations(state => state.entries[entryKey]), runtimes = useConversations(state => state.runtimes)
  const canInteract = useInteractionGuard(), conversationId = entry?.conversation?.id
  const [view, setView] = useState<RequirementView>(), [target, setTarget] = useState<Omit<RequirementBuildChoice, 'agentId'>>()
  const [agentId, setAgentId] = useState(initialAgentId ?? entry?.runtimeId ?? ''), [pending, setPending] = useState('read'), [error, setError] = useState('')
  const generation = useRef(0), mounted = useRef(true)
  const draftKey = `tpanel.requirement-build-draft.v1.${encodeURIComponent(entry?.conversation?.creatorId ?? '')}.${conversationId}.${request.draftId}`
  const current = (): boolean => mounted.current && canInteract() && isPrivateEntrySelected(entryKey)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  useEffect(() => {
    const ticket = ++generation.current, client = conversationClient()
    if (!client || !conversationId) { setError('原需求当前不可读取。'); setPending(''); return }
    setPending('read'); setError('')
    void client.requirements.read(conversationId, request.draftId).then(result => {
      const incoming = conversationValue(result), draft = incoming.draft
      if (!current() || ticket !== generation.current) return
      if (draft.id !== request.draftId || draft.conversationId !== conversationId || draft.creatorId !== entry?.conversation?.creatorId || draft.revision !== request.expectedRevision || draft.plan?.revision !== request.expectedPlanRevision || draft.plan.stale || incoming.fileState !== 'saved' || incoming.planFileState !== 'saved') throw new Error('需求或计划已变化，请返回核对后重新准备。')
      setView(incoming)
      let next: Omit<RequirementBuildChoice, 'agentId'> | undefined
      if (draft.handoff?.task) next = { root: draft.handoff.task.root, ...(draft.target ? { targetId: draft.target.id } : {}) }
      else if (draft.target) next = { root: draft.target.root, targetId: draft.target.id }
      else if (entry?.conversation?.kind === 'code' && entry.conversation.workspace.kind === 'directory') next = { root: entry.conversation.workspace.root, selection: { kind: 'code' } }
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(draftKey) ?? 'null')
        if (saved && typeof saved === 'object' && 'revision' in saved && 'planRevision' in saved && saved.revision === request.expectedRevision && saved.planRevision === request.expectedPlanRevision) {
          if ('agentId' in saved && typeof saved.agentId === 'string' && /^[\w.-]{1,100}$/.test(saved.agentId)) setAgentId(saved.agentId)
          if (!draft.handoff?.task && 'target' in saved && saved.target && typeof saved.target === 'object' && 'root' in saved.target && typeof saved.target.root === 'string') {
            const candidate = saved.target, candidateRoot = saved.target.root, selected = 'selection' in candidate ? requirementTargetSelectionSchema.safeParse(candidate.selection) : undefined
            if ('targetId' in candidate && typeof candidate.targetId === 'string' && draft.target?.id === candidate.targetId && projectRootKey(draft.target.root) === projectRootKey(candidateRoot)) next = { root: candidateRoot, targetId: candidate.targetId }
            else if (selected?.success && selected.data.kind === 'code' && entry?.conversation?.kind === 'code' && entry.conversation.workspace.kind === 'directory' && projectRootKey(entry.conversation.workspace.root) === projectRootKey(candidateRoot)) next = { root: candidateRoot, selection: selected.data }
            else if (selected?.success && selected.data.kind === 'directory') next = { root: candidateRoot, selection: selected.data }
          }
        }
      } catch { /* A damaged local choice is never treated as a grant. */ }
      setTarget(next)
    }).catch(cause => { if (current() && ticket === generation.current) setError(conversationError(cause)) }).finally(() => { if (current() && ticket === generation.current) setPending('') })
    return () => { generation.current++ }
  }, [entryKey, conversationId, request.draftId, request.expectedRevision, request.expectedPlanRevision])
  const available = runtimes.filter(item => item.enabled && item.available)
  useEffect(() => { if (!agentId && available.length) setAgentId(available[0].id) }, [agentId, runtimes])
  useEffect(() => {
    if (!view || !current()) return
    try { localStorage.setItem(draftKey, JSON.stringify({ revision: request.expectedRevision, planRevision: request.expectedPlanRevision, agentId, target })) }
    catch { setError('构建选择无法保存，请检查本地存储。') }
  }, [view, target, agentId, draftKey, request.expectedRevision, request.expectedPlanRevision])
  const chooseDirectory = async (): Promise<void> => {
    const client = conversationClient()
    if (!client || pending || !current() || view?.draft.handoff?.task) return
    const ticket = ++generation.current; setPending('directory'); setError('')
    try {
      const selected = conversationValue(await client.pickDirectory({ purpose: 'trellis-requirement' }))
      if (selected && current() && ticket === generation.current) setTarget({ root: selected.path, selection: { kind: 'directory', grantId: selected.grantId } })
    } catch (cause) { if (current() && ticket === generation.current) setError(conversationError(cause)) }
    finally { if (current() && ticket === generation.current) setPending('') }
  }
  const ready = Boolean(view && target && (target.targetId || target.selection || view.draft.handoff?.task) && available.some(item => item.id === agentId) && !pending && !error)
  return <Modal open onClose={() => onResolve(null)} width={760} ariaLabel="准备构建" placement="center"><section className="requirement-execution my-scrollbar">
    <header className="requirement-execution-header"><FolderOpen size={17} aria-hidden="true" /><h2 className="my-item-title">准备构建</h2><Button variant="ghost" size="sm" aria-label="关闭构建准备" onClick={() => onResolve(null)}><X size={15} /></Button></header>
    <div className="requirement-execution-body">
      {pending === 'read' && <p className="my-activity-note" role="status"><Loader2 size={14} className="animate-spin" />正在核对需求与计划…</p>}
      {view && <><h3 className="my-item-title">{view.draft.title}</h3>
        <div className="requirement-execution-review"><span className="my-item-title">目标工程</span><span className="my-item-description break-all">{target?.root ?? '尚未选择工程'}</span>{!view.draft.handoff?.task && <div className="requirement-workbench-line"><Button size="sm" variant="outline" disabled={Boolean(pending)} onClick={() => void chooseDirectory()}>{target ? '更换工程' : '选择工程'}</Button>{entry?.conversation?.kind === 'code' && entry.conversation.workspace.kind === 'directory' && projectRootKey(target?.root) !== projectRootKey(entry.conversation.workspace.root) && <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => setTarget({ root: entry.conversation?.workspace.root ?? '', selection: { kind: 'code' } })}>使用当前 Code 工程</Button>}</div>}</div>
        <label className="requirement-execution-engine"><span className="my-item-title">执行引擎</span><select className="my-input" value={agentId} disabled={Boolean(pending)} onChange={event => setAgentId(event.target.value)} aria-label="执行引擎">{agentId && !available.some(item => item.id === agentId) && <option value={agentId} disabled>{runtimes.find(item => item.id === agentId)?.name ?? agentId}（不可用）</option>}{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {!available.length && <p className="my-item-description" role="status">当前没有可用执行引擎，请先完成引擎设置。</p>}
        <div className="requirement-workbench-line"><Button size="sm" variant="ghost" onClick={() => { onResolve(null); openConversationSettings() }}>配置引擎与默认模型</Button><Button size="sm" variant="ghost" onClick={() => { onResolve(null); useApp.getState().setPage('models') }}>管理模型连接</Button></div>
        <div className="requirement-execution-review"><span className="my-item-title">执行方式与权限</span><span className="my-item-description">使用所选工程；不会自动创建隔离工作副本。托管阶段会使用独立会话和引擎默认配置，实际模型与权限以引擎报告为准。执行准备完成后可查看和调整发起会话提供的选项；这些临时选择不会自动传给托管阶段。工具请求由原生授权处理，无法交互时拒绝。</span></div>
        <div className="requirement-execution-review"><span className="my-item-title">固定版本</span><span className="my-item-description break-all">需求 {view.draft.confirmed?.revision ?? '未确认'} · 计划 {view.draft.plan?.revision ?? '未确认'}</span><span className="my-item-description">{request.knowledgeSources?.length ?? 0} 项已采用来源 · {request.directKnowledge?.sources.length ?? 0} 项直接摘录 · {request.designSources?.length ?? 0} 项设计文件 · {view.draft.references.length} 项附件</span></div>
      </>}
      {error && <p className="my-item-description" role="alert"><CircleAlert size={14} aria-hidden="true" /> {error}</p>}
      <div className="requirement-workbench-line"><Button size="sm" variant="primary" disabled={!ready} onClick={() => { if (ready && target && current()) onResolve({ ...target, agentId }) }}>{view?.draft.handoff?.task ? '继续原任务准备' : '确认并准备执行'}</Button><span className="my-item-description">准备后先审阅规划，工作流启动需再次确认。</span></div>
    </div>
  </section></Modal>
}
