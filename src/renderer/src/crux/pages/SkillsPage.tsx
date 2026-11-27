import { useState, type JSX } from 'react'
import { Bot, ChevronDown, Plus, Search, ShoppingBag, Trash2, Wrench, X } from 'lucide-react'
import type { CruxSkill } from '@shared/crux'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, Dropdown, DropdownItem, EmptyState } from '../../my/ui'
import { SKILL_MARKET_PRESETS } from '../collaboration-platform-store'
import { useCrux } from '../store'
import { Field, inputClass, Select, textareaClass } from '../ui'

type SkillScopeFilter = 'all' | 'in_use' | 'unused' | 'space'

/**
 * 1:1 复刻 HiFox「技能（组织中所有 Agent 都可以遵循的操作手册）」：
 * 胶囊筛选（全部 / 使用中 / 未使用 / 空间专属）+ 列表行 + 右侧 SKILL.md 详情与编辑抽屉。
 */
export function SkillsPage(): JSX.Element | null {
  const { snapshot, currentSpaceId, busy, run, setModule } = useCrux()
  const [scopeTab, setScopeTab] = useState<SkillScopeFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<CruxSkill | 'new' | null>(null)

  if (!snapshot) return null

  const allVisible = snapshot.skills.filter((skill) => !skill.spaceId || skill.spaceId === currentSpaceId)
  const skills = allVisible.filter((skill) => {
    const usedCount = snapshot.agents.filter((a) => !a.archived && a.skillIds.includes(skill.id)).length
    if (scopeTab === 'in_use' && usedCount === 0) return false
    if (scopeTab === 'unused' && usedCount > 0) return false
    if (scopeTab === 'space' && skill.spaceId !== currentSpaceId) return false
    return `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(keyword.trim().toLowerCase())
  })

  const removeSkill = async (skill: CruxSkill): Promise<void> => {
    const bound = snapshot.agents.filter((a) => a.skillIds.includes(skill.id))
    if (!await confirmDialog({
      title: `删除技能「${skill.name}」？`,
      message: bound.length ? `将同步解除 ${bound.length} 个 Agent 的绑定。` : '删除后无法恢复。',
      confirmText: '删除',
      danger: true
    })) return
    const res = await run('删除技能', () => api.crux.removeSkill({ id: skill.id }))
    if (res?.ok && selected !== 'new' && selected?.id === skill.id) setSelected(null)
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="my-scrollbar flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-1 py-1" style={{ scrollbarGutter: 'stable' }}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-my-lg font-semibold text-my-primary">技能</h1>
            <p className="mt-0.5 text-my-xs text-my-tertiary">组织中所有 Agent 都可以遵循的操作手册（SKILL.md）。</p>
          </div>
          <div className="flex items-center gap-2">
            <Dropdown
              align="right"
              width={220}
              trigger={({ toggle, open }) => (
                <Button size="sm" variant="primary" aria-expanded={open} onClick={toggle}>
                  <Plus size={14} />添加技能<ChevronDown size={13} />
                </Button>
              )}
            >
              {(close) => (
                <>
                  <DropdownItem onClick={() => { close(); setSelected('new') }}>
                    <div>
                      <div className="font-medium text-my-primary">手动编写</div>
                      <div className="text-my-2xs text-my-tertiary">自己动手编写 SKILL.md 规范</div>
                    </div>
                  </DropdownItem>
                  <DropdownItem onClick={() => { close(); setModule('marketplace') }}>
                    <div>
                      <div className="font-medium text-my-primary">安装公开技能</div>
                      <div className="text-my-2xs text-my-tertiary">从市场一键导入研发/审查/发布模板</div>
                    </div>
                  </DropdownItem>
                </>
              )}
            </Dropdown>
          </div>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex flex-wrap items-center gap-0.5 rounded-full bg-my-layer-2 p-0.5" role="tablist" aria-label="技能筛选">
            {([
              ['all', '全部'],
              ['in_use', '使用中'],
              ['unused', '未使用'],
              ['space', '当前空间']
            ] as const).map(([id, label]) => {
              const active = scopeTab === id
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setScopeTab(id)}
                  className="collab-filter-pill"
                >
                  {label}
                </button>
              )
            })}
          </div>

          <div className="relative w-56 max-w-full">
            <Search size={14} className="pointer-events-none absolute top-2.5 left-3 text-my-icon-tertiary" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索技能…"
              aria-label="搜索技能"
              className={`${inputClass} pl-8`}
            />
          </div>
        </div>

        {skills.length === 0 ? (
          <EmptyState
            title="暂无技能"
            description="创建技能或从市场导入，供空间内的 Agent 直接调用。"
            action={(
              <>
                <Button size="sm" variant="primary" onClick={() => setSelected('new')}>
                  <Plus size={14} />创建技能
                </Button>
                <Button size="sm" variant="outline" onClick={() => setModule('marketplace')}>
                  <ShoppingBag size={14} />从市场安装公开技能
                </Button>
              </>
            )}
          />
        ) : (
          <div className="overflow-hidden rounded-my-base border border-my-line bg-my-panel">
            <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_100px] border-b border-my-line bg-my-layer-1 px-4 py-2 text-my-2xs font-medium text-my-tertiary">
              <span>名称</span>
              <span>被谁使用</span>
              <span className="text-right">范围</span>
            </div>
            <div className="divide-y divide-my-line">
              {skills.map((skill) => {
                const bound = snapshot.agents.filter((a) => !a.archived && a.skillIds.includes(skill.id))
                const isSelected = selected !== 'new' && selected?.id === skill.id
                return (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => setSelected(skill)}
                    className={`grid w-full grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_100px] items-center gap-3 px-4 py-3 text-left transition-colors ${
                      isSelected ? 'bg-my-layer-2' : 'hover:bg-my-layer-1'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="collab-tone-avatar grid h-8 w-8 shrink-0 place-items-center rounded-my-base" data-tone="indigo">
                        <Wrench size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-my-sm font-medium text-my-primary">{skill.name}</span>
                        <span className="block truncate text-my-2xs text-my-tertiary">{skill.description || '暂无描述'}</span>
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1 text-my-xs text-my-secondary">
                      {bound.length === 0 ? (
                        <span className="text-my-tertiary">— 未使用</span>
                      ) : (
                        bound.slice(0, 3).map((ag) => (
                          <span key={ag.id} className="my-chip"><Bot size={11} />{ag.name}</span>
                        ))
                      )}
                    </span>
                    <span className="text-right text-my-2xs text-my-tertiary">
                      {skill.spaceId ? '空间技能' : '组织共享'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* 右侧 SKILL.md 详情与编辑抽屉 */}
      {selected && (
        <SkillInspectorDrawer
          key={selected === 'new' ? 'new' : selected.id}
          skill={selected === 'new' ? null : selected}
          defaultSpaceId={currentSpaceId ?? undefined}
          onClose={() => setSelected(null)}
          onDelete={selected === 'new' ? undefined : () => void removeSkill(selected)}
        />
      )}
    </div>
  )
}

function SkillInspectorDrawer({
  skill,
  defaultSpaceId,
  onClose,
  onDelete
}: {
  skill: CruxSkill | null
  defaultSpaceId?: string
  onClose: () => void
  onDelete?: () => void
}): JSX.Element {
  const { snapshot, busy, run } = useCrux()
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [scope, setScope] = useState(skill ? (skill.spaceId ?? '') : '')
  const [content, setContent] = useState(skill?.content ?? '')

  const toggleBindAgent = async (agentId: string, bind: boolean): Promise<void> => {
    const ag = snapshot?.agents.find((a) => a.id === agentId)
    if (!ag || !skill || busy) return
    const nextSkillIds = bind ? [...ag.skillIds, skill.id] : ag.skillIds.filter((id) => id !== skill.id)
    await run('更新 Agent 技能绑定', () => api.crux.saveAgent({
      id: ag.id,
      spaceId: ag.spaceId,
      name: ag.name,
      description: ag.description,
      instructions: ag.instructions,
      skillIds: nextSkillIds,
      repositories: ag.repositories,
      runtimeKind: ag.runtimeKind,
      workingDirectory: ag.workingDirectory,
      enabled: ag.enabled,
      archived: ag.archived
    }))
  }

  const save = async (): Promise<void> => {
    if (!name.trim() || !content.trim() || busy) return
    const res = await run(skill ? '保存技能' : '创建技能', () => api.crux.saveSkill({
      id: skill?.id,
      spaceId: scope || undefined,
      name: name.trim(),
      description: description.trim() || undefined,
      content: content.trim()
    }))
    if (res?.ok && !skill) onClose()
  }

  const eligibleAgents = (snapshot?.agents ?? []).filter((a) => !a.archived && (!scope || a.spaceId === scope))

  return (
    <aside className="ml-4 flex h-full w-[420px] max-w-full shrink-0 flex-col rounded-my-base border border-my-line bg-my-canvas">
      <header className="flex items-center justify-between border-b border-my-line px-4 py-2.5">
        <h2 className="text-my-sm font-semibold text-my-primary">{skill ? skill.name : '创建新技能'}</h2>
        <div className="flex items-center gap-1">
          {onDelete && (
            <button type="button" aria-label="删除技能" onClick={onDelete} className="grid h-7 w-7 place-items-center rounded-my-base text-my-tertiary hover:bg-my-layer-1 hover:text-my-danger-text">
              <Trash2 size={14} />
            </button>
          )}
          <button type="button" aria-label="关闭抽屉" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1">
            <X size={15} />
          </button>
        </div>
      </header>

      <div className="my-scrollbar flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
        {!skill && (
          <div>
            <div className="mb-1.5 text-my-2xs text-my-tertiary">快速套用预设模板</div>
            <div className="flex flex-wrap gap-1.5">
              {SKILL_MARKET_PRESETS.slice(0, 3).map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => { setName(preset.name); setDescription(preset.description); setContent(preset.content) }}
                  className="rounded-full border border-my-line bg-my-panel px-2.5 py-0.5 text-my-2xs text-my-secondary hover:border-my-line-strong hover:text-my-primary"
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <Field label="技能名称">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：PR 代码审查清单" />
        </Field>
        <Field label="用途简介">
          <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明适用时机" />
        </Field>
        <Field label="共享范围">
          <Select
            className="w-full"
            disabled={Boolean(skill)}
            value={scope}
            onChange={setScope}
            options={[
              { value: '', label: '在整个组织内共享' },
              ...(defaultSpaceId ? [{ value: defaultSpaceId, label: '仅当前空间可用' }] : [])
            ]}
          />
        </Field>
        <Field label="SKILL.md 指令正文">
          <textarea
            className={`${textareaClass} font-mono text-my-xs`}
            style={{ minHeight: 'var(--my-space-192)' }}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="编写可复用的检查步骤、工作方法与输出要求…"
          />
        </Field>

        {skill && eligibleAgents.length > 0 && (
          <div className="border-t border-my-line pt-3 space-y-1.5">
            <div className="text-my-xs font-medium text-my-primary">附加给 Agent（勾选立即生效）</div>
            {eligibleAgents.map((ag) => {
              const checked = ag.skillIds.includes(skill.id)
              return (
                <label key={ag.id} className="flex items-center gap-2 rounded-my-base border border-my-line bg-my-panel px-2.5 py-1.5 text-my-xs">
                  <input type="checkbox" checked={checked} onChange={(e) => void toggleBindAgent(ag.id, e.target.checked)} />
                  <Bot size={13} />
                  <span className="truncate text-my-primary">{ag.name}</span>
                </label>
              )
            })}
          </div>
        )}
      </div>

      <footer className="flex justify-end gap-2 border-t border-my-line px-4 py-3">
        <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
        <Button size="sm" variant="primary" disabled={!name.trim() || !content.trim() || busy} onClick={() => void save()}>
          {skill ? '保存修改' : '创建技能'}
        </Button>
      </footer>
    </aside>
  )
}
