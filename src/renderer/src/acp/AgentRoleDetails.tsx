import { useEffect, useRef, useState, type JSX } from 'react'
import { Archive, ArrowLeft, Bot, ChevronRight, FileText, FolderGit2, Monitor, Plug, Plus, Settings2, Share2, SlidersHorizontal, Puzzle } from 'lucide-react'
import { clsx } from 'clsx'
import { api, hasIpc } from '../api'
import { Button } from '../my/ui'
import { RuntimePanel } from './RuntimePanel'
import { RuntimePicker } from './RuntimePicker'
import { SessionDetails } from './SessionDetails'
import { ProfileSkills } from './ProfileSkills'
import { ProfileMcpServers } from './ProfileMcpServers'
import { RuntimeConfigFields } from './RuntimeConfigFields'
import { cleanRuntimeConfig, runtimeConfigError } from './runtime-config'
import type { AcpAgentProfile, AcpAgentStatus, AcpSessionRecord } from '../../../shared/types'

export type RoleDetailsSection = 'overview' | 'instructions' | 'im' | 'tools' | 'workspace' | 'runtime' | 'git' | 'skills' | 'archive'

type DetailKey = Exclude<RoleDetailsSection, 'overview'>

export function AgentRoleDetails({ profile, currentProfile, session, recentSession, agents, root, section, onSection, isCurrent, onAgentsChange, onUpdated, onProfileChange, onNew, onContinue, onEdit, onKnowledge, onSpec }: {
  profile?: AcpAgentProfile; currentProfile?: AcpAgentProfile; session?: AcpSessionRecord; recentSession?: AcpSessionRecord
  agents: AcpAgentStatus[]; root: string; section: RoleDetailsSection; onSection: (section: RoleDetailsSection) => void; isCurrent: () => boolean
  onAgentsChange: (agents: AcpAgentStatus[]) => void; onUpdated: (session: AcpSessionRecord) => void; onProfileChange: (profile: AcpAgentProfile) => void
  onNew: (profileId?: string) => void; onContinue: (sessionId: string) => void; onEdit: (profile: AcpAgentProfile) => void; onKnowledge: () => void; onSpec: () => void
}): JSX.Element {
  const engineId = session?.runtimeSnapshot?.id ?? profile?.runtimeId
  const engine = agents.find((agent) => (agent.runtimeId ?? agent.id) === engineId)
  const connected = Boolean(session && ['ready', 'busy', 'awaiting_permission', 'cancelling'].includes(session.status))
  const name = profile?.name ?? session?.agentName ?? '执行引擎与本机环境'
  const description = profile?.description || (profile ? '为这个角色补充职责说明。' : '先配置本机执行引擎，再创建自己的 Agent 角色。')
  const cwd = session?.cwd ?? profile?.cwd ?? ''
  const cwdName = cwd ? cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd : ''

  const cards: Array<{ key: DetailKey; icon: typeof FileText; title: string; desc: string; value: string; soon?: boolean }> = [
    { key: 'instructions', icon: FileText, title: '角色指令', desc: '定义角色身份与工作方式，随每轮请求提供给执行引擎。', value: profile?.instructions.trim() ? '已配置' : '无' },
    { key: 'im', icon: Share2, title: '触发 & IM 集成', desc: '集成飞书、企业微信、钉钉、微信等 IM 工具。', value: '即将支持', soon: true },
    { key: 'tools', icon: Plug, title: '工具 & 知识库', desc: '设置 Agent 可以使用的项目知识、来源与规范。', value: '沿用项目配置' },
    { key: 'workspace', icon: SlidersHorizontal, title: '运行设置', desc: '设置工作目录、单轮最长运行时长。', value: `${cwdName || '跟随当前项目'} · ${session?.profileSnapshot?.maxTurnMinutes ?? profile?.maxTurnMinutes ?? 30} 分钟` },
    { key: 'runtime', icon: Monitor, title: '电脑 & Runtime', desc: '设置电脑、Runtime，注入环境变量、自定义参数等。', value: engine?.name ?? profile?.runtimeId ?? '未配置' },
    { key: 'git', icon: FolderGit2, title: 'Git 仓库 & 设置', desc: 'Agent 在工作目录内读写代码与文档。', value: cwd ? '指定目录' : '当前项目' },
    { key: 'skills', icon: Puzzle, title: '技能', desc: '为角色额外选择当前项目技能。', value: profile?.skillPaths?.length ? `已选 ${profile.skillPaths.length} 个` : '沿用执行引擎' },
    { key: 'archive', icon: Archive, title: '归档', desc: '归档后 Agent 无法被指派或提及，历史会保留。', value: '即将支持', soon: true }
  ]

  if (section !== 'overview') return <DetailView key={section} section={section} profile={session ? currentProfile : profile} session={session} agents={agents} root={root} engine={engine} connected={connected}
    isCurrent={isCurrent} onAgentsChange={onAgentsChange} onUpdated={onUpdated} onProfileChange={onProfileChange} onSection={onSection} onKnowledge={onKnowledge} onSpec={onSpec} />

  return <>
    <span className="acp-avatar large"><Bot size={24} /></span><h2 data-inspector-focus tabIndex={-1}>{name}</h2>
    <p className="acp-inspector-description">{description}</p>
    <p className="text-my-sm text-my-tertiary">本机私有 · 当前项目{session ? ' · 本会话使用开始时的角色快照' : ' · 角色默认配置'}</p>
    {profile && <div className="acp-inspector-actions">{session ? <Button size="sm" variant="primary" onClick={() => onContinue(session.sessionId)}>继续当前对话</Button> : recentSession ? <Button size="sm" variant="primary" onClick={() => onContinue(recentSession.sessionId)}>继续最近对话</Button> : <Button size="sm" variant="primary" onClick={() => onNew(profile.id)}>开始会话</Button>}<Button size="sm" variant="outline" onClick={() => onNew(profile.id)}><Plus size={13} />新会话</Button></div>}
    <div className="acp-setting-list">
      {cards.map(({ key, icon: Icon, title, desc, value, soon }) => (
        <button key={key} type="button" className={clsx('acp-setting-card', soon && 'is-soon')} disabled={soon} onClick={() => onSection(key)}>
          <span className="acp-setting-icon"><Icon size={16} /></span>
          <span className="acp-setting-main"><strong>{title}</strong><small>{desc}</small></span>
          <span className="acp-setting-value">{value}</span>
          {soon ? <span className="acp-setting-soon">即将支持</span> : <ChevronRight size={14} className="acp-setting-chevron" />}
        </button>
      ))}
    </div>
    {currentProfile && <Button variant="ghost" size="sm" className="mt-3" onClick={() => onEdit(currentProfile)}><Settings2 size={13} />编辑全部默认配置</Button>}
    <p className="mt-4 text-my-sm leading-relaxed text-my-tertiary">角色配置仅保存在本机当前项目。团队共享尚未提供；打开详情、修改配置和安装引擎都不会自动开始编码。</p>
  </>
}

/** 图二式子页：返回 + 标题 + 分区内容。 */
function DetailView({ section, profile, session, agents, root, engine, connected, isCurrent, onAgentsChange, onUpdated, onProfileChange, onSection, onKnowledge, onSpec }: {
  section: DetailKey; profile?: AcpAgentProfile; session?: AcpSessionRecord; agents: AcpAgentStatus[]; root: string
  engine: AcpAgentStatus | undefined; connected: boolean; isCurrent: () => boolean
  onAgentsChange: (agents: AcpAgentStatus[]) => void; onUpdated: (session: AcpSessionRecord) => void; onProfileChange: (profile: AcpAgentProfile) => void
  onSection: (section: RoleDetailsSection) => void; onKnowledge: () => void; onSpec: () => void
}): JSX.Element {
  const [draft, setDraft] = useState<AcpAgentProfile | undefined>(profile)
  const selectedEngine = draft ? agents.find(agent => (agent.runtimeId ?? agent.id) === draft.runtimeId) : engine
  const launchKind = selectedEngine?.launchKind
  const sdk = launchKind === 'sdk'
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  useEffect(() => { setDraft(profile); setError('') }, [profile])
  const update = (patch: Partial<AcpAgentProfile>): void => { if (draft) setDraft({ ...draft, ...patch }) }
  const save = async (): Promise<void> => {
    if (!draft || lock.current || !hasIpc || !isCurrent()) return
    const invalid = runtimeConfigError(draft, launchKind)
    if (invalid) { setError(invalid); return }
    lock.current = true
    setPending(true); setError(''); setNotice('')
    try {
      const cleaned: AcpAgentProfile = {
        ...draft, ...cleanRuntimeConfig(draft, { role: true, launchKind }), name: draft.name.trim(),
        cwd: draft.cwd?.trim() || undefined
      }
      const res = await api.acpProfileSave(cleaned)
      if (!isCurrent()) return
      if (res.ok && res.profile) { onProfileChange(res.profile); setNotice('已保存。修改只影响之后的新会话，已有会话继续使用开始时的快照。') }
      else setError(res.error ?? '保存失败')
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : '保存失败') }
    finally { lock.current = false; if (isCurrent()) setPending(false) }
  }
  const headers: Record<DetailKey, { title: string; desc: string }> = {
    instructions: { title: '角色指令', desc: '身份、工作方式与输出要求，随会话的每轮请求提供给执行引擎。' },
    im: { title: '触发 & IM 集成', desc: '集成飞书、企业微信、钉钉、微信等 IM 工具。' },
    tools: { title: '工具 & 知识库', desc: '设置 Agent 可以使用的项目知识、来源与规范。' },
    workspace: { title: '运行设置', desc: '设置工作目录、单轮最长运行时长。' },
    runtime: { title: '电脑 & Runtime', desc: '设置电脑、Runtime，注入环境变量、自定义参数等。' },
    git: { title: 'Git 仓库 & 设置', desc: 'Agent 在工作目录内读写代码与文档。' },
    skills: { title: '技能', desc: '为角色额外选择当前项目技能。' },
    archive: { title: '归档', desc: '归档后 Agent 无法被指派或提及，历史会保留。' }
  }
  const header = headers[section]
  const authLabel = !selectedEngine ? '未配置引擎' : sdk ? '使用 AI 供应商凭据' : selectedEngine.health === 'auth_required' ? '需要登录' : selectedEngine.available ? '沿用本机登录' : '引擎未就绪'
  const modelLabel = session?.currentModelId ?? '连接后选择'
  return <>
    <button type="button" className="acp-detail-back" onClick={() => onSection('overview')}><ArrowLeft size={14} />返回</button>
    <h2 data-inspector-focus tabIndex={-1}>{header.title}</h2>
    <p className="acp-inspector-description">{header.desc}</p>

    {section === 'instructions' && (profile ? <>
      <textarea rows={9} className="my-input !h-auto w-full resize-y py-2" value={draft?.instructions ?? ''} disabled={pending} placeholder="写明这个角色的身份、工作边界、处理步骤和输出要求。" onChange={(event) => update({ instructions: event.target.value })} />
      <SaveBar pending={pending} error={error} notice={notice} dirty={draft?.instructions !== profile.instructions} onSave={save} />
      {session && <p className="mt-2 text-my-sm text-my-tertiary">编辑角色默认设置会影响之后的新会话，不会改写这次会话。</p>}
    </> : <p className="text-my-sm text-my-tertiary">当前查看的是会话引擎，不包含可编辑的角色指令。</p>)}

    {section === 'tools' && <>
      <p className="text-my-sm leading-relaxed text-my-secondary">工具与技能由执行引擎及项目配置提供，具体工具操作仍会使用会话实际给出的权限选项。知识入口使用当前项目已有的资料。</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={onKnowledge}>打开项目知识库</Button><Button size="sm" variant="outline" onClick={onSpec}>查看项目规范</Button></div>
    </>}

    {section === 'workspace' && (profile ? <>
      {session && <div className="mb-4"><SessionDetails detailsOnly key={session.sessionId} session={session} isCurrent={isCurrent} onUpdated={onUpdated} /></div>}
      {!session && <>
        <label className="block text-my-sm text-my-secondary">默认工作目录
          <input className="my-input mt-1 w-full font-mono" value={draft?.cwd ?? ''} disabled={pending} placeholder={`跟随当前项目：${root}`} onChange={(event) => update({ cwd: event.target.value })} />
        </label>
        <label className="mt-3 block text-my-sm text-my-secondary">单轮最长运行（分钟）
          <input type="number" min={1} max={120} required className="my-input mt-1 w-24" value={draft?.maxTurnMinutes ?? 30} disabled={pending} onChange={(event) => update({ maxTurnMinutes: Number(event.target.value) })} />
        </label>
        <p className="mt-2 text-my-sm text-my-tertiary">留空工作目录则使用当前项目。修改不会改动已有会话。</p>
        <SaveBar pending={pending} error={error} notice={notice} dirty={draft?.cwd !== profile.cwd || draft?.maxTurnMinutes !== profile.maxTurnMinutes} onSave={save} />
      </>}
    </> : <p className="text-my-sm text-my-tertiary">当前查看的是会话引擎，没有可编辑的运行设置。</p>)}

    {section === 'runtime' && (profile ? <>
      {session && <p className="mb-3 rounded-my-md bg-my-layer-2 px-3 py-2 text-my-sm text-my-secondary">当前会话的执行引擎：{session.runtimeSnapshot?.name ?? session.agentName}（开始会话时的快照）。下面的修改保存为角色默认，供新会话使用。</p>}
      <div className="acp-detail-row acp-detail-row-stack">
        <span className="acp-detail-row-label">Runtime</span>
        <RuntimePicker agents={agents} value={draft?.runtimeId} triggerSize="row" onSelect={(runtimeId) => update({ runtimeId })} onAgentsChange={onAgentsChange} isCurrent={isCurrent} />
      </div>
      {session && <div className="acp-detail-row">
        <span className="acp-detail-row-label">当前会话模型</span>
        <span className="acp-detail-row-value">{connected && session?.currentModelId ? modelLabel : '连接后选择'}</span>
      </div>}
      <div className="acp-detail-row">
        <span className="acp-detail-row-label">默认授权<small>{sdk ? '模型与凭据使用设置中的 AI 供应商' : '登录与授权沿用引擎本机配置'}</small></span>
        <span className="acp-detail-row-value">{authLabel}</span>
      </div>

      {draft && <section className="acp-detail-section"><RuntimeConfigFields role value={draft} runtimeId={draft.runtimeId} launchKind={launchKind} disabled={pending} onChange={update} /></section>}

      {draft && sdk && <section className="acp-detail-section"><ProfileMcpServers key={`${profile.id}:${JSON.stringify(profile.mcpServerNames ?? [])}`} value={draft.mcpServerNames ?? []} disabled={pending} onChange={(mcpServerNames) => update({ mcpServerNames })} /></section>}
      <SaveBar pending={pending} error={error} notice={notice} dirty={isProfileDirty(draft, profile)} onSave={save} />

      <details className="mt-4 border-t border-my-line pt-3" open={!selectedEngine?.available}>
        <summary className="cursor-pointer text-my-sm text-my-secondary">本机环境与引擎安装</summary>
        <div className="mt-3"><RuntimePanel agents={agents} runtimeId={draft?.runtimeId ?? profile.runtimeId} onChange={onAgentsChange} isCurrent={isCurrent} heading={false} /></div>
      </details>
    </> : <>
      <p className="text-my-sm">当前会话的执行引擎：{session?.runtimeSnapshot?.name ?? session?.agentName ?? '本机环境'}。</p>
      <p className="mt-2 text-my-sm text-my-tertiary">模型、模式、协作方式与推理强度在输入框底部调整。</p>
      <div className="mt-3"><RuntimePanel agents={agents} onChange={onAgentsChange} isCurrent={isCurrent} heading={false} /></div>
    </>)}

    {section === 'git' && <>
      <p className="text-my-sm leading-relaxed text-my-secondary">Agent 的读写范围就是会话的工作目录及其中的 Git 仓库。仓库历史、分支与提交请使用项目工作台的 Git 视图。</p>
      <dl className="mt-3 space-y-2 break-all text-my-sm">
        <div><dt className="text-my-tertiary">当前项目</dt><dd className="font-mono">{root}</dd></div>
        {(session?.cwd ?? profile?.cwd) && <div><dt className="text-my-tertiary">工作目录</dt><dd className="font-mono">{session?.cwd ?? profile?.cwd}</dd></div>}
      </dl>
    </>}

    {section === 'skills' && <>
      {session && <div className="mb-4 text-my-sm text-my-secondary"><h3 className="font-medium text-my-primary">本会话技能快照 · {session.profileSnapshot?.skillPaths?.length ?? 0} 个</h3>{session.profileSnapshot?.skillPaths?.length ? <ul className="mt-2 space-y-1 break-all font-mono">{session.profileSnapshot.skillPaths.map((path) => <li key={path}>{path}</li>)}</ul> : <p className="mt-1 text-my-tertiary">未额外选择项目技能，沿用执行引擎。</p>}</div>}
      {profile && draft ? <>
        {session && <p className="mb-3 text-my-sm text-my-tertiary">下面修改角色默认配置，仅影响之后的新会话。</p>}
        <ProfileSkills root={root} value={draft.skillPaths ?? []} disabled={pending} isCurrent={isCurrent} onChange={(skillPaths) => update({ skillPaths })} />
        <SaveBar pending={pending} error={error} notice={notice} dirty={JSON.stringify(draft.skillPaths ?? []) !== JSON.stringify(profile.skillPaths ?? [])} onSave={save} />
      </> : <p className="text-my-sm text-my-tertiary">当前没有可编辑的角色默认配置。</p>}
    </>}

    {section === 'im' && <p className="text-my-sm leading-relaxed text-my-tertiary">本机版本尚未提供 IM 触发与集成。当前可以通过面板手动指派任务；团队触发通道会在后续版本提供。</p>}
    {section === 'archive' && <p className="text-my-sm leading-relaxed text-my-tertiary">本机版本尚未提供角色归档。删除角色请使用「编辑全部默认配置」，历史会话会继续保留。</p>}
  </>
}

function isProfileDirty(draft: AcpAgentProfile | undefined, profile: AcpAgentProfile): boolean {
  if (!draft) return false
  return draft.runtimeId !== profile.runtimeId || draft.modelId !== profile.modelId || draft.cwd !== profile.cwd || draft.maxTurnMinutes !== profile.maxTurnMinutes
    || JSON.stringify(draft.env ?? []) !== JSON.stringify(profile.env ?? []) || JSON.stringify(draft.args ?? []) !== JSON.stringify(profile.args ?? [])
    || JSON.stringify(draft.mcpServerNames ?? []) !== JSON.stringify(profile.mcpServerNames ?? [])
}

function SaveBar({ pending, error, notice, dirty, onSave }: { pending: boolean; error: string; notice: string; dirty: boolean; onSave: () => void }): JSX.Element {
  return <div className="mt-3">
    <Button size="sm" variant="primary" disabled={pending || !dirty || !hasIpc} onClick={onSave}>{pending ? '保存中…' : '保存修改'}</Button>
    {error && <p role="alert" className="mt-2 text-my-sm text-my-danger-text">{error}</p>}
    {!error && notice && <p role="status" className="mt-2 text-my-sm text-my-success-text">{notice}</p>}
  </div>
}
