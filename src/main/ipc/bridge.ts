import { ipcInvoke } from '../../shared/ipc-channels'
import { noProject } from '../../shared/ipc-errors'
import { installTpanel, installTrellisHooks } from '../services/bridge'
import { getSettings } from '../services/store'
import { getProjectRoot, pullPendingFocus } from '../state'
import { handle } from './registry'

export function registerBridgeIpc(): void {
  handle(ipcInvoke.bridge.installTpanel, () => installTpanel(getSettings().bridgeToken))

  handle(ipcInvoke.bridge.pullFocus, () => pullPendingFocus())

  handle(ipcInvoke.bridge.installHooks, () => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return installTrellisHooks(root)
  })
}
