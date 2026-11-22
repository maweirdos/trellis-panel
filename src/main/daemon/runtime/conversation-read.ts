import { runtimeBodies, type RuntimeBodyMethod } from '../../../shared/daemon-runtime'
import type { AcpConversationDetailSnapshot, AcpConversationEventPage, AcpConversationListSnapshot } from '../../../shared/acp-projections'
import type * as acp from '../../services/acp'
import { AcpControlPlaneCursorError } from '../../services/acp/control-plane-store'
import { DaemonError } from '../errors'
import { ConversationReadServiceMethods } from './admission'

export interface ConversationReadPorts {
  acp: typeof acp
  projections: ConversationProjectionPort
}

export interface ConversationProjectionPort {
  list(root: string, input: unknown): AcpConversationListSnapshot
  detail(root: string, input: unknown): AcpConversationDetailSnapshot | AcpConversationListSnapshot
  events(root: string, input: unknown): AcpConversationEventPage
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
      case 'runtime.conversationProjectionList': {
        const body = runtimeBodies[method].parse(raw)
        return this.ports.projections.list(root, body.input)
      }
      case 'runtime.conversationProjectionDetail': {
        const body = runtimeBodies[method].parse(raw)
        try {
          return this.ports.projections.detail(root, body)
        } catch (error) {
          if (error instanceof AcpControlPlaneCursorError) throw new DaemonError('E_CONFLICT', `Conversation projection reset: ${error.reason}`)
          throw error
        }
      }
      case 'runtime.conversationProjectionEvents': {
        const body = runtimeBodies[method].parse(raw)
        try {
          return this.ports.projections.events(root, body)
        } catch (error) {
          if (error instanceof AcpControlPlaneCursorError) throw new DaemonError('E_CONFLICT', `Conversation projection reset: ${error.reason}`)
          throw error
        }
      }
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
