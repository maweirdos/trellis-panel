import type { FlowIconName } from './icons'
import type { CruxModule } from './store'

export interface CollaborationModule {
  id: CruxModule
  label: string
  group: string
  icon: FlowIconName
  scope: 'global' | 'space'
  parent?: CruxModule
}

export const COLLABORATION_MODULES: CollaborationModule[] = [
  { id: 'overview', label: '新手指引与概览', group: '工作台', icon: 'overview', scope: 'global' },
  { id: 'inbox', label: '收件箱', group: '工作台', icon: 'inbox', scope: 'global' },
  { id: 'my-tasks', label: '我的任务', group: '工作台', icon: 'tasks', scope: 'global' },
  { id: 'all-agents', label: '全部 Agent', group: '工作台', icon: 'agents', scope: 'global' },
  { id: 'marketplace', label: '市场', group: '工作台', icon: 'skills', scope: 'global' },
  { id: 'tasks', label: '任务', group: '空间 · 任务', icon: 'tasks', scope: 'space' },
  { id: 'board', label: '任务看板', group: '空间 · 任务', icon: 'board', scope: 'space', parent: 'tasks' },
  { id: 'iterations', label: '迭代', group: '空间 · 任务', icon: 'iterations', scope: 'space', parent: 'tasks' },
  { id: 'views', label: '视图', group: '空间 · 任务', icon: 'board', scope: 'space', parent: 'tasks' },
  { id: 'triage', label: '分拣台', group: '空间 · 任务', icon: 'triage', scope: 'space', parent: 'tasks' },
  { id: 'projects', label: '专项', group: '空间 · 任务', icon: 'projects', scope: 'space', parent: 'tasks' },
  { id: 'analytics', label: '统计分析', group: '空间 · 任务', icon: 'activity', scope: 'space', parent: 'tasks' },
  { id: 'agents', label: 'Agents', group: '空间', icon: 'agents', scope: 'space' },
  { id: 'crews', label: '小队', group: '空间', icon: 'crews', scope: 'space' },
  { id: 'automations', label: 'Agent 自动化', group: '空间', icon: 'automations', scope: 'space' },
  { id: 'creations', label: '文档库', group: '空间', icon: 'reports', scope: 'space' },
  { id: 'skills', label: '技能', group: '空间', icon: 'skills', scope: 'space' },
  { id: 'task-types', label: '任务类型 & 工作流', group: '配置', icon: 'tasks', scope: 'space' },
  { id: 'task-statuses', label: '任务状态', group: '配置', icon: 'review', scope: 'space' },
  { id: 'task-labels', label: '任务标签', group: '配置', icon: 'projects', scope: 'space' },
  { id: 'spaces', label: '空间设置', group: '配置', icon: 'spaces', scope: 'space' },
  { id: 'runtimes', label: '机器与 Runtime', group: '组织', icon: 'automations', scope: 'global' },
  { id: 'members', label: '成员', group: '组织', icon: 'members', scope: 'global' }
]
