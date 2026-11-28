import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronRight, Loader2, Save, Trash2, X } from 'lucide-react'
import { api } from '../api'
import { Button, DisclosureGrid, Modal } from '../my/ui'

function ProfileDisclosure({ title, subtitle, defaultOpen = false, children }: { title: string; subtitle: string; defaultOpen?: boolean; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return <div className="acp-setting">
    <button type="button" className="flex w-full items-center gap-2.5 min-h-[var(--my-space-64)] px-[var(--my-space-10)] py-[var(--my-space-11)] text-left transition-colors hover:text-my-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <ChevronRight size={14} className={`shrink-0 text-my-tertiary transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
      <span className="min-w-0 flex-1"><strong>{title}</strong><small>{subtitle}</small></span>
    </button>
    <DisclosureGrid open={open}><div className="acp-setting-content">{children}</div></DisclosureGrid>
  </div>
}
import { confirmDialog } from '../components/Dialogs'
import { Select } from '../components/Select'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { RuntimePanel, runtimeHealthLabel } from './RuntimePanel'
import { ProfileSkills } from './ProfileSkills'
import { ProfileMcpServers } from './ProfileMcpServers'
import { RuntimeConfigFields } from './RuntimeConfigFields'
import { cleanRuntimeConfig, runtimeConfigError } from './runtime-config'
import type { AcpAgentProfile, AcpAgentStatus } from '../../../shared/types'

export function ProfileEditor({ initial, agents, root, isNew = false, inline = false, isCurrent, onAgentsChange, onSaved, onDeleted, onClose }: {
  initial: AcpAgentProfile
  agents: AcpAgentStatus[]
  root: string
  isNew?: boolean
  inline?: boolean
  isCurrent: () => boolean
  onAgentsChange?: (agents: AcpAgentStatus[]) => void
  onSaved: (profile: AcpAgentProfile) => void
  onDeleted: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const formId = useId()
  const [draft, setDraft] = useState(initial)
  const selectedEngine = agents.find(agent => (agent.runtimeId ?? agent.id) === draft.runtimeId)
  const launchKind = selectedEngine?.launchKind
  const sdk = launchKind === 'sdk'
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const close = (): void => { if (!lock.current) onClose() }
  const save = async (): Promise<void> => {
    if (!isCurrent() || !canInteract() || interactionSignal?.aborted || lock.current || !draft.name.trim() || !draft.runtimeId || !Number.isFinite(draft.maxTurnMinutes) || draft.maxTurnMinutes < 1 || draft.maxTurnMinutes > 120) return
    const invalid = runtimeConfigError(draft, launchKind)
    if (invalid) { setError(invalid); return }
    lock.current = true
    setPending(true)
    setError('')
    try {
      const res = await api.acpProfileSave({ ...draft, ...cleanRuntimeConfig(draft, { role: true, launchKind }), name: draft.name.trim(), cwd: draft.cwd?.trim() || undefined })
      if (!isCurrent()) return
      if (res.ok && res.profile) onSaved(res.profile)
      else setError(res.error ?? '保存失败')
    } catch (err) { if (isCurrent()) setError(err instanceof Error ? err.message : '保存失败') }
    finally { lock.current = false; if (isCurrent()) setPending(false) }
  }
  const remove = async (): Promise<void> => {
    if (lock.current || !isCurrent()) return
    const confirmed = await confirmDialog({ title: `删除 Agent「${initial.name}」？`, message: '历史会话继续保留，现有运行不受影响。', confirmText: '删除', danger: true }, interactionSignal)
    if (!confirmed || !canInteract() || interactionSignal?.aborted || !isCurrent() || lock.current) return
    lock.current = true
    setPending(true)
    setError('')
    try {
      const res = await api.acpProfileDelete(initial.id)
      if (!isCurrent()) return
      if (res.ok) onDeleted(initial.id)
      else setError(res.error ?? '删除失败')
    } catch (err) { if (isCurrent()) setError(err instanceof Error ? err.message : '删除失败') }
    finally { lock.current = false; if (isCurrent()) setPending(false) }
  }
  const content = <div role={inline ? undefined : 'dialog'} aria-modal={inline ? undefined : 'true'} aria-labelledby={`${formId}-title`} className={inline ? 'flex min-h-0 flex-col' : 'flex max-h-[76vh] max-w-[92vw] flex-col'}>
      <header className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-my-line bg-my-surface-1 px-4 py-3">
        <h2 id={`${formId}-title`} className="min-w-0 flex-1 text-my-sm font-medium text-my-primary">{isNew ? '创建自定义角色' : '编辑角色默认配置'}</h2>
        <button type="submit" form={formId} className="my-control my-control-sm my-button-primary shrink-0" disabled={pending || !draft.name.trim() || !draft.runtimeId}>{pending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} 保存角色</button>
        <button type="button" className="my-icon-control" title="关闭角色配置" aria-label="关闭角色配置" disabled={pending} onClick={close}><X size={14} /></button>
      </header>
      <form id={formId} className="my-scrollbar min-h-0 space-y-3 overflow-y-auto p-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <label className="block text-my-sm text-my-secondary">角色名称<input autoFocus required maxLength={100} placeholder="例如：产品助手、前端研发" className="my-input mt-1 w-full" value={draft.name} disabled={pending} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="block text-my-sm text-my-secondary">角色职责<input placeholder="用一句话说明这个角色负责什么" className="my-input mt-1 w-full" value={draft.description} disabled={pending} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="block text-my-sm text-my-secondary">执行引擎<Select ariaLabel="角色执行引擎" className="mt-1 w-full" value={draft.runtimeId} disabled={pending} onChange={(runtimeId) => setDraft({ ...draft, runtimeId })} options={[
          ...(!agents.some((agent) => (agent.runtimeId ?? agent.id) === draft.runtimeId) ? [{ value: draft.runtimeId, label: draft.runtimeId || '选择执行引擎' }] : []),
          ...agents.map((agent) => ({ value: agent.runtimeId ?? agent.id, label: `${agent.name} · ${runtimeHealthLabel(agent)}` }))
        ]} /></label>
        {onAgentsChange && <ProfileDisclosure title="引擎安装与本机环境" subtitle={runtimeHealthLabel(agents.find((agent) => (agent.runtimeId ?? agent.id) === draft.runtimeId))} defaultOpen={!agents.find((agent) => (agent.runtimeId ?? agent.id) === draft.runtimeId)?.available}><RuntimePanel agents={agents} onChange={onAgentsChange} isCurrent={isCurrent} runtimeId={draft.runtimeId} heading={false} /></ProfileDisclosure>}
        <RuntimeConfigFields role runtimeId={draft.runtimeId} launchKind={launchKind} value={draft} disabled={pending} onChange={patch => setDraft(previous => ({ ...previous, ...patch }))} />
        <label className="block text-my-sm text-my-secondary">角色指令<textarea rows={5} className="my-input mt-1 !h-auto w-full resize-y py-2" value={draft.instructions} disabled={pending} placeholder="写明工作边界、处理步骤和输出要求。例如：先澄清需求，完成 PRD 后等待我确认。" onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
        <ProfileDisclosure title="项目技能" subtitle={`已选 ${draft.skillPaths?.length ?? 0} / 32`}><ProfileSkills root={root} value={draft.skillPaths ?? []} disabled={pending} isCurrent={isCurrent} onChange={(skillPaths) => setDraft({ ...draft, skillPaths })} /></ProfileDisclosure>
        {sdk && <ProfileMcpServers value={draft.mcpServerNames ?? []} disabled={pending} onChange={(mcpServerNames) => setDraft({ ...draft, mcpServerNames })} />}
        <label className="block text-my-sm text-my-secondary">默认工作目录<input className="my-input mt-1 w-full font-mono text-my-sm" value={draft.cwd ?? ''} disabled={pending} placeholder={`跟随当前项目：${root}`} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} /></label>
        <p className="text-my-sm text-my-tertiary">{sdk ? 'Pi 的工作目录必须位于当前项目内；留空使用项目根目录' : '留空使用当前项目；修改仅影响新会话。'}</p>
        <label className="block text-my-sm text-my-secondary">单轮最长运行（分钟）<input type="number" min={1} max={120} required className="my-input ml-2 w-20" value={draft.maxTurnMinutes} disabled={pending} onChange={(event) => setDraft({ ...draft, maxTurnMinutes: Number(event.target.value) })} /></label>
        {error && <p role="alert" className="text-my-sm text-my-danger-text">{error}</p>}
        {!isNew && <div className="pt-1"><Button variant="ghost" className="text-my-danger-text" disabled={pending} onClick={() => void remove()}><Trash2 size={13} /> 删除</Button></div>}
      </form>
    </div>
  return inline ? content : <Modal open placement="center" onClose={close} width={620}>{content}</Modal>
}
