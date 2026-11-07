import { z } from 'zod'
import { cruxSnapshotSchema } from '../../../src/shared/crux-schema'
import { teamTaskIdentity, type TeamExecutionRecord, type TeamTaskRef } from '../../../src/shared/team-task-execution'
import { taskInputCanonical } from '../../../src/shared/team-task-inputs'
import { TEAM_MAX_RESPONSE_BYTES } from '../../../src/shared/team-platform'
import { executionInputAgentContentSchema, executionInputAgentDigestText, executionInputCommandSchema, executionInputDigestText, executionInputSchema,
  executionInputReceiptSchema, executionInputViewSchema, executionInputResourceViewSchema,
  type ExecutionInput, type ExecutionInputCommand, type ExecutionInputReceipt, type ExecutionInputResource } from '../../../src/shared/team-execution-input'
import { governanceHash as hash, governanceFail as fail, governanceStored as stored, type GovernanceHost } from './governance'
import type { TeamTaskExecutions } from './task-executions'
import type { TeamTaskInputs } from './task-inputs'
import type { StoreActor, StorePrincipal } from './store-types'

type Host = GovernanceHost & { event(actorId: string, task: TeamTaskRef, executionId: string, commandId: string): void }
export class TeamExecutionInputs {
  constructor(private readonly host: Host, private readonly inputs: TeamTaskInputs, private readonly executions: TeamTaskExecutions) {}

  private load(principal: StorePrincipal, task: TeamTaskRef, executionId: string): ExecutionInput {
    this.executions.historyForPrincipal(principal, task, executionId)
    const row = this.host.get('SELECT recordJson FROM team_task_execution_inputs WHERE executionId=?', executionId)
    if (!row) fail('EXECUTION_INPUT_UNAVAILABLE', 'Execution has no captured stage input', 404)
    const input = stored(executionInputSchema, row.recordJson)
    if (input.executionId !== executionId || teamTaskIdentity(input.task) !== teamTaskIdentity(task) || hash(executionInputDigestText(input)) !== input.digest) fail('CORRUPT_STORE', 'Captured input identity failed verification', 503)
    this.inputs.fixedExecutionBundle(principal, task, input.inputBundle)
    return input
  }
  private fixed(principal: StorePrincipal, input: ExecutionInput, resource: ExecutionInputResource): { text: string; withdrawn: boolean } {
    const source = resource.selection.source
    if (source.kind === 'confirmed-artifact' || source.kind === 'confirmed-creation') {
      const value = this.executions.resolveOutput(principal, input.task, source)
      if (value.bodyDigest !== resource.bodyDigest || value.byteLength !== resource.byteLength || value.title !== resource.title) fail('CORRUPT_STORE', 'Original predecessor artifact changed', 503)
      return value
    }
    if (source.kind === 'governance' || source.kind === 'confirmed-document') {
      const value = this.inputs.fixedExecutionResource(principal, input.task, source)
      if (value.bodyDigest !== resource.bodyDigest || value.byteLength !== resource.byteLength || value.title !== resource.title) fail('CORRUPT_STORE', 'Original fixed resource changed', 503)
      return value
    }
    const bytes = this.host.body(resource.bodyDigest), text = bytes.toString('utf8')
    if (bytes.length !== resource.byteLength || hash(bytes) !== resource.bodyDigest || !Buffer.from(text, 'utf8').equals(bytes)) fail('CORRUPT_STORE', 'Captured Agent or skill bytes failed verification', 503)
    return { text, withdrawn: false }
  }
  /** Called by finalize and every ordinary business delivery path; no native fact is invented. */
  assertUsable(principal: StorePrincipal, execution: TeamExecutionRecord): void {
    if (!this.host.get('SELECT executionId FROM team_task_execution_inputs WHERE executionId=?', execution.executionId)) return
    const input = this.load(principal, execution.task, execution.executionId)
    if (input.epoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Captured input belongs to the original service epoch')
    for (const resource of input.resources) if (this.fixed(principal, input, resource).withdrawn && resource.selection.required) fail('EXECUTION_INPUT_WITHDRAWN', 'A required fixed version was withdrawn')
  }
  read(actor: StoreActor, task: TeamTaskRef, executionId: string, purpose: 'history' | 'use'): z.infer<typeof executionInputViewSchema> {
    const principal = this.host.authenticate(actor), input = this.load(principal, task, executionId)
    if (purpose === 'use') {
      this.executions.assertInputOwner(actor, task, executionId, input.generation)
      this.assertUsable(principal, this.executions.history(actor, task, executionId))
    }
    const head = this.host.get('SELECT currentBundleId FROM task_input_heads WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=?', task.projectId, task.taskId, task.spaceId, task.taskCreatedAt)
    const row = head?.currentBundleId ? this.host.get('SELECT recordJson FROM task_input_bundles WHERE bundleId=?', head.currentBundleId) : null
    const current = row ? stored(z.object({ bundleId: z.string(), revision: z.number(), digest: z.string() }).passthrough(), row.recordJson) : null
    return executionInputViewSchema.parse({ contractVersion: 2, purpose, input, currentBundle: current ? { bundleId: current.bundleId, revision: current.revision, digest: current.digest } : null,
      resources: input.resources.map(resource => ({ selectionId: resource.selection.id, status: this.fixed(principal, input, resource).withdrawn ? 'withdrawn' : 'available' })) })
  }
  readResource(actor: StoreActor, task: TeamTaskRef, executionId: string, purpose: 'history' | 'use', selectionId: string): z.infer<typeof executionInputResourceViewSchema> {
    const view = this.read(actor, task, executionId, purpose), resource = view.input.resources.find(item => item.selection.id === selectionId)
    if (!resource) fail('EXECUTION_INPUT_UNAVAILABLE', 'Resource is not a member of the captured input', 404)
    const value = this.fixed(this.host.authenticate(actor), view.input, resource)
    return executionInputResourceViewSchema.parse({ contractVersion: 2, inputDigest: view.input.digest, resource, status: value.withdrawn ? 'withdrawn' : 'available', text: value.text })
  }
  private owner(actor: StoreActor, command: ExecutionInputCommand): TeamExecutionRecord {
    const principal = this.host.authenticate(actor)
    if (principal.person.userId !== command.expectedActorId || principal.deviceId !== command.expectedDeviceId) fail('EXECUTION_FORBIDDEN', 'Original account and device are required', 403)
    if (command.expectedEpoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Original service epoch changed')
    return this.executions.assertInputOwner(actor, command.task, command.expectedExecutionId, command.expectedGeneration)
  }
  private receipt(actor: StoreActor, command: ExecutionInputCommand, raw: unknown): ExecutionInputReceipt {
    const principal = this.host.authenticate(actor), receipt = stored(executionInputReceiptSchema, raw)
    const execution = this.executions.history(actor, command.task, receipt.executionId)
    // Receipt access retains exact original credential ownership after release/handoff.
    const row = this.host.get('SELECT actorJson FROM team_task_executions WHERE executionId=?', execution.executionId)
    if (!row || taskInputCanonical(stored(z.object({ kind: z.string(), credentialHash: z.string() }).strict(), row.actorJson)) !== taskInputCanonical(actor)
      || principal.person.userId !== command.expectedActorId || principal.deviceId !== command.expectedDeviceId) fail('EXECUTION_FORBIDDEN', 'Original reporting owner is required', 403)
    if (receipt.requestDigest !== hash(taskInputCanonical(command)) || receipt.commandId !== command.commandId || receipt.epoch !== command.expectedEpoch
      || receipt.epoch !== this.host.identity().epoch || receipt.actorId !== principal.person.userId || receipt.deviceId !== principal.deviceId
      || receipt.executionId !== command.expectedExecutionId || receipt.generation !== command.expectedGeneration || teamTaskIdentity(receipt.task) !== teamTaskIdentity(command.task)) fail('COMMAND_CONFLICT', 'Captured input receipt does not match the original command')
    const input = this.load(principal, command.task, receipt.executionId)
    if (input.digest !== receipt.inputDigest) fail('CORRUPT_STORE', 'Captured input receipt changed', 503)
    return receipt
  }
  reconcile(actor: StoreActor, raw: unknown): ExecutionInputReceipt | null {
    const command = executionInputCommandSchema.parse(raw), principal = this.host.authenticate(actor)
    this.executions.history(actor, command.task, command.expectedExecutionId)
    const row = this.host.get('SELECT kind,resultJson FROM commands WHERE userId=? AND commandId=?', principal.person.userId, command.commandId)
    if (!row) { this.owner(actor, command); return null }
    if (row.kind !== 'executionInputCommand') fail('COMMAND_CONFLICT', 'UUID belongs to another command')
    return this.receipt(actor, command, row.resultJson)
  }
  command(actor: StoreActor, raw: unknown): { status: 'committed' | 'duplicate'; commandId: string; result: ExecutionInputReceipt } {
    const command = executionInputCommandSchema.parse(raw)
    return this.host.mutation(actor, command.commandId, 'executionInputCommand', command,
      principal => { this.executions.history(actor, command.task, command.expectedExecutionId); if (command.expectedEpoch !== this.host.identity().epoch || principal.person.userId !== command.expectedActorId || principal.deviceId !== command.expectedDeviceId) fail('EXECUTION_FORBIDDEN', 'Original epoch, actor and device are required', 403) },
      () => this.capture(actor, command), (_principal, receipt) => { this.receipt(actor, command, receipt) })
  }
  private capture(actor: StoreActor, command: ExecutionInputCommand): ExecutionInputReceipt {
    const execution = this.owner(actor, command), principal = this.host.authenticate(actor)
    if (this.host.get('SELECT executionId FROM team_task_execution_inputs WHERE executionId=?', execution.executionId)) fail('EXECUTION_INPUT_ALREADY_CAPTURED', 'An execution input is immutable; create a successor at the owning boundary')
    const bundle = this.inputs.fixedExecutionBundle(principal, command.task, execution.inputBundle), settings = bundle.template?.settings
    if (!settings || settings.kind !== 'workflow-template' || !settings.execution) fail('EXECUTION_DEFINITION_REQUIRED', 'Adopt a published portable workflow before capturing input')
    const definition = settings.execution
    if (!definition.nodes.some(node => node.id === execution.nodeId && node.kind !== 'gate')) fail('EXECUTION_NODE_CONFLICT', 'Original execution node is not in the captured output-producing definition')
    if (definition.definitionId !== execution.workflow.definitionId || definition.revision !== execution.workflow.revision || hash(taskInputCanonical(definition)) !== execution.workflow.digest) fail('EXECUTION_DEFINITION_CONFLICT', 'Execution does not name its adopted portable definition')
    if (definition.roles.length !== command.roles.length || definition.roles.some(role => !command.roles.some(selected => selected.roleId === role.id))) fail('EXECUTION_INPUT_ROLE_CONFLICT', 'Capture the exact logical role set')
    const row = this.host.get('SELECT snapshotJson FROM crux_workspaces WHERE projectId=?', command.task.projectId)
    if (!row) fail('EXECUTION_INPUT_UNAVAILABLE', 'Original Agent configuration is unavailable', 404)
    const snapshot = stored(cruxSnapshotSchema, row.snapshotJson), pending = new Map<string, Buffer>()
    const captureBody = (text: string): { bodyDigest: string; byteLength: number } => {
      const bytes = Buffer.from(text, 'utf8'), bodyDigest = hash(bytes)
      if (bytes.toString('utf8') !== text || bytes.length > 128 * 1024) fail('EXECUTION_INPUT_TOO_LARGE', 'Captured Agent or skill must be exact UTF-8 within 128 KiB', 413)
      pending.set(bodyDigest, bytes); return { bodyDigest, byteLength: bytes.length }
    }
    const agents = command.roles.map(selected => {
      const agent = snapshot.agents.find(item => item.id === selected.agentId && item.spaceId === command.task.spaceId && item.enabled && !item.archived)
      if (!agent || new Set(agent.skillIds).size !== agent.skillIds.length) fail('EXECUTION_INPUT_ROLE_CONFLICT', 'Selected Agent is unavailable')
      const content = executionInputAgentContentSchema.parse({ agentId: agent.id, instructions: agent.instructions, skills: agent.skillIds.map(skillId => {
        const skill = snapshot.skills.find(item => item.id === skillId && (!item.spaceId || item.spaceId === command.task.spaceId))
        if (!skill) fail('EXECUTION_INPUT_SKILL_UNAVAILABLE', 'A selected skill cannot be resolved')
        return { skillId, name: skill.name, description: skill.description ?? null, content: skill.content }
      }) })
      const digest = hash(executionInputAgentDigestText(content))
      if (digest !== selected.expectedDigest) fail('EXECUTION_INPUT_AGENT_CHANGED', 'Agent or resolved skills changed after selection')
      return { roleId: selected.roleId, agentId: agent.id, digest, instructions: captureBody(content.instructions),
        skills: content.skills.map(skill => ({ skillId: skill.skillId, name: skill.name, description: skill.description, ...captureBody(skill.content) })) }
    })
    if ([...pending.values()].reduce((total, bytes) => total + bytes.length, 0) > 1024 * 1024) fail('EXECUTION_INPUT_TOO_LARGE', 'Captured Agent/skill input exceeds one MiB', 413)
    const predecessor = execution.predecessorExecutionId ? this.executions.history(actor, command.task, execution.predecessorExecutionId) : null
    const resources: ExecutionInputResource[] = command.selections.map(selection => {
      const node = definition.nodes.find(item => item.id === selection.nodeId)
      if (!node || node.kind !== 'agent' || node.phaseId !== selection.phaseId || node.stage !== selection.stage) fail('EXECUTION_INPUT_SELECTION_CONFLICT', 'Selection does not belong to its declared stage/node')
      const source = selection.source
      if (source.kind === 'confirmed-artifact' || source.kind === 'confirmed-creation') {
        if (predecessor?.finalization?.outcome !== 'completed' || !predecessor.finalization.outputs.some(item => taskInputCanonical(item) === taskInputCanonical(source))) fail('EXECUTION_INPUT_SELECTION_CONFLICT', 'Resource is not an exact confirmed predecessor output')
        const value = this.executions.resolveOutput(principal, command.task, source)
        if (selection.required && value.withdrawn) fail('EXECUTION_INPUT_WITHDRAWN', 'Required predecessor output was withdrawn')
        return { selection, title: value.title, bodyDigest: value.bodyDigest, byteLength: value.byteLength }
      }
      if (source.kind === 'governance' || source.kind === 'confirmed-document') {
        if (source.kind === 'governance' ? ![...bundle.rules, ...(bundle.template ? [bundle.template] : [])].some(item => item.packageId === source.packageId && item.versionId === source.versionId)
          : !bundle.documents.some(item => item.documentId === source.documentId && item.versionId === source.versionId)
            && !predecessor?.finalization?.outputs.some(item => item.kind === 'confirmed-document' && item.documentId === source.documentId && item.versionId === source.versionId)) fail('EXECUTION_INPUT_SELECTION_CONFLICT', 'Resource is not adopted or a supported fixed predecessor output')
        const value = this.inputs.fixedExecutionResource(principal, command.task, source)
        const prior = source.kind === 'confirmed-document' && predecessor?.finalization?.outputs.find(item => item.kind === 'confirmed-document' && item.documentId === source.documentId && item.versionId === source.versionId)
        if (prior && prior.bodyDigest !== value.bodyDigest) fail('EXECUTION_DEPENDENCY_CONFLICT', 'Original predecessor digest changed')
        if (selection.required && value.withdrawn) fail('EXECUTION_INPUT_WITHDRAWN', 'Required source was withdrawn')
        return { selection, title: value.title, bodyDigest: value.bodyDigest, byteLength: value.byteLength }
      }
      if (selection.required && source.roleId !== node.roleId) fail('EXECUTION_INPUT_ROLE_CONFLICT', 'Required Agent baseline must belong to this node role')
      const agent = agents.find(item => item.roleId === source.roleId)
      if (!agent) fail('EXECUTION_INPUT_ROLE_CONFLICT', 'Selected role has no captured Agent')
      if (source.kind === 'agent-instructions') return { selection, title: 'Agent instructions', ...agent.instructions }
      const skill = agent.skills.find(item => item.skillId === source.skillId)
      if (!skill) fail('EXECUTION_INPUT_SKILL_UNAVAILABLE', 'Skill is not bound to the captured Agent')
      return { selection, title: skill.name, bodyDigest: skill.bodyDigest, byteLength: skill.byteLength }
    })
    for (const node of definition.nodes) {
      if (node.kind !== 'agent') continue
      const selected = resources.filter(item => item.selection.nodeId === node.id)
      if (selected.length > 24) fail('EXECUTION_INPUT_TOO_LARGE', 'A stage supports at most 24 sources', 413)
      const agent = agents.find(item => item.roleId === node.roleId)
      if (!agent || !selected.some(item => item.selection.required && item.selection.source.kind === 'agent-instructions' && item.selection.source.roleId === node.roleId)) fail('EXECUTION_INPUT_REQUIRED', 'Each stage requires its captured Agent instructions')
      for (const skill of agent.skills) if (!selected.some(item => item.selection.required && item.selection.source.kind === 'skill' && item.selection.source.roleId === node.roleId && item.selection.source.skillId === skill.skillId)) fail('EXECUTION_INPUT_REQUIRED', 'Each stage requires all captured bound skills')
      for (const rule of [...bundle.rules.filter(item => item.settings.kind === 'rule' && item.settings.obligation === 'required'), ...(bundle.template ? [bundle.template] : [])]) {
        if (!selected.some(item => item.selection.required && item.selection.source.kind === 'governance' && item.selection.source.packageId === rule.packageId && item.selection.source.versionId === rule.versionId)) fail('EXECUTION_INPUT_REQUIRED', 'Each stage requires the adopted required rules and template')
      }
    }
    const content = { contractVersion: 2 as const, executionId: execution.executionId, task: command.task, epoch: execution.epoch, generation: execution.generation,
      actorId: execution.actorId, deviceId: execution.deviceId, inputBundle: { bundleId: bundle.bundleId, revision: bundle.revision, digest: bundle.digest }, workflow: execution.workflow, definition, agents, resources, capturedAt: Date.now() }
    const input = executionInputSchema.parse({ ...content, digest: hash(taskInputCanonical(content)) })
    // Expanded Agent/skill descriptors and JSON escaping count toward reads,
    // independently of capture-command and body quotas. Reserve worker framing
    // and the largest future current-bundle revision before any blob/row write.
    const readEnvelope = { contractVersion: 2, purpose: 'history', input,
      currentBundle: { ...input.inputBundle, revision: Number.MAX_SAFE_INTEGER },
      resources: input.resources.map(resource => ({ selectionId: resource.selection.id, status: 'unavailable' })) }
    if (Buffer.byteLength(JSON.stringify(readEnvelope), 'utf8') > TEAM_MAX_RESPONSE_BYTES - 64 * 1024) fail('EXECUTION_INPUT_TOO_LARGE', 'Captured input metadata exceeds its recoverable response budget', 413)
    for (const [bodyDigest, bytes] of pending) {
      if (!this.host.get('SELECT bodyDigest FROM blobs WHERE bodyDigest=?', bodyDigest)) {
        const usage = this.host.get('SELECT COALESCE(SUM(byteLength),0) AS bytes FROM blobs')
        if (!usage || typeof usage.bytes !== 'number' || usage.bytes + bytes.length > 1024 * 1024 * 1024) fail('CAPACITY_EXCEEDED', 'Team blob capacity reached', 507)
      }
      this.host.persistBody(bytes, bodyDigest)
      this.host.run('INSERT INTO blobs(bodyDigest,byteLength,createdAt) VALUES(?,?,?) ON CONFLICT(bodyDigest) DO NOTHING', bodyDigest, bytes.length, Date.now())
    }
    this.host.run('INSERT INTO team_task_execution_inputs(executionId,recordJson) VALUES(?,?)', execution.executionId, JSON.stringify(input))
    this.host.event(execution.actorId, command.task, execution.executionId, command.commandId)
    return executionInputReceiptSchema.parse({ contractVersion: 2, commandId: command.commandId, task: command.task, epoch: execution.epoch,
      actorId: execution.actorId, deviceId: execution.deviceId, executionId: execution.executionId, generation: execution.generation,
      inputDigest: input.digest, requestDigest: hash(taskInputCanonical(command)), committedAt: Date.now() })
  }
}
