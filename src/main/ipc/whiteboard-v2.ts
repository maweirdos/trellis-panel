import { ipcInvoke } from '../../shared/ipc-channels'
import { z } from 'zod'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import type { CreationReply } from '../../shared/creation-api'
import { whiteboardV2CapabilityInputSchema, whiteboardV2ClientListSchema, whiteboardV2ClientGetSchema, whiteboardV2ClientCommandInputSchema, whiteboardV2ClientRecoverSchema, type WhiteboardV2ClientCommand } from '../../shared/whiteboard-v2-api'
import type { WhiteboardV2Command } from '../../shared/creation-whiteboard-v2'
import { whiteboardV2Service } from '../services/creations'
import { creationFailure } from '../services/creations/service'
import { handle } from './registry'

function bindIntent(command: WhiteboardV2ClientCommand): WhiteboardV2Command {
  switch (command.action) {
    case 'create': return { ...command, kind: 'whiteboard', home: 'personal', spaceId: null }
    case 'publish': return { ...command, reviewerIds: [] }
    case 'annotate': return { ...command, target: { kind: 'general' } }
    default: return command
  }
}

async function owned<T>(action: () => Promise<T>): Promise<CreationReply<T>> {
  try { return { ok: true, value: await action() } }
  catch (error) {
    const failure = creationFailure(error)
    return { ...ipcFail(IpcErrorCode.Unknown, '白板操作未完成'), code: error instanceof z.ZodError ? 'INVALID_INPUT' : failure.code, ...(failure.outcomeUnknown ? { outcomeUnknown: true } : {}) }
  }
}

export function registerWhiteboardV2Ipc(): void {
  handle(ipcInvoke.whiteboardV2.capabilities, (_event, raw) => owned(async () => (await whiteboardV2Service()).capabilities(whiteboardV2CapabilityInputSchema.parse(raw))))
  handle(ipcInvoke.whiteboardV2.list, (_event, raw) => owned(async () => (await whiteboardV2Service()).list(whiteboardV2ClientListSchema.parse(raw))))
  handle(ipcInvoke.whiteboardV2.get, (_event, raw) => owned(async () => (await whiteboardV2Service()).get(whiteboardV2ClientGetSchema.parse(raw))))
  handle(ipcInvoke.whiteboardV2.command, (_event, raw) => owned(async () => {
    const input = whiteboardV2ClientCommandInputSchema.parse(raw)
    return (await whiteboardV2Service()).command({ ...input, command: bindIntent(input.command) })
  }))
  handle(ipcInvoke.whiteboardV2.recover, (_event, raw) => owned(async () => {
    const input = whiteboardV2ClientRecoverSchema.parse(raw)
    return (await whiteboardV2Service()).recover('command' in input ? { ...input, command: bindIntent(input.command) } : input)
  }))
}
