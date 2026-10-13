// 参考 设置页（三作用域）：项目设置（常规/状态/标签/成员/功能）、工作区设置（常规/成员）、
// 偏好外观（Profile：主题卡 / 自定义强调色 / 账户）。所有写操作均为内存演示（useMy.setState）。
import { useState, type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Check, ChevronDown } from 'lucide-react'
import { useMy, useProject } from '../store'
import type { MyStore } from '../store'
import { Avatar, Button, Dropdown, DropdownHeader, DropdownItem, LabelPill } from '../ui'
import { WorkspaceMark, StateGroupIcon } from '../icons'
import type { Member, Project, StateGroup, ThemeMode } from '../types'

/* ---------------- 常量 ---------------- */

const STATE_GROUP_LABELS: Record<StateGroup, string> = {
  backlog: 'Backlog',
  unstarted: 'Unstarted',
  started: 'Started',
  completed: 'Completed',
  cancelled: 'Cancelled'
}

const STATE_GROUPS: StateGroup[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled']

/** 上游令牌包 label 8 色系 */
const LABEL_FAMILIES = ['indigo', 'emerald', 'grey', 'crimson', 'yellow', 'orange', 'pink', 'purple'] as const
type LabelFamily = (typeof LABEL_FAMILIES)[number]

/** 自定义强调色预设（与 参考 默认品牌蓝起点一致的自拟 8 色） */
const ACCENT_PRESETS = ['#006399', '#7e22ce', '#c2410c', '#15803d', '#b91c1c', '#0f766e', '#a16207', '#2563eb']

type FeatureKey = 'cycleEnabled' | 'moduleEnabled' | 'pagesEnabled' | 'intakeEnabled'

const FEATURES: Array<{ key: FeatureKey; label: string; desc: string }> = [
  { key: 'cycleEnabled', label: 'Cycles', desc: '按周期迭代规划与跟踪工作项。' },
  { key: 'moduleEnabled', label: 'Modules', desc: '按功能模块组织相关工作项。' },
  { key: 'pagesEnabled', label: 'Pages', desc: '项目内的协作文档与知识库。' },
  { key: 'intakeEnabled', label: 'Intake', desc: '接收并处理外部提交的工单。' }
]

/* ---------------- 通用小件 ---------------- */

/** 设置页骨架：左 220px 导航 + 右内容区 */
function SettingsShell<T extends string>({
  items,
  activeId,
  onSelect,
  children
}: {
  items: Array<{ id: T; label: string }>
  activeId: T
  onSelect: (id: T) => void
  children: ReactNode
}): JSX.Element {
  return (
    <div className="mx-auto flex max-w-[1024px] bg-my-canvas">
      <nav className="w-[220px] shrink-0 py-6">
        <div className="px-4 text-[15px] font-semibold text-my-primary">Settings</div>
        <div className="mt-3 flex flex-col gap-0.5 px-1">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => onSelect(it.id)}
              className={clsx(
                'rounded-md px-3 py-1.5 text-left text-[13px]',
                activeId === it.id
                  ? 'bg-my-layer-1-active text-my-primary'
                  : 'text-my-secondary hover:bg-my-layer-transparent-hover'
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1 py-6 pr-8">{children}</div>
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="mb-3 text-[13px] font-semibold text-my-primary">{children}</h3>
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-my-tertiary">{label}</div>
      {children}
    </div>
  )
}

/** 紧凑输入框（添加行内使用，h-8） */
function MiniInput({
  value,
  onChange,
  placeholder,
  width
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  width?: number
}): JSX.Element {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={width ? { width } : undefined}
      className="h-8 rounded-md border border-my-line bg-my-layer-2 px-2.5 text-[12.5px] text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
    />
  )
}

/** 自制开关（参考 风格：开=强调色底，圆点右移） */
function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className={clsx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors', on ? 'bg-my-accent' : 'bg-my-layer-3')}
    >
      <span
        className={clsx(
          'absolute left-[2px] top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform',
          on && 'translate-x-[14px]'
        )}
      />
    </button>
  )
}

/** 成员行：头像 + 名字 + 角色徽标 */
function MemberList({ members }: { members: Member[] }): JSX.Element {
  return (
    <div className="my-card px-4 py-1">
      {members.map((m) => (
        <div key={m.id} className="flex h-11 items-center gap-2.5 border-b border-my-line last:border-b-0">
          <Avatar name={m.name} color={m.avatarColor} size={24} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-my-primary">{m.name}</span>
          <span className="rounded bg-my-layer-3 px-1.5 py-0.5 text-[11px] text-my-tertiary">{m.role}</span>
        </div>
      ))}
    </div>
  )
}

/* ---------------- 项目设置 ---------------- */

function ProjectGeneral({ project }: { project: Project }): JSX.Element {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const dirty = name !== project.name || description !== project.description

  const save = (): void => {
    useMy.setState((s) => ({
      data: {
        ...s.data,
        projects: s.data.projects.map((p) =>
          p.id === project.id ? { ...p, name: name.trim() || p.name, description } : p
        )
      }
    }))
  }

  return (
    <>
      <SectionTitle>General</SectionTitle>
      <div className="flex flex-col gap-4 my-card p-4">
        <Field label="项目名称">
          <input className="my-input" value={name} placeholder="项目名称" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="项目描述">
          <textarea
            value={description}
            rows={3}
            placeholder="一句话描述这个项目…"
            onChange={(e) => setDescription(e.target.value)}
            style={{ height: 'auto', padding: '8px 12px', resize: 'vertical' }}
            className="w-full rounded-md border border-my-line bg-my-layer-2 text-[13px] leading-relaxed text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
          />
        </Field>
        <Field label="项目图标与颜色">
          <div className="flex items-center gap-2.5">
            <WorkspaceMark color={project.color} letter={project.icon.slice(0, 1)} size={36} />
            <span className="text-[12px] text-my-tertiary">{project.color}</span>
          </div>
        </Field>
        <div className="flex items-center">
          <Button variant="primary" disabled={!dirty} onClick={save}>
            保存
          </Button>
          <span className="ml-2.5 text-[11px] text-my-tertiary">演示环境：仅内存生效</span>
        </div>
      </div>
    </>
  )
}

function ProjectStates(): JSX.Element {
  const states = useMy((s) => s.data.states)
  const sorted = [...states].sort((a, b) => a.sequence - b.sequence)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [group, setGroup] = useState<StateGroup>('backlog')
  const [color, setColor] = useState('#A3A3A3')

  const confirmAdd = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    const maxSeq = states.reduce((m, st) => Math.max(m, st.sequence), 0)
    useMy.setState((s) => ({
      data: {
        ...s.data,
        states: [
          ...s.data.states,
          { id: `st-custom-${Date.now()}`, name: trimmed, color, group, sequence: maxSeq + 10000 }
        ]
      }
    }))
    setName('')
    setGroup('backlog')
    setColor('#A3A3A3')
    setAdding(false)
  }

  return (
    <>
      <SectionTitle>States</SectionTitle>
      <div className="my-card px-4">
        {sorted.map((st) => (
          <div key={st.id} className="flex h-10 items-center gap-2.5 border-b border-my-line text-[13px]">
            <StateGroupIcon stateGroup={st.group} color={st.color} size={14} />
            <span className="min-w-0 flex-1 truncate text-my-primary">{st.name}</span>
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: st.color }} />
            <span className="w-[90px] shrink-0 text-right text-[12px] text-my-tertiary">{STATE_GROUP_LABELS[st.group]}</span>
          </div>
        ))}
      </div>
      {adding ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <MiniInput value={name} onChange={setName} placeholder="状态名称" width={150} />
          <Dropdown
            width={160}
            trigger={({ toggle }) => (
              <button
                type="button"
                onClick={toggle}
                className="flex h-8 items-center gap-1.5 rounded-md border border-my-line bg-my-layer-2 px-2.5 text-[12.5px] text-my-secondary hover:border-my-line-1"
              >
                <StateGroupIcon stateGroup={group} color={color} size={13} />
                {STATE_GROUP_LABELS[group]}
                <ChevronDown size={12} className="text-my-icon-tertiary" />
              </button>
            )}
          >
            {(close) => (
              <div>
                <DropdownHeader>状态组</DropdownHeader>
                {STATE_GROUPS.map((g) => (
                  <DropdownItem
                    key={g}
                    selected={g === group}
                    icon={<StateGroupIcon stateGroup={g} color={color} size={13} />}
                    onClick={() => {
                      setGroup(g)
                      close()
                    }}
                  >
                    {STATE_GROUP_LABELS[g]}
                  </DropdownItem>
                ))}
              </div>
            )}
          </Dropdown>
          <input
            type="color"
            value={color}
            title="状态颜色"
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded-md border border-my-line bg-my-layer-2 p-0.5"
          />
          <Button variant="primary" size="sm" onClick={confirmAdd}>
            确定
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
            取消
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-3 text-[13px] text-my-secondary hover:text-my-primary"
        >
          + 添加状态
        </button>
      )}
    </>
  )
}

function ProjectLabels(): JSX.Element {
  const labels = useMy((s) => s.data.labels)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [family, setFamily] = useState<LabelFamily>('indigo')

  const confirmAdd = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    useMy.setState((s) => ({
      data: { ...s.data, labels: [...s.data.labels, { id: `lb-custom-${Date.now()}`, name: trimmed, color: family }] }
    }))
    setName('')
    setFamily('indigo')
    setAdding(false)
  }

  return (
    <>
      <SectionTitle>Labels</SectionTitle>
      <div className="my-card p-4">
        <div className="flex flex-wrap gap-2">
          {labels.map((lb) => (
            <LabelPill key={lb.id} label={lb} />
          ))}
        </div>
      </div>
      {adding ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <MiniInput value={name} onChange={setName} placeholder="标签名称" width={150} />
          <Dropdown
            width={160}
            trigger={({ toggle }) => (
              <button
                type="button"
                onClick={toggle}
                className="flex h-8 items-center gap-1.5 rounded-md border border-my-line bg-my-layer-2 px-2.5 text-[12.5px] text-my-secondary hover:border-my-line-1"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-[3px] border"
                  style={{ background: `var(--my-label-${family}-bg)`, borderColor: `var(--my-label-${family}-border)` }}
                />
                {family.charAt(0).toUpperCase() + family.slice(1)}
                <ChevronDown size={12} className="text-my-icon-tertiary" />
              </button>
            )}
          >
            {(close) => (
              <div>
                <DropdownHeader>颜色系</DropdownHeader>
                {LABEL_FAMILIES.map((f) => (
                  <DropdownItem
                    key={f}
                    selected={f === family}
                    icon={
                      <span
                        className="h-3 w-3 rounded-[3px] border"
                        style={{ background: `var(--my-label-${f}-bg)`, borderColor: `var(--my-label-${f}-border)` }}
                      />
                    }
                    onClick={() => {
                      setFamily(f)
                      close()
                    }}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </DropdownItem>
                ))}
              </div>
            )}
          </Dropdown>
          <Button variant="primary" size="sm" onClick={confirmAdd}>
            确定
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
            取消
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-3 text-[13px] text-my-secondary hover:text-my-primary"
        >
          + 添加标签
        </button>
      )}
    </>
  )
}

function ProjectFeatures({ project }: { project: Project }): JSX.Element {
  const toggle = (key: FeatureKey): void => {
    useMy.setState((s) => ({
      data: {
        ...s.data,
        projects: s.data.projects.map((p) => {
          if (p.id !== project.id) return p
          const patch: Partial<Project> = {}
          patch[key] = !p[key]
          return { ...p, ...patch }
        })
      }
    }))
  }

  return (
    <>
      <SectionTitle>Features</SectionTitle>
      <div className="my-card px-4 py-1">
        {FEATURES.map((f) => (
          <div key={f.key} className="flex items-center justify-between gap-4 border-b border-my-line py-3 last:border-b-0">
            <div className="min-w-0">
              <div className="text-[13px] text-my-primary">{f.label}</div>
              <div className="mt-0.5 text-[12px] text-my-tertiary">{f.desc}</div>
            </div>
            <Switch on={project[f.key]} onToggle={() => toggle(f.key)} />
          </div>
        ))}
      </div>
    </>
  )
}

function ProjectSettings(): JSX.Element {
  const data = useMy((s) => s.data)
  const tab = useMy((s) => s.projectSettingsTab)
  const setTab = useMy((s) => s.setProjectSettingsTab)
  const project = useProject()
  const members = data.members.filter((m) => project.memberIds.includes(m.id))
  const items: Array<{ id: MyStore['projectSettingsTab']; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'states', label: 'States' },
    { id: 'labels', label: 'Labels' },
    { id: 'members', label: 'Members' },
    { id: 'features', label: 'Features' }
  ]
  return (
    <SettingsShell items={items} activeId={tab} onSelect={setTab}>
      {/* key=项目 id：切换项目时重置表单本地状态 */}
      {tab === 'general' && <ProjectGeneral key={project.id} project={project} />}
      {tab === 'states' && <ProjectStates />}
      {tab === 'labels' && <ProjectLabels />}
      {tab === 'members' && <MemberList members={members} />}
      {tab === 'features' && <ProjectFeatures key={project.id} project={project} />}
    </SettingsShell>
  )
}

/* ---------------- 工作区设置 ---------------- */

function WorkspaceSettings(): JSX.Element {
  const workspace = useMy((s) => s.data.workspace)
  const members = useMy((s) => s.data.members)
  const tab = useMy((s) => s.workspaceSettingsTab)
  const setTab = useMy((s) => s.setWorkspaceSettingsTab)
  const [name, setName] = useState(workspace.name)
  const items: Array<{ id: MyStore['workspaceSettingsTab']; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'members', label: 'Members' }
  ]
  return (
    <SettingsShell items={items} activeId={tab} onSelect={setTab}>
      {tab === 'general' && (
        <>
          <SectionTitle>General</SectionTitle>
          <div className="flex flex-col gap-4 my-card p-4">
            <Field label="工作区名称">
              <input className="my-input" value={name} placeholder="工作区名称" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="URL Slug">
              <input
                className="my-input cursor-default"
                style={{ color: 'var(--my-txt-tertiary)' }}
                value={workspace.slug}
                readOnly
              />
            </Field>
          </div>
        </>
      )}
      {tab === 'members' && (
        <>
          <SectionTitle>Members</SectionTitle>
          <MemberList members={members} />
        </>
      )}
    </SettingsShell>
  )
}

/* ---------------- 偏好外观（Profile） ---------------- */

/** 主题卡迷你预览的静态色值（不随当前主题变化，卡片即所选项的预览） */
const THEME_PREVIEW: Record<ThemeMode, { canvas: string; panel: string; line: string; bar: string; accent: string }> = {
  light: { canvas: '#f2f2f3', panel: '#ffffff', line: '#eaebec', bar: '#dfe1e4', accent: '#006399' },
  dark: { canvas: '#0f0f10', panel: '#191b1c', line: '#222425', bar: '#2b2e2f', accent: '#2893cc' }
}

function ThemeCard({ mode, active, onSelect }: { mode: ThemeMode; active: boolean; onSelect: () => void }): JSX.Element {
  const c = THEME_PREVIEW[mode]
  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        'w-[150px] rounded-lg border border-my-line p-2 text-left transition-shadow',
        active ? 'ring-2 ring-my-accent' : 'hover:border-my-line-strong'
      )}
    >
      <div className="h-[76px] w-full overflow-hidden rounded-md border" style={{ background: c.canvas, borderColor: c.line }}>
        <div className="flex h-full gap-1.5 p-1.5">
          <div className="w-6 shrink-0 rounded-sm" style={{ background: c.panel }} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="h-2 w-3/4 rounded-sm" style={{ background: c.bar }} />
            <div className="h-2 w-1/2 rounded-sm" style={{ background: c.accent }} />
            <div className="h-2 w-2/3 rounded-sm" style={{ background: c.bar }} />
            <div className="h-2 w-1/3 rounded-sm" style={{ background: c.bar }} />
          </div>
        </div>
      </div>
      <div className={clsx('mt-1.5 flex items-center gap-1.5 text-[12px]', active ? 'text-my-primary' : 'text-my-secondary')}>
        {mode === 'light' ? 'Light' : 'Dark'}
        {active && <Check size={12} className="text-my-accent-text" />}
      </div>
    </button>
  )
}

function ProfileSettings(): JSX.Element {
  const theme = useMy((s) => s.theme)
  const setTheme = useMy((s) => s.setTheme)
  const customAccent = useMy((s) => s.customAccent)
  const setCustomAccent = useMy((s) => s.setCustomAccent)
  const data = useMy((s) => s.data)
  const me = data.members.find((m) => m.id === data.workspace.memberId) ?? data.members[0]
  return (
    <SettingsShell
      items={[{ id: 'preferences', label: 'Preferences' }]}
      activeId="preferences"
      onSelect={() => {}}
    >
      {/* 主题 */}
      <div className="mb-8">
        <SectionTitle>Theme</SectionTitle>
        <div className="flex gap-3">
          <ThemeCard mode="light" active={theme === 'light'} onSelect={() => setTheme('light')} />
          <ThemeCard mode="dark" active={theme === 'dark'} onSelect={() => setTheme('dark')} />
        </div>
      </div>
      {/* 自定义强调色 */}
      <div className="mb-8">
        <SectionTitle>Custom accent</SectionTitle>
        <div className="flex flex-wrap items-center gap-3 my-card p-4">
          {ACCENT_PRESETS.map((hex) => (
            <button
              key={hex}
              type="button"
              title={hex}
              onClick={() => setCustomAccent(hex)}
              className={clsx(
                'h-7 w-7 shrink-0 rounded-full transition-transform',
                customAccent === hex ? 'ring-2 ring-my-accent ring-offset-2 ring-offset-p-canvas' : 'hover:scale-110'
              )}
              style={{ background: hex }}
            />
          ))}
          <Button onClick={() => setCustomAccent(null)}>恢复默认</Button>
        </div>
      </div>
      {/* 账户 */}
      <div className="mb-8">
        <SectionTitle>Account</SectionTitle>
        <div className="flex items-center gap-3 my-card p-4">
          <Avatar name={me.name} color={me.avatarColor} size={44} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-my-primary">{me.name}</span>
              <span className="rounded bg-my-layer-3 px-1.5 py-0.5 text-[11px] text-my-tertiary">{me.role}</span>
            </div>
            <input
              readOnly
              value="demo@harbor.dev"
              className="mt-1 w-[220px] cursor-default border-0 bg-transparent p-0 text-[12px] text-my-tertiary outline-none"
            />
          </div>
        </div>
      </div>
      <div className="text-[12px] text-my-tertiary">偏好保存在本地 tpanel.my.ui</div>
    </SettingsShell>
  )
}

/* ---------------- 入口 ---------------- */

export function SettingsPage({ scope }: { scope: 'workspace' | 'project' | 'profile' }): JSX.Element {
  if (scope === 'project') return <ProjectSettings />
  if (scope === 'workspace') return <WorkspaceSettings />
  return <ProfileSettings />
}
