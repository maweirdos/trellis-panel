import { app } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { HifoxContentService } from '../services/hifox/content-service'
import { handle } from './registry'

export function registerTeamContentIpc(): void {
  const service = new HifoxContentService(app.getPath('userData'))
  handle(ipcInvoke.teamContent.readiness, (_event, input) => service.readiness(input))
  handle(ipcInvoke.teamContent.generate, (_event, input) => service.generate(input))
  handle(ipcInvoke.teamContent.job, (_event, input) => service.job(input))
  handle(ipcInvoke.teamContent.receipt, (_event, input) => service.receipt(input))
  handle(ipcInvoke.teamContent.cancel, (_event, input) => service.cancel(input))
  handle(ipcInvoke.teamContent.listReferences, (_event, input) => service.listReferences(input))
  handle(ipcInvoke.teamContent.config, (_event, input) => service.config(input))
  handle(ipcInvoke.teamContent.configure, (_event, input) => service.configure(input))
  handle(ipcInvoke.teamContent.probe, (_event, input) => service.probe(input))
}
