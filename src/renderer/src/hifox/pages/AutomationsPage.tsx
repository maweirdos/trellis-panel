import { formatCollaborationTime } from '../ui'
/**
 * 自动化：规则（触发器 → 目标 → 指令）的增删改、启停、手动运行与运行历史（PRD 3.8）。
 * Agent/小队目标当前只登记「等待 Runtime」；成员目标即时通知进收件箱。
 */
import { useState } from 'react'
import { Play, Plus, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useHifox, availableExecutionTargets } from '../store'
import { PageHeader, Field, inputClass, textareaClass } from '../ui'
import { Button, EmptyState, Modal, Switch } from '../../my/ui'
import type { HifoxAutomation, HifoxAutomationTriggerKind } from '@shared/hifox'
import { FlowIcon } from '../icons'

const TRIGGER_LABEL: Record<HifoxAutomationTriggerKind, string> = {
  schedule: '定时', task_status: '状态触发', task_created: '新任务', comment: '评论关键词'
}

export function AutomationsPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const shared = useHifox((s) => s.workspaceContext.state !== 'local')
  const run = useHifox((s) => s.run)
  const [editing, setEditing] = useState<HifoxAutomation | 'new' | null>(null)
  const [historyOf, setHistoryOf] = useState<HifoxAutomation | null>(null)
  if (!snapshot) return <></>

  const automations = snapshot.automations.filter((a) => a.spaceId === currentSpaceId)
  const statuses = snapshot.taskStatuses.filter((s) => s.spaceId === currentSpaceId)
  const { agents, crews } = availableExecutionTargets(snapshot, currentSpaceId)
  const members = snapshot.spaces.find((s) => s.id === currentSpaceId)?.memberIds
    .map((id) => snapshot.members.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => Boolean(m)) ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="自动化"
        description={`按时间、任务状态或评论触发；${shared ? '团队服务' : '本机应用'}负责定时规则，Agent 与小队等待运行环境执行`}
        actions={<Button variant="primary" size="sm" onClick={() => setEditing('new')}><Plus size={14} />新建自动化</Button>}
      />
      {automations.length === 0
        ? <EmptyState title="暂无自动化" description="把重复动作（汇总、通知、初检）交给规则" />
        : (
          <div className="my-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {automations.map((automation) => (
              <section key={automation.id} className={`flex flex-wrap items-center gap-3 rounded-my-md border p-3 ${automation.enabled ? 'border-my-line bg-my-layer-1' : 'border-my-line opacity-70'}`}>
                <div className="min-w-0 flex-1">
                  <h2 className="flex items-center gap-2 truncate text-sm font-medium text-my-primary">
                    <FlowIcon name="automations" size={18} />{automation.name}
                    <span className="rounded-my-sm bg-my-layer-1 px-1.5 py-0.5 text-my-2xs font-normal text-my-tertiary">
                      {TRIGGER_LABEL[automation.trigger.kind]}
                      {automation.trigger.kind === 'schedule' && ` ${automation.trigger.value}${automation.trigger.days?.length ? ` · 周${automation.trigger.days.join('、')}` : ' · 每天'}`}
                      {automation.trigger.kind === 'task_status' && ` → ${statuses.find((s) => s.id === automation.trigger.value)?.name ?? '—'}`}
                      {automation.trigger.kind === 'comment' && ` 含「${automation.trigger.value}」`}
                    </span>
                  </h2>
                  <p className="truncate text-my-xs text-my-tertiary">
                    交给 {automation.target.kind === 'none' ? '（无目标）' : `${automation.target.kind === 'member' ? '' : automation.target.kind === 'agent' ? 'Ⓐ ' : 'Ⓒ '}${automation.target.name}`}
                    {automation.instruction ? ` · ${automation.instruction}` : ''}
                  </p>
                </div>
                <span className="text-my-2xs text-my-tertiary">上次 {automation.lastRunAt ? formatCollaborationTime(automation.lastRunAt) : '未运行'}</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" title="手动运行一次" onClick={() => void run('运行自动化', () => api.hifox.runAutomation({ id: automation.id }))}><Play size={13} /></Button>
                  <Button variant="ghost" size="sm" onClick={() => setHistoryOf(automation)}>历史（{automation.runs.length}）</Button>
                  <Switch checked={automation.enabled} label="" onChange={(value) => void run('切换自动化', () => api.hifox.toggleAutomation({ id: automation.id, enabled: value }))} />
                  <Button variant="ghost" size="sm" onClick={() => setEditing(automation)}>编辑</Button>
                  <button type="button" aria-label={`删除 ${automation.name}`} className="grid h-7 w-7 place-items-center rounded-my-md text-my-tertiary hover:bg-my-layer-1 hover:text-red-400"
                    onClick={() => void run('删除自动化', () => api.hifox.removeAutomation({ id: automation.id }))}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </section>
            ))}
          </div>
        )}
      {editing && <AutomationEditor key={typeof editing === 'string' ? editing : editing.id}
        automation={editing}
        onClose={() => setEditing(null)}
        statuses={statuses.map((s) => ({ id: s.id, name: s.name }))}
        agents={agents.map((a) => ({ id: a.id, name: a.name }))}
        crews={crews.map((c) => ({ id: c.id, name: c.name }))}
        members={members.map((m) => ({ id: m.id, name: m.name }))}
      />}
      <Modal open={historyOf !== null} onClose={() => setHistoryOf(null)} width={480} ariaLabel="运行历史">
        <div className="flex flex-col gap-2 p-5">
          <h2 className="text-sm font-semibold text-my-primary">「{historyOf?.name}」运行历史</h2>
          <ul className="my-scrollbar max-h-80 space-y-1.5 overflow-y-auto">
            {(snapshot.automations.find((item) => item.id === historyOf?.id)?.runs ?? []).map((entry) => (
              <li key={entry.id} className="rounded-my-md border border-my-line px-2.5 py-2 text-my-xs">
                <p className="flex items-center gap-2">
                  <span className={`rounded-my-sm px-1.5 py-0.5 text-my-2xs ${entry.outcome === 'done' ? 'bg-emerald-500/15 text-emerald-500' : entry.outcome === 'waiting_runtime' ? 'bg-amber-500/15 text-amber-500' : 'bg-my-layer-1 text-my-tertiary'}`}>
                    {entry.outcome === 'done' ? '完成' : entry.outcome === 'waiting_runtime' ? '等待 Runtime' : '跳过'}
                  </span>
                  <span className="text-my-secondary">{entry.trigger}</span>
                  <span className="ml-auto text-my-tertiary">{formatCollaborationTime(entry.at)}</span>
                </p>
                {entry.detail && <p className="mt-1 text-my-tertiary">{entry.detail}</p>}
              </li>
            ))}
            {(historyOf?.runs.length ?? 0) === 0 && <li className="text-my-xs text-my-tertiary">还没有运行记录；可手动运行一次验证规则。</li>}
          </ul>
        </div>
      </Modal>
    </div>
  )
}

function AutomationEditor({ automation, onClose, statuses, agents, crews, members }: {
  automation: HifoxAutomation | 'new' | null
  onClose: () => void
  statuses: Array<{ id: string; name: string }>
  agents: Array<{ id: string; name: string }>
  crews: Array<{ id: string; name: string }>
  members: Array<{ id: string; name: string }>
}): JSX.Element | null {
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const shared = useHifox((s) => s.workspaceContext.state !== 'local')
  const run = useHifox((s) => s.run)
  const existing = automation && automation !== 'new' ? automation : null
  const [name, setName] = useState(existing?.name ?? '')
  const [triggerKind, setTriggerKind] = useState<HifoxAutomationTriggerKind>(existing?.trigger.kind ?? 'schedule')
  const [triggerValue, setTriggerValue] = useState(existing?.trigger.value ?? '09:00')
  const [target, setTarget] = useState(existing ? `${existing.target.kind}:${existing.target.id ?? ''}` : 'none:')
  const [instruction, setInstruction] = useState(existing?.instruction ?? '')
  const [days, setDays] = useState<number[]>(existing?.trigger.days ?? [])
  const busy = useHifox((s) => s.busy)

  if (!automation || !currentSpaceId) return null

  const submit = async (): Promise<void> => {
    const [kind, id] = target.split(':') as ['agent' | 'crew' | 'member' | 'none', string]
    const result = await run(existing ? '更新自动化' : '创建自动化', () => api.hifox.saveAutomation({
      id: existing?.id,
      spaceId: existing?.spaceId ?? currentSpaceId,
      name: name.trim(),
      enabled: existing?.enabled ?? true,
      trigger: { kind: triggerKind, value: triggerValue || undefined, days: triggerKind === 'schedule' ? days : undefined },
      target: { kind, id: id || undefined },
      instruction: instruction.trim() || undefined
    }))
    if (result?.ok) onClose()
  }

  return (
    <Modal open onClose={onClose} width={500} ariaLabel={existing ? '编辑自动化' : '新建自动化'}>
      <div className="my-scrollbar flex max-h-[var(--my-modal-max-height)] flex-col gap-3 overflow-y-auto p-5">
        <h2 className="text-sm font-semibold text-my-primary">{existing ? `编辑 ${existing.name}` : '新建自动化'}</h2>
        <Field label="名称"><input className={inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：每早汇总受阻任务" /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="触发器">
            <select className={inputClass} value={triggerKind} onChange={(e) => {
              const kind = e.target.value as HifoxAutomationTriggerKind
              setTriggerKind(kind)
              setTriggerValue(kind === 'schedule' ? '09:00' : kind === 'task_status' ? statuses[0]?.id ?? '' : '')
            }}>
              {(['schedule', 'task_status', 'task_created', 'comment'] as HifoxAutomationTriggerKind[]).map((k) => (
                <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>
              ))}
            </select>
          </Field>
          <Field label={triggerKind === 'schedule' ? '时间（HH:mm）' : triggerKind === 'task_status' ? '目标状态' : triggerKind === 'comment' ? '关键词' : '（无需参数）'}>
            {triggerKind === 'task_status'
              ? <select className={inputClass} value={triggerValue} onChange={(e) => setTriggerValue(e.target.value)}>
                  {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              : triggerKind === 'task_created'
                ? <input className={inputClass} disabled value="任意新任务" readOnly />
                : <input className={inputClass} value={triggerValue} onChange={(e) => setTriggerValue(e.target.value)} placeholder={triggerKind === 'schedule' ? '09:00' : '关键词'} />}
          </Field>
        </div>
        {triggerKind === 'schedule' && <Field label="执行日期" hint="不选择表示每天；应用运行期间按本机时区触发"><div className="flex flex-wrap gap-1">{[1, 2, 3, 4, 5, 6, 7].map((day) => <button type="button" key={day} aria-pressed={days.includes(day)} onClick={() => setDays(days.includes(day) ? days.filter((value) => value !== day) : [...days, day].sort())} className={`rounded-my-sm px-2 py-1 text-my-xs ${days.includes(day) ? 'bg-my-navigation-selected text-my-primary' : 'bg-my-layer-1 text-my-secondary'}`}>{['周一', '周二', '周三', '周四', '周五', '周六', '周日'][day - 1]}</button>)}</div></Field>}
        <Field label="交给谁执行">
          <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="none:">不指定（仅记录）</option>
            {agents.map((a) => <option key={`agent:${a.id}`} value={`agent:${a.id}`}>Agent · {a.name}（等待 Runtime）</option>)}
            {crews.map((c) => <option key={`crew:${c.id}`} value={`crew:${c.id}`}>小队 · {c.name}（等待 Runtime）</option>)}
            {members.map((m) => <option key={`member:${m.id}`} value={`member:${m.id}`}>成员 · {m.name}（通知）</option>)}
          </select>
        </Field>
        <Field label="指令 / 说明">
          <textarea className={textareaClass} style={{ minHeight: 'var(--my-space-80)' }} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="执行什么、输出什么、写回哪里" />
        </Field>
        <p className="text-my-xs leading-relaxed text-my-tertiary">
          {shared ? '定时规则由团队服务运行，使用服务所在时区；关闭桌面不会停止共享规则。' : '定时规则只在本机应用运行期间触发，使用本机时区。'}Agent 和小队的实际执行需要运行环境。
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={busy || !name.trim() || (triggerKind === 'schedule' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(triggerValue)) || (['task_status', 'comment'].includes(triggerKind) && !triggerValue.trim())} onClick={() => void submit()}>{existing ? '保存' : '创建'}</Button>
        </div>
      </div>
    </Modal>
  )
}
