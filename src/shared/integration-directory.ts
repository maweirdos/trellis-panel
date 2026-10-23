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
  { id: 'jira', providerId: 'jira', category: 'tasks', kind: 'tasks', name: 'Jira', description: '绑定 Jira 实例，管理项目来源、同步与 Issue 导入。' },
  { id: 'gitlab-issues-hosted', providerId: 'gitlab', category: 'tasks', kind: 'tasks', deployment: 'hosted', name: '极狐 GitLab.cn Issues', description: '将托管 GitLab 项目的 Issue 关联到当前项目。' },
  { id: 'gitlab-issues-self-managed', providerId: 'gitlab', category: 'tasks', kind: 'tasks', deployment: 'self-managed', name: 'GitLab Issues（自部署版）', description: '连接自有 GitLab 实例，配置项目 Issue 来源。' },
  { id: 'github', providerId: 'github', category: 'repositories', kind: 'repositories', name: 'GitHub', description: '浏览仓库与 Pull Request，关联本地工作项。' },
  { id: 'gitlab-repositories', providerId: 'gitlab', category: 'repositories', kind: 'repositories', name: 'GitLab', description: '浏览项目与 Merge Request，复用已有 GitLab 连接。' },
  { id: 'gitee', providerId: 'gitee', category: 'repositories', kind: 'repositories', name: 'Gitee', description: '浏览授权仓库与 Pull Request，保留研发来源。' },
  { id: 'dingtalk', providerId: 'dingtalk', category: 'messaging', kind: 'messaging', name: '钉钉', description: '管理应用与个人身份，保留群机器人通知入口。' },
  { id: 'feishu', providerId: 'feishu', category: 'messaging', kind: 'messaging', name: '飞书', description: '绑定群机器人，预览并手动发送工作项摘要。' },
  { id: 'weknora', providerId: 'weknora', category: 'knowledge', kind: 'knowledge', name: 'WeKnora', description: '设置项目知识库，检索资料并人工确认发布成果。' }
]
export const INTEGRATION_DIRECTORY_GROUPS: ReadonlyArray<{ id: IntegrationCategory; name: string; description: string }> = [
  { id: 'tasks', name: '任务管理工具', description: '接入团队用于推进产品工作的任务与项目系统。' },
  { id: 'repositories', name: 'Git 仓库', description: '接入代码托管平台，将仓库中的研发工作与任务关联。' },
  { id: 'messaging', name: '即时通讯', description: '配置团队消息入口与工作项通知目的地。' },
  { id: 'knowledge', name: '知识服务', description: '为当前项目选择知识来源与成果发布范围。' }
]
