import { useId, useState, type JSX } from 'react'
import { ArrowLeft, Check, ChevronRight, FileText, Loader2, Send, Sparkles, X } from 'lucide-react'
import type { CruxSnapshot } from '@shared/crux'
import { MarkdownView } from '../../components/MarkdownView'
import { TeamContentSettings } from '../../components/team/TeamContentSettings'
import { Button, DisclosureGrid } from '../../my/ui'
import { useEscLayer } from '../../utils/use-esc-layer'
import { useCrux } from '../store'
import { useTaskDraftField, type TaskDraft } from '../pages/task-detail/task-drafts'
import { useRequirementIntake } from './use-requirement-intake'
import { useIntakeSave } from './use-intake-save'
import { IntakeReferences } from './IntakeReferences'
import { spaceMemberResponsibilities, WorkflowSpaceMembers } from '../workflow-stage/WorkflowSpaceMembers'
import { Select } from '../ui'
import './intake.css'

export function RequirementIntake({ snapshot, spaceId, actorId, draft, onClose, onManual }: { snapshot: CruxSnapshot; spaceId: string; actorId: string; draft: TaskDraft; onClose(): void; onManual(): void }): JSX.Element {
  const escapeId = useId()
  useEscLayer(true, { id: `requirement-intake-${escapeId}`, kind: 'preview', onClose })
  const intake = useRequirementIntake(snapshot, spaceId, actorId, draft)
  const space = snapshot.spaces.find(item => item.id === spaceId)
  const members = snapshot.members.filter(member => space?.memberIds.includes(member.id))
  const [reviewerId, setReviewerId] = useTaskDraftField(draft, 'intakeReviewer', members.find(member => member.id !== actorId)?.id ?? '')
  const saved = useIntakeSave(intake, draft, spaceId, actorId, reviewerId, onClose)
  const [editing, setEditing] = useState(false)
  const [showDocument, setShowDocument] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  const [addingReviewers, setAddingReviewers] = useState(false)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const context = useCrux(state => state.workspaceContext)
  const seedTask = snapshot.tasks.find(task => task.id === intake.taskId && task.createdAt === intake.taskCreatedAt && task.spaceId === spaceId)
  const canManageSpace = Boolean(space && !space.archived && (context.canManage || space.ownerId === actorId))
  const workspaceBusy = useCrux(state => state.busy)
  const available = Boolean(intake.readiness?.capabilities.includes('requirements') && !['unconfigured', 'disabled', 'protection-unavailable'].includes(intake.readiness.status))
  const disabled = intake.busy || intake.running || saved.saving || workspaceBusy || !intake.source.canWrite()
  const inputDisabled = disabled || saved.locked || intake.taskSaveUnknown || Boolean(intake.commandId || intake.cancelCommand) || intake.job?.state === 'unknown'
  const saveDisabled = disabled || intake.taskSaveUnknown || !intake.candidate.trim() || intake.job?.state !== 'succeeded' || intake.job.cancelRequested || Boolean(intake.commandId || intake.cancelCommand) || intake.staleInputs || Boolean(intake.answer.trim()) || !seedTask
  const canSend = !inputDisabled && available && Boolean(intake.original.trim()) && (!intake.candidate || Boolean(intake.answer.trim()) || intake.staleInputs)
  const started = Boolean(intake.taskId || intake.job || intake.candidate)
  const openTask = (): void => { if (intake.source.owns() && intake.taskId) { onClose(); useCrux.getState().openTask(intake.taskId) } }
  return <section className="requirement-intake" aria-label="需求准备">
    <header className="intake-header">
      <div className="intake-header-title"><Button size="sm" variant="ghost" aria-label="返回任务" onClick={onClose}><ArrowLeft size={16} /></Button><span>任务</span><span aria-hidden="true">/</span><strong>{seedTask?.title || '新需求'}</strong></div>
      <div className="intake-utilities">{intake.candidate && <Button size="sm" variant="ghost" onClick={() => setShowDocument(value => !value)}>{showDocument ? '返回讨论' : '查看需求说明'}</Button>}{intake.taskId && <Button size="sm" variant="ghost" onClick={openTask}>打开任务 {intake.taskId}</Button>}<Button size="sm" variant="ghost" aria-label="关闭需求准备" onClick={onClose}><X size={16} /></Button></div>
    </header>
    <div className={`intake-layout${showDocument && intake.candidate ? ' has-artifact' : ''}`}>
      {showDocument && intake.candidate && <section className="intake-artifact" aria-label="需求说明候选">
        <div className="intake-artifact-heading"><h2><FileText size={16} />需求说明</h2><Button size="sm" variant="ghost" onClick={() => setEditing(value => !value)}>{editing ? '阅读预览' : '直接修改正文'}</Button></div>
        {editing ? <textarea className="intake-editor" aria-label="需求候选正文" value={intake.candidate} disabled={inputDisabled} onChange={event => intake.setCandidate(event.target.value)} /> : <div className="intake-markdown"><MarkdownView content={intake.candidate} /></div>}
        <footer className="intake-footer"><div className="intake-review"><label className="flex items-center gap-2"><span>评审同事</span><Select ariaLabel="需求评审人" disabled={inputDisabled} value={reviewerId} onChange={setReviewerId} options={[{ value: '', label: '请选择评审同事' }, ...(reviewerId && !members.some(member => member.id === reviewerId) ? [{ value: reviewerId, label: '原评审同事已不在空间', disabled: true }] : []), ...members.map(member => ({ value: member.id, label: `${member.name}${member.id === actorId ? '（自己）' : ''} · ${spaceMemberResponsibilities(member)}` }))]} /></label><Button variant="outline" disabled={saveDisabled || Boolean(saved.locked && saved.mode !== 'draft')} onClick={() => void saved.save('draft')}>{saved.saving && saved.mode === 'draft' && <Loader2 size={15} className="animate-spin" />}{saved.mode === 'draft' && saved.step || '保存需求草稿'}</Button><Button variant="primary" disabled={saveDisabled || !members.some(member => member.id === reviewerId) || Boolean(saved.locked && saved.mode !== 'review')} onClick={() => void saved.save('review')}>{saved.saving && saved.mode === 'review' && <Loader2 size={15} className="animate-spin" />}{saved.mode === 'review' && saved.step || '采用并提交评审'}</Button></div></footer>
      </section>}
      <section className={`intake-conversation${started ? ' is-started' : ' intake-empty'}`} aria-label="需求讨论">
        {started && <div className="intake-thread my-scrollbar">
          <div className="intake-message"><div className="intake-message-head">我</div><p>{intake.original}</p>{intake.files.map((file, index) => <p key={`${file.name}:${index}`}><FileText size={14} /> {file.name}</p>)}</div>
          {intake.job && <div className="intake-message"><div className="intake-message-head"><Sparkles size={15} /> 产品助手</div><div className="intake-model-result" role="status"><span>{intake.running ? '正在结合资料整理需求…' : intake.job.state === 'succeeded' && !intake.job.cancelRequested ? '需求候选已生成，可以查看并继续调整。' : '本轮整理未完成。'}</span>{(intake.running || intake.cancelCommand) && <Button size="sm" variant="ghost" disabled={intake.busy || saved.saving || saved.locked} onClick={() => void intake.cancel()}>{intake.cancelCommand ? '核对取消请求' : '取消整理'}</Button>}</div>{intake.candidate && !showDocument && <Button size="sm" variant="outline" onClick={() => setShowDocument(true)}><FileText size={14} />查看需求说明</Button>}</div>}
          {intake.taskId && <p role="status" className="intake-saved"><Check size={14} />素材已保存为任务 <button type="button" onClick={openTask}>{intake.taskId}</button></p>}
          <div className="intake-evidence">
            <button type="button" aria-expanded={evidenceOpen} onClick={() => setEvidenceOpen((v) => !v)} className="inline-flex cursor-pointer items-center gap-1 text-left transition-colors hover:text-my-primary">
              <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${evidenceOpen ? 'rotate-90' : ''}`} />
              <span>查看本轮依据</span>
            </button>
            <DisclosureGrid open={evidenceOpen}>
              <div className="mt-2 space-y-1">
                <p>包括输入诉求、上传文本、所选资料版本与适用的已发布团队规范。提供依据不代表模型已遵守；此入口未读取 Git 源码。</p>
                {intake.job?.sources.map(source => <p key={source.sourceId}><strong>{source.title ?? source.sourceId}{source.versionNumber ? ` · v${source.versionNumber}` : ''}</strong><small>{source.kind} · SHA-256 {source.digest}</small></p>)}
              </div>
            </DisclosureGrid>
          </div>
          {seedTask && canManageSpace && <div><Button size="sm" variant="ghost" disabled={inputDisabled} aria-expanded={addingReviewers} onClick={() => setAddingReviewers(value => !value)}>{addingReviewers ? '收起评审同事' : '添加评审同事'}</Button>{addingReviewers && <WorkflowSpaceMembers key={`${intake.scope.workspaceKey}:${seedTask.id}:${seedTask.createdAt}`} snapshot={snapshot} task={seedTask} creating returnLabel="返回需求评审" onAdded={ids => { const peer = ids.find(id => id !== actorId); if (intake.source.owns() && peer) setReviewerId(peer) }} onClose={() => setAddingReviewers(false)} />}</div>}
        </div>}
        {!started && <div className="intake-empty-heading"><span>产品助手</span><h2>这次想解决什么？</h2></div>}
        <div className="intake-composer">
          <textarea className="intake-compose-field" aria-label={intake.candidate ? '补充需求或回答问题' : '客户原始诉求'} autoFocus rows={started ? 3 : 5} placeholder={intake.candidate ? '说说你的想法…' : '描述你的想法，或放入一份需求资料…'} value={intake.candidate ? intake.answer : intake.original} disabled={inputDisabled} onChange={event => intake.candidate ? intake.setAnswer(event.target.value) : intake.setOriginal(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing && canSend) { event.preventDefault(); void intake.run() } }} />
          <div className="intake-compose-controls"><IntakeReferences intake={intake} disabled={inputDisabled} />{intake.commandId || intake.job?.state === 'unknown' ? <Button disabled={disabled || saved.locked} onClick={() => void intake.reconcile()}>核对原请求</Button> : <Button variant="primary" disabled={!canSend} aria-label={intake.candidate ? '发送补充，更新需求' : '保存素材并开始讨论'} onClick={() => void intake.run()}>{intake.busy || intake.running ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}</Button>}</div>
        </div>
        <div className="intake-utilities">{!intake.taskId && <Button size="sm" variant="ghost" disabled={inputDisabled} onClick={onManual}>手动填写</Button>}{intake.readiness?.canManage && <Button size="sm" variant="ghost" disabled={inputDisabled} aria-expanded={configuring} onClick={() => setConfiguring(value => !value)}>{configuring ? '收起团队 AI 设置' : '团队 AI 设置'}</Button>}</div>
        {!available && <div className="intake-availability"><strong role="status">{intake.readiness ? '团队 AI 尚未就绪' : '正在核对团队 AI'}</strong><p>{intake.readiness?.canManage ? '请配置团队 AI，已输入的素材会保留。' : '请联系团队管理员开放需求整理能力。'}</p><Button size="sm" variant="ghost" disabled={inputDisabled} onClick={() => void intake.refreshReadiness()}>重新检查</Button></div>}
        {configuring && intake.readiness?.canManage && <fieldset disabled={inputDisabled}><TeamContentSettings workspaceKey={intake.scope.workspaceKey} teamId={intake.readiness.teamId} onChanged={() => { void intake.refreshReadiness(); setConfiguring(false) }} /></fieldset>}
        {intake.staleInputs && <p role="status">素材已变化，请发送补充并更新需求后再采用。</p>}{saved.locked && <p role="status">本次保存已固定正文、资料和保存方式，请继续核对原请求。</p>}{intake.taskSaveUnknown && <p role="alert" className="intake-error">原任务保存结果尚未确认，请在工作区待处理操作中核对原请求。</p>}{intake.error && <p role="alert" className="intake-error">{intake.error}</p>}{!intake.source.available && <p role="alert" className="intake-error">原需求任务或访问权限已变化，请关闭后重新核对。</p>}
      </section>
    </div>
  </section>
}
