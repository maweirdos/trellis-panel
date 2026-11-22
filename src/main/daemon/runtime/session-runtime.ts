import { z } from 'zod'
import { runtimeBodies, type RuntimeBodyMethod } from '../../../shared/daemon-runtime'
import * as acp from '../../services/acp'
import { bindTaskSchema, configureSchema, newSessionSchema, promptOptionsSchema } from '../../services/acp/types'
import {
  checkRequirementPredecessor,
  getWorkflowApplication,
  workflowDesktopTemplates,
  isManagedWorkflowOrigin,
  withOrdinaryConnectionAdmission,
  withOrdinaryWorkflowAdmission,
  withManagedWorkflowAdmission,
} from '../../services/workflow-desktop'
import { readRegular } from '../../services/private-conversations/files'
import { utf8 } from '../../services/private-conversations/requirement-files'
import { requirementPredecessorSchema, requirementTaskOriginSchema } from '../../../shared/conversation-requirements'
import { runRefSchema } from '../../../shared/workflow'
import { ipcFail, IpcErrorCode } from '../../../shared/ipc-errors'
import { DaemonError } from '../errors'
import type { AdmissionService, RuntimeDispatchContext } from './admission'
import type { RuntimeEvents } from './events'

export interface RuntimeSessionPorts {
  admission: AdmissionService
  events: RuntimeEvents
  isClosed(): boolean
}

export class RuntimeSessionService {
  constructor(private readonly ports: RuntimeSessionPorts) {}

  handles(method: RuntimeBodyMethod): boolean {
    return method !== 'runtime.taskExecution'
  }

  async execute(method: RuntimeBodyMethod, raw: unknown, root: string, context: RuntimeDispatchContext): Promise<unknown> {
    this.ports.admission.assertWorkspaceAdmitted(method, root)
    this.ports.admission.assertIntakeAdmitted(method, raw)
    const admission = this.ports.admission
    const valid = (): boolean => admission.assertValid(root, method) && !this.ports.isClosed()
    const connection = <T extends { ok: boolean }>(target: { sessionId?: string; profileId?: string }, action: () => Promise<T>): Promise<T> =>
      withOrdinaryConnectionAdmission(root, target, action)
    switch (method) {
      case 'runtime.profileSave':
        return acp.saveAcpProfile(root, runtimeBodies[method].parse(raw).input)
      case 'runtime.profileDelete':
        return acp.deleteAcpProfile(root, runtimeBodies[method].parse(raw).profileId)
      case 'runtime.historyUpdate': {
        const request = runtimeBodies[method].parse(raw)
        return acp.updateAcpHistorySession(root, request.sessionId, request.input, valid)
      }
      case 'runtime.historyDeletePreview':
        return acp.previewAcpHistoryDeletion(root, runtimeBodies[method].parse(raw).sessionId, valid)
      case 'runtime.historyDelete': {
        const request = runtimeBodies[method].parse(raw)
        return acp.deleteAcpHistorySession(root, request.sessionId, request.input.token, valid)
      }
      case 'runtime.historyRegenerateTitle':
        return acp.regenerateAcpHistoryTitle(root, runtimeBodies[method].parse(raw).sessionId, valid)
      case 'runtime.historyRetry':
        return acp.retryAcpHistorySession(root, runtimeBodies[method].parse(raw).sessionId)
      case 'runtime.handoffPreview': {
        const request = runtimeBodies[method].parse(raw)
        if (await isManagedWorkflowOrigin(root, request.sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再接续此会话')
        return acp.previewAcpSessionHandoff(root, request.sessionId, request.input, valid)
      }
      case 'runtime.handoffCreate': {
        const request = runtimeBodies[method].parse(raw)
        if (await isManagedWorkflowOrigin(root, request.sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再接续此会话')
        return connection({ sessionId: request.sessionId }, () => acp.createAcpSessionHandoff(root, request.sessionId, request.input, valid))
      }
      case 'runtime.handoffStatus': {
        const request = runtimeBodies[method].parse(raw)
        return acp.getAcpSessionHandoff(root, request.sessionId, request.operationId)
      }
      case 'runtime.handoffCancel': {
        const request = runtimeBodies[method].parse(raw)
        return acp.cancelAcpSessionHandoff(root, request.sessionId, request.input)
      }
      case 'runtime.new': {
        const parsed = runtimeBodies[method].parse(raw)
        const input = z.object({
          profileId: z.string().optional(),
          predecessor: requirementPredecessorSchema.optional(),
          predecessorRun: runRefSchema.optional(),
        }).passthrough().parse(parsed.input)
        if (Boolean(input.predecessor) !== Boolean(input.predecessorRun)) throw new DaemonError('E_INVALID_ARG', '后继执行需要原任务与原运行的完整身份')
        return connection({ profileId: input.profileId }, async () => {
          const target = newSessionSchema.parse(parsed.input)
          if (target.taskDir) {
            const data = z.object({ meta: z.object({ conversationRequirement: z.unknown().optional() }).passthrough().nullish() }).passthrough()
              .parse(JSON.parse(utf8(readRegular(root, `.trellis/tasks/${target.taskDir}/task.json`, 512 * 1024).bytes)))
            if (data.meta?.conversationRequirement !== undefined) {
              const original = requirementTaskOriginSchema.parse(data.meta.conversationRequirement)
              if (original.predecessor && (!input.predecessor || !input.predecessorRun || JSON.stringify(original.predecessor) !== JSON.stringify(input.predecessor))) throw new DaemonError('E_DENIED', '后继任务缺少经核验的原运行身份')
              if (!original.predecessor && input.predecessor) throw new DaemonError('E_DENIED', '原任务没有此后继身份')
            } else if (input.predecessor) throw new DaemonError('E_DENIED', '普通任务没有此后继身份')
          } else if (input.predecessor) throw new DaemonError('E_DENIED', '后继运行缺少目标任务')
          if (input.predecessor && input.predecessorRun) await checkRequirementPredecessor(root, input.predecessor, input.predecessorRun)
          return acp.newAcpSession(root, parsed.input)
        })
      }
      case 'runtime.prompt': {
        const parsed = runtimeBodies[method].parse(raw)
        const options = parsed.options === undefined ? undefined : promptOptionsSchema.parse(parsed.options)
        return withOrdinaryWorkflowAdmission(root, parsed.sessionId, options?.expectedConnectionGeneration, admitted =>
          acp.promptAcpSession(root, parsed.sessionId, parsed.text, options, () => valid() && admitted()))
      }
      case 'runtime.cancel':
        return acp.cancelAcpSession(root, runtimeBodies[method].parse(raw).sessionId)
      case 'runtime.end': {
        const request = runtimeBodies[method].parse(raw)
        if (await isManagedWorkflowOrigin(root, request.sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再结束关联会话')
        return acp.killAcpSession(root, request.sessionId)
      }
      case 'runtime.resume': {
        const request = runtimeBodies[method].parse(raw)
        return connection(request, () => acp.resumeAcpSession(root, request.sessionId))
      }
      case 'runtime.configure': {
        const request = runtimeBodies[method].parse(raw)
        return connection(request, () => acp.configureAcpSession(root, request.sessionId, configureSchema.parse(request.input)))
      }
      case 'runtime.recover': {
        const request = runtimeBodies[method].parse(raw)
        return connection(request, () => acp.recoverAcpSessionModel(root, request.sessionId, request.input, valid))
      }
      case 'runtime.bind': {
        const request = runtimeBodies[method].parse(raw)
        if (await isManagedWorkflowOrigin(root, request.sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再更改会话绑定')
        return acp.bindAcpSessionTask(root, request.sessionId, bindTaskSchema.parse(request.input), valid)
      }
      case 'runtime.permission': {
        const request = runtimeBodies[method].parse(raw)
        return acp.respondAcpPermission(root, request.requestId, request.optionId)
      }
      case 'runtime.watcher': {
        const request = runtimeBodies[method].parse(raw)
        acp.routeWatcherEvent(root, request.path, request.event)
        return null
      }
      case 'runtime.notify': {
        acp.routeNotifyRail(root, runtimeBodies[method].parse(raw).text)
        return null
      }
      case 'runtime.materialChange': {
        const request = z.object({
          projectRoot: z.literal(root),
          relativePath: z.string().min(1).max(8192),
          kind: z.enum(['add', 'change', 'unlink']),
        }).passthrough().parse(runtimeBodies[method].parse(raw).material)
        acp.emitAcpMaterialChange(request as unknown as Parameters<typeof acp.emitAcpMaterialChange>[0])
        return null
      }
      case 'runtime.timeline': {
        const request = z.object({
          kind: z.enum(['session-status', 'diagnostic', 'material-change', 'jira-sync']),
          text: z.string().max(32000),
          payload: z.record(z.string(), z.unknown()).optional(),
          taskDir: z.string().max(200).optional(),
        }).strict().parse(runtimeBodies[method].parse(raw).input)
        acp.emitTrellisTimeline(root, request.kind, request.text, request.payload, request.taskDir)
        return null
      }
      case 'runtime.workflow.templates':
        return workflowDesktopTemplates(root)
      case 'runtime.workflow.requirementPredecessor': {
        const request = runtimeBodies[method].parse(raw)
        return checkRequirementPredecessor(root, request.predecessor, request.expectedRun)
      }
      case 'runtime.workflow.isManagedOrigin': {
        const request = runtimeBodies[method].parse(raw)
        return isManagedWorkflowOrigin(root, request.sessionId, request.generation, request.associationOnly)
      }
      case 'runtime.events': {
        const request = runtimeBodies[method].parse(raw)
        const page = this.ports.events.catchUp(root, request.after, request.limit)
        if (!page.resetRequired) return { ...page, sessions: null }
        const result = acp.listAcpSessions(root, 100)
        return {
          cursor: this.ports.events.cursor(),
          events: [],
          resetRequired: true,
          hasMore: false,
          sessions: result.ok ? { ...result, sessions: result.sessions.map(session => ({ ...session, events: [] })) } : result,
        }
      }
      default: {
        if (!method.startsWith('runtime.workflow.')) throw new DaemonError('E_INVALID_ARG', 'Unsupported runtime domain method.')
      }
    }
    const application = await getWorkflowApplication(root)
    switch (method) {
      case 'runtime.workflow.preview': return application.preview(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.start': {
        const request = runtimeBodies[method].parse(raw)
        return withManagedWorkflowAdmission(root, () => application.start(request), request)
      }
      case 'runtime.workflow.snapshot': return application.snapshot(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.events': return application.events(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.stop': return application.stop(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.previewRevision': return application.previewRevision(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.acceptRevision': return application.acceptRevision(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.cancelRevision': return application.cancelRevision(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.revisionStatus': return application.revisionStatus(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.inspectWorkspaceRecovery': return application.inspectWorkspaceRecovery(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.readArtifact': return application.readArtifact(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.readRecoveryArtifact': return application.readRecoveryArtifact(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.resolveMaterialOwner': return application.resolveMaterialOwner(runtimeBodies[method].parse(raw).relativePath)
      default: throw new DaemonError('E_INVALID_ARG', 'Unsupported runtime domain method.')
    }
  }
}
