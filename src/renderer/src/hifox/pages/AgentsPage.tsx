/**
 * Agent 管理列表：职责指令、技能绑定、代码库引用、Runtime 选择（仅配置）、
 * 工作目录模式、启停。执行链路由 Runtime 模块接入（当前派发止于等待 Runtime）。
 */
import { useState } from 'react'
import { Bot, Plus, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useHifox } from '../store'
import { PageHeader, Field, inputClass, DispatchNote } from '../ui'
import { Button, EmptyState, Modal, Switch } from '../../my/ui'
import type { HifoxAgent, HifoxRuntimeKind, HifoxWorkingDirectoryMode } from '@shared/hifox'

export function AgentsPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const run = useHifox((s) => s.run)
  const [editing, setEditing] = useState<HifoxAgent | 'new' | null>(null)

  const agents = snapshot.agents.filter((a) => a.spaceId === currentSpaceId)
  const skills = snapshot.skills

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="Agent"
        description="Agent 保存「如何工作」：职责指令 + 技能 + 代码库 + Runtime 与工作目录配置"
        actions={<Button variant="primary" size="sm" onClick={() => setEditing('new')}><Plus size={14} />新建 Agent</Button>}
      />
      {agents.length === 0
        ? <EmptyState title="该空间还没有 Agent" description="新建一个 Agent，把一类任务的稳定做法沉淀下来" />
        : (
          <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
            {agents.map((agent) => {
              const dispatched = snapshot.tasks.filter((t) => t.executor?.kind === 'agent' && t.executor.id === agent.id)
              return (
                <section key={agent.id} className={`flex flex-col gap-2 rounded-my-md border p-3 ${agent.enabled ? 'border-my-line bg-my-layer/40' : 'border-my-line/60 bg-my-layer/20 opacity-70'}`}>
                  <header className="flex items-start gap-2">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-my-md bg-indigo-500/15 text-indigo-400"><Bot size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <h2 className="flex items-center gap-1.5 truncate text-sm font-medium text-my-primary">
                        {agent.name}
                        {!agent.enabled && <span className="rounded-my-sm bg-my-layer px-1 text-[10px] text-my-tertiary">已停用</span>}
                      </h2>
                      <p className="truncate text-my-xs text-my-tertiary">{agent.description ?? '暂无描述'}</p>
                    </div>
                    <Switch checked={agent.enabled} onChange={(value) => void run('更新 Agent', () => api.hifox.saveAgent({
                      spaceId: agent.spaceId, name: agent.name, description: agent.description, instructions: agent.instructions,
                      skillIds: agent.skillIds, repositories: agent.repositories, runtimeKind: agent.runtimeKind,
                      workingDirectory: agent.workingDirectory, enabled: value, id: agent.id
                    }))} label="" />
                  </header>
                  <p className="line-clamp-3 whitespace-pre-wrap rounded-my-md bg-my-layer px-2.5 py-2 text-my-xs leading-relaxed text-my-secondary">{agent.instructions}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-my-xs text-my-tertiary">
                    <span className="rounded-my-sm bg-my-layer px-1.5 py-0.5">Runtime：{agent.runtimeKind === 'claude-code' ? 'Claude Code' : agent.runtimeKind === 'codex' ? 'Codex' : '自定义'}</span>
                    <span className="rounded-my-sm bg-my-layer px-1.5 py-0.5">目录：{agent.workingDirectory === 'repo' ? '仓库目录' : '临时目录'}</span>
                    {agent.skillIds.map((id) => {
                      const skill = skills.find((s) => s.id === id)
                      return skill ? <span key={id} className="rounded-my-sm bg-violet-500/15 px-1.5 py-0.5 text-violet-400">技能 · {skill.name}</span> : null
                    })}
                    {agent.repositories.map((repo) => (
                      <span key={repo.name} className="rounded-my-sm bg-emerald-500/15 px-1.5 py-0.5 text-emerald-500">仓库 · {repo.name}</span>
                    ))}
                  </div>
                  <div className="mt-auto flex items-center gap-2">
                    <span className="text-[11px] text-my-tertiary">
                      {dispatched.length > 0 ? `当前执行槽任务 ${dispatched.length} 条` : '暂无任务指派给它'}
                    </span>
                    <div className="ml-auto flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(agent)}>编辑</Button>
                      <button type="button" aria-label={`删除 ${agent.name}`} className="grid h-7 w-7 place-items-center rounded-my-md text-my-tertiary hover:bg-my-layer hover:text-red-400"
                        onClick={() => void run('删除 Agent', () => api.hifox.removeAgent({ id: agent.id }))}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </section>
              )
            })}
          </div>
        )}
      <AgentEditor agent={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

function AgentEditor({ agent, onClose }: { agent: HifoxAgent | 'new' | null; onClose: () => void }): JSX.Element | null {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const run = useHifox((s) => s.run)
  const existing = agent && agent !== 'new' ? agent : null
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [instructions, setInstructions] = useState(existing?.instructions ?? '职责：…\n动手前：…\n改后：…\n汇报：…')
  const [skillIds, setSkillIds] = useState<string[]>(existing?.skillIds ?? [])
  const [runtimeKind, setRuntimeKind] = useState<HifoxRuntimeKind>(existing?.runtimeKind ?? 'claude-code')
  const [workingDirectory, setWorkingDirectory] = useState<HifoxWorkingDirectoryMode>(existing?.workingDirectory ?? 'repo')
  const [repos, setRepos] = useState((existing?.repositories ?? []).map((r) => r.name).join('\n'))

  if (!agent || !currentSpaceId) return null

  const submit = async (): Promise<void> => {
    const repositoryList = repos.split('\n').map((s) => s.trim()).filter(Boolean).map((repoName) => ({ name: repoName }))
    const result = await run(existing ? '更新 Agent' : '创建 Agent', () => api.hifox.saveAgent({
      id: existing?.id,
      spaceId: existing?.spaceId ?? currentSpaceId,
      name: name.trim(),
      description: description.trim() || undefined,
      instructions: instructions.trim(),
      skillIds,
      repositories: repositoryList,
      runtimeKind,
      workingDirectory,
      enabled: existing?.enabled ?? true
    }))
    if (result?.ok) onClose()
  }

  return (
    <Modal open onClose={onClose} width={560} ariaLabel={existing ? '编辑 Agent' : '新建 Agent'}>
      <div className="flex flex-col gap-3 p-1">
        <h2 className="text-sm font-semibold text-my-primary">{existing ? `编辑 ${existing.name}` : '新建 Agent'}</h2>
        <div className="grid grid-cols-2 gap-2">
          <Field label="名称"><input className={inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：前端修复" /></Field>
          <Field label="一句话描述"><input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="承接什么类工作" /></Field>
        </div>
        <Field label="指令（职责 / 动手前 / 改后 / 汇报）">
          <textarea className={`${inputClass} min-h-32 resize-y font-mono text-my-xs`} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
        <div>
          <p className="mb-1.5 text-my-xs font-medium text-my-tertiary">绑定技能（可复用的流程规范）</p>
          <div className="flex flex-wrap gap-1.5">
            {snapshot.skills.map((skill) => {
              const on = skillIds.includes(skill.id)
              return (
                <button key={skill.id} type="button"
                  onClick={() => setSkillIds((prev) => on ? prev.filter((x) => x !== skill.id) : [...prev, skill.id])}
                  className={`rounded-my-sm bg-violet-500/15 px-1.5 py-0.5 text-my-xs text-violet-400 transition-opacity ${on ? 'opacity-100' : 'opacity-40 hover:opacity-70'}`}>
                  {on ? '✓ ' : ''}{skill.name}
                </button>
              )
            })}
            {snapshot.skills.length === 0 && <span className="text-my-xs text-my-tertiary">暂无技能，先到「技能」模块创建</span>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Runtime（仅配置，连接由 Runtime 模块负责）">
            <select className={inputClass} value={runtimeKind} onChange={(e) => setRuntimeKind(e.target.value as HifoxRuntimeKind)}>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="custom">自定义</option>
            </select>
          </Field>
          <Field label="工作目录模式" hint="临时目录：每任务独立 worktree，防互相覆盖">
            <select className={inputClass} value={workingDirectory} onChange={(e) => setWorkingDirectory(e.target.value as HifoxWorkingDirectoryMode)}>
              <option value="repo">仓库目录（共享）</option>
              <option value="temp">临时目录（隔离）</option>
            </select>
          </Field>
        </div>
        <Field label="代码库引用（每行一个名称）">
          <textarea className={`${inputClass} min-h-16 resize-y font-mono text-my-xs`} value={repos} onChange={(e) => setRepos(e.target.value)} placeholder={'trellis-panel'} />
        </Field>
        <DispatchNote dispatch={{ status: 'waiting_runtime', since: '', note: 'Runtime 未接入：Agent 创建后可直接指派任务，执行将在 Runtime 模块接入后启动。' }} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={!name.trim() || !instructions.trim()} onClick={() => void submit()}>{existing ? '保存' : '创建'}</Button>
        </div>
      </div>
    </Modal>
  )
}
