import { app } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { createCruxTaskMaterialsService } from '../services/crux/task-materials'
import { handle } from './registry'

export function registerCruxTaskMaterialsIpc(): void {
  const service = createCruxTaskMaterialsService(app.getPath('userData'))
  handle(ipcInvoke.cruxMaterials.list, (_event, input) => service.list(input))
  handle(ipcInvoke.cruxMaterials.read, (_event, input) => service.read(input))
  handle(ipcInvoke.cruxMaterials.versions, (_event, input) => service.versions(input))
  handle(ipcInvoke.cruxMaterials.submissions, (_event, input) => service.submissions(input))
  handle(ipcInvoke.cruxMaterials.command, (_event, input) => service.command(input))
  handle(ipcInvoke.cruxMaterials.pending, (_event, input) => service.pending(input))
  handle(ipcInvoke.cruxMaterials.reconcile, (_event, input) => service.reconcile(input))
  handle(ipcInvoke.cruxMaterials.retry, (_event, input) => service.retry(input))
}
