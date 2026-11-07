import { app } from 'electron'
import type { TeamGovernanceApi } from '../../shared/team-governance'
import { createCruxGovernanceService } from '../services/crux/governance'
import { handle } from './registry'

export type CruxGovernanceChannels = { [K in keyof TeamGovernanceApi]: Parameters<typeof handle>[0] }
/** Root registry/preload owns the channel constants and passes its declared group. */
export function registerCruxGovernanceIpc(channels: CruxGovernanceChannels): void {
  const service = createCruxGovernanceService(app.getPath('userData'))
  handle(channels.list, (_event, input) => service.list(input))
  handle(channels.read, (_event, input) => service.read(input))
  handle(channels.readDocument, (_event, input) => service.readDocument(input))
  handle(channels.command, (_event, input) => service.command(input))
  handle(channels.inputs, (_event, input) => service.inputs(input))
  handle(channels.candidates, (_event, input) => service.candidates(input))
  handle(channels.adopt, (_event, input) => service.adopt(input))
  handle(channels.inputRevision, (_event, input) => service.inputRevision(input))
  handle(channels.pending, (_event, input) => service.pending(input))
  handle(channels.reconcile, (_event, input) => service.reconcile(input))
  handle(channels.retry, (_event, input) => service.retry(input))
}
