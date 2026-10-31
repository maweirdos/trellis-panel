import { app } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { HifoxCodeResourceService } from '../services/hifox/code-resources'
import { handle } from './registry'

export function registerHifoxCodeResourcesIpc(): HifoxCodeResourceService {
  const service = new HifoxCodeResourceService(app.getPath('userData'))
  handle(ipcInvoke.hifoxResources.list, (_event, input) => service.list(input))
  handle(ipcInvoke.hifoxResources.task, (_event, input) => service.task(input))
  handle(ipcInvoke.hifoxResources.command, (_event, input) => service.command(input))
  handle(ipcInvoke.hifoxResources.pending, (_event, input) => service.pending(input))
  handle(ipcInvoke.hifoxResources.reconcile, (_event, input) => service.reconcile(input))
  handle(ipcInvoke.hifoxResources.retry, (_event, input) => service.retry(input))
  return service
}
