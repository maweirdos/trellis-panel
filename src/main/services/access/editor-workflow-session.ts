import { createHash, randomUUID } from 'node:crypto'
import {
  editorWorkflowHookContextSchema, editorWorkflowHookReadySchema, editorWorkflowSessionBindSchema,
  editorWorkflowSessionBindingSchema, type EditorWorkflowHookContext, type EditorWorkflowSessionBind,
  type EditorWorkflowSessionBinding, type EditorWorkflowUnavailableReason
} from '../../../shared/editor-workflow-session'
import {
  executionContextPacketSchema, executionInputResourceViewSchema, executionInputViewSchema,
  type ExecutionInputSource, type ExecutionInputView
} from '../../../shared/team-execution-input'
import { teamExecutionViewSchema, teamTaskIdentity } from '../../../shared/team-task-execution'
import { taskInputCanonical } from '../../../shared/team-canonical'
import { prepareExecutionAgentRules } from '../agent-rules'
import type { withDesktopTeamService } from '../team-desktop'

const MAX_BINDINGS = 64

type Authority = {
  connectionId: string; accountId: string | null; origin: string; pairingId: string; ownerId: string;
  deviceId: string; projectId: string; instanceId: string; epoch: string; authorizationRevision: number
}
type BoundSession = { binding: EditorWorkflowSessionBinding; authority: Authority }

export class EditorWorkflowSessionError extends Error {
  constructor(readonly reason: EditorWorkflowUnavailableReason, message: string) { super(message); this.name = 'EditorWorkflowSessionError' }
}
function reject(reason: EditorWorkflowUnavailableReason, message: string): never { throw new EditorWorkflowSessionError(reason, message) }
function selectionIdentity(value: EditorWorkflowSessionBinding | EditorWorkflowSessionBind): string {
  return taskInputCanonical({ connectionId: value.connectionId, provider: value.provider, nativeSessionId: value.nativeSessionId,
    task: value.task, executionId: value.executionId, generation: value.generation, inputDigest: value.inputDigest,
    rootNodeId: value.rootNodeId, roleNodeIds: value.roleNodeIds })
}

/** Ephemeral read selectors, scoped by the authenticated TPAP credential and exact native identity. */
export class EditorWorkflowSessions {
  private readonly bindings = new Map<string, BoundSession>()
  private lifecycle = 0
  constructor(private readonly service: () => typeof withDesktopTeamService) {}

  close(): void { this.lifecycle++; this.bindings.clear() }

  async bind(credentialKey: string, raw: EditorWorkflowSessionBind): Promise<EditorWorkflowSessionBinding> {
    const input = editorWorkflowSessionBindSchema.parse(raw), key = this.key(credentialKey, input), lifecycle = this.lifecycle
    const previous = this.bindings.get(key)
    this.assertRevision(previous, input)
    if (!previous && this.bindings.size >= MAX_BINDINGS) reject('binding-capacity', 'Native session selection capacity reached; restart the bridge before binding another session')
    const authority = await this.authority(input.connectionId)
    const { expectedRevision: _expectedRevision, ...selection } = input
    const candidate: BoundSession = { authority, binding: editorWorkflowSessionBindingSchema.parse({ ...selection,
      bindingId: previous?.binding.bindingId ?? randomUUID(), revision: (previous?.binding.revision ?? 0) + 1 }) }
    const source = this.source(candidate)
    // Validate bootstrap and every explicitly supplied role; absent roles never acquire a fallback.
    for (const nodeId of new Set([input.rootNodeId, ...Object.values(input.roleNodeIds)])) {
      if (nodeId !== undefined) await this.prepare(source, nodeId)
    }
    await this.assertExecution(candidate)
    if (lifecycle !== this.lifecycle) reject('binding-changed', 'The MCP bridge restarted during binding; bind the native session again')
    const current = this.bindings.get(key)
    this.assertRevision(current, input)
    if (current && selectionIdentity(current.binding) === selectionIdentity(input) && taskInputCanonical(current.authority) === taskInputCanonical(authority)) {
      return editorWorkflowSessionBindingSchema.parse(current.binding)
    }
    if (current !== previous) reject('binding-conflict', 'Native session selection changed during binding; read the latest binding revision before retrying')
    if (current && input.expectedRevision !== current.binding.revision) reject('binding-conflict', 'An old binding revision cannot refresh changed authority')
    if (!current && this.bindings.size >= MAX_BINDINGS) reject('binding-capacity', 'Native session selection capacity reached')
    this.bindings.set(key, candidate)
    return editorWorkflowSessionBindingSchema.parse(candidate.binding)
  }

  async context(credentialKey: string, raw: EditorWorkflowHookContext): Promise<ReturnType<typeof editorWorkflowHookReadySchema.parse>> {
    const input = editorWorkflowHookContextSchema.parse(raw), key = this.key(credentialKey, input), session = this.bindings.get(key)
    if (!session) reject('not-bound', 'This provider native session has no explicit task binding; bind it before reading Hook context')
    await this.assertExecution(session)
    const nodeId = input.role === undefined ? session.binding.rootNodeId : session.binding.roleNodeIds[input.role]
    if (nodeId === undefined) reject('role-unavailable', 'The requested role has no explicit fixed node mapping')
    const prepared = await this.prepare(this.source(session), nodeId)
    await prepared.assertCurrent()
    await this.assertExecution(session)
    if (this.bindings.get(key) !== session) reject('binding-changed', 'Native session selection changed while reading context; retry against the current binding')
    return editorWorkflowHookReadySchema.parse({ ...session.binding, status: 'ready', nodeId,
      additionalContext: prepared.instructions, contextManifest: prepared.manifest })
  }

  private key(credentialKey: string, input: { provider: string; nativeSessionId: string }): string {
    if (!/^[a-f0-9]{64}$/.test(credentialKey)) reject('authority-changed', 'The authenticated TPAP credential scope is unavailable')
    return taskInputCanonical([credentialKey, input.provider, input.nativeSessionId])
  }

  private assertRevision(current: BoundSession | undefined, input: EditorWorkflowSessionBind): void {
    if (!current) {
      if (input.expectedRevision !== 0) reject('binding-conflict', 'First native session binding requires expectedRevision 0')
      return
    }
    const revision = current.binding.revision
    const retry = selectionIdentity(current.binding) === selectionIdentity(input) && input.expectedRevision === revision - 1
    if (input.expectedRevision !== revision && !retry) reject('binding-conflict', 'Native session binding revision changed; an old selection cannot overwrite it')
  }

  private async authority(connectionId: string): Promise<Authority> {
    try {
      return await this.service()(async service => {
        const connection = (await service.connections()).find(item => item.connectionId === connectionId)
        if (!connection || connection.state !== 'active' || connection.accessLocked || !connection.ownerId || !connection.projectId) {
          reject('authority-changed', 'The selected desktop team connection, account or device is unavailable')
        }
        const snapshot = await service.cruxSnapshot(connectionId)
        const current = (await service.connections()).find(item => item.connectionId === connectionId)
        const identity = (item: typeof connection): string => taskInputCanonical([item.connectionId, item.accountId, item.origin, item.pairingId, item.ownerId, item.deviceId, item.projectId, item.state, item.accessLocked])
        if (!current || identity(current) !== identity(connection) || snapshot.projectId !== connection.projectId || snapshot.actor.id !== connection.ownerId) {
          reject('authority-changed', 'The selected desktop team identity changed during authorization')
        }
        return { connectionId, accountId: connection.accountId, origin: connection.origin, pairingId: connection.pairingId,
          ownerId: connection.ownerId, deviceId: connection.deviceId, projectId: connection.projectId,
          instanceId: snapshot.instanceId, epoch: snapshot.epoch, authorizationRevision: snapshot.authorizationRevision }
      })
    } catch (error) {
      if (error instanceof EditorWorkflowSessionError) throw error
      reject('authority-changed', 'Current desktop team authorization could not be verified')
    }
  }

  private async assertExecution(session: BoundSession): Promise<void> {
    const { authority, binding } = session, current = await this.authority(binding.connectionId)
    if (taskInputCanonical(current) !== taskInputCanonical(authority)) reject('authority-changed', 'The bound account, device, service instance, epoch or authorization revision changed; explicitly rebind')
    if (binding.task.instanceId !== authority.instanceId || binding.task.projectId !== authority.projectId) reject('execution-changed', 'The task does not belong to the selected service instance and project')
    try {
      const view = teamExecutionViewSchema.parse(await this.service()(service => service.executionRead({ connectionId: binding.connectionId, task: binding.task })))
      const active = view.active
      if (teamTaskIdentity(view.task) !== teamTaskIdentity(binding.task) || view.epoch !== authority.epoch || view.authorizationRevision !== authority.authorizationRevision
        || view.generation !== binding.generation || !active || teamTaskIdentity(active.task) !== teamTaskIdentity(binding.task)
        || active.executionId !== binding.executionId || active.generation !== binding.generation || active.epoch !== authority.epoch
        || active.actorId !== authority.ownerId || active.deviceId !== authority.deviceId || active.ownership !== 'editor-owned' || active.authority !== 'active') {
        reject('execution-changed', 'The original task, active execution, generation or reporting owner changed')
      }
    } catch (error) {
      if (error instanceof EditorWorkflowSessionError) throw error
      reject('execution-changed', 'The original active execution is unavailable under current authorization')
    }
    await this.assertAuthority(session)
    try {
      const admission = await this.service()(service => service.cutoverCheck({ connectionId: binding.connectionId, task: binding.task }))
      await this.assertAuthority(session)
      if (!admission.admitted || teamTaskIdentity(admission.task) !== teamTaskIdentity(binding.task)) {
        reject('context-unavailable', 'The original task has no current verified cutover installation admission')
      }
    } catch (error) {
      if (error instanceof EditorWorkflowSessionError) throw error
      reject('context-unavailable', 'Current cutover installation admission is unavailable or its configuration/provider scripts changed')
    }
  }

  private async assertAuthority(session: BoundSession): Promise<void> {
    const current = await this.authority(session.binding.connectionId)
    if (taskInputCanonical(current) !== taskInputCanonical(session.authority)) reject('authority-changed', 'Desktop team authority changed while reading the fixed context')
  }

  private assertInput(session: BoundSession, view: ExecutionInputView): void {
    const { binding, authority } = session, { input } = view
    if (view.purpose !== 'use' || teamTaskIdentity(input.task) !== teamTaskIdentity(binding.task) || input.executionId !== binding.executionId
      || input.generation !== binding.generation || input.digest !== binding.inputDigest || input.epoch !== authority.epoch
      || input.actorId !== authority.ownerId || input.deviceId !== authority.deviceId) {
      reject('execution-changed', 'Captured inputs differ from the original task, execution, generation or digest')
    }
  }

  private source(session: BoundSession): ExecutionInputSource {
    const { binding } = session
    let pinned: ExecutionInputView | undefined
    const read = async (selectionId?: string): Promise<unknown> => {
      await this.assertExecution(session)
      const value = await this.service()(service => service.executionInputRead({ connectionId: binding.connectionId, task: binding.task,
        executionId: binding.executionId, ...(selectionId === undefined ? {} : { selectionId }) }))
      await this.assertExecution(session)
      return value
    }
    return {
      read: async () => {
        const view = executionInputViewSchema.parse(await read())
        this.assertInput(session, view)
        if (pinned && taskInputCanonical(view) !== taskInputCanonical(pinned)) reject('context-unavailable', 'Fixed input authority or resource availability changed during composition')
        pinned = view
        return view
      },
      readResource: async selectionId => {
        const expected = pinned?.input.resources.find(resource => resource.selection.id === selectionId)
        if (!expected) reject('context-unavailable', 'Read the captured manifest before reading its exact selected resource')
        const view = executionInputResourceViewSchema.parse(await read(selectionId))
        if (view.inputDigest !== binding.inputDigest || taskInputCanonical(view.resource) !== taskInputCanonical(expected)) reject('context-unavailable', 'The resource differs from the original captured input')
        return view
      }
    }
  }

  private async prepare(source: ExecutionInputSource, nodeId: string): ReturnType<typeof prepareExecutionAgentRules> {
    try {
      const prepared = await prepareExecutionAgentRules({ executionSource: source, nodeId })
      const packet = executionContextPacketSchema.parse(JSON.parse(prepared.instructions))
      if (packet.node.id !== nodeId || prepared.manifest.nodeId !== nodeId) reject('context-unavailable', 'Prepared context does not belong to the explicitly selected node')
      const instructions = packet.sources.find(item => item.selection.required && item.selection.source.kind === 'agent-instructions' && item.selection.source.roleId === packet.node.roleId)
      if (!instructions || instructions.status !== 'full' || !instructions.text?.trim()) reject('context-unavailable', 'The selected bootstrap or role has no complete readable captured instruction body')
      if (createHash('sha256').update(prepared.instructions).digest('hex') !== prepared.manifest.packetDigest) reject('context-unavailable', 'Prepared fixed context packet digest differs')
      return prepared
    } catch (error) {
      if (error instanceof EditorWorkflowSessionError) throw error
      reject('context-unavailable', 'The fixed bootstrap or role context is missing, withdrawn, corrupt or exceeds its required body budget')
    }
  }
}
