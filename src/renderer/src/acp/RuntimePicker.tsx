import { useState, type JSX } from 'react'
import { ChevronDown, ChevronRight, Laptop, MoreHorizontal, Wifi, WifiOff } from 'lucide-react'
import { clsx } from 'clsx'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { Dropdown, DropdownHeader } from '../my/ui'
import { RuntimePanel, runtimeHealthLabel } from './RuntimePanel'
import type { AcpAgentStatus } from '../../../shared/types'

export function RuntimeMark({ runtimeId, size = 16 }: { runtimeId?: string; size?: number }): JSX.Element {
  return <ToolBrandIcon brand={runtimeId} size={size} className="acp-runtime-mark" />
}

export function RuntimeConnectivity({ agent, showOff = false }: { agent: AcpAgentStatus | undefined; showOff?: boolean }): JSX.Element | null {
  if (!agent) return null
  const online = agent.enabled && agent.available && !agent.setupRequired
  if (!online && !showOff) return <span className="acp-runtime-status" title={runtimeHealthLabel(agent)}>{runtimeHealthLabel(agent)}</span>
  return online
    ? <Wifi size={13} className="acp-runtime-online" aria-label={runtimeHealthLabel(agent)} />
    : <WifiOff size={13} className="acp-runtime-offline" aria-label={runtimeHealthLabel(agent)} />
}

function findAgent(agents: AcpAgentStatus[], runtimeId: string | undefined): AcpAgentStatus | undefined {
  return agents.find((agent) => (agent.runtimeId ?? agent.id) === runtimeId)
}

/**
 * 图一式 Runtime 选择器：触发按钮 +「我的（本机）」分组下拉。
 * 下拉底部可展开本机 Runtime 管理（安装 / 重新探测 / 选择 Node）。
 */
export function RuntimePicker({ agents, value, deviceLabel = '本机', onSelect, onAgentsChange, isCurrent, triggerSize = 'sm' }: {
  agents: AcpAgentStatus[]
  value: string | undefined
  deviceLabel?: string
  onSelect: (runtimeId: string) => void
  onAgentsChange?: (agents: AcpAgentStatus[]) => void
  isCurrent?: () => boolean
  triggerSize?: 'sm' | 'row'
}): JSX.Element {
  const [deviceOpen, setDeviceOpen] = useState(true)
  const [manageOpen, setManageOpen] = useState(false)
  const current = findAgent(agents, value)
  return <Dropdown align="left" width={330} layoutKey={`runtime-picker:${deviceOpen}:${manageOpen}`} trigger={({ open, toggle }) => (
    <button type="button" className={clsx('acp-runtime-trigger', triggerSize === 'row' && 'acp-runtime-trigger-row')} aria-expanded={open} aria-haspopup="true" disabled={!agents.length} onClick={toggle}>
      <RuntimeMark runtimeId={value} />
      <span className="acp-runtime-trigger-name">{current?.name ?? value ?? '选择 Runtime'}</span>
      <span className="acp-runtime-trigger-device">{deviceLabel}</span>
      <RuntimeConnectivity agent={current} />
      <ChevronDown size={13} className="acp-runtime-trigger-caret" />
    </button>
  )}>
    {(close) => <div className="acp-runtime-menu my-scrollbar">
      <DropdownHeader>选择 Runtime</DropdownHeader>
      <p className="acp-runtime-group">我的</p>
      <div className="acp-runtime-device">
        <button type="button" className="acp-runtime-caret-button" aria-expanded={deviceOpen} aria-label={deviceOpen ? '收起本机设备' : '展开本机设备'} onClick={() => setDeviceOpen((open) => !open)}>
          <ChevronDown size={12} className="acp-runtime-caret" />
        </button>
        <Laptop size={15} className="shrink-0 text-my-secondary" />
        <span className="min-w-0 flex-1 truncate">{deviceLabel}</span>
        <Wifi size={13} className="acp-runtime-online" />
      </div>
      {deviceOpen && <ul className="acp-runtime-options" role="listbox" aria-label="本机可用 Runtime">
        {agents.map((agent) => {
          const runtimeId = agent.runtimeId ?? agent.id
          const selected = runtimeId === value
          return <li key={agent.id}>
            <button type="button" role="option" aria-selected={selected} className={clsx('acp-runtime-option', selected && 'is-selected')} onClick={() => { onSelect(runtimeId); close() }}>
              <RuntimeMark runtimeId={runtimeId} />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {selected && <span className="acp-runtime-checked" aria-hidden="true">✓</span>}
              <RuntimeConnectivity agent={agent} showOff />
            </button>
          </li>
        })}
        {agents.length === 0 && <li className="px-3 py-2 text-my-sm text-my-tertiary">尚未探测到本机 Runtime，请在下方重新探测。</li>}
      </ul>}
      <div className="acp-runtime-more">
        <button type="button" className="acp-runtime-more-toggle" aria-expanded={manageOpen} onClick={() => setManageOpen((open) => !open)}>
          <MoreHorizontal size={15} />
          <span className="flex-1 text-left">更多 Runtime</span>
          <ChevronRight size={13} className={clsx('acp-runtime-caret', manageOpen && 'is-open')} />
        </button>
        {manageOpen && onAgentsChange && isCurrent && <div className="acp-runtime-manage"><RuntimePanel agents={agents} onChange={onAgentsChange} isCurrent={isCurrent} heading={false} /></div>}
        {manageOpen && (!onAgentsChange || !isCurrent) && <p className="px-3 pb-3 text-my-sm text-my-tertiary">在设置页管理本机 Runtime 的安装与探测。</p>}
      </div>
    </div>}
  </Dropdown>
}
