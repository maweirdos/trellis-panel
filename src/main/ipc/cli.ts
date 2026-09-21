import { ipcInvoke } from '../../shared/ipc-channels'
import { runCli, abortCli } from '../services/cli'
import { getSettings } from '../services/store'
import { getProjectRoot } from '../state'
import { handle } from './registry'
import type { WindowDeps } from './deps'

export function registerCliIpc(deps: WindowDeps): void {
  handle(ipcInvoke.cli.run, (_e, args: string[]) => {
    const win = deps.getMain()
    const root = getProjectRoot()
    if (!win || !root) return -1
    const { cliCommand } = getSettings()
    return runCli(win, root, cliCommand, args)
  })

  handle(ipcInvoke.cli.abort, (_e, runId: number) => abortCli(runId))
}
