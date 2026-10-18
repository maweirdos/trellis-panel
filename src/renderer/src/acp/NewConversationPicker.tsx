import { useState, type JSX } from 'react'
import { Bot, ChevronRight, Loader2, Plus, X } from 'lucide-react'
import { clsx } from 'clsx'
import { Button, Modal } from '../my/ui'
import { RuntimePanel, runtimeHealthLabel } from './RuntimePanel'
import { isStarterRole, rolesForDisplay } from './role-presentation'
import type { AcpAgentProfile, AcpAgentStatus, TaskInfo } from '../../../shared/types'

export function NewConversationPicker({ profiles, agents, initialProfileId, initialTaskDir, root, tasks, starting, error, isCurrent, onAgentsChange, onStart, onCreateRole, onEditRole, onClose }: {
  profiles: AcpAgentProfile[]; agents: AcpAgentStatus[]; initialProfileId?: string; initialTaskDir?: string
  root: string; tasks: TaskInfo[]; starting: boolean; error: string; isCurrent: () => boolean
  onAgentsChange: (agents: AcpAgentStatus[]) => void
  onStart: (profile: AcpAgentProfile, taskDir: string | undefined, selectModel: boolean) => void
  onCreateRole: () => void; onEditRole: (profile: AcpAgentProfile) => void; onClose: () => void
}): JSX.Element {
  const [selectedId, setSelectedId] = useState(initialProfileId ?? rolesForDisplay(profiles)[0]?.id ?? '')
  const [selectedTask, setSelectedTask] = useState(initialTaskDir ?? '')
  const selected = profiles.find((profile) => profile.id === selectedId)
  const engine = agents.find((agent) => (agent.runtimeId ?? agent.id) === selected?.runtimeId)
  const ready = Boolean(engine?.enabled && engine.available)
  const close = (): void => { if (!starting) onClose() }
  return <Modal open onClose={close} width={780}><div role="dialog" aria-modal="true" aria-labelledby="acp-new-conversation-title" className="acp-new-conversation">
    <header className="acp-picker-header"><div><h2 id="acp-new-conversation-title">新建会话</h2><p>选择一个具名角色，再明确连接并开始。选择和编辑都不会自动启动。</p></div><Button size="sm" variant="ghost" title="关闭新会话选择器" disabled={starting} onClick={close}><X size={15} /></Button></header>
    <div className="acp-picker-body">
      <section className="acp-picker-roles my-scrollbar" aria-label="选择 Agent 角色"><div className="mb-3 flex items-center gap-2"><strong className="flex-1 text-my-sm text-my-primary">我的角色</strong><Button size="sm" variant="ghost" disabled={starting} onClick={onCreateRole}><Plus size={13} />创建角色</Button></div>
        {rolesForDisplay(profiles).map((profile) => {
          const runtime = agents.find((agent) => (agent.runtimeId ?? agent.id) === profile.runtimeId)
          return <button key={profile.id} className={clsx('acp-picker-role', selectedId === profile.id && 'is-selected')} aria-pressed={selectedId === profile.id} disabled={starting} onClick={() => setSelectedId(profile.id)}><span className="acp-avatar"><Bot size={17} /></span><span><strong>{profile.name}</strong><small>{profile.description || (isStarterRole(profile) ? '预置起点，可编辑为你的工作角色' : '自定义工作角色')}</small><small>执行引擎：{runtime?.name ?? profile.runtimeId}</small></span><ChevronRight size={13} /></button>
        })}
        {profiles.length === 0 && <div className="py-5 text-my-sm leading-relaxed text-my-secondary"><p>还没有可复用的角色。先写明角色名称、职责和指令，再选择执行引擎。</p><Button size="sm" variant="primary" className="mt-3" onClick={onCreateRole}>创建第一个角色</Button></div>}
      </section>
      <section className="acp-picker-context my-scrollbar" aria-label="新会话上下文">
        {selected ? <><h3 className="font-medium text-my-primary">{selected.name}</h3><p className="mt-2 text-my-sm leading-relaxed text-my-secondary">{selected.description || '尚未填写角色职责'}</p><p className="mt-3 text-my-sm text-my-tertiary">本机私有 · 当前项目</p>
          <dl className="mt-4 space-y-3 text-my-sm"><div><dt className="text-my-tertiary">执行引擎</dt><dd className="mt-1 text-my-primary">{engine?.name ?? selected.runtimeId} · {runtimeHealthLabel(engine)}</dd></div><div><dt className="text-my-tertiary">工作目录</dt><dd className="mt-1 break-all text-my-secondary">{selected.cwd || root}</dd></div></dl>
          <label className="mt-4 block text-my-sm text-my-secondary">关联任务<select className="my-input mt-2 w-full" value={selectedTask} disabled={starting} onChange={(event) => setSelectedTask(event.target.value)}><option value="">不关联任务</option>{tasks.map((task) => <option key={task.dirName} value={task.dirName}>{task.record?.title ?? task.dirName}</option>)}</select></label>
          <details className="acp-setting mt-4"><summary><span><strong>角色指令</strong><small>本次会话开始时保存角色快照</small></span></summary><div className="acp-setting-content"><pre>{selected.instructions || '未配置额外指令'}</pre></div></details>
          {!ready && <div className="mt-4"><RuntimePanel agents={agents} runtimeId={selected.runtimeId} onChange={onAgentsChange} isCurrent={isCurrent} heading={false} /></div>}
          <p className="mt-4 text-my-sm leading-relaxed text-my-tertiary">模型与模式由实际引擎连接后返回。你可以先连接，再选择它确实支持的模型。</p><Button size="sm" variant="outline" className="mt-2" disabled={!ready || starting} onClick={() => onStart(selected, selectedTask || undefined, true)}>连接后选择模型</Button>
          <button className="mt-4 block text-my-sm text-my-secondary underline underline-offset-2" disabled={starting} onClick={() => onEditRole(selected)}>编辑这个角色的默认设置</button>
        </> : <p className="py-8 text-my-sm text-my-tertiary">从左侧选择一个角色，或创建自己的角色。</p>}
      </section>
    </div>
    <footer className="acp-picker-footer">{error && <p role="alert" className="mb-3 text-my-sm text-my-danger-text">{error}</p>}<div className="flex items-center gap-3"><p className="min-w-0 flex-1 text-my-sm text-my-tertiary">{selected ? `${selected.name} · ${runtimeHealthLabel(engine)}` : '尚未选择角色'}</p><Button size="sm" variant="outline" disabled={starting} onClick={close}>取消</Button><Button size="sm" variant="primary" disabled={!selected || !ready || starting} onClick={() => { if (selected) onStart(selected, selectedTask || undefined, false) }}>{starting ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}创建新会话</Button></div></footer>
  </div></Modal>
}
