import { ipcInvoke } from '../../shared/ipc-channels'
import type { CreationReply } from '../../shared/creation-api'
import { creationService } from '../services/creations'
import { creationFailure } from '../services/creations/service'
import { handle } from './registry'

async function owned<T>(action: () => Promise<T>): Promise<CreationReply<T>> {
  try { return { ok: true, value: await action() } }
  catch (error) { return creationFailure(error) }
}
export function registerCreationsIpc(): void {
  handle(ipcInvoke.creations.list, (_event, input) => owned(() => creationService().list(input)))
  handle(ipcInvoke.creations.get, (_event, input) => owned(() => creationService().get(input)))
  handle(ipcInvoke.creations.command, (_event, input) => owned(() => creationService().command(input)))
  handle(ipcInvoke.creations.recover, (_event, input) => owned(() => creationService().recover(input)))
  handle(ipcInvoke.creations.planCandidate, (_event, input) => owned(() => creationService().planCandidate(input)))
  handle(ipcInvoke.creations.generateCandidate, (_event, input) => owned(() => creationService().generateCandidate(input)))
  handle(ipcInvoke.creations.cancelCandidate, (_event, input) => owned(() => creationService().cancelCandidate(input)))
}
