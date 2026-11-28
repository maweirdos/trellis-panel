import { useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import { hasIpc } from '../api'
import { Modal } from '../my/ui'
import { AccountFlow } from './account/AccountFlow'
import { useCrux } from './store'
import './collaboration.css'

export interface ConnectionPanelProps {
  trigger?: 'compact' | 'connect'
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
  initialStep?: 'entry' | 'accounts' | 'auth' | 'organizations' | 'create-organization'
  returnToOnboarding?: boolean
}

export function ConnectionPanel({ trigger = 'compact', open: controlledOpen, onOpenChange, hideTrigger = false, initialStep, returnToOnboarding = false }: ConnectionPanelProps = {}): JSX.Element {
  const workspaceContext = useCrux((state) => state.workspaceContext)
  const selectWorkspace = useCrux((state) => state.selectWorkspace)
  const bootstrap = useCrux((state) => state.bootstrap)
  const busy = useCrux((state) => state.busy)
  const [internalOpen, setInternalOpen] = useState(false)
  const requestCloseRef = useRef<(() => void) | null>(null)
  const open = controlledOpen ?? internalOpen
  const setOpen = (value: boolean): void => {
    if (controlledOpen === undefined) setInternalOpen(value)
    onOpenChange?.(value)
  }
  const label = workspaceContext.state === 'local'
    ? '登录 / 切换组织'
    : workspaceContext.state === 'connected'
      ? workspaceContext.projectName ?? '团队组织'
      : workspaceContext.state === 'offline'
        ? `${workspaceContext.projectName ?? '团队组织'} · 离线`
        : '登录已过期 · 点击恢复'

  return <>
    {!hideTrigger && <button
      type="button"
      disabled={!hasIpc}
      onClick={() => setOpen(true)}
      className="flex min-h-8 w-full items-center gap-2 rounded-my-base py-1 text-left text-my-xs text-my-secondary transition-colors duration-100 hover:text-my-primary disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={workspaceContext.state === 'local' ? '登录团队账号或创建组织' : trigger === 'connect' ? '管理账号与组织' : '切换组织或本机模式'}
    >
      <Globe size={15} />
      <span className="min-w-0 flex-1 truncate">{trigger === 'connect' && workspaceContext.state !== 'local' ? '切换组织' : label}</span>
      {workspaceContext.pendingCount > 0 && <span>{workspaceContext.pendingCount} 待核对</span>}
    </button>}
    <Modal open={open} onClose={() => requestCloseRef.current?.()} fullScreen ariaLabel="账号与组织">
      <AccountFlow
        open={open}
        initialStep={initialStep ?? (workspaceContext.state === 'local' ? 'organizations' : 'organizations')}
        returnToOnboarding={returnToOnboarding}
        currentConnectionId={workspaceContext.connectionId}
        currentIsLocal={workspaceContext.state === 'local'}
        hostBusy={busy}
        requestCloseRef={requestCloseRef}
        onClose={() => setOpen(false)}
        onSelectWorkspace={selectWorkspace}
        onWorkspaceUpdated={bootstrap}
      />
    </Modal>
  </>
}
