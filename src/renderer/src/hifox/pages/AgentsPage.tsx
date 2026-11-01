/** Agent 职责、技能和生命周期配置。 */
import { useState } from 'react'
import { Archive, Plus, RotateCcw } from 'lucide-react'
import type { HifoxAgent, HifoxAgentInput, HifoxRuntimeKind, HifoxWorkingDirectoryMode } from '@shared/hifox'
import { api } from '../../api'
import { Button, EmptyState, Modal, Switch } from '../../my/ui'
import { FlowIcon } from '../icons'
import { useHifox } from '../store'
import { PageHeader, Field, inputClass, textareaClass, compactInputClass } from '../ui'

type AgentView = 'active' | 'disabled' | 'archived' | 'exclusive'

function agentInput(agent: HifoxAgent): HifoxAgentInput & { id: string } {
  return {
    id: agent.id, spaceId: agent.spaceId, name: agent.name, description: agent.description,
    instructions: agent.instructions, skillIds: agent.skillIds, repositories: agent.repositories,
    runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory,
    enabled: agent.enabled, archived: agent.archived
  }
}

export function AgentsPage(): JSX.Element | null {
  const snapshot = useHifox((state) => state.snapshot)
  const currentSpaceId = useHifox((state) => state.currentSpaceId)
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const [editing, setEditing] = useState<HifoxAgent | 'new' | null>(null)
  const [view, setView] = useState<AgentView>('active')
  const [keyword, setKeyword] = useState('')
  if (!snapshot) return null
  const agents = snapshot.agents.filter((agent) => agent.spaceId === currentSpaceId &&
    `${agent.name} ${agent.description ?? ''}`.toLowerCase().includes(keyword.toLowerCase()) &&
    (view === 'archived' ? agent.archived : !agent.archived && (view === 'exclusive' ? Boolean(agent.exclusiveCrewId) : !agent.exclusiveCrewId && (view === 'active' ? agent.enabled : !agent.enabled))))

  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="Agent" description="维护稳定职责、工作指令与技能；任务目标和验收标准留在任务中。"
      actions={<Button variant="primary" size="sm" disabled={busy || !currentSpaceId} onClick={() => setEditing('new')}><Plus size={14} />新建 Agent</Button>} />
    <div className="flex flex-wrap items-center gap-2">
      <input className={`${inputClass} max-w-xs`} aria-label="搜索 Agent" placeholder="搜索 Agent 名称或职责" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
      <select className={`${compactInputClass}`} aria-label="Agent 列表范围" value={view} onChange={(event) => setView(event.target.value as AgentView)}>
        <option value="active">可独立指派</option><option value="disabled">已停用</option><option value="exclusive">小队专属配置</option><option value="archived">已归档</option>
      </select>
      <span className="text-my-xs text-my-tertiary">{agents.length} 个 Agent</span>
    </div>
    <p className="text-my-xs text-my-tertiary">此处保存协作配置。指派后的执行与对话等待 Runtime 接入。</p>
    {agents.length === 0 ? <EmptyState title="没有匹配的 Agent" description="调整筛选，或先创建一个职责明确的 Agent" /> :
      <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
        {agents.map((agent) => {
          const tasks = snapshot.tasks.filter((task) => task.executor?.kind === 'agent' && task.executor.id === agent.id)
          const crews = snapshot.crews.filter((crew) => crew.captain.id === agent.id || crew.members.some((ref) => ref.kind === 'agent' && ref.id === agent.id))
          const captainOf = crews.find((crew) => !crew.archived && crew.captain.id === agent.id)
          return <section key={agent.id} className="flex flex-col gap-3 rounded-my-md border border-my-line bg-my-layer-1 p-3">
            <header className="flex items-start gap-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-my-md bg-my-layer-2 text-my-secondary"><FlowIcon name="agents" size={20} /></span>
              <div className="min-w-0 flex-1"><h2 className="my-item-title truncate">{agent.name}</h2><p className="my-item-description">{agent.description || '暂无职责描述'}</p></div>
              {!agent.archived && <Switch checked={agent.enabled} disabled={busy || Boolean(captainOf)} label={captainOf ? `请先更换「${captainOf.name}」的队长` : `启用 ${agent.name}`} onChange={(enabled) => void run('更新 Agent 状态', () => api.hifox.saveAgent({ ...agentInput(agent), enabled }))} />}
            </header>
            <div className="flex flex-wrap gap-2 text-my-2xs text-my-tertiary">
              <span>{agent.archived ? '已归档' : agent.enabled ? '已启用' : '已停用'}</span>
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
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(agent)}>{agent.archived ? '查看配置' : '编辑'}</Button>
                {agent.archived
                  ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run('恢复 Agent', () => api.hifox.saveAgent({ ...agentInput(agent), archived: false }))}><RotateCcw size={13} />恢复</Button>
                  : <Button variant="ghost" size="sm" disabled={busy || Boolean(captainOf)} title={captainOf ? `请先更换「${captainOf.name}」的队长或归档小队` : '归档后保留历史任务，可恢复'} onClick={() => void run('归档 Agent', () => api.hifox.removeAgent({ id: agent.id }))}><Archive size={13} />归档</Button>}
              </div>
            </footer>
          </section>
        })}
      </div>}
    {editing && currentSpaceId && <AgentEditor key={`${currentSpaceId}:${editing === 'new' ? 'new' : editing.id}`} agent={editing === 'new' ? null : editing} spaceId={currentSpaceId} onClose={() => setEditing(null)} />}
  </div>
}

export function AgentEditor({ agent, spaceId, onClose }: { agent: HifoxAgent | null; spaceId: string; onClose: () => void }): JSX.Element | null {
  const snapshot = useHifox((state) => state.snapshot)
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const [name, setName] = useState(agent?.name ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  const [skillIds, setSkillIds] = useState<string[]>(agent?.skillIds ?? [])
  const [runtimeKind, setRuntimeKind] = useState<HifoxRuntimeKind>(agent?.runtimeKind ?? 'claude-code')
  const [workingDirectory, setWorkingDirectory] = useState<HifoxWorkingDirectoryMode>(agent?.workingDirectory ?? 'repo')
  const [repos, setRepos] = useState((agent?.repositories ?? []).map((repo) => repo.name).join('\n'))
  if (!snapshot) return null
  const skills = snapshot.skills.filter((skill) => !skill.spaceId || skill.spaceId === (agent?.spaceId ?? spaceId))
  const submit = async (): Promise<void> => {
    if (busy || !name.trim() || !instructions.trim()) return
    const repositories = [...new Set(repos.split('\n').map((value) => value.trim()).filter(Boolean))]
      .map((repoName) => ({ name: repoName, url: agent?.repositories.find((repo) => repo.name === repoName)?.url }))
    const result = await run(agent ? '更新 Agent' : '创建 Agent', () => api.hifox.saveAgent({
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
          <details className="rounded-my-md border border-my-line p-2.5 text-my-xs text-my-secondary"><summary className="cursor-pointer">代码库与执行配置引用</summary>
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-my-tertiary">仅保存配置引用；连接、隔离目录和实际执行由 Runtime 模块提供。</p>
              <div className="grid grid-cols-2 gap-2"><Field label="Runtime 引用"><select className={inputClass} value={runtimeKind} onChange={(event) => setRuntimeKind(event.target.value as HifoxRuntimeKind)}><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="custom">自定义</option></select></Field>
                <Field label="目录模式引用"><select className={inputClass} value={workingDirectory} onChange={(event) => setWorkingDirectory(event.target.value as HifoxWorkingDirectoryMode)}><option value="repo">仓库目录</option><option value="temp">临时目录</option></select></Field></div>
              <Field label="代码库名称（每行一个）"><textarea className={`${textareaClass} font-mono text-my-xs`} style={{ minHeight: 'var(--my-space-64)' }} value={repos} onChange={(event) => setRepos(event.target.value)} /></Field>
            </div>
          </details>
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" disabled={busy || !name.trim() || !instructions.trim()} onClick={() => void submit()}>{busy ? '保存中…' : agent ? '保存' : '创建'}</Button></div>
    </div>
  </Modal>
}
