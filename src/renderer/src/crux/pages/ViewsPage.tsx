import { useRef, useState, type JSX } from 'react'
import { ArrowUpRight, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import type { CruxView, CruxViewFilter } from '@shared/crux'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, Dropdown, DropdownItem, EmptyState, Modal, SearchInput, Tooltip } from '../../my/ui'
import { FlowIcon } from '../icons'
import { applyTaskFilter, isTriagePending, spaceTasks, useCrux } from '../store'
import { Field, inputClass, PageHeader, Select } from '../ui'
import { TaskFilters } from './TaskFilterBar'

const GROUP_LABEL: Record<CruxView['groupBy'], string> = {
  status: '按状态',
  assignee: '按处理人',
  type: '按类型',
  priority: '按优先级'
}

export function ViewsPage(): JSX.Element | null {
  const { snapshot, currentSpaceId, taskFilter, activeViewId, applySavedView, setModule, run, busy } = useCrux()
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [groupBy, setGroupBy] = useState<CruxView['groupBy']>('status')
  const [filter, setFilter] = useState<CruxViewFilter>({})
  const [keyword, setKeyword] = useState('')

  const editorSnapshotRef = useRef({ editingId, title: '新建视图' })
  if (creating) {
    editorSnapshotRef.current = {
      editingId,
      title: editingId ? '编辑视图' : '新建视图'
    }
  }

  if (!snapshot) return null

  const readOnly = Boolean(snapshot.spaces.find((space) => space.id === currentSpaceId)?.archived)
  const allViews = snapshot.views.filter((view) => !currentSpaceId || view.spaceId === currentSpaceId)
  const views = keyword.trim()
    ? allViews.filter((view) => view.name.toLowerCase().includes(keyword.trim().toLowerCase()))
    : allViews
  const tasks = spaceTasks(snapshot, currentSpaceId).filter((task) => !isTriagePending(snapshot, task))

  const openEditor = (view?: CruxView): void => {
    setEditingId(view?.id ?? null)
    setName(view?.name ?? '')
    setGroupBy(view?.groupBy ?? 'status')
    setFilter(view ? { ...view.filter } : { ...taskFilter })
    setCreating(true)
  }

  const save = async (): Promise<void> => {
    if (!currentSpaceId || !name.trim()) return
    const result = await run('保存视图', () =>
      api.crux.saveView({
        id: editingId ?? undefined,
        spaceId: currentSpaceId,
        name: name.trim(),
        filter,
        groupBy
      })
    )
    if (result?.ok) setCreating(false)
  }

  const remove = async (view: CruxView): Promise<void> => {
    const ok = await confirmDialog({
      title: `删除视图「${view.name}」？`,
      message: '删除后仅移除保存的筛选条件，不会删除任何任务数据。',
      confirmText: '删除视图',
      danger: true
    })
    if (!ok) return
    const result = await run('删除视图', () => api.crux.removeView({ id: view.id }))
    if (result?.ok && activeViewId === view.id) applySavedView(null)
  }

  const openView = (view: CruxView): void => {
    applySavedView(view.id)
    setModule('tasks')
  }

  const disabledSaveReason = readOnly
    ? '已归档空间仅支持只读查看'
    : !name.trim()
      ? '请先输入视图名称'
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="视图"
        description="保存常用任务筛选与分组规则，在任务工作区中一键切换复查。"
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={!currentSpaceId || busy || readOnly}
            onClick={() => openEditor()}
          >
            <Plus size={14} />
            <span>新建视图</span>
          </Button>
        }
      />

      {allViews.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-2">
          <SearchInput
            size="sm"
            value={keyword}
            onChange={setKeyword}
            placeholder="搜索已保存视图"
            ariaLabel="搜索视图"
            className="w-64"
          />
          <span className="text-my-xs tabular-nums text-my-tertiary">共 {views.length} 个视图</span>
        </div>
      )}

      {views.length === 0 ? (
        <EmptyState
          icon={<FlowIcon name="board" size={28} />}
          title={keyword.trim() ? '未找到匹配视图' : '还没有保存的视图'}
          description={
            keyword.trim()
              ? '尝试清空或调整搜索关键词。'
              : '将高频的筛选条件与分组方式保存为视图，随时回到任务工作区继续推进。'
          }
          action={
            !keyword.trim() && currentSpaceId && !readOnly ? (
              <Button size="sm" variant="primary" onClick={() => openEditor()}>
                <Plus size={14} />
                <span>新建视图</span>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {views.map((view) => {
            const matchedCount = applyTaskFilter(tasks, snapshot, view.filter).length
            const isActive = activeViewId === view.id
            return (
              <article
                key={view.id}
                className={`my-card flex flex-col justify-between gap-3 p-4 transition-colors duration-150 ease-out ${
                  isActive ? 'border-my-accent bg-my-layer-2' : 'hover:border-my-line-strong'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <h2 className="my-item-title truncate text-my-sm font-medium text-my-primary">{view.name}</h2>
                    <div className="flex flex-wrap items-center gap-1.5 text-my-xs text-my-secondary">
                      <span className="rounded-my-sm bg-my-layer-1 px-1.5 py-0.5">{GROUP_LABEL[view.groupBy]}</span>
                      <span className="tabular-nums text-my-tertiary">{matchedCount} 个任务</span>
                      {isActive && (
                        <span className="rounded-my-sm bg-my-accent-subtle px-1.5 py-0.5 text-my-2xs text-my-accent">
                          当前生效
                        </span>
                      )}
                    </div>
                  </div>
                  <Dropdown
                    align="right"
                    width={148}
                    trigger={({ toggle, open }) => (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`视图 ${view.name} 更多操作`}
                        aria-expanded={open}
                        onClick={toggle}
                      >
                        <MoreHorizontal size={14} />
                      </Button>
                    )}
                  >
                    {(close) => (
                      <>
                        <DropdownItem
                          disabled={busy || readOnly}
                          onClick={() => {
                            close()
                            openEditor(view)
                          }}
                        >
                          <Pencil size={13} />
                          <span>编辑视图</span>
                        </DropdownItem>
                        <DropdownItem
                          danger
                          disabled={busy || readOnly}
                          onClick={() => {
                            close()
                            void remove(view)
                          }}
                        >
                          <Trash2 size={13} />
                          <span>删除视图</span>
                        </DropdownItem>
                      </>
                    )}
                  </Dropdown>
                </div>

                <footer className="flex items-center justify-end border-t border-my-line pt-2.5">
                  <Button size="sm" variant="ghost" onClick={() => openView(view)}>
                    <span>打开视图</span>
                    <ArrowUpRight size={13} />
                  </Button>
                </footer>
              </article>
            )
          })}
          </div>
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} width={600} placement="center" ariaLabel={editorSnapshotRef.current.title}>
        <div className="flex max-h-[82vh] flex-col">
          <header className="shrink-0 border-b border-my-line px-6 py-4">
            <h2 className="text-my-base font-medium text-my-primary">{editorSnapshotRef.current.title}</h2>
          </header>
          <div className="my-scrollbar my-fade-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="视图名称">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：本周高优先级 Bug"
                  className={inputClass}
                />
              </Field>
              <Field label="默认分组方式">
                <Select
                  ariaLabel="默认分组方式"
                  value={groupBy}
                  onChange={(value) => setGroupBy(value as CruxView['groupBy'])}
                  options={[
                    { value: 'status', label: '按状态' },
                    { value: 'assignee', label: '按处理人' },
                    { value: 'type', label: '按类型' },
                    { value: 'priority', label: '按优先级' }
                  ]}
                />
              </Field>
            </div>

            <div className="space-y-2 border-t border-my-line pt-3">
              <div className="collab-form-label">任务筛选条件</div>
              <TaskFilters value={filter} onChange={(patch) => setFilter((prev) => ({ ...prev, ...patch }))} />
            </div>
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-my-line px-6 py-3.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCreating(false)}>
              取消
            </Button>
            {disabledSaveReason ? (
              <Tooltip label={disabledSaveReason} wrap>
                <span className="inline-flex">
                  <Button size="sm" variant="primary" disabled>
                    保存视图
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
                保存视图
              </Button>
            )}
          </footer>
        </div>
      </Modal>
    </div>
  )
}
