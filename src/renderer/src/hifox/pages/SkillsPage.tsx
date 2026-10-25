/** 可复用工作指令；组织技能和当前空间技能可绑定给 Agent。 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { HifoxAgent, HifoxSkill } from '@shared/hifox'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, EmptyState, Modal } from '../../my/ui'
import { FlowIcon } from '../icons'
import { useHifox } from '../store'
import { PageHeader, Field, inputClass, textareaClass } from '../ui'
import { AgentEditor } from './AgentsPage'

export function SkillsPage(): JSX.Element | null {
  const snapshot = useHifox((state) => state.snapshot)
  const currentSpaceId = useHifox((state) => state.currentSpaceId)
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const [editing, setEditing] = useState<HifoxSkill | 'new' | null>(null)
  const [editingAgent, setEditingAgent] = useState<HifoxAgent | null>(null)
  const [keyword, setKeyword] = useState('')
  if (!snapshot) return null
  const skills = snapshot.skills.filter((skill) => (!skill.spaceId || skill.spaceId === currentSpaceId) && `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(keyword.toLowerCase()))
  const remove = async (skill: HifoxSkill): Promise<void> => {
    const bound = snapshot.agents.filter((agent) => agent.skillIds.includes(skill.id))
    if (!await confirmDialog({ title: `删除技能「${skill.name}」？`, message: bound.length ? `将解除 ${bound.length} 个 Agent 的绑定：${bound.map((agent) => agent.name).join('、')}。后续任务不再包含这些指令。` : '技能内容将被删除。', confirmText: '删除技能', danger: true })) return
    await run('删除技能', () => api.hifox.removeSkill({ id: skill.id }))
  }
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="技能" description="集中维护可复用的检查清单、工作方法与验证要求；保存后，绑定它的 Agent 使用同一份最新配置。"
      actions={<Button variant="primary" size="sm" disabled={busy} onClick={() => setEditing('new')}><Plus size={14} />新建技能</Button>} />
    <div className="flex flex-wrap items-center gap-3"><input className={`${inputClass} max-w-xs`} aria-label="搜索技能" placeholder="搜索技能名称或用途" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><span className="text-my-xs text-my-tertiary">当前空间与组织技能 · {skills.length} 项</span></div>
    {skills.length === 0 ? <EmptyState title="暂无匹配的技能" description="为重复出现的工作建立一份规范，再从 Agent 配置中绑定。" /> :
      <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
        {skills.map((skill) => {
          const bound = snapshot.agents.filter((agent) => agent.skillIds.includes(skill.id))
          return <section key={skill.id} className="flex flex-col gap-3 rounded-my-md border border-my-line bg-my-layer-1 p-3">
            <header className="flex items-start gap-2"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-my-md bg-my-layer-2"><FlowIcon name="skills" size={20} /></span>
              <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium text-my-primary">{skill.name}</h2><p className="text-my-xs text-my-tertiary">{skill.description || '暂无用途描述'}</p></div><span className="text-my-2xs text-my-tertiary">{skill.spaceId ? '空间技能' : '组织技能'}</span>
            </header>
            <pre className="my-scrollbar max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-my-md bg-my-layer-2 px-2.5 py-2 text-my-xs leading-relaxed text-my-secondary">{skill.content}</pre>
            <div className="flex flex-wrap items-center gap-1.5 text-my-xs text-my-tertiary"><span>绑定 {bound.length} 个 Agent</span>{bound.filter((agent) => agent.spaceId === currentSpaceId).map((agent) => <button key={agent.id} type="button" onClick={() => setEditingAgent(agent)} className="inline-flex items-center gap-1 rounded-my-sm border border-my-line px-1.5 py-0.5 text-my-secondary hover:bg-my-layer-1-hover"><FlowIcon name="agents" size={12} />{agent.name}{agent.archived ? ' · 已归档' : !agent.enabled ? ' · 已停用' : ''}</button>)}</div>
            <footer className="mt-auto flex justify-end gap-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(skill)}>编辑</Button><Button variant="ghost" size="sm" disabled={busy} aria-label={`删除技能 ${skill.name}`} onClick={() => void remove(skill)}><Trash2 size={13} /></Button></footer>
          </section>
        })}
      </div>}
    {editing && <SkillEditor key={`${currentSpaceId}:${editing === 'new' ? 'new' : editing.id}`} skill={editing === 'new' ? null : editing} spaceId={currentSpaceId ?? undefined} onClose={() => setEditing(null)} />}
    {editingAgent && <AgentEditor key={editingAgent.id} agent={editingAgent} spaceId={editingAgent.spaceId} onClose={() => setEditingAgent(null)} />}
  </div>
}

function SkillEditor({ skill, spaceId, onClose }: { skill: HifoxSkill | null; spaceId?: string; onClose: () => void }): JSX.Element {
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [content, setContent] = useState(skill?.content ?? '')
  const [scope, setScope] = useState(skill ? skill.spaceId ?? '' : spaceId ?? '')
  const submit = async (): Promise<void> => {
    if (busy || !name.trim() || !content.trim()) return
    const result = await run(skill ? '更新技能' : '创建技能', () => api.hifox.saveSkill({ id: skill?.id, spaceId: scope || undefined, name: name.trim(), description: description.trim() || undefined, content: content.trim() }))
    if (result?.ok) onClose()
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={540} ariaLabel={skill ? '编辑技能' : '新建技能'}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col gap-3 p-4">
      <h2 className="shrink-0 text-sm font-semibold text-my-primary">{skill ? `编辑 ${skill.name}` : '新建技能'}</h2>
      <div className="my-scrollbar min-h-0 overflow-y-auto pr-1"><div className="flex flex-col gap-3">
        <Field label="技能名称"><input className={inputClass} autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="如：组件回归检查" /></Field>
        <Field label="用途描述"><input className={inputClass} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明适用的任务和时机" /></Field>
        <Field label="可用范围" hint="组织技能可供所有空间绑定；空间技能仅供所属空间使用。"><select className={inputClass} disabled={Boolean(skill)} value={scope} onChange={(event) => setScope(event.target.value)}><option value="">组织技能</option>{(skill?.spaceId || spaceId) && <option value={skill?.spaceId ?? spaceId}>当前空间技能</option>}</select></Field>
        <Field label="技能指令" hint="写可复用的步骤、检查项与输出格式；不要写单次任务目标或敏感凭据。"><textarea className={`${textareaClass} font-mono text-my-xs`} style={{ minHeight: 'var(--my-space-192)' }} value={content} onChange={(event) => setContent(event.target.value)} placeholder="适用条件、工作步骤、验证方法与结果格式…" /></Field>
        <p className="text-my-xs text-my-tertiary">在 Agent 配置中勾选技能完成绑定。此处维护指令内容，执行时的技能加载由 Runtime 接入。</p>
      </div></div>
      <div className="flex shrink-0 justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" disabled={busy || !name.trim() || !content.trim()} onClick={() => void submit()}>{busy ? '保存中…' : skill ? '保存' : '创建'}</Button></div>
    </div>
  </Modal>
}
