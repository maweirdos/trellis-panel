// 内置示例数据：仅无快照的预览路径使用。日期相对"今天"生成，保证视图始终有内容。
import type {
  Cycle,
  IntakeIssue,
  Issue,
  Label,
  Member,
  Module,
  NotificationItem,
  PageDoc,
  MyDataset,
  Priority,
  Project,
  SavedView,
  WorkItemState
} from './types'

const pad = (n: number): string => String(n).padStart(2, '0')

function dayDate(offset: number): Date {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + offset)
  return d
}

function isoWeekKeyOf(d: Date): string {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  c.setDate(c.getDate() + 3 - ((c.getDay() + 6) % 7))
  const week1 = new Date(c.getFullYear(), 0, 4)
  week1.setDate(week1.getDate() + 3 - ((week1.getDay() + 6) % 7))
  const week = 1 + Math.round((c.getTime() - week1.getTime()) / (7 * 24 * 3600 * 1000))
  return `${c.getFullYear()}-W${String(week).padStart(2, '0')}`
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 相对今天的日期（offset 为天数，可为负） */
function day(offset: number): string {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + offset)
  return iso(d)
}

const MEMBERS: Member[] = [
  { id: 'me', name: '我', avatarColor: '#059669', role: 'Admin' },
  { id: 'u2', name: '陈曦', avatarColor: '#7e22ce', role: 'Member' },
  { id: 'u3', name: '林远', avatarColor: '#c2410c', role: 'Member' },
  { id: 'u4', name: '苏澜', avatarColor: '#15803d', role: 'Member' },
  { id: 'u5', name: '祁风', avatarColor: '#b91c1c', role: 'Guest' }
]

const DEFAULT_STATES: WorkItemState[] = [
  { id: 'st-backlog', name: '未规划', color: '#A3A3A3', group: 'backlog', sequence: 15000 },
  { id: 'st-todo', name: '待办', color: '#3A3A3A', group: 'unstarted', sequence: 25000 },
  { id: 'st-progress', name: '进行中', color: '#F59E0B', group: 'started', sequence: 35000 },
  { id: 'st-done', name: '已完成', color: '#16A34A', group: 'completed', sequence: 45000 },
  { id: 'st-cancel', name: '已取消', color: '#EF4444', group: 'cancelled', sequence: 55000 }
]

const LABELS: Label[] = [
  { id: 'lb-fe', name: '前端', color: 'indigo' },
  { id: 'lb-be', name: '后端', color: 'emerald' },
  { id: 'lb-design', name: '设计', color: 'pink' },
  { id: 'lb-bug', name: '缺陷', color: 'crimson' },
  { id: 'lb-perf', name: '性能', color: 'orange' },
  { id: 'lb-doc', name: '文档', color: 'grey' },
  { id: 'lb-urgent-fix', name: '紧急修复', color: 'yellow' },
  { id: 'lb-infra', name: '基础设施', color: 'purple' }
]

const PROJECTS: Project[] = [
  {
    id: 'p-web',
    name: '网站改版',
    icon: '网',
    color: '#059669',
    description: '官网视觉与信息架构升级，统一设计语言。',
    cycleEnabled: true,
    moduleEnabled: true,
    pagesEnabled: true,
    intakeEnabled: true,
    memberIds: ['me', 'u2', 'u3', 'u4'],
    leadId: 'me',
    favorite: true,
    createdAt: day(-120)
  },
  {
    id: 'p-app',
    name: '移动端 App',
    icon: '移',
    color: '#7e22ce',
    description: 'iOS / Android 双端客户端，2.0 大版本。',
    cycleEnabled: true,
    moduleEnabled: true,
    pagesEnabled: true,
    intakeEnabled: true,
    memberIds: ['me', 'u2', 'u4', 'u5'],
    leadId: 'u2',
    favorite: true,
    createdAt: day(-90)
  },
  {
    id: 'p-data',
    name: '数据平台',
    icon: '数',
    color: '#c2410c',
    description: '指标仓库与自助分析，服务增长与运营。',
    cycleEnabled: true,
    moduleEnabled: true,
    pagesEnabled: false,
    intakeEnabled: false,
    memberIds: ['me', 'u3', 'u4'],
    leadId: 'u3',
    favorite: false,
    createdAt: day(-60)
  }
]

interface Seed {
  t: string
  pr: Priority
  st: string
  as: string | null
  lb: string[]
  off: [number, number] // [startOffset, dueOffset]
  par?: boolean // 有子工作项
  cyc?: string
  mod?: string
  desc?: string
}

const SEEDS: Record<string, Seed[]> = {
  'p-web': [
    { t: '首页 Hero 区支持暗色模式自适应', pr: 'high', st: 'st-done', as: 'u2', lb: ['lb-fe', 'lb-design'], off: [-30, -12], cyc: 'c-web-2', mod: 'm-web-brand' },
    { t: '导航栏信息架构重组（三栏→两栏）', pr: 'urgent', st: 'st-progress', as: 'me', lb: ['lb-design'], off: [-8, 4], cyc: 'c-web-3', mod: 'm-web-brand', par: true },
    { t: '产品页落地模板组件化', pr: 'medium', st: 'st-progress', as: 'u3', lb: ['lb-fe'], off: [-5, 7], cyc: 'c-web-3', mod: 'm-web-content' },
    { t: 'SEO 元信息批量治理', pr: 'low', st: 'st-todo', as: null, lb: ['lb-doc'], off: [2, 14], cyc: 'c-web-3', mod: 'm-web-content' },
    { t: '多语言路由与前缀规范化', pr: 'medium', st: 'st-todo', as: 'u2', lb: ['lb-fe'], off: [3, 18], mod: 'm-web-infra' },
    { t: '首页 LCP 优化到 2s 内', pr: 'high', st: 'st-backlog', as: 'u3', lb: ['lb-perf'], off: [10, 30], mod: 'm-web-infra' },
    { t: '字体子集化与预加载策略', pr: 'low', st: 'st-backlog', as: null, lb: ['lb-perf'], off: [12, 32], mod: 'm-web-infra' },
    { t: '客户案例页数据接入 CMS', pr: 'medium', st: 'st-done', as: 'u4', lb: ['lb-be'], off: [-24, -9], cyc: 'c-web-2', mod: 'm-web-content' },
    { t: '深色模式对比度不达标（正文 #999）', pr: 'high', st: 'st-progress', as: 'u2', lb: ['lb-bug', 'lb-design'], off: [-3, 2], cyc: 'c-web-3' },
    { t: '页脚法律链接 404', pr: 'none', st: 'st-cancel', as: 'u4', lb: ['lb-bug'], off: [-20, -15] },
    { t: '博客代码块增加一键复制', pr: 'low', st: 'st-done', as: 'me', lb: ['lb-fe'], off: [-16, -6], cyc: 'c-web-2' },
    { t: '联系表单接入反垃圾服务', pr: 'medium', st: 'st-backlog', as: null, lb: ['lb-be', 'lb-infra'], off: [8, 25] },
    { t: '导航下拉在触屏上误触', pr: 'medium', st: 'st-todo', as: 'u3', lb: ['lb-bug', 'lb-fe'], off: [-1, 9], cyc: 'c-web-3' }
  ],
  'p-app': [
    { t: '2.0 新视觉走查清单', pr: 'high', st: 'st-progress', as: 'u2', lb: ['lb-design'], off: [-6, 6], cyc: 'c-app-1', mod: 'm-app-ui' },
    { t: '启动页冷启动时间优化', pr: 'urgent', st: 'st-progress', as: 'u4', lb: ['lb-perf'], off: [-7, 3], cyc: 'c-app-1', mod: 'm-app-perf', par: true },
    { t: '离线缓存层设计与落地', pr: 'high', st: 'st-todo', as: 'me', lb: ['lb-be', 'lb-infra'], off: [1, 20], mod: 'm-app-sync' },
    { t: '推送通知支持富媒体', pr: 'medium', st: 'st-backlog', as: null, lb: ['lb-fe'], off: [5, 26], mod: 'm-app-ui' },
    { t: 'Android 15 边缘手势兼容', pr: 'medium', st: 'st-todo', as: 'u5', lb: ['lb-bug', 'lb-fe'], off: [0, 12], cyc: 'c-app-1' },
    { t: '登录页验证码通道超时', pr: 'urgent', st: 'st-done', as: 'u4', lb: ['lb-bug', 'lb-be'], off: [-14, -8], cyc: 'c-app-0' },
    { t: '深链路由统一 Scheme', pr: 'medium', st: 'st-backlog', as: 'u2', lb: ['lb-infra'], off: [9, 28], mod: 'm-app-sync' },
    { t: '相册批量上传断点续传', pr: 'high', st: 'st-progress', as: 'me', lb: ['lb-fe', 'lb-perf'], off: [-4, 8], cyc: 'c-app-1', mod: 'm-app-sync' },
    { t: '低端机型内存告警埋点', pr: 'low', st: 'st-backlog', as: null, lb: ['lb-perf'], off: [14, 34], mod: 'm-app-perf' },
    { t: '引导页文案本地化（繁体）', pr: 'none', st: 'st-todo', as: 'u5', lb: ['lb-doc'], off: [4, 16] },
    { t: 'iOS 侧滑返回与手势冲突', pr: 'high', st: 'st-done', as: 'u2', lb: ['lb-bug'], off: [-18, -10], cyc: 'c-app-0' },
    { t: '深色主题下状态栏图标色错误', pr: 'medium', st: 'st-progress', as: 'u5', lb: ['lb-bug', 'lb-design'], off: [-2, 5], cyc: 'c-app-1', mod: 'm-app-ui' }
  ],
  'p-data': [
    { t: '指标口径字典 v1 发布', pr: 'high', st: 'st-progress', as: 'u3', lb: ['lb-doc', 'lb-be'], off: [-9, 6], cyc: 'c-data-1', mod: 'm-data-metric' },
    { t: '事件埋点 Schema 校验服务', pr: 'high', st: 'st-todo', as: 'u4', lb: ['lb-be'], off: [2, 15], mod: 'm-data-collect', par: true },
    { t: '自助看板权限模型', pr: 'medium', st: 'st-backlog', as: null, lb: ['lb-be', 'lb-infra'], off: [7, 24], mod: 'm-data-bi' },
    { t: 'ETL 任务失败自动重试', pr: 'high', st: 'st-done', as: 'u3', lb: ['lb-infra'], off: [-22, -11], cyc: 'c-data-0' },
    { t: '日活看板加载超 30s', pr: 'urgent', st: 'st-progress', as: 'u4', lb: ['lb-bug', 'lb-perf'], off: [-4, 1], cyc: 'c-data-1', mod: 'm-data-bi' },
    { t: '归档冷数据迁移 S3', pr: 'low', st: 'st-backlog', as: null, lb: ['lb-infra'], off: [15, 40], mod: 'm-data-collect' },
    { t: '留存分析漏斗组件', pr: 'medium', st: 'st-todo', as: 'me', lb: ['lb-fe', 'lb-be'], off: [3, 17], cyc: 'c-data-1', mod: 'm-data-bi' },
    { t: '埋点字段命名规范评审', pr: 'none', st: 'st-done', as: 'u3', lb: ['lb-doc'], off: [-15, -7], cyc: 'c-data-0' },
    { t: '数据漂移监控告警', pr: 'medium', st: 'st-backlog', as: 'u4', lb: ['lb-infra'], off: [6, 22], mod: 'm-data-collect' }
  ]
}

const PARENT_TITLES: Record<string, string> = {
  'p-web-2': '二级导航吸顶与滚动手感',
  'p-app-2': '图片压缩管线（上传前本地压缩）',
  'p-data-2': 'Schema 校验规则引擎'
}

function buildIssues(): Issue[] {
  const issues: Issue[] = []
  const counters: Record<string, number> = {}
  let idSeq = 0

  for (const [projectId, seeds] of Object.entries(SEEDS)) {
    for (const s of seeds) {
      idSeq += 1
      counters[projectId] = (counters[projectId] ?? 0) + 1
      const id = `${projectId}-${idSeq}`
      issues.push({
        id,
        projectId,
        sequenceId: counters[projectId],
        name: s.t,
        description:
          s.desc ??
          `${s.t}。\n\n验收要点：\n- 覆盖浅色 / 深色两套主题\n- 关键路径回归通过\n- 相关文档同步更新`,
        stateId: s.st,
        priority: s.pr,
        assigneeId: s.as,
        labelIds: s.lb,
        cycleId: s.cyc ?? null,
        moduleId: s.mod ?? null,
        cycle: isoWeekKeyOf(dayDate(Math.max(s.off[0], -6))),
        pkg: s.lb.includes('lb-fe')
          ? '渲染层'
          : s.lb.includes('lb-be')
            ? '服务端'
            : s.lb.includes('lb-infra')
              ? '基础设施'
              : s.lb.includes('lb-design')
                ? '设计'
                : '通用',
        scope: null,
        startDate: day(s.off[0]),
        dueDate: day(s.off[1]),
        createdAt: day(s.off[0] - 5),
        parentId: null,
        subIssueIds: [],
        activity: [
          { id: `${id}-a1`, actorId: 'me', verb: '创建了工作项', at: day(s.off[0] - 5) },
          { id: `${id}-a2`, actorId: s.as ?? 'u2', verb: '将状态改为', detail: s.st, at: day(Math.max(s.off[0] - 2, -60)) }
        ],
        comments:
          idSeq % 4 === 1
            ? [
                { id: `${id}-c1`, actorId: 'u3', body: '这块我补了一版设计标注，可以按最新稿来。', at: day(-2) },
                { id: `${id}-c2`, actorId: 'me', body: '收到，先按新稿实现，周四前提测。', at: day(-1) }
              ]
            : [],
        completedAt: s.st === 'st-done' ? day(s.off[1]) : null
      })
    }
  }

  // 为 par 的三条父工作项造子工作项
  let subSeq = 100
  for (const [parentId, title] of Object.entries(PARENT_TITLES)) {
    const parent = issues.find((i) => i.id === parentId)
    if (!parent) continue
    for (let k = 1; k <= 3; k++) {
      subSeq += 1
      idSeq += 1
      const proj = parent.projectId
      counters[proj] = (counters[proj] ?? 0) + 1
      const sid = `${proj}-${idSeq}`
      issues.push({
        id: sid,
        projectId: proj,
        sequenceId: counters[proj],
        name: `${title} · 子任务 ${k}`,
        description: `父工作项「${title}」拆解的子任务 ${k}。`,
        stateId: k === 1 ? 'st-done' : k === 2 ? 'st-progress' : 'st-todo',
        priority: 'medium',
        assigneeId: parent.assigneeId,
        labelIds: [],
        cycleId: parent.cycleId,
        moduleId: parent.moduleId,
        pkg: parent.pkg,
        scope: null,
        cycle: isoWeekKeyOf(dayDate(-3)),
        startDate: parent.startDate,
        dueDate: parent.dueDate,
        createdAt: day(-10),
        parentId,
        subIssueIds: [],
        activity: [{ id: `${sid}-a1`, actorId: 'me', verb: '创建了工作项', at: day(-10) }],
        comments: [],
        completedAt: k === 1 ? day(-3) : null
      })
      parent.subIssueIds.push(sid)
    }
  }

  // 挂到周期：把无周期的未完成项随机（确定性取模）补进进行中周期
  const activeCycles: Record<string, string> = {
    'p-web': 'c-web-3',
    'p-app': 'c-app-1',
    'p-data': 'c-data-1'
  }
  let fill = 0
  for (const issue of issues) {
    if (!issue.cycleId && issue.parentId === null) {
      fill += 1
      if (fill % 3 === 0) issue.cycleId = activeCycles[issue.projectId] ?? null
    }
  }
  return issues
}

function buildCycles(): Cycle[] {
  return [
    { id: 'c-web-0', projectId: 'p-web', name: 'Sprint 14', status: 'completed', startDate: day(-42), endDate: day(-29), issueIds: [] },
    { id: 'c-web-2', projectId: 'p-web', name: 'Sprint 15', status: 'completed', startDate: day(-28), endDate: day(-15), issueIds: [] },
    { id: 'c-web-3', projectId: 'p-web', name: 'Sprint 16', status: 'active', startDate: day(-8), endDate: day(4), issueIds: [] },
    { id: 'c-web-4', projectId: 'p-web', name: 'Sprint 17', status: 'upcoming', startDate: day(5), endDate: day(18), issueIds: [] },
    { id: 'c-app-0', projectId: 'p-app', name: '迭代 08', status: 'completed', startDate: day(-30), endDate: day(-17), issueIds: [] },
    { id: 'c-app-1', projectId: 'p-app', name: '迭代 09', status: 'active', startDate: day(-7), endDate: day(5), issueIds: [] },
    { id: 'c-app-2', projectId: 'p-app', name: '迭代 10', status: 'draft', startDate: day(8), endDate: day(21), issueIds: [] },
    { id: 'c-data-0', projectId: 'p-data', name: 'D-Wave 05', status: 'completed', startDate: day(-25), endDate: day(-12), issueIds: [] },
    { id: 'c-data-1', projectId: 'p-data', name: 'D-Wave 06', status: 'active', startDate: day(-5), endDate: day(8), issueIds: [] }
  ]
}

function buildModules(): Module[] {
  return [
    {
      id: 'm-web-brand', projectId: 'p-web', name: '品牌焕新', description: '色彩/字体/插画体系更新与站点套用。',
      status: 'in-progress', leadId: 'me', memberIds: ['me', 'u2', 'u3'], startDate: day(-20), endDate: day(20), issueIds: []
    },
    {
      id: 'm-web-content', projectId: 'p-web', name: '内容工程', description: 'CMS 接入、模板组件与 SEO 治理。',
      status: 'planned', leadId: 'u3', memberIds: ['u3', 'u4'], startDate: day(-3), endDate: day(32), issueIds: []
    },
    {
      id: 'm-web-infra', projectId: 'p-web', name: '性能与基建', description: '构建产物、字体、LCP 与表单反垃圾。',
      status: 'paused', leadId: 'u2', memberIds: ['u2', 'u3'], startDate: day(-10), endDate: day(36), issueIds: []
    },
    {
      id: 'm-app-ui', projectId: 'p-app', name: '2.0 界面走查', description: '新视觉落地走查与细节打磨。',
      status: 'in-progress', leadId: 'u2', memberIds: ['u2', 'u4', 'u5'], startDate: day(-6), endDate: day(14), issueIds: []
    },
    {
      id: 'm-app-sync', projectId: 'p-app', name: '同步与离线', description: '离线缓存、深链与上传链路。',
      status: 'planned', leadId: 'me', memberIds: ['me', 'u2'], startDate: day(1), endDate: day(30), issueIds: []
    },
    {
      id: 'm-app-perf', projectId: 'p-app', name: '性能专项', description: '冷启动、内存与图片管线。',
      status: 'in-progress', leadId: 'u4', memberIds: ['u4'], startDate: day(-7), endDate: day(34), issueIds: []
    },
    {
      id: 'm-data-metric', projectId: 'p-data', name: '指标口径', description: '指标字典与口径评审机制。',
      status: 'in-progress', leadId: 'u3', memberIds: ['u3', 'me'], startDate: day(-9), endDate: day(12), issueIds: []
    },
    {
      id: 'm-data-collect', projectId: 'p-data', name: '采集管道', description: '埋点 Schema、校验与冷数据归档。',
      status: 'planned', leadId: 'u4', memberIds: ['u4'], startDate: day(2), endDate: day(40), issueIds: []
    },
    {
      id: 'm-data-bi', projectId: 'p-data', name: '自助分析', description: '看板性能、权限与漏斗组件。',
      status: 'in-progress', leadId: 'u3', memberIds: ['u3', 'u4', 'me'], startDate: day(-5), endDate: day(24), issueIds: []
    }
  ]
}

function buildViews(): SavedView[] {
  return [
    {
      id: 'v-all-urgent', projectId: 'p-web', name: '全部紧急与高优', description: '跨模块跟踪需要当日响应的工作项。',
      filters: { priority: ['urgent', 'high'] }, ownedById: 'me'
    },
    {
      id: 'v-bug-board', projectId: 'p-app', name: '缺陷清洗台', description: '按状态流转的缺陷视图。',
      filters: { stateGroup: ['unstarted', 'started'] }, ownedById: 'u2'
    },
    {
      id: 'v-infra', projectId: 'p-data', name: '基建流水线', description: '基础设施相关工作项汇总。',
      filters: { labelIds: ['lb-infra'] }, ownedById: 'u3'
    }
  ]
}

function buildPages(): PageDoc[] {
  return [
    {
      id: 'pg-web-1', projectId: 'p-web', emoji: '🎨', title: '设计语言升级说明',
      content: '本次升级覆盖色彩、圆角、阴影与插画风。\n\n## 色彩\n主色从藏蓝调整为品牌蓝，语义色保持不变。\n\n## 字体\n中文回退保持系统栈，英文统一 Inter Variable。',
      updatedAt: day(-2)
    },
    {
      id: 'pg-web-2', projectId: 'p-web', emoji: '🚀', title: '发布流程 Checklist',
      content: '每次发版前逐项确认：\n\n1. 回归用例全绿\n2. 灰度 10% 观察 2 小时\n3. 公告与更新日志同步',
      updatedAt: day(-5)
    },
    {
      id: 'pg-app-1', projectId: 'p-app', emoji: '📱', title: '2.0 版本说明（草稿）',
      content: '2.0 聚焦三件事：新视觉、性能、离线。\n\n- 新视觉：全部页面走查两轮\n- 性能：冷启动 < 1.2s\n- 离线：核心页可用',
      updatedAt: day(-1)
    },
    {
      id: 'pg-data-1', projectId: 'p-data', emoji: '📐', title: '指标口径评审记录',
      content: '周会结论：\n\n- 「活跃」定义保持双门槛（打开 + 关键行为）\n- 留存统一 7 日窗口',
      updatedAt: day(-8)
    },
    {
      id: 'pg-data-2', projectId: 'p-data', emoji: '🧭', title: '新同学上手指南',
      content: '欢迎加入数据平台！\n\n第一天：开通账号与权限\n第一周：跑通一条 ETL\n第一个月：认领一个模块',
      updatedAt: day(-12)
    }
  ]
}

function buildIntake(): IntakeIssue[] {
  return [
    { id: 'in-1', projectId: 'p-web', title: '官网白皮书下载链接失效', description: '市场部反馈白皮书表单提交后 404。', status: 'pending', submittedBy: 'u5', createdAt: day(-1) },
    { id: 'in-2', projectId: 'p-web', title: '希望博客支持 RSS 订阅', description: '读者来信：想用阅读器订阅更新。', status: 'pending', submittedBy: 'u4', createdAt: day(-2) },
    { id: 'in-3', projectId: 'p-app', title: '平板横屏布局错乱', description: 'iPad Pro 横屏时底部标签栏溢出。', status: 'accepted', submittedBy: 'u2', createdAt: day(-3) },
    { id: 'in-4', projectId: 'p-app', title: '重复：登录验证码超时', description: '与已修复的 in-3 同源，判定重复。', status: 'duplicate', submittedBy: 'u5', createdAt: day(-4) },
    { id: 'in-5', projectId: 'p-data', title: '导出 Excel 数字变科学计数法', description: '运营导出大数字列显示异常。', status: 'snoozed', submittedBy: 'u3', createdAt: day(-6) },
    { id: 'in-6', projectId: 'p-data', title: '旧版看板入口请求下线', description: '已被新看板替代，申请移除入口。', status: 'declined', submittedBy: 'u4', createdAt: day(-9) }
  ]
}

function buildNotifications(): NotificationItem[] {
  return [
    { id: 'n-1', kind: 'assigned', title: '导航栏信息架构重组（三栏→两栏）', body: '祁风 将你指派为负责人', at: day(0), read: false, projectId: 'p-web', issueId: 'p-web-2' },
    { id: 'n-2', kind: 'mention', title: '指标口径字典 v1 发布', body: '林远 在评论中提到了你', at: day(0), read: false, projectId: 'p-data', issueId: 'p-data-1' },
    { id: 'n-3', kind: 'assigned', title: '相册批量上传断点续传', body: '苏澜 将你指派为负责人', at: day(-1), read: false, projectId: 'p-app', issueId: 'p-app-8' },
    { id: 'n-4', kind: 'created', title: '深色模式对比度不达标（正文 #999）', body: '你创建的工作项有了新动态', at: day(-1), read: true, projectId: 'p-web', issueId: 'p-web-9' },
    { id: 'n-5', kind: 'subscribed', title: '日活看板加载超 30s', body: '关注的工作项状态变为 In Progress', at: day(-2), read: true, projectId: 'p-data', issueId: 'p-data-5' }
  ]
}

function buildDataset(): MyDataset {
  const issues = buildIssues()
  const cycles = buildCycles()
  const modules = buildModules()
  for (const issue of issues) {
    if (issue.cycleId) {
      const c = cycles.find((x) => x.id === issue.cycleId)
      if (c) c.issueIds.push(issue.id)
    }
    if (issue.moduleId) {
      const m = modules.find((x) => x.id === issue.moduleId)
      if (m) m.issueIds.push(issue.id)
    }
  }
  return {
    workspace: { name: '示例工作区（预览数据）', slug: 'sample', memberId: 'me' },
    members: MEMBERS,
    projects: PROJECTS,
    states: DEFAULT_STATES,
    labels: LABELS,
    issues,
    cycles,
    modules,
    views: buildViews(),
    pages: buildPages(),
    intake: buildIntake(),
    notifications: buildNotifications()
  }
}

export const createDemoDataset = buildDataset
