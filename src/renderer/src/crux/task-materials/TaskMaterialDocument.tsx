import { useState, type JSX } from 'react'
import { BookOpen, CheckCircle2, ChevronRight, FileText, Send } from 'lucide-react'
import type { TeamTaskMaterialView } from '@shared/team-task-materials'
import { Button, DisclosureGrid, Tabs } from '../../my/ui'
import { TeamMarkdown } from '../../team/TeamMarkdown'
import { Field, inputClass, textareaClass } from '../ui'
import { TASK_MATERIAL_LABELS, taskMaterialTime } from './material-presentation'

export type MaterialSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'unknown' | 'error' | 'conflict'
const SAVE_LABEL: Record<MaterialSaveState, string> = {
  clean: '共享草稿已加载', dirty: '有未保存修改', saving: '正在保存草稿…', saved: '草稿已保存',
  unknown: '保存结果待核对', error: '未确认保存成功', conflict: '并发草稿已保留，待合并'
}
export interface TaskMaterialDocumentProps {
  view: TeamTaskMaterialView
  actorId: string
  title: string
  text: string
  saveState: MaterialSaveState
  busy: boolean
  writable: boolean
  changed: boolean
  initialMode?: 'read' | 'edit'
  onChange(value: { title: string; text: string }): void
  onSave(): void
  onSubmit(): void
  onDecide(action: 'approve' | 'reject', reason?: string): void
  onSelectVersion(versionId: string): void
}

/** A fixed selected version and a mutable draft remain separate even while approval metadata refreshes. */
export function TaskMaterialDocument(props: TaskMaterialDocumentProps): JSX.Element {
  const { view, actorId, title, text, saveState, busy, writable, changed, onChange, onSave, onSubmit, onDecide, onSelectVersion } = props
  const [mode, setMode] = useState<'read' | 'edit' | 'source'>(props.initialMode ?? 'read')
  const [rejecting, setRejecting] = useState(false), [reason, setReason] = useState('')
  const [originOpen, setOriginOpen] = useState(false)
  const document = view.document, selected = view.selected
  const currentDraft = document.draft.versionId === selected.versionId
  const editor = writable && currentDraft && document.editorIds.includes(actorId)
  const displayMode = mode === 'edit' && !editor ? 'read' : mode
  const pending = document.latestSubmission?.status === 'pending' ? document.latestSubmission : null
  const canDecide = writable && !changed && document.approverIds.includes(actorId) && pending?.versionId === selected.versionId && pending.bodyDigest === selected.bodyDigest
  const canSubmit = editor && !changed && !pending && document.latestSubmission?.versionId !== selected.versionId && saveState !== 'unknown' && saveState !== 'conflict'
  const displayedText = displayMode === 'read' && changed ? text : view.text
  return <article className="min-w-0 space-y-4" aria-label={`${TASK_MATERIAL_LABELS[document.kind]}正文`}>
    <header className="flex flex-wrap items-start gap-3">
      <FileText size={18} className="mt-0.5 shrink-0 text-my-icon-secondary" />
      <div className="min-w-0 flex-1"><h3 className="break-words text-my-md font-medium text-my-primary">{selected.title}</h3>
        <p className="mt-1 text-my-xs text-my-tertiary">{TASK_MATERIAL_LABELS[document.kind]} · 阅读 v{selected.number} · {taskMaterialTime(selected.createdAt)}{currentDraft ? ' · 当前共享草稿' : ' · 固定历史版本'}</p>
      </div>
      {document.approved?.versionId === selected.versionId && <span className="my-chip inline-flex items-center gap-1 text-my-success-text"><CheckCircle2 size={13} />此版本已批准</span>}
    </header>
    {selected.origin && <div className="rounded-my-base border border-my-line p-3 text-my-xs text-my-tertiary" aria-label="材料版本来源">
      <button type="button" aria-expanded={originOpen} onClick={() => setOriginOpen((v) => !v)} className="inline-flex cursor-pointer items-center gap-1 text-left transition-colors hover:text-my-primary">
        <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${originOpen ? 'rotate-90' : ''}`} />
        <span>版本来源 · 设备上报</span>
      </button>
      <DisclosureGrid open={originOpen}>
        <div>
          <p className="mt-2">由设备上报；服务未核验本机文件或模型执行。</p>
          {changed && <p className="mt-2">来源仅属于所读版本 v{selected.number}，未保存编辑不继承。</p>}
          <dl className="mt-3 space-y-2">
            <div><dt>上报设备</dt><dd className="break-all text-my-secondary"><code>{selected.origin.deviceId}</code></dd></div>
            <div><dt>文件</dt><dd className="text-my-secondary">{selected.origin.file}</dd></div>
            <div><dt>原输入</dt><dd className="break-all text-my-secondary"><code>{selected.origin.inputVersion}</code></dd></div>
            <div><dt>尝试 · 代次 {selected.origin.generation}</dt><dd className="break-all text-my-secondary"><code>{selected.origin.attemptId}</code></dd></div>
            {selected.origin.inputBundle && <><div><dt>原包修订 r{selected.origin.inputBundle.revision}</dt><dd className="break-all text-my-secondary"><code>{selected.origin.inputBundle.bundleId}</code></dd></div><div><dt>原包摘要</dt><dd className="break-all text-my-secondary"><code>{selected.origin.inputBundle.digest}</code></dd></div></>}
          </dl>
        </div>
      </DisclosureGrid>
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      <Tabs tabs={[{ id: 'read', label: '阅读' }, ...(editor ? [{ id: 'edit', label: '编辑草稿' }] : []), { id: 'source', label: '原文' }]} active={displayMode} onChange={(next) => { if (next === 'read' || next === 'source' || next === 'edit' && editor) setMode(next) }} />
      <div className="ml-auto flex flex-wrap gap-2">
        {!currentDraft && <Button size="sm" disabled={busy || changed} onClick={() => onSelectVersion(document.draft.versionId)}>查看当前草稿</Button>}
        {document.approved && document.approved.versionId !== selected.versionId && <Button size="sm" disabled={busy || changed} onClick={() => onSelectVersion(document.approved?.versionId ?? selected.versionId)}>查看批准版</Button>}
      </div>
    </div>
    {selected.disposition === 'conflict' && <p role="status" className="rounded-my-base bg-my-warning-subtle p-3 text-my-xs text-my-warning-text">这是保存冲突时保留的版本，当前共享草稿未被覆盖。请比较后再明确合并。</p>}
    {displayMode === 'edit' && editor ? <div className="space-y-3">
      <Field label="文档标题"><input className={inputClass} value={title} maxLength={300} onChange={(event) => onChange({ title: event.target.value, text })} /></Field>
      <Field label="草稿正文"><textarea className={textareaClass} rows={18} value={text} onChange={(event) => onChange({ title, text: event.target.value })} aria-describedby="task-material-save-state" /></Field>
      <div className="flex flex-wrap items-center gap-2"><p id="task-material-save-state" role="status" className="flex-1 text-my-xs text-my-tertiary">{SAVE_LABEL[saveState]}</p><Button size="sm" variant="primary" disabled={busy || !changed || !title.trim() || !text.trim() || saveState === 'unknown' || saveState === 'conflict'} onClick={onSave}>保存共享草稿</Button></div>
    </div> : displayMode === 'source' ? <pre className="my-scrollbar max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-my-base bg-my-layer-1 p-3 text-my-xs text-my-secondary">{view.text}</pre>
      : <div className="my-scrollbar max-h-96 overflow-auto rounded-my-base border border-my-line p-4">{changed && <p role="status" className="mb-3 text-my-xs text-my-warning-text">正在预览未保存修改，尚未成为共享版本。</p>}<TeamMarkdown text={displayedText} identity={`${document.projectId}:${document.taskId}:${document.documentId}:${selected.versionId}:${changed ? 'draft' : selected.bodyDigest}`} /></div>}
    <footer className="flex flex-wrap items-center gap-2 border-t border-my-line pt-3">
      {canSubmit && <Button size="sm" variant="primary" disabled={busy} onClick={onSubmit}><Send size={14} />提交此版本评审</Button>}
      {canDecide && <><Button size="sm" variant="primary" disabled={busy} onClick={() => onDecide('approve')}><CheckCircle2 size={14} />批准此版本</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting((value) => !value)}>退回修改</Button></>}
      {pending && !canDecide && <span className="inline-flex items-center gap-1 text-my-xs text-my-tertiary"><BookOpen size={13} />有待评审的固定版本{pending.versionId !== selected.versionId && <Button size="sm" variant="ghost" disabled={busy || changed} onClick={() => onSelectVersion(pending.versionId)}>阅读评审版</Button>}</span>}
      {document.latestSubmission?.status === 'rejected' && <p className="w-full whitespace-pre-wrap break-words text-my-xs text-my-warning-text">退回原因：{document.latestSubmission.reason}</p>}
      {rejecting && canDecide && <div className="w-full space-y-2"><Field label="需要修改的内容"><textarea className={textareaClass} rows={3} maxLength={2000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></Field><div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>取消</Button><Button size="sm" disabled={busy || !reason.trim()} onClick={() => onDecide('reject', reason.trim())}>确认退回</Button></div></div>}
    </footer>
  </article>
}
