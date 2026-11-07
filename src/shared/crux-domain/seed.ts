/**
 * Crux 演示种子数据：覆盖 PRD 各模块的典型形态。
 * 时间锚定在构建日附近，保证版本/活动/收件箱在 UI 上有意义。
 */
import type {
  CruxActivity,
  CruxAgent,
  CruxAutomation,
  CruxComment,
  CruxCrew,
  CruxInboxItem,
  CruxIteration,
  CruxMember,
  CruxProject,
  CruxSkill,
  CruxSnapshot,
  CruxSpace,
  CruxTask,
  CruxTaskLabel,
  CruxTaskStatus,
  CruxTaskType,
  CruxView
} from '../crux'

const T0 = '2026-10-19T09:00:00.000Z'
const T1 = '2026-10-20T09:00:00.000Z'
const T2 = '2026-10-21T09:00:00.000Z'
const T3 = '2026-10-22T09:00:00.000Z'

/** First launch contains only a local roster identity; teams are user-created. */
export function buildInitialSnapshot(): CruxSnapshot {
  return {
    members: [{ id: 'local-owner', name: '我', role: 'owner', avatarHue: 210, joinedAt: new Date().toISOString() }],
    spaces: [], taskTypes: [], taskStatuses: [], taskLabels: [], tasks: [], comments: [],
    activities: [], projects: [], iterations: [], views: [], triageDecisions: [],
    automations: [], inbox: [], agents: [], skills: [], crews: []
  }
}

export function buildSeedSnapshot(): CruxSnapshot {
  const members: CruxMember[] = [
    { id: 'm-lin', name: '林晓', email: 'lin@demo.dev', title: '前端负责人', role: 'owner', avatarHue: 210, joinedAt: T0 },
    { id: 'm-zhao', name: '赵启', email: 'zhao@demo.dev', title: '后端工程师', role: 'admin', avatarHue: 140, joinedAt: T0 },
    { id: 'm-chen', name: '陈默', email: 'chen@demo.dev', title: '测试工程师', role: 'member', avatarHue: 30, joinedAt: T1 },
    { id: 'm-sun', name: '孙悦', email: 'sun@demo.dev', title: '产品经理', role: 'member', avatarHue: 280, joinedAt: T1 },
    { id: 'm-zhou', name: '周航', email: 'zhou@demo.dev', title: '文档维护', role: 'member', avatarHue: 340, joinedAt: T2 }
  ]

  const spaces: CruxSpace[] = [
    { id: 'sp-eng', name: '研发空间', key: 'ENG', description: '产品研发主空间：需求、缺陷与自动化流水线', multiAssignee: true, memberIds: ['m-lin', 'm-zhao', 'm-chen', 'm-sun', 'm-zhou'], taskSeq: 110, createdAt: T0 },
    { id: 'sp-ops', name: '支持空间', key: 'SUP', description: '用户反馈与支持跟进', multiAssignee: false, memberIds: ['m-sun', 'm-zhou'], taskSeq: 12, createdAt: T1 }
  ]

  const mkType = (id: string, spaceId: string, name: string, requiredHints?: string[], isDefault?: boolean): CruxTaskType =>
    ({ id, spaceId, name, requiredHints, isDefault })
  const taskTypes: CruxTaskType[] = [
    mkType('tt-req', 'sp-eng', '需求', ['背景与目标', '验收标准'], true),
    mkType('tt-bug', 'sp-eng', 'Bug', ['复现步骤', '影响范围'], false),
    mkType('tt-chore', 'sp-eng', '任务', undefined, false),
    mkType('tt-doc', 'sp-eng', '内容', undefined, false),
    mkType('tt-feedback', 'sp-ops', '用户反馈', undefined, true)
  ]

  const mkStatus = (id: string, spaceId: string, name: string, category: CruxTaskStatus['category'], order: number): CruxTaskStatus =>
    ({ id, spaceId, name, category, order })
  const engStatuses: CruxTaskStatus[] = [
    mkStatus('st-backlog', 'sp-eng', 'Backlog', 'backlog', 1),
    mkStatus('st-todo', 'sp-eng', 'Todo', 'todo', 2),
    mkStatus('st-progress', 'sp-eng', 'In Progress', 'in_progress', 3),
    mkStatus('st-review', 'sp-eng', 'In Review', 'in_review', 4),
    mkStatus('st-done', 'sp-eng', 'Done', 'done', 5),
    mkStatus('st-blocked', 'sp-eng', 'Blocked', 'blocked', 6),
    mkStatus('st-cancelled', 'sp-eng', 'Cancelled', 'cancelled', 7)
  ]
  const taskStatuses: CruxTaskStatus[] = [
    ...engStatuses,
    ...['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'].map((category, index) =>
      mkStatus(`st-sup-${category}`, 'sp-ops', ['待定', '待处理', '处理中', '待复核', '完成', '受阻', '关闭'][index], category as CruxTaskStatus['category'], index + 1)
    )
  ]

  const taskLabels: CruxTaskLabel[] = [
    { id: 'lb-fe', spaceId: 'sp-eng', name: '前端', color: '#3b82f6' },
    { id: 'lb-be', spaceId: 'sp-eng', name: '后端', color: '#10b981' },
    { id: 'lb-doc', spaceId: 'sp-eng', name: '文档', color: '#f59e0b' },
    { id: 'lb-risk', spaceId: 'sp-eng', name: '风险', color: '#ef4444' }
  ]

  const projects: CruxProject[] = [
    { id: 'pr-panel', spaceId: 'sp-eng', name: '协作面板升级', goal: '把空间、任务与 Agent 协作链路跑通并交付这一轮看板体验', status: 'active', ownerIds: ['m-lin', 'm-sun'], createdAt: T0 }
  ]

  const iterations: CruxIteration[] = [
    { id: 'it-42', spaceId: 'sp-eng', name: '版本 42（本周）', goal: '看板与任务链路可用', startDate: '2026-10-19', endDate: '2026-10-25', status: 'active', taskIds: ['ENG-101', 'ENG-103', 'ENG-105', 'ENG-106'] },
    { id: 'it-43', spaceId: 'sp-eng', name: '版本 43（下周）', goal: '自动化与分拣台完善', startDate: '2026-10-26', endDate: '2026-11-01', status: 'pending', taskIds: ['ENG-107'] }
  ]

  const mkTask = (partial: Partial<CruxTask> & Pick<CruxTask, 'id' | 'title' | 'statusId'>): CruxTask => ({
    spaceId: 'sp-eng',
    description: '',
    priority: 'medium',
    assigneeIds: [],
    labelIds: [],
    iterationIds: [],
    relations: [],
    followerIds: [],
    creatorId: 'm-lin',
    createdAt: T1,
    updatedAt: T2,
    ...partial
  })

  const tasks: CruxTask[] = [
    mkTask({
      id: 'ENG-101', title: '把任务列表空状态按钮文案从「开始」改为「开始执行」', typeId: 'tt-chore', statusId: 'st-review',
      description: '验收标准：空状态按钮文案改为「开始执行」，截图走查通过。',
      priority: 'low', assigneeIds: ['m-lin'], labelIds: ['lb-fe'], projectId: 'pr-panel', iterationIds: ['it-42'],
      followerIds: ['m-sun'], createdAt: T1, updatedAt: T3
    }),
    mkTask({
      id: 'ENG-102', title: '修复看板列宽在窄屏下挤压的问题', typeId: 'tt-bug', statusId: 'st-blocked',
      description: '复现：窗口宽度 < 1080 时第三列被压缩到 120px。\n影响：看板可读性下降。',
      priority: 'high', assigneeIds: ['m-lin', 'm-zhao'], labelIds: ['lb-fe', 'lb-risk'],
      relations: [{ kind: 'blocks', taskId: 'ENG-105' }],
      followerIds: ['m-chen'], createdAt: T1, updatedAt: T2
    }),
    mkTask({
      id: 'ENG-103', title: '调研：任务导出为 CSV 的三种实现路径', typeId: 'tt-req', statusId: 'st-progress',
      description: '对比前端生成 / 主进程生成 / CLI 三条路径，结论写回任务。',
      priority: 'medium', assigneeIds: [], executor: { kind: 'agent', id: 'ag-research', name: '调研小助手' },
      labelIds: [], projectId: 'pr-panel', iterationIds: ['it-42'],
      dispatch: { status: 'waiting_runtime', since: T2, note: '已派发给调研小助手，等待 Runtime 接入后执行' },
      followerIds: ['m-sun'], createdAt: T1, updatedAt: T2
    }),
    mkTask({
      id: 'ENG-104', title: '补充《空间与任务》用户手册章节', typeId: 'tt-doc', statusId: 'st-todo',
      description: '覆盖空间切换、任务字段与看板视图三节。',
      priority: 'low', assigneeIds: ['m-zhou'], labelIds: ['lb-doc'], followerIds: [], createdAt: T2, updatedAt: T2
    }),
    mkTask({
      id: 'ENG-105', title: '看板支持按处理人分组', typeId: 'tt-req', statusId: 'st-todo',
      description: '验收标准：分组切换即时生效，保存的视图记住分组方式。',
      priority: 'medium', assigneeIds: ['m-zhao'], labelIds: ['lb-be'], projectId: 'pr-panel', iterationIds: ['it-42'],
      relations: [{ kind: 'related', taskId: 'ENG-102' }], followerIds: ['m-lin'], createdAt: T2, updatedAt: T2
    }),
    mkTask({
      id: 'ENG-106', title: '回归：登录与新建任务主链路', typeId: 'tt-chore', statusId: 'st-progress',
      description: '跑通登录 → 建空间 → 建任务 → 指派的主链路并记录结果。',
      priority: 'medium', assigneeIds: ['m-chen'], labelIds: [], iterationIds: ['it-42'],
      followerIds: ['m-lin'], createdAt: T2, updatedAt: T3
    }),
    mkTask({
      id: 'ENG-107', title: '分拣台：每天早上汇总未分配的高优任务', typeId: 'tt-req', statusId: 'st-backlog',
      description: '把进入空间的未分配 urgent/high 任务推入分拣台，附优先级建议。',
      priority: 'none', assigneeIds: [], labelIds: [], iterationIds: ['it-43'], followerIds: [], createdAt: T3, updatedAt: T3
    }),
    mkTask({
      id: 'ENG-108', title: '子任务：看板空状态插画资源', typeId: 'tt-chore', statusId: 'st-todo',
      parentTaskId: 'ENG-101', priority: 'low', assigneeIds: ['m-sun'], labelIds: ['lb-fe'],
      followerIds: [], createdAt: T2, updatedAt: T2
    }),
    mkTask({
      id: 'ENG-109', title: '重复上报：窄屏看板错位（与 ENG-102 同源）', typeId: 'tt-bug', statusId: 'st-backlog',
      relations: [{ kind: 'duplicate', taskId: 'ENG-102' }],
      priority: 'high', assigneeIds: [], labelIds: ['lb-fe'], followerIds: [], createdAt: T3, updatedAt: T3
    }),
    mkTask({
      id: 'ENG-110', title: '清理已下线接口的调用', typeId: 'tt-chore', statusId: 'st-done',
      completedAt: T3, priority: 'low', assigneeIds: ['m-zhao'], labelIds: ['lb-be'],
      followerIds: [], createdAt: T0, updatedAt: T3
    }),
    mkTask({
      id: 'SUP-12', spaceId: 'sp-ops', title: '客户 A 反馈导出失败', typeId: 'tt-feedback', statusId: 'st-sup-in_progress',
      priority: 'high', assigneeIds: ['m-zhou'], labelIds: [], iterationIds: [], relations: [],
      followerIds: ['m-sun'], createdAt: T2, updatedAt: T3
    })
  ]

  const comments: CruxComment[] = [
    { id: 'cm-1', taskId: 'ENG-101', authorId: 'm-sun', body: '验收标准补充：按钮 hover 态同步更新。@m-lin 辛苦确认下文案。', mentions: ['m-lin'], createdAt: T2 },
    { id: 'cm-2', taskId: 'ENG-101', authorId: 'm-lin', body: '文案已确认，按「开始执行」走。', mentions: [], createdAt: T3, resolved: true },
    { id: 'cm-3', taskId: 'ENG-102', authorId: 'm-chen', body: '1080 以下必现，录屏已附在描述里。', mentions: [], createdAt: T2 },
    { id: 'cm-4', taskId: 'ENG-103', authorId: 'agent:ag-research', body: '已接收调研任务。当前等待 Runtime 接入，结论将写回本任务。', mentions: [], createdAt: T2 }
  ]

  const activities: CruxActivity[] = [
    { id: 'ac-1', taskId: 'ENG-101', kind: 'status', text: '状态从 Todo 变更为 In Review', at: T2 },
    { id: 'ac-2', taskId: 'ENG-101', kind: 'comment', text: '孙悦 评论：验收标准补充……', at: T2 },
    { id: 'ac-3', taskId: 'ENG-102', kind: 'status', text: '状态从 In Progress 变更为 Blocked', at: T2 },
    { id: 'ac-4', taskId: 'ENG-103', kind: 'dispatch', text: '指派给 Agent「调研小助手」，排队等待 Runtime', at: T2 },
    { id: 'ac-5', taskId: 'ENG-110', kind: 'status', text: '状态变更为 Done', at: T3 }
  ]

  const views: CruxView[] = [
    { id: 'vw-review', spaceId: 'sp-eng', name: '本周待评审', filter: { iterationId: 'it-42', priorities: ['urgent', 'high', 'medium'] }, groupBy: 'status', pinned: true },
    { id: 'vw-mine', spaceId: 'sp-eng', name: '我的未完成', filter: { assigneeIds: ['m-lin'] }, groupBy: 'status' }
  ]

  const agents: CruxAgent[] = [
    {
      id: 'ag-fe', spaceId: 'sp-eng', name: '前端修复', description: '承接前端缺陷：定位、修复、补回归',
      instructions: '职责：修复前端缺陷。\n动手前：复现问题并确认影响范围。\n改后：运行 lint 与相关组件测试。\n汇报：结论与验证截图写回任务评论。',
      skillIds: ['sk-commit'], repositories: [{ name: 'trellis-panel', url: 'https://example.com/trellis-panel.git' }],
      runtimeKind: 'claude-code', workingDirectory: 'temp', enabled: true, createdAt: T0
    },
    {
      id: 'ag-research', spaceId: 'sp-eng', name: '调研小助手', description: '方案调研与对比，结论写回任务',
      instructions: '职责：技术调研与方案对比。\n动手前：明确问题边界与验收标准。\n产出：结论、对比表与推荐方案写回任务描述。\n限制：不修改代码。',
      skillIds: [], repositories: [], runtimeKind: 'codex', workingDirectory: 'repo', enabled: true, createdAt: T1
    },
    {
      id: 'ag-doc', spaceId: 'sp-eng', name: '文档管家', description: '按发布节奏更新用户手册',
      instructions: '职责：跟随发布更新文档。\n改后：校对术语与链接。\n汇报：变更清单写回任务。',
      skillIds: ['sk-doc'], repositories: [], runtimeKind: 'claude-code', workingDirectory: 'repo', enabled: true, createdAt: T2
    }
  ]

  const skills: CruxSkill[] = [
    {
      id: 'sk-commit', name: '提交规范', description: '统一的分支与提交信息规范',
      content: '分支：<产品>-agent/<Agent名称>/<任务编号>。\n提交：触发人与 Agent 共同署名。\n消息格式：type(scope): 摘要（关联任务编号）。',
      createdAt: T0
    },
    {
      id: 'sk-doc', name: '文档回归清单', description: '发布前文档更新检查项',
      content: '1. 新增能力是否已入用户手册；\n2. 截图是否与当前 UI 一致；\n3. 术语表是否需要补充；\n4. 变更清单是否写回任务。',
      createdAt: T1
    }
  ]

  const crews: CruxCrew[] = [
    {
      id: 'cr-deliver', spaceId: 'sp-eng', name: '交付小队', description: '需求到验收的一站式小队',
      captain: { kind: 'agent', id: 'ag-fe', name: '前端修复' },
      members: [
        { kind: 'agent', id: 'ag-research', name: '调研小助手' },
        { kind: 'member', id: 'm-zhao', name: '赵启' },
        { kind: 'member', id: 'm-chen', name: '陈默' }
      ],
      createdAt: T2
    }
  ]

  const automations: CruxAutomation[] = [
    {
      id: 'au-morning', spaceId: 'sp-eng', name: '每早汇总受阻任务', enabled: true,
      trigger: { kind: 'schedule', value: '09:00' },
      target: { kind: 'agent', id: 'ag-research', name: '调研小助手' },
      instruction: '汇总空间内 Blocked 任务，输出阻塞原因清单。',
      projectId: 'pr-panel', lastRunAt: T3,
      runs: [
        { id: 'run-1', at: T3, trigger: 'schedule 09:00', outcome: 'waiting_runtime', detail: '目标为 Agent，已登记等待 Runtime 接入' },
        { id: 'run-2', at: T2, trigger: 'schedule 09:00', outcome: 'waiting_runtime', detail: '同上' }
      ]
    },
    {
      id: 'au-review', spaceId: 'sp-eng', name: '进入待评审时通知测试', enabled: true,
      trigger: { kind: 'task_status', value: 'st-review' },
      target: { kind: 'member', id: 'm-chen', name: '陈默' },
      instruction: '待评审任务推给测试同学复核。',
      runs: [{ id: 'run-3', at: T3, trigger: 'ENG-101 → In Review', outcome: 'done', detail: '已通知陈默并写入收件箱' }]
    }
  ]

  // 分区语义按 REA 实测：重要 = @提及/被指派/执行异常；其他 = 状态变化/自动化结果
  const inbox: CruxInboxItem[] = [
    { id: 'in-1', section: 'important', kind: 'mention', title: '孙悦 在 ENG-101 提到了你', body: '验收标准补充：按钮 hover 态同步更新。', taskId: 'ENG-101', at: T2, read: false },
    { id: 'in-2', section: 'important', kind: 'assign', title: 'ENG-102 指派给了你', body: '修复看板列宽在窄屏下挤压的问题', taskId: 'ENG-102', at: T2, read: false },
    { id: 'in-3', section: 'other', kind: 'dispatch', title: 'ENG-103 等待 Runtime', body: '已派发给调研小助手，Runtime 接入后自动执行', taskId: 'ENG-103', at: T2, read: false },
    { id: 'in-4', section: 'other', kind: 'status', title: 'ENG-106 进入 In Progress', body: '回归：登录与新建任务主链路', taskId: 'ENG-106', at: T3, read: false },
    { id: 'in-5', section: 'other', kind: 'status', title: 'ENG-101 进入 In Review', body: '把任务列表空状态按钮文案从「开始」改为「开始执行」', taskId: 'ENG-101', at: T2, read: true },
    { id: 'in-6', section: 'other', kind: 'automation', title: '自动化「每早汇总受阻任务」已运行', body: '结果：等待 Runtime 接入', at: T3, read: false },
    { id: 'in-7', section: 'other', kind: 'status', title: 'ENG-110 进入 Done', body: '清理已下线接口的调用', taskId: 'ENG-110', at: T3, read: true, cleared: true }
  ]

  return {
    spaces, members, taskTypes, taskStatuses, taskLabels, tasks, comments, activities,
    projects, iterations, views,
    triageDecisions: [
      { taskId: 'ENG-109', disposition: 'assign', at: T3, actorId: 'm-sun', note: '先归并到 ENG-102 处理' }
    ],
    automations, inbox, agents, skills, crews
  }
}
