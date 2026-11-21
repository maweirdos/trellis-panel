import { Select } from '../../components/Select'
import { lazy, Suspense, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent, type RefObject, type ReactNode } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, FileInput, FileText, FolderOpen, GitCompareArrows, ListChecks, Loader2, MessageCircle, MoreHorizontal, Paperclip, Quote, RefreshCw, Save, Search, Sparkles, Users, X } from 'lucide-react'
import { AgentActivityMark } from '../../acp/AgentActivityMark'
import { hasRequirementContent, REQUIREMENT_FILE_BYTES, type RequirementAction, type RequirementDocument, type RequirementOperation, type RequirementView } from '@shared/conversation-requirements'
import type { CruxTask } from '@shared/crux'
import { MarkdownView } from '../../components/MarkdownView'
import { Button, Checkbox, Dropdown, DropdownItem, Modal } from '../../my/ui'
import { statusLabel } from '../../utils/labels'
import { PrivateConversation, type PrivateConversationAssistantPort } from '../Conversation'
import { KnowledgePicker } from './KnowledgePicker'
import { AdoptedEvidence } from './AdoptedEvidence'
import { DesignContext } from './DesignContext'
import { requirementReadingLocation, rememberRequirementReading } from './reading-position'
import { designHandoffKey } from './workbench-state'
import { useRequirementWorkbench, type RequirementWorkbenchController, type RequirementWorkbenchOptions } from './useRequirementWorkbench'
import './workbench.css'

const DocumentEditor = lazy(() => import('./DocumentEditor'))
export interface TeamHandoffFeedback {
  state: 'working' | 'created' | 'failed'
  message: string
  taskId?: string
}

export interface RequirementWorkbenchProps extends RequirementWorkbenchOptions {
  boundTask?: CruxTask
  onViewTeamTask?(taskId: string): void
  arrangement?: ReactNode
  teamHandoffFeedback?: TeamHandoffFeedback | null
  onClose(): void
  onTeamHandoff?(view: RequirementView, trigger: HTMLButtonElement, task?: CruxTask): void
}
const actionLabels: Record<RequirementAction, string> = { clarify: '澄清问题', research: '研究资料', draft: '生成需求', revise: '修改文档', acceptance: '检查验收', plan: '生成计划', discuss: '讨论需求' }
const stateLabels: Record<RequirementOperation['state'], string> = { reserved: '已准备', dispatching: '正在派发', running: '处理中', completed: '已完成', candidate: '待采用', adopted: '已采用', failed: '未完成', cancelled: '已取消', unknown: '待核对' }
const instructions: Record<RequirementAction, string> = {
  clarify: '请根据当前草稿，找出目标、范围和关键缺口，提出少量可回答的问题。',
  research: '请研究所选资料，区分已有事实、推断和待确认事项，并说明依据。',
  draft: '请根据当前草稿整理目标、范围和可验证的验收标准；不确定的内容列为待确认。',
  acceptance: '请补充当前文档的验收标准和异常情况；不确定的内容列为待确认。',
  revise: '请根据我的要求修改当前文档，保留无关内容和已有约束。',
  plan: '请根据当前需求生成实施计划。', discuss: '请结合当前文档回答我的问题。'
}
function adoptedSourceOperation(operations: RequirementOperation[]): RequirementOperation | undefined {
  return [...operations].reverse().find(operation => operation.state === 'adopted' && operation.knowledge.length > 0)
}

function WorkbenchFeedback({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const issue = controller.issue, commandIssue = controller.buffer?.commandIssue
  const native = [controller.current?.nativeError, controller.current?.session?.status === 'error' ? controller.current.session.error : undefined].filter(Boolean)
  // Native connection recovery is already rendered once by the original assistant controller.
  const nativeDuplicate = issue?.kind === 'operation' && native.some(message => message === issue.message || Boolean(message && issue.message.includes(message)) || /running daemon.*(?:outdated|unverified)|different installed version owns this daemon/i.test(`${message} ${issue.message}`))
  if ((!issue || nativeDuplicate) && !commandIssue) return null
  const title = commandIssue ? '原操作需要核对' : issue?.kind === 'save' ? '文档保存未完成' : issue?.kind === 'handoff' ? '任务交接未完成' : issue?.kind === 'successor' ? '后续需求未打开' : issue?.kind === 'load' ? '需求读取未完成' : '本次操作未完成'
  return <div className="requirement-workbench-feedback" role="alert"><CircleAlert size={15} aria-hidden="true" /><span className="my-item-title">{title}</span><Button size="sm" variant="ghost" disabled={!controller.active || controller.busy} onClick={() => void (issue?.kind === 'save' ? controller.save() : issue?.kind === 'successor' ? controller.openSuccessor() : issue?.kind === 'operation' || commandIssue ? controller.checkOperations() : controller.reload())}>{issue?.kind === 'save' ? '重试保存' : issue?.kind === 'successor' ? '检查原后续需求' : issue?.kind === 'operation' || commandIssue ? '检查原操作' : '重新读取'}</Button><details><summary className="my-item-description">原因</summary><pre>{commandIssue ?? issue?.message}</pre></details></div>
}

function TeamHandoffFeedbackView({ feedback, trigger, onView }: { onView?(id: string): void; feedback: TeamHandoffFeedback; trigger?: RefObject<HTMLButtonElement | null> }): JSX.Element {
  const retry = (): void => {
    const button = trigger?.current
    if (button && !button.disabled) button.click()
  }
  return <div className="requirement-workbench-feedback" role={feedback.state === 'failed' ? 'alert' : 'status'} aria-live="polite">
    {feedback.state === 'working' ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : feedback.state === 'created' ? <Check size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
    {feedback.state === 'created' && feedback.taskId && onView ? <Button size="sm" variant="ghost" onClick={() => onView(feedback.taskId!)}>{feedback.message}</Button> : <><span className="my-item-title">{feedback.state === 'working' ? '正在共享需求版本' : feedback.state === 'created' ? '已共享需求版本' : '需求版本共享未完成'}</span>
    <span className="my-item-description">{feedback.message}</span></>}
    {feedback.state === 'failed' && <Button size="sm" variant="outline" onClick={retry}>重试共享</Button>}
  </div>
}

function Sources({ controller, entryKey }: { controller: RequirementWorkbenchController; entryKey: string }): JSX.Element | null {
  const value = controller.buffer, [visibleFiles, setVisibleFiles] = useState(50), fieldsId = useId()
  if (!value || !controller.view) return null
  const current = controller.current
  const adopted = adoptedSourceOperation(value.operations)
  const handoffSources = value.operations.filter(operation => operation.state === 'adopted').flatMap(operation => operation.knowledge.map(source => ({ operation, source, key: JSON.stringify([operation.id, source.sourceId, source.returnedRevision]) })))
  const directSources = value.knowledgeSelection ? value.knowledgeSources.map(source => ({ source, key: JSON.stringify(['direct', value.knowledgeSelection?.connectionId, value.knowledgeSelection?.connectionRevision, source.sourceId, source.returnedRevision]) })) : []
  const designSources = controller.view.draft.designContextFiles
  return <div className="requirement-workbench-sources">
    <KnowledgePicker key={`${value.conversation.creatorId}:${value.conversation.id}:${controller.view.draft.id}`} entryKey={entryKey} requirementId={controller.view.draft.id} selection={value.knowledgeSelection} sources={value.knowledgeSources} onChange={controller.setKnowledge} disabled={!controller.active || controller.readOnly || controller.busy} />
    {adopted && adopted.knowledge.length > 0 && <AdoptedEvidence key={adopted.id} entryKey={entryKey} draftId={controller.view.draft.id} operation={adopted} />}
    {(handoffSources.length > 0 || directSources.length > 0) && <details><summary className="requirement-workbench-disclosure"><Paperclip size={14} aria-hidden="true" /><span className="my-item-title">交接知识来源</span><span className="my-item-description">{value.selectedHandoffSources.filter(key => [...handoffSources, ...directSources].some(item => item.key === key)).length} 项已选</span><ChevronDown size={12} aria-hidden="true" /></summary><fieldset className="requirement-workbench-source-body requirement-workbench-file-list" disabled={!controller.active || controller.readOnly || controller.busy}><legend className="sr-only">选择要交接的知识摘录</legend>{handoffSources.map(({ source, key }) => <label key={key} className="requirement-workbench-check"><Checkbox checked={value.selectedHandoffSources.includes(key)} onChange={checked => controller.setHandoffSource(key, checked)} /><span className="requirement-workbench-file-name"><span className="my-item-title">{source.title}</span><span className="my-item-description">{source.returnedRevision.slice(0, 8)} · {value.selectedHandoffSources.includes(key) ? '已选交接' : '不交接'}</span></span></label>)}{directSources.map(({ source, key }) => <label key={key} className="requirement-workbench-check"><Checkbox checked={value.selectedHandoffSources.includes(key)} onChange={checked => controller.setHandoffSource(key, checked)} /><span className="requirement-workbench-file-name"><span className="my-item-title">当前选中的摘录 {source.sourceId.slice(0, 8)}</span><span className="my-item-description">{source.returnedRevision.slice(0, 8)} · {value.selectedHandoffSources.includes(key) ? '已选交接' : '不交接'}</span></span></label>)}</fieldset></details>}
    {designSources.length > 0 && <details><summary className="requirement-workbench-disclosure"><FileText size={14} aria-hidden="true" /><span className="my-item-title">交接设计文件</span><span className="my-item-description">{designSources.filter(file => value.selectedHandoffSources.includes(designHandoffKey(file))).length} 项已选</span><ChevronDown size={12} aria-hidden="true" /></summary><fieldset className="requirement-workbench-source-body requirement-workbench-file-list" disabled={!controller.active || controller.readOnly || controller.busy}><legend className="sr-only">选择要交接的设计文件</legend><p className="my-item-description">计划使用的设计文件需逐项授权交接；不交接的文件请先从设计语境移除并更新计划。</p>{designSources.map(file => { const key = designHandoffKey(file); return <label key={key} className="requirement-workbench-check"><Checkbox checked={value.selectedHandoffSources.includes(key)} onChange={checked => controller.setHandoffSource(key, checked)} /><span className="requirement-workbench-file-name"><span className="my-item-title">{file.source.name}</span><span className="my-item-description">{file.source.revision.slice(0, 8)} · {value.selectedHandoffSources.includes(key) ? '已选交接' : '不交接'}</span></span></label> })}</fieldset></details>}
    <details data-requirement-files onToggle={event => { if (event.currentTarget.open && !current?.filesLoaded && !current?.filesLoading) controller.refreshFiles() }}><summary className="requirement-workbench-disclosure"><FileText size={14} aria-hidden="true" /><span className="my-item-title">引用文件</span>{value.references.length > 0 && <span className="my-item-description">{value.references.length} 项</span>}<ChevronDown size={12} aria-hidden="true" /></summary><div className="requirement-workbench-source-body">
      <div className="requirement-workbench-line"><Button size="sm" variant="ghost" disabled={!controller.canImportFiles} onClick={controller.importFiles}>{current?.action === 'files' ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> : <Paperclip size={13} />}{current?.action === 'files' ? '正在添加…' : '添加本机文件'}</Button><Button size="sm" variant="ghost" disabled={!controller.active || current?.filesLoading || current?.action === 'files'} onClick={controller.refreshFiles}><RefreshCw size={13} />刷新文件</Button>{current?.filesLoading && <Loader2 size={13} className="animate-spin" aria-label="读取文件中" />}</div>
      <fieldset disabled={!controller.active || controller.readOnly || controller.busy} className="requirement-workbench-file-list"><legend className="sr-only">选择固定文件版本</legend>
        {value.references.map(reference => {
          const file = current?.files.find(item => item.id === reference.fileId && item.revision === reference.revision), saved = controller.view?.draft.references.find(item => item.fileId === reference.fileId && item.revision === reference.revision)
          if (file) return null
          return <label key={`${reference.fileId}:${reference.revision}`} className="requirement-workbench-check"><Checkbox checked onChange={() => controller.toggleReference(reference, false)} /><span className="my-item-title">{saved?.name ?? reference.fileId}</span><span className="my-item-description">已固定版本 · {reference.revision.slice(0, 8)}</span></label>
        })}
        {(current?.files ?? []).filter(file => file.bytes <= REQUIREMENT_FILE_BYTES).slice(0, visibleFiles).map(file => <label key={`${file.id}:${file.revision}`} className="requirement-workbench-check"><Checkbox checked={value.references.some(reference => reference.fileId === file.id && reference.revision === file.revision)} onChange={checked => controller.toggleReference({ fileId: file.id, revision: file.revision }, checked)} /><span className="requirement-workbench-file-name"><span className="my-item-title">{file.name}</span><span className="my-item-description" title={file.revision}>{file.relativePath} · {file.revision.slice(0, 8)}</span></span></label>)}
      </fieldset>
      {current?.fileError ? <p className="my-item-description text-my-danger-text" role="alert">{current.fileError}</p> : current?.filesLoaded && !current.files.length && <p className="my-item-description">暂无可引用文件。</p>}
      {(current?.files.length ?? 0) > visibleFiles && <Button size="sm" variant="ghost" onClick={() => setVisibleFiles(value => value + 50)}>显示更多文件</Button>}
    </div></details>
    <div className="requirement-workbench-source-actions"><label className="requirement-workbench-check" htmlFor={`${fieldsId}-context`}><input id={`${fieldsId}-context`} type="checkbox" className="accent-current" checked={value.fromConversation} disabled={!controller.active || controller.readOnly || controller.busy} onChange={event => controller.setFromConversation(event.target.checked)} /><span className="my-item-description">引用原会话内容</span></label><Button size="sm" variant="ghost" disabled={!controller.current?.text.trim() || controller.readOnly || !controller.active} onClick={controller.importInput}><FileInput size={13} />带入当前输入</Button></div>
  </div>
}

function AssistantEmpty({ controller, onAction }: { controller: RequirementWorkbenchController; onAction(action: RequirementAction): void }): JSX.Element {
  const plan = controller.buffer?.document === 'plan'
  const groups: Array<{ title: string; actions: Array<{ action: RequirementAction; icon: JSX.Element; title: string; description: string }> }> = [
    { title: '明确需求', actions: [
      { action: 'clarify', icon: <MessageCircle size={17} />, title: '澄清方向', description: '明确目标、范围和未决问题。' },
      { action: 'research', icon: <Search size={17} />, title: '研究选定资料', description: controller.buffer?.knowledgeSources.length || controller.buffer?.references.length ? '核对所选资料的事实与依据。' : '选择知识摘录或文件后开始。' }
    ] },
    { title: plan ? '完善计划' : '形成文档', actions: [
      { action: 'draft', icon: <FileText size={17} />, title: plan ? '整理计划' : '整理成稿', description: plan ? '按当前需求重新整理计划。' : '将资料和回答整理为需求稿。' },
      { action: 'acceptance', icon: <ListChecks size={17} />, title: '补全验收标准', description: '检查异常路径与可验证条件。' }
    ] }
  ]
  return <div className="requirement-workbench-assistant-empty"><h2>接下来做什么</h2><div className="requirement-workbench-starters">{groups.map(group => <section className="requirement-workbench-action-group" key={group.title} aria-label={group.title}><h3 className="my-item-description">{group.title}</h3>{group.actions.map(({ action, icon, title, description }) => <button key={action} type="button" className="requirement-workbench-action" disabled={!controller.canRun} onClick={() => onAction(action)}><span className="requirement-workbench-action-icon" aria-hidden="true">{icon}</span><span className="requirement-workbench-action-copy"><span className="my-item-title">{title}</span><span className="my-item-description">{description}</span></span><ChevronRight size={14} aria-hidden="true" /></button>)}</section>)}</div></div>
}

function Questions({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const value = controller.buffer, fieldsId = useId()
  if (!value || !controller.questions.length) return null
  return <details className="requirement-workbench-questions" open><summary className="requirement-workbench-disclosure"><ListChecks size={14} aria-hidden="true" /><span className="my-item-title">待补充问题</span><span className="my-item-description">{controller.questions.length}</span><ChevronDown size={12} aria-hidden="true" /></summary><form onSubmit={event => { event.preventDefault(); void controller.submitAnswers() }} className="requirement-workbench-question-fields">
    {controller.questions.map((question, index) => <div key={question.id}><label className="my-item-title" htmlFor={`${fieldsId}-${index}`}>{question.question}{question.required && <span className="my-item-description"> · 必答</span>}</label><textarea id={`${fieldsId}-${index}`} className="my-input" rows={2} maxLength={8000} value={value.answers[question.id] ?? question.answer ?? ''} disabled={!controller.active || controller.readOnly} onChange={event => controller.answer(question.id, event.target.value)} /></div>)}
    <Button size="sm" variant="outline" type="submit" disabled={!controller.canRun}>提交补充<ArrowRight size={13} /></Button>
  </form></details>
}

function OperationResults({ controller, inlineSelection, onComparisonTrigger }: {
  controller: RequirementWorkbenchController
  inlineSelection: boolean
  onComparisonTrigger(trigger: HTMLButtonElement): void
}): JSX.Element | null {
  const value = controller.buffer
  if (!value) return null
  const latest = value.operations[value.operations.length - 1], failed = latest && (!inlineSelection || !latest.quote) && (latest.state === 'failed' || latest.state === 'cancelled') ? latest : undefined
  const candidates = controller.candidates.filter(({ operation }) => !operation.quote && !value.selectionOperations.includes(operation.commandId))
  const unmatched = value.runCommand && !value.operations.some(operation => operation.commandId === value.runCommand?.commandId)
  const selectionPending = Boolean(value.selectionCommand) && !inlineSelection
  const uncertain = controller.pendingOperations.filter(operation => operation.state === 'unknown')
  const adopted = latest?.state === 'adopted' ? latest : undefined

  if (!candidates.length && !uncertain.length && !unmatched && !selectionPending && !failed && !adopted && !controller.pendingOperations.length) return null
  return <div className="requirement-workbench-results">
    {controller.pendingOperations.some(operation => operation.action === 'plan' && operation.state !== 'unknown') && <div className="requirement-workbench-result" role="status"><AgentActivityMark active={controller.active} /><span className="my-item-title">正在生成计划</span></div>}
    {adopted && <p key={adopted.id} className="requirement-workbench-updated" role="status"><Check size={13} aria-hidden="true" /><span>{adopted.document === 'plan' ? '计划已更新' : '需求草稿已更新'}</span></p>}
    {candidates.map(({ operation, candidate }) => <div className="requirement-workbench-result" key={operation.id}><FileText size={15} aria-hidden="true" /><span className="requirement-workbench-result-title"><span className="my-item-title">{operation.document === 'plan' ? '实施计划候选' : candidate?.title}</span><span className="my-item-description">{operation.action === 'plan' ? `依据需求版本 ${(operation.planSourceRevision ?? operation.sourceRevision).slice(0, 8)}` : '待比较'}</span></span><Button size="sm" variant="outline" disabled={!controller.active || controller.busy} onClick={event => { onComparisonTrigger(event.currentTarget); controller.compare(operation.id) }}><GitCompareArrows size={13} />比较候选</Button></div>)}
    {(uncertain.length > 0 || unmatched) && <div className="requirement-workbench-result"><CircleAlert size={15} aria-hidden="true" /><span className="my-item-title">上次操作待核对</span><Button size="sm" variant="outline" disabled={!controller.active || controller.busy} onClick={() => void controller.checkOperations()}>检查状态</Button>{unmatched && <Button size="sm" variant="outline" disabled={!controller.active || controller.busy} onClick={() => void controller.resumeOperation()}>恢复原操作</Button>}</div>}
    {selectionPending && <div className="requirement-workbench-result"><CircleAlert size={15} aria-hidden="true" /><span className="my-item-title">选区应用回执待核对</span><Button size="sm" variant="outline" disabled={!controller.active || controller.busy} onClick={() => void controller.checkOperations()}>检查原应用</Button></div>}
    {failed && <details className="requirement-workbench-operation-detail"><summary className="my-item-description">{actionLabels[failed.action]} · {stateLabels[failed.state]}</summary>{failed.detail && <pre>{failed.detail}</pre>}<Button size="sm" variant="ghost" disabled={!controller.active || controller.busy} onClick={() => void controller.checkOperations()}>检查原操作</Button></details>}
  </div>
}

function CandidateComparison({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const observation = controller.comparison, value = controller.buffer
  if (!observation?.candidate || !value) return null
  const { operation, candidate } = observation, current = operation.document === 'plan' ? value.planBody : value.body
  const selection = Boolean(operation.quote || value.selectionOperations.includes(operation.commandId))
  const stale = operation.sourceRevision !== controller.view?.draft.revision, canAdopt = !selection && !stale && !(operation.document === 'plan' ? controller.requirementDirty : controller.planDirty) && !controller.readOnly
  if (selection) return <section className="requirement-workbench-comparison" aria-label="比较选区候选"><header className="requirement-workbench-comparison-header"><GitCompareArrows size={15} aria-hidden="true" /><span className="my-item-title">选区候选</span><Button size="sm" variant="ghost" aria-label="关闭候选比较" onClick={() => controller.compare()}><X size={14} /></Button></header><div className="requirement-workbench-comparison-columns"><section><h3 className="my-item-title">原选区</h3><pre className="requirement-workbench-comparison-content my-scrollbar">{operation.quote?.text ?? '原选区暂不可读取，请检查原操作。'}</pre></section><section><h3 className="my-item-title">建议替换文本</h3><pre className="requirement-workbench-comparison-content my-scrollbar">{candidate.selectionReplacement ?? '选区替换文本暂不可读取。'}</pre></section></div><footer className="requirement-workbench-line"><span className="my-item-description">可比较并复制候选；重新选择后可在编辑器中审阅应用。</span></footer></section>
  return <section className="requirement-workbench-comparison" aria-label="比较候选文档"><header className="requirement-workbench-comparison-header"><GitCompareArrows size={15} aria-hidden="true" /><span className="my-item-title">{operation.document === 'plan' ? '计划候选' : candidate.title}</span><span className="my-item-description">{stale ? '原文已更新' : controller.dirty ? '本地有修改' : current === candidate.markdown ? '内容相同' : '内容已更改'}</span><Button size="sm" variant="ghost" aria-label="关闭候选比较" onClick={() => controller.compare()}><X size={14} /></Button></header><div className="requirement-workbench-comparison-columns"><section><h3 className="my-item-title">当前文档</h3><div className="requirement-workbench-comparison-content my-scrollbar">{current ? <MarkdownView content={current} /> : <p className="my-item-description">空文档</p>}</div></section><section><h3 className="my-item-title">候选文档</h3><div className="requirement-workbench-comparison-content my-scrollbar"><MarkdownView content={candidate.markdown} /></div></section></div><footer className="requirement-workbench-line">{canAdopt ? <Button size="sm" variant="primary" disabled={controller.busy || !controller.active} onClick={() => void controller.adopt(operation.id)}><Check size={14} />{controller.dirty ? '替换本地稿并采用' : '采用候选'}</Button> : <><span className="my-item-description">{selection ? '选区候选需逐段审阅；可复制所需内容，不会替换全文。' : controller.dirty ? '本地修改已保留，可选择并复制所需内容。' : '候选基于旧版本，可保留所需内容或重新生成。'}</span>{!selection && <Button size="sm" variant="outline" disabled={!controller.canRun} onClick={() => { controller.setDocument(operation.document); controller.compare(); void controller.runAction(operation.action) }}>基于当前版本重做</Button>}</>}</footer></section>
}

function RemoteComparison({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const value = controller.buffer, remote = value?.remote
  if (!value || !remote) return null
  return <details className="requirement-workbench-remote" open><summary className="my-item-title">已保存内容有新版本，本地修改已保留</summary><div className="requirement-workbench-comparison-columns"><section><h3 className="my-item-title">本地稿</h3><div className="requirement-workbench-comparison-content my-scrollbar"><MarkdownView content={value.document === 'plan' ? value.planBody : value.body} /></div></section><section><h3 className="my-item-title">最新保存版本</h3><div className="requirement-workbench-comparison-content my-scrollbar"><MarkdownView content={value.document === 'plan' ? remote.draft.plan?.body ?? '' : remote.draft.body} /></div></section></div><div className="requirement-workbench-line"><Button size="sm" variant="outline" disabled={controller.busy} onClick={() => void controller.useRemote()}>使用新版本</Button><Button size="sm" variant="outline" disabled={controller.busy || controller.readOnly} onClick={() => void controller.keepLocal()}>保存本地稿为新版本</Button></div></details>
}

function FileComparison({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const value = controller.buffer, view = controller.view, document = value?.document
  if (!value || !view || !document || view.pendingSave || value.remote) return null
  const state = document === 'plan' ? view.planFileState : view.fileState
  const fileBody = document === 'plan' ? view.planFileBody : view.fileBody
  if (state !== 'changed' && state !== 'missing') return null
  const local = document === 'plan' ? value.planBody : value.body
  return <details className="requirement-workbench-remote" open><summary className="my-item-title">{state === 'missing' ? '实际文件缺失' : '实际文件已变更'}</summary><div className="requirement-workbench-comparison-columns"><section><h3 className="my-item-title">本地稿</h3><div className="requirement-workbench-comparison-content my-scrollbar"><MarkdownView content={local} /></div></section><section><h3 className="my-item-title">实际文件</h3><div className="requirement-workbench-comparison-content my-scrollbar">{fileBody !== undefined ? <MarkdownView content={fileBody} /> : <p className="my-item-description">{state === 'missing' ? '文件不存在。' : '文件内容暂不可读取。'}</p>}</div></section></div><div className="requirement-workbench-line"><Button size="sm" variant="outline" disabled={!controller.active || controller.busy || controller.readOnly || state === 'changed' && fileBody === undefined} onClick={() => void controller.resolveFileConflict(document, 'keep-local')}>备份并保留本地稿</Button>{state === 'changed' && <Button size="sm" variant="outline" disabled={!controller.active || controller.busy || controller.readOnly || fileBody === undefined} onClick={() => void controller.resolveFileConflict(document, 'use-file')}>备份并采用实际文件</Button>}</div></details>
}

export function RequirementWorkbench({ boundTask, arrangement, onViewTeamTask, teamHandoffFeedback, onClose, onTeamHandoff, ...options }: RequirementWorkbenchProps): JSX.Element {
  const controller = useRequirementWorkbench(options), value = controller.buffer, view = controller.view, fieldsId = useId()
  const assistantPane = useRef<HTMLElement>(null), sourcePanel = useRef<HTMLDivElement>(null), tabRefs = useRef<Partial<Record<RequirementDocument, HTMLButtonElement | null>>>({}), comparisonTrigger = useRef<HTMLButtonElement | null>(null), comparisonWasOpen = useRef(Boolean(controller.comparison))
  const teamHandoffTrigger = useRef<HTMLButtonElement | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false), [sourceFocus, setSourceFocus] = useState<'knowledge' | 'files'>()
  const [selectionReview, setSelectionReview] = useState<RequirementDocument>()
  const [format, setFormat] = useState('standard'), [diagram, setDiagram] = useState(false)
  const [selectionIssue, setSelectionIssue] = useState('')
  const [designReferencesOpen, setDesignReferencesOpen] = useState(false)
  const document = value?.document ?? 'requirement', plan = view?.draft.plan, receipt = value?.receipt ?? view?.draft.handoff
  const busySave = value?.pending === 'save'
  const saveStatus = busySave ? '保存中…' : controller.issue?.kind === 'save' ? '保存失败' : controller.dirty ? '未保存' : view ? '已保存' : '读取中…'
  const adoptedKnowledge = value ? adoptedSourceOperation(value.operations)?.knowledge ?? [] : []
  const knowledgeCount = new Set([...(value?.knowledgeSources ?? []), ...adoptedKnowledge].map(source => source.returnedRevision)).size
  const sourceCount = knowledgeCount + (value?.references.length ?? 0) + Number(Boolean(value?.fromConversation))
  const sourceDescription = `${value?.knowledgeSelection?.collectionIds.length ?? 0} 个知识库 · ${value?.knowledgeSources.length ?? 0} 条选定摘录 · ${adoptedKnowledge.length} 条已采用来源 · ${value?.references.length ?? 0} 个文件${value?.fromConversation ? ' · 引用原会话' : ''}`
  const designFiles = (controller.current?.files ?? []).filter(file => file.bytes <= 64 * 1024 && /\.(?:md|txt|html?|svg|csv|tsv|json|css|m?js|tsx?|jsx|py|sql|xml)$/i.test(file.name) && (controller.current?.kind === 'code' || file.kind === 'input')).map(file => controller.current?.kind === 'code' && controller.current.conversation?.workspace.kind === 'directory' ? { kind: 'project-file' as const, projectRoot: controller.current.conversation.workspace.root, relativePath: file.relativePath, revision: file.revision, name: file.name } : { kind: 'file' as const, fileId: file.id, revision: file.revision, name: file.name })
  const designFilesState = controller.current?.filesLoading ? 'loading' : controller.current?.fileError ? 'error' : controller.current?.filesLoaded ? 'ready' : 'unavailable'
  const openSources = (focus?: 'knowledge' | 'files'): void => { setSourcesOpen(true); setSourceFocus(focus) }
  useEffect(() => {
    if (!sourcesOpen || !sourceFocus || !controller.active) return
    const details = sourcePanel.current?.querySelector<HTMLDetailsElement>(sourceFocus === 'knowledge' ? '.requirement-workbench-knowledge' : 'details[data-requirement-files]')
    if (!details) return
    details.open = true
    details.querySelector('summary')?.focus()
    setSourceFocus(undefined)
  }, [sourcesOpen, sourceFocus, controller.active, view?.draft.id])
  useEffect(() => {
    const open = Boolean(controller.comparison)
    if (comparisonWasOpen.current && !open) {
      const trigger = comparisonTrigger.current
      requestAnimationFrame(() => trigger?.focus())
    }
    comparisonWasOpen.current = open
  }, [controller.comparison])
  const assistantAction = (action: RequirementAction): void => {
    if (!controller.active || controller.readOnly) return
    controller.appendInstruction(action === 'draft' || action === 'acceptance' || action === 'revise' ? 'revise' : 'discuss', instructions[action])
    assistantPane.current?.querySelector<HTMLTextAreaElement>('.acp-composer textarea')?.focus()
  }
  const inlineSelection = selectionReview === document
  const confirmed = view?.draft.confirmed
  const documentStatus = document === 'plan' && plan ? controller.planStale ? '计划需更新' : `依据需求版本 ${plan.sourceRevision.slice(0, 8)}` : confirmed && !controller.requirementDirty && view?.confirmationCurrent === true ? `已确认 · ${confirmed.revision.slice(0, 8)}` : '讨论稿'
  const firstDraft = document === 'requirement' && !hasRequirementContent(value?.body ?? '')
  const firstSource = Boolean(value?.references.length || value?.fromConversation)
  const draftPrompt = [format === 'bug' ? '整理为缺陷报告，区分实际与预期行为、复现条件和验证方式。' : '整理为标准需求，写清用户、场景、范围及可操作的验收条件。',
    '依据用户原话和可读取的资料，未确定的业务决定列为待确认。', diagram ? '附一张与文字一致的 Mermaid 流程图。' : ''].filter(Boolean).join(' ')
  const port: PrivateConversationAssistantPort = {
    text: value?.text ?? '', onTextChange: controller.setText,
    hasSourceInput: firstDraft && firstSource,
    onSend: () => firstDraft ? controller.runAction('draft', draftPrompt) : controller.runAction(value?.textAction === 'revise' ? 'revise' : 'discuss'),
    pending: controller.assistantPending || controller.busy || !view || controller.readOnly,
    emptyState: <AssistantEmpty controller={controller} onAction={assistantAction} />, events: controller.events,
    context: firstDraft ? <div className="flex flex-wrap items-center gap-2"><Select size="sm" aria-label="起草模板" value={format} onChange={setFormat} options={[{ value: 'standard', label: '标准需求' }, { value: 'bug', label: '缺陷报告' }]} /><label className="flex items-center gap-1"><input type="checkbox" checked={diagram} onChange={event => setDiagram(event.target.checked)} />附流程图</label></div> : value?.quote || value?.textAction === 'revise' ? <div className="requirement-workbench-composer-context">{value?.textAction === 'revise' && <div className="requirement-workbench-quote"><span>{document === 'plan' ? '将修改计划' : '将修改需求'}</span><Button size="sm" variant="ghost" aria-label="取消文档修改，改为讨论" onClick={() => controller.setTextAction(undefined)}><X size={13} /></Button></div>}{value?.quote && <div className="requirement-workbench-quote"><Quote size={13} aria-hidden="true" /><span>{value.quote.text}</span><Button size="sm" variant="ghost" aria-label="移除引用" onClick={controller.clearQuote}><X size={13} /></Button></div>}</div> : undefined
  }
  const tabs: Array<{ id: RequirementDocument; label: string }> = [{ id: 'requirement', label: '需求' }, ...(plan ? [{ id: 'plan' as const, label: '计划' }] : [])]
  const assistantActions: RequirementAction[] = ['clarify', 'research', 'draft', 'acceptance', ...(document === 'plan' ? ['revise' as const] : [])]
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let target: RequirementDocument | undefined
    if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && tabs.length > 1) target = tabs[1 - index].id
    if (event.key === 'Home') target = 'requirement'
    if (event.key === 'End') target = tabs[tabs.length - 1].id
    if (!target) return
    event.preventDefault(); controller.setDocument(target); tabRefs.current[target]?.focus()
  }
  return <section className="requirement-workbench" aria-label="需求工作台" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing && controller.active) { event.preventDefault(); event.stopPropagation(); if (!controller.busy && !controller.readOnly) void controller.save() }
  }}>
    <div className="requirement-workbench-body">
      <section className="requirement-workbench-document" aria-label="需求与计划文档">
        <header className="requirement-workbench-header">
          <input className="requirement-workbench-identity" value={value?.title ?? ''} placeholder="需求工作台" maxLength={200} aria-label="需求名称" disabled={!view || !controller.active} readOnly={controller.readOnly} onChange={event => controller.editTitle(event.target.value)} />
          <div role="tablist" aria-label="需求材料" className="requirement-workbench-tabs">{tabs.map((tab, index) => <button key={tab.id} type="button" ref={node => { tabRefs.current[tab.id] = node }} className={`my-control my-control-sm ${document === tab.id ? 'my-button-neutral' : 'my-button-ghost'}`} role="tab" id={`${fieldsId}-tab-${tab.id}`} aria-controls={`${fieldsId}-${tab.id}`} aria-selected={document === tab.id} tabIndex={document === tab.id ? 0 : -1} title={tab.id === 'plan' && controller.planStale ? '需求已变更，计划需更新' : tab.label} onClick={() => controller.setDocument(tab.id)} onKeyDown={event => tabKeyDown(event, index)}>{tab.label}{tab.id === 'plan' && controller.planStale && <CircleAlert size={12} aria-label="需更新" />}</button>)}</div>
          <span className="requirement-workbench-save-status" role="status" aria-live="polite" title={saveStatus}>{busySave ? <Loader2 size={12} className="animate-spin" /> : view && !controller.dirty ? <Check size={12} /> : <Save size={12} />}<span>{saveStatus}</span></span>
          <Dropdown align="right" disabled={!view || controller.busy || !controller.active} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" aria-label="需求选项" disabled={!view || controller.busy || !controller.active} aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} /></Button>}>{close => <>
            <DropdownItem icon={<Save size={14} />} disabled={!controller.dirty || controller.readOnly} onClick={() => { close(); void controller.save() }}>保存文档</DropdownItem>
            <DropdownItem icon={<FileInput size={14} />} disabled={!controller.current?.text.trim() || controller.readOnly} onClick={() => { close(); controller.importInput() }}>带入当前输入</DropdownItem>
            <DropdownItem icon={<RefreshCw size={14} />} onClick={() => { close(); void controller.reload() }}>重新读取</DropdownItem>
            <DropdownItem icon={<RefreshCw size={14} />} disabled={controller.dirty || controller.readOnly || view?.fileState !== 'changed'} onClick={() => { close(); void controller.syncFile() }}>同步需求文件</DropdownItem>
            <DropdownItem icon={<RefreshCw size={14} />} onClick={() => { close(); void controller.checkOperations() }}>检查原操作</DropdownItem>
          </>}</Dropdown>
          <Button size="sm" variant="ghost" aria-label="关闭需求工作台" onClick={onClose}><X size={16} /></Button>
        </header>
        {value && view && <div className="requirement-workbench-actions">
          <span className="my-item-description">{documentStatus}</span>
          {sourceCount > 0 && <Button size="sm" variant="ghost" onClick={() => openSources('files')}><Paperclip size={13} />{value.fromConversation ? '原对话' : '来源'}{view.draft.references.length > 0 && ` · ${view.draft.references.length} 份文件`}</Button>}
          <div className="requirement-workbench-action-buttons">
            {(!plan || controller.planStale) && <Button size="sm" variant="ghost" disabled={!controller.canRun || !hasRequirementContent(value.body)} onClick={() => void controller.runAction('plan')}>{plan ? '更新实施计划' : '生成实施计划'}</Button>}
            {plan && !controller.planStale && !receipt && <Button size="sm" variant="ghost" disabled={controller.nextDisabled} onClick={() => void controller.beginBuild()}>准备工程</Button>}
            {value.commitCommand && !receipt && <Button size="sm" variant="ghost" disabled={controller.nextDisabled} onClick={() => void controller.next()}>检查工程交接</Button>}
            {onTeamHandoff && <Button size="sm" variant="primary" disabled={controller.readOnly || controller.busy || !controller.active || !hasRequirementContent(value.body)} onClick={event => { const trigger = event.currentTarget; teamHandoffTrigger.current = trigger; void controller.prepareTeamHandoff().then(result => { if (result) onTeamHandoff(result, trigger, boundTask) }) }}><Users size={14} />{boundTask ? `共享此版本到〈${boundTask.id}〉` : '交接需求'}</Button>}
          </div>
        </div>}
        {!(inlineSelection && controller.issue?.message === selectionIssue) && <WorkbenchFeedback controller={controller} />}
        {arrangement}
        {teamHandoffFeedback && <TeamHandoffFeedbackView feedback={teamHandoffFeedback} trigger={teamHandoffTrigger} onView={onViewTeamTask} />}
        {view?.pendingSave && <details className="requirement-workbench-remote" open><summary className="my-item-title">上次保存中断，需要核对</summary><p className="my-item-description">恢复前会保留实际文件的当前版本；本地后续编辑不会被覆盖。</p><div className="requirement-workbench-comparison-columns"><section><h3 className="my-item-title">当前本地稿</h3><div className="requirement-workbench-comparison-content my-scrollbar"><MarkdownView content={view.pendingSave.document === 'plan' ? value?.planBody ?? '' : value?.body ?? ''} /></div></section><section><h3 className="my-item-title">中断前待保存内容</h3><div className="requirement-workbench-comparison-content my-scrollbar"><MarkdownView content={view.pendingSave.document === 'plan' ? view.pendingSave.draft.plan?.body ?? '' : view.pendingSave.draft.body} /></div></section><section><h3 className="my-item-title">实际文件</h3><div className="requirement-workbench-comparison-content my-scrollbar">{view.pendingSave.actual.body !== undefined ? <MarkdownView content={view.pendingSave.actual.body} /> : <p className="my-item-description">{view.pendingSave.actual.state === 'missing' ? '文件不存在。' : view.pendingSave.actual.detail ?? '文件暂不可读取。'}</p>}</div></section></div><Button size="sm" variant="outline" disabled={!controller.active || controller.busy || controller.readOnly || view.pendingSave.actual.state === 'unavailable'} onClick={() => void controller.resolvePendingSave()}>恢复待保存内容</Button></details>}
        {controller.loading ? <div className="requirement-workbench-document-loading" role="status"><Loader2 size={16} className="animate-spin" />读取需求文档…</div> : !view || !value ? <div className="requirement-workbench-document-loading"><FileText size={22} /><span className="my-item-title">暂未读取需求</span><Button size="sm" variant="outline" disabled={controller.busy} onClick={() => void controller.reload()}>重新读取</Button></div> : <>
          <div role="tabpanel" id={`${fieldsId}-requirement`} aria-labelledby={`${fieldsId}-tab-requirement`} className="requirement-workbench-editor-panel" hidden={document !== 'requirement'}><Suspense fallback={<div className="requirement-workbench-document-loading" role="status"><Loader2 size={16} className="animate-spin" />载入编辑器…</div>}><DocumentEditor value={value.body} onChange={body => controller.editDocumentBody('requirement', body)} documentKey={`${view.draft.id}:requirement`} docRevision={view.draft.revision} bodyRevision={view.draft.bodyRevision} readOnly={controller.readOnly} disabled={!controller.active || document !== 'requirement'} ariaLabel="需求文档" readingPosition={requirementReadingLocation(value.conversation, view.draft.id).positions.requirement} onReadingPositionChange={position => rememberRequirementReading(value.conversation, view.draft.id, 'requirement', position)} onQuote={selection => { if (controller.quote(selection)) assistantPane.current?.querySelector<HTMLTextAreaElement>('.acp-composer textarea')?.focus() }} onSelectionEdit={controller.editSelection} onSelectionApplied={controller.selectionApplied} canApplySelection={controller.canApplySelection} onSelectionRecover={controller.checkOperations} onSelectionCancel={controller.cancelSelection} onSelectionReviewChange={(open, error) => { setSelectionIssue(error ?? ''); setSelectionReview(current => open ? 'requirement' : current === 'requirement' ? undefined : current) }} /></Suspense></div>
          {plan && <div role="tabpanel" id={`${fieldsId}-plan`} aria-labelledby={`${fieldsId}-tab-plan`} className="requirement-workbench-editor-panel" hidden={document !== 'plan'}><Suspense fallback={<div className="requirement-workbench-document-loading" role="status"><Loader2 size={16} className="animate-spin" />载入编辑器…</div>}><DocumentEditor value={value.planBody} onChange={body => controller.editDocumentBody('plan', body)} documentKey={`${view.draft.id}:plan`} docRevision={plan.revision} bodyRevision={plan.bodyRevision} readOnly={controller.readOnly} disabled={!controller.active || document !== 'plan'} ariaLabel="计划文档" readingPosition={requirementReadingLocation(value.conversation, view.draft.id).positions.plan} onReadingPositionChange={position => rememberRequirementReading(value.conversation, view.draft.id, 'plan', position)} onQuote={selection => { if (controller.quote(selection)) assistantPane.current?.querySelector<HTMLTextAreaElement>('.acp-composer textarea')?.focus() }} onSelectionEdit={controller.editSelection} onSelectionApplied={controller.selectionApplied} canApplySelection={controller.canApplySelection} onSelectionRecover={controller.checkOperations} onSelectionCancel={controller.cancelSelection} onSelectionReviewChange={(open, error) => { setSelectionIssue(error ?? ''); setSelectionReview(current => open ? 'plan' : current === 'plan' ? undefined : current) }} /></Suspense></div>}
        </>}
        <RemoteComparison controller={controller} />
        <FileComparison controller={controller} />
        <CandidateComparison controller={controller} />
        {view && (document === 'requirement' ? view.fileState !== 'saved' : Boolean(view.planFileState && view.planFileState !== 'saved')) && <div className="requirement-workbench-file-state"><CircleAlert size={13} /><span className="my-item-description">{document === 'plan' ? view.planFileState === 'changed' ? '计划文件已更新，请核对后保存。' : '计划文件暂不可读取。' : view.fileState === 'changed' ? '需求文件已更新' : view.fileState === 'missing' ? '需求文件缺失' : '需求文件暂不可读取'}</span>{document === 'requirement' && view.fileState === 'changed' && <Button size="sm" variant="ghost" disabled={controller.dirty || controller.busy || controller.readOnly} onClick={() => void controller.syncFile()}>读取文件修改</Button>}{view.detail && <details><summary className="my-item-description">原因</summary><pre>{view.detail}</pre></details>}</div>}
        {view && (receipt || value?.commitCommand || view.draft.predecessor || view.draft.target) && <footer className="requirement-workbench-handoff"><div className="requirement-workbench-handoff-identity"><FolderOpen size={14} aria-hidden="true" /><span className="my-item-description">{receipt?.task ? `${receipt.task.title} · ${statusLabel(receipt.task.status)}` : view.draft.predecessor ? `后续需求 · 原任务 ${view.draft.predecessor.task.taskId}` : view.draft.target?.root ?? '计划就绪后选择工程'}</span></div><div className="requirement-workbench-line">{receipt?.task ? <><Button size="sm" variant="outline" disabled={controller.busy} onClick={() => void controller.openTask()}>打开任务</Button>{receipt.state === 'created' && <Button size="sm" variant="outline" disabled={controller.busy || !controller.active} onClick={() => void controller.openSuccessor()}>继续修改需求</Button>}{receipt.state === 'created' && options.onStartTrellis && <Button size="sm" variant="primary" disabled={controller.busy} onClick={() => void controller.openTask(true)}>进入执行流程<ArrowRight size={14} /></Button>}{receipt.state !== 'created' && <Button size="sm" variant="primary" disabled={controller.busy} onClick={() => void controller.commit()}>补全交接</Button>}</> : null}</div>{receipt?.detail && <details><summary className="my-item-description">交接详情</summary><pre>{receipt.detail}</pre></details>}</footer>}
      </section>
      <aside ref={assistantPane} className="requirement-workbench-assistant my-conversation-frame" aria-label="需求助手">
        <header className="requirement-workbench-assistant-header">
          <Sparkles size={15} aria-hidden="true" /><h2 className="my-item-title">需求助手</h2>
          <Button className="requirement-workbench-context-trigger" size="sm" variant="ghost" aria-label={`资料与上下文，${sourceDescription}`} title={sourceDescription} aria-expanded={sourcesOpen} aria-controls={`${fieldsId}-sources`} onClick={() => { setSourceFocus(undefined); setSourcesOpen(open => !open) }}><Paperclip size={14} /><span>资料</span><span className="requirement-workbench-source-count">{sourceCount}</span><ChevronDown size={12} /></Button>
          <Dropdown align="right" disabled={!controller.canRun} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" aria-label="需求助手操作" disabled={!controller.canRun} aria-expanded={open} onClick={toggle}><MoreHorizontal size={15} /></Button>}>{close => <>{assistantActions.map(action => <DropdownItem key={action} onClick={() => { close(); assistantAction(action) }}>{action === 'draft' && document === 'plan' ? '重新整理计划' : actionLabels[action]}</DropdownItem>)}<DropdownItem onClick={() => { close(); setDesignReferencesOpen(true); if (!controller.current?.filesLoaded) controller.refreshFiles() }}>按设计参考修改</DropdownItem></>}</Dropdown>
        </header>
        <div className="requirement-workbench-assistant-materials my-scrollbar">
          <div ref={sourcePanel} id={`${fieldsId}-sources`} hidden={!sourcesOpen}><Sources controller={controller} entryKey={options.entryKey} /></div>
          <Questions controller={controller} /><OperationResults controller={controller} inlineSelection={inlineSelection} onComparisonTrigger={trigger => { comparisonTrigger.current = trigger }} />
        </div>
        <PrivateConversation entryKey={options.entryKey} onFiles={() => { openSources('files'); controller.refreshFiles() }} onNew={onClose} onNewDirectory={onClose} directoryPending={false} directoryFixed composerContext={null} assistantPort={port} />
      </aside>
    </div>
    {value && <Modal open={designReferencesOpen} onClose={() => setDesignReferencesOpen(false)} ariaLabel="按设计参考修改">
      <div className="requirement-workbench-reference-dialog">
        <h2 className="my-item-title">按设计参考修改</h2>
        <DesignContext value={value.designContext} standards={designFiles} materials={designFiles} standardsState={designFilesState} materialsState={designFilesState} disabled={!controller.active || controller.readOnly} onChange={controller.setDesignContext} />
        <div className="requirement-workbench-action-buttons"><Button size="sm" variant="ghost" onClick={() => setDesignReferencesOpen(false)}>关闭</Button><Button size="sm" variant="primary" onClick={() => { setDesignReferencesOpen(false); assistantAction('revise') }}>撰写修改指令</Button></div>
      </div>
    </Modal>}
  </section>
}

export default RequirementWorkbench
