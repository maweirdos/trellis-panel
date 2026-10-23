/**
 * 技能库：可复用流程规范的创建与绑定关系展示（PRD 2.9）。
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useHifox } from '../store'
import { PageHeader, Field, inputClass } from '../ui'
import { Button, EmptyState, Modal } from '../../my/ui'
import type { HifoxSkill } from '@shared/hifox'

export function SkillsPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const run = useHifox((s) => s.run)
  const [editing, setEditing] = useState<HifoxSkill | 'new' | null>(null)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="技能"
        description="会反复用到、且不止一个 Agent 需要的流程，沉淀成技能再绑定给 Agent；一次性的目标写在任务里"
        actions={<Button variant="primary" size="sm" onClick={() => setEditing('new')}><Plus size={14} />新建技能</Button>}
      />
      {snapshot.skills.length === 0
        ? <EmptyState title="暂无技能" description="把提交规范、回归清单这类流程沉淀为技能" />
        : (
          <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
            {snapshot.skills.map((skill) => {
              const boundAgents = snapshot.agents.filter((a) => a.skillIds.includes(skill.id))
              return (
                <section key={skill.id} className="flex flex-col gap-2 rounded-my-md border border-my-line bg-my-layer/40 p-3">
                  <header className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-medium text-my-primary">✨ {skill.name}</h2>
                      <p className="truncate text-my-xs text-my-tertiary">{skill.description ?? '暂无描述'}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(skill)}>编辑</Button>
                      <button type="button" aria-label={`删除技能 ${skill.name}`} className="grid h-7 w-7 place-items-center rounded-my-md text-my-tertiary hover:bg-my-layer hover:text-red-400"
                        onClick={() => void run('删除技能', () => api.hifox.removeSkill({ id: skill.id }))}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </header>
                  <pre className="my-scrollbar max-h-40 overflow-y-auto whitespace-pre-wrap rounded-my-md bg-my-layer px-2.5 py-2 text-my-xs leading-relaxed text-my-secondary">{skill.content}</pre>
                  <p className="mt-auto text-[11px] text-my-tertiary">
                    {boundAgents.length > 0 ? `已绑定：${boundAgents.map((a) => a.name).join('、')}` : '尚未绑定任何 Agent'}
                  </p>
                </section>
              )
            })}
          </div>
        )}
      <SkillEditor skill={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

function SkillEditor({ skill, onClose }: { skill: HifoxSkill | 'new' | null; onClose: () => void }): JSX.Element | null {
  const run = useHifox((s) => s.run)
  const existing = skill && skill !== 'new' ? skill : null
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [content, setContent] = useState(existing?.content ?? '1. …\n2. …\n3. …')

  if (!skill) return null

  const submit = async (): Promise<void> => {
    const result = await run(existing ? '更新技能' : '创建技能', () => api.hifox.saveSkill({
      id: existing?.id, name: name.trim(), description: description.trim() || undefined, content: content.trim()
    }))
    if (result?.ok) onClose()
  }

  return (
    <Modal open onClose={onClose} width={500} ariaLabel={existing ? '编辑技能' : '新建技能'}>
      <div className="flex flex-col gap-3 p-1">
        <h2 className="text-sm font-semibold text-my-primary">{existing ? `编辑 ${existing.name}` : '新建技能'}</h2>
        <div className="grid grid-cols-2 gap-2">
          <Field label="名称"><input className={inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：提交规范" /></Field>
          <Field label="一句话描述"><input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <Field label="内容（检查项 / 步骤 / 汇报格式）">
          <textarea className={`${inputClass} min-h-40 resize-y font-mono text-my-xs`} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={!name.trim() || !content.trim()} onClick={() => void submit()}>{existing ? '保存' : '创建'}</Button>
        </div>
      </div>
    </Modal>
  )
}
