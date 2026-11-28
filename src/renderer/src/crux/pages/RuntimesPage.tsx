import type { JSX } from 'react'
import { MachineRuntimeConsole } from '../../pages/MachineRuntimeConsole'
import { useMy } from '../../my/store'
import { useApp } from '../../store'
import { useCrux } from '../store'

export function RuntimesPage(): JSX.Element {
  const setPage = useApp((state) => state.setPage)
  const setModule = useCrux((state) => state.setModule)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MachineRuntimeConsole
        onOpenModels={() => setPage('models')}
        onOpenGateway={() => setPage('gateway')}
        onOpenDaemonLogs={() => {
          useMy.getState().setSettingsView('daemon')
          setPage('settings')
        }}
        onManageAgents={() => setModule('agents')}
      />
    </div>
  )
}
