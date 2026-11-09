import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema, workspaceGrantSchema, type ProcessOwner } from '../../../shared/daemon/identity'
import { nativeWorkflowCutoverRequestSchema, nativeWorkflowCutoverPreviewRequestSchema, nativeWorkflowCutoverProposalSchema, type NativeWorkflowCutoverRequest } from '../../../shared/native-workflow-cutover'
import { cutoverCommandSchema, cutoverManifestSchema, type CutoverCommand, type CutoverRecord, type CutoverScope } from '../../../shared/team-cutover'
import { teamTaskIdentity, type TeamTaskRef } from '../../../shared/team-task-execution'
import type { ImportPreview } from '../../../shared/team-import'
import type { TeamContentRequest } from '../../../shared/team-content-transport'
import type { NativeContentPin } from '../team-platform/content-transport'
import type { NativeTaskPreparationAuthority } from '../../daemon/runtime/task-preparation'
import { createHash } from 'node:crypto'
import { workcopyOwnerSchema } from '../../../shared/workcopy-use'
import { sameOwner } from '../../daemon/native'
import { claimWorkspaceAdmission } from '../workflow-admission'
import { resolveWorkcopy, assertWorkcopyObservation } from '../workcopy-use/identity'
import type { WorkcopyUseRegistry } from '../workcopy-use/registry'
import { TrellisImportDiscovery } from '../trellis-import'
import { WorkflowCutoverInstaller } from './installer'
import { buildNativeWorkflowConnector, NATIVE_WORKFLOW_CONNECTOR_PATHS, getNativeBaselineConversion, type CutoverDispatchSurface } from './connectors'
import { assertDirectories, captureDirectory, captureDirectoryTree, captureParents, fileDigest, fileStat, boundedEntries, publishPrivate, readPrivate, readRegular, targetPath } from './files'
import { CutoverJournalStore, cutoverJournalSchema, cutoverFailure, verifyCutoverInstallation, type CutoverJournal, hasRetainedDispatchText } from './admission'
import { CutoverTransport, cutoverDigest } from './transport'
import { nativeProviderSettings, isNativeProviderHookSource } from './provider-hooks'
import { CUTOVER_FILE_LIMITS } from './types'

export interface WorkflowCutoverPorts {
  dataDir: string
  /** Current profile discovery is fixed by the authenticated native dispatcher. */
  accessDescriptorPath?: string
  workcopies: WorkcopyUseRegistry
  assertCurrent(authority: NativeTaskPreparationAuthority): void
  processIdentity(pid: number): Promise<ProcessOwner | null>
  assertLegacyAvailable(root: string): Promise<void>
  withTransport<T>(pin: NativeContentPin, assertCurrent: () => Promise<void>, task: TeamTaskRef, action: (request: TeamContentRequest) => Promise<T>): Promise<T>
}
const leaseRecoverySchema = z.object({ operationId: z.string().uuid(), root: z.string(), token: z.string().uuid(), owner: workcopyOwnerSchema, executor: processOwnerSchema }).strict()
const commandOwnerSchema = z.object({ root: z.string(), owner: processOwnerSchema, grant: workspaceGrantSchema, inputDigest: z.string() }).strict()
type ReviewRequest = Extract<NativeWorkflowCutoverRequest, { operation: 'preview' | 'propose' }>
const proposalReceiptSchema = z.object({ root: z.string(), directories: cutoverJournalSchema.shape.directories, inputDigest: z.string(), preview: nativeWorkflowCutoverPreviewRequestSchema }).strict()
const scopeOf = (command: CutoverCommand): CutoverScope => ({ instanceId: command.instanceId, projectId: command.projectId, namespaceId: command.namespaceId, workcopyDigest: command.workcopyDigest })
const dispatchKinds = new Set(['root-instruction', 'command', 'skill', 'agent', 'hook', 'script', 'workflow', 'configuration'])
// Frozen default managed instructions. Markers alone cannot attest custom behavior.
const BASELINE_MANAGED_ROOT_DIGEST = 'c1f511b1cfc1902f2147da159f09cc51f380b0c9e341cdb3ac5dea5233f3e307'
const PLATFORM_GATES = ['native-prepare-verify', 'current-handler-single-writer-adopted-input', 'fixed-artifact-delivery', 'configured-database-jira-transition'] as const

/** The original plan is immutable. Only observed receipts and local file milestones advance. */
export class WorkflowCutoverCoordinator {
  private readonly store: CutoverJournalStore
  private readonly pending = new Set<string>()
  constructor(private readonly ports: WorkflowCutoverPorts) { this.store = new CutoverJournalStore(ports.dataDir) }
  private commandPath(id: string): string { z.string().uuid().parse(id); return join(this.ports.dataDir, 'cutovers', 'native-commands', id + '.json') }
  assertReceiptAuthority(root: string, id: string, authority?: NativeTaskPreparationAuthority): void {
    if (!authority) cutoverFailure('CUTOVER_NATIVE_AUTHORITY_REQUIRED', 'Original cutover command requires protected native authority')
    this.ports.assertCurrent(authority)
    captureDirectoryTree(this.ports.dataDir)
    const file = this.commandPath(id); captureDirectoryTree(join(this.ports.dataDir, 'cutovers', 'native-commands'))
    const bytes = readPrivate(captureDirectory(dirname(file)), basename(file), CUTOVER_FILE_LIMITS.fileBytes).bytes
    if (!bytes) cutoverFailure('CUTOVER_NATIVE_AUTHORITY_REQUIRED', 'Original cutover command owner is unavailable')
    const original = commandOwnerSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (original.root !== root || !sameOwner(original.owner, authority.actor) || cutoverDigest(original.grant) !== cutoverDigest(authority.grant)) cutoverFailure('CUTOVER_NATIVE_OWNER_CHANGED', 'Cached cutover receipt belongs to its original native process and workspace grant')
    this.ports.assertCurrent(authority)
  }
  authorizeCommand(root: string, id: string, request: NativeWorkflowCutoverRequest, authority: NativeTaskPreparationAuthority): void {
    this.ports.assertCurrent(authority)
    if (authority.grant.root !== root) cutoverFailure('CUTOVER_NATIVE_OWNER_CHANGED', 'Native grant does not address this physical workcopy')
    const file = this.commandPath(id)
    if (fileStat(file)) {
      this.assertReceiptAuthority(root, id, authority)
      const bytes = readPrivate(captureDirectory(dirname(file)), basename(file), CUTOVER_FILE_LIMITS.fileBytes).bytes
      if (!bytes) cutoverFailure('CUTOVER_NATIVE_AUTHORITY_REQUIRED', 'Original cutover command owner disappeared')
      const original = commandOwnerSchema.parse(JSON.parse(bytes.toString('utf8')))
      if (original.inputDigest !== cutoverDigest(request)) cutoverFailure('COMMAND_PAYLOAD_CONFLICT', 'Runtime cutover UUID belongs to another original request')
      return
    }
    const workcopy = resolveWorkcopy(root)
    if (workcopy.canonicalRoot !== root) cutoverFailure('CUTOVER_WHOLE_WORKCOPY_REQUIRED', 'Native cutover requires the whole physical workcopy root')
    // This also rejects any private-path/workcopy overlap before a command index write.
    this.store.assertStorage(root)
    for (const directory of [join(this.ports.dataDir, 'cutovers'), join(this.ports.dataDir, 'cutovers', 'native-commands')]) {
      captureDirectoryTree(this.ports.dataDir)
      if (!fileStat(directory)) mkdirSync(directory, { mode: 0o700 })
      captureDirectoryTree(directory)
    }
    publishPrivate(captureDirectory(join(this.ports.dataDir, 'cutovers', 'native-commands')), id + '.json', Buffer.from(JSON.stringify({ root, owner: authority.actor, grant: authority.grant, inputDigest: cutoverDigest(request) })))
    this.assertReceiptAuthority(root, id, authority)
  }
  private leaseDirectory(operationId: string): string {
    return join(this.ports.dataDir, 'cutovers', 'native-leases', operationId)
  }
  /** Only a positively stopped coordinator can release its retained local-write capability. */
  private async recoverLeases(root: string, operationId: string, guard: () => void): Promise<void> {
    const directory = this.leaseDirectory(operationId)
    if (!fileStat(directory)) return
    const directories = captureDirectoryTree(directory)
    for (const name of boundedEntries(directory)) {
      if (/^\.publish-[0-9a-f-]{36}$/.test(name)) continue
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Unexpected original cutover lease receipt')
      guard(); assertDirectories(directories)
      const bytes = readPrivate(captureDirectory(directory), name, CUTOVER_FILE_LIMITS.fileBytes).bytes
      if (!bytes) cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Original cutover lease receipt disappeared')
      const saved = leaseRecoverySchema.parse(JSON.parse(bytes.toString('utf8')))
      if (saved.root !== root || saved.operationId !== operationId || saved.owner.kind !== 'git' || saved.owner.id !== operationId || name !== saved.token + '.json') cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Original cutover lease scope changed')
      const lease = this.ports.workcopies.leaseByDigest(createHash('sha256').update(saved.token).digest('hex'), saved.owner)
      if (!lease) continue
      const actual = await this.ports.processIdentity(saved.executor.pid)
      guard(); assertDirectories(directories)
      if (actual && sameOwner(actual, saved.executor)) cutoverFailure('CUTOVER_BUSY', 'Original local cutover coordinator is still alive')
      const released = this.ports.workcopies.release({ token: saved.token, owner: saved.owner, outcome: 'cleanup-confirmed' })
      if (!released.released) cutoverFailure('CUTOVER_BUSY', 'Original local-write occupancy remains unresolved')
    }
  }
  private async prepareLease(root: string, operationId: string, guard: () => void): Promise<z.infer<typeof leaseRecoverySchema>> {
    const executor = await this.ports.processIdentity(process.pid)
    guard()
    if (!executor) cutoverFailure('CUTOVER_NATIVE_AUTHORITY_REQUIRED', 'Actual local coordinator identity is unavailable')
    const token = randomUUID(), owner = { kind: 'git' as const, id: operationId, generation: randomUUID(), label: 'Convert whole-workcopy workflow' }
    const record = { operationId, root, token, owner, executor }
    this.store.assertStorage(root)
    for (const directory of [join(this.ports.dataDir, 'cutovers'), join(this.ports.dataDir, 'cutovers', 'native-leases'), this.leaseDirectory(operationId)]) {
      guard(); captureDirectoryTree(join(directory, '..'))
      if (!fileStat(directory)) mkdirSync(directory, { mode: 0o700 })
      captureDirectoryTree(directory)
    }
    publishPrivate(captureDirectory(this.leaseDirectory(operationId)), token + '.json', Buffer.from(JSON.stringify(record)))
    guard(); return record
  }
  private original(root: string, request: Exclude<NativeWorkflowCutoverRequest, { operation: 'preview' | 'propose' }>): CutoverJournal {
    const record = this.store.read(request.operationId)
    if (!record || record.root !== root) cutoverFailure('CUTOVER_ORIGINAL_MISSING', 'Original private cutover plan is unavailable for this granted root')
    assertDirectories(record.directories)
    return record
  }
  private proposalPath(operationId: string): string {
    z.string().uuid().parse(operationId)
    return join(this.ports.dataDir, 'cutovers', 'proposals', operationId + '.json')
  }
  private proposal(root: string, operationId: string): z.infer<typeof proposalReceiptSchema> | null {
    this.store.assertStorage(root)
    const file = this.proposalPath(operationId)
    assertDirectories(captureParents(this.ports.dataDir, 'cutovers/proposals/' + operationId + '.json'))
    if (!fileStat(file)) return null
    const bytes = readPrivate(captureDirectory(dirname(file)), basename(file), 24 * 1024 * 1024).bytes
    if (!bytes) return null
    const saved = proposalReceiptSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (saved.root !== root || saved.preview.command.operationId !== operationId) cutoverFailure('CUTOVER_SCOPE_CONFLICT', 'Original proposal belongs to another operation or granted root')
    assertDirectories(saved.directories)
    return saved
  }
  private async propose(root: string, request: Extract<NativeWorkflowCutoverRequest, { operation: 'propose' }>, authority: NativeTaskPreparationAuthority): Promise<unknown> {
    const identity = resolveWorkcopy(root), directories = captureDirectoryTree(root)
    if (root !== identity.canonicalRoot) cutoverFailure('CUTOVER_WHOLE_WORKCOPY_REQUIRED', 'Proposal requires the whole original physical workcopy')
    const guard = (): void => { this.ports.assertCurrent(authority); assertDirectories(directories); if (authority.grant.root !== root) cutoverFailure('CUTOVER_NATIVE_OWNER_CHANGED', 'Original granted root changed') }
    guard()
    const { pin, command } = request
    this.assertPin(pin, command)
    const task = request.manifest.tasks[0]
    if (!task) cutoverFailure('CUTOVER_SCOPE_CONFLICT', 'Proposal requires an original mapped task')
    const saved = this.proposal(root, command.operationId)
    if (saved && saved.inputDigest !== cutoverDigest(request)) cutoverFailure('COMMAND_PAYLOAD_CONFLICT', 'Cutover operation already has different original proposal inputs')
    if (!saved && this.store.read(command.operationId)) cutoverFailure('CUTOVER_STATE_CONFLICT', 'Existing reviewed operations must use their retained preview command')
    guard()
    const result = await this.ports.withTransport(pin, async () => guard(), task.task, async requestTransport => {
      guard()
      const reviewed = await this.review(root, saved ? saved.preview : request, new CutoverTransport(requestTransport), guard)
      guard()
      let preview = saved?.preview
      if (!preview) {
        const manifest = cutoverManifestSchema.safeParse({ contractVersion: 1, boundary: 'whole-workcopy', ...request.manifest,
          files: reviewed.actualFiles, nativeConnector: { id: 'trellis-panel-native', version: '1', digest: reviewed.connectorDigest } })
        if (!manifest.success) cutoverFailure('CUTOVER_BLOCKED', 'Reviewed conversions cannot form a complete native proposal: ' + reviewed.blockers.join('; ').slice(0, 700))
        preview = nativeWorkflowCutoverPreviewRequestSchema.parse({ operation: 'preview', pin,
          command: { ...command, manifest: manifest.data, manifestDigest: cutoverDigest(manifest.data) } })
        this.store.assertStorage(root)
        for (const directory of [join(this.ports.dataDir, 'cutovers'), join(this.ports.dataDir, 'cutovers', 'proposals')]) {
          guard(); captureDirectoryTree(join(directory, '..'))
          if (!fileStat(directory)) mkdirSync(directory, { mode: 0o700 })
          captureDirectoryTree(directory)
        }
        publishPrivate(captureDirectory(join(this.ports.dataDir, 'cutovers', 'proposals')), command.operationId + '.json', Buffer.from(JSON.stringify({ root, directories, inputDigest: cutoverDigest(request), preview })))
      }
      guard()
      return nativeWorkflowCutoverProposalSchema.parse({ preview, blockers: reviewed.blockers, ready: !reviewed.blockers.length,
        enforcement: { scope: 'platform-task-boundaries', gates: PLATFORM_GATES, editorHookRegistration: 'unverified' } })
    })
    guard(); return result
  }
  private assertPin(pin: NativeContentPin, command: Pick<CutoverCommand, 'expectedActorId' | 'expectedDeviceId' | 'expectedEpoch' | 'instanceId' | 'projectId'>): void {
    if (pin.actorId !== command.expectedActorId || pin.deviceId !== command.expectedDeviceId || pin.epoch !== command.expectedEpoch || pin.instanceId !== command.instanceId || pin.projectId !== command.projectId) cutoverFailure('CUTOVER_SCOPE_CONFLICT', 'Original native pin differs from the immutable stage command')
  }
  private async inventory(root: string, guard: () => void): Promise<ImportPreview> {
    guard(); const discovery = await TrellisImportDiscovery.open(root); guard()
    const preview = await discovery.preview(); guard(); return preview
  }
  private async review(root: string, request: ReviewRequest, transport: CutoverTransport, guard: () => void): Promise<{ inventory: ImportPreview; blockers: string[]; plan: ReturnType<typeof buildNativeWorkflowConnector>; actualFiles: { targetPath: string; beforeDigest: string | null; afterDigest: string | null }[]; connectorDigest: string }> {
    const manifest = request.operation === 'preview' ? request.command.manifest : request.manifest
    const inventory = await this.inventory(root, guard), imported = await transport.imported({ ...request.command, manifest }); guard()
    const blockers: string[] = []
    const block = (message: string): void => { if (blockers.length < 4000) blockers.push(message.slice(0, 500)) }
    if (inventory.truncated || imported.manifest.truncated) block('CUTOVER_SOURCE_INVENTORY_INCOMPLETE')
    if (inventory.owners.some(owner => owner.state !== 'idle')) block('CUTOVER_RETAINED_OWNER_UNVERIFIED')
    // Never substitute capture().tasks: that list contains selected assets only.
    if (cutoverDigest(inventory.tasks) !== cutoverDigest(imported.manifest.tasks)) block('CUTOVER_ALL_SOURCE_TASKS_REQUIRED')
    if (inventory.tasks.length !== manifest.tasks.length || inventory.tasks.some(task => !manifest.tasks.some(item => item.sourceTaskKey === task.sourceTaskKey))) block('CUTOVER_ALL_TASK_MAPPINGS_REQUIRED')
    for (const task of manifest.tasks) {
      const source = inventory.tasks.find(item => item.sourceTaskKey === task.sourceTaskKey)
      if (!source || !imported.receipts.some(receipt => receipt.mapping && receipt.mapping.sourceTaskKey === source.sourceTaskKey && receipt.mapping.locations.includes(source.location) && teamTaskIdentity(receipt.mapping.task) === teamTaskIdentity(task.task))) block('CUTOVER_SOURCE_MAPPING_MISSING:' + task.sourceTaskKey)
    }
    const selected = new Map(imported.manifest.assets.map(asset => [asset.itemKey, asset]))
    for (const asset of inventory.assets) {
      const bound = selected.get(asset.itemKey)
      if (!bound || bound.sourceDigest !== asset.sourceDigest || bound.relativePath !== asset.relativePath || bound.kind !== asset.kind || bound.sourceTaskKey !== asset.sourceTaskKey) block('CUTOVER_SOURCE_ASSET_UNBOUND:' + asset.relativePath)
    }
    if (selected.size !== inventory.assets.length) block('CUTOVER_SOURCE_ASSET_SET_CHANGED')
    const conversions = new Map(manifest.conversions.map(item => [item.itemKey, item]))
    const sources: CutoverDispatchSurface[] = inventory.assets.filter(asset => dispatchKinds.has(asset.kind)).map(asset => ({ sourceId: asset.itemKey, relativePath: asset.relativePath, digest: asset.sourceDigest,
      kind: asset.kind === 'workflow' || asset.kind === 'root-instruction' || asset.kind === 'command' || asset.kind === 'skill' || asset.kind === 'agent' || asset.kind === 'hook' || asset.kind === 'script' ? asset.kind : 'embedded-prompt' }))
    const originals = new Map<string, Buffer | null>()
    for (const target of new Set([...Object.values(NATIVE_WORKFLOW_CONNECTOR_PATHS), ...sources.map(item => item.relativePath), ...(request.operation === 'preview' ? request.command.manifest.files.map(file => file.targetPath) : [])])) {
      const parents = captureParents(root, target); assertDirectories(parents)
      originals.set(target, readRegular(targetPath(root, target)).bytes)
    }
    for (const source of sources) {
      if (source.kind !== 'root-instruction') continue
      const bytes = originals.get(source.relativePath)
      if (!bytes) continue
      const text = bytes.toString('utf8'), start = text.indexOf('<!-- TRELLIS:START -->'), end = text.indexOf('<!-- TRELLIS:END -->')
      const uniqueSpan = Buffer.from(text, 'utf8').equals(bytes) && !text.includes('\0') && start >= 0 && end > start
        && text.split('<!-- TRELLIS:START -->').length === 2 && text.split('<!-- TRELLIS:END -->').length === 2
      const managed = text.slice(start, end + '<!-- TRELLIS:END -->'.length).replace(/\r\n/g, '\n')
      const outside = text.slice(0, start) + text.slice(end + '<!-- TRELLIS:END -->'.length)
      // The known span owns dispatch. Preserve ordinary project rules byte-for-byte;
      // retained dispatch and explicit editor event requirements outside it need review.
      const editorBehavior = /(?:\b(?:PreToolUse|PostToolUse|SessionStart|UserPromptSubmit|StopHook)\b|(?:before|after|every)\s+(?:each\s+)?tool\b|每(?:个|次).{0,24}(?:工具|tool)|(?:inject|注入).{0,40}(?:context|上下文)|(?:must|require|enforce|install|register).{0,48}(?:editor|tool|context|stop).{0,16}hook|(?:必须|需要).{0,24}(?:编辑器|工具|上下文).{0,12}(?:钩子|hook))/i
      source.managedBlockOnly = uniqueSpan && fileDigest(managed) === BASELINE_MANAGED_ROOT_DIGEST
        && !hasRetainedDispatchText(outside) && !editorBehavior.test(outside)
      if (!source.managedBlockOnly || conversions.get(source.sourceId)?.implementation !== 'platform-root-v1') block('CUTOVER_ROOT_BEHAVIOR_REVIEW_REQUIRED:' + source.relativePath)
    }
    const instructionFiles: ('AGENTS.md' | 'CLAUDE.md')[] = []
    const reviewedBaseline: { sourceId: string; originalBytes: Buffer }[] = [], reviewedRemovals: { sourceId: string; originalBytes: Buffer }[] = [], reviewedProviderHooks: { sourceId: string; originalBytes: Buffer }[] = []
    for (const source of sources) {
      if (source.relativePath === 'AGENTS.md' || source.relativePath === 'CLAUDE.md') instructionFiles.push(source.relativePath)
      const bytes = originals.get(source.relativePath), conversion = conversions.get(source.sourceId)
      if (!bytes || !conversion) continue
      if (getNativeBaselineConversion(source.relativePath, bytes) === conversion.implementation) reviewedBaseline.push({ sourceId: source.sourceId, originalBytes: bytes })
      if (source.kind === 'hook' && conversion.implementation === 'platform-hook-v1' && (nativeProviderSettings(source.relativePath, bytes) || isNativeProviderHookSource(source.relativePath, bytes))) reviewedProviderHooks.push({ sourceId: source.sourceId, originalBytes: bytes })
      if ((source.kind === 'command' || source.kind === 'skill' || source.kind === 'agent') && conversion.implementation === 'removed-dispatch-v1') reviewedRemovals.push({ sourceId: source.sourceId, originalBytes: bytes })
    }
    const plan = buildNativeWorkflowConnector({ operationId: request.command.operationId, tasks: manifest.tasks.map(task => task.task), sourceInventory: sources, inventoryComplete: !inventory.truncated,
      originals: [...originals].map(([relativePath, bytes]) => ({ relativePath, bytes })), instructionFiles,
      reviewedBaseline: { version: 1, files: reviewedBaseline }, reviewedRemovals, reviewedProviderHooks, accessDescriptorPath: this.ports.accessDescriptorPath })
    plan.blockers.forEach(item => block(item.code + ':' + item.message))
    // Coverage requires a fixed baseline or the exact reviewed provider conversion;
    // arbitrary custom Hook/Skill/Agent behavior still has no inferred replacement.
    for (const source of sources) {
      if (source.kind === 'root-instruction') continue
      const bytes = originals.get(source.relativePath)
      const implementation = conversions.get(source.sourceId)?.implementation
      const providerSupported = bytes && implementation === 'platform-hook-v1' && source.kind === 'hook' && (nativeProviderSettings(source.relativePath, bytes) || isNativeProviderHookSource(source.relativePath, bytes))
      if (!bytes || getNativeBaselineConversion(source.relativePath, bytes) !== implementation && !providerSupported) block('CUTOVER_REQUIRED_NATIVE_BEHAVIOR_UNVERIFIED:' + source.relativePath)
    }
    for (const source of sources) {
      const conversion = conversions.get(source.sourceId)
      if (!conversion || conversion.sourceDigest !== source.digest || conversion.targetPath !== source.relativePath || !plan.coveredSourceIds.includes(source.sourceId)) block('CUTOVER_ORIGINAL_DISPATCH_UNCOVERED:' + source.relativePath)
    }
    for (const conversion of manifest.conversions) if (!sources.some(source => source.sourceId === conversion.itemKey && source.digest === conversion.sourceDigest)) block('CUTOVER_UNKNOWN_CONVERSION:' + conversion.itemKey)
    const actualFiles = plan.files.map(file => ({ targetPath: file.relativePath, beforeDigest: file.expectedBeforeDigest, afterDigest: file.afterDigest })).sort((a, b) => a.targetPath.localeCompare(b.targetPath))
    const connectorDigest = cutoverDigest(actualFiles.filter(file => file.targetPath.startsWith('.crux/workflow/')))
    if (request.operation === 'preview') {
      const declaredFiles = [...request.command.manifest.files].sort((a, b) => a.targetPath.localeCompare(b.targetPath))
      if (cutoverDigest(actualFiles) !== cutoverDigest(declaredFiles)) block('CUTOVER_GENERATED_PLAN_MISMATCH')
      if (request.command.manifest.nativeConnector.digest !== connectorDigest) block('CUTOVER_CONNECTOR_DIGEST_MISMATCH')
    }
    for (const blocker of [...inventory.blockers, ...imported.manifest.blockers]) {
      if (blocker.code === 'ACTIVATION_NOT_IMPLEMENTED' || blocker.code === 'NATIVE_OWNER_UNVERIFIED') continue
      if (blocker.code === 'BEHAVIOR_CONVERSION_REQUIRED' && blocker.relativePath && sources.some(source => source.relativePath === blocker.relativePath && plan.coveredSourceIds.includes(source.sourceId))) continue
      block(blocker.code + ':' + (blocker.relativePath ?? 'unresolved whole-workcopy source'))
    }
    return { inventory, blockers: [...new Set(blockers)], plan, actualFiles, connectorDigest }
  }
  private async verifyInventory(record: CutoverJournal, guard: () => void): Promise<void> {
    const current = await this.inventory(record.root, guard), original = record.inventory
    if (current.truncated || current.owners.some(owner => owner.state !== 'idle') || cutoverDigest(current.tasks) !== cutoverDigest(original.tasks)) cutoverFailure('CUTOVER_SOURCE_CHANGED', 'Whole source task inventory or retained ownership changed')
    const files = new Map(record.request.command.manifest.files.map(file => [file.targetPath, file]))
    const actual = new Map(current.assets.map(asset => [asset.itemKey, asset]))
    for (const asset of original.assets) {
      const now = actual.get(asset.itemKey), file = files.get(asset.relativePath)
      if (!now && file?.afterDigest === null) continue
      if (!now || now.relativePath !== asset.relativePath || now.sourceDigest !== asset.sourceDigest && now.sourceDigest !== file?.afterDigest) cutoverFailure('CUTOVER_SOURCE_CHANGED', 'Original source bytes changed: ' + asset.relativePath)
      actual.delete(asset.itemKey)
    }
    if ([...actual.values()].some(asset => !files.has(asset.relativePath))) cutoverFailure('CUTOVER_SOURCE_CHANGED', 'An unbound local asset appeared after original preview')
  }
  async execute(root: string, raw: NativeWorkflowCutoverRequest, authority: NativeTaskPreparationAuthority): Promise<unknown> {
    const request = nativeWorkflowCutoverRequestSchema.parse(raw)
    const originalAuthority = { actor: structuredClone(authority.actor), grant: structuredClone(authority.grant), assertProduct: authority.assertProduct.bind(authority) }
    this.ports.assertCurrent(originalAuthority)
    const operationId = request.operation === 'preview' || request.operation === 'propose' ? request.command.operationId : request.operationId
    if (this.pending.has(operationId)) cutoverFailure('CUTOVER_BUSY', 'Original cutover is still running; inspect and reconcile it')
    this.pending.add(operationId)
    let release: (() => void) | undefined
    try {
      if (request.operation === 'propose') return await this.propose(root, request, originalAuthority)
      const retained = request.operation === 'preview' ? this.store.read(operationId) : this.original(root, request)
      if (retained && retained.root !== root) cutoverFailure('CUTOVER_ORIGINAL_MISSING', 'Original cutover belongs to another physical root')
      const originalRequest = request.operation === 'preview' ? request : retained?.request
      if (!originalRequest) cutoverFailure('CUTOVER_ORIGINAL_MISSING', 'Original private cutover plan is unavailable')
      const { pin, command: stage } = originalRequest
      this.assertPin(pin, stage)
      if (request.operation === 'preview') {
        const proposed = this.proposal(root, operationId)
        if (proposed && cutoverDigest(proposed.preview) !== cutoverDigest(request)) cutoverFailure('COMMAND_PAYLOAD_CONFLICT', 'Preview must preserve the complete original native proposal command')
        if (retained) {
          if (cutoverDigest(retained.request) !== cutoverDigest(request)) cutoverFailure('COMMAND_PAYLOAD_CONFLICT', 'Cutover operation already has a different preview')
          this.ports.assertCurrent(originalAuthority)
          return { operationId, previewDigest: retained.previewDigest, manifest: stage.manifest, blockers: retained.blockers, ready: !retained.blockers.length, enforcement: { scope: 'platform-task-boundaries', gates: PLATFORM_GATES, editorHookRegistration: 'unverified' } }
        }
      }
      const identity = resolveWorkcopy(root), directories = captureDirectoryTree(root)
      if (root !== identity.canonicalRoot) cutoverFailure('CUTOVER_WHOLE_WORKCOPY_REQUIRED', 'Only the whole original workcopy can activate')
      let guard = (): void => { this.ports.assertCurrent(originalAuthority); assertDirectories(directories); if (originalAuthority.grant.root !== root) cutoverFailure('CUTOVER_NATIVE_OWNER_CHANGED', 'Original granted root changed') }
      if (request.operation !== 'inspect') {
        if (request.operation === 'recover') await this.recoverLeases(root, operationId, guard)
        guard()
        const retainedLease = await this.prepareLease(root, operationId, guard)
        const admission = claimWorkspaceAdmission(root, 'managed', undefined, { projectRoot: root })
        let lease: ReturnType<WorkcopyUseRegistry['acquire']> | undefined
        release = () => { if (lease) this.ports.workcopies.release({ token: lease.token, owner: lease.owner, outcome: 'settled' }); admission.release() }
        const baseGuard = guard
        guard = () => { baseGuard(); if (!admission.isCurrent()) cutoverFailure('CUTOVER_ADMISSION_CHANGED', 'Whole-workcopy admission changed'); assertWorkcopyObservation(lease ? this.ports.workcopies.assertHeld(root, lease.token, lease.owner) : resolveWorkcopy(root), identity) }
        guard()
        lease = this.ports.workcopies.acquire(root, { kind: 'tree-change', expected: { id: identity.id, revision: identity.revision }, owner: retainedLease.owner, token: retainedLease.token })
        guard(); await this.ports.assertLegacyAvailable(root); guard()
      }
      const guarded = async <T>(action: () => Promise<T>): Promise<T> => { guard(); const value = await action(); guard(); return value }
      const installer = new WorkflowCutoverInstaller({ privateDirectory: join(this.ports.dataDir, 'cutovers'), validateAdmission: async input => {
        guard(); if (input.operationId !== operationId || input.rootDirectory !== root) cutoverFailure('CUTOVER_SCOPE_CONFLICT', 'Installer changed its original operation or root')
      } })
      const task = stage.manifest.tasks[0]
      if (!task) cutoverFailure('CUTOVER_SCOPE_CONFLICT', 'Original cutover requires a mapped task')
      return await guarded(() => this.ports.withTransport(pin, async () => guard(), task.task, async requestTransport => {
        const transport = new CutoverTransport(requestTransport)
        const persist = (record: CutoverJournal): void => { guard(); const saved = this.store.save(record); record.sequence = saved.sequence; record.previousDigest = saved.previousDigest; guard() }
        if (request.operation === 'preview') {
          const reviewed = await guarded(() => this.review(root, request, transport, guard))
          const previewDigest = cutoverDigest({ root, directories, request, assets: reviewed.inventory.assets, tasks: reviewed.inventory.tasks, blockers: reviewed.blockers })
          const record: CutoverJournal = { version: 1, sequence: 0, previousDigest: null, request, root, directories, owner: originalAuthority.actor, grant: originalAuthority.grant,
            inventory: { assets: reviewed.inventory.assets, tasks: reviewed.inventory.tasks }, previewDigest, blockers: reviewed.blockers, target: 'activate', local: 'uninstalled', steps: [{ command: stage, state: 'prepared', receipt: null }], server: null }
          persist(record)
          if (!record.blockers.length) await guarded(() => installer.stage({ operationId, rootDirectory: root, files: reviewed.plan.files }))
          return { operationId, previewDigest, manifest: stage.manifest, blockers: record.blockers, ready: !record.blockers.length, enforcement: { scope: 'platform-task-boundaries', gates: PLATFORM_GATES, editorHookRegistration: 'unverified' } }
        }
        if (!retained) cutoverFailure('CUTOVER_ORIGINAL_MISSING', 'Original private cutover plan disappeared')
        const record = retained
        const result = () => ({ operationId, previewDigest: record.previewDigest, target: record.target, local: record.local, server: record.server, steps: record.steps, blockers: record.blockers })
        if (request.operation === 'inspect') {
          const current = await guarded(() => transport.read(scopeOf(stage), operationId))
          return { ...result(), observedServer: current }
        }
        if (request.operation === 'apply' && request.previewDigest !== record.previewDigest) cutoverFailure('STALE_PREVIEW', 'Apply requires the original reviewed whole-workcopy preview')
        if (record.blockers.length) cutoverFailure('CUTOVER_BLOCKED', record.blockers.join('; ').slice(0, 1000))
        if (request.operation === 'suspend' || request.operation === 'rollback') { record.target = request.operation; persist(record) }
        if (request.operation === 'apply' && record.target !== 'activate') cutoverFailure('CUTOVER_STATE_CONFLICT', 'Terminal control requires inspection or original recovery')
        const commit = async (command: CutoverCommand): Promise<boolean> => {
          const retainedStep = record.steps.find(item => item.command.commandId === command.commandId)
          const step: CutoverJournal['steps'][number] = retainedStep ?? { command, state: 'prepared', receipt: null }
          if (!retainedStep) { record.steps.push(step); persist(record) }
          if (cutoverDigest(step.command) !== cutoverDigest(command)) cutoverFailure('COMMAND_PAYLOAD_CONFLICT', 'Retained command UUID has another original body')
          if (step.state === 'committed') return true
          if (step.state !== 'prepared') {
            const receipt = await guarded(() => transport.reconcile(step.command))
            if (receipt) { step.receipt = receipt; step.state = 'committed'; persist(record); return true }
            if (request.operation !== 'recover') { step.state = 'unknown'; persist(record); return false }
          }
          step.state = 'dispatched'; persist(record)
          try { const receipt = await guarded(() => transport.command(step.command)); step.receipt = receipt; step.state = 'committed'; persist(record); return true }
          catch (error) { step.state = error && typeof error === 'object' && 'outcomeUnknown' in error && error.outcomeUnknown === false ? 'rejected' : 'unknown'; persist(record); throw error }
        }
        const observe = async (): Promise<CutoverRecord> => {
          const current = await guarded(() => transport.read(scopeOf(stage), operationId))
          const receipt = record.steps.filter(step => step.receipt).at(-1)?.receipt
          if (!current || !receipt || current.manifestDigest !== stage.manifestDigest || current.revision !== receipt.revision || current.lastCommandId !== receipt.commandId) cutoverFailure('CUTOVER_RECEIPT_MISMATCH', 'Current operation does not match its original committed receipt')
          record.server = current; persist(record); return current
        }
        const next = (action: Exclude<CutoverCommand['action'], 'stage'>, server: CutoverRecord): CutoverCommand => {
          const retainedStep = record.steps.find(step => step.command.action === action)
          if (retainedStep) return retainedStep.command
          const { manifest: _manifest, manifestDigest: _digest, ...envelope } = stage
          return cutoverCommandSchema.parse({ ...envelope, commandId: randomUUID(), expectedRevision: server.revision, action,
            ...(action === 'installed' ? { installation: { manifestDigest: stage.manifestDigest, connectorDigest: stage.manifest.nativeConnector.digest, files: stage.manifest.files.map(file => ({ targetPath: file.targetPath, afterDigest: file.afterDigest })) } } : {}) })
        }
        // Only explicit recover may re-dispatch the exact original unknown body; never advance past it.
        for (const step of record.steps) if (step.state !== 'committed' && step.state !== 'prepared' && !await commit(step.command)) return result()
        const firstStep = record.steps[0]
        if (!firstStep || firstStep.command.action !== 'stage' || firstStep.command.commandId !== stage.commandId) cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Original stage milestone is missing')
        if (!firstStep.receipt) {
          await guarded(() => this.verifyInventory(record, guard))
          if (!await commit(stage)) return result()
        }
        let server = await observe()
        if (record.target === 'suspend' || record.target === 'rollback') {
          if (server.state !== 'suspended' && server.state !== 'rolled-back') { if (!await commit(next('suspend', server))) return result(); server = await observe() }
          if (record.target === 'rollback' && server.state !== 'rolled-back') {
            const status = await guarded(() => installer.rollback(operationId))
            if (status.phase !== 'rolled-back') return { ...result(), installation: status }
            record.local = 'rolled-back'; persist(record)
            if (await commit(next('rollback', server))) await observe()
          }
          return result()
        }
        if (server.state === 'active') { await verifyCutoverInstallation(this.ports.dataDir, record, guard); return result() }
        if (server.state !== 'staged' && server.state !== 'installed') cutoverFailure('CUTOVER_STATE_CONFLICT', 'Original activation cannot resume from a terminal server state')
        await guarded(() => this.verifyInventory(record, guard))
        let installed = await guarded(() => request.operation === 'recover' ? installer.recover(operationId) : installer.install(operationId))
        if (request.operation === 'recover' && (installed.phase === 'staged' || installed.phase === 'installing')) installed = await guarded(() => installer.install(operationId))
        if (!installed.localVerified || installed.phase !== 'installed') return { ...result(), installation: installed }
        record.local = 'installed'; persist(record); await verifyCutoverInstallation(this.ports.dataDir, record, guard)
        if (server.state === 'staged') { if (!await commit(next('installed', server))) return result(); server = await observe() }
        await guarded(() => this.ports.assertLegacyAvailable(root)); await guarded(() => this.verifyInventory(record, guard)); await verifyCutoverInstallation(this.ports.dataDir, record, guard)
        if (await commit(next('activate', server))) await observe()
        await verifyCutoverInstallation(this.ports.dataDir, record, guard); guard(); return result()
      }))
    } finally { release?.(); this.pending.delete(operationId) }
  }
}
