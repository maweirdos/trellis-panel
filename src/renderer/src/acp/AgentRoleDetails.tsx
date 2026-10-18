import type { JSX } from 'react'
import { BookOpen, Bot, ChevronRight, FileText, Folder, Monitor, Plus, Settings2 } from 'lucide-react'
import { Button } from '../my/ui'
import { RuntimePanel, runtimeHealthLabel } from './RuntimePanel'
import { SessionDetails } from './SessionDetails'
import type { AcpAgentProfile, AcpAgentStatus, AcpSessionRecord } from '../../../shared/types'

export type RoleDetailsSection = 'overview' | 'instructions' | 'engine' | 'workspace' | 'resources'

export function AgentRoleDetails({ profile, currentProfile, session, recentSession, agents, root, section, onSection, isCurrent, onAgentsChange, onUpdated, onNew, onContinue, onEdit, onKnowledge, onSpec }: {
  profile?: AcpAgentProfile; currentProfile?: AcpAgentProfile; session?: AcpSessionRecord; recentSession?: AcpSessionRecord
  agents: AcpAgentStatus[]; root: string; section: RoleDetailsSection; onSection: (section: RoleDetailsSection) => void; isCurrent: () => boolean
  onAgentsChange: (agents: AcpAgentStatus[]) => void; onUpdated: (session: AcpSessionRecord) => void
  onNew: (profileId?: string) => void; onContinue: (sessionId: string) => void; onEdit: (profile: AcpAgentProfile) => void; onKnowledge: () => void; onSpec: () => void
}): JSX.Element {
  const engineId = session?.runtimeSnapshot?.id ?? profile?.runtimeId
  const engine = agents.find((agent) => (agent.runtimeId ?? agent.id) === engineId)
  const toggle = (value: RoleDetailsSection): void => onSection(section === value ? 'overview' : value)
  return <>
    <span className="acp-avatar large"><Bot size={24} /></span><h2 data-inspector-focus tabIndex={-1}>{profile?.name ?? session?.agentName ?? '执行引擎与本机环境'}</h2>
    <p className="acp-inspector-description">{profile?.description || (profile ? '为这个角色补充职责和工作指令。' : '先配置本机执行引擎，再创建自己的 Agent 角色。')}</p>
    <p className="text-my-sm text-my-tertiary">本机私有 · 当前项目{session ? ' · 本会话使用开始时的角色快照' : ' · 角色默认配置'}</p>
    {profile && <div className="acp-inspector-actions">{session ? <Button size="sm" variant="primary" onClick={() => onContinue(session.sessionId)}>继续当前对话</Button> : recentSession ? <Button size="sm" variant="primary" onClick={() => onContinue(recentSession.sessionId)}>继续最近对话</Button> : <Button size="sm" variant="primary" onClick={() => onNew(profile.id)}>开始会话</Button>}<Button size="sm" variant="outline" onClick={() => onNew(profile.id)}><Plus size={13} />新会话</Button></div>}
    {profile && <details className="acp-setting" open={section === 'instructions'}><summary onClick={(event) => { event.preventDefault(); toggle('instructions') }}><FileText size={18} /><span><strong>角色指令</strong><small>身份、工作方式与输出要求</small></span><ChevronRight size={13} /></summary><div className="acp-setting-content"><pre>{profile.instructions || '尚未配置额外指令'}</pre>{session && <p className="mt-2 text-my-tertiary">编辑角色默认设置会影响之后的新会话，不会改写这次会话。</p>}</div></details>}
    <details className="acp-setting" open={section === 'engine' || !profile}><summary onClick={(event) => { event.preventDefault(); toggle('engine') }}><Monitor size={18} /><span><strong>执行引擎与模型</strong><small>{engine?.name ?? session?.runtimeSnapshot?.name ?? profile?.runtimeId ?? '本机环境'} · {session && ['ready', 'busy', 'awaiting_permission', 'cancelling'].includes(session.status) ? '已连接' : session?.status === 'starting' ? '正在连接' : runtimeHealthLabel(engine)}</small></span><ChevronRight size={13} /></summary><div className="acp-setting-content">
      {session ? <><p className="mb-2">当前会话的执行引擎：{session.runtimeSnapshot?.name ?? session.agentName}。</p><p className="text-my-tertiary">模型、模式、协作方式与推理强度在输入框底部调整。</p><Button size="sm" variant="ghost" className="mt-2" onClick={() => onContinue(session.sessionId)}>回到输入框</Button></> : <p className="mb-3">选择的是角色默认执行引擎。模型将在会话连接后获取；这里不会提前保存一个未经引擎确认的模型。</p>}
      {!session && profile && <Button size="sm" variant="outline" className="mb-3" onClick={() => onNew(profile.id)}>连接后选择模型</Button>}
      <details className="mt-3" open={!session}><summary className="cursor-pointer">本机环境与引擎安装</summary><div className="mt-3"><RuntimePanel agents={agents} runtimeId={engineId} onChange={onAgentsChange} isCurrent={isCurrent} heading={false} /></div></details>
    </div></details>
    {profile && <details className="acp-setting" open={section === 'workspace'}><summary onClick={(event) => { event.preventDefault(); toggle('workspace') }}><Folder size={18} /><span><strong>工作目录与运行设置</strong><small>{session?.cwd ?? profile.cwd ?? '跟随当前项目'} · 最长 {session?.profileSnapshot?.maxTurnMinutes ?? profile.maxTurnMinutes} 分钟</small></span><ChevronRight size={13} /></summary><div className="acp-setting-content break-all">{session ? <SessionDetails detailsOnly key={session.sessionId} session={session} isCurrent={isCurrent} onUpdated={onUpdated} /> : <><p>工作目录：{profile.cwd ?? root}</p><p className="mt-2">单轮最长运行：{profile.maxTurnMinutes} 分钟。</p></>}<p className="mt-2 text-my-tertiary">工具调用、权限等待、取消与恢复仍由实际会话管理；修改默认配置不会改动已有会话。</p></div></details>}
    <details className="acp-setting" open={section === 'resources'}><summary onClick={(event) => { event.preventDefault(); toggle('resources') }}><BookOpen size={18} /><span><strong>工具、知识与技能</strong><small>沿用执行引擎与当前项目的现有配置</small></span><ChevronRight size={13} /></summary><div className="acp-setting-content"><p>工具与技能由执行引擎及项目配置提供。具体工具操作仍会使用会话实际给出的权限选项。</p><p className="mt-2">知识入口使用当前项目已有的资料；本页尚不提供每个角色独立的工具授权、知识绑定或技能安装配置。</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={onKnowledge}>打开项目知识库</Button><Button size="sm" variant="outline" onClick={onSpec}>查看项目规范</Button></div></div></details>
    {currentProfile && <Button variant="ghost" size="sm" onClick={() => onEdit(currentProfile)}><Settings2 size={13} />编辑角色默认配置</Button>}
    <p className="mt-5 text-my-sm leading-relaxed text-my-tertiary">角色配置仅保存在本机当前项目。团队共享尚未提供；打开详情、修改配置和安装引擎都不会自动开始编码。</p>
  </>
}
