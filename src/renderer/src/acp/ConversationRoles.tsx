import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Bot, ChevronDown, Plus, Settings2 } from 'lucide-react'
import type { AcpAgentProfile, AcpAgentStatus } from '../../../shared/types'
import { conversationRoleRevisionText, type ConversationProjectRole } from '../../../shared/conversation/project-role'
import { api, hasIpc } from '../api'
import { useKnowledgeOwner } from '../knowledge/bridge'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { ModuleLinks } from '../my/layout/ModuleLinks'
import { PageContent } from '../my/layout/PageLayout'
import { useMy } from '../my/store'
import { Button, Dropdown, SearchInput } from '../my/ui'
import { useApp } from '../store'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { ProfileEditor } from './ProfileEditor'
import { isStarterRole, rolesForDisplay } from './role-presentation'
import { RuntimePanel } from './RuntimePanel'
import './workspace.css'

export function ConversationRoles({ root, onStart }: {
  root: string
  onStart: (role: ConversationProjectRole) => void
}): JSX.Element {
  const active = useInteractionActive()
  const canInteract = useInteractionGuard()
  const { current: isCurrent } = useKnowledgeOwner(root)
  const startGeneration = useRef(0)
  const [agents, setAgents] = useState<AcpAgentStatus[]>([])
  const [profiles, setProfiles] = useState<AcpAgentProfile[]>([])
  const [editor, setEditor] = useState<AcpAgentProfile>()
  const [query, setQuery] = useState('')
  const [showEngines, setShowEngines] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async (signal: AbortSignal): Promise<void> => {
    setLoading(true)
    setError('')
    const [engines, roles] = await Promise.allSettled([api.acpAgents(), api.acpProfiles()])
    if (signal.aborted || !isCurrent()) return
    if (engines.status === 'fulfilled' && engines.value.ok && engines.value.agents) setAgents(engines.value.agents)
    if (roles.status === 'fulfilled' && roles.value.ok && roles.value.profiles) setProfiles(roles.value.profiles)
    if (engines.status === 'rejected' || roles.status === 'rejected' || !engines.value.ok || !roles.value.ok) {
      setError('无法读取角色或执行引擎。')
    }
    setLoading(false)
  }, [isCurrent])
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!active || !hasIpc) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [active, refresh, revision])

  const filter = query.trim().toLowerCase()
  const visible = rolesForDisplay(profiles.filter(role =>
    `${role.name} ${role.description} ${role.runtimeId}`.toLowerCase().includes(filter)))
  const custom = visible.filter(role => !isStarterRole(role))
  const starter = visible.filter(isStarterRole)
  async function startRole(role: AcpAgentProfile): Promise<void> {
    if (!canInteract() || !isCurrent()) return
    const generation = ++startGeneration.current
    const current = () => isCurrent() && canInteract() && generation === startGeneration.current
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(conversationRoleRevisionText(role)))
      const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if (current()) onStart({ id: role.id, name: role.name, revision })
    } catch {
      if (current()) setError('无法确认角色版本，请重新选择。')
    }
  }
  const renderRole = (role: AcpAgentProfile): JSX.Element => (
    <article key={role.id} className="acp-agent-card">
      <button type="button" className="my-nav-item flex min-w-0 flex-1 items-start gap-2 text-left"
        aria-label={`编辑角色 ${role.name}`} onClick={() => setEditor(role)}>
        <Bot size={18} className="shrink-0" aria-hidden="true" />
        <div><span className="my-item-title">{role.name}</span>
          {role.description && <p className="my-item-description">{role.description}</p>}</div>
      </button>
      <Button type="button" variant="ghost" size="sm" className="shrink-0"
        aria-label={`与 ${role.name} 开始对话`} onClick={() => void startRole(role)}>开始对话</Button>
    </article>
  )
  const createRole = (): void => {
    const engines = agents.filter(agent => agent.id === 'codex' || agent.id === 'claude')
    const engine = engines.find(agent => agent.enabled && agent.available && agent.health === 'ready') ?? engines[0] ?? agents[0]
    setEditor({ id: crypto.randomUUID(), name: '', description: '', instructions: '',
      runtimeId: engine?.runtimeId ?? engine?.id ?? '', maxTurnMinutes: 30 })
  }

  return <section className="acp-catalogue my-scrollbar h-full" aria-label="角色管理">
    <PageContent variant="centered">
      <div className="acp-catalogue-heading">
        <div><Dropdown trigger={({ open, toggle }) => <button type="button" className="acp-module-switch"
          aria-label="切换对话模块" aria-expanded={open} onClick={toggle}><strong>角色</strong><ChevronDown size={13} aria-hidden="true" /></button>}>
          {close => <div onClick={close}><ModuleLinks domain="agents" agentView="roles" /></div>}
        </Dropdown></div>
        <Button variant="ghost" size="sm" aria-expanded={showEngines} onClick={() => setShowEngines(open => !open)}>
          <Settings2 size={15} aria-hidden="true" />执行引擎
        </Button>
        <Button variant="primary" size="sm" disabled={!hasIpc || loading} onClick={createRole}>
          <Plus size={15} aria-hidden="true" />创建角色
        </Button>
      </div>
      {showEngines && <section className="acp-library-engines">
        <RuntimePanel agents={agents} onChange={setAgents} isCurrent={isCurrent} />
        <Button size="sm" variant="ghost" className="mt-3" onClick={() => {
          useMy.getState().setSettingsView('engines')
          useApp.getState().setPage('settings')
        }}>管理自定义执行命令</Button>
      </section>}
      <div className="acp-catalogue-tools">
        <SearchInput value={query} onChange={setQuery} size="sm" placeholder="搜索角色" />
      </div>
      {error && <FeedbackNotice variant="inline" title={error}
        actions={<Button size="sm" variant="ghost" onClick={() => setRevision(value => value + 1)}>重试</Button>} />}
      <div className="acp-agent-grid">{custom.map(renderRole)}</div>
      {!visible.length && !error && <p className="my-item-description" role="status">
        {loading ? '正在读取角色…' : filter ? '没有符合条件的角色' : '暂无角色'}
      </p>}
      {starter.length > 0 && <details className="acp-starter-roles" open={!custom.length}>
        <summary>预置角色</summary><div className="acp-agent-grid">{starter.map(renderRole)}</div>
      </details>}
      {editor && <ProfileEditor key={editor.id} initial={editor} isNew={!profiles.some(role => role.id === editor.id)}
        agents={agents} root={root} isCurrent={isCurrent} onAgentsChange={setAgents} onClose={() => setEditor(undefined)}
        onSaved={saved => {
          setProfiles(current => [...current.filter(role => role.id !== saved.id), saved])
          setEditor(undefined)
          useApp.getState().pushToast({ kind: 'success', title: '角色已保存' })
        }}
        onDeleted={id => {
          setProfiles(current => current.filter(role => role.id !== id))
          setEditor(undefined)
        }} />}
    </PageContent>
  </section>
}
