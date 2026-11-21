import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { nativeTaskPrepareSchema, nativeWorkflowPackagePinSchema, type NativeTaskBinding, type NativeWorkflowPackagePin } from '../../shared/native-task-preparation'
import { processOwnerSchema, workspaceGrantSchema } from '../../shared/daemon/identity'
import { workcopyIdentitySchema } from '../../shared/workcopy-use'
import { taskInputCanonical } from '../../shared/team-task-inputs'
import { buildOrdinaryPackage, ORDINARY_PACKAGE_ROOT_PATHS, ordinaryPackageRootObservationSchema, type BuildOrdinaryPackageInput, type OrdinaryPackageRootObservation } from './project-workflow-package'
import { WorkflowCutoverInstaller } from './workflow-cutover/installer'
import { assertDirectories, boundedEntries, captureDirectory, captureDirectoryTree, captureParents, fileDigest, fileStat, publishPrivate, readPrivate, readRegular, targetPath, within } from './workflow-cutover/files'
import { CutoverInstallerError, type CutoverInstallationStatus, type CutoverPhysicalIdentity } from './workflow-cutover/types'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const originalScopeSchema = z.object({
  root: z.string().min(1).max(4096), directoryIdentity: digest, request: nativeTaskPrepareSchema,
  nativeOwner: processOwnerSchema, grant: workspaceGrantSchema, workcopy: workcopyIdentitySchema
}).strict()
const intentSchema = originalScopeSchema.extend({
  version: z.literal(1), operationId: z.string().uuid(), releaseDigest: digest, manifestDigest: digest,
  rootObservations: z.array(ordinaryPackageRootObservationSchema).length(ORDINARY_PACKAGE_ROOT_PATHS.length)
}).strict()
const releaseSchema = z.object({
  version: z.literal(1), root: z.string(), directoryIdentity: digest, operationId: z.string().uuid(),
  preparationId: z.string().uuid(), intentDigest: digest, releaseDigest: digest, manifestDigest: digest
}).strict()
type OriginalScope = z.infer<typeof originalScopeSchema>
export type ProjectWorkflowPreparationScope = OriginalScope
type Intent = z.infer<typeof intentSchema>
type Release = z.infer<typeof releaseSchema>
const hookIdentitySchema = z.object({
  dispatchId: z.string().uuid(), sessionId: z.string().min(1).max(512), connectionGeneration: z.string().min(1).max(512).nullable()
}).strict()
export type ProjectWorkflowHookIdentity = z.infer<typeof hookIdentitySchema>
const hookSchema = z.object({
  version: z.literal(1), owner: z.literal('application'), event: z.literal('task-start'), handler: z.literal('fixed-context/v1'),
  boundary: z.enum(['native-session', 'prompt']), preparationId: z.string().uuid(), task: nativeTaskPrepareSchema.shape.task,
  epoch: nativeTaskPrepareSchema.shape.pin.shape.epoch, executionId: nativeTaskPrepareSchema.shape.expected.shape.executionId,
  generation: z.number().int().positive(), nodeId: nativeTaskPrepareSchema.shape.expected.shape.nodeId, attempt: z.number().int().positive(),
  inputDigest: digest, releaseDigest: digest.nullable(), operationId: z.string().uuid().nullable(), manifestDigest: digest.nullable(),
  identity: hookIdentitySchema, outcome: z.enum(['pass', 'fail']), observedAt: z.number().int().nonnegative(),
  failure: z.object({ code: z.string().max(80) }).strict().nullable()
}).strict()
type HookBoundary = 'native-session' | 'prompt'
const same = (a: unknown, b: unknown): boolean => taskInputCanonical(a) === taskInputCanonical(b)
function conflict(message: string): never { throw new CutoverInstallerError('CUTOVER_FILE_CONFLICT', message) }

/** Private ownership and restart records around the existing guarded file installer. */
export class ProjectWorkflowInstallation {
  private readonly parents: CutoverPhysicalIdentity[]
  private readonly directory: string
  constructor(daemonDirectory: string) {
    this.parents = captureDirectoryTree(daemonDirectory)
    this.directory = join(daemonDirectory, 'project-workflow-installations')
  }
  private storage(create: boolean): void {
    assertDirectories(this.parents)
    for (const path of [this.directory, ...['intents', 'releases', 'plans', 'hooks'].map(name => join(this.directory, name))]) {
      if (create && !fileStat(path)) mkdirSync(path, { mode: 0o700 })
      captureDirectory(path)
    }
  }
  private read<S extends z.ZodType>(kind: 'intents' | 'releases', name: string, schema: S): z.output<S> | null {
    this.storage(false)
    const bytes = readPrivate(captureDirectory(join(this.directory, kind)), name + '.json', 2 * 1024 * 1024).bytes
    return bytes === null ? null : schema.parse(JSON.parse(bytes.toString('utf8')))
  }
  private publish(kind: 'intents' | 'releases' | 'hooks', name: string, value: unknown): void {
    this.storage(true)
    const parent = captureDirectory(join(this.directory, kind))
    if (boundedEntries(parent.path).length >= (kind === 'hooks' ? 8000 : 2000)) conflict('Project workflow private record retention is full.')
    const bytes = Buffer.from(taskInputCanonical(value), 'utf8')
    if (bytes.length > 2 * 1024 * 1024) conflict('Project workflow private record exceeds its metadata budget.')
    publishPrivate(parent, name + '.json', bytes)
  }
  private releaseKey(scope: Pick<OriginalScope, 'root' | 'directoryIdentity'>, releaseDigest: string): string {
    return fileDigest(taskInputCanonical([scope.root, scope.directoryIdentity, releaseDigest]))
  }
  /** Root instructions/configuration are observed only, including explicit absence. */
  private observations(root: string): OrdinaryPackageRootObservation[] {
    const directories = captureDirectoryTree(root)
    const result = ORDINARY_PACKAGE_ROOT_PATHS.map(relativePath => {
      const parents = captureParents(root, relativePath)
      assertDirectories([...directories, ...parents])
      const bytes = readRegular(targetPath(root, relativePath)).bytes
      assertDirectories([...directories, ...parents])
      return { relativePath, digest: bytes === null ? null : fileDigest(bytes) }
    })
    assertDirectories(directories)
    return result
  }
  private assertObservations(intent: Intent): void {
    if (!same(this.observations(intent.root), intent.rootObservations)) conflict('Original root instructions or provider configuration changed; preserve those bytes and review the drift.')
  }
  private original(scope: OriginalScope, intent: Intent): void {
    const { root, directoryIdentity, request, nativeOwner, grant, workcopy } = intent
    if (!same(scope, { root, directoryIdentity, request, nativeOwner, grant, workcopy })) conflict('Original project workflow preparation belongs to another intent, owner or physical directory.')
  }
  private pin(intent: Intent): NativeWorkflowPackagePin {
    return nativeWorkflowPackagePinSchema.parse({ version: 1, handler: 'fixed-context/v1', operationId: intent.operationId,
      releaseDigest: intent.releaseDigest, manifestDigest: intent.manifestDigest, intentDigest: fileDigest(taskInputCanonical(intent)) })
  }
  private release(intent: Intent): Release {
    const release = this.read('releases', this.releaseKey(intent, intent.releaseDigest), releaseSchema)
    if (!release || release.root !== intent.root || release.directoryIdentity !== intent.directoryIdentity
      || release.operationId !== intent.operationId || release.releaseDigest !== intent.releaseDigest || release.manifestDigest !== intent.manifestDigest) conflict('Original release journal ownership is missing or changed.')
    const original = this.read('intents', release.preparationId, intentSchema)
    if (!original || fileDigest(taskInputCanonical(original)) !== release.intentDigest
      || original.request.preparationId !== release.preparationId || original.operationId !== release.operationId
      || original.root !== release.root || original.directoryIdentity !== release.directoryIdentity
      || original.releaseDigest !== release.releaseDigest || original.manifestDigest !== release.manifestDigest) conflict('Release does not match its original private preparation journal.')
    return release
  }
  private assertStatus(status: CutoverInstallationStatus, intent: Intent): void {
    if (!status.localVerified || status.rootDirectory !== intent.root || status.operationId !== intent.operationId || status.manifestDigest !== intent.manifestDigest) conflict('Original local workflow installation is incomplete or changed.')
  }
  /** Recover only a verified installed release, never take over a partial installation. */
  retainedInstalledScope(preparationId: string): ProjectWorkflowPreparationScope {
    const intent = this.read('intents', z.string().uuid().parse(preparationId), intentSchema)
    if (!intent || intent.request.preparationId !== preparationId) conflict('Original workflow preparation intent is unavailable.')
    this.release(intent); this.assertObservations(intent)
    const installer = new WorkflowCutoverInstaller({ privateDirectory: join(this.directory, 'plans'),
      validateAdmission: async () => { conflict('Preparation recovery inspection cannot change the installation.') } })
    this.assertStatus(installer.verifyInstalled(intent.operationId), intent)
    const { root, directoryIdentity, request, nativeOwner, grant, workcopy } = intent
    return { root, directoryIdentity, request, nativeOwner, grant, workcopy }
  }
  async prepare(rawScope: OriginalScope, materials: Omit<BuildOrdinaryPackageInput, 'rootObservations'>,
    guard: () => void, assertCurrent: () => Promise<void>): Promise<NativeWorkflowPackagePin> {
    const scope = originalScopeSchema.parse(rawScope)
    guard()
    if (scope.request.workflowPackagePolicy !== 'fixed-context/v1') conflict('Project workflow installation requires explicit versioned preparation policy.')
    if (within(scope.root, this.directory) || within(this.directory, scope.root)) conflict('Private workflow journals must stay outside the engineering directory.')
    this.storage(true)
    const previous = this.read('intents', scope.request.preparationId, intentSchema)
    if (previous) this.original(scope, previous)
    const rootObservations = previous?.rootObservations ?? this.observations(scope.root)
    const built = buildOrdinaryPackage({ ...materials, rootObservations })
    const key = this.releaseKey(scope, built.releaseDigest)
    const existing = this.read('releases', key, releaseSchema)
    const intent = previous ?? intentSchema.parse({ ...scope, version: 1, operationId: existing?.operationId ?? scope.request.preparationId,
      releaseDigest: built.releaseDigest, manifestDigest: built.manifestDigest, rootObservations })
    if (intent.releaseDigest !== built.releaseDigest || intent.manifestDigest !== built.manifestDigest) conflict('Original immutable workflow preview changed; resume its original inputs.')
    this.assertObservations(intent); guard()
    if (!previous) this.publish('intents', scope.request.preparationId, intent)
    const pin = this.pin(intent)
    if (!existing) this.publish('releases', key, { version: 1, root: scope.root, directoryIdentity: scope.directoryIdentity,
      operationId: intent.operationId, preparationId: scope.request.preparationId, intentDigest: pin.intentDigest,
      releaseDigest: built.releaseDigest, manifestDigest: built.manifestDigest } satisfies Release)
    const release = this.release(intent)
    const validate = async (): Promise<void> => {
      guard(); this.original(scope, intent); this.assertObservations(intent)
      if (!same(this.read('intents', scope.request.preparationId, intentSchema), intent)) conflict('Original workflow installation intent changed.')
      await assertCurrent()
      guard(); this.assertObservations(intent); this.release(intent)
    }
    const installer = new WorkflowCutoverInstaller({ privateDirectory: join(this.directory, 'plans'), validateAdmission: async request => {
      if (request.rootDirectory !== intent.root || request.operationId !== intent.operationId || request.manifestDigest !== intent.manifestDigest
        || request.action === 'rollback') conflict('Installer request differs from the original ordinary-package operation.')
      await validate()
    } })
    await validate()
    if (release.preparationId !== scope.request.preparationId) {
      // Another preparation can reuse a completed installation, never take over its partial operation.
      this.assertStatus(installer.verifyInstalled(intent.operationId), intent)
    } else {
      const staged = fileStat(join(this.directory, 'plans', intent.operationId, 'plan.json'))
      if (!staged) {
        if (fileStat(targetPath(scope.root, built.releaseDirectory))) conflict('An unowned workflow release directory already exists; preserve it for review.')
        await installer.stage({ operationId: intent.operationId, rootDirectory: scope.root, files: built.files })
        guard()
      }
      await validate()
      await installer.recover(intent.operationId); guard()
      await validate()
      this.assertStatus(await installer.install(intent.operationId), intent); guard()
    }
    await validate()
    this.assertStatus(installer.verifyInstalled(intent.operationId), intent)
    guard()
    return pin
  }
  /** No writes to the project, no source reads and no implicit repair at task start. */
  verify(binding: NativeTaskBinding): void {
    if (!binding.request.workflowPackagePolicy) {
      if (binding.workflowPackage) conflict('An ungoverned preparation cannot acquire a retrospective package pin.')
      return
    }
    const pin = binding.workflowPackage
    if (!pin) conflict('Required original workflow package pin is missing.')
    const intent = this.read('intents', binding.preparationId, intentSchema)
    if (!intent) conflict('Required original workflow preparation journal is missing.')
    const { root, directoryIdentity, request, nativeOwner, grant, workcopy } = binding
    this.original({ root, directoryIdentity, request, nativeOwner, grant, workcopy }, intent)
    if (!same(this.pin(intent), pin)) conflict('Required workflow release differs from the original private pin.')
    this.release(intent); this.assertObservations(intent)
    const installer = new WorkflowCutoverInstaller({ privateDirectory: join(this.directory, 'plans'),
      validateAdmission: async () => { conflict('Task-start verification cannot mutate the workflow installation.') } })
    this.assertStatus(installer.verifyInstalled(pin.operationId), intent)
  }
  /** Immutable private application-Hook evidence; contains no provider-native compatibility claim. */
  recordHook(binding: NativeTaskBinding, identity: ProjectWorkflowHookIdentity, boundary: HookBoundary, error?: unknown): void {
    if (!binding.request.workflowPackagePolicy) return
    const expected = binding.request.expected
    const record = hookSchema.parse({
      version: 1, owner: 'application', event: 'task-start', handler: 'fixed-context/v1', boundary,
      preparationId: binding.preparationId, task: binding.request.task, epoch: binding.request.pin.epoch,
      executionId: expected.executionId, generation: expected.generation, nodeId: expected.nodeId, attempt: expected.attempt,
      inputDigest: expected.inputDigest, releaseDigest: binding.workflowPackage?.releaseDigest ?? null,
      operationId: binding.workflowPackage?.operationId ?? null, manifestDigest: binding.workflowPackage?.manifestDigest ?? null,
      identity, outcome: error === undefined ? 'pass' : 'fail', observedAt: Date.now(),
      failure: error === undefined ? null : { code: error instanceof Error && 'code' in error ? String(error.code).slice(0, 80) : 'FIXED_CONTEXT_REJECTED' }
    })
    // Two immutable outcomes per boundary retain the first pass and first failure,
    // including a later failure after an earlier pass. Repeated assertions add no rows.
    const key = fileDigest(taskInputCanonical([identity.dispatchId, boundary, record.outcome]))
    this.storage(true)
    const bytes = readPrivate(captureDirectory(join(this.directory, 'hooks')), key + '.json', 2 * 1024 * 1024).bytes
    if (bytes) {
      const { observedAt: _at, failure: _failure, ...original } = hookSchema.parse(JSON.parse(bytes.toString('utf8')))
      const { observedAt: _nextAt, failure: _nextFailure, ...current } = record
      if (!same(original, current)) conflict('Original task-start Hook receipt belongs to a different fixed dispatch.')
      return
    }
    this.publish('hooks', key, record)
  }
}
