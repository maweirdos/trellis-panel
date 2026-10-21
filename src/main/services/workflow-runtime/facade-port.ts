/** Adapter only: native transport, permissions, directory leases and history stay in acp.ts. */
import {
  newAcpSession, listAcpSessions, getAcpHistorySession, getAcpHistoryEvents,
  promptAcpSession, cancelAcpSession, killAcpSession, resumeAcpSession,
  flushAcpHistory, historyPersistence
} from '../acp'
import { observeWorkflowAcp } from './acp-events'
import type { WorkflowAcpPort } from './types'

export function createFacadeWorkflowAcpPort(options: { isCurrent?: () => boolean; projectGeneration?: number } = {}): WorkflowAcpPort {
  return {
    create: newAcpSession, list: listAcpSessions, get: getAcpHistorySession, historyEvents: getAcpHistoryEvents,
    prompt: (root, sessionId, text, input, prepared) => promptAcpSession(root, sessionId, text, input, options.isCurrent, options.projectGeneration ?? 0, prepared),
    cancel: cancelAcpSession, end: killAcpSession, resume: resumeAcpSession,
    flushHistory: flushAcpHistory, persistence: historyPersistence, observe: observeWorkflowAcp
  }
}
