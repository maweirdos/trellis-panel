import type { CruxInitialTaskType, CruxSpace, CruxSpaceModules, CruxSpaceTemplate } from './crux'

export interface SpaceTemplatePreset {
  id: CruxSpaceTemplate
  label: string
  description: string
  defaultTaskTypes: CruxInitialTaskType[]
  defaultModules: CruxSpaceModules
  starterTask: {
    title: string
    description: string
  }
}

export const DEFAULT_SPACE_MODULES: CruxSpaceModules = {
  views: true,
  iterations: true,
  projects: true,
  triage: true,
  docs: true,
  automations: true,
  agents: true,
  skills: true
}

export const SPACE_MODULE_META: ReadonlyArray<{
  key: keyof CruxSpaceModules
  label: string
  description: string
}> = [
  { key: 'views', label: '视图', description: '保存常用筛选与分组视图，快速切换视角' },
  { key: 'iterations', label: '迭代 / 版本', description: '按周期或版本号规划排期与交付节奏' },
  { key: 'projects', label: '专项（史诗）', description: '将跨周期相关任务聚合为阶段性目标' },
  { key: 'triage', label: '分拣台', description: '集中审核外部流入或待确认的新任务' },
  { key: 'docs', label: '文档库', description: '沉淀空间共享文档、方案规范与产物' },
  { key: 'agents', label: 'Agent 与小队', description: '配置空间专属 Agent 岗位与协作小队' },
  { key: 'automations', label: '自动化', description: '按状态变更或定时触发自动派发与提醒' },
  { key: 'skills', label: '技能', description: '维护空间复用的工作流指令与技能包' }
]

const modules = (patch: Partial<CruxSpaceModules>): CruxSpaceModules => ({
  views: true,
  iterations: false,
  projects: false,
  triage: false,
  docs: true,
  automations: true,
  agents: true,
  skills: true,
  ...patch
})

export const SPACE_TEMPLATE_PRESETS: ReadonlyArray<SpaceTemplatePreset> = [
  {
    id: 'software',
    label: '软件研发',
    description: '需求、缺陷与版本迭代交付',
    defaultTaskTypes: ['需求', 'Bug', '任务'],
    defaultModules: modules({ iterations: true, projects: true, triage: false }),
    starterTask: {
      title: '示例任务：熟悉空间协作与 Agent 派发',
      description: '这是一条自动生成的示例任务。\n\n你可以尝试：\n1. 点击任务查看详情并分配处理人或指派空间 Agent\n2. 拖动任务卡片切换状态，观察右侧折叠空列自动展开\n3. 在「空间设置」中随时调整本空间开启的功能模块与任务类型'
    }
  },
  {
    id: 'product',
    label: '产品管理',
    description: '需求规划、路线图与专项评审',
    defaultTaskTypes: ['需求', '任务', '内容'],
    defaultModules: modules({ iterations: true, projects: true, triage: true }),
    starterTask: {
      title: '示例任务：梳理本季度核心需求路线图',
      description: '整理关键产品目标与验收标准，并在文档库沉淀背景资料供团队与 Agent 共享查阅。'
    }
  },
  {
    id: 'marketing',
    label: '市场营销',
    description: '活动策划、内容排期与推广执行',
    defaultTaskTypes: ['任务', '内容'],
    defaultModules: modules({ projects: true }),
    starterTask: {
      title: '示例任务：策划新版本发布推广方案',
      description: '明确核心卖点、传播渠道与交付时间节点，调用 Agent 协助产出初稿内容。'
    }
  },
  {
    id: 'design',
    label: '设计',
    description: '界面设计、体验评审与视觉规范',
    defaultTaskTypes: ['需求', '任务', '内容'],
    defaultModules: modules({ projects: true }),
    starterTask: {
      title: '示例任务：整理核心页面交互与视觉走查清单',
      description: '沉淀组件规范并在空间文档库共享评审意见。'
    }
  },
  {
    id: 'project',
    label: '项目管理',
    description: '跨团队专项推进、里程碑与风险跟踪',
    defaultTaskTypes: ['需求', '任务'],
    defaultModules: modules({ iterations: true, projects: true, triage: true }),
    starterTask: {
      title: '示例任务：建立当前阶段里程碑与周进度同步',
      description: '使用专项与迭代跟踪关键依赖，及时收拢阻塞项。'
    }
  },
  {
    id: 'operations',
    label: '运营',
    description: '日常活动跟进、流程优化与数据复盘',
    defaultTaskTypes: ['任务', '内容'],
    defaultModules: modules({ triage: true }),
    starterTask: {
      title: '示例任务：搭建日常运营巡检与复盘模板',
      description: '将重复性核对流程沉淀为技能或自动化规则。'
    }
  },
  {
    id: 'it',
    label: 'IT 支持',
    description: '故障工单分拣、环境维护与权限响应',
    defaultTaskTypes: ['Bug', '任务'],
    defaultModules: modules({ triage: true }),
    starterTask: {
      title: '示例任务：配置工单接入与值班分拣流程',
      description: '开启分拣台集中处理新提交的支持请求，按优先级快速分派。'
    }
  },
  {
    id: 'hr',
    label: '人力资源',
    description: '招聘推进、入职协同与制度文档',
    defaultTaskTypes: ['任务', '内容'],
    defaultModules: modules({}),
    starterTask: {
      title: '示例任务：梳理新成员入职引导清单',
      description: '在文档库沉淀团队手册，并用任务跟踪关键节点。'
    }
  },
  {
    id: 'support',
    label: '客户服务',
    description: '客户反馈分拣、问题闭环与知识库更新',
    defaultTaskTypes: ['Bug', '任务'],
    defaultModules: modules({ triage: true }),
    starterTask: {
      title: '示例任务：整理高频客户问题回复指南',
      description: '汇总常见客诉场景并同步至团队文档库。'
    }
  },
  {
    id: 'legal',
    label: '法务',
    description: '合同审核、合规审查与条款归档',
    defaultTaskTypes: ['任务', '内容'],
    defaultModules: modules({}),
    starterTask: {
      title: '示例任务：建立标准协议审阅核对清单',
      description: '将合规核查要点整理为空间技能，辅助日常评审。'
    }
  },
  {
    id: 'finance',
    label: '财务',
    description: '预算核对、月度结算与报表协作',
    defaultTaskTypes: ['任务'],
    defaultModules: modules({}),
    starterTask: {
      title: '示例任务：梳理月度对账与归档节点',
      description: '明确责任人与截止日期，确保关键财务流程可追踪。'
    }
  },
  {
    id: 'sales',
    label: '销售',
    description: '商机跟进、方案定制与客户交付交接',
    defaultTaskTypes: ['任务', '内容'],
    defaultModules: modules({ projects: true }),
    starterTask: {
      title: '示例任务：整理重点客户方案演示材料',
      description: '结合文档库资料快速生成定制化沟通材料。'
    }
  },
  {
    id: 'data',
    label: '数据科学',
    description: '数据分析、实验追踪与指标报告',
    defaultTaskTypes: ['任务'],
    defaultModules: modules({}),
    starterTask: {
      title: '示例任务：定义核心业务指标分析口径',
      description: '在文档库记录指标口径，并指派 Agent 协助整理分析结论。'
    }
  },
  {
    id: 'other',
    label: '其他',
    description: '通用轻量协作空间，随时按需开启模块',
    defaultTaskTypes: ['任务'],
    defaultModules: modules({}),
    starterTask: {
      title: '示例任务：开始你的第一个团队协作任务',
      description: '随时新建任务、邀请成员，或在空间设置中按需开关迭代、专项、分拣台等功能模块。'
    }
  }
]

export function getSpaceTemplatePreset(template: CruxSpaceTemplate | undefined): SpaceTemplatePreset {
  return SPACE_TEMPLATE_PRESETS.find((item) => item.id === template) ?? SPACE_TEMPLATE_PRESETS[0]
}

/** 历史未显式设置 enabledModules 的空间保留全量模块；显式配置后严格按配置生效。 */
export function resolveSpaceModules(space: Pick<CruxSpace, 'enabledModules'> | undefined): CruxSpaceModules {
  if (!space?.enabledModules) return { ...DEFAULT_SPACE_MODULES }
  return { ...DEFAULT_SPACE_MODULES, ...space.enabledModules }
}

/** 根据组织名称自动推导 2~7 位大写字母数字前缀（如 "honsky" -> "HONS"）。 */
export function deriveSpaceKeyFromName(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (ascii.length >= 2) return ascii.slice(0, 4)
  if (ascii.length === 1) return `${ascii}1`
  return 'MAIN'
}
