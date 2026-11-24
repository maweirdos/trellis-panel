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
  readonly category?: string
  readonly current?: string | boolean
  readonly choices: readonly { readonly value: string; readonly label: string; readonly group?: string }[]
}

export type ConversationDriverAction =
  | 'chat' | 'planning' | 'execution' | 'cancel' | 'resume' | 'goal' | 'goalPause' | 'compact' | 'nativeSubthreads' | 'modelSwitch' | 'readOnly' | 'toolApproval'

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
  readonly models: readonly ConversationDriverModel[]
  readonly options: readonly ConversationDriverOption[]
  readonly selectedModel?: string
  readonly actions: Readonly<Record<ConversationDriverAction, ConversationDriverEvidence>>
}
