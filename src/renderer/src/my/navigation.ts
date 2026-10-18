import type { Page } from '../store'

export type NavigationDomain = 'overview' | 'intake' | 'work' | 'knowledge' | 'conversations' | 'team' | 'analytics' | 'tools'
export type NavigationScope = 'project' | 'application' | 'local' | 'mixed'
export type WorkItemsView = 'items' | 'iterations'
export type ModuleId = NavigationDomain | 'iterations'

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
  tasks: { title: '工作项', domain: 'work', scope: 'project', icon: 'work-items', keywords: '任务' },
  dashboard: { title: '概览', domain: 'overview', scope: 'project', icon: 'your-work', keywords: '我的工作' },
  inbox: { title: '需求接入', domain: 'intake', scope: 'project', icon: 'inbox', keywords: '待办池 收件箱' },
  jira: {
    title: 'Jira 来源', domain: 'intake', scope: 'project', icon: 'work-items',
    scopeNote: 'Jira 结果遵循外部查询条件；导入目标是顶栏所选项目。',
    commandHint: '导入当前项目 · 外部查询'
  },
  team: { title: '团队', domain: 'team', scope: 'project', icon: 'views', keywords: '协作' },
  analytics: { title: '统计', domain: 'analytics', scope: 'project', icon: 'analytics', keywords: '统计分析' },
  archive: { title: '工作项归档', domain: 'work', scope: 'project', icon: 'intake' },
  acp: { title: 'Agent 会话', domain: 'conversations', scope: 'project', icon: 'inbox', keywords: 'Agent 对话 ACP' },
  channels: { title: '协作频道', domain: 'conversations', scope: 'project', icon: 'inbox', keywords: 'AI 频道' },
  chat: {
    title: '通用 API 问答', domain: 'tools', scope: 'local', icon: 'inbox', keywords: '本机 跨项目 会话',
    scopeNote: '本机通用 API 问答 · 会话历史跨项目共享'
  },
  knowledge: {
    title: '知识', domain: 'knowledge', scope: 'project', icon: 'pages', keywords: '文档 知识库',
    scopeNote: '项目资料来自当前目录；公司库与个人问答历史可跨项目访问。',
    commandHint: '当前项目 · 公司与个人资料'
  },
  spec: { title: '规范文档', domain: 'knowledge', scope: 'project', icon: 'views' },
  architecture: { title: '架构图', domain: 'tools', scope: 'project', icon: 'views' },
  studio: { title: '定制中心', domain: 'tools', scope: 'project', icon: 'modules' },
  models: { title: '模型管理', domain: 'tools', scope: 'application', icon: 'cycles' },
  settings: { title: '设置', domain: 'tools', scope: 'application', icon: 'work-items', scopeNote: '个人偏好和连接配置在本机保存；项目绑定按设置项注明的目标生效。' },
  gateway: { title: 'MCP 网关', domain: 'tools', scope: 'mixed', icon: 'analytics', keywords: '应用 项目' },
  devtools: {
    title: '本机开发工具', domain: 'tools', scope: 'local', icon: 'views', keywords: 'Git 只读 运行 日志 脚本 多工程',
    scopeNote: 'Git 仅为只读查看（无写操作）；运行只管理面板自己启动的进程，进程存活不代表服务就绪。'
  }
} satisfies Record<Page, PageNavigation>

export const DOMAIN_LABELS: Record<NavigationDomain, string> = {
  overview: '概览', intake: '需求接入', work: '工作项', knowledge: '知识',
  conversations: '会话', team: '团队', analytics: '统计', tools: '工具与设置'
}

export const PRIMARY_NAVIGATION: ReadonlyArray<{ id: ModuleId; page: Page; label: string; shortLabel: string; view?: WorkItemsView }> = [
  { id: 'overview', page: 'dashboard', label: '概览', shortLabel: '概览' },
  { id: 'intake', page: 'inbox', label: '需求接入', shortLabel: '接入' },
  { id: 'work', page: 'tasks', label: '工作项', shortLabel: '工作项', view: 'items' },
  { id: 'iterations', page: 'tasks', label: '迭代', shortLabel: '迭代', view: 'iterations' },
  { id: 'knowledge', page: 'knowledge', label: '知识', shortLabel: '知识' },
  { id: 'conversations', page: 'acp', label: '会话', shortLabel: '会话' },
  { id: 'team', page: 'team', label: '团队', shortLabel: '团队' },
  { id: 'analytics', page: 'analytics', label: '统计', shortLabel: '统计' }
]

export const INTAKE_PAGES: readonly Page[] = ['inbox', 'jira']
export const WORK_PAGES: readonly Page[] = ['tasks', 'archive']
export const AI_MODES: readonly Page[] = ['acp', 'channels']
export const PROJECT_TOOLS: readonly Page[] = ['architecture', 'studio']
export const APPLICATION_TOOLS: readonly Page[] = ['chat', 'models', 'settings', 'devtools']

export function getPageNavigation(page: Page): PageNavigation {
  return PAGE_NAVIGATION[page]
}

export function activeModule(page: Page, view: WorkItemsView): ModuleId {
  return page === 'tasks' && view === 'iterations' ? 'iterations' : getPageNavigation(page).domain
}

/** Knowledge and conversation pages already own their real source/session browsers. */
export function hasShellContext(page: Page): boolean {
  return page !== 'chat' && !['knowledge', 'conversations'].includes(getPageNavigation(page).domain)
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
