import { runtimeBodies, type RuntimeBodyMethod } from '../../../shared/daemon-runtime'
import type * as acp from '../../services/acp'
import { DaemonError } from '../errors'
import { ConversationReadServiceMethods } from './admission'

export interface ConversationReadPorts {
  acp: typeof acp
}

export class ConversationReadService {
  constructor(private readonly ports: ConversationReadPorts) {}

  handles(method: RuntimeBodyMethod): boolean {
    return ConversationReadServiceMethods.has(method)
  }

  async execute(method: RuntimeBodyMethod, raw: unknown, root: string): Promise<unknown> {
    switch (method) {
      case 'runtime.sessions': {
        const result = this.ports.acp.listAcpSessions(root, runtimeBodies[method].parse(raw).limit)
        return result.ok ? { ...result, sessions: result.sessions.map(session => ({ ...session, events: [] })) } : result
      }
      case 'runtime.historyList':
        return this.ports.acp.listAcpHistorySessions(root, runtimeBodies[method].parse(raw).input)
      case 'runtime.historySession':
        return this.ports.acp.getAcpHistorySession(root, runtimeBodies[method].parse(raw).sessionId)
      case 'runtime.historyEvents': {
        const request = runtimeBodies[method].parse(raw)
        return this.ports.acp.getAcpHistoryEvents(root, request.sessionId, request.input)
      }
      case 'runtime.piImage': {
        const request = runtimeBodies[method].parse(raw)
        return this.ports.acp.getAcpPiImage(root, request.sessionId, request.imageId)
      }
      default:
        throw new DaemonError('E_INVALID_ARG', 'Unsupported conversation read method.')
    }
  }
}
