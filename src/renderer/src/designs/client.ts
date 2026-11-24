import type { DesignWorkspaceApi } from '@shared/design-workspace'
import { api, hasIpc } from '../api'

export function designClient(): DesignWorkspaceApi | null {
  return hasIpc ? api.designWorkspace ?? null : null
}

export function requireDesignClient(): DesignWorkspaceApi {
  const client = designClient()
  if (!client) throw new Error('本机设计接口当前不可用，请在桌面应用中重试。')
  return client
}

export function notifyDesignChanged(origin = 'workspace'): void { window.dispatchEvent(new CustomEvent('trellis-design-changed', { detail: { origin } })) }
