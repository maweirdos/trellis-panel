import { useState } from 'react'
import { ArrowUpRight, Plus, Trash2 } from 'lucide-react'
import type { CruxView, CruxViewFilter } from '@shared/crux'
import { api } from '../../api'
import { Button, EmptyState, Modal, SearchInput } from '../../my/ui'
import { FlowIcon } from '../icons'
import { applyTaskFilter, isTriagePending, spaceTasks, useCrux } from '../store'
import { Field, inputClass, PageHeader } from '../ui'
import { TaskFilters } from './TasksPage'

const GROUP_LABEL: Record<CruxView['groupBy'], string> = { status: '按状态', assignee: '按处理人', type: '按类型', priority: '按优先级' }

export function ViewsPage(): JSX.Element | null {
  const { snapshot, currentSpaceId, taskFilter, activeViewId, applySavedView, setModule, run, busy } = useCrux()
  const [keyword, setKeyword] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [groupBy, setGroupBy] = useState<CruxView['groupBy']>('status')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [filter, setFilter] = useState<CruxViewFilter>({})
  if (!snapshot) return null
  const readOnly = Boolean(snapshot.spaces.find((space) => space.id === currentSpaceId)?.archived)
  const views = snapshot.views.filter((view) => view.spaceId === currentSpaceId && view.name.toLowerCase().includes(keyword.trim().toLowerCase()))
  const tasks = spaceTasks(snapshot, currentSpaceId).filter((task) => !isTriagePending(snapshot, task))
  const save = async (): Promise<void> => {
    if (!currentSpaceId || !name.trim() || busy) return
    const result = await run('保存视图', () => api.crux.saveView({ id: editingId ?? undefined, spaceId: currentSpaceId, name: name.trim(), filter, groupBy }))
    if (result?.ok) { if (editingId === activeViewId) applySavedView(editingId); setCreating(false); setName(''); setEditingId(null) }
  }
  const open = (view: CruxView): void => { applySavedView(view.id); setModule('board') }
  const remove = async (view: CruxView): Promise<void> => {
    const result = await run('删除视图', () => api.crux.removeView({ id: view.id }))
    if (result?.ok && activeViewId === view.id) applySavedView(null)
  }
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="视图" description="保存常用任务筛选与分组，在看板中继续查看和调整。" actions={<Button size="sm" variant="primary" disabled={!currentSpaceId || busy || readOnly} onClick={() => { setEditingId(null); setName(''); setGroupBy('status'); setFilter({ ...taskFilter }); setCreating(true) }}><Plus size={14} />新建视图</Button>} />
    <div className="flex flex-wrap items-center justify-between gap-2"><SearchInput value={keyword} onChange={setKeyword} placeholder="搜索视图" /><Button size="sm" variant="ghost" onClick={() => { applySavedView(null); setModule('board') }}>打开任务看板<ArrowUpRight size={13} /></Button></div>
    <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
      {views.length === 0 ? <EmptyState title="暂无匹配视图" description="创建视图保存当前空间的常用筛选，或在任务看板中保存。" /> : <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">{views.map((view) => {
        const count = applyTaskFilter(tasks, snapshot, view.filter).length
        const criteria = Object.values(view.filter).filter((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)).length
        return <article key={view.id} data-saved-view={view.id} className="flex min-w-0 flex-col gap-3 rounded-my-md border border-my-line p-3">
          <button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => open(view)}><FlowIcon name="board" size={18} /><h2 className="my-item-title min-w-0 flex-1 truncate">{view.name}</h2><ArrowUpRight size={14} className="shrink-0 text-my-tertiary" /></button>
          <p className="text-my-xs text-my-secondary">{GROUP_LABEL[view.groupBy]} · {criteria > 0 ? `${criteria} 项筛选` : '全部任务'} · {count} 条任务</p>
          <footer className="flex flex-wrap items-center gap-2"><Button size="sm" variant="ghost" onClick={() => open(view)}>打开视图</Button><Button size="sm" variant="ghost" disabled={busy || readOnly} onClick={() => { setEditingId(view.id); setName(view.name); setGroupBy(view.groupBy); setFilter({ ...view.filter }); setCreating(true) }}>编辑视图</Button><Button size="sm" variant="ghost" className="ml-auto" disabled={busy || readOnly} aria-label={`删除视图 ${view.name}`} onClick={() => void remove(view)}><Trash2 size={13} />删除</Button></footer>
        </article>
      })}</div>}
    </div>
    <Modal open={creating} onClose={() => { if (!busy) setCreating(false) }} width={720} ariaLabel={editingId ? '编辑视图' : '新建视图'}>
      <div className="flex max-h-[var(--my-modal-max-height)] flex-col gap-4 p-4"><h2 className="text-my-lg font-semibold text-my-primary">{editingId ? '编辑视图' : '新建视图'}</h2>
        <div className="my-scrollbar min-h-0 space-y-4 overflow-y-auto pr-1"><Field label="视图名称"><input autoFocus className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：待我处理的高优先级任务" /></Field>
          <Field label="分组方式"><select className={inputClass} value={groupBy} onChange={(event) => setGroupBy(event.target.value as CruxView['groupBy'])}>{(Object.keys(GROUP_LABEL) as CruxView['groupBy'][]).map((key) => <option key={key} value={key}>{GROUP_LABEL[key]}</option>)}</select></Field>
          <div><h3 className="mb-2 text-my-xs text-my-tertiary">任务筛选</h3><TaskFilters value={filter} onChange={(patch) => setFilter((previous) => ({ ...previous, ...patch }))} /></div>
        </div>
        <footer className="flex justify-end gap-2"><Button size="sm" disabled={busy || readOnly} onClick={() => setCreating(false)}>取消</Button><Button size="sm" variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>保存视图</Button></footer>
      </div>
    </Modal>
  </div>
}
