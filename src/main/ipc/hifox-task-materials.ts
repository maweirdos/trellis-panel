import { app } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { createHifoxTaskMaterialsService } from '../services/hifox/task-materials'
import { handle } from './registry'

export function registerHifoxTaskMaterialsIpc(): void {
  const service = createHifoxTaskMaterialsService(app.getPath('userData'))
  handle(ipcInvoke.hifoxMaterials.list, (_event, input) => service.list(input))
  handle(ipcInvoke.hifoxMaterials.read, (_event, input) => service.read(input))
  handle(ipcInvoke.hifoxMaterials.versions, (_event, input) => service.versions(input))
  handle(ipcInvoke.hifoxMaterials.submissions, (_event, input) => service.submissions(input))
  handle(ipcInvoke.hifoxMaterials.command, (_event, input) => service.command(input))
  handle(ipcInvoke.hifoxMaterials.pending, (_event, input) => service.pending(input))
  handle(ipcInvoke.hifoxMaterials.reconcile, (_event, input) => service.reconcile(input))
  handle(ipcInvoke.hifoxMaterials.retry, (_event, input) => service.retry(input))
}
