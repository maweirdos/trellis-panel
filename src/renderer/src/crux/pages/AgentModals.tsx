import { useMemo, useState, type JSX } from 'react'
import {
  Bot, Check, Code2, Coffee, FolderGit2, Maximize2, Minimize2,
  Palette, Plus, Search, Users2, X
} from 'lucide-react'
import type { CruxCrewInput, CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'
import type { AcpAgentStatus } from '../../../../shared/types'
import { api, hasIpc } from '../../api'
import { Button, Modal } from '../../my/ui'
import { identityTone } from '../identity-tone'
import {
  useCollaborationPlatform,
  type AgentVisibility,
  type IsolationMode
} from '../collaboration-platform-store'
import { FlowIcon } from '../icons'
import {
  useLocalExecutionSlot,
  WORKDIR_MODE_OPTIONS
} from '../local-execution-slot'
import { RuntimePicker } from '../RuntimePicker'
import { statusOf, useCrux } from '../store'
import { inputClass, MemberChip, Select, StatusBadge, textareaClass } from '../ui'

interface ScenarioPreset {
  id: 'code' | 'daily' | 'design'
  label: string
  rolePlaceholder: string
  defaultRole: string
  runtimeKind: CruxRuntimeKind
  workingDirectory: CruxWorkingDirectoryMode
  isolationMode: IsolationMode
  instructions: string
}

const SCENARIO_PRESETS: readonly ScenarioPreset[] = [
  {
    id: 'code',
    label: '代码开发',
    rolePlaceholder: '职位或角色（如：开发）',
    defaultRole: '开发',
    runtimeKind: 'codex',
    workingDirectory: 'repo',
    isolationMode: 'worktree',
    instructions: [
      '1. 先阅读任务正文、验收标准与关联代码，确认影响范围后再动手修改。',
      '2. 优先实施最小可行变更，严格复用项目既有设计规范与目录结构。',
      '3. 修改后运行类型检查与校验命令，汇报改动清单、实测结果与潜在风险。'
    ].join('\n')
  },
  {
    id: 'daily',
    label: '日常事务',
    rolePlaceholder: '职位或角色（如：助理）',
    defaultRole: '事务助理',
    runtimeKind: 'claude-code',
    workingDirectory: 'temp',
    isolationMode: 'in_place',
    instructions: [
      '1. 快速梳理待办、任务讨论与阻塞项，提炼清晰结论与下一步责任人。',
      '2. 用简洁易懂的中文输出结构化摘要、行动清单或需求验收标准。'
    ].join('\n')
  },
  {
    id: 'design',
    label: '设计与创意',
    rolePlaceholder: '职位或角色（如：设计）',
    defaultRole: '设计',
    runtimeKind: 'claude-code',
    workingDirectory: 'repo',
    isolationMode: 'in_place',
    instructions: [
      '1. 遵循项目 DESIGN.md 与设计令牌体系，优先检查信息层级、圆角、间距与浅深色适配。',
      '2. 给出可落地的交互改进建议或样式修复方案，并覆盖空态、异常态与键盘无障碍。'
    ].join('\n')
  }
]

function scenarioIcon(id: ScenarioPreset['id']): JSX.Element {
  if (id === 'code') return <Code2 size={13} />
  if (id === 'daily') return <Coffee size={13} />
  return <Palette size={13} />
}

/**
 * 轻量居中创建 Agent 弹窗（严格遵循 Crux 表单视觉标准）：
 * - 视觉层级：标题 15px 半粗主色 > 控件值 13px 主色 > 标签 12px 次级色（微缩进对齐） > 提示 11px 弱色
 * - 空间节奏：统一 24px 水平边距、14px 字段组间距、6px 标签与控件间距
 * - 默认收起指令时一屏完整呈现，零滚动条干扰
 */
export function CreateAgentModal({
  open,
  defaultSpaceId,
  detectedRuntimes,
  machineName,
  onClose,
  onCreated
}: {
  open: boolean
  defaultSpaceId: string
  detectedRuntimes: AcpAgentStatus[]
  machineName: string
  onClose: () => void
  onCreated: (agentId: string) => void
}): JSX.Element | null {
  const { snapshot, busy, run } = useCrux()
  const setAgentSlotOverride = useLocalExecutionSlot((s) => s.setAgentOverride)
  const { customRuntimes, updateAgentMeta, recordAgentInstructionVersion } = useCollaborationPlatform()

  const [scenarioId, setScenarioId] = useState<ScenarioPreset['id']>('code')
  const [spaceId, setSpaceId] = useState(defaultSpaceId)
  const [firstName, setFirstName] = useState('')
  const [roleTitle, setRoleTitle] = useState('')
  const [visibility, setVisibility] = useState<AgentVisibility>('space')
  const [runtimeKind, setRuntimeKind] = useState<CruxRuntimeKind>('codex')
  const [runtimeId, setRuntimeId] = useState<string>('codex')
  const [customRuntimeId, setCustomRuntimeId] = useState<string | undefined>(undefined)
  const [workingDirectory, setWorkingDirectory] = useState<CruxWorkingDirectoryMode>('repo')
  const [isolationMode, setIsolationMode] = useState<IsolationMode>('worktree')
  const [instructions, setInstructions] = useState('')
  const [instructionsExpanded, setInstructionsExpanded] = useState(false)
  const [repos, setRepos] = useState<string[]>([])
  const [addingRepo, setAddingRepo] = useState(false)
  const [repoDraft, setRepoDraft] = useState('')

  if (!open || !snapshot) return null

  const activeSpaces = snapshot.spaces.filter((s) => !s.archived)
  const currentScenario = SCENARIO_PRESETS.find((item) => item.id === scenarioId) ?? SCENARIO_PRESETS[0]
  const previewName = firstName.trim() || 'Athena'

  const selectScenario = (preset: ScenarioPreset): void => {
    setScenarioId(preset.id)
    setRuntimeKind(preset.runtimeKind)
    setRuntimeId(preset.runtimeKind === 'custom' ? 'pi' : preset.runtimeKind)
    setCustomRuntimeId(undefined)
    setWorkingDirectory(preset.workingDirectory)
    setIsolationMode(preset.isolationMode)
    if (!roleTitle.trim() || SCENARIO_PRESETS.some((p) => p.defaultRole === roleTitle.trim())) {
      setRoleTitle(preset.defaultRole)
    }
    if (!instructions.trim() || SCENARIO_PRESETS.some((p) => p.instructions === instructions.trim())) {
      setInstructions(preset.instructions)
    }
  }

  const pickRepoFolder = async (): Promise<void> => {
    if (!hasIpc) return
    const picked = await api.pickProject()
    if (!picked) return
    const trimmed = picked.trim()
    if (trimmed && !repos.includes(trimmed)) {
      setRepos((prev) => [...prev, trimmed])
      setWorkingDirectory('repo')
    }
  }

  const commitRepoDraft = (): void => {
    const trimmed = repoDraft.trim()
    if (trimmed && !repos.includes(trimmed)) {
      setRepos((prev) => [...prev, trimmed])
      setWorkingDirectory('repo')
    }
    setRepoDraft('')
    setAddingRepo(false)
  }

  const submit = async (): Promise<void> => {
    const name = firstName.trim()
    if (!name || busy) return
    const desc = roleTitle.trim() || currentScenario.defaultRole
    const finalInstructions = instructions.trim() || currentScenario.instructions
    const res = await run('创建 Agent', () => api.crux.saveAgent({
      spaceId,
      name,
      description: desc || undefined,
      instructions: finalInstructions,
      skillIds: [],
      repositories: repos.map((r) => ({ name: r })),
      runtimeKind,
      workingDirectory,
      enabled: true,
      archived: false
    }))
    if (res?.ok) {
      const created = [...res.data.agents].reverse().find((a) => a.spaceId === spaceId && a.name === name)
      if (created) {
        updateAgentMeta(created.id, { visibility, isolationMode, customRuntimeId })
        setAgentSlotOverride(created.id, { runtimeKind, runtimeId, workingDirectory })
        if (finalInstructions) recordAgentInstructionVersion(created.id, finalInstructions, '初始创建')
        onCreated(created.id)
      } else {
        onClose()
      }
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={540} placement="center" ariaLabel="创建 Agent">
      <div className="flex max-h-[var(--my-modal-max-height)] flex-col bg-my-canvas">
        <header className="flex shrink-0 items-center justify-between px-6 pt-5 pb-2">
          <h2 className="text-my-md font-semibold text-my-primary">创建 Agent</h2>
          <button
            type="button"
            aria-label="关闭弹窗"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1 hover:text-my-primary"
          >
            <X size={15} />
          </button>
        </header>

        <div className="collab-scroll collab-form min-h-0 flex-1 px-6 pt-2 pb-4">
          {/* 顶部头像 + 3 场景预设胶囊 */}
          <div className="flex flex-col items-center gap-2.5 pb-1">
            <span
              className="collab-tone-avatar grid h-12 w-12 place-items-center rounded-full"
              data-tone={identityTone(previewName)}
            >
              <Bot size={22} />
            </span>
            <div className="flex flex-wrap items-center justify-center gap-2" role="group" aria-label="选择工作场景">
              {SCENARIO_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={scenarioId === preset.id}
                  onClick={() => selectScenario(preset)}
                  className="collab-scenario-pill"
                >
                  {scenarioIcon(preset.id)}
                  <span>{preset.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 名称 - 职位或角色 */}
          <div className="collab-form-field">
            <span className="collab-form-label">名称</span>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                className={`${inputClass} flex-1`}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="如：Athena / 流川枫"
                aria-label="Agent 名称"
              />
              <span className="shrink-0 text-my-xs text-my-tertiary">-</span>
              <input
                className={`${inputClass} flex-1`}
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                placeholder={currentScenario.rolePlaceholder}
                aria-label="职位或角色"
              />
            </div>
          </div>

          {/* 所属空间 | 可见性 */}
          <div className="collab-form-grid-2">
            <div className="collab-form-field">
              <span className="collab-form-label">所属空间</span>
              <Select
                className="w-full"
                value={spaceId}
                onChange={setSpaceId}
                options={activeSpaces.map((s) => ({ value: s.id, label: s.name }))}
              />
            </div>
            <div className="collab-form-field">
              <span className="collab-form-label">可见性</span>
              <Select
                className="w-full"
                value={visibility}
                onChange={(v) => setVisibility(v as AgentVisibility)}
                options={[
                  { value: 'space', label: '公开（空间共享）' },
                  { value: 'personal', label: '私有（仅自己）' }
                ]}
              />
            </div>
          </div>

          {/* Runtime（带真实品牌图标的分组选择器） */}
          <div className="collab-form-field">
            <span className="collab-form-label">Runtime</span>
            <RuntimePicker
              fullWidth
              valueKind={runtimeKind}
              valueRuntimeId={runtimeId}
              customRuntimeId={customRuntimeId}
              detectedRuntimes={detectedRuntimes}
              customRuntimes={customRuntimes}
              machineName={machineName}
              onSelect={(next) => {
                setRuntimeKind(next.runtimeKind)
                setRuntimeId(next.runtimeId)
                setCustomRuntimeId(next.customRuntimeId)
              }}
            />
          </div>

          {/* Agent 指令（默认 1 行收起，避免撑出滚动条） */}
          <div className="collab-form-field">
            <span className="collab-form-label">Agent 指令</span>
            {instructionsExpanded ? (
              <div className="rounded-my-base border border-my-line bg-my-panel p-2.5">
                <div className="mb-1.5 flex items-center justify-between text-my-2xs text-my-tertiary">
                  <span>设定此 Agent 的职责、边界与验收标准</span>
                  <button
                    type="button"
                    onClick={() => setInstructionsExpanded(false)}
                    className="inline-flex items-center gap-1 text-my-secondary hover:text-my-primary"
                  >
                    <Minimize2 size={12} />收起
                  </button>
                </div>
                <textarea
                  className={`${textareaClass} font-mono text-my-xs`}
                  rows={4}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={currentScenario.instructions}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setInstructionsExpanded(true)}
                className="flex w-full items-center justify-between rounded-my-base border border-my-line bg-my-panel px-3 py-2 text-left text-my-xs text-my-tertiary transition-colors hover:border-my-line-strong hover:text-my-primary"
              >
                <span className="truncate">
                  {instructions.trim()
                    ? `已配置自定义指令（${instructions.trim().length} 字）`
                    : '点击配置指令，可选（默认套用所选场景模板）'}
                </span>
                <Maximize2 size={13} className="ml-2 shrink-0" />
              </button>
            )}
          </div>

          {/* 工作方式 + 附加 Git 仓库 */}
          <div className="collab-form-field">
            <span className="collab-form-label">工作方式</span>
            <Select
              className="w-full"
              value={workingDirectory}
              onChange={(v) => setWorkingDirectory(v as CruxWorkingDirectoryMode)}
              options={[...WORKDIR_MODE_OPTIONS]}
            />

            {repos.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {repos.map((repo) => (
                  <span
                    key={repo}
                    className="inline-flex items-center gap-1.5 rounded-my-base border border-my-line bg-my-panel px-2.5 py-1 text-my-xs text-my-secondary"
                  >
                    <FolderGit2 size={12} />
                    <span className="max-w-[260px] truncate font-mono text-my-2xs">{repo}</span>
                    <button
                      type="button"
                      aria-label={`移除仓库 ${repo}`}
                      onClick={() => setRepos((prev) => prev.filter((item) => item !== repo))}
                      className="text-my-tertiary hover:text-my-danger-text"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {addingRepo ? (
              <div className="flex items-center gap-2 pt-1">
                <input
                  autoFocus
                  className={`${inputClass} flex-1 font-mono text-my-xs`}
                  value={repoDraft}
                  onChange={(e) => setRepoDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRepoDraft()
                    if (e.key === 'Escape') { setRepoDraft(''); setAddingRepo(false) }
                  }}
                  placeholder="输入仓库名或本地路径，如 trellis-panel"
                />
                <Button size="sm" variant="outline" onClick={commitRepoDraft}>确定</Button>
                <Button size="sm" variant="ghost" onClick={() => { setRepoDraft(''); setAddingRepo(false) }}>取消</Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <Button size="sm" variant="ghost" onClick={() => setAddingRepo(true)}>
                  <Plus size={13} />附加 Git 仓库
                </Button>
                {hasIpc && (
                  <Button size="sm" variant="ghost" onClick={() => void pickRepoFolder()}>
                    <FolderGit2 size={13} />选择本机目录
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-my-line px-6 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" disabled={!firstName.trim() || busy} onClick={() => void submit()}>
            创建
          </Button>
        </footer>
      </div>
    </Modal>
  )
}

/**
 * 轻量居中创建小队弹窗（套用统一 Crux 表单标准）。
 */
export function CreateCrewModal({
  open,
  defaultSpaceId,
  onClose,
  onCreated
}: {
  open: boolean
  defaultSpaceId: string
  onClose: () => void
  onCreated: (crewId: string) => void
}): JSX.Element | null {
  const { snapshot, busy, run } = useCrux()
  const [spaceId, setSpaceId] = useState(defaultSpaceId)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [captainVal, setCaptainVal] = useState('')
  const [memberRefs, setMemberRefs] = useState<CruxCrewInput['memberRefs']>([])

  if (!open || !snapshot) return null
  const activeSpaces = snapshot.spaces.filter((s) => !s.archived)
  const space = snapshot.spaces.find((s) => s.id === spaceId)
  const agents = snapshot.agents.filter((a) => a.spaceId === spaceId && !a.archived && a.enabled)
  const people = snapshot.members.filter((m) => space?.memberIds.includes(m.id))

  const toggleMember = (kind: 'agent' | 'member', id: string): void => {
    setMemberRefs((prev) =>
      prev.some((r) => r.kind === kind && r.id === id)
        ? prev.filter((r) => !(r.kind === kind && r.id === id))
        : [...prev, { kind, id }]
    )
  }

  const submit = async (): Promise<void> => {
    if (!name.trim() || !captainVal || busy) return
    const [capKind, capId] = captainVal.split(':') as ['agent' | 'member', string]
    const allRefs = memberRefs.some((r) => r.kind === capKind && r.id === capId)
      ? memberRefs
      : [{ kind: capKind, id: capId }, ...memberRefs]
    const res = await run('创建小队', () => api.crux.saveCrew({
      spaceId,
      name: name.trim(),
      description: description.trim() || undefined,
      instructions: '',
      ownerId: capKind === 'member' ? capId : null,
      ...(capKind === 'member' ? { captainMemberId: capId } : { captainAgentId: capId }),
      memberRefs: allRefs
    }))
    if (res?.ok) {
      const created = [...res.data.crews].reverse().find((c) => c.spaceId === spaceId && c.name === name.trim())
      if (created) onCreated(created.id)
      else onClose()
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={500} placement="center" ariaLabel="创建小队">
      <div className="flex max-h-[var(--my-modal-max-height)] flex-col bg-my-canvas">
        <header className="flex shrink-0 items-center justify-between px-6 pt-5 pb-2">
          <h2 className="text-my-md font-semibold text-my-primary">创建小队</h2>
          <button
            type="button"
            aria-label="关闭弹窗"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1 hover:text-my-primary"
          >
            <X size={15} />
          </button>
        </header>

        <div className="collab-scroll collab-form min-h-0 flex-1 px-6 pt-2 pb-4">
          <div className="flex justify-center pb-1">
            <span
              className="collab-tone-avatar grid h-12 w-12 place-items-center rounded-full"
              data-tone={identityTone(name.trim() || 'crew')}
            >
              <Users2 size={22} />
            </span>
          </div>

          <div className="collab-form-field">
            <span className="collab-form-label">名称</span>
            <input
              autoFocus
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：前端交付小队"
            />
          </div>

          <div className="collab-form-field">
            <span className="collab-form-label">描述</span>
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="这支小队协同处理什么工作？（可选）"
            />
          </div>

          <div className="collab-form-grid-2">
            <div className="collab-form-field">
              <span className="collab-form-label">所属空间</span>
              <Select
                className="w-full"
                value={spaceId}
                onChange={(v) => { setSpaceId(v); setCaptainVal(''); setMemberRefs([]) }}
                options={activeSpaces.map((s) => ({ value: s.id, label: s.name }))}
              />
            </div>
            <div className="collab-form-field">
              <span className="collab-form-label">队长</span>
              <Select
                className="w-full"
                value={captainVal}
                onChange={setCaptainVal}
                options={[
                  { value: '', label: '选择小队队长…' },
                  ...agents.map((a) => ({ value: `agent:${a.id}`, label: `Agent · ${a.name}` })),
                  ...people.map((m) => ({ value: `member:${m.id}`, label: `成员 · ${m.name}` }))
                ]}
              />
            </div>
          </div>

          <div className="collab-form-field">
            <span className="collab-form-label">成员</span>
            <div className="collab-scroll max-h-40 space-y-1.5">
              {agents.map((a) => {
                const isCaptain = captainVal === `agent:${a.id}`
                const checked = isCaptain || memberRefs.some((r) => r.kind === 'agent' && r.id === a.id)
                return (
                  <label key={a.id} className="flex cursor-pointer items-center justify-between rounded-my-base border border-my-line bg-my-panel px-3 py-2 text-my-xs hover:border-my-line-strong">
                    <span className="inline-flex items-center gap-2 text-my-primary">
                      <input type="checkbox" checked={checked} disabled={isCaptain} onChange={() => toggleMember('agent', a.id)} />
                      <Bot size={13} className="text-my-secondary" />
                      <span>{a.name}</span>
                    </span>
                    {isCaptain && <span className="my-chip">队长</span>}
                  </label>
                )
              })}
              {people.map((m) => {
                const isCaptain = captainVal === `member:${m.id}`
                const checked = isCaptain || memberRefs.some((r) => r.kind === 'member' && r.id === m.id)
                return (
                  <label key={m.id} className="flex cursor-pointer items-center justify-between rounded-my-base border border-my-line bg-my-panel px-3 py-2 text-my-xs hover:border-my-line-strong">
                    <span className="inline-flex items-center gap-2 text-my-primary">
                      <input type="checkbox" checked={checked} disabled={isCaptain} onChange={() => toggleMember('member', m.id)} />
                      <MemberChip member={m} size="sm" />
                      <span>{m.name}</span>
                    </span>
                    {isCaptain && <span className="my-chip">队长</span>}
                  </label>
                )
              })}
            </div>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-my-line px-6 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" disabled={!name.trim() || !captainVal || busy} onClick={() => void submit()}>
            创建
          </Button>
        </footer>
      </div>
    </Modal>
  )
}

/**
 * 居中 Spotlight 式「创建或指派任务」弹窗。
 */
export function AssignTaskModal({
  open,
  target,
  onClose,
  onCreateNewTask,
  onDelegateTask
}: {
  open: boolean
  target: { kind: 'agent' | 'crew'; id: string; name: string; spaceId: string } | null
  onClose: () => void
  onCreateNewTask: () => void
  onDelegateTask: (taskId: string) => void
}): JSX.Element | null {
  const { snapshot } = useCrux()
  const [query, setQuery] = useState('')

  const tasks = useMemo(() => {
    if (!snapshot || !target) return []
    const q = query.trim().toLowerCase()
    return snapshot.tasks
      .filter((t) => t.spaceId === target.spaceId)
      .filter((t) => !q || `${t.id} ${t.title}`.toLowerCase().includes(q))
      .slice(0, 12)
  }, [snapshot, target, query])

  if (!open || !target || !snapshot) return null

  return (
    <Modal open={open} onClose={onClose} width={520} placement="center" ariaLabel={`指派任务给 ${target.name}`}>
      <div className="flex max-h-[var(--my-modal-max-height)] flex-col bg-my-canvas">
        <header className="flex shrink-0 items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-my-md font-semibold text-my-primary">为 {target.name} 安排任务</h2>
          <button
            type="button"
            aria-label="关闭弹窗"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1 hover:text-my-primary"
          >
            <X size={15} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-5">
          <Button
            size="md"
            variant="primary"
            className="w-full justify-center"
            onClick={() => {
              onClose()
              onCreateNewTask()
            }}
          >
            <Plus size={15} />新建任务
          </Button>

          <div className="flex items-center gap-2 pt-1 text-my-2xs text-my-tertiary">
            <span className="h-px flex-1 bg-my-line" />
            <span>或指派已有任务</span>
            <span className="h-px flex-1 bg-my-line" />
          </div>

          <div className="relative">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-my-tertiary" />
            <input
              autoFocus
              className={`${inputClass} pl-8`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索任务编号或标题…"
              aria-label="搜索任务"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="collab-form-label">{query.trim() ? `匹配任务 (${tasks.length})` : '最近任务'}</span>
            <div className="collab-scroll max-h-60 space-y-1">
              {tasks.length === 0 ? (
                <div className="rounded-my-base border border-dashed border-my-line py-8 text-center text-my-xs text-my-tertiary">
                  当前空间没有匹配的任务，可直接点击上方「新建任务」
                </div>
              ) : (
                tasks.map((task) => {
                  const alreadyAssigned = task.executor?.kind === target.kind && task.executor.id === target.id
                  const firstAssigneeId = task.assigneeIds[0]
                  const assignee = firstAssigneeId ? snapshot.members.find((m) => m.id === firstAssigneeId) : undefined
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => {
                        onDelegateTask(task.id)
                        onClose()
                      }}
                      className="flex w-full items-center gap-2.5 rounded-my-base border border-transparent px-2.5 py-2 text-left transition-colors hover:border-my-line hover:bg-my-panel"
                    >
                      <FlowIcon name="tasks" size={14} className="shrink-0 text-my-icon-secondary" />
                      <span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{task.id}</span>
                      <span className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-primary">{task.title}</span>
                      <StatusBadge status={statusOf(snapshot, task.statusId)} />
                      {assignee && <MemberChip member={assignee} size="sm" />}
                      {alreadyAssigned && <Check size={13} className="shrink-0 text-my-success-text" />}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
