import { lazy, Suspense, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { ArrowRight, Check, ChevronDown, CircleAlert, FileInput, FileText, FolderOpen, GitCompareArrows, ListChecks, Loader2, MessageCircle, MoreHorizontal, Quote, RefreshCw, Save, Search, Sparkles, X } from 'lucide-react'
import { REQUIREMENT_FILE_BYTES, type RequirementAction, type RequirementDocument, type RequirementOperation } from '@shared/conversation-requirements'
import { MarkdownView } from '../../components/MarkdownView'
import { Button, Checkbox, Dropdown, DropdownItem } from '../../my/ui'
import { statusLabel } from '../../utils/labels'
import { PrivateConversation, type PrivateConversationAssistantPort } from '../Conversation'
import { KnowledgePicker } from './KnowledgePicker'
import { AdoptedEvidence } from './AdoptedEvidence'
import { useRequirementWorkbench, type RequirementWorkbenchController, type RequirementWorkbenchOptions } from './useRequirementWorkbench'
import './workbench.css'

const DocumentEditor = lazy(() => import('./DocumentEditor'))
export interface RequirementWorkbenchProps extends RequirementWorkbenchOptions { onClose(): void }
const actionLabels: Record<RequirementAction, string> = { clarify: '澄清问题', research: '研究资料', draft: '生成需求', revise: '修改文档', acceptance: '检查验收', plan: '生成计划', discuss: '讨论需求' }
const stateLabels: Record<RequirementOperation['state'], string> = { reserved: '已准备', dispatching: '正在派发', running: '处理中', candidate: '待采用', adopted: '已采用', failed: '未完成', cancelled: '已取消', unknown: '待核对' }

function WorkbenchFeedback({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const issue = controller.issue, commandIssue = controller.buffer?.commandIssue
  const native = [controller.current?.nativeError, controller.current?.session?.status === 'error' ? controller.current.session.error : undefined].filter(Boolean)
  // Native connection recovery is already rendered once by the original assistant controller.
  const nativeDuplicate = issue?.kind === 'operation' && native.some(message => message === issue.message || Boolean(message && issue.message.includes(message)) || /running daemon.*(?:outdated|unverified)|different installed version owns this daemon/i.test(`${message} ${issue.message}`))
  if ((!issue || nativeDuplicate) && !commandIssue) return null
  const title = commandIssue ? '原操作需要核对' : issue?.kind === 'save' ? '文档保存未完成' : issue?.kind === 'handoff' ? '任务交接未完成' : issue?.kind === 'load' ? '需求读取未完成' : '本次操作未完成'
  return <div className="requirement-workbench-feedback" role="alert"><CircleAlert size={15} aria-hidden="true" /><span className="my-item-title">{title}</span><Button size="sm" variant="ghost" disabled={!controller.active || controller.busy} onClick={() => void (issue?.kind === 'save' ? controller.save() : issue?.kind === 'operation' || commandIssue ? controller.checkOperations() : controller.reload())}>{issue?.kind === 'save' ? '重试保存' : issue?.kind === 'operation' || commandIssue ? '检查原操作' : '重新读取'}</Button><details><summary className="my-item-description">原因</summary><pre>{commandIssue ?? issue?.message}</pre></details></div>
}

function Sources({ controller, entryKey }: { controller: RequirementWorkbenchController; entryKey: string }): JSX.Element | null {
  const value = controller.buffer, [visibleFiles, setVisibleFiles] = useState(50), fieldsId = useId()
  if (!value || !controller.view) return null
  const current = controller.current
  const adopted = [...value.operations].reverse().find(operation => operation.state === 'adopted')
  return <div className="requirement-workbench-sources">
    <KnowledgePicker key={`${value.conversation.creatorId}:${value.conversation.id}:${controller.view.draft.id}`} entryKey={entryKey} requirementId={controller.view.draft.id} selection={value.knowledgeSelection} sources={value.knowledgeSources} onChange={controller.setKnowledge} disabled={!controller.active || controller.readOnly || controller.busy} />
    {adopted && adopted.knowledge.length > 0 && <AdoptedEvidence key={adopted.id} entryKey={entryKey} draftId={controller.view.draft.id} operation={adopted} />}
    <details data-requirement-files onToggle={event => { if (event.currentTarget.open && !current?.filesLoaded && !current?.filesLoading) controller.refreshFiles() }}><summary className="requirement-workbench-disclosure"><FileText size={14} aria-hidden="true" /><span className="my-item-title">引用文件</span>{value.references.length > 0 && <span className="my-item-description">{value.references.length} 项</span>}<ChevronDown size={12} aria-hidden="true" /></summary><div className="requirement-workbench-source-body">
      <div className="requirement-workbench-line"><Button size="sm" variant="ghost" disabled={!controller.active || current?.filesLoading} onClick={controller.refreshFiles}><RefreshCw size={13} />刷新文件</Button>{current?.filesLoading && <Loader2 size={13} className="animate-spin" aria-label="读取文件中" />}</div>
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

function AssistantEmpty({ controller }: { controller: RequirementWorkbenchController }): JSX.Element {
  return <div className="requirement-workbench-assistant-empty"><MessageCircle size={20} aria-hidden="true" /><h2>一起把需求想清楚</h2><div className="requirement-workbench-starters">{([
    ['clarify', <MessageCircle size={14} />], ['research', <Search size={14} />], ['draft', <FileText size={14} />], ['acceptance', <ListChecks size={14} />]
  ] satisfies Array<[RequirementAction, JSX.Element]>).map(([action, icon]) => <Button key={action} size="sm" variant="outline" disabled={!controller.canRun || action === 'research' && !controller.buffer?.knowledgeSelection} onClick={() => void controller.runAction(action)}>{icon}{actionLabels[action]}</Button>)}</div></div>
}

function Questions({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const value = controller.buffer, fieldsId = useId()
  if (!value || !controller.questions.length) return null
  return <details className="requirement-workbench-questions" open><summary className="requirement-workbench-disclosure"><ListChecks size={14} aria-hidden="true" /><span className="my-item-title">待补充问题</span><span className="my-item-description">{controller.questions.length}</span><ChevronDown size={12} aria-hidden="true" /></summary><form onSubmit={event => { event.preventDefault(); void controller.submitAnswers() }} className="requirement-workbench-question-fields">
    {controller.questions.map((question, index) => <div key={question.id}><label className="my-item-title" htmlFor={`${fieldsId}-${index}`}>{question.question}{question.required && <span className="my-item-description"> · 必答</span>}</label><textarea id={`${fieldsId}-${index}`} className="my-input" rows={2} maxLength={8000} value={value.answers[question.id] ?? question.answer ?? ''} disabled={!controller.active || controller.readOnly} onChange={event => controller.answer(question.id, event.target.value)} /></div>)}
    <Button size="sm" variant="outline" type="submit" disabled={!controller.canRun}>提交补充<ArrowRight size={13} /></Button>
  </form></details>
}

function OperationResults({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const value = controller.buffer
  if (!value) return null
  const latest = value.operations[value.operations.length - 1], failed = latest && (latest.state === 'failed' || latest.state === 'cancelled') ? latest : undefined
  const unmatched = value.runCommand && !value.operations.some(operation => operation.commandId === value.runCommand?.commandId)
  const uncertain = controller.pendingOperations.filter(operation => operation.state === 'unknown')
  const adopted = latest?.state === 'adopted' ? latest : undefined
  if (!controller.candidates.length && !uncertain.length && !unmatched && !failed && !adopted) return null
  return <div className="requirement-workbench-results">
    {adopted && <p key={adopted.id} className="requirement-workbench-updated" role="status"><Check size={13} aria-hidden="true" /><span>{adopted.document === 'plan' ? '计划已更新' : '需求草稿已更新'}</span></p>}
    {controller.candidates.map(({ operation, candidate }) => <div className="requirement-workbench-result" key={operation.id}><FileText size={15} aria-hidden="true" /><span className="requirement-workbench-result-title"><span className="my-item-title">{operation.document === 'plan' ? '计划' : candidate?.title}</span><span className="my-item-description">{actionLabels[operation.action]} · 待比较</span></span><Button size="sm" variant="outline" disabled={!controller.active || controller.busy} onClick={() => controller.compare(operation.id)}><GitCompareArrows size={13} />比较候选</Button></div>)}
    {(uncertain.length > 0 || unmatched) && <div className="requirement-workbench-result"><CircleAlert size={15} aria-hidden="true" /><span className="my-item-title">上次操作待核对</span><Button size="sm" variant="outline" disabled={!controller.active || controller.busy} onClick={() => void controller.checkOperations()}>检查状态</Button></div>}
    {failed && <details className="requirement-workbench-operation-detail"><summary className="my-item-description">{actionLabels[failed.action]} · {stateLabels[failed.state]}</summary>{failed.detail && <pre>{failed.detail}</pre>}<Button size="sm" variant="ghost" disabled={!controller.active || controller.busy} onClick={() => void controller.checkOperations()}>检查原操作</Button></details>}
  </div>
}

function CandidateComparison({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const observation = controller.comparison, value = controller.buffer
  if (!observation?.candidate || !value) return null
  const { operation, candidate } = observation, current = operation.document === 'plan' ? value.planBody : value.body
  const stale = operation.sourceRevision !== controller.view?.draft.revision, canAdopt = !stale && !(operation.document === 'plan' ? controller.requirementDirty : controller.planDirty) && !controller.readOnly
  return <section className="requirement-workbench-comparison" aria-label="比较候选文档"><header className="requirement-workbench-comparison-header"><GitCompareArrows size={15} aria-hidden="true" /><span className="my-item-title">{operation.document === 'plan' ? '计划候选' : candidate.title}</span><span className="my-item-description">{stale ? '原文已更新' : controller.dirty ? '本地有修改' : current === candidate.markdown ? '内容相同' : '内容已更改'}</span><Button size="sm" variant="ghost" aria-label="关闭候选比较" onClick={() => controller.compare()}><X size={14} /></Button></header><div className="requirement-workbench-comparison-columns"><section><h3 className="my-item-title">当前文档</h3><div className="requirement-workbench-comparison-content my-scrollbar">{current ? <MarkdownView content={current} /> : <p className="my-item-description">空文档</p>}</div></section><section><h3 className="my-item-title">候选文档</h3><div className="requirement-workbench-comparison-content my-scrollbar"><MarkdownView content={candidate.markdown} /></div></section></div><footer className="requirement-workbench-line">{canAdopt ? <Button size="sm" variant="primary" disabled={controller.busy || !controller.active} onClick={() => void controller.adopt(operation.id)}><Check size={14} />{controller.dirty ? '替换本地稿并采用' : '采用候选'}</Button> : <><span className="my-item-description">{controller.dirty ? '本地修改已保留，可选择并复制所需内容。' : '候选基于旧版本，可保留所需内容或重新生成。'}</span><Button size="sm" variant="outline" disabled={!controller.canRun} onClick={() => { controller.setDocument(operation.document); controller.compare(); void controller.runAction(operation.action) }}>基于当前版本重做</Button></>}</footer></section>
}

function RemoteComparison({ controller }: { controller: RequirementWorkbenchController }): JSX.Element | null {
  const value = controller.buffer, remote = value?.remote
  if (!value || !remote) return null
  return <details className="requirement-workbench-remote" open><summary className="my-item-title">已保存内容有新版本，本地修改已保留</summary><div className="requirement-workbench-comparison-columns"><section><h3 className="my-item-title">本地稿</h3><div className="requirement-workbench-comparison-content my-scrollbar"><MarkdownView content={value.document === 'plan' ? value.planBody : value.body} /></div></section><section><h3 className="my-item-title">最新保存版本</h3><div className="requirement-workbench-comparison-content my-scrollbar"><MarkdownView content={value.document === 'plan' ? remote.draft.plan?.body ?? '' : remote.draft.body} /></div></section></div><div className="requirement-workbench-line"><Button size="sm" variant="outline" disabled={controller.busy} onClick={() => void controller.useRemote()}>使用新版本</Button><Button size="sm" variant="outline" disabled={controller.busy || controller.readOnly} onClick={() => void controller.keepLocal()}>保存本地稿为新版本</Button></div></details>
}

export function RequirementWorkbench({ onClose, ...options }: RequirementWorkbenchProps): JSX.Element {
  const controller = useRequirementWorkbench(options), value = controller.buffer, view = controller.view, fieldsId = useId()
  const assistantPane = useRef<HTMLElement>(null), sourcePanel = useRef<HTMLDivElement>(null), tabRefs = useRef<Partial<Record<RequirementDocument, HTMLButtonElement | null>>>({})
  const document = value?.document ?? 'requirement', plan = view?.draft.plan, receipt = value?.receipt ?? view?.draft.handoff
  const busySave = value?.pending === 'save'
  const saveStatus = busySave ? '保存中…' : controller.dirty ? '未保存' : view ? '已保存' : '读取中…'
  const source = <Sources controller={controller} entryKey={options.entryKey} />
  const port: PrivateConversationAssistantPort = {
    text: value?.text ?? '', onTextChange: controller.setText,
    onSend: () => controller.runAction(value?.quote ? 'revise' : 'discuss'),
    pending: controller.assistantPending || controller.busy || !view || controller.readOnly,
    emptyState: <AssistantEmpty controller={controller} />, events: controller.events,
    context: value?.quote ? <div className="requirement-workbench-quote"><Quote size={13} aria-hidden="true" /><span>{value.quote.text}</span><Button size="sm" variant="ghost" aria-label="移除引用" onClick={controller.clearQuote}><X size={13} /></Button></div> : undefined
  }
  const tabs: Array<{ id: RequirementDocument; label: string }> = [{ id: 'requirement', label: '需求' }, { id: 'plan', label: '计划' }]
  const assistantActions: RequirementAction[] = ['clarify', 'research', 'draft', 'acceptance', ...(document === 'plan' ? ['revise' as const] : [])]
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let target: RequirementDocument | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') target = tabs[1 - index].id
    if (event.key === 'Home') target = 'requirement'
    if (event.key === 'End') target = 'plan'
    if (!target) return
    event.preventDefault(); controller.setDocument(target); tabRefs.current[target]?.focus()
  }
  return <section className="requirement-workbench" aria-label="需求工作台" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing && controller.active) { event.preventDefault(); event.stopPropagation(); if (!controller.busy && !controller.readOnly) void controller.save() }
  }}>
    <header className="requirement-workbench-header"><FileText size={17} aria-hidden="true" /><input className="requirement-workbench-identity" value={value?.title ?? ''} placeholder="需求工作台" maxLength={200} aria-label="需求名称" disabled={!view || !controller.active} readOnly={controller.readOnly} onChange={event => controller.editTitle(event.target.value)} /><span className="requirement-workbench-save-status" role="status" aria-live="polite">{busySave ? <Loader2 size={12} className="animate-spin" /> : view && !controller.dirty ? <Check size={12} /> : null}{saveStatus}</span><Button size="sm" variant="ghost" disabled={!view || !controller.dirty || controller.busy || controller.readOnly || !controller.active} aria-label="保存文档" onClick={() => void controller.save()}><Save size={15} /></Button><Dropdown align="right" disabled={!view || controller.busy || !controller.active} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" aria-label="需求选项" disabled={!view || controller.busy} aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} /></Button>}>{close => <><DropdownItem icon={<FileInput size={14} />} disabled={!controller.current?.text.trim() || controller.readOnly} onClick={() => { close(); controller.importInput() }}>带入当前输入</DropdownItem><DropdownItem icon={<RefreshCw size={14} />} onClick={() => { close(); void controller.reload() }}>重新读取</DropdownItem><DropdownItem icon={<RefreshCw size={14} />} disabled={controller.dirty || controller.readOnly || view?.fileState !== 'changed'} onClick={() => { close(); void controller.syncFile() }}>同步需求文件</DropdownItem><DropdownItem icon={<RefreshCw size={14} />} onClick={() => { close(); void controller.checkOperations() }}>检查原操作</DropdownItem></>}</Dropdown><Button size="sm" variant="primary" disabled={controller.nextDisabled} onClick={() => void controller.next()}>{value?.pending === 'run' || value?.pending === 'commit' || value?.pending === 'target' ? <Loader2 size={14} className="animate-spin" /> : null}{controller.nextLabel}<ArrowRight size={14} /></Button><Button size="sm" variant="ghost" aria-label="关闭需求工作台" onClick={onClose}><X size={16} /></Button></header>
    <WorkbenchFeedback controller={controller} />
    <div className="requirement-workbench-body">
      <section className="requirement-workbench-document" aria-label="需求与计划文档"><div className="requirement-workbench-document-bar"><div role="tablist" aria-label="需求材料" className="requirement-workbench-tabs">{tabs.map((tab, index) => <button key={tab.id} type="button" ref={node => { tabRefs.current[tab.id] = node }} className={`my-control my-control-sm ${document === tab.id ? 'my-button-neutral' : 'my-button-ghost'}`} role="tab" id={`${fieldsId}-tab-${tab.id}`} aria-controls={`${fieldsId}-${tab.id}`} aria-selected={document === tab.id} tabIndex={document === tab.id ? 0 : -1} onClick={() => controller.setDocument(tab.id)} onKeyDown={event => tabKeyDown(event, index)}>{tab.id === 'plan' ? <ListChecks size={14} /> : <FileText size={14} />}{tab.label}{tab.id === 'plan' && plan?.stale && <span className="my-item-description">需更新</span>}</button>)}</div><span className="my-item-description">{document === 'requirement' && view?.draft.confirmed && !controller.requirementDirty && view.draft.confirmed.bodyRevision === view.draft.bodyRevision ? '已确认快照' : document === 'plan' && plan?.stale ? '需求已变更' : ''}</span></div>
        <div role="tabpanel" id={`${fieldsId}-${document}`} aria-labelledby={`${fieldsId}-tab-${document}`} className="requirement-workbench-editor-panel">
          {controller.loading ? <div className="requirement-workbench-document-loading" role="status"><Loader2 size={16} className="animate-spin" />读取需求文档…</div> : !view || !value ? <div className="requirement-workbench-document-loading"><FileText size={22} /><span className="my-item-title">暂未读取需求</span><Button size="sm" variant="outline" disabled={controller.busy} onClick={() => void controller.reload()}>重新读取</Button></div> : document === 'plan' && !plan ? <div className="requirement-workbench-plan-empty"><ListChecks size={24} aria-hidden="true" /><h2>把需求变成计划</h2><p className="my-item-description">确认当前需求后，生成独立的实施计划。</p><Button variant="primary" size="sm" disabled={!controller.canRun || !value.body.trim()} onClick={() => void controller.runAction('plan')}>确认需求并生成计划<ArrowRight size={14} /></Button></div> : <>
            <Suspense fallback={<div className="requirement-workbench-document-loading" role="status"><Loader2 size={16} className="animate-spin" />载入编辑器…</div>}><DocumentEditor value={document === 'requirement' ? value.body : value.planBody} onChange={controller.editBody} documentKey={`${view.draft.id}:${document}`} docRevision={document === 'requirement' ? view.draft.revision : plan?.revision} bodyRevision={document === 'requirement' ? view.draft.bodyRevision : plan?.bodyRevision} readOnly={controller.readOnly} disabled={!controller.active} ariaLabel={document === 'requirement' ? '需求文档' : '计划文档'} onQuote={selection => { if (controller.quote(selection)) assistantPane.current?.querySelector<HTMLTextAreaElement>('.acp-composer textarea')?.focus() }} onPolish={selection => controller.quote(selection, true)} /></Suspense>
          </>}
        </div>
        <RemoteComparison controller={controller} />
        <CandidateComparison controller={controller} />
        {view && (document === 'requirement' ? view.fileState !== 'saved' : Boolean(view.planFileState && view.planFileState !== 'saved')) && <div className="requirement-workbench-file-state"><CircleAlert size={13} /><span className="my-item-description">{document === 'plan' ? view.planFileState === 'changed' ? '计划文件已更新，请核对后保存。' : '计划文件暂不可读取。' : view.fileState === 'changed' ? '需求文件已更新' : view.fileState === 'missing' ? '需求文件缺失' : '需求文件暂不可读取'}</span>{document === 'requirement' && view.fileState === 'changed' && <Button size="sm" variant="ghost" disabled={controller.dirty || controller.busy || controller.readOnly} onClick={() => void controller.syncFile()}>读取文件修改</Button>}{view.detail && <details><summary className="my-item-description">原因</summary><pre>{view.detail}</pre></details>}</div>}
        {view && (plan || receipt || value?.commitCommand) && <footer className="requirement-workbench-handoff"><div className="requirement-workbench-handoff-identity"><FolderOpen size={14} aria-hidden="true" /><span className="my-item-description">{receipt?.task ? `${receipt.task.title} · ${statusLabel(receipt.task.status)}` : view.draft.target?.root ?? '计划就绪后选择工程'}</span></div><div className="requirement-workbench-line">{receipt?.task ? <><Button size="sm" variant="outline" disabled={controller.busy} onClick={() => void controller.openTask()}>打开任务</Button>{receipt.state === 'created' && options.onStartTrellis && <Button size="sm" variant="primary" disabled={controller.busy} onClick={() => void controller.openTask(true)}>进入执行流程<ArrowRight size={14} /></Button>}{receipt.state !== 'created' && <Button size="sm" variant="primary" disabled={controller.busy} onClick={() => void controller.commit()}>补全交接</Button>}</> : !controller.readOnly && plan && !plan.stale && <Dropdown align="right" disabled={controller.busy} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" disabled={controller.busy} aria-expanded={open} onClick={toggle}><FolderOpen size={14} />{view.draft.target ? '更换工程' : '选择工程'}<ChevronDown size={12} /></Button>}>{close => <><DropdownItem onClick={() => { close(); void controller.selectTarget() }}>选择本机 Trellis 工程</DropdownItem>{controller.current?.kind === 'code' && <DropdownItem onClick={() => { close(); void controller.selectTarget({ kind: 'code' }) }}>使用当前 Code 工程</DropdownItem>}</>}</Dropdown>}</div>{receipt?.detail && <details><summary className="my-item-description">交接详情</summary><pre>{receipt.detail}</pre></details>}</footer>}
      </section>
      <aside ref={assistantPane} className="requirement-workbench-assistant my-conversation-frame" aria-label="需求助手"><header className="requirement-workbench-assistant-header"><Sparkles size={15} aria-hidden="true" /><h2 className="my-item-title">需求助手</h2><Dropdown align="right" disabled={!controller.canRun} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" aria-label="需求助手操作" disabled={!controller.canRun} aria-expanded={open} onClick={toggle}><MoreHorizontal size={15} /></Button>}>{close => <>{assistantActions.map(typed => {
          return <DropdownItem key={typed} disabled={typed === 'research' && !value?.knowledgeSelection} onClick={() => { close(); void controller.runAction(typed) }}>{typed === 'draft' && document === 'plan' ? '重新整理计划' : actionLabels[typed]}</DropdownItem>
        })}</>}</Dropdown></header><div ref={sourcePanel} className="requirement-workbench-assistant-materials my-scrollbar">{source}<Questions controller={controller} /><OperationResults controller={controller} /></div><PrivateConversation entryKey={options.entryKey} onFiles={() => { const files = sourcePanel.current?.querySelector<HTMLDetailsElement>('details[data-requirement-files]'); if (files) files.open = true; controller.refreshFiles() }} onNew={onClose} onNewDirectory={onClose} directoryPending={false} directoryFixed composerContext={null} assistantPort={port} />
      </aside>
    </div>
  </section>
}

export default RequirementWorkbench
