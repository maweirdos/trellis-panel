import { useRef, useState, type JSX } from 'react'
import { Loader2, Plus } from 'lucide-react'
import type { CruxRuntimeKind, CruxSnapshot, CruxTask } from '@shared/crux'
import { api } from '../../api'
import { Button } from '../../my/ui'
import { useCrux } from '../store'
import { Field, inputClass, textareaClass } from '../ui'
import { useTaskDraft, useTaskDraftField } from '../pages/task-detail/task-drafts'
import { useTaskSource } from '../pages/task-detail/use-task-source'

/** An inline configuration detour keeps the original task and handoff draft mounted. */
export function WorkflowAgentSetup({ snapshot, task, onCreated, onClose }: {
  snapshot: CruxSnapshot
  task: CruxTask
  onCreated(id: string): void
  onClose(): void
}): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const busy = useCrux((state) => state.busy)
  const source = useTaskSource({ spaceId: task.spaceId, taskId: task.id })
  const draft = useTaskDraft(snapshot, context, { kind: 'workflow', spaceId: task.spaceId, task, creationContext: ['create-space-agent'] })
  const [name, setName] = useTaskDraftField(draft, 'name', '')
  const [instructions, setInstructions] = useTaskDraftField(draft, 'instructions', '')
  const [runtimeKind, setRuntimeKind] = useTaskDraftField<CruxRuntimeKind>(draft, 'runtimeKind', 'codex')
  const [error, setError] = useState('')
  const flight = useRef(false)
  async function create(): Promise<void> {
    if (flight.current || busy || !source.canWrite() || !name.trim() || !instructions.trim()) return
    flight.current = true; setError('')
    const before = new Set(snapshot.agents.map((agent) => agent.id))
    const acknowledge = draft.acknowledge()
    try {
      const result = await useCrux.getState().run('创建空间 Agent', async () => {
        if (!source.canWrite()) return { ok: false as const, error: '原任务来源已变化，请重新打开。' }
        const response = await api.crux.saveAgent({ spaceId: task.spaceId, name: name.trim(), instructions: instructions.trim(),
          runtimeKind, workingDirectory: 'repo', skillIds: [], repositories: [], enabled: true, archived: false })
        if (response.ok) acknowledge()
        return response
      })
      if (!source.owns()) return
      if (!result?.ok) { setError(result && !result.ok ? result.error : '创建尚未确认，请核对空间 Agent 后重试。'); return }
      const created = result.data.agents.find((agent) => !before.has(agent.id) && agent.spaceId === task.spaceId && agent.name === name.trim())
      if (created) onCreated(created.id)
      else setError('创建已有回执，请在执行 Agent 列表中核对新配置。')
    } finally { flight.current = false }
  }
  return <section className="workflow-agent-setup space-y-3 rounded-my-md border border-my-line bg-my-layer-1 p-3" aria-label="在当前空间创建 Agent">
    <h4 className="text-my-sm font-medium">新建空间 Agent · {snapshot.spaces.find((space) => space.id === task.spaceId)?.name}</h4>
    <Field label="Agent 名称"><input className={inputClass} value={name} maxLength={200} disabled={busy} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="工作指令"><textarea className={textareaClass} rows={4} value={instructions} disabled={busy} placeholder="职责、动手前检查、验证方式与汇报要求" onChange={(event) => setInstructions(event.target.value)} /></Field>
    <Field label="执行配置引用"><select className={inputClass} value={runtimeKind} disabled={busy} onChange={(event) => setRuntimeKind(event.target.value as CruxRuntimeKind)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="custom">自定义</option></select></Field>
    <p className="text-my-xs text-my-tertiary">创建后返回当前交接草稿。配置 Agent 不会启动执行。</p>
    {error && <p role="alert" className="collab-inline-error">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>返回交接</Button><Button size="sm" variant="primary" disabled={busy || !source.available || !name.trim() || !instructions.trim()} onClick={() => void create()}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}创建并选用</Button></div>
  </section>
}
