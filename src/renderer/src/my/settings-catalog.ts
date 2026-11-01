import { Blocks, Bot, Cpu, Database, Globe, Info, Palette, Plug, Server, Settings2, type LucideIcon } from 'lucide-react'
import type { Page } from '../store'
import type { SettingsView } from './navigation'

export type SettingsGroup = '偏好设置' | '智能与连接' | '应用管理'

export interface SettingsDestination {
  id: string
  title: string
  description: string
  icon: LucideIcon
  page: Page
  view?: SettingsView
  group: SettingsGroup
  keywords: readonly string[]
}

const GENERAL_SETTINGS: SettingsDestination = {
  id: 'preferences',
  title: '通用',
  description: '启动行为、快捷键与本机偏好。',
  icon: Settings2,
  page: 'settings',
  view: 'preferences',
  group: '偏好设置',
  keywords: ['偏好', '启动', '开机', '快捷键', 'general', 'preferences', 'startup', 'shortcuts']
}

export const SETTINGS_DESTINATIONS: readonly SettingsDestination[] = [
  GENERAL_SETTINGS,
  {
    id: 'appearance',
    title: '外观',
    description: '调整主题、界面密度与显示偏好。',
    icon: Palette,
    page: 'settings',
    view: 'appearance',
    group: '偏好设置',
    keywords: ['主题', '密度', '紧凑', '标准', '舒适', '放大', '字号', '字体', '深色', '浅色', '亮色', 'appearance', 'theme', 'density', 'font']
  },
  {
    id: 'models',
    title: '模型供应商',
    description: '管理模型服务、连接凭据与可用模型。',
    icon: Cpu,
    page: 'models',
    group: '智能与连接',
    keywords: ['模型', '供应商', '凭据', '密钥', 'API', 'provider', 'model', 'token']
  },
  {
    id: 'engines',
    title: '执行引擎',
    description: '管理本机执行引擎的安装与连接。',
    icon: Bot,
    page: 'settings',
    view: 'engines',
    group: '智能与连接',
    keywords: ['Agent', 'ACP', 'acpx', 'CLI', '安装', '运行时', 'runtime', 'engine']
  },
  {
    id: 'integrations',
    title: '应用集成',
    description: '连接外部应用，管理账号、同步与通知。',
    icon: Blocks,
    page: 'integrations',
    group: '智能与连接',
    keywords: ['Jira', 'GitHub', 'GitLab', 'Gitee', '钉钉', '飞书', 'WeKnora', '连接', '账号', '同步', '导入', '仓库', '通知', 'integration']
  },
  {
    id: 'gateway',
    title: 'MCP服务',
    description: '管理 MCP 服务及应用与项目的工具连接。',
    icon: Plug,
    page: 'gateway',
    group: '智能与连接',
    keywords: ['MCP', '工具', '服务', '网关', '应用', '项目', 'gateway', 'server']
  },
  {
    id: 'daemon',
    title: '后台服务',
    description: '查看后台服务状态，管理后台运行行为。',
    icon: Server,
    page: 'settings',
    view: 'daemon',
    group: '应用管理',
    keywords: ['后台', '守护进程', '常驻', '退出', 'daemon', 'background']
  },
  {
    id: 'network',
    title: '网络服务',
    description: '配置本机网络服务的访问与连接。',
    icon: Globe,
    page: 'settings',
    view: 'network',
    group: '应用管理',
    keywords: ['网络', '服务', '端口', '地址', '访问', 'HTTP', 'network', 'port']
  },
  {
    id: 'storage',
    title: '存储空间',
    description: '查看本机存储占用，管理可清理的数据。',
    icon: Database,
    page: 'settings',
    view: 'storage',
    group: '应用管理',
    keywords: ['存储', '空间', '磁盘', '缓存', '清理', '数据', 'storage', 'cache']
  },
  {
    id: 'about',
    title: '关于',
    description: '查看应用版本、许可证与项目链接。',
    icon: Info,
    page: 'settings',
    view: 'about',
    group: '应用管理',
    keywords: ['版本', '更新', '许可证', '开源', 'Trellis', 'about', 'version', 'license']
  }
]

export function getSettingsDestination(page: Page, view: SettingsView): SettingsDestination {
  return SETTINGS_DESTINATIONS.find((destination) => destination.page === page && (destination.view === undefined || destination.view === view)) ?? GENERAL_SETTINGS
}
