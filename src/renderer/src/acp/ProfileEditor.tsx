import { useRef, useState, type JSX } from 'react'
import { Loader2, Save, Trash2, X } from 'lucide-react'
import { api } from '../api'
import { Button, Modal } from '../my/ui'
import { confirmDialog } from '../components/Dialogs'
import type { AcpAgentProfile, AcpAgentStatus } from '../../../shared/types'

export function ProfileEditor({ initial, agents, root, isNew = false, isCurrent, onSaved, onDeleted, onClose }: {
  initial: AcpAgentProfile
  agents: AcpAgentStatus[]
  root: string
  isNew?: boolean
  isCurrent: () => boolean
  onSaved: (profile: AcpAgentProfile) => void
  onDeleted: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const [draft, setDraft] = useState(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const close = (): void => { if (!lock.current) onClose() }
  const save = async (): Promise<void> => {
    if (!isCurrent() || lock.current || !draft.name.trim() || !draft.runtimeId || !Number.isFinite(draft.maxTurnMinutes) || draft.maxTurnMinutes < 1 || draft.maxTurnMinutes > 120) return
    lock.current = true
    setPending(true)
    setError('')
    try {
      const res = await api.acpProfileSave({ ...draft, name: draft.name.trim(), cwd: draft.cwd?.trim() || undefined })
      if (!isCurrent()) return
      if (res.ok && res.profile) onSaved(res.profile)
      else setError(res.error ?? '保存失败')
    } catch (err) { if (isCurrent()) setError(err instanceof Error ? err.message : '保存失败') }
    finally { lock.current = false; if (isCurrent()) setPending(false) }
  }
  const remove = async (): Promise<void> => {
    if (lock.current || !isCurrent()) return
    const confirmed = await confirmDialog({ title: `删除 Agent「${initial.name}」？`, message: '历史会话继续保留，现有运行不受影响。', confirmText: '删除', danger: true })
    if (!confirmed || !isCurrent() || lock.current) return
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
  return <Modal open onClose={close} width={620}>
    <div role="dialog" aria-modal="true" aria-labelledby="acp-profile-title" className="flex max-h-[76vh] max-w-[92vw] flex-col">
      <header className="flex items-center gap-2 border-b border-my-line px-4 py-3">
        <h2 id="acp-profile-title" className="flex-1 text-my-sm font-medium text-my-primary">Agent 配置</h2>
        <Button variant="ghost" size="sm" title="关闭 Agent 配置" disabled={pending} onClick={close}><X size={14} /></Button>
      </header>
      <form className="my-scrollbar min-h-0 space-y-3 overflow-y-auto p-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <label className="block text-my-xs text-my-secondary">名称<input autoFocus required maxLength={100} className="my-input mt-1 w-full" value={draft.name} disabled={pending} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="block text-my-xs text-my-secondary">说明<input className="my-input mt-1 w-full" value={draft.description} disabled={pending} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="block text-my-xs text-my-secondary">Runtime<select className="my-input mt-1 w-full" value={draft.runtimeId} disabled={pending} onChange={(event) => setDraft({ ...draft, runtimeId: event.target.value })}>
          {!agents.some((agent) => (agent.runtimeId ?? agent.id) === draft.runtimeId) && <option value={draft.runtimeId}>{draft.runtimeId || '选择 Runtime'}</option>}
          {agents.map((agent) => <option key={agent.id} value={agent.runtimeId ?? agent.id}>{agent.name}</option>)}
        </select></label>
        <label className="block text-my-xs text-my-secondary">Agent 指令<textarea rows={5} className="my-input mt-1 w-full resize-y" value={draft.instructions} disabled={pending} placeholder="定义角色与工作方式。开始新会话时保存指令快照。" onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
        <label className="block text-my-xs text-my-secondary">默认工作目录<input className="my-input mt-1 w-full font-mono text-my-xs" value={draft.cwd ?? ''} disabled={pending} placeholder={`跟随当前项目：${root}`} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} /></label>
        <p className="text-my-2xs text-my-tertiary">默认使用当前项目，也可显式指定其他工作目录。保存配置不会启动 Agent；已开始的会话继续使用其配置快照。</p>
        <label className="block text-my-xs text-my-secondary">单轮最长运行（分钟）<input type="number" min={1} max={120} required className="my-input ml-2 w-20" value={draft.maxTurnMinutes} disabled={pending} onChange={(event) => setDraft({ ...draft, maxTurnMinutes: Number(event.target.value) })} /></label>
        {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
        <div className="flex items-center justify-between gap-2 pt-1">
          {isNew ? <span /> : <Button variant="ghost" className="text-my-danger-text" disabled={pending} onClick={() => void remove()}><Trash2 size={13} /> 删除</Button>}
          <Button variant="primary" disabled={pending || !draft.name.trim() || !draft.runtimeId} onClick={() => void save()}>{pending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} 保存配置</Button>
        </div>
      </form>
    </div>
  </Modal>
}
