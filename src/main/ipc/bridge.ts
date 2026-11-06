import { ipcInvoke } from '../../shared/ipc-channels'
import { installTpanel } from '../services/bridge'
import { getSettings } from '../services/store'
import { pullPendingFocus } from '../state'
import { handle } from './registry'

export function registerBridgeIpc(): void {
  handle(ipcInvoke.bridge.installTpanel, () => installTpanel(getSettings().bridgeToken))

  handle(ipcInvoke.bridge.pullFocus, () => pullPendingFocus())
}
