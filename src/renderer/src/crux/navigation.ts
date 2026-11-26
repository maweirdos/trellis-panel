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
  { id: 'overview', label: '协作概览', group: '工作台', icon: 'overview', scope: 'global' },
  { id: 'inbox', label: '收件箱', group: '工作台', icon: 'inbox', scope: 'global' },
  { id: 'my-tasks', label: '我的任务', group: '工作台', icon: 'tasks', scope: 'global' },
  { id: 'all-agents', label: 'Agent 目录', group: '工作台', icon: 'agents', scope: 'global' },
  { id: 'tasks', label: '任务', group: '空间 · 任务', icon: 'tasks', scope: 'space' },
  { id: 'board', label: '任务看板', group: '空间 · 任务', icon: 'board', scope: 'space', parent: 'tasks' },
  { id: 'iterations', label: '版本', group: '空间 · 任务', icon: 'iterations', scope: 'space', parent: 'tasks' },
  { id: 'triage', label: '分拣台', group: '空间 · 任务', icon: 'triage', scope: 'space', parent: 'tasks' },
  { id: 'views', label: '视图', group: '空间 · 任务', icon: 'board', scope: 'space', parent: 'tasks' },
  { id: 'projects', label: '专项', group: '空间 · 任务', icon: 'projects', scope: 'space', parent: 'tasks' },
  { id: 'creations', label: '文档库', group: '空间', icon: 'reports', scope: 'space' },
  { id: 'agents', label: 'Agent', group: '空间', icon: 'agents', scope: 'space' },
  { id: 'crews', label: '小队', group: '空间', icon: 'crews', scope: 'space' },
  { id: 'automations', label: '自动化', group: '空间', icon: 'automations', scope: 'space' },
  { id: 'skills', label: '技能', group: '空间', icon: 'skills', scope: 'space' },
  { id: 'task-types', label: '任务类型', group: '配置', icon: 'tasks', scope: 'space' },
  { id: 'task-statuses', label: '任务状态', group: '配置', icon: 'review', scope: 'space' },
  { id: 'task-labels', label: '任务标签', group: '配置', icon: 'projects', scope: 'space' },
  { id: 'spaces', label: '空间设置', group: '配置', icon: 'spaces', scope: 'space' },
  { id: 'members', label: '同事', group: '组织', icon: 'members', scope: 'global' }
]
