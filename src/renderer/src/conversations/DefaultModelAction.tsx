import { useState, type JSX } from 'react'
import { DropdownItem } from '../my/ui'
import { api } from '../api'
import { refreshConversationDefaults, useConversations } from './workspace'

export function DefaultModelAction({ modelId }: { modelId?: string }): JSX.Element | null {
  const preferred = useConversations(state => state.defaultPiModelId)
  const models = useConversations(state => state.piModels)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (!api?.setDefaultConversationModel || !modelId || !models.some(model => model.id === modelId && model.available)) return null
  const save = async (): Promise<void> => {
    if (busy || !api.setDefaultConversationModel) return
    setBusy(true); setError('')
    try {
      await api.setDefaultConversationModel({ modelId, expectedDefaultId: preferred })
      await refreshConversationDefaults()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '默认模型保存失败') }
    finally { setBusy(false) }
  }
  return <><DropdownItem disabled={busy || preferred === modelId} onClick={() => void save()}>{busy ? '正在保存默认模型…' : preferred === modelId ? '已设为新会话默认' : '设为新会话默认'}</DropdownItem>{error && <p role="alert" className="my-item-description text-my-danger-text px-3 py-2">{error}</p>}</>
}
