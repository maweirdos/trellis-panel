import type { JSX } from 'react'
import { useCrux } from '../crux/store'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { MachineRuntimeConsole } from './MachineRuntimeConsole'

export function MachinesPage(): JSX.Element {
  const setPage = useApp((state) => state.setPage)

  return (
    <MachineRuntimeConsole
      onOpenModels={() => setPage('models')}
      onOpenGateway={() => setPage('gateway')}
      onOpenDaemonLogs={() => {
        useMy.getState().setSettingsView('daemon')
        setPage('settings')
      }}
      onManageAgents={() => {
        useCrux.getState().setModule('all-agents')
        setPage('crux')
      }}
    />
  )
}
