import type { IntegrationCategory, ProviderId } from './integrations'

/** Presentation identity only. All GitLab roles resolve the same provider credentials. */
export type IntegrationDirectoryId = 'jira' | 'gitlab-issues-hosted' | 'gitlab-issues-self-managed' | 'github' | 'gitlab-repositories' | 'gitee' | 'dingtalk' | 'feishu' | 'weknora'
export type IntegrationWorkspaceKind = 'tasks' | 'repositories' | 'messaging' | 'knowledge'
export interface IntegrationDirectoryEntry {
  id: IntegrationDirectoryId
  providerId: ProviderId
  category: IntegrationCategory
  name: string
  description: string
  kind: IntegrationWorkspaceKind
  deployment?: 'hosted' | 'self-managed'
}
export const INTEGRATION_DIRECTORY: readonly IntegrationDirectoryEntry[] = [
  { id: 'jira', providerId: 'jira', category: 'tasks', kind: 'tasks', name: 'Jira', description: '同步 Jira 项目与任务。' },
  { id: 'gitlab-issues-hosted', providerId: 'gitlab', category: 'tasks', kind: 'tasks', deployment: 'hosted', name: '极狐 GitLab.cn Issues', description: '将 GitLab Issue 同步到项目。' },
  { id: 'gitlab-issues-self-managed', providerId: 'gitlab', category: 'tasks', kind: 'tasks', deployment: 'self-managed', name: 'GitLab Issues（自部署版）', description: '连接自有 GitLab，同步 Issue。' },
  { id: 'github', providerId: 'github', category: 'repositories', kind: 'repositories', name: 'GitHub', description: '关联仓库与 Pull Request。' },
  { id: 'gitlab-repositories', providerId: 'gitlab', category: 'repositories', kind: 'repositories', name: 'GitLab', description: '关联项目与 Merge Request。' },
  { id: 'gitee', providerId: 'gitee', category: 'repositories', kind: 'repositories', name: 'Gitee', description: '关联仓库与 Pull Request。' },
  { id: 'dingtalk', providerId: 'dingtalk', category: 'messaging', kind: 'messaging', name: '钉钉', description: '连接钉钉应用、账号与任务助手。' },
  { id: 'feishu', providerId: 'feishu', category: 'messaging', kind: 'messaging', name: '飞书', description: '通过群机器人发送工作项通知。' },
  { id: 'weknora', providerId: 'weknora', category: 'knowledge', kind: 'knowledge', name: 'WeKnora', description: '检索项目知识，发布工作成果。' }
]
export const INTEGRATION_DIRECTORY_GROUPS: ReadonlyArray<{ id: IntegrationCategory; name: string; description: string }> = [
  { id: 'tasks', name: '任务管理工具', description: '接入团队用于推进产品工作的任务与项目系统。' },
  { id: 'repositories', name: 'Git 仓库', description: '接入代码托管平台，将仓库中的研发工作与任务关联。' },
  { id: 'messaging', name: '即时通讯', description: '配置团队消息入口与工作项通知目的地。' },
  { id: 'knowledge', name: '知识服务', description: '为当前项目选择知识来源与成果发布范围。' }
]
