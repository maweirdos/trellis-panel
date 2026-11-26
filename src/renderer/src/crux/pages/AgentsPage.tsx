/** Agent 职责、技能和生命周期配置。 */
import { useEffect, useState } from 'react'
import { Archive, Cpu, MessageCircle, Plus, RotateCcw } from 'lucide-react'
import type { CruxAgent, CruxAgentInput, CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'
import type { AcpAgentStatus } from '../../../../shared/types'
import { api } from '../../api'
import { runtimeHealthLabel } from '../../acp/runtime-status'
import { getRuntimeInventorySnapshot, subscribeRuntimeInventory } from '../../acp/useRuntimeInventoryRefresh'
import { Button, EmptyState, Modal, Switch } from '../../my/ui'
import { FlowIcon } from '../icons'
import { useAgentChatBridge } from '../agent-chat-bridge'
import {
  APPROVAL_OPTIONS_BY_RUNTIME,
  matchDetectedRuntime,
  MODEL_PRESET_OPTIONS,
  RUNTIME_KIND_OPTIONS,
  WORKDIR_MODE_OPTIONS,
  runtimeKindLabel,
  useLocalExecutionSlot,
  type LocalApprovalPolicy
} from '../local-execution-slot'
import { useCrux } from '../store'
import { PageHeader, Field, inputClass, textareaClass, Select } from '../ui'

type AgentView = 'active' | 'disabled' | 'archived' | 'exclusive'

function agentInput(agent: CruxAgent): CruxAgentInput & { id: string } {
  return {
    id: agent.id, spaceId: agent.spaceId, name: agent.name, description: agent.description,
    instructions: agent.instructions, skillIds: agent.skillIds, repositories: agent.repositories,
    runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory,
    enabled: agent.enabled, archived: agent.archived
  }
}

export function AgentsPage(): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const currentSpaceId = useCrux((state) => state.currentSpaceId)
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const resolveAgentSlot = useLocalExecutionSlot((state) => state.resolveAgentSlot)
  const [detectedRuntimes, setDetectedRuntimes] = useState<AcpAgentStatus[]>(getRuntimeInventorySnapshot)
  const [editing, setEditing] = useState<CruxAgent | 'new' | null>(null)
  const [view, setView] = useState<AgentView>('active')
  const [keyword, setKeyword] = useState('')
  useEffect(() => subscribeRuntimeInventory(setDetectedRuntimes), [])
  if (!snapshot) return null
  const agents = snapshot.agents.filter((agent) => agent.spaceId === currentSpaceId &&
    `${agent.name} ${agent.description ?? ''}`.toLowerCase().includes(keyword.toLowerCase()) &&
    (view === 'archived' ? agent.archived : !agent.archived && (view === 'exclusive' ? Boolean(agent.exclusiveCrewId) : !agent.exclusiveCrewId && (view === 'active' ? agent.enabled : !agent.enabled))))

  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="Agent" description="第一层维护团队共享职责、工作指令与技能；第二层本机执行槽（Runtime/模型/审批）仅在各人本机生效。"
      actions={<Button variant="primary" size="sm" disabled={busy || !currentSpaceId} onClick={() => setEditing('new')}><Plus size={14} />新建 Agent</Button>} />
    <div className="flex flex-wrap items-center gap-2">
      <input className={`${inputClass} max-w-xs`} aria-label="搜索 Agent" placeholder="搜索 Agent 名称或职责" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
      <Select
        size="sm"
        ariaLabel="Agent 列表范围"
        value={view}
        onChange={(val) => setView(val as AgentView)}
        options={[
          { value: 'active', label: '可独立指派' },
          { value: 'disabled', label: '已停用' },
          { value: 'exclusive', label: '小队专属配置' },
          { value: 'archived', label: '已归档' }
        ]}
      />
      <span className="text-my-xs text-my-tertiary">{agents.length} 个 Agent</span>
    </div>
    <p className="text-my-xs text-my-tertiary">团队共享岗位定义（左侧/上级配置）；各自本机默认执行槽可在「Agent 目录」全局设置或点「编辑」单独覆盖。</p>
    {agents.length === 0 ? <EmptyState title="没有匹配的 Agent" description="调整筛选，或先创建一个职责明确的 Agent" /> :
      <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
        {agents.map((agent) => {
          const tasks = snapshot.tasks.filter((task) => task.executor?.kind === 'agent' && task.executor.id === agent.id)
          const crews = snapshot.crews.filter((crew) => crew.captain.id === agent.id || crew.members.some((ref) => ref.kind === 'agent' && ref.id === agent.id))
          const captainOf = crews.find((crew) => !crew.archived && crew.captain.id === agent.id)
          const localSlot = resolveAgentSlot(agent.id, { runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory })
          const matchedRuntime = matchDetectedRuntime(detectedRuntimes, localSlot.slot.runtimeKind)
          const runtimeStatusText = matchedRuntime ? runtimeHealthLabel(matchedRuntime) : '待探测'
          return <section key={agent.id} className="flex flex-col gap-3 rounded-my-md border border-my-line bg-my-layer-1 p-3">
            <header className="flex items-start gap-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-my-md bg-my-layer-2 text-my-secondary"><FlowIcon name="agents" size={20} /></span>
              <div className="min-w-0 flex-1"><h2 className="my-item-title truncate">{agent.name}</h2><p className="my-item-description">{agent.description || '暂无职责描述'}</p></div>
              {!agent.archived && <Switch checked={agent.enabled} disabled={busy || Boolean(captainOf)} label={captainOf ? `请先更换「${captainOf.name}」的队长` : `启用 ${agent.name}`} onChange={(enabled) => void run('更新 Agent 状态', () => api.crux.saveAgent({ ...agentInput(agent), enabled }))} />}
            </header>
            <div className="flex flex-wrap items-center gap-2 text-my-2xs text-my-tertiary">
              <span>{agent.archived ? '已归档' : agent.enabled ? '已启用' : '已停用'}</span>
              <span className="inline-flex items-center gap-1 text-my-secondary"><Cpu size={11} aria-hidden="true" />本机：{runtimeKindLabel(localSlot.slot.runtimeKind)} · {runtimeStatusText}</span>
              {agent.exclusiveCrewId && <span>小队专属 · {snapshot.crews.find((crew) => crew.id === agent.exclusiveCrewId)?.name ?? '所属小队'}</span>}
              {captainOf && <span>队长 · {captainOf.name}</span>}
            </div>
            <p className="line-clamp-3 whitespace-pre-wrap rounded-my-md bg-my-layer-2 px-2.5 py-2 text-my-xs leading-relaxed text-my-secondary">{agent.instructions}</p>
            <div className="flex flex-wrap gap-1.5 text-my-xs text-my-secondary">
              {agent.skillIds.map((id) => {
                const skill = snapshot.skills.find((item) => item.id === id)
                return skill ? <span key={id} className="inline-flex items-center gap-1 rounded-my-sm border border-my-line px-1.5 py-0.5"><FlowIcon name="skills" size={12} />{skill.name}</span> : null
              })}
              {agent.skillIds.length === 0 && <span className="text-my-tertiary">尚未绑定技能</span>}
            </div>
            <footer className="mt-auto flex flex-wrap items-center gap-2">
              <span className="text-my-2xs text-my-tertiary">关联任务 {tasks.length} · 小队 {crews.length}</span>
              <div className="ml-auto flex gap-1">
                {agent.enabled && !agent.archived && !agent.exclusiveCrewId && (
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => useAgentChatBridge.getState().startAgentChat(agent.id, { runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory })}>
                    <MessageCircle size={13} />发起对话
                  </Button>
                )}
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(agent)}>{agent.archived ? '查看配置' : '编辑'}</Button>
                {agent.archived
                  ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run('恢复 Agent', () => api.crux.saveAgent({ ...agentInput(agent), archived: false }))}><RotateCcw size={13} />恢复</Button>
                  : <Button variant="ghost" size="sm" disabled={busy || Boolean(captainOf)} title={captainOf ? `请先更换「${captainOf.name}」的队长或归档小队` : '归档后保留历史任务，可恢复'} onClick={() => void run('归档 Agent', () => api.crux.removeAgent({ id: agent.id }))}><Archive size={13} />归档</Button>}
              </div>
            </footer>
          </section>
        })}
      </div>}
    {editing && currentSpaceId && <AgentEditor key={`${currentSpaceId}:${editing === 'new' ? 'new' : editing.id}`} agent={editing === 'new' ? null : editing} spaceId={currentSpaceId} onClose={() => setEditing(null)} />}
  </div>
}

export function AgentEditor({ agent, spaceId, onClose }: { agent: CruxAgent | null; spaceId: string; onClose: () => void }): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const { resolveAgentSlot, setAgentOverride, clearAgentOverride, conflictNotice, clearConflictNotice } = useLocalExecutionSlot()
  const [name, setName] = useState(agent?.name ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  const [skillIds, setSkillIds] = useState<string[]>(agent?.skillIds ?? [])
  const [runtimeKind, setRuntimeKind] = useState<CruxRuntimeKind>(agent?.runtimeKind ?? 'claude-code')
  const [workingDirectory, setWorkingDirectory] = useState<CruxWorkingDirectoryMode>(agent?.workingDirectory ?? 'repo')
  const [repos, setRepos] = useState((agent?.repositories ?? []).map((repo) => repo.name).join('\n'))
  if (!snapshot) return null
  const skills = snapshot.skills.filter((skill) => !skill.spaceId || skill.spaceId === (agent?.spaceId ?? spaceId))
  const localSlot = agent ? resolveAgentSlot(agent.id) : null
  const submit = async (): Promise<void> => {
    if (busy || !name.trim() || !instructions.trim()) return
    const repositories = [...new Set(repos.split('\n').map((value) => value.trim()).filter(Boolean))]
      .map((repoName) => ({ name: repoName, url: agent?.repositories.find((repo) => repo.name === repoName)?.url }))
    const result = await run(agent ? '更新 Agent' : '创建 Agent', () => api.crux.saveAgent({
      id: agent?.id, spaceId: agent?.spaceId ?? spaceId, name: name.trim(), description: description.trim() || undefined,
      instructions: instructions.trim(), skillIds, repositories, runtimeKind, workingDirectory,
      enabled: agent?.enabled ?? true, archived: agent?.archived ?? false
    }))
    if (result?.ok) onClose()
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={580} ariaLabel={agent ? '编辑 Agent' : '新建 Agent'}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col gap-3 p-4">
      <h2 className="shrink-0 text-sm font-semibold text-my-primary">{agent ? `编辑 ${agent.name}` : '新建 Agent'}</h2>
      <div className="my-scrollbar min-h-0 overflow-y-auto pr-1">
        <div className="flex flex-col gap-3">
          <p className="text-my-2xs font-medium text-my-tertiary">第一层：共享岗位定义（随团队空间同步）</p>
          <div className="grid grid-cols-2 gap-2"><Field label="名称"><input className={inputClass} autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="如：前端修复" /></Field><Field label="职责描述"><input className={inputClass} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="适合承接什么工作" /></Field></div>
          <Field label="工作指令" hint="写清职责、动手前检查、需要先问人的情形、验证方式和汇报要求。">
            <textarea className={`${textareaClass} font-mono text-my-xs`} style={{ minHeight: 'var(--my-space-144)' }} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="接到任务后先阅读需求和最近评论；修改后运行相关检查；汇报结果、验证与风险。" />
          </Field>
          <fieldset><legend className="mb-2 text-my-xs font-medium text-my-tertiary">绑定技能</legend>
            <div className="flex flex-col gap-2">{skills.map((skill) => <label key={skill.id} className="flex items-start gap-2 rounded-my-md border border-my-line p-2 text-my-xs text-my-secondary">
              <input className="mt-0.5" type="checkbox" checked={skillIds.includes(skill.id)} onChange={(event) => setSkillIds((previous) => event.target.checked ? [...previous, skill.id] : previous.filter((id) => id !== skill.id))} />
              <span><span className="font-medium">{skill.name}</span><span className="ml-2 text-my-2xs text-my-tertiary">{skill.spaceId ? '空间技能' : '组织技能'}</span>{skill.description && <span className="mt-1 block text-my-tertiary">{skill.description}</span>}</span>
            </label>)}{skills.length === 0 && <p className="text-my-xs text-my-tertiary">暂无可用技能，可先在技能库中创建。</p>}</div>
          </fieldset>
          <details className="rounded-my-md border border-my-line p-2.5 text-my-xs text-my-secondary"><summary className="cursor-pointer">团队默认引用（代码库与参考引擎）</summary>
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-my-tertiary">仅保存团队参考引用；实际执行时的本机 Runtime、审批与目录偏好由成员各自的「本机执行槽」接管。</p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="参考 Runtime">
                  <Select
                    className="w-full"
                    value={runtimeKind}
                    onChange={(val) => setRuntimeKind(val as CruxRuntimeKind)}
                    options={[
                      { value: 'claude-code', label: 'Claude Code' },
                      { value: 'codex', label: 'Codex' },
                      { value: 'custom', label: '自定义' }
                    ]}
                  />
                </Field>
                <Field label="参考目录模式">
                  <Select
                    className="w-full"
                    value={workingDirectory}
                    onChange={(val) => setWorkingDirectory(val as CruxWorkingDirectoryMode)}
                    options={[
                      { value: 'repo', label: '仓库目录' },
                      { value: 'temp', label: '临时目录' }
                    ]}
                  />
                </Field>
              </div>
              <Field label="代码库名称（每行一个）"><textarea className={`${textareaClass} font-mono text-my-xs`} style={{ minHeight: 'var(--my-space-64)' }} value={repos} onChange={(event) => setRepos(event.target.value)} /></Field>
            </div>
          </details>
          <section aria-label="第二层：我的本机执行槽" className="rounded-my-base border border-my-line bg-my-layer-1 p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="flex items-center gap-1.5 text-my-xs font-medium text-my-primary"><Cpu size={13} aria-hidden="true" />第二层：我的本机执行槽（仅当前设备生效）</h3>
                <p className="mt-0.5 text-my-2xs text-my-tertiary">{agent && localSlot ? (localSlot.overridden ? '当前已为此岗位单独覆盖本机配置' : '当前继承我的全局本机默认执行槽') : '保存新岗位后，将自动继承我的全局本机默认执行槽'}</p>
              </div>
              {agent && localSlot && <Switch checked={localSlot.overridden} label="为此岗位单独覆盖" onChange={(checked) => {
                if (checked) setAgentOverride(agent.id, { ...localSlot.slot })
                else clearAgentOverride(agent.id)
              }} />}
            </div>
            {agent && localSlot && (
              <div className="grid grid-cols-2 gap-2 text-my-xs">
                <Field label="本机 Runtime 引擎">
                  <Select className="w-full" disabled={!localSlot.overridden} value={localSlot.slot.runtimeKind}
                    onChange={(val) => setAgentOverride(agent.id, { runtimeKind: val as CruxRuntimeKind })}
                    options={[...RUNTIME_KIND_OPTIONS]} />
                </Field>
                <Field label="本机默认模型">
                  <Select className="w-full" disabled={!localSlot.overridden} value={localSlot.slot.model}
                    onChange={(val) => setAgentOverride(agent.id, { model: val })}
                    options={[...MODEL_PRESET_OPTIONS]} />
                </Field>
                <Field label="审批策略">
                  <Select className="w-full" disabled={!localSlot.overridden} value={localSlot.slot.approvalPolicy}
                    onChange={(val) => setAgentOverride(agent.id, { approvalPolicy: val as LocalApprovalPolicy })}
                    options={[...APPROVAL_OPTIONS_BY_RUNTIME[localSlot.slot.runtimeKind]]} />
                </Field>
                <Field label="目录执行策略">
                  <Select className="w-full" disabled={!localSlot.overridden} value={localSlot.slot.workingDirectory}
                    onChange={(val) => setAgentOverride(agent.id, { workingDirectory: val as CruxWorkingDirectoryMode })}
                    options={[...WORKDIR_MODE_OPTIONS]} />
                </Field>
              </div>
            )}
            {conflictNotice && <div className="flex items-center justify-between gap-2 text-my-2xs text-my-warning-text" role="status">
              <span>{conflictNotice}</span>
              <button type="button" className="text-my-secondary hover:text-my-primary" onClick={clearConflictNotice}>知道了</button>
            </div>}
          </section>
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" disabled={busy || !name.trim() || !instructions.trim()} onClick={() => void submit()}>{busy ? '保存中…' : agent ? '保存' : '创建'}</Button></div>
    </div>
  </Modal>
}
