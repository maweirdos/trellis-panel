// peek-over 工作项详情浮层：backdrop 点击关闭，中央面板（标题/描述/子工作项/评论/活动 + 右侧属性栏），Esc 关闭。
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Calendar, Check, ChevronDown, Copy, Plus, Star, X, FileText, Maximize2, ExternalLink } from 'lucide-react'
import { useMy } from '../store'
import { IssueDetailLayout } from './work-items/IssueDetailLayout'
import { useApp } from '../../store'
import { api } from '../../api'
import { useEscLayer } from '../../utils/use-esc-layer'
import { currentWeekKey, nextWeekKey } from '../isoWeek'
import { Avatar, Checkbox, Dropdown, DropdownHeader, DropdownItem, Tabs } from '../ui'
import { WorkspaceMark, PriorityIcon, StateGroupIcon } from '../icons'
import type { Issue, Label, Member, Priority, WorkItemState } from '../types'

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
  none: '无'
}

/** 属性栏右侧触发框样式 */
const BOX =
  'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-my-md border border-my-line bg-my-layer-1 px-2 text-my-sm text-my-secondary hover:bg-my-layer-1-hover'

interface PropRowProps {
  label: string
  children: ReactNode
}

/** 属性栏一行 */
function PropRow({ label, children }: PropRowProps): JSX.Element {
  return (
    <div className="mb-3">
      <div className="my-item-title mb-1">{label}</div>
      {children}
    </div>
  )
}

/** 日期属性输入 */
function DateField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }): JSX.Element {
  const theme = useMy((s) => s.theme)
  return (
    <input
      type="date"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      style={{ colorScheme: theme }}
      className="h-7 w-full rounded-my-md border border-my-line bg-my-layer-1 px-2 text-my-sm text-my-secondary outline-none focus:border-my-line-accent"
    />
  )
}

interface PeekBodyProps {
  issue: Issue
  ident: string
}

/** 面板主体（拥有本地输入态；issue.id 变化时重置） */
function PeekBody({ issue, ident }: PeekBodyProps): JSX.Element {
  const store = useMy()
  const { data, updateIssue, openIssue, closeIssue } = store
  const [name, setName] = useState(issue.name)
  const [desc, setDesc] = useState(issue.description)
  const [tab, setTab] = useState<'sub' | 'comments' | 'activity'>('sub')
  const [subName, setSubName] = useState('')
  const [comment, setComment] = useState('')
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachPath, setAttachPath] = useState('')
  const [copied, setCopied] = useState(false)

  // 切换 peek 目标时重置本地输入
  useEffect(() => {
    setName(issue.name)
    setDesc(issue.description)
    setSubName('')
    setComment('')
  }, [issue.id, issue.name, issue.description])

  // 任务文档（task 目录下的 .md）：prd/design 命名友好化，点击进入完整任务详情抽屉阅读
  const snapshotTasks = useApp((s) => s.snapshot?.tasks)
  const taskInfo = snapshotTasks?.find((t) => t.dirName === issue.id)
  const docs = (taskInfo?.artifacts ?? [])
    .filter((a) => a.kind === 'file' && a.name.toLowerCase().endsWith('.md'))
    .map((a) => ({
      name: a.name,
      label:
        a.name.toLowerCase() === 'prd.md'
          ? 'PRD'
          : a.name.toLowerCase() === 'design.md'
            ? '设计'
            : a.name.replace(/\.md$/i, '')
    }))
  const openFullDetail = (materialPath?: string): void => {
    if (!taskInfo) {
      useApp.getState().pushToast({ kind: 'info', title: '当前为演示工作项', body: '连接本机项目后，可在中央工作区阅读真实任务材料。' })
      return
    }
    const state = useApp.getState()
    state.expandTaskWorkspace({ fromPage: state.page, taskDir: issue.id, archived: false,
      scrollTop: document.querySelector<HTMLElement>('[data-page-scroll]')?.scrollTop ?? 0 }, materialPath)
    closeIssue()
  }
  // 文档绝对路径（artifacts 里的 path 就是任务目录内的文件路径）
  const docPath = (name: string): string => {
    const hit = taskInfo?.artifacts.find((a) => a.name === name)
    return hit?.path ?? name
  }

  const memberOf = (id: string | null): Member | undefined => data.members.find((m) => m.id === id)
  const stateOf = (stateId: string): WorkItemState | undefined => data.states.find((s) => s.id === stateId)
  const state = stateOf(issue.stateId)
  const assignee = memberOf(issue.assigneeId)
  const peekProject = data.projects.find((p) => p.id === issue.projectId)

  const commitName = (): void => {
    const v = name.trim()
    if (v && v !== issue.name) updateIssue(issue.id, { name: v })
    else setName(issue.name)
  }
  const commitDesc = (): void => {
    if (desc !== issue.description) updateIssue(issue.id, { description: desc })
  }

  const copyId = (): void => {
    navigator.clipboard
      .writeText(`${ident}-${issue.sequenceId}`)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => undefined)
  }

  // 资料引入（PF-07/B1）：人工选取项目内文件，复制一份进任务目录（原件不动）。
  // 走既有 docRead（项目内包含检查）+ taskWriteArtifact（任务目录写入），不建第二套资料库。
  const confirmAttach = (): void => {
    const rel = attachPath.trim().replace(/^[\\/]+|[\\/]+$/g, '')
    if (!rel) return
    const root = useApp.getState().snapshot?.meta.root
    if (!root) {
      useApp.getState().pushToast({ kind: 'warn', title: '未打开项目', body: '请先在顶栏选择项目' })
      return
    }
    const abs = `${root.replace(/[\\/]+$/, '')}/${rel.replace(/\\/g, '/')}`
    void api.docRead(abs).then((r) => {
      if (!r.ok || typeof r.content !== 'string') {
        useApp.getState().pushToast({ kind: 'error', title: '读取失败', body: r.error ?? '文件无法读取' })
        return
      }
      const base = rel.split(/[\\/]/).pop() ?? ''
      void api.taskWriteArtifact(issue.id, base, r.content).then((w) => {
        if (w.ok) {
          useApp.getState().pushToast({ kind: 'success', title: '已复制到任务资料', body: base })
          setAttachOpen(false)
          setAttachPath('')
        } else {
          useApp.getState().pushToast({ kind: 'error', title: '写入失败', body: w.error ?? '未知错误' })
        }
      })
    })
  }

  // 子工作项：回车创建真实任务并经 task.py add-subtask 持久化父子关联（B3）。
  // 关联以快照里的真实 children 为准；命令失败时如实提示，不伪造本地链接。
  const addSubIssue = (): void => {
    const n = subName.trim()
    if (!n) return
    void store.createIssue({ name: n, priority: 'none' }).then((sid) => {
      if (!sid) return
      setSubName('')
      void api.taskLinkSubtask(issue.id, sid).then((r) => {
        if (!r.ok) {
          useApp.getState().pushToast({
            kind: 'warn',
            title: '子任务已创建，关联未建立',
            body: `${r.error ?? '未知错误'}。可手动运行：python .trellis/scripts/task.py add-subtask ${issue.id} ${sid}`
          })
        }
      })
    })
  }

  // 评论：回车追加（本地视图状态；任务落盘不含评论字段）
  const addComment = (): void => {
    const body = comment.trim()
    if (!body) return
    void store.updateIssue(issue.id, {
      comments: [
        ...issue.comments,
        { id: `${issue.id}-c-${Date.now()}`, actorId: data.workspace.memberId, body, at: '刚刚' }
      ]
    })
    setComment('')
  }

  const subIssues = issue.subIssueIds
    .map((id) => data.issues.find((i) => i.id === id))
    .filter((i): i is Issue => Boolean(i))
  const projectCycles = data.cycles.filter((c) => c.projectId === issue.projectId)
  const projectModules = data.modules.filter((m) => m.projectId === issue.projectId)
  const currentCycle = projectCycles.find((c) => c.id === issue.cycleId)
  const currentModule = projectModules.find((m) => m.id === issue.moduleId)
  const issueLabels = issue.labelIds
    .map((id) => data.labels.find((l) => l.id === id))
    .filter((l): l is Label => Boolean(l))

  const toggleLabel = (labelId: string): void => {
    const has = issue.labelIds.includes(labelId)
    updateIssue(issue.id, {
      labelIds: has ? issue.labelIds.filter((x) => x !== labelId) : [...issue.labelIds, labelId]
    })
  }

  const tabs: Array<{ id: 'sub' | 'comments' | 'activity'; label: string; count?: number }> = [
    { id: 'sub', label: '子工作项', count: subIssues.length },
    { id: 'comments', label: '临时评论', count: issue.comments.length },
    { id: 'activity', label: '记录' }
  ]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="工作项快速预览"
      className="my-peek-in flex max-h-[84vh] w-[880px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-my-xl border border-my-line bg-my-layer-2 shadow-[var(--my-shadow-overlay-200)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <IssueDetailLayout
        header={<>
        <WorkspaceMark color={peekProject?.color ?? 'var(--my-avatar-bg)'} letter={peekProject?.icon ?? 'P'} size={16} />
        <span className="shrink-0 text-my-sm text-my-tertiary">
          {ident}-{issue.sequenceId}
        </span>
        <span onKeyDown={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
          <span className="flex h-6 items-center gap-1.5 px-1.5 text-my-sm text-my-secondary" title="任务阶段由 Trellis 工作流维护，面板只读">
            {state && <StateGroupIcon stateGroup={state.group} color={state.color} size={12} />}
            {state?.name ?? '未知阶段'}
          </span>
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" title="在中央任务工作区展开" onClick={() => openFullDetail()} className="my-control my-control-sm text-my-secondary hover:bg-my-layer-1-hover">
            <Maximize2 size={14} /> 展开
          </button>
          <button
            type="button"
            title={docs.length > 0 ? '查看任务文档' : '打开完整任务详情（任务目录下暂无文档）'}
            onClick={() => {
              const first = docs.find((d) => d.name.toLowerCase() === 'prd.md') ?? docs[0]
              openFullDetail(first ? docPath(first.name) : undefined)
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
          >
            <FileText size={14} />
          </button>
          <button
            type="button"
            title={store.favorites.includes(issue.id) ? '取消收藏' : '收藏'}
            onClick={() => store.toggleFavorite(issue.id)}
            className="flex h-7 w-7 items-center justify-center rounded text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
          >
            <Star size={14} className={store.favorites.includes(issue.id) ? 'fill-current text-my-warning' : ''} />
          </button>
          <button
            type="button"
            title="复制 ID"
            onClick={copyId}
            className="flex h-7 w-7 items-center justify-center rounded text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
          >
            {copied ? <Check size={14} className="text-my-success-text" /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            title="关闭"
            onClick={() => closeIssue()}
            className="flex h-7 w-7 items-center justify-center rounded text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
          >
            <X size={15} />
          </button>
        </div>
        </>}
        properties={<>
          <PropRow label="文档">
            {docs.length === 0 ? (
              <span className="text-my-xs text-my-tertiary">任务目录下暂无 .md 文档</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {docs.map((d) => (
                  <span key={d.name} className="inline-flex overflow-hidden rounded-my-sm border border-my-line bg-my-layer-1">
                    <button type="button" title={`在中央工作区阅读 ${d.name}`} onClick={() => openFullDetail(docPath(d.name))} className="flex items-center gap-1 px-1.5 py-1 text-my-xs text-my-secondary hover:bg-my-layer-1-hover hover:text-my-accent-text">
                      <FileText size={11} /> {d.label}
                    </button>
                    <button type="button" title={`在独立文档窗打开 ${d.name}`} onClick={() => {
                      void api.docOpen({ key: docPath(d.name), title: `${ident}-${issue.sequenceId} · ${d.label}`, file: docPath(d.name), theme: useMy.getState().theme })
                    }} className="border-l border-my-line px-1 text-my-secondary hover:bg-my-layer-1-hover hover:text-my-accent-text"><ExternalLink size={11} /></button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => openFullDetail()}
                  className="flex items-center gap-1 rounded-my-sm px-1 py-1 text-my-xs text-my-tertiary hover:text-my-accent-text"
                >
                  全部 ›
                </button>
              </div>
            )}
          </PropRow>
          <PropRow label="资料引入">
            {attachOpen ? (
              <div className="flex flex-col gap-1">
                <input
                  autoFocus
                  value={attachPath}
                  onChange={(e) => setAttachPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmAttach()
                  }}
                  placeholder="项目内路径，如 docs/需求摘要.md"
                  className="h-7 w-full rounded-my-sm border border-my-line bg-my-layer-1 px-2 text-my-xs text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
                />
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={confirmAttach}
                    className="rounded-my-sm bg-my-accent-subtle px-2 py-1 text-my-xs text-my-accent-text hover:bg-my-layer-1-hover"
                  >
                    复制到任务资料
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAttachOpen(false); setAttachPath('') }}
                    className="px-1 py-1 text-my-xs text-my-tertiary hover:text-my-primary"
                  >
                    取消
                  </button>
                </div>
                <p className="text-my-xs leading-4 text-my-tertiary">
                  人工选取：把项目内 md / txt / yaml / json 复制一份进任务目录，原件不动、不建第二套资料库。
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAttachOpen(true)}
                className="flex items-center gap-1 rounded-my-sm px-1 py-1 text-my-xs text-my-tertiary hover:text-my-accent-text"
              >
                <Plus size={11} /> 添加项目资料
              </button>
            )}
          </PropRow>
          <PropRow label="优先级">
            <Dropdown
              width={180}
              trigger={({ toggle }) => (
                <button type="button" onClick={toggle} className={BOX}>
                  <PriorityIcon priority={issue.priority} size={13} />
                  <span className="min-w-0 flex-1 truncate text-left">{PRIORITY_LABELS[issue.priority]}</span>
                  <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <DropdownHeader>设置优先级</DropdownHeader>
                  {PRIORITIES.map((pr) => (
                    <DropdownItem
                      key={pr}
                      selected={pr === issue.priority}
                      icon={<PriorityIcon priority={pr} size={13} />}
                      onClick={() => {
                        updateIssue(issue.id, { priority: pr })
                        close()
                      }}
                    >
                      {PRIORITY_LABELS[pr]}
                    </DropdownItem>
                  ))}
                </>
              )}
            </Dropdown>
          </PropRow>
          <PropRow label="阶段（工作流维护）">
            <div className="flex h-7 items-center gap-1.5 text-my-sm text-my-secondary">
              {state && <StateGroupIcon stateGroup={state.group} color={state.color} size={13} />}
              {state?.name ?? '未知阶段'}
            </div>
          </PropRow>
          <PropRow label="负责人">
            <Dropdown
              width={200}
              trigger={({ toggle }) => (
                <button type="button" onClick={toggle} className={BOX}>
                  {assignee ? <Avatar name={assignee.name} color={assignee.avatarColor} size={18} /> : <span className="h-[18px] w-[18px] shrink-0 rounded-full border border-dashed border-my-line-strong" />}
                  <span className="min-w-0 flex-1 truncate text-left">{assignee?.name ?? '未分配'}</span>
                  <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <DropdownItem
                    selected={issue.assigneeId === null}
                    onClick={() => {
                      updateIssue(issue.id, { assigneeId: null })
                      close()
                    }}
                  >
                    未分配
                  </DropdownItem>
                  {data.members.map((m) => (
                    <DropdownItem
                      key={m.id}
                      selected={m.id === issue.assigneeId}
                      icon={<Avatar name={m.name} color={m.avatarColor} size={16} />}
                      onClick={() => {
                        updateIssue(issue.id, { assigneeId: m.id })
                        close()
                      }}
                    >
                      {m.name}
                    </DropdownItem>
                  ))}
                </>
              )}
            </Dropdown>
          </PropRow>
          <PropRow label="周期">
            <Dropdown
              width={200}
              trigger={({ toggle }) => {
                const opts = [
                  { key: '', label: '无周期' },
                  { key: currentWeekKey(), label: `本周（${currentWeekKey()}）` },
                  { key: nextWeekKey(), label: `下周（${nextWeekKey()}）` }
                ]
                const cur = opts.find((o) => o.key === (issue.cycle ?? ''))
                return (
                  <button type="button" onClick={toggle} className={BOX}>
                    <Calendar size={13} className={issue.cycle ? 'text-my-icon-accent' : 'text-my-icon-tertiary'} />
                    <span className="min-w-0 flex-1 truncate text-left">{cur?.label ?? '无周期'}</span>
                    <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />
                  </button>
                )
              }}
            >
              {(close) => {
                const opts = [
                  { key: '', label: '无周期' },
                  { key: currentWeekKey(), label: `本周（${currentWeekKey()}）` },
                  { key: nextWeekKey(), label: `下周（${nextWeekKey()}）` }
                ]
                return (
                  <>
                    <DropdownHeader>设置周期</DropdownHeader>
                    {opts.map((o) => (
                      <DropdownItem
                        key={o.key}
                        selected={(issue.cycle ?? '') === o.key}
                        icon={<Calendar size={13} />}
                        onClick={() => {
                          void store.updateIssue(issue.id, { cycle: o.key || null })
                          close()
                        }}
                      >
                        {o.label}
                      </DropdownItem>
                    ))}
                  </>
                )
              }}
            </Dropdown>
          </PropRow>
          <PropRow label="标签">
            <Dropdown
              width={210}
              trigger={({ toggle }) => (
                <button type="button" onClick={toggle} className={clsx(BOX, issueLabels.length === 0 && 'text-my-tertiary')}>
                  {issueLabels.length === 0 ? (
                    <span className="min-w-0 flex-1 truncate text-left">无</span>
                  ) : (
                    <>
                      <span
                        className="h-2 w-2 shrink-0 rounded-my-sm"
                        style={{ background: `var(--my-label-${issueLabels[0].color}-icon)` }}
                      />
                      <span className="min-w-0 flex-1 truncate text-left">{issueLabels[0].name}</span>
                      {issueLabels.length > 1 && (
                        <span className="shrink-0 text-my-xs text-my-tertiary">+{issueLabels.length - 1}</span>
                      )}
                    </>
                  )}
                  <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <DropdownHeader>设置标签</DropdownHeader>
                  {data.labels.map((lb) => (
                    <button
                      key={lb.id}
                      type="button"
                      onClick={() => toggleLabel(lb.id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-my-layer-1-hover"
                    >
                      <Checkbox checked={issue.labelIds.includes(lb.id)} onChange={() => toggleLabel(lb.id)} />
                      <span
                        className="h-2 w-2 shrink-0 rounded-my-sm"
                        style={{ background: `var(--my-label-${lb.color}-icon)` }}
                      />
                      <span className="min-w-0 flex-1 truncate text-my-sm text-my-secondary">{lb.name}</span>
                    </button>
                  ))}
                  <div className="mt-1 border-t border-my-line pt-1">
                    <DropdownItem onClick={close}>完成</DropdownItem>
                  </div>
                </>
              )}
            </Dropdown>
          </PropRow>
          {/* 无周期数据时隐藏该属性行 */}
          {data.cycles.length > 0 && (
            <PropRow label="周期">
              <Dropdown
                width={210}
                trigger={({ toggle }) => (
                  <button type="button" onClick={toggle} className={clsx(BOX, !currentCycle && 'text-my-tertiary')}>
                    <span className="min-w-0 flex-1 truncate text-left">{currentCycle?.name ?? '无'}</span>
                    <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <DropdownItem
                      selected={issue.cycleId === null}
                      onClick={() => {
                        updateIssue(issue.id, { cycleId: null })
                        close()
                      }}
                    >
                      无
                    </DropdownItem>
                    {projectCycles.map((c) => (
                      <DropdownItem
                        key={c.id}
                        selected={c.id === issue.cycleId}
                        onClick={() => {
                          updateIssue(issue.id, { cycleId: c.id })
                          close()
                        }}
                      >
                        {c.name}
                      </DropdownItem>
                    ))}
                  </>
                )}
              </Dropdown>
            </PropRow>
          )}
          {/* 无模块数据时隐藏该属性行 */}
          {data.modules.length > 0 && (
            <PropRow label="模块">
              <Dropdown
                width={210}
                trigger={({ toggle }) => (
                  <button type="button" onClick={toggle} className={clsx(BOX, !currentModule && 'text-my-tertiary')}>
                    <span className="min-w-0 flex-1 truncate text-left">{currentModule?.name ?? '无'}</span>
                    <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <DropdownItem
                      selected={issue.moduleId === null}
                      onClick={() => {
                        updateIssue(issue.id, { moduleId: null })
                        close()
                      }}
                    >
                      无
                    </DropdownItem>
                    {projectModules.map((m) => (
                      <DropdownItem
                        key={m.id}
                        selected={m.id === issue.moduleId}
                        onClick={() => {
                          updateIssue(issue.id, { moduleId: m.id })
                          close()
                        }}
                      >
                        {m.name}
                      </DropdownItem>
                    ))}
                  </>
                )}
              </Dropdown>
            </PropRow>
          )}
          <PropRow label="开始日期">
            <DateField value={issue.startDate} onChange={(v) => updateIssue(issue.id, { startDate: v })} />
          </PropRow>
          <PropRow label="截止日期">
            <DateField value={issue.dueDate} onChange={(v) => updateIssue(issue.id, { dueDate: v })} />
          </PropRow>
        </>}
      >
          <div className="shrink-0 px-4 pb-2 pt-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              className="w-full bg-transparent text-my-lg font-semibold text-my-primary outline-none placeholder:text-my-placeholder"
              placeholder="工作项标题"
            />
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onBlur={commitDesc}
              placeholder="添加描述…"
              className="mt-2 min-h-[140px] w-full resize-none bg-transparent text-my-md leading-5 text-my-secondary outline-none placeholder:text-my-placeholder"
            />
          </div>
          <div className="shrink-0 border-b border-my-line px-4 pb-1">
            <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id)} />
          </div>
          <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {tab === 'sub' && (
              <div>
                {subIssues.map((sub) => {
                  const subState = stateOf(sub.stateId)
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => openIssue(sub.id)}
                      className="flex h-9 w-full items-center gap-2 rounded-my-md px-2 text-left hover:bg-my-layer-1"
                    >
                      {subState && <StateGroupIcon stateGroup={subState.group} color={subState.color} size={12} />}
                      <span className="w-16 shrink-0 text-my-xs text-my-tertiary">
                        {ident}-{sub.sequenceId}
                      </span>
                      <span className="my-item-title min-w-0 flex-1 truncate">{sub.name}</span>
                      <PriorityIcon priority={sub.priority} size={12} />
                    </button>
                  )
                })}
                <div className="mt-1 flex items-center gap-2 rounded-my-md px-2 py-1 hover:bg-my-layer-1">
                  <Plus size={13} className="shrink-0 text-my-icon-tertiary" />
                  <input
                    value={subName}
                    onChange={(e) => setSubName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addSubIssue()
                    }}
                    placeholder="添加子工作项"
                    className="h-7 min-w-0 flex-1 bg-transparent text-my-sm text-my-primary outline-none placeholder:text-my-placeholder"
                  />
                </div>
                <p className="mt-1 px-2 text-my-xs leading-4 text-my-tertiary">
                  回车创建真实子任务；父子关联经 task.py add-subtask 写入 task.json，失败时会明确提示。
                </p>
              </div>
            )}
            {tab === 'comments' && (
              <div>
                <p className="my-item-description mb-3">仅保留在当前界面内存中，刷新项目后会清除；不会发送给其他成员。</p>
                {issue.comments.map((c) => {
                  const actor = memberOf(c.actorId)
                  return (
                    <div key={c.id} className="flex items-start gap-2 py-2">
                      {actor ? <Avatar name={actor.name} color={actor.avatarColor} size={20} /> : <Avatar name="？" color="var(--my-avatar-bg)" size={20} />}
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-1.5">
                          <span className="my-item-title">{actor?.name ?? '未知成员'}</span>
                          <span className="text-my-xs text-my-tertiary">{c.at}</span>
                        </div>
                        <div className="whitespace-pre-wrap text-my-sm leading-5 text-my-secondary">{c.body}</div>
                      </div>
                    </div>
                  )
                })}
                <div className="mt-1 flex items-center gap-2 rounded-my-md px-2 py-1 hover:bg-my-layer-1">
                  <Avatar
                    name={memberOf(data.workspace.memberId)?.name ?? '我'}
                    color={memberOf(data.workspace.memberId)?.avatarColor ?? 'var(--my-avatar-bg)'}
                    size={20}
                  />
                  <input
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addComment()
                    }}
                    placeholder="添加临时备注，回车追加"
                    className="h-7 min-w-0 flex-1 bg-transparent text-my-sm text-my-primary outline-none placeholder:text-my-placeholder"
                  />
                </div>
              </div>
            )}
            {tab === 'activity' && (
              <div>
                {issue.activity.map((a) => {
                  const actor = memberOf(a.actorId)
                  const detailState = a.detail ? stateOf(a.detail) : undefined
                  return (
                    <div key={a.id} className="flex items-start gap-2 py-1.5">
                      {actor ? <Avatar name={actor.name} color={actor.avatarColor} size={16} /> : <Avatar name="？" color="var(--my-avatar-bg)" size={16} />}
                      <div className="min-w-0 text-my-sm leading-5 text-my-secondary">
                        <span className="font-medium text-my-primary">{actor?.name ?? '未知成员'}</span> {a.verb}
                        {detailState && (
                          <span className="ml-1 inline-flex items-center gap-1">
                            <StateGroupIcon stateGroup={detailState.group} color={detailState.color} size={11} />
                            {detailState.name}
                          </span>
                        )}
                        {!detailState && a.detail && <span className="ml-1">{a.detail}</span>}
                        <span className="ml-1.5 text-my-xs text-my-tertiary">{a.at}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
      </IssueDetailLayout>
    </div>
  )
}

/** peek 浮层入口：无 peek 目标时不渲染 */
export function IssuePeek(): JSX.Element | null {
  const peekIssueId = useMy((s) => s.peekIssueId)
  const issue = useMy((s) => (s.peekIssueId ? s.data.issues.find((i) => i.id === s.peekIssueId) : undefined))
  const projects = useMy((s) => s.data.projects)
  const closeIssue = useMy((s) => s.closeIssue)

  useEscLayer(Boolean(peekIssueId), {
    kind: 'preview',
    id: 'issue-peek',
    deferWhenInputFocused: true,
    onClose: closeIssue
  })

  if (!issue) return null
  const project = projects.find((p) => p.id === issue.projectId)
  const ident = (project?.id ?? 'p-x').replace(/^p-/, '').toUpperCase()
  return (
    <div
      className="my-fade fixed inset-0 z-[60] flex items-center justify-center bg-my-backdrop"
      onMouseDown={() => closeIssue()}
    >
      <PeekBody issue={issue} ident={ident} />
    </div>
  )
}
