import { app, dialog } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { HifoxTaskWorkspaceService, type HifoxTaskWorkspaceDependencies } from '../services/hifox/task-workspace'
import { handle } from './registry'

export type HifoxWorkIpcDependencies = Pick<HifoxTaskWorkspaceDependencies, 'getProjectRoot' | 'getProjectGeneration' | 'creationReferences' | 'creationFiles'>

/** Register only in the native host. Supplemental browser hosting has no local-work bridge. */
export function registerHifoxWorkIpc(deps: HifoxWorkIpcDependencies): HifoxTaskWorkspaceService {
  const service = new HifoxTaskWorkspaceService({
    ...deps, dataDir: app.getPath('userData'),
    chooseProjectRoot: async () => {
      const result = await dialog.showOpenDialog({ title: '选择本机 Trellis 项目', properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0] ?? null
    }
  })
  handle(ipcInvoke.hifoxWork.status, (_event, input: unknown) => service.status(input))
  handle(ipcInvoke.hifoxWork.prepare, (_event, input: unknown) => service.prepare(input))
  return service
}
