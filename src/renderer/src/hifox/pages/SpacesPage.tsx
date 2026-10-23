/**
 * 空间与配置：空间列表/新建/多人处理人开关 + 任务类型/状态/标签管理（PRD 3.1/4.1/4.3/4.4）。
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useHifox } from '../store'
import { PageHeader, Field, inputClass, LabelChip } from '../ui'
import { Button, Switch, EmptyState } from '../../my/ui'
import type { HifoxStatusCategory } from '@shared/hifox'

const CATEGORIES: Array<[HifoxStatusCategory, string]> = [
  ['backlog', 'Backlog（收集规划）'], ['todo', 'Todo（可开始）'], ['in_progress', '处理中'],
  ['in_review', '待评审'], ['done', '完成'], ['blocked', '受阻'], ['cancelled', '已取消']
]

export function SpacesPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const setCurrentSpace = useHifox((s) => s.setCurrentSpace)
  const run = useHifox((s) => s.run)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const [typeName, setTypeName] = useState('')
  const [statusName, setStatusName] = useState('')
  const [statusCategory, setStatusCategory] = useState<HifoxStatusCategory>('todo')
  const [labelName, setLabelName] = useState('')
  const [labelAsOrg, setLabelAsOrg] = useState(false)

  const space = snapshot.spaces.find((s) => s.id === currentSpaceId)
  const types = snapshot.taskTypes.filter((t) => t.spaceId === currentSpaceId)
  const statuses = snapshot.taskStatuses.filter((s) => s.spaceId === currentSpaceId).sort((a, b) => a.order - b.order)
  const labels = snapshot.taskLabels.filter((l) => !l.spaceId || l.spaceId === currentSpaceId)

  const createSpace = async (): Promise<void> => {
    const result = await run('创建空间', () => api.hifox.createSpace({ name: name.trim(), key: key.trim(), description: description.trim() || undefined }))
    if (result?.ok && result.data) {
      const created = result.data.spaces[result.data.spaces.length - 1]
      if (created) setCurrentSpace(created.id)
      setName(''); setKey(''); setDescription(''); setCreateOpen(false)
    }
  }

  if (!space) return <EmptyState title="还没有空间" description="创建一个空间开始协作" />

  return (
    <div className="my-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      <PageHeader
        title="空间与配置"
        description="空间是团队与任务的边界；前缀决定任务编号，工作流配置按空间独立"
        actions={<Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />新建空间</Button>}
      />

      <section className="flex flex-col gap-2 rounded-my-md border border-my-line bg-my-layer/40 p-3">
        <h2 className="text-my-sm font-medium text-my-primary">当前空间：{space.name}（{space.key}）</h2>
        <p className="text-my-xs text-my-tertiary">{space.description ?? '暂无描述'}</p>
        <div className="flex flex-wrap items-center gap-4">
          <Switch
            checked={space.multiAssignee}
            onChange={(value) => void run('更新空间', () => api.hifox.updateSpace({ id: space.id, multiAssignee: value }))}
            label="多人处理人（关闭后既有任务收敛为第一名处理人）"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {snapshot.spaces.map((s) => (
            <button key={s.id} type="button" onClick={() => setCurrentSpace(s.id)}
              className={`rounded-my-md border px-2.5 py-1.5 text-left text-my-xs transition-colors ${s.id === space.id ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border-my-line text-my-secondary hover:bg-my-layer'}`}>
              <span className="block font-medium">{s.name}</span>
              <span className="text-[10px] text-my-tertiary">{s.key} · {s.memberIds.length} 成员 · 任务 #{s.taskSeq}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <section className="flex flex-col gap-2 rounded-my-md border border-my-line p-3">
          <h2 className="text-my-sm font-medium text-my-primary">任务类型（PRD 4.1 / 4.4 两层模型）</h2>
          <ul className="space-y-1.5">
            {types.map((type) => (
              <li key={type.id} className="rounded-my-md bg-my-layer/60 p-2">
                <div className="flex items-center gap-2 text-my-xs">
                  <span className={`min-w-0 flex-1 truncate ${type.isDefault ? 'font-medium text-my-primary' : 'text-my-secondary'}`}>
                    {type.name}{type.isDefault && '（默认）'}
                    {type.requiredHints && <span className="ml-1 text-my-tertiary">需补：{type.requiredHints.join('、')}</span>}
                  </span>
                  {!type.isDefault && (
                    <button type="button" aria-label={`删除类型 ${type.name}`} className="text-my-tertiary hover:text-red-400"
                      onClick={() => void run('删除类型', () => api.hifox.removeTaskType({ id: type.id }))}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                {/* PRD 4.4 规则1：每个类型可配置可用状态；点选保存 */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {statuses.map((status) => {
                    const on = type.statusIds ? type.statusIds.includes(status.id) : true
                    return (
                      <button key={status.id} type="button"
                        title={type.statusIds ? '配置该类型的可用状态' : '当前沿用空间全部状态，点选任一状态即开始自定义'}
                        onClick={() => {
                          const next = type.statusIds
                            ? (type.statusIds.includes(status.id)
                                ? type.statusIds.filter((x) => x !== status.id)
                                : [...type.statusIds, status.id])
                            : [status.id]
                          void run('更新类型状态集', () => api.hifox.updateTaskType({ id: type.id, statusIds: next }))
                        }}
                        className={`rounded-my-sm px-1.5 py-0.5 text-[10px] transition-opacity ${on ? 'bg-indigo-500/20 text-indigo-300' : 'bg-my-layer text-my-tertiary opacity-50'}`}>
                        {status.name}
                      </button>
                    )
                  })}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-auto flex gap-1.5 pt-2">
            <input className={inputClass} placeholder="新类型名称" value={typeName} onChange={(e) => setTypeName(e.target.value)} />
            <Button size="sm" disabled={!typeName.trim()} onClick={() => {
              void run('创建类型', () => api.hifox.createTaskType({ spaceId: space.id, name: typeName.trim() }))
              setTypeName('')
            }}><Plus size={13} /></Button>
          </div>
        </section>

        <section className="flex flex-col gap-2 rounded-my-md border border-my-line p-3">
          <h2 className="text-my-sm font-medium text-my-primary">任务状态（PRD 4.4）</h2>
          <ul className="space-y-1">
            {statuses.map((status) => (
              <li key={status.id} className="flex items-center gap-2 text-my-xs">
                <span className="min-w-0 flex-1 truncate text-my-secondary">{status.order}. {status.name}</span>
                <span className="shrink-0 text-[10px] text-my-tertiary">{CATEGORIES.find(([c]) => c === status.category)?.[1].split('（')[0]}</span>
                <button type="button" aria-label={`删除状态 ${status.name}`} className="text-my-tertiary hover:text-red-400"
                  onClick={() => void run('删除状态', () => api.hifox.removeTaskStatus({ id: status.id }))}>
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-auto flex gap-1.5 pt-2">
            <input className={`${inputClass} flex-1`} placeholder="新状态名称" value={statusName} onChange={(e) => setStatusName(e.target.value)} />
            <select className={`${inputClass} w-28`} value={statusCategory} onChange={(e) => setStatusCategory(e.target.value as HifoxStatusCategory)}>
              {CATEGORIES.map(([c, label]) => <option key={c} value={c}>{label.split('（')[0]}</option>)}
            </select>
            <Button size="sm" disabled={!statusName.trim()} onClick={() => {
              void run('创建状态', () => api.hifox.createTaskStatus({ spaceId: space.id, name: statusName.trim(), category: statusCategory }))
              setStatusName('')
            }}><Plus size={13} /></Button>
          </div>
        </section>

        <section className="flex flex-col gap-2 rounded-my-md border border-my-line p-3">
          <h2 className="text-my-sm font-medium text-my-primary">任务标签（PRD 4.3）</h2>
          <ul className="space-y-1">
            {labels.map((label) => (
              <li key={label.id} className="flex items-center gap-2 text-my-xs">
                <span className={`min-w-0 flex-1 ${label.archived ? 'opacity-40 line-through' : ''}`}>
                  <LabelChip label={label} />{!label.spaceId && <span className="ml-1 text-[10px] text-my-tertiary">组织</span>}
                </span>
                {!label.archived && (
                  <button type="button" aria-label={`归档标签 ${label.name}`} className="text-my-tertiary hover:text-amber-400"
                    onClick={() => void run('归档标签', () => api.hifox.archiveLabel({ id: label.id }))}>
                    归档
                  </button>
                )}
              </li>
            ))}
            {labels.length === 0 && <li className="text-my-xs text-my-tertiary">暂无标签</li>}
          </ul>
          <div className="mt-auto flex flex-col gap-1.5 pt-2">
            <div className="flex gap-1.5">
              <input className={inputClass} placeholder="新标签名称" value={labelName} onChange={(e) => setLabelName(e.target.value)} />
              <Button size="sm" disabled={!labelName.trim()} onClick={() => {
                void run('创建标签', () => api.hifox.createLabel({ spaceId: labelAsOrg ? undefined : space.id, name: labelName.trim() }))
                setLabelName('')
            }}><Plus size={13} /></Button>
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-my-xs text-my-tertiary" title="PRD 4.3 规则4：组织标签在所有空间可用">
              <input type="checkbox" checked={labelAsOrg} onChange={(e) => setLabelAsOrg(e.target.checked)} />
              创建为组织标签（所有空间可用）
            </label>
          </div>
        </section>
      </div>

      {createOpen && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/40" role="dialog" aria-label="新建空间">
          <div className="w-96 rounded-my-lg border border-my-line bg-my-canvas p-4">
            <h2 className="mb-3 text-sm font-semibold text-my-primary">新建空间</h2>
            <div className="flex flex-col gap-2.5">
              <Field label="空间名称"><input className={inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：设计空间" /></Field>
              <Field label="任务前缀" hint="2~6 个英文字母，作为任务编号前缀（如 ENG-111）">
                <input className={inputClass} value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="如：DSG" />
              </Field>
              <Field label="描述（可选）"><input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
              <p className="text-my-xs text-my-tertiary">新空间自带默认任务类型与七类状态工作流。</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>取消</Button>
                <Button variant="primary" size="sm" disabled={!name.trim() || !/^[A-Z]{2,6}$/.test(key)} onClick={() => void createSpace()}>创建</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
