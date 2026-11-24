import { verifiedCutoverAdmission } from '../../services/workflow-cutover/admission'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { ProcessOwner, WorkspaceGrant } from '../../../shared/daemon'
import { nativeTaskBindingSchema, nativeTaskPreparationRequestSchema, type NativeTaskBinding, type NativeTaskPrepare, type NativeTaskPreparationRequest } from '../../../shared/native-task-preparation'
import { executionInputDigestText, type ExecutionInputView } from '../../../shared/team-execution-input'
import { teamTaskIdentity, teamExecutionCommandSchema, type TeamExecutionRecord } from '../../../shared/team-task-execution'
import type { TeamTaskRef } from '../../../shared/team-task-execution'
import { teamTaskCodeResourceDtoSchema, type TeamTaskCodeResourceDto } from '../../../shared/team-code-resources'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { executionArtifactDigestText } from '../../../shared/team-execution-artifacts'
import type { TeamContentRequest } from '../../../shared/team-content-transport'
import { DaemonError } from '../errors'
import { readBounded, writeExclusiveAtomic } from '../files'
import { processIdentity, sameOwner } from '../native'
import { TaskExecutionTransport } from '../../services/team-platform/task-execution-transport'
import { ExecutionInputTransport } from '../../services/team-platform/execution-input-transport'
import type { NativeContentPin } from '../../services/team-platform/content-transport'
import { inspectCruxWorkExecutionProject, cruxWorkProjectIdentity } from '../../services/crux/work-project'
import { type DatabaseDeliveryCaptureRequest } from '../../../shared/database-delivery'
import { confirmDatabaseDelivery, readDatabaseDeliveryCommand } from './database-delivery'
import { verifyHandoffSource } from '../../services/crux/task-outputs/handoff-source'
import { resolveWorkcopy, assertWorkcopyObservation } from '../../services/workcopy-use/identity'
import type { WorkcopyUseRegistry } from '../../services/workcopy-use/registry'
import { claimWorkspaceAdmission } from '../../services/workflow-admission'
import type { WorkcopyIdentity } from '../../../shared/workcopy-use'
import type { WorkspaceAdmission } from '../../services/workflow-admission'
import type { ExecutionInputSource } from '../../../shared/team-execution-input'
import { readExecutionInputRules, type FixedExecutionRules } from '../../services/crux/task-input-rules'
import { ProjectWorkflowInstallation, type ProjectWorkflowHookIdentity, type ProjectWorkflowPreparationScope } from '../../services/project-workflow-installation'
import { readRegular, fileDigest } from '../../services/workflow-cutover/files'
import { DesktopTeamError, type NativePreparationPhase } from '../../services/team-platform/types'
import { teamTaskDevelopmentContextSchema } from '../../../shared/team-task-development'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const equal = (a: unknown, b: unknown): boolean => taskInputCanonical(a) === taskInputCanonical(b)
const MAX_MATERIAL_BYTES = 16 * 1024 * 1024
const MAX_BINDING_BYTES = 2 * 1024 * 1024
function conflict(message: string): never { throw new DaemonError('E_CONFLICT', message) }
const executionRequest = (request: TeamContentRequest) => <S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.output<S>> =>
  request(path, schema, body === undefined ? undefined : z.record(z.string(), z.unknown()).parse(body))

/** Supplied by the authenticated dispatcher, or captured by its durably accepted
 * native dispatch. Never parsed from a body; daemon capture retains the original
 * actor/grant and current task checks without retaining the GUI connection. */
export interface NativeTaskPreparationAuthority {
  actor: ProcessOwner
  grant: WorkspaceGrant
  assertProduct(): void
  /** In-memory operation/Stop check; never supplied by a request body. */
  assertOperation?(): void
}
export interface NativeTaskPreparationPorts {
  directory: string
  teamDataDirectory: string
  workcopies: WorkcopyUseRegistry
  assertOwner(): void
  assertCurrent(grant: WorkspaceGrant): void
  withTransport<T>(pin: NativeContentPin, assertCurrent: () => Promise<void>, action: (request: TeamContentRequest) => Promise<T>, task: TeamTaskRef): Promise<T>
  assertLegacyAvailable(root: string): Promise<void>
}

/** Preparation owns no engine, native shutdown, business claim or scheduler. */
export class NativeTaskPreparation {
  private readonly directory: string
  private readonly workflowPackages: ProjectWorkflowInstallation
  private readonly exitedOrigins = new Set<string>()
  private readonly recoveredPreparations = new Map<string, ProjectWorkflowPreparationScope>()
  private readonly pendingPreparations = new Map<string, { root: string; request: NativeTaskPrepare; authority: NativeTaskPreparationAuthority }>()
  constructor(private readonly ports: NativeTaskPreparationPorts) {
    this.directory = join(realpathSync.native(ports.directory), 'native-task-preparations')
    this.workflowPackages = new ProjectWorkflowInstallation(realpathSync.native(ports.directory))
  }
  private assertStorage(root: string, workspace = resolveWorkcopy(root).canonicalRoot): void {
    const within = (parent: string, child: string): boolean => {
      const path = relative(parent, child)
      return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')
    }
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
  private executableIdentity(executable: string): string {
    const path = realpathSync.native(executable), stat = lstatSync(path, { bigint: true })
    if (!stat.isFile()) throw new DaemonError('E_DENIED', 'Original application executable is unavailable.')
    return taskInputCanonical([process.platform === 'win32' ? path.toLowerCase() : path,
      String(stat.dev), String(stat.ino), String(stat.birthtimeNs), String(stat.mtimeNs), String(stat.size)])
  }
  private assertRecoveryScope(stored: NativeTaskBinding | ProjectWorkflowPreparationScope, root: string, authority: NativeTaskPreparationAuthority): void {
    this.ports.assertOwner(); this.ports.assertCurrent(authority.grant); authority.assertProduct()
    if ('state' in stored && (stored.state !== 'ready' || stored.execution.ownership !== 'product-managed')
      || stored.request.origin !== 'product' || stored.request.ownership !== 'product-managed'
      || stored.root !== root || authority.grant.root !== root
      || !equal(stored.grant, authority.grant) || stored.nativeOwner.userId !== authority.actor.userId
      || this.executableIdentity(stored.nativeOwner.executable) !== this.executableIdentity(authority.actor.executable))
      throw new DaemonError('E_DENIED', 'Original ready product preparation cannot be continued by this process or grant.')
  }
  /** Reconstruct the same preparation after a failed read, without replaying engine or business effects. */
  async authorizeRecovery(root: string, request: NativeTaskPreparationRequest, authority: NativeTaskPreparationAuthority): Promise<void> {
    if (request.operation !== 'prepare' || request.workflowPackagePolicy !== 'fixed-context/v1')
      throw new DaemonError('E_DENIED', 'Only the original fixed-context preparation has a recovery owner.')
    await this.authorizeAuthority(root, request, authority)
    if (existsSync(join(this.directory, request.preparationId, 'binding.json'))) {
      const binding = this.read(request.preparationId)
      if (!equal(binding.request, request)) conflict('Original preparation recovery request changed.')
      this.workflowPackages.verify(binding)
      return
    }
    if (existsSync(join(this.directory, request.preparationId)))
      throw new DaemonError('E_UNKNOWN', 'Original preparation has a partial material directory; preserve it for inspection.', 'unknown')
    const scope = this.workflowPackages.retainedInstalledScope(request.preparationId)
    const guard = (): void => {
      this.assertRecoveryScope(scope, root, authority)
      if (!equal(scope.request, request) || scope.directoryIdentity !== cruxWorkProjectIdentity(root)
        || !equal(scope, this.workflowPackages.retainedInstalledScope(request.preparationId)))
        conflict('Original incomplete preparation identity or installed release changed.')
      assertWorkcopyObservation(resolveWorkcopy(root), scope.workcopy)
      if (this.ports.workcopies.facts(resolveWorkcopy(root)).length) conflict('Original preparation still has a workcopy owner.')
    }
    guard()
    const key = taskInputCanonical(scope.nativeOwner)
    if (!sameOwner(scope.nativeOwner, authority.actor) && !this.exitedOrigins.has(key)) {
      const actual = await processIdentity(scope.nativeOwner.pid)
      guard()
      if (actual && (actual.pid !== scope.nativeOwner.pid || actual.startedAt === scope.nativeOwner.startedAt))
        throw new DaemonError('E_DENIED', 'Original preparation GUI is still live or its exit is unverified.')
      if (this.exitedOrigins.size >= 2000) throw new DaemonError('E_BUSY', 'Preparation recovery retention is full.')
      this.exitedOrigins.add(key)
    }
    await this.ports.assertLegacyAvailable(root)
    guard()
    if (this.recoveredPreparations.size >= 2000 && !this.recoveredPreparations.has(request.preparationId))
      throw new DaemonError('E_BUSY', 'Preparation recovery retention is full.')
    this.recoveredPreparations.set(request.preparationId, scope)
  }
  /** Only a proved exit permits a new GUI to verify the unchanged original binding. */
  async authorizeAuthority(root: string, raw: NativeTaskPreparationRequest, authority: NativeTaskPreparationAuthority): Promise<void> {
    const request = nativeTaskPreparationRequestSchema.parse(raw)
    const original = { actor: structuredClone(authority.actor), grant: structuredClone(authority.grant), assertProduct: authority.assertProduct.bind(authority) }
    this.ports.assertOwner(); this.assertStorage(root)
    const file = join(this.directory, request.preparationId, 'binding.json')
    const stored = request.operation !== 'prepare' || existsSync(file) ? this.read(request.preparationId) : undefined
    if (!stored || sameOwner(stored.nativeOwner, original.actor) || request.operation === 'database-delivery') {
      this.assertAuthority(root, request, original)
      return
    }
    this.assertRecoveryScope(stored, root, original)
    const bytes = readBounded(file, MAX_BINDING_BYTES), executable = this.executableIdentity(original.actor.executable)
    const key = taskInputCanonical(stored.nativeOwner)
    const guard = (): void => {
      if (!equal(authority.actor, original.actor) || !equal(authority.grant, original.grant)
        || readBounded(file, MAX_BINDING_BYTES) !== bytes || !equal(this.read(request.preparationId), stored)
        || this.executableIdentity(original.actor.executable) !== executable
        || this.executableIdentity(stored.nativeOwner.executable) !== executable)
        conflict('Original preparation or native recovery identity changed during authorization.')
      this.assertRecoveryScope(stored, root, original)
    }
    guard()
    if (!this.exitedOrigins.has(key)) {
      const actual = await processIdentity(stored.nativeOwner.pid)
      guard()
      if (actual !== null && (!actual || actual.pid !== stored.nativeOwner.pid || !actual.startedAt || actual.startedAt === stored.nativeOwner.startedAt))
        throw new DaemonError('E_DENIED', 'Original preparation GUI is still live or its exit could not be verified.')
      // Cache only irreversible original-process exit, never current task/capability authority.
      if (this.exitedOrigins.size >= 2000) throw new DaemonError('E_BUSY', 'Original preparation exit evidence retention is full.')
      this.exitedOrigins.add(key)
    }
    guard()
    this.assertAuthority(root, request, original)
  }
  /** Also runs before RuntimeCommands can return a cached original receipt. */
  assertAuthority(root: string, raw: NativeTaskPreparationRequest, authority: NativeTaskPreparationAuthority): void {
    this.assertAuthorityForWorkcopy(root, raw, authority)
  }
  private assertAuthorityForWorkcopy(root: string, raw: NativeTaskPreparationRequest, authority: NativeTaskPreparationAuthority, workspace?: string): void {
    const request = nativeTaskPreparationRequestSchema.parse(raw)
    this.ports.assertOwner()
    if (request.operation !== 'inspect') this.ports.assertCurrent(authority.grant)
    if (root !== authority.grant.root) throw new DaemonError('E_DENIED', 'Preparation root differs from the authenticated workspace grant.')
    this.assertStorage(root, workspace)
    const file = join(this.directory, request.preparationId, 'binding.json')
    const stored = request.operation !== 'prepare' || existsSync(file) ? this.read(request.preparationId) : undefined
    if (stored) {
      if (stored.root !== root || !equal(stored.grant, authority.grant)) throw new DaemonError('E_DENIED', 'Original preparation belongs to another directory grant.')
      if (!sameOwner(stored.nativeOwner, authority.actor)) {
        if (request.operation === 'database-delivery' || !this.exitedOrigins.has(taskInputCanonical(stored.nativeOwner)))
          throw new DaemonError('E_DENIED', 'Original preparation process exit has not been authorized.')
        this.assertRecoveryScope(stored, root, authority)
      }
    }
    const recovered = !stored && request.operation === 'prepare' ? this.recoveredPreparations.get(request.preparationId) : undefined
    if (recovered) {
      this.assertRecoveryScope(recovered, root, authority)
      if (!equal(recovered.request, request) || !sameOwner(recovered.nativeOwner, authority.actor)
        && !this.exitedOrigins.has(taskInputCanonical(recovered.nativeOwner))) conflict('Original preparation recovery authority changed.')
    }
    const input = request.operation === 'prepare' ? request : stored?.request
    if (!input) throw new DaemonError('E_DENIED', 'Original native binding is unavailable.')
    if (input.origin === 'product' ? input.ownership !== 'product-managed' : input.ownership !== 'editor-owned') throw new DaemonError('E_DENIED', 'Preparation origin differs from its ownership mode.')
    if (request.operation !== 'inspect' && input.ownership === 'product-managed') authority.assertProduct()
  }
  /** Generic command inspection must retain a preparation's original process boundary. */
  private assertPendingReceipt(root: string, preparationId: string, authority?: NativeTaskPreparationAuthority): boolean {
    const pending = this.pendingPreparations.get(preparationId)
    if (!pending) return false
    if (!authority || pending.root !== root || !sameOwner(pending.authority.actor, authority.actor)
      || !equal(pending.authority.grant, authority.grant))
      throw new DaemonError('E_DENIED', 'Pending preparation belongs to its original authenticated process and grant.')
    pending.authority.assertOperation?.()
    this.assertAuthority(root, pending.request, authority)
    return true
  }
  assertReceiptAuthority(root: string, preparationId: string, authority?: NativeTaskPreparationAuthority): void {
    if (this.assertPendingReceipt(root, preparationId, authority)) return
    this.ports.assertOwner(); this.assertStorage(root)
    const capture = readDatabaseDeliveryCommand(this.directory, preparationId)
    const request = nativeTaskPreparationRequestSchema.parse({ operation: 'inspect', preparationId: capture?.request.preparationId ?? preparationId })
    if (!authority) throw new DaemonError('E_DENIED', 'Original preparation receipts require their authenticated native process and workspace grant.')
    if (capture && !sameOwner(this.read(request.preparationId).nativeOwner, authority.actor))
      throw new DaemonError('E_DENIED', 'Database delivery receipts retain their original native process boundary.')
    this.assertAuthority(root, request, authority)
  }
  async authorizeReceiptAuthority(root: string, preparationId: string, authority?: NativeTaskPreparationAuthority): Promise<void> {
    if (this.assertPendingReceipt(root, preparationId, authority)) return
    if (!authority) throw new DaemonError('E_DENIED', 'Original preparation receipts require native authority.')
    this.ports.assertOwner(); this.assertStorage(root)
    const capture = readDatabaseDeliveryCommand(this.directory, preparationId)
    if (capture) { this.assertReceiptAuthority(root, preparationId, authority); return }
    await this.authorizeAuthority(root, { operation: 'inspect', preparationId }, authority)
    if (!equal(capture, readDatabaseDeliveryCommand(this.directory, preparationId))) conflict('Original database receipt identity changed.')
    this.assertReceiptAuthority(root, preparationId, authority)
  }
  /** Cached prepare receipts must pass the same fresh cutover gate as first preparation. */
  async assertFreshCutover(root: string, preparationId: string, authority: NativeTaskPreparationAuthority): Promise<void> {
    await this.authorizeReceiptAuthority(root, preparationId, authority)
    const binding = this.read(preparationId), input = binding.request
    const guard = (): void => { this.assertReceiptAuthority(root, preparationId, authority); if (!equal(binding, this.read(preparationId))) conflict('Original preparation changed during fresh admission.') }
    guard()
    this.workflowPackages.verify(binding)
    await this.ports.withTransport(input.pin, async () => guard(), async request => {
      const transport = new TaskExecutionTransport(input.task, input.pin.actorId, input.pin.deviceId, executionRequest(request))
      await verifiedCutoverAdmission(this.ports.teamDataDirectory, input.task, input.pin.actorId, input.pin.deviceId, transport.cutover(), { root })
      guard()
    }, input.task)
    guard()
    this.workflowPackages.verify(binding)
  }
  async execute(root: string, raw: NativeTaskPreparationRequest, authority: NativeTaskPreparationAuthority,
    handoff?: (binding: NativeTaskBinding, admission: WorkspaceAdmission, releasePreparation: () => void) => void): Promise<NativeTaskBinding> {
    const request = nativeTaskPreparationRequestSchema.parse(raw)
    // Copy the authenticated capture before any await. Bodies cannot provide these facts.
    const original = { actor: structuredClone(authority.actor), grant: structuredClone(authority.grant), assertProduct: authority.assertProduct.bind(authority),
      assertOperation: authority.assertOperation?.bind(authority) }
    original.assertOperation?.()
    await this.authorizeAuthority(root, request, original)
    original.assertOperation?.()
    let stored: NativeTaskBinding | undefined
    if (request.operation !== 'prepare' || existsSync(join(this.directory, request.preparationId, 'binding.json'))) {
      stored = this.read(request.preparationId)
      this.assertAuthority(root, request, original)
      if (request.operation === 'inspect') return stored
      if (request.operation === 'prepare' && !equal(stored.request, request)) conflict('Preparation UUID belongs to a different original intent.')
    }
    const input = request.operation === 'prepare' ? request : stored?.request
    if (!input) throw new DaemonError('E_DENIED', 'Original preparation is unavailable.')
    const recovered = !stored ? this.recoveredPreparations.get(input.preparationId) : undefined
    const nativeOwner = stored?.nativeOwner ?? recovered?.nativeOwner ?? original.actor, grant = stored?.grant ?? original.grant
    if (input.origin === 'product' ? input.ownership !== 'product-managed' : input.ownership !== 'editor-owned') throw new DaemonError('E_DENIED', 'Preparation origin differs from its native ownership mode.')
    if (input.ownership === 'product-managed') original.assertProduct()
    const directoryIdentity = cruxWorkProjectIdentity(root), workcopy = resolveWorkcopy(root)
    if (stored && stored.directoryIdentity !== directoryIdentity) conflict('Original selected directory was replaced.')
    assertWorkcopyObservation(workcopy, input.expected.workcopy)
    const admission = claimWorkspaceAdmission(workcopy.canonicalRoot, 'managed', undefined, { projectRoot: root })
    let lease: ReturnType<WorkcopyUseRegistry['acquire']> | undefined, handedOff = false
    const guardAuthority = (): void => {
      original.assertOperation?.()
      this.ports.assertOwner(); this.ports.assertCurrent(original.grant)
      this.assertAuthorityForWorkcopy(root, request, original, workcopy.canonicalRoot)
      if (stored && !equal(stored, this.read(request.preparationId))) conflict('Original binding changed during verification.')
      if (!admission.isCurrent() || original.grant.root !== root || realpathSync.native(root) !== root || cruxWorkProjectIdentity(root) !== directoryIdentity) conflict('Original physical directory or workspace admission changed.')
      if (input.ownership === 'product-managed') original.assertProduct()
      if (lease) this.ports.workcopies.assertLeaseHeld(lease.token, lease.owner)
    }
    const guard = (): void => {
      guardAuthority()
      const actual = lease ? this.ports.workcopies.assertHeld(root, lease.token, lease.owner) : resolveWorkcopy(root)
      assertWorkcopyObservation(actual, workcopy)
    }
    let phase: NativePreparationPhase = 'authorization'
    const checked = async <T>(action: () => Promise<T>): Promise<T> => {
      try { guard(); const value = await action(); guard(); return value }
      catch (error) { if (error instanceof DesktopTeamError) error.preparationPhase ??= phase; throw error }
    }
    try {
      guard()
      lease = this.ports.workcopies.acquire(root, { kind: 'tree-change', expected: { id: workcopy.id, revision: workcopy.revision },
        owner: { kind: 'git', id: input.preparationId, generation: randomUUID(), label: 'Prepare platform task', taskKey: teamTaskIdentity(input.task) } })
      if (request.operation === 'prepare') this.pendingPreparations.set(request.preparationId, { root, request, authority: original })
      await checked(() => this.ports.assertLegacyAvailable(root))
      // Credential/session prerequisites only read remote state. Keep current
      // native authority there; checked() observes Git before/after each logical
      // preparation step, and installer/publication guards do so before writes.
      const verified = await checked(() => this.ports.withTransport(input.pin, async () => guardAuthority(), async requestTransport => {
        const readRequest = <S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.output<S>> => {
          if (body !== undefined) throw new DaemonError('E_DENIED', 'Native preparation cannot submit team mutations.')
          return requestTransport(path, schema)
        }
        const taskTransport = new TaskExecutionTransport(input.task, input.pin.actorId, input.pin.deviceId, readRequest)
        const source = new ExecutionInputTransport(input.task, input.expected.executionId, input.pin.actorId, input.pin.deviceId, readRequest).source('use')
        await checked(() => verifiedCutoverAdmission(this.ports.teamDataDirectory, input.task, input.pin.actorId, input.pin.deviceId, taskTransport.cutover(), { root }))
        const active = await checked(() => taskTransport.read())
        const execution = this.execution(input, active.active, active.epoch)
        const firstResource = await checked(() => requestTransport(`/api/projects/${input.task.projectId}/crux/tasks/${encodeURIComponent(input.task.taskId)}/code-resource`, teamTaskCodeResourceDtoSchema))
        this.resource(input, firstResource)
        phase = 'fixed-input'
        const firstInput = await checked(() => source.read())
        this.fixedInput(input, execution, firstInput)
        phase = 'project'
        const project = await checked(() => inspectCruxWorkExecutionProject(root, firstResource.resource ?? undefined))
        if (!project.resourceMatched) conflict('Selected repository does not match the actual authorized engineering directory.')
        const directory = join(this.directory, input.preparationId), texts = new Map<string, string>()
        const resources: NativeTaskBinding['resources'] = []
        let bytes = 0
        phase = 'fixed-input'
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
        await checked(() => verifiedCutoverAdmission(this.ports.teamDataDirectory, input.task, input.pin.actorId, input.pin.deviceId, taskTransport.cutover(), { root }))
        let workflowPackage = stored?.workflowPackage
        if (input.workflowPackagePolicy && !stored) {
          phase = 'workflow-installation'
          const assertInstallationCurrent = async (): Promise<void> => {
            const current = await checked(() => taskTransport.read())
            const activeExecution = this.execution(input, current.active, current.epoch)
            if (current.authorizationRevision !== latest.authorizationRevision || !equal(activeExecution.executor, execution.executor)) conflict('Original task authority changed during local workflow installation.')
            const view = await checked(() => source.read())
            this.fixedInput(input, activeExecution, view)
            if (!equal(view, firstInput)) conflict('Original workflow inputs changed during installation.')
            const resource = await checked(() => requestTransport(`/api/projects/${input.task.projectId}/crux/tasks/${encodeURIComponent(input.task.taskId)}/code-resource`, teamTaskCodeResourceDtoSchema))
            this.resource(input, resource)
            if (!equal({ ...resource, serverTime: 0 }, { ...secondResource, serverTime: 0 })) conflict('Original code resource changed during installation.')
            const currentProject = await checked(() => inspectCruxWorkExecutionProject(root, resource.resource ?? undefined))
            if (!equal(currentProject, finalProject)) conflict('Actual repository changed during installation.')
            await checked(() => this.ports.assertLegacyAvailable(root))
            await checked(() => verifiedCutoverAdmission(this.ports.teamDataDirectory, input.task, input.pin.actorId, input.pin.deviceId, taskTransport.cutover(), { root }))
          }
          workflowPackage = await checked(() => this.workflowPackages.prepare({
            root, directoryIdentity, request: input, nativeOwner, grant, workcopy
          }, {
            input: firstInput.input, codeResource: secondResource.resource ? {
              resourceId: secondResource.resource.resourceId, projectId: secondResource.resource.projectId,
              revision: secondResource.resource.revision, source: secondResource.resource.source
            } : null,
            rules: resources.filter(item => item.resource.selection.source.kind === 'governance').map(item => ({
              resource: item.resource, status: item.status, body: item.path ? texts.get(item.path) ?? null : null
            }))
          }, guard, assertInstallationCurrent))
        }
        phase = 'binding-publication'
        const binding = nativeTaskBindingSchema.parse({ version: 1, state: 'ready', preparationId: input.preparationId, request: input,
          root, directoryIdentity, directory, grant, nativeOwner, workcopy, execution, input: firstInput.input, resources,
          outputs: firstInput.input.definition.nodes.flatMap(node => node.kind === 'gate' ? [] : node.outputs.map(output => ({ nodeId: node.id, output,
            path: join(directory, 'outputs', hash(taskInputCanonical([node.id, output.id])) + (output.kind === 'creation-html' ? '.html' : '.md')) }))),
          predecessor, ...(workflowPackage ? { workflowPackage } : {}),
          resourceRevision: input.expected.resource, authorizationRevision: latest.authorizationRevision, preparedAt: Date.now() })
        this.workflowPackages.verify(binding)
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
      if (this.pendingPreparations.get(request.preparationId)?.authority === original) this.pendingPreparations.delete(request.preparationId)
      // This lease encloses awaited reads/private publication only. No native process
      // was started, so settling it makes no claim about a process having stopped.
      try { if (lease) this.ports.workcopies.release({ token: lease.token, owner: lease.owner, outcome: 'settled' }) }
      finally { if (!handedOff) admission.release() }
    }
  }
  async captureDatabaseDelivery(root: string, raw: DatabaseDeliveryCaptureRequest, authority: NativeTaskPreparationAuthority): Promise<Awaited<ReturnType<typeof confirmDatabaseDelivery>>> {
    const original = { actor: structuredClone(authority.actor), grant: structuredClone(authority.grant), assertProduct: authority.assertProduct.bind(authority) }
    const request = structuredClone(raw)
    this.assertAuthority(root, request, original)
    let release: (() => void) | undefined, admission: WorkspaceAdmission | undefined
    try {
      const binding = await this.execute(root, { operation: 'verify', preparationId: request.preparationId }, original,
        (_binding, held, done) => { admission = held; release = done })
      const guard = (): void => {
        this.assertAuthority(root, request, original)
        if (!admission?.isCurrent()) conflict('Original database capture workspace admission changed')
      }
      return await this.withPreparedExecution(binding, guard, async (transport, source) => {
        const result = await confirmDatabaseDelivery({ directory: this.directory, binding, request, transport, assertPrepared: guard })
        const view = await source.read(); guard()
        this.fixedInput(binding.request, binding.execution, view)
        return result
      }, true)
    } finally { try { release?.() } finally { admission?.release() } }
  }
  /** Admitted Daemon work reuses its retained grant and current protected device;
   * the initiating GUI connection is no longer its execution authority. */
  async withExecution<T>(binding: NativeTaskBinding, assertOwned: () => void,
    action: (transport: TaskExecutionTransport, source: ExecutionInputSource, resource: TeamTaskCodeResourceDto, view: ExecutionInputView) => Promise<T>): Promise<T> {
    return this.withPreparedExecution(binding, assertOwned, action, false)
  }
  /** Current use plus original private bytes; no native storage path leaves this owner. */
  async executionRules(binding: NativeTaskBinding, assertOwned: () => void): Promise<FixedExecutionRules> {
    return this.withExecution(binding, assertOwned, async (_transport, source, _resource, view) => {
      let firstRead = true
      const fixed = await readExecutionInputRules({
        read: () => {
          if (!firstRead) return source.read()
          firstRead = false
          return Promise.resolve(view)
        },
        readResource: async selectionId => {
          assertOwned()
          const resource = view.input.resources.find(item => item.selection.id === selectionId)
          const state = view.resources.find(item => item.selectionId === selectionId)
          const retained = binding.resources.find(item => item.resource.selection.id === selectionId)
          if (!resource || !state || !retained || !equal(retained.resource, resource)) return conflict('Original input has no matching retained native bytes.')
          let text: string | null = null
          if (state.status === 'available') {
            if (!retained.path) return conflict('Original fixed material bytes are unavailable.')
            const bytes = readRegular(retained.path, 1024 * 1024).bytes
            if (!bytes) return conflict('Original fixed material bytes are unavailable.')
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
            if (Buffer.byteLength(text, 'utf8') !== resource.byteLength || hash(text) !== resource.bodyDigest) conflict('Original retained input differs from current authorized fixed bytes.')
          }
          return { contractVersion: 2, inputDigest: view.input.digest, resource, status: state.status, text }
        }
      }, binding.execution.nodeId)
      // Reopen current authority for each assertion rather than retaining a transport lease.
      return { ...fixed, assertCurrent: async () => {
        await this.withExecution(binding, assertOwned, async (_transport, _source, _resource, currentView) => {
          if (!equal(currentView, fixed.view)) conflict('Original execution input authority or source availability changed.')
        })
      } }
    })
  }
  /** Required application-managed context gate. It never registers a provider-native event. */
  async taskStartHook(binding: NativeTaskBinding, assertOwned: () => void, identity: ProjectWorkflowHookIdentity,
    boundary: 'native-session' | 'prompt'): Promise<void> {
    if (!binding.request.workflowPackagePolicy) return
    try {
      assertOwned()
      const fixed = await this.executionRules(binding, assertOwned)
      assertOwned()
      await fixed.assertCurrent()
      assertOwned()
    } catch (error) {
      this.workflowPackages.recordHook(binding, identity, boundary, error)
      throw error
    }
    this.assertTaskStartHook(binding, assertOwned, identity, boundary)
  }
  /** Last synchronous boundary after awaited composers, before native creation/send. */
  assertTaskStartHook(binding: NativeTaskBinding, assertOwned: () => void, identity: ProjectWorkflowHookIdentity,
    boundary: 'native-session' | 'prompt'): void {
    if (!binding.request.workflowPackagePolicy) return
    try {
      assertOwned()
      if (!equal(this.read(binding.preparationId), binding)) conflict('Original governed preparation changed before task start.')
      const expected = binding.request.expected
      if (teamTaskIdentity(binding.input.task) !== teamTaskIdentity(binding.request.task)
        || binding.input.digest !== expected.inputDigest || binding.input.executionId !== expected.executionId
        || binding.execution.executionId !== expected.executionId || binding.execution.generation !== expected.generation
        || binding.execution.nodeId !== expected.nodeId || binding.execution.attempt !== expected.attempt) conflict('Task-start context differs from its original task/node/attempt pin.')
      this.workflowPackages.verify(binding)
      for (const item of binding.resources) {
        if (!item.resource.selection.required) continue
        if (!item.path || item.status !== 'available') conflict('Required task-start source is unavailable.')
        const bytes = readRegular(item.path).bytes
        if (!bytes || bytes.length !== item.resource.byteLength || fileDigest(bytes) !== item.resource.bodyDigest) conflict('Required original fixed source changed before task start.')
      }
      assertOwned()
      this.workflowPackages.recordHook(binding, identity, boundary)
    } catch (error) {
      this.workflowPackages.recordHook(binding, identity, boundary, error)
      throw error
    }
  }
  recordTaskStartFailure(binding: NativeTaskBinding, identity: ProjectWorkflowHookIdentity, error: unknown,
    boundary: 'native-session' | 'prompt' = 'native-session'): void {
    this.workflowPackages.recordHook(binding, identity, boundary, error)
  }
  private async withPreparedExecution<T>(binding: NativeTaskBinding, assertOwned: () => void,
    action: (transport: TaskExecutionTransport, source: ExecutionInputSource, resource: TeamTaskCodeResourceDto, view: ExecutionInputView) => Promise<T>, allowEditor: boolean): Promise<T> {
    const original = this.read(binding.preparationId), input = original.request
    if (!equal(original, binding) || !allowEditor && (input.origin !== 'product' || input.ownership !== 'product-managed')) conflict('Original product preparation changed.')
    const guard = (): void => {
      this.ports.assertOwner(); this.ports.assertCurrent(original.grant); assertOwned()
      if (cruxWorkProjectIdentity(original.root) !== original.directoryIdentity) conflict('Original engineering directory was replaced.')
      assertWorkcopyObservation(resolveWorkcopy(original.root), original.workcopy)
    }
    guard()
    return this.ports.withTransport(input.pin, async () => guard(), async request => {
      const transport = new TaskExecutionTransport(input.task, input.pin.actorId, input.pin.deviceId, executionRequest(request))
      const source = new ExecutionInputTransport(input.task, input.expected.executionId, input.pin.actorId, input.pin.deviceId, executionRequest(request)).source('use')
      const validate = async (): Promise<{ resource: TeamTaskCodeResourceDto; view: ExecutionInputView }> => {
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
        return { resource, view }
      }
      const { resource, view } = await validate()
      const result = await action(transport, source, resource, view)
      guard()
      return result
    }, input.task)
  }
  async managedTaskAssignment(binding: NativeTaskBinding, assertOwned: () => void): Promise<number> {
    const task = binding.request.task
    const pin = binding.request.pin
    return this.ports.withTransport(pin, async () => assertOwned(), async request => {
      const current = await request(`/api/projects/${task.projectId}/crux/tasks/${encodeURIComponent(task.taskId)}/development-context`,
        teamTaskDevelopmentContextSchema)
      assertOwned()
      const { snapshot } = current
      const original = snapshot.snapshot.tasks.find(item => item.id === task.taskId && item.spaceId === task.spaceId && item.createdAt === task.taskCreatedAt)
      if (snapshot.instanceId !== task.instanceId || snapshot.epoch !== pin.epoch || snapshot.actor.id !== pin.actorId
        || !original || (original.workflow?.handlerId ?? original.assigneeIds[0]) !== pin.actorId || !original.assigneeGeneration) {
        throw new DaemonError('E_DENIED', '无法核对正式任务当前处理人与分配代次。')
      }
      return original.assigneeGeneration
    }, task)
  }
  retained(preparationId: string): NativeTaskBinding { this.ports.assertOwner(); return this.read(preparationId) }
  /** Only retained output publication. No directory grant, live lease, material
   * path or model authority survives cleanup through this transport. */
  withCapturedOutputs<T>(binding: NativeTaskBinding, action: (transport: TaskExecutionTransport) => Promise<T>): Promise<T> {
    this.ports.assertOwner()
    if (!equal(this.read(binding.preparationId), binding) || binding.request.origin !== 'product' || binding.request.ownership !== 'product-managed') conflict('Original product output preparation changed.')
    const input = binding.request
    return this.ports.withTransport(input.pin, async () => this.ports.assertOwner(), async request => {
      const plain = executionRequest(request)
      const reader = new TaskExecutionTransport(input.task, input.pin.actorId, input.pin.deviceId, plain)
      const validate = async (): Promise<void> => {
        this.ports.assertOwner()
        const current = await reader.read(), active = this.execution(input, current.active, current.epoch)
        if (!equal(active.executor, binding.execution.executor)) conflict('Original output executor changed.')
        const source = new ExecutionInputTransport(input.task, input.expected.executionId, input.pin.actorId, input.pin.deviceId, plain).source('use')
        const view = await source.read()
        this.fixedInput(input, active, view)
        if (!equal(view.input, binding.input) || view.resources.some(item => item.status !== 'available' && binding.input.resources.some(resource => resource.selection.id === item.selectionId && resource.selection.required))) conflict('Original output inputs are no longer authorized.')
        const resource = await request(`/api/projects/${input.task.projectId}/crux/tasks/${encodeURIComponent(input.task.taskId)}/code-resource`, teamTaskCodeResourceDtoSchema)
        this.resource(input, resource)
      }
      return action(new TaskExecutionTransport(input.task, input.pin.actorId, input.pin.deviceId, async (path, schema, body) => {
        // Receipt lookup stays historical; it cannot renew authority to POST.
        if (body !== undefined && path.endsWith('/commands')) {
          const command = teamExecutionCommandSchema.parse(body)
          if (!['save-artifact', 'seal-delivery', 'checkpoint', 'finalize'].includes(command.kind)
            || command.expectedExecutionId !== input.expected.executionId || command.expectedGeneration !== input.expected.generation
            || ('expectedNodeId' in command && (command.expectedNodeId !== input.expected.nodeId || command.expectedAttempt !== input.expected.attempt))) conflict('Captured-output transport cannot admit another execution operation.')
          await validate()
        }
        return plain(path, schema, body)
      }))
    }, input.task)
  }
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
