import type { Page } from '../store'

export type NavigationDomain = 'home' | 'agents' | 'tasks' | 'team' | 'knowledge' | 'settings'
export type NavigationScope = 'project' | 'application' | 'local' | 'mixed'
export type WorkItemsView = 'items' | 'iterations'
export type ModuleId = NavigationDomain
export type TeamView = 'overview' | 'members' | 'activity' | 'reports'
export type ToolView = 'git' | 'run' | 'architecture' | 'studio'
export type AgentView = 'conversation' | 'roles'
export type KnowledgeView = 'materials' | 'company'
export type SettingsView = 'preferences' | 'engines'
export const SETTINGS_VIEW_TITLES: Record<SettingsView, string> = { preferences: '偏好设置', engines: 'Agent 执行引擎' }

interface PageNavigation {
  title: string
  domain: NavigationDomain
  scope: NavigationScope
  icon: string
  keywords?: string
  scopeNote?: string
  commandHint?: string
}

/** The existing route remains the fact; modules never create another project context. */
export const PAGE_NAVIGATION = {
  tasks: { title: '任务', domain: 'tasks', scope: 'local', icon: 'work-items', keywords: '个人 团队任务 本地工作 工作项 全部工作项' },
  dashboard: { title: '概览', domain: 'home', scope: 'project', icon: 'your-work', keywords: '首页 我的工作 个人记录 收藏' },
  creations: { title: '创作', domain: 'home', scope: 'local', icon: 'pages', keywords: '个人 作品 原型 文档 图表 评审' },
  inbox: { title: '接入', domain: 'tasks', scope: 'project', icon: 'inbox', keywords: '需求接入 待办池 收件箱' },
  jira: {
    title: '接入', domain: 'tasks', scope: 'project', icon: 'work-items', keywords: 'Jira 来源 外部查询',
    scopeNote: 'Jira 结果遵循外部查询条件；导入目标是顶栏所选项目。',
    commandHint: '导入当前项目 · 外部查询'
  },
  team: { title: '概况', domain: 'team', scope: 'project', icon: 'views', keywords: '协作' },
  hifox: {
    title: '团队协作', domain: 'team', scope: 'local', icon: 'modules',
    keywords: 'HiFox 团队协作 空间 同事 成员 任务 看板 专项 版本 迭代 分拣台 收件箱 自动化 Agent 技能 小队'
  },
  analytics: { title: '统计', domain: 'team', scope: 'project', icon: 'analytics', keywords: '统计分析' },
  archive: { title: '归档', domain: 'tasks', scope: 'project', icon: 'intake' },
  acp: { title: '对话', domain: 'agents', scope: 'project', icon: 'inbox', keywords: 'Agent 对话 ACP' },
  channels: { title: '频道', domain: 'agents', scope: 'project', icon: 'inbox', keywords: 'AI 协作频道' },
  chat: {
    title: '问答', domain: 'agents', scope: 'local', icon: 'inbox', keywords: '通用 API 问答 本机 跨项目 会话',
    scopeNote: '本机通用 API 问答 · 会话历史跨项目共享'
  },
  knowledge: {
    title: '资料', domain: 'knowledge', scope: 'project', icon: 'pages', keywords: '文档 知识库',
    scopeNote: '项目资料来自当前目录；知识库与个人问答历史可跨项目访问。',
    commandHint: '当前项目 · 知识库与个人资料'
  },
  spec: { title: '规范', domain: 'knowledge', scope: 'project', icon: 'views', keywords: '规范文档 日志' },
  architecture: { title: '架构', domain: 'tasks', scope: 'project', icon: 'views' },
  studio: { title: '定制', domain: 'tasks', scope: 'project', icon: 'modules' },
  models: { title: 'AI 模型与供应商', domain: 'settings', scope: 'application', icon: 'models' },
  settings: { title: '偏好设置', domain: 'settings', scope: 'application', icon: 'work-items' },
  integrations: { title: '外部应用集成', domain: 'settings', scope: 'mixed', icon: 'modules', keywords: 'Jira GitHub GitLab Issues Gitee 钉钉 飞书 WeKnora 连接 账号 同步 导入 仓库 通知' },
  gateway: { title: 'MCP 工具服务', domain: 'settings', scope: 'mixed', icon: 'mcp', keywords: '应用 项目' },
  devtools: {
    title: '工具', domain: 'tasks', scope: 'project', icon: 'views', keywords: 'Git 只读 应用 运行 日志 脚本 启动 端口',
    scopeNote: '当前项目的 Git 与本地应用。'
  }
} satisfies Record<Page, PageNavigation>

export const DOMAIN_LABELS: Record<NavigationDomain, string> = {
  home: '个人', agents: '对话', tasks: '任务', team: '团队', knowledge: '知识', settings: '设置'
}

export const PRIMARY_NAVIGATION: ReadonlyArray<{ id: ModuleId; page: Page; label: string; shortLabel: string }> = [
  { id: 'home', page: 'tasks', label: '个人', shortLabel: '个人' },
  { id: 'team', page: 'hifox', label: '团队', shortLabel: '团队' },
  { id: 'agents', page: 'acp', label: '对话', shortLabel: '对话' },
  { id: 'knowledge', page: 'knowledge', label: '知识', shortLabel: '知识' }
]

export function getPageNavigation(page: Page): PageNavigation {
  return PAGE_NAVIGATION[page]
}

export function activeModule(page: Page): ModuleId {
  // Keep the legacy tasks preference namespace while presenting one personal module.
  const domain = getPageNavigation(page).domain
  return domain === 'tasks' ? 'home' : domain
}

/** Knowledge and conversation pages already own their real source/session browsers. */
export function hasShellContext(page: Page): boolean {
  return page !== 'hifox' && !['knowledge', 'agents'].includes(activeModule(page))
}

export function navigationScopeLabel(scope: NavigationScope): string {
  switch (scope) {
    case 'project': return '当前项目'
    case 'application': return '应用'
    case 'local': return '本机 · 跨项目'
    case 'mixed': return '应用与项目'
  }
}

/** Snapshot roots are absolute. Windows roots are case insensitive; POSIX roots are not. */
export function projectRootKey(root: string | null | undefined): string | null {
  if (!root?.trim()) return null
  const separators = root.trim().replace(/\\/g, '/')
  const windows = /^[a-z]:\//i.test(separators) || separators.startsWith('//')
  const compact = windows
    ? separators.startsWith('//') ? `//${separators.slice(2).replace(/^\/+/, '').replace(/\/+/g, '/')}` : separators.replace(/\/+/g, '/')
    : separators
  const normalized = /^[a-z]:\/$/i.test(compact) ? compact : compact.replace(/\/+$/, '') || '/'
  return windows ? normalized.toLowerCase() : normalized
}

export function projectNameFromPath(root: string): string {
  return root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
}

export function projectChoices(currentRoot: string | null, recentRoots: readonly string[]): string[] {
  const seen = new Set<string>()
  return (currentRoot ? [currentRoot, ...recentRoots] : [...recentRoots]).filter((root) => {
    const key = projectRootKey(root)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
