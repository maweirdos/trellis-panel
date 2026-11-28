import { useRef, useState, type JSX } from 'react'
import { History, MoreHorizontal, Pencil, Play, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { CruxAutomation, CruxAutomationTriggerKind } from '@shared/crux'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, Dropdown, DropdownItem, EmptyState, Modal, Switch, Tooltip } from '../../my/ui'
import { AUTOMATION_PRESETS, type AutomationPreset } from '../collaboration-platform-store'
import { FlowIcon } from '../icons'
import { availableExecutionTargets, statusDisplayName, useCrux } from '../store'
import { Field, formatCollaborationTime, inputClass, PageHeader, Select, textareaClass } from '../ui'

const TRIGGER_LABEL: Record<CruxAutomationTriggerKind, string> = {
  schedule: '定时',
  task_status: '状态触发',
  task_created: '新任务',
  comment: '评论关键词'
}

/**
 * 自动化：规则（触发器 → 目标 → 指令）的增删改、启停、手动运行与运行历史。
 */
export function AutomationsPage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const currentSpaceId = useCrux((s) => s.currentSpaceId)
  const shared = useCrux((s) => s.workspaceContext.state !== 'local')
  const run = useCrux((s) => s.run)
  const busy = useCrux((s) => s.busy)

  const [editing, setEditing] = useState<CruxAutomation | 'new' | null>(null)
  const [historyOf, setHistoryOf] = useState<CruxAutomation | null>(null)
  const [presetsOpen, setPresetsOpen] = useState(false)

  const historySnapshotRef = useRef<CruxAutomation | null>(null)
  if (historyOf) historySnapshotRef.current = historyOf

  if (!snapshot) return null

  const automations = snapshot.automations.filter((a) => a.spaceId === currentSpaceId)
  const statuses = snapshot.taskStatuses.filter((s) => s.spaceId === currentSpaceId)
  const { agents, crews } = availableExecutionTargets(snapshot, currentSpaceId)
  const members = snapshot.spaces.find((s) => s.id === currentSpaceId)?.memberIds
    .map((id) => snapshot.members.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m)) ?? []

  const applyPreset = async (preset: AutomationPreset): Promise<void> => {
    if (!currentSpaceId) return
    const defaultAgent = agents[0]
    const defaultMember = members[0]
    const target = defaultAgent
      ? { kind: 'agent' as const, id: defaultAgent.id }
      : defaultMember
        ? { kind: 'member' as const, id: defaultMember.id }
        : { kind: 'none' as const }
    const res = await run('创建自动化模板', () => api.crux.saveAutomation({
      spaceId: currentSpaceId,
      name: preset.name,
      enabled: true,
      trigger: { kind: preset.triggerKind, value: preset.triggerValue || undefined, days: preset.days },
      target,
      instruction: preset.instruction
    }))
    if (res?.ok) setPresetsOpen(false)
  }

  const removeAutomation = async (automation: CruxAutomation): Promise<void> => {
    const ok = await confirmDialog({
      title: `删除自动化「${automation.name}」？`,
      message: '删除后该规则将不再触发，历史记录一并移除，无法撤销。',
      confirmText: '删除规则',
      danger: true
    })
    if (!ok) return
    await run('删除自动化', () => api.crux.removeAutomation({ id: automation.id }))
  }

  const shownHistory = historySnapshotRef.current
  const liveHistoryRuns = shownHistory
    ? (snapshot.automations.find((item) => item.id === shownHistory.id)?.runs ?? shownHistory.runs)
    : []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Agent 自动化"
        description={`响应任务事件或定时计划让 Agent 自主工作；${shared ? '团队服务' : '本机应用'}负责调度触发。`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPresetsOpen(true)}>
              <Sparkles size={14} />
              <span>模板库</span>
            </Button>
            <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
              <Plus size={14} />
              <span>创建自动化</span>
            </Button>
          </div>
        }
      />

      {automations.length === 0 ? (
        <EmptyState
          icon={<FlowIcon name="automations" size={28} />}
          title="暂无自动化规则"
          description="把重复动作（定时汇总、状态流转通知、初检分拣）交给自动化规则持续执行。"
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
                <Plus size={14} />
                <span>创建自动化</span>
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPresetsOpen(true)}>
                <Sparkles size={14} />
                <span>从模板库启用</span>
              </Button>
            </div>
          }
        />
      ) : (
        <div className="my-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
          {automations.map((automation) => (
            <section
              key={automation.id}
              className={`my-card flex flex-wrap items-center gap-3 p-4 transition-opacity duration-150 ${
                automation.enabled ? '' : 'opacity-70'
              }`}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <h2 className="my-item-title flex flex-wrap items-center gap-2 text-my-sm font-medium text-my-primary">
                  <FlowIcon name="automations" size={16} />
                  <span className="truncate">{automation.name}</span>
                  <span className="rounded-my-sm bg-my-layer-1 px-1.5 py-0.5 text-my-2xs font-normal text-my-secondary">
                    {TRIGGER_LABEL[automation.trigger.kind]}
                    {automation.trigger.kind === 'schedule' && ` ${automation.trigger.value}${automation.trigger.days?.length ? ` · 周${automation.trigger.days.join('、')}` : ' · 每天'}`}
                    {automation.trigger.kind === 'task_status' && ` → ${statusDisplayName(statuses.find((s) => s.id === automation.trigger.value))}`}
                    {automation.trigger.kind === 'comment' && ` 含「${automation.trigger.value}」`}
                  </span>
                </h2>
                <p className="truncate text-my-xs text-my-secondary">
                  交给 {automation.target.kind === 'none' ? '（无目标）' : `${automation.target.kind === 'member' ? '' : automation.target.kind === 'agent' ? 'Agent · ' : '小队 · '}${automation.target.name}`}
                  {automation.instruction ? ` · ${automation.instruction}` : ''}
                </p>
              </div>

              <span className="text-my-2xs tabular-nums text-my-tertiary">
                上次 {automation.lastRunAt ? formatCollaborationTime(automation.lastRunAt) : '未运行'}
              </span>

              <div className="flex items-center gap-2">
                <Switch
                  checked={automation.enabled}
                  label=""
                  onChange={(value) => void run('切换自动化', () => api.crux.toggleAutomation({ id: automation.id, enabled: value }))}
                />
                <Tooltip label="手动运行一次">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`运行 ${automation.name}`}
                    onClick={() => void run('运行自动化', () => api.crux.runAutomation({ id: automation.id }))}
                  >
                    <Play size={14} />
                  </Button>
                </Tooltip>
                <Dropdown
                  align="right"
                  width={156}
                  trigger={({ toggle, open }) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${automation.name} 更多操作`}
                      aria-expanded={open}
                      onClick={toggle}
                    >
                      <MoreHorizontal size={14} />
                    </Button>
                  )}
                >
                  {(close) => (
                    <>
                      <DropdownItem onClick={() => { close(); setHistoryOf(automation) }}>
                        <History size={13} />
                        <span>运行历史（{automation.runs.length}）</span>
                      </DropdownItem>
                      <DropdownItem onClick={() => { close(); setEditing(automation) }}>
                        <Pencil size={13} />
                        <span>编辑规则</span>
                      </DropdownItem>
                      <DropdownItem danger onClick={() => { close(); void removeAutomation(automation) }}>
                        <Trash2 size={13} />
                        <span>删除规则</span>
                      </DropdownItem>
                    </>
                  )}
                </Dropdown>
              </div>
            </section>
          ))}
        </div>
      )}

      <AutomationEditor
        open={editing !== null}
        automation={editing}
        onClose={() => setEditing(null)}
        statuses={statuses.map((s) => ({ id: s.id, name: statusDisplayName(s) }))}
        agents={agents.map((a) => ({ id: a.id, name: a.name }))}
        crews={crews.map((c) => ({ id: c.id, name: c.name }))}
        members={members.map((m) => ({ id: m.id, name: m.name }))}
      />

      <Modal open={historyOf !== null} onClose={() => setHistoryOf(null)} width={480} placement="center" ariaLabel="运行历史">
        <div className="flex max-h-[82vh] flex-col">
          <header className="shrink-0 border-b border-my-line px-6 py-4">
            <h2 className="text-my-base font-medium text-my-primary">「{shownHistory?.name}」运行历史</h2>
          </header>
          <div className="my-scrollbar my-fade-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <ul className="space-y-2">
              {liveHistoryRuns.map((entry) => (
                <li key={entry.id} className="my-card px-3 py-2.5 text-my-xs">
                  <p className="flex items-center gap-2">
                    <span
                      className={`rounded-my-sm px-1.5 py-0.5 text-my-2xs ${
                        entry.outcome === 'done'
                          ? 'bg-my-success-subtle text-my-success-text'
                          : entry.outcome === 'waiting_runtime'
                            ? 'bg-my-warning-subtle text-my-warning-text'
                            : 'bg-my-layer-1 text-my-tertiary'
                      }`}
                    >
                      {entry.outcome === 'done' ? '完成' : entry.outcome === 'waiting_runtime' ? '等待 Runtime' : '跳过'}
                    </span>
                    <span className="text-my-secondary">{entry.trigger}</span>
                    <span className="ml-auto tabular-nums text-my-tertiary">{formatCollaborationTime(entry.at)}</span>
                  </p>
                  {entry.detail && <p className="mt-1.5 text-my-secondary">{entry.detail}</p>}
                </li>
              ))}
              {liveHistoryRuns.length === 0 && (
                <li className="py-4 text-center text-my-xs text-my-tertiary">还没有运行记录；可手动运行一次验证规则。</li>
              )}
            </ul>
          </div>
          <footer className="flex shrink-0 justify-end border-t border-my-line px-6 py-3.5">
            <Button size="sm" variant="ghost" onClick={() => setHistoryOf(null)}>关闭</Button>
          </footer>
        </div>
      </Modal>

      <Modal open={presetsOpen} onClose={() => setPresetsOpen(false)} width={560} placement="center" ariaLabel="自动化规则模板">
        <div className="flex max-h-[82vh] flex-col">
          <header className="shrink-0 border-b border-my-line px-6 py-4">
            <h2 className="text-my-base font-medium text-my-primary">常用协作自动化模板</h2>
            <p className="mt-0.5 text-my-xs text-my-secondary">一键创建并默认指派给当前空间可用 Agent（若无则通知成员），创建后可随时微调。</p>
          </header>
          <div className="my-scrollbar my-fade-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto px-6 py-5">
            {AUTOMATION_PRESETS.map((preset) => (
              <div key={preset.id} className="my-card flex items-start justify-between gap-3 p-3.5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="my-item-title text-my-sm font-medium text-my-primary">{preset.name}</div>
                  <p className="my-item-description text-my-xs text-my-secondary">{preset.description}</p>
                  <p className="text-my-2xs text-my-tertiary">
                    触发：{TRIGGER_LABEL[preset.triggerKind]}{preset.triggerValue ? ` · ${preset.triggerValue}` : ''}
                  </p>
                </div>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void applyPreset(preset)}>
                  一键启用
                </Button>
              </div>
            ))}
          </div>
          <footer className="flex shrink-0 justify-end border-t border-my-line px-6 py-3.5">
            <Button size="sm" variant="ghost" onClick={() => setPresetsOpen(false)}>关闭</Button>
          </footer>
        </div>
      </Modal>
    </div>
  )
}

interface AutomationEditorProps {
  open: boolean
  automation: CruxAutomation | 'new' | null
  onClose: () => void
  statuses: Array<{ id: string; name: string }>
  agents: Array<{ id: string; name: string }>
  crews: Array<{ id: string; name: string }>
  members: Array<{ id: string; name: string }>
}

function AutomationEditor(props: AutomationEditorProps): JSX.Element {
  const busy = useCrux((s) => s.busy)
  const lastAutomationRef = useRef<CruxAutomation | 'new' | null>(null)
  const sessionRef = useRef(0)
  const wasOpenRef = useRef(false)
  if (props.open && props.automation) {
    lastAutomationRef.current = props.automation
    if (!wasOpenRef.current) sessionRef.current++
  }
  wasOpenRef.current = props.open
  const current = lastAutomationRef.current
  const existing = current && current !== 'new' ? current : null

  return (
    <Modal open={props.open} onClose={() => { if (!busy) props.onClose() }} width={520} placement="center" ariaLabel={existing ? '编辑自动化' : '新建自动化'}>
      <AutomationEditorForm
        key={`${sessionRef.current}:${existing?.id ?? 'new'}`}
        existing={existing}
        onClose={props.onClose}
        statuses={props.statuses}
        agents={props.agents}
        crews={props.crews}
        members={props.members}
      />
    </Modal>
  )
}

function AutomationEditorForm({
  existing,
  onClose,
  statuses,
  agents,
  crews,
  members
}: {
  existing: CruxAutomation | null
  onClose: () => void
  statuses: Array<{ id: string; name: string }>
  agents: Array<{ id: string; name: string }>
  crews: Array<{ id: string; name: string }>
  members: Array<{ id: string; name: string }>
}): JSX.Element {
  const currentSpaceId = useCrux((s) => s.currentSpaceId)
  const shared = useCrux((s) => s.workspaceContext.state !== 'local')
  const run = useCrux((s) => s.run)
  const busy = useCrux((s) => s.busy)

  const [name, setName] = useState(existing?.name ?? '')
  const [triggerKind, setTriggerKind] = useState<CruxAutomationTriggerKind>(existing?.trigger.kind ?? 'schedule')
  const [triggerValue, setTriggerValue] = useState(existing?.trigger.value ?? '09:00')
  const [target, setTarget] = useState(existing ? `${existing.target.kind}:${existing.target.id ?? ''}` : 'none:')
  const [instruction, setInstruction] = useState(existing?.instruction ?? '')
  const [days, setDays] = useState<number[]>(existing?.trigger.days ?? [])

  const invalidReason = !currentSpaceId
    ? '当前未选中空间'
    : !name.trim()
      ? '请先填写规则名称'
      : triggerKind === 'schedule' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(triggerValue)
        ? '请填写 24 小时制时间，例如 09:00'
        : (triggerKind === 'task_status' || triggerKind === 'comment') && !triggerValue.trim()
          ? '请先完善触发器参数'
          : null

  const submit = async (): Promise<void> => {
    if (!currentSpaceId || invalidReason) return
    const [kind, id] = target.split(':') as ['agent' | 'crew' | 'member' | 'none', string]
    const result = await run(existing ? '更新自动化' : '创建自动化', () => api.crux.saveAutomation({
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
    <div className="flex max-h-[82vh] flex-col">
      <header className="shrink-0 border-b border-my-line px-6 py-4">
        <h2 className="text-my-base font-medium text-my-primary">{existing ? `编辑 ${existing.name}` : '新建自动化'}</h2>
      </header>

      <div className="my-scrollbar my-fade-scroll min-h-0 flex-1 space-y-3.5 overflow-y-auto px-6 py-5">
        <Field label="名称">
          <input className={inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：每早汇总受阻任务" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="触发器">
            <Select
              className="w-full"
              value={triggerKind}
              onChange={(val) => {
                const kind = val as CruxAutomationTriggerKind
                setTriggerKind(kind)
                setTriggerValue(kind === 'schedule' ? '09:00' : kind === 'task_status' ? statuses[0]?.id ?? '' : '')
              }}
              options={((['schedule', 'task_status', 'task_created', 'comment'] as CruxAutomationTriggerKind[])).map((k) => ({
                value: k,
                label: TRIGGER_LABEL[k]
              }))}
            />
          </Field>
          <Field label={triggerKind === 'schedule' ? '时间（HH:mm）' : triggerKind === 'task_status' ? '目标状态' : triggerKind === 'comment' ? '关键词' : '（无需参数）'}>
            {triggerKind === 'task_status' ? (
              <Select
                className="w-full"
                value={triggerValue}
                onChange={setTriggerValue}
                options={statuses.map((s) => ({ value: s.id, label: s.name }))}
              />
            ) : triggerKind === 'task_created' ? (
              <input className={inputClass} disabled value="任意新任务" readOnly />
            ) : (
              <input className={inputClass} value={triggerValue} onChange={(e) => setTriggerValue(e.target.value)} placeholder={triggerKind === 'schedule' ? '09:00' : '关键词'} />
            )}
          </Field>
        </div>

        {triggerKind === 'schedule' && (
          <Field label="执行日期" hint="不选择表示每天；应用运行期间按本机时区触发">
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                const selected = days.includes(day)
                return (
                  <button
                    type="button"
                    key={day}
                    aria-pressed={selected}
                    onClick={() => setDays(selected ? days.filter((value) => value !== day) : [...days, day].sort())}
                    className={`rounded-my-sm border px-2 py-1 text-my-xs transition-colors ${
                      selected
                        ? 'border-my-accent bg-my-accent-subtle text-my-primary'
                        : 'border-my-line bg-my-canvas text-my-secondary hover:bg-my-layer-1'
                    }`}
                  >
                    {['周一', '周二', '周三', '周四', '周五', '周六', '周日'][day - 1]}
                  </button>
                )
              })}
            </div>
          </Field>
        )}

        <Field label="交给谁执行">
          <Select
            className="w-full"
            value={target}
            onChange={setTarget}
            options={[
              { value: 'none:', label: '不指定（仅记录）' },
              ...agents.map((a) => ({ value: `agent:${a.id}`, label: `Agent · ${a.name}（等待 Runtime）` })),
              ...crews.map((c) => ({ value: `crew:${c.id}`, label: `小队 · ${c.name}（等待 Runtime）` })),
              ...members.map((m) => ({ value: `member:${m.id}`, label: `成员 · ${m.name}（通知）` }))
            ]}
          />
        </Field>
        <Field label="指令 / 说明">
          <textarea className={textareaClass} style={{ minHeight: 'var(--my-space-80)' }} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="执行什么、输出什么、写回哪里" />
        </Field>
        <p className="text-my-xs leading-relaxed text-my-tertiary">
          {shared ? '定时规则由团队服务运行，使用服务所在时区；关闭桌面不会停止共享规则。' : '定时规则只在本机应用运行期间触发，使用本机时区。'}Agent 和小队的实际执行需要运行环境。
        </p>
      </div>

      <footer className="flex shrink-0 justify-end gap-2 border-t border-my-line px-6 py-3.5">
        <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
        {invalidReason ? (
          <Tooltip label={invalidReason} wrap>
            <span className="inline-flex">
              <Button variant="primary" size="sm" disabled>
                {existing ? '保存' : '创建'}
              </Button>
            </span>
          </Tooltip>
        ) : (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
            {existing ? '保存' : '创建'}
          </Button>
        )}
      </footer>
    </div>
  )
}
