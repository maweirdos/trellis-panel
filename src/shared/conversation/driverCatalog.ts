export interface ConversationDriverModel {
  readonly id: string
  readonly displayName: string
  readonly isDefault: boolean
  readonly providerId?: string
  readonly group?: string
}

export interface ConversationDriverOption {
  readonly id: string
  readonly label: string
  readonly modelId?: string
  readonly turnSelectable?: true
  readonly category?: string
  readonly current?: string | boolean
  readonly choices: readonly { readonly value: string; readonly label: string; readonly group?: string }[]
}

export type ConversationDriverSkillSource = 'app' | 'repo' | 'personal' | 'system' | 'other'

export interface ConversationDriverSkill {
  readonly name: string
  readonly displayName?: string
  readonly description?: string
  readonly source?: ConversationDriverSkillSource
}

export type ConversationDriverAction =
  | 'chat' | 'planning' | 'execution' | 'cancel' | 'steer' | 'resume' | 'goal' | 'goalPause' | 'compact' | 'nativeSubthreads' | 'modelSwitch' | 'readOnly' | 'toolApproval'

export interface ConversationDriverEvidence {
  readonly state: 'verified' | 'unsupported' | 'unknown'
  readonly source: 'native-handshake' | 'native-catalog' | 'native-session' | 'host-policy'
  readonly detail: string
}

export interface ConversationDriverDescriptor {
  readonly version?: string
  readonly configurationKey: string
  readonly observedAt: string
  readonly source: 'native-catalog' | 'native-session'
  /** 标记该目录为冷启动尚未生成磁盘缓存时返回的内置静态兜底快照；后台预热完成后将替换为真实原生目录。 */
  readonly provisional?: true
  readonly models: readonly ConversationDriverModel[]
  readonly options: readonly ConversationDriverOption[]
  readonly skills?: readonly ConversationDriverSkill[]
  readonly selectedModel?: string
  readonly actions: Readonly<Record<ConversationDriverAction, ConversationDriverEvidence>>
}
