import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { ProcessOwner, WorkspaceGrant } from '../../../shared/daemon'
import { nativeTaskBindingSchema, nativeTaskPreparationRequestSchema, type NativeTaskBinding, type NativeTaskPrepare, type NativeTaskPreparationRequest } from '../../../shared/native-task-preparation'
import { executionInputDigestText, type ExecutionInputView } from '../../../shared/team-execution-input'
import { teamTaskIdentity, type TeamExecutionRecord } from '../../../shared/team-task-execution'
import type { TeamTaskRef } from '../../../shared/team-task-execution'
import { teamTaskCodeResourceDtoSchema, type TeamTaskCodeResourceDto } from '../../../shared/team-code-resources'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { executionArtifactDigestText } from '../../../shared/team-execution-artifacts'
import type { TeamContentRequest } from '../../../shared/team-content-transport'
import { DaemonError } from '../errors'
import { readBounded, writeExclusiveAtomic } from '../files'
import { sameOwner } from '../native'
import { TaskExecutionTransport } from '../../services/team-platform/task-execution-transport'
import { ExecutionInputTransport } from '../../services/team-platform/execution-input-transport'
import type { NativeContentPin } from '../../services/team-platform/content-transport'
import { inspectCruxWorkExecutionProject, cruxWorkProjectIdentity } from '../../services/crux/work-project'
import { verifyHandoffSource } from '../../services/crux/task-outputs/handoff-source'
import { resolveWorkcopy, assertWorkcopyObservation } from '../../services/workcopy-use/identity'
import type { WorkcopyUseRegistry } from '../../services/workcopy-use/registry'
import { claimWorkspaceAdmission } from '../../services/workflow-admission'
import type { WorkcopyIdentity } from '../../../shared/workcopy-use'
import type { WorkspaceAdmission } from '../../services/workflow-admission'
import type { ExecutionInputSource } from '../../../shared/team-execution-input'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const equal = (a: unknown, b: unknown): boolean => taskInputCanonical(a) === taskInputCanonical(b)
const MAX_MATERIAL_BYTES = 16 * 1024 * 1024
const MAX_BINDING_BYTES = 2 * 1024 * 1024
function conflict(message: string): never { throw new DaemonError('E_CONFLICT', message) }
const executionRequest = (request: TeamContentRequest) => <S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.output<S>> =>
  request(path, schema, body === undefined ? undefined : z.record(z.string(), z.unknown()).parse(body))

/** Supplied only by the existing authenticated native dispatcher, never parsed from a body. */
export interface NativeTaskPreparationAuthority {
  actor: ProcessOwner
  grant: WorkspaceGrant
  assertProduct(): void
}
export interface NativeTaskPreparationPorts {
  directory: string
  workcopies: WorkcopyUseRegistry
  assertOwner(): void
  assertCurrent(grant: WorkspaceGrant): void
  withTransport<T>(pin: NativeContentPin, assertCurrent: () => Promise<void>, action: (request: TeamContentRequest) => Promise<T>, task: TeamTaskRef): Promise<T>
  assertLegacyAvailable(root: string): Promise<void>
}

/** Preparation owns no engine, native shutdown, business claim or scheduler. */
export class NativeTaskPreparation {
  private readonly directory: string
  constructor(private readonly ports: NativeTaskPreparationPorts) {
    this.directory = join(realpathSync.native(ports.directory), 'native-task-preparations')
  }
  private assertStorage(root: string): void {
    const within = (parent: string, child: string): boolean => {
      const path = relative(parent, child)
      return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')
    }
    const workspace = resolveWorkcopy(root).canonicalRoot
    if (within(workspace, this.directory) || within(this.directory, root)) throw new DaemonError('E_DENIED', 'Native preparation storage must be outside the engineering workspace.')
    if (existsSync(this.directory) && (lstatSync(this.directory).isSymbolicLink() || realpathSync.native(this.directory) !== this.directory)) throw new DaemonError('E_DENIED', 'Native preparation storage cannot be redirected.')
  }
  private read(id: string): NativeTaskBinding {
    const directory = join(this.directory, id)
    if (lstatSync(directory).isSymbolicLink() || realpathSync.native(directory) !== directory) throw new DaemonError('E_DENIED', 'Original preparation directory was redirected.')
    const file = join(directory, 'binding.json')
    if (lstatSync(file).nlink !== 1) throw new DaemonError('E_DENIED', 'Original preparation metadata cannot have hardlinks.')
    const binding = nativeTaskBindingSchema.parse(JSON.parse(readBounded(file, MAX_BINDING_BYTES)))
    if (binding.preparationId !== id || binding.directory !== directory) throw new DaemonError('E_DENIED', 'Original preparation storage identity changed.')
    for (const name of ['inputs', 'outputs']) {
      const path = join(directory, name), stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== path) throw new DaemonError('E_DENIED', 'Original material directory cannot be redirected.')
    }
    return binding
  }
  /** Also runs before RuntimeCommands can return a cached original receipt. */
  assertAuthority(root: string, raw: NativeTaskPreparationRequest, authority: NativeTaskPreparationAuthority): void {
    const request = nativeTaskPreparationRequestSchema.parse(raw)
    this.ports.assertOwner()
    if (request.operation !== 'inspect') this.ports.assertCurrent(authority.grant)
    if (root !== authority.grant.root) throw new DaemonError('E_DENIED', 'Preparation root differs from the authenticated workspace grant.')
    this.assertStorage(root)
    const file = join(this.directory, request.preparationId, 'binding.json')
    const stored = request.operation !== 'prepare' || existsSync(file) ? this.read(request.preparationId) : undefined
    if (stored && (!sameOwner(stored.nativeOwner, authority.actor) || stored.root !== root || !equal(stored.grant, authority.grant))) throw new DaemonError('E_DENIED', 'Original preparation belongs to another native process or grant.')
    const input = request.operation === 'prepare' ? request : stored?.request
    if (!input) throw new DaemonError('E_DENIED', 'Original native binding is unavailable.')
    if (input.origin === 'product' ? input.ownership !== 'product-managed' : input.ownership !== 'editor-owned') throw new DaemonError('E_DENIED', 'Preparation origin differs from its ownership mode.')
    if (request.operation !== 'inspect' && input.ownership === 'product-managed') authority.assertProduct()
  }
  /** Generic command inspection must retain a preparation's original process boundary. */
  assertReceiptAuthority(root: string, preparationId: string, authority?: NativeTaskPreparationAuthority): void {
    const request = nativeTaskPreparationRequestSchema.parse({ operation: 'inspect', preparationId })
    if (!authority) throw new DaemonError('E_DENIED', 'Original preparation receipts require their authenticated native process and workspace grant.')
    this.assertAuthority(root, request, authority)
  }
  async execute(root: string, raw: NativeTaskPreparationRequest, authority: NativeTaskPreparationAuthority,
    handoff?: (binding: NativeTaskBinding, admission: WorkspaceAdmission, releasePreparation: () => void) => void): Promise<NativeTaskBinding> {
    const request = nativeTaskPreparationRequestSchema.parse(raw)
    // Copy the authenticated capture before any await. Bodies cannot provide these facts.
    const original = { actor: structuredClone(authority.actor), grant: structuredClone(authority.grant), assertProduct: authority.assertProduct.bind(authority) }
    this.assertAuthority(root, request, original)
    let stored: NativeTaskBinding | undefined
    if (request.operation !== 'prepare' || existsSync(join(this.directory, request.preparationId, 'binding.json'))) {
      stored = this.read(request.preparationId)
      if (!sameOwner(stored.nativeOwner, original.actor) || stored.root !== root || !equal(stored.grant, original.grant)) throw new DaemonError('E_DENIED', 'Only the original native owner and directory grant may inspect this binding.')
      if (request.operation === 'inspect') return stored
      if (request.operation === 'prepare' && !equal(stored.request, request)) conflict('Preparation UUID belongs to a different original intent.')
    }
    const input = request.operation === 'prepare' ? request : stored?.request
    if (!input) throw new DaemonError('E_DENIED', 'Original preparation is unavailable.')
    if (input.origin === 'product' ? input.ownership !== 'product-managed' : input.ownership !== 'editor-owned') throw new DaemonError('E_DENIED', 'Preparation origin differs from its native ownership mode.')
    if (input.ownership === 'product-managed') original.assertProduct()
    const directoryIdentity = cruxWorkProjectIdentity(root), workcopy = resolveWorkcopy(root)
    if (stored && stored.directoryIdentity !== directoryIdentity) conflict('Original selected directory was replaced.')
    assertWorkcopyObservation(workcopy, input.expected.workcopy)
    const admission = claimWorkspaceAdmission(workcopy.canonicalRoot, 'managed', undefined, { projectRoot: root })
    let lease: ReturnType<WorkcopyUseRegistry['acquire']> | undefined, handedOff = false
    const guard = (): void => {
      this.ports.assertOwner(); this.ports.assertCurrent(original.grant)
      if (!admission.isCurrent() || original.grant.root !== root || realpathSync.native(root) !== root || cruxWorkProjectIdentity(root) !== directoryIdentity) conflict('Original physical directory or workspace admission changed.')
      if (input.ownership === 'product-managed') original.assertProduct()
      const actual = lease ? this.ports.workcopies.assertHeld(root, lease.token, lease.owner) : resolveWorkcopy(root)
      assertWorkcopyObservation(actual, workcopy)
    }
    const checked = async <T>(action: () => Promise<T>): Promise<T> => { guard(); const value = await action(); guard(); return value }
    try {
      guard()
      lease = this.ports.workcopies.acquire(root, { kind: 'tree-change', expected: { id: workcopy.id, revision: workcopy.revision },
        owner: { kind: 'git', id: input.preparationId, generation: randomUUID(), label: 'Prepare platform task', taskKey: teamTaskIdentity(input.task) } })
      await checked(() => this.ports.assertLegacyAvailable(root))
      const verified = await checked(() => this.ports.withTransport(input.pin, async () => guard(), async requestTransport => {
        const readRequest = <S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.output<S>> => {
          if (body !== undefined) throw new DaemonError('E_DENIED', 'Native preparation cannot submit team mutations.')
          return requestTransport(path, schema)
        }
        const taskTransport = new TaskExecutionTransport(input.task, input.pin.actorId, input.pin.deviceId, readRequest)
        const source = new ExecutionInputTransport(input.task, input.expected.executionId, input.pin.actorId, input.pin.deviceId, readRequest).source('use')
        const active = await checked(() => taskTransport.read())
        const execution = this.execution(input, active.active, active.epoch)
        const firstResource = await checked(() => requestTransport(`/api/projects/${input.task.projectId}/crux/tasks/${encodeURIComponent(input.task.taskId)}/code-resource`, teamTaskCodeResourceDtoSchema))
        this.resource(input, firstResource)
        const firstInput = await checked(() => source.read())
        this.fixedInput(input, execution, firstInput)
        const project = await checked(() => inspectCruxWorkExecutionProject(root, firstResource.resource ?? undefined))
        if (!project.resourceMatched) conflict('Selected repository does not match the actual authorized engineering directory.')
        const directory = join(this.directory, input.preparationId), texts = new Map<string, string>()
        const resources: NativeTaskBinding['resources'] = []
        let bytes = 0
        for (const expected of firstInput.input.resources) {
          const value = await checked(() => source.readResource(expected.selection.id))
          if (value.inputDigest !== firstInput.input.digest || !equal(value.resource, expected)) conflict('Fixed source response differs from the original captured selection.')
          const state = firstInput.resources.find(item => item.selectionId === expected.selection.id)
          if (!state || state.status !== value.status) conflict('Fixed source availability changed during preparation.')
          let path: string | null = null
          if (value.status === 'available' && value.text !== null) {
            if (hash(value.text) !== expected.bodyDigest || Buffer.byteLength(value.text, 'utf8') !== expected.byteLength) conflict('Fixed source bytes differ from their captured digest.')
            bytes += expected.byteLength
            if (bytes > MAX_MATERIAL_BYTES) throw new DaemonError('E_BUSY', 'Fixed native preparation exceeds its material budget.')
            path = join(directory, 'inputs', hash(expected.selection.id) + '.txt')
            texts.set(path, value.text)
          } else if (expected.selection.required) conflict('A required fixed source is withdrawn or unavailable.')
          resources.push({ resource: expected, status: value.status, path })
        }
        const requiredCode = Boolean(firstResource.resource) || firstInput.input.definition.nodes.some(node => node.kind !== 'gate'
          && node.outputs.some(output => output.required && ['source-patch', 'selected-file'].includes(output.kind)))
        const predecessor = await checked(() => this.predecessor(input, execution, firstResource, taskTransport, root, workcopy, requiredCode, guard))
        const secondResource = await checked(() => requestTransport(`/api/projects/${input.task.projectId}/crux/tasks/${encodeURIComponent(input.task.taskId)}/code-resource`, teamTaskCodeResourceDtoSchema))
        this.resource(input, secondResource)
        if (!equal({ ...firstResource, serverTime: 0 }, { ...secondResource, serverTime: 0 })) conflict('Task resource or permission changed during preparation.')
        const secondInput = await checked(() => source.read())
        this.fixedInput(input, execution, secondInput)
        if (!equal(firstInput, secondInput)) conflict('Fixed execution input or source availability changed during preparation.')
        const latest = await checked(() => taskTransport.read())
        this.execution(input, latest.active, latest.epoch)
        if (active.authorizationRevision !== latest.authorizationRevision) conflict('Task authority changed during preparation.')
        const finalProject = await checked(() => inspectCruxWorkExecutionProject(root, secondResource.resource ?? undefined))
        if (!finalProject.resourceMatched || !equal(project, finalProject)) conflict('Actual repository identity changed during preparation.')
        await checked(() => this.ports.assertLegacyAvailable(root))
        const binding = nativeTaskBindingSchema.parse({ version: 1, state: 'ready', preparationId: input.preparationId, request: input,
          root, directoryIdentity, directory, grant: original.grant, nativeOwner: original.actor, workcopy, execution, input: firstInput.input, resources,
          outputs: firstInput.input.definition.nodes.flatMap(node => node.kind === 'gate' ? [] : node.outputs.map(output => ({ nodeId: node.id, output,
            path: join(directory, 'outputs', hash(taskInputCanonical([node.id, output.id])) + (output.kind === 'creation-html' ? '.html' : '.md')) }))),
          predecessor, resourceRevision: input.expected.resource, authorizationRevision: latest.authorizationRevision, preparedAt: Date.now() })
        guard()
        if (stored) {
          if (!equal(stored, this.read(input.preparationId))) conflict('Original retained binding or material directories changed during verification.')
          if (!equal(stored.input, binding.input) || !equal(stored.resources, binding.resources) || !equal(stored.outputs, binding.outputs)) conflict('Original immutable material mapping differs.')
          for (const [path, text] of texts) {
            if (lstatSync(path).nlink !== 1 || readBounded(path, 1024 * 1024) !== text) conflict('Original immutable material bytes changed.')
          }
          return stored
        }
        this.publish(binding, texts, guard)
        return binding
      }, input.task))
      guard()
      if (handoff) {
        // The callback transfers the tree lease to the exact native alias without
        // yielding. The managed admission token remains held across that transfer.
        handoff(verified, admission, () => {
          if (lease) this.ports.workcopies.release({ token: lease.token, owner: lease.owner, outcome: 'settled' })
          lease = undefined
        })
        handedOff = true
      }
      return verified
    } finally {
      // This lease encloses awaited reads/private publication only. No native process
      // was started, so settling it makes no claim about a process having stopped.
      try { if (lease) this.ports.workcopies.release({ token: lease.token, owner: lease.owner, outcome: 'settled' }) }
      finally { if (!handedOff) admission.release() }
    }
  }
  /** Admitted Daemon work reuses its retained grant and current protected device;
   * the initiating GUI connection is no longer its execution authority. */
  async withExecution<T>(binding: NativeTaskBinding, assertOwned: () => void,
    action: (transport: TaskExecutionTransport, source: ExecutionInputSource, resource: TeamTaskCodeResourceDto) => Promise<T>): Promise<T> {
    const original = this.read(binding.preparationId), input = original.request
    if (!equal(original, binding) || input.origin !== 'product' || input.ownership !== 'product-managed') conflict('Original product preparation changed.')
    const guard = (): void => {
      this.ports.assertOwner(); this.ports.assertCurrent(original.grant); assertOwned()
      if (cruxWorkProjectIdentity(original.root) !== original.directoryIdentity) conflict('Original engineering directory was replaced.')
      assertWorkcopyObservation(resolveWorkcopy(original.root), original.workcopy)
    }
    guard()
    return this.ports.withTransport(input.pin, async () => guard(), async request => {
      const transport = new TaskExecutionTransport(input.task, input.pin.actorId, input.pin.deviceId, executionRequest(request))
      const source = new ExecutionInputTransport(input.task, input.expected.executionId, input.pin.actorId, input.pin.deviceId, executionRequest(request)).source('use')
      const validate = async (): Promise<TeamTaskCodeResourceDto> => {
        guard()
        const current = await transport.read(); guard()
        const active = this.execution(input, current.active, current.epoch)
        if (!equal(active.executor, original.execution.executor)) conflict('Original executor claim changed.')
        const resource = await request(`/api/projects/${input.task.projectId}/crux/tasks/${encodeURIComponent(input.task.taskId)}/code-resource`, teamTaskCodeResourceDtoSchema)
        guard(); this.resource(input, resource)
        const view = await source.read(); guard(); this.fixedInput(input, active, view)
        if (!equal(view.input, original.input)) conflict('Original fixed input changed.')
        const project = await inspectCruxWorkExecutionProject(original.root, resource.resource ?? undefined)
        guard(); if (!project.resourceMatched) conflict('Actual repository differs from the retained resource.')
        for (const item of original.resources) {
          const state = view.resources.find(state => state.selectionId === item.resource.selection.id)
          if (!state || item.resource.selection.required && state.status !== 'available') conflict('A required original input is no longer available.')
          if (item.path && (lstatSync(item.path).nlink !== 1 || hash(readBounded(item.path, 1024 * 1024)) !== item.resource.bodyDigest)) conflict('Original fixed material bytes changed.')
        }
        return resource
      }
      const resource = await validate()
      const result = await action(transport, source, resource)
      guard()
      return result
    }, input.task)
  }
  retained(preparationId: string): NativeTaskBinding { this.ports.assertOwner(); return this.read(preparationId) }
  withReceipts<T>(binding: NativeTaskBinding, action: (transport: TaskExecutionTransport) => Promise<T>): Promise<T> {
    this.ports.assertOwner()
    if (!equal(this.read(binding.preparationId), binding)) conflict('Original preparation changed.')
    const input = binding.request
    return this.ports.withTransport(input.pin, async () => this.ports.assertOwner(), request => action(
      new TaskExecutionTransport(input.task, input.pin.actorId, input.pin.deviceId, executionRequest(request))), input.task)
  }
  private execution(input: NativeTaskPrepare, execution: TeamExecutionRecord | null, epoch: string): TeamExecutionRecord {
    if (input.pin.projectId !== input.task.projectId || input.pin.instanceId !== input.task.instanceId || epoch !== input.pin.epoch || !execution
      || teamTaskIdentity(execution.task) !== teamTaskIdentity(input.task) || execution.epoch !== input.pin.epoch
      || execution.executionId !== input.expected.executionId || execution.generation !== input.expected.generation
      || execution.actorId !== input.pin.actorId || execution.deviceId !== input.pin.deviceId || execution.authority !== 'active'
      || execution.ownership !== input.ownership || execution.nodeId !== input.expected.nodeId || execution.attempt !== input.expected.attempt || execution.finalization) conflict('Current execution does not authorize this original native owner, node or attempt.')
    return execution
  }
  private fixedInput(input: NativeTaskPrepare, execution: TeamExecutionRecord, view: ExecutionInputView): void {
    const fixed = view.input
    if (view.purpose !== 'use' || fixed.digest !== input.expected.inputDigest || hash(executionInputDigestText(fixed)) !== fixed.digest
      || teamTaskIdentity(fixed.task) !== teamTaskIdentity(input.task) || fixed.epoch !== input.pin.epoch || fixed.executionId !== execution.executionId
      || fixed.generation !== execution.generation || fixed.actorId !== input.pin.actorId || fixed.deviceId !== input.pin.deviceId
      || !equal(execution.inputBundle, fixed.inputBundle) || !equal(view.currentBundle, fixed.inputBundle) || !equal(execution.workflow, fixed.workflow)
      || hash(taskInputCanonical(fixed.definition)) !== fixed.workflow.digest || !fixed.definition.nodes.some(node => node.id === execution.nodeId)) conflict('Original adopted input or portable definition is stale or inconsistent.')
    if (view.resources.length !== fixed.resources.length || new Set(view.resources.map(item => item.selectionId)).size !== fixed.resources.length) conflict('Fixed input source availability is incomplete.')
  }
  private resource(input: NativeTaskPrepare, value: TeamTaskCodeResourceDto): void {
    if (value.instanceId !== input.task.instanceId || value.epoch !== input.pin.epoch || value.projectId !== input.task.projectId
      || value.taskId !== input.task.taskId || value.taskCreatedAt !== input.task.taskCreatedAt || value.spaceId !== input.task.spaceId) conflict('Current code resource does not belong to the original task scope.')
    const expected = input.expected.resource
    if (!expected) {
      if (value.resource || value.selection?.resourceId || value.availability !== 'unconfigured') conflict('Task requires an explicitly verified repository resource.')
      return
    }
    if (value.availability !== 'available' || !value.resource || value.resource.disabled || value.resource.resourceId !== expected.resourceId
      || value.resource.projectId !== input.task.projectId || value.resource.revision !== expected.revision || value.spaceRevision !== expected.spaceRevision
      || !value.selection || value.selection.resourceId !== expected.resourceId || value.selection.revision !== expected.selectionRevision
      || value.selection.taskCreatedAt !== input.task.taskCreatedAt || value.selection.spaceId !== input.task.spaceId) conflict('Selected resource is unavailable or its current permission/selection changed.')
  }
  private async predecessor(input: NativeTaskPrepare, execution: TeamExecutionRecord, resource: TeamTaskCodeResourceDto, transport: TaskExecutionTransport,
    root: string, workcopy: WorkcopyIdentity, requiredCode: boolean, guard: () => void): Promise<NativeTaskBinding['predecessor']> {
    if (!execution.predecessorExecutionId) return null
    guard()
    const previous = await transport.history(execution.predecessorExecutionId)
    guard()
    const finalization = previous.finalization, ref = finalization?.checkpoint
    if (finalization?.outcome !== 'completed' || !ref || !finalization.manifest) conflict('Predecessor has no fixed completed checkpoint.')
    const checkpoint = previous.checkpoints?.find(item => item.versionId === ref.versionId && item.digest === ref.digest)
    if (!checkpoint || hash(executionArtifactDigestText(checkpoint)) !== checkpoint.digest || !equal(checkpoint.manifest, finalization.manifest)) conflict('Predecessor checkpoint differs from its exact completed delivery.')
    if ((checkpoint.source.kind === 'git-commit' || checkpoint.source.kind === 'git-patch') && checkpoint.source.repositoryId !== resource.resource?.source.repositoryId) conflict('Checkpoint repository differs from the selected current resource.')
    const source = await verifyHandoffSource({ root, source: checkpoint.source, role: 'receiver', requiredCode, expectedWorkcopy: { id: workcopy.id, revision: workcopy.revision },
      targetPaths: input.targetPaths, assertOwned: guard, readArtifact: async ref => { guard(); const value = await transport.artifact(ref); guard(); return { text: value.text, bodyDigest: value.artifact.bodyDigest } } })
    guard()
    if (!source.ready) conflict('Fixed predecessor code is available but has not been applied to this directory.')
    return { executionId: previous.executionId, checkpointVersionId: checkpoint.versionId, checkpointDigest: checkpoint.digest, source }
  }
  private publish(binding: NativeTaskBinding, texts: Map<string, string>, guard: () => void): void {
    this.assertStorage(binding.root)
    guard()
    const serialized = JSON.stringify(binding)
    if (Buffer.byteLength(serialized) > MAX_BINDING_BYTES) throw new DaemonError('E_BUSY', 'Native binding exceeds the retained metadata budget.')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (readdirSync(this.directory).length >= 2000) throw new DaemonError('E_BUSY', 'Native preparation retention is full; preserve original bindings before admitting more.')
    // Never adopt a partial/crashed directory or replace unrelated existing bytes.
    mkdirSync(binding.directory, { mode: 0o700 })
    mkdirSync(join(binding.directory, 'inputs'), { mode: 0o700 })
    mkdirSync(join(binding.directory, 'outputs'), { mode: 0o700 })
    for (const [path, text] of texts) { guard(); writeExclusiveAtomic(path, text) }
    guard(); writeExclusiveAtomic(join(binding.directory, 'binding.json'), serialized)
  }
}
