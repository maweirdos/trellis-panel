import { useMemo, type JSX } from 'react'
import { ChatPage } from '../../pages/Chat'
import { useAgentChatBridge } from '../agent-chat-bridge'
import { useCrux } from '../store'

/**
 * Crux 协作空间内嵌独立对话页（1:1 复刻 HiFox 图 1）：
 * 彻底隐藏冗余的内置会话侧栏与重复顶栏，保留单层极简顶栏（关闭 / Agent 切换 / 新对话 / 右上角历史下拉 / 设置），
 * 聊天流与底部圆角编写器纯净居中呈现。
 */
export function CruxChatPage(): JSX.Element {
  const setModule = useCrux((s) => s.setModule)
  const returnModule = useAgentChatBridge((s) => s.returnModule)
  const setInspectAgentId = useAgentChatBridge((s) => s.setInspectAgentId)

  const embeddedCrux = useMemo(() => ({
    onClose: () => {
      setModule(returnModule === 'chat' ? 'all-agents' : returnModule)
    },
    onOpenSettings: (agentId: string) => {
      setInspectAgentId(agentId)
      setModule('all-agents')
    }
  }), [returnModule, setInspectAgentId, setModule])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-my-canvas">
      <ChatPage active embeddedCrux={embeddedCrux} />
    </div>
  )
}
