import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft, BookOpen, FileText, RefreshCw, X } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { CruxWorkspaceContext } from '@shared/crux-remote'
import type { ProductTaskResults } from '@shared/product-task-entry'
import type { ExecutionArtifactRef } from '@shared/team-execution-artifacts'
import { Button, Modal } from '../my/ui'
import { TeamMarkdown } from '../team/TeamMarkdown'
import { useCrux } from './store'
import { productTaskApi } from './development/ProductTaskEntry'
import { useTaskSource } from './pages/task-detail/use-task-source'
import { useTaskDraft, useTaskDraftField } from './pages/task-detail/task-drafts'
import { SpaceGovernancePanel, type GovernanceEditorDraft, type GovernanceLessonSource } from './governance/SpaceGovernancePanel'
import { api } from '../api'

const syncLabels = { captured: '本地已保存', pending: '待同步', unknown: '同步结果待核对', denied: '共享权限不可用', failed: '同步未完成', 'needs-code': '共享成果已确认 · 待补齐代码来源', confirmed: '共享成果已确认' } as const
const kindNames: Record<string, string> = { 'implementation-report': '实施记录', 'check-report': '检查记录', general: '处理结果', 'source-patch': '代码补丁', 'selected-file': '工程文件' }

/** Task-level fixed output reading remains present after development handoff. */
export function TaskExecutionResults({ task, refreshRevision = 0, onRead }: { task: CruxTask; refreshRevision?: number; onRead?(value: ProductTaskResults | null): void }): JSX.Element | null {
  const context = useCrux(state => state.workspaceContext), client = productTaskApi()
  const snapshot = useCrux(state => state.snapshot)
  const source = useTaskSource({ spaceId: task.spaceId, taskId: task.id })
  const [value, setValue] = useState<ProductTaskResults | null>(null), [error, setError] = useState('')
  const [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<{ ref: ExecutionArtifactRef; title: string; kind: string; text?: string; error?: string } | null>(null)
  const [lesson, setLesson] = useState<GovernanceLessonSource | null>(null), [editingRule, setEditingRule] = useState(false)
  const readerHeader = useRef<HTMLDivElement>(null)
  const sequence = useRef(0), reading = useRef(0)
  const query = { workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }
  useEffect(() => {
    if (!client || context.state !== 'connected' || !source.available) return
    let active = true
    const ticket = ++sequence.current
    setLoading(true)
    void client.results(query).then(reply => {
      if (!active || ticket !== sequence.current || !source.owns()) return
      if (reply.ok) { setValue(reply.value); setError(''); onRead?.(reply.value) } else { setValue(null); setSelected(null); setError(reply.error); onRead?.(null) }
    }).catch(cause => { if (active && source.owns()) { setError(cause instanceof Error ? cause.message : '成果读取失败。'); onRead?.(null) } })
      .finally(() => { if (active && source.owns()) setLoading(false) })
    return () => { active = false }
  }, [client, context.key, context.state, task.id, task.createdAt, task.updatedAt, refresh, refreshRevision, source.available, onRead])
  useEffect(() => {
    if (!value?.sync || value.sync.nextAttemptAt === null || !source.available) return
    const timer = setTimeout(() => setRefresh(current => current + 1), 3000)
    return () => clearTimeout(timer)
  }, [value, source.available])
  async function read(ref: ExecutionArtifactRef, title: string, kind: string): Promise<void> {
    if (!client || !source.owns()) return
    const ticket = ++reading.current
    setLesson(null); setEditingRule(false)
    setSelected({ ref, title, kind })
    try {
      const reply = await client.artifact({ ...query, ref })
      if (!source.owns() || ticket !== reading.current) return
      setSelected(reply.ok ? { ref, title, kind, text: reply.value.text } : { ref, title, kind, error: reply.error })
    } catch (cause) {
      if (source.owns() && ticket === reading.current) setSelected({ ref, title, kind, error: cause instanceof Error ? cause.message : '原成果暂不可读。' })
    }
  }
  const completed = snapshot?.taskStatuses.some(status => status.id === task.statusId && status.spaceId === task.spaceId && status.category === 'done')
    && (!task.workflow || task.workflow.stage === 'done')
  const governance = api && Object.hasOwn(api, 'cruxGovernance') ? api.cruxGovernance : undefined
  const canPromote = Boolean(completed && selected?.text !== undefined && !selected.error
    && ['implementation-report', 'general'].includes(selected.kind) && governance && context.instanceId && context.projectId && context.actorId && source.canWrite())
  const backToResult = (): void => {
    setEditingRule(false)
    requestAnimationFrame(() => readerHeader.current?.querySelector<HTMLButtonElement>('[aria-label="沉淀规范"]')?.focus({ preventScroll: true }))
  }
  if (!client || context.state !== 'connected') return null
  return <section aria-label="执行成果" className="mt-3 min-w-0 space-y-2 border-t border-my-line pt-3">
    <header className="flex flex-wrap items-center gap-2"><h3 className="flex-1 text-my-sm font-medium text-my-primary">执行成果</h3>
      <span role="status" className="text-my-xs text-my-secondary">{value?.sync ? syncLabels[value.sync.state] : value?.finalized ? '执行交付已确认' : loading && !value ? '正在读取…' : value?.artifacts.length ? '共享成果已确认' : '暂无已确认成果'}</span>
      <Button size="sm" variant="ghost" aria-label="刷新执行成果" disabled={loading || !source.available} onClick={() => setRefresh(current => current + 1)}><RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /></Button>
    </header>
    {value?.artifacts.map(item => <div key={item.ref.versionId} className="flex min-w-0 items-center gap-2">
      <FileText size={14} className="shrink-0 text-my-icon-secondary" />
      <span className="min-w-0 flex-1"><span className="my-item-title break-words">{kindNames[item.kind] ?? item.title}</span><span className="my-item-description ml-2">{item.byteLength.toLocaleString()} B</span></span>
      <Button size="sm" variant="ghost" disabled={!source.available} onClick={() => void read(item.ref, kindNames[item.kind] ?? item.title, item.kind)}>阅读固定版本</Button>
    </div>)}
    {value?.previous && <details className="text-my-xs text-my-secondary"><summary className="cursor-pointer">上次固定交付</summary><div className="mt-2 space-y-1">
      {value.previous.artifacts.map(item => <div key={item.ref.versionId} className="flex min-w-0 items-center gap-2"><FileText size={14} className="shrink-0 text-my-icon-secondary" /><span className="my-item-title min-w-0 flex-1 break-words">{kindNames[item.kind] ?? item.title}</span><Button size="sm" variant="ghost" disabled={!source.available} onClick={() => void read(item.ref, kindNames[item.kind] ?? item.title, item.kind)}>阅读上次固定版本</Button></div>)}
    </div></details>}
    {value?.sync?.error && <p role="status" className="break-words text-my-xs text-my-warning-text">{value.sync.error}</p>}
    {error && <p role="alert" className="break-words text-my-xs text-my-danger-text">{error}</p>}
    {selected && source.available && <Modal open width={editingRule ? 1040 : 800} ariaLabel={editingRule ? '沉淀规范' : selected.title} onClose={() => { if (editingRule) backToResult(); else { reading.current++; setSelected(null); setLesson(null) } }}>
      <div ref={readerHeader} className="flex flex-wrap items-center gap-2 border-b border-my-line p-3">
        {editingRule && <Button size="sm" variant="ghost" onClick={backToResult}><ArrowLeft size={14} />返回成果</Button>}
        <h2 className="min-w-0 flex-1 text-my-title font-medium">{editingRule ? '沉淀规范' : selected.title}</h2>
        {!editingRule && canPromote && <Button aria-label="沉淀规范" size="sm" variant="ghost" onClick={() => {
          if (!source.canWrite() || !context.instanceId || !context.projectId) return
          setLesson({ task: { instanceId: context.instanceId, projectId: context.projectId, spaceId: task.spaceId, taskId: task.id, taskCreatedAt: task.createdAt }, artifact: selected.ref, title: `${task.title} · ${selected.title}` })
          setEditingRule(true)
        }}><BookOpen size={14} />沉淀规范</Button>}
        <Button size="sm" variant="ghost" aria-label={editingRule ? '返回成果阅读' : '关闭成果'} onClick={() => { if (editingRule) backToResult(); else { reading.current++; setSelected(null); setLesson(null) } }}><X size={16} /></Button>
      </div>
      <div className="my-scrollbar max-h-[70vh] overflow-y-auto p-4">
      <div hidden={editingRule}>
        {selected.error ? <p role="alert" className="text-my-sm text-my-danger-text">{selected.error}</p> : selected.text === undefined ? <p role="status" className="text-my-sm text-my-secondary">正在读取固定版本…</p>
          : ['selected-file', 'source-patch'].includes(selected.kind) ? <pre className="whitespace-pre-wrap break-words font-mono text-my-sm text-my-primary">{selected.text}</pre>
            : <TeamMarkdown text={selected.text} identity={`${context.key}:${task.id}:${selected.ref.versionId}`} />}
        <details className="mt-4 text-my-xs text-my-secondary"><summary className="cursor-pointer">版本详情</summary><dl className="mt-2 space-y-1 break-all"><div>执行：{selected.ref.executionId}</div><div>版本：{selected.ref.versionId}</div><div>摘要：{selected.ref.bodyDigest}</div></dl></details>
      </div>
      {lesson && snapshot && governance && context.actorId && <div hidden={!editingRule}>
        <TaskLessonEditor key={`${lesson.task.taskCreatedAt}:${lesson.artifact.versionId}`} snapshot={snapshot} context={context} task={task} lesson={lesson} active={editingRule && source.canWrite()} />
      </div>}
      </div>
    </Modal>}
  </section>
}

function TaskLessonEditor({ snapshot, context, task, lesson, active }: {
  snapshot: CruxSnapshot; context: CruxWorkspaceContext; task: CruxTask; lesson: GovernanceLessonSource; active: boolean
}): JSX.Element | null {
  const draft = useTaskDraft(snapshot, context, { kind: 'workflow', spaceId: task.spaceId, task,
    creationContext: ['rule-lesson', lesson.task.instanceId, lesson.task.projectId, lesson.artifact.executionId, lesson.artifact.artifactId, lesson.artifact.versionId, lesson.artifact.bodyDigest] })
  const [editor, setEditor] = useTaskDraftField<GovernanceEditorDraft | null>(draft, 'governance-editor', null)
  const space = snapshot.spaces.find(item => item.id === task.spaceId)
  const governance = api && Object.hasOwn(api, 'cruxGovernance') ? api.cruxGovernance : undefined
  if (!governance || !context.actorId || !space) return null
  return <SpaceGovernancePanel api={governance} workspaceKey={context.key} spaceId={task.spaceId} actorId={context.actorId}
    people={snapshot.members.filter(member => space.memberIds.includes(member.id)).map(member => ({ id: member.id, name: member.name }))}
    canManage={!space.archived && (context.canManage || space.ownerId === context.actorId)}
    lessonSource={lesson} lessonDraft={editor} onLessonDraftChange={setEditor} active={active} />
}
