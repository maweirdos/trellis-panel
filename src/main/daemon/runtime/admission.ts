import {
  RUNTIME_MUTATING_METHODS,
  runtimeBodies,
  type RuntimeMethod,
  type RuntimeBodyMethod,
} from '../../../shared/daemon-runtime'
import { KNOWLEDGE_MUTATIONS as LEGACY_KNOWLEDGE_MUTATIONS, knowledgeRuntimeBody as legacyKnowledgeRuntimeBody } from '../../../shared/daemon-runtime-knowledge'
import { LIFECYCLE_RUNTIME_CONTROLS, LIFECYCLE_SESSION_ADMISSIONS } from '../../../shared/daemon/lifecycle'
import { isBoundedNativeTaskControl } from '../../../shared/native-task-execution'
import type { WorkspaceGrant } from '../../../shared/daemon'
import type { NativeTaskPreparationAuthority } from './task-preparation'
import { DaemonError } from '../errors'

export interface RuntimeDispatchContext {
  workspace?: WorkspaceGrant
  commandId?: string
  native?: Pick<NativeTaskPreparationAuthority, 'actor' | 'assertProduct'>
}

export type RuntimeAdmissionClass =
  | 'read'
  | 'mutation'
  | 'lifecycle-control'
  | 'native-task-control'

export interface RuntimeAdmissionContext {
  root: string
  method: RuntimeBodyMethod
  payload?: unknown
  commandId?: string
  workspace?: WorkspaceGrant
}

export interface RuntimeAdmissionPort {
  assertOwner(): void
  assertAuthority(): void
  assertAdmission?(): void
  assertWorkspaceAdmission?(root: string, method: RuntimeBodyMethod): void
  assertWorkspaceGrant?(grant: WorkspaceGrant): void
}

const GLOBAL_METHODS = new Set<string>([
  'runtime.privateRead',
  'runtime.privateSend',
  'runtime.privateCancel',
  'runtime.privateEnd',
  'runtime.privateRespond',
  'runtime.privateConfigure',
  'runtime.privateRecoverModel',
  'runtime.cruxProgress',
  'runtime.conversationTaskScope',
  'runtime.agents',
  'runtime.setup',
  'runtime.probe',
  'runtime.blob.open',
  'runtime.blob.append',
  'runtime.blob.seal',
  'runtime.blob.read',
  'runtime.blob.release',
  'runtime.command',
])

const CLOSED_ADMISSION_EXEMPTIONS = new Set<string>([
  'runtime.cancel',
  'runtime.end',
  'runtime.privateCancel',
  'runtime.privateEnd',
  'runtime.handoffCancel',
  'runtime.workflow.stop',
  'runtime.workflow.cancelRevision',
])

export function isGlobalRuntimeMethod(method: string): boolean {
  return GLOBAL_METHODS.has(method)
}

export function isRuntimeReadMethod(method: string): boolean {
  return ConversationReadServiceMethods.has(method) || SessionReadServiceMethods.has(method)
}

export const SessionReadServiceMethods = new Set<string>([
  'runtime.sessions',
  'runtime.historyList',
  'runtime.historySession',
  'runtime.historyEvents',
  'runtime.piImage',
  'runtime.conversationProjectionList',
  'runtime.conversationProjectionDetail',
  'runtime.conversationProjectionEvents',
  'runtime.events',
])

export const ConversationReadServiceMethods = new Set<string>([
  'runtime.sessions',
  'runtime.historyList',
  'runtime.historySession',
  'runtime.historyEvents',
  'runtime.piImage',
  'runtime.conversationProjectionList',
  'runtime.conversationProjectionDetail',
  'runtime.conversationProjectionEvents',
])

export class AdmissionService {
  constructor(private readonly ports: RuntimeAdmissionPort) {}

  assertOwner(): void {
    this.ports.assertOwner()
  }

  assertAuthority(): void {
    this.ports.assertAuthority()
  }

  handles(method: RuntimeBodyMethod): boolean {
    return true
  }

  classify(method: RuntimeMethod, payload?: unknown): RuntimeAdmissionClass {
    if (this.isLifecycleControl(method, payload)) return 'lifecycle-control'
    if (this.isMutation(method, payload)) return 'mutation'
    return 'read'
  }

  requiresCommand(method: RuntimeMethod, payload?: unknown): boolean {
    return this.isMutation(method, payload)
  }

  isLifecycleControl(method: RuntimeMethod, payload?: unknown): boolean {
    return LIFECYCLE_RUNTIME_CONTROLS.includes(method) || this.isNativeTaskControl(method, payload)
  }

  isNativeTaskControl(method: RuntimeMethod, payload?: unknown): boolean {
    return isBoundedNativeTaskControl(method, payload)
  }

  closedMutationAllowed(method: RuntimeMethod, payload?: unknown): boolean {
    return this.isNativeTaskControl(method, payload) || CLOSED_ADMISSION_EXEMPTIONS.has(method)
  }

  isMutation(method: RuntimeMethod, payload?: unknown): boolean {
    if (method === 'runtime.workflowCutover') {
      const operation = runtimeBodies['runtime.workflowCutover'].safeParse(payload)
      return operation.success && operation.data.operation !== 'inspect' && operation.data.operation !== 'propose'
    }
    if (method === 'runtime.taskExecution') {
      const operation = runtimeBodies['runtime.taskExecution'].safeParse(payload)
      return operation.success && operation.data.operation !== 'reconcile'
    }
    if (method === 'runtime.taskPreparation') {
      const operation = runtimeBodies['runtime.taskPreparation'].safeParse(payload)
      return operation.success && ['prepare', 'database-delivery'].includes(operation.data.operation)
    }
    if (method === 'runtime.knowledge') {
      const operation = legacyKnowledgeRuntimeBody.safeParse(payload)
      return operation.success && LEGACY_KNOWLEDGE_MUTATIONS.includes(operation.data.operation)
    }
    return RUNTIME_MUTATING_METHODS.includes(method)
  }

  profileScopeAllowed(method: string): boolean {
    return isGlobalRuntimeMethod(method)
  }

  assertIntakeAdmitted(method: RuntimeMethod, payload?: unknown): void {
    if (!this.isLifecycleControl(method, payload)) this.ports.assertAdmission?.()
  }

  assertWorkspaceAdmitted(method: RuntimeBodyMethod, root: string): void {
    if (!LIFECYCLE_RUNTIME_CONTROLS.includes(method)) this.ports.assertWorkspaceAdmission?.(root, method)
  }

  assertValid(root: string, method: RuntimeBodyMethod): boolean {
    this.ports.assertOwner()
    this.ports.assertAuthority()
    this.ports.assertWorkspaceAdmission?.(root, method)
    return true
  }

  assertCommand(method: RuntimeBodyMethod, commandId: string | undefined, payload?: unknown): void {
    if (this.requiresCommand(method, payload) && !commandId) {
      throw new DaemonError('E_INVALID_ARG', 'Runtime mutations require a stable command ID.')
    }
  }

  assertWorkspaceGrant(grant: WorkspaceGrant): void {
    this.ports.assertWorkspaceGrant?.(grant)
  }

  assertSessionAdmissionMethod(method: RuntimeMethod): boolean {
    return LIFECYCLE_SESSION_ADMISSIONS.includes(method)
  }
}
