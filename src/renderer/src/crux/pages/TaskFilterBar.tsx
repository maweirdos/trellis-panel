import { SearchInput } from '../../my/ui'
import { PriorityIcon, StateGroupIcon } from '../../my/icons'
import type { CruxPriority, CruxStatusCategory } from '@shared/crux'
import { PRIORITY_LABEL, statusDisplayName, useCrux, visibleLabels, type CruxTaskFilterState } from '../store'
import { CRUX_STATE_GROUPS, cruxStatusColor } from '../task-workspace-adapter'
import { Select } from '../ui'

const PRIORITY_OPTIONS: CruxPriority[] = ['urgent', 'high', 'medium', 'low', 'none']

function toggleListValue(list: string[] | undefined, value: string): string[] | undefined {
  const current = list ?? []
  const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
  return next.length ? next : undefined
}

export function TaskFilters({
  value,
  onChange
}: {
  value: CruxTaskFilterState
  onChange: (patch: Partial<CruxTaskFilterState>) => void
}): JSX.Element | null {
  const { snapshot, currentSpaceId } = useCrux()
  if (!snapshot) return null

  const statuses = snapshot.taskStatuses
    .filter((item) => !currentSpaceId || item.spaceId === currentSpaceId)
    .slice()
    .sort((left, right) => left.order - right.order)
  const types = snapshot.taskTypes.filter((item) => !currentSpaceId || item.spaceId === currentSpaceId)
  const labels = visibleLabels(snapshot, currentSpaceId)
  const space = snapshot.spaces.find((item) => item.id === currentSpaceId)
  const members = space
    ? snapshot.members.filter((member) => space.memberIds.includes(member.id))
    : snapshot.members
  const iterations = snapshot.iterations.filter((item) => !currentSpaceId || item.spaceId === currentSpaceId)
  const projects = snapshot.projects.filter((item) => (!currentSpaceId || item.spaceId === currentSpaceId) && item.status !== 'archived')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          size="sm"
          value={value.keyword ?? ''}
          onChange={(keyword) => onChange({ keyword: keyword || undefined })}
          placeholder="搜索任务标题或编号"
          ariaLabel="搜索任务标题或编号"
          className="min-w-[180px] flex-1"
        />
        {iterations.length > 0 && (
          <div className="w-36 shrink-0">
            <Select
              className="w-full"
              ariaLabel="按迭代筛选"
              value={value.iterationId ?? ''}
              onChange={(iterationId) => onChange({ iterationId: iterationId || undefined })}
              options={[
                { value: '', label: '全部迭代' },
                ...iterations.map((item) => ({ value: item.id, label: item.name }))
              ]}
            />
          </div>
        )}
        {projects.length > 0 && (
          <div className="w-36 shrink-0">
            <Select
              className="w-full"
              ariaLabel="按专项筛选"
              value={value.projectId ?? ''}
              onChange={(projectId) => onChange({ projectId: projectId || undefined })}
              options={[
                { value: '', label: '全部专项' },
                ...projects.map((item) => ({ value: item.id, label: item.name }))
              ]}
            />
          </div>
        )}
      </div>

      {statuses.length > 0 && (
        <div className="space-y-1.5">
          <div className="pl-0.5 text-my-xs text-my-secondary">状态</div>
          <div className="flex flex-wrap gap-1.5">
            {statuses.map((status) => {
              const selected = value.statusIds?.includes(status.id) ?? false
              const category: CruxStatusCategory = status.category
              return (
                <button
                  key={status.id}
                  type="button"
                  onClick={() => onChange({ statusIds: toggleListValue(value.statusIds, status.id) })}
                  className={`inline-flex items-center gap-1.5 rounded-my-sm border px-2 py-1 text-my-xs transition-colors duration-150 ease-out ${
                    selected
                      ? 'border-my-accent bg-my-accent-subtle text-my-primary'
                      : 'border-my-line bg-my-canvas text-my-secondary hover:bg-my-layer-1'
                  }`}
                >
                  <StateGroupIcon stateGroup={CRUX_STATE_GROUPS[category]} size={12} color={cruxStatusColor(category)} />
                  <span>{statusDisplayName(status)}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="pl-0.5 text-my-xs text-my-secondary">优先级</div>
        <div className="flex flex-wrap gap-1.5">
          {PRIORITY_OPTIONS.map((priority) => {
            const selected = value.priorities?.includes(priority) ?? false
            return (
              <button
                key={priority}
                type="button"
                onClick={() => {
                  const current = value.priorities ?? []
                  const next = current.includes(priority)
                    ? current.filter((item) => item !== priority)
                    : [...current, priority]
                  onChange({ priorities: next.length ? next : undefined })
                }}
                className={`inline-flex items-center gap-1.5 rounded-my-sm border px-2 py-1 text-my-xs transition-colors duration-150 ease-out ${
                  selected
                    ? 'border-my-accent bg-my-accent-subtle text-my-primary'
                    : 'border-my-line bg-my-canvas text-my-secondary hover:bg-my-layer-1'
                }`}
              >
                <PriorityIcon priority={priority} size={12} />
                <span>{PRIORITY_LABEL[priority]}</span>
              </button>
            )
          })}
        </div>
      </div>

      {types.length > 0 && (
        <div className="space-y-1.5">
          <div className="pl-0.5 text-my-xs text-my-secondary">类型</div>
          <div className="flex flex-wrap gap-1.5">
            {types.map((type) => {
              const selected = value.typeIds?.includes(type.id) ?? false
              return (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => onChange({ typeIds: toggleListValue(value.typeIds, type.id) })}
                  className={`inline-flex items-center rounded-my-sm border px-2 py-1 text-my-xs transition-colors duration-150 ease-out ${
                    selected
                      ? 'border-my-accent bg-my-accent-subtle text-my-primary'
                      : 'border-my-line bg-my-canvas text-my-secondary hover:bg-my-layer-1'
                  }`}
                >
                  {type.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {members.length > 0 && (
        <div className="space-y-1.5">
          <div className="pl-0.5 text-my-xs text-my-secondary">处理人</div>
          <div className="flex flex-wrap gap-1.5">
            {members.map((member) => {
              const selected = value.assigneeIds?.includes(member.id) ?? false
              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => onChange({ assigneeIds: toggleListValue(value.assigneeIds, member.id) })}
                  className={`inline-flex items-center rounded-my-sm border px-2 py-1 text-my-xs transition-colors duration-150 ease-out ${
                    selected
                      ? 'border-my-accent bg-my-accent-subtle text-my-primary'
                      : 'border-my-line bg-my-canvas text-my-secondary hover:bg-my-layer-1'
                  }`}
                >
                  {member.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {labels.length > 0 && (
        <div className="space-y-1.5">
          <div className="pl-0.5 text-my-xs text-my-secondary">标签</div>
          <div className="flex flex-wrap gap-1.5">
            {labels.map((label) => {
              const selected = value.labelIds?.includes(label.id) ?? false
              return (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => onChange({ labelIds: toggleListValue(value.labelIds, label.id) })}
                  className={`inline-flex items-center rounded-my-sm border px-2 py-1 text-my-xs transition-colors duration-150 ease-out ${
                    selected
                      ? 'border-my-accent bg-my-accent-subtle text-my-primary'
                      : 'border-my-line bg-my-canvas text-my-secondary hover:bg-my-layer-1'
                  }`}
                >
                  {label.name}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
