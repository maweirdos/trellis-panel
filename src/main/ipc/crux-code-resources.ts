import { app } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { CruxCodeResourceService } from '../services/crux/code-resources'
import { handle } from './registry'

export function registerCruxCodeResourcesIpc(): CruxCodeResourceService {
  const service = new CruxCodeResourceService(app.getPath('userData'))
  handle(ipcInvoke.cruxResources.list, (_event, input) => service.list(input))
  handle(ipcInvoke.cruxResources.task, (_event, input) => service.task(input))
  handle(ipcInvoke.cruxResources.command, (_event, input) => service.command(input))
  handle(ipcInvoke.cruxResources.pending, (_event, input) => service.pending(input))
  handle(ipcInvoke.cruxResources.reconcile, (_event, input) => service.reconcile(input))
  handle(ipcInvoke.cruxResources.retry, (_event, input) => service.retry(input))
  return service
}
