import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { nativeTaskExecutionRequestSchema, nativeTaskExecutionResultSchema, nativeTaskStartSchema,
  type NativeTaskExecutionRequest, type NativeTaskExecutionResult, type NativeTaskStart } from '../../../shared/native-task-execution'
import { processOwnerSchema, workspaceGrantSchema } from '../../../shared/daemon/identity'
import { workcopyLeaseSchema, type WorkcopyLease } from '../../../shared/workcopy-use'
import { teamExecutionCommandSchema, teamExecutionReceiptSchema, teamTaskIdentity, type TeamExecutionCommand } from '../../../shared/team-task-execution'
import { executionArtifactKindSchema, executionCodeSourceSchema, type ExecutionArtifactRef, type ExecutionCodeSource, type ExecutionDeliveryManifest } from '../../../shared/team-execution-artifacts'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { executionContextManifestSchema } from '../../../shared/team-execution-input'
import { replayConversationTextEvents } from '../../../shared/acp-text-blocks'
import type { NativeTaskBinding } from '../../../shared/native-task-preparation'
import type { TimelineEvent } from '../../../shared/types'
import type { IpcFail } from '../../../shared/ipc-errors'
import { DaemonError } from '../errors'
import { readBounded, writeAtomic, writeExclusiveAtomic } from '../files'
import { processIdentity, sameOwner } from '../native'
import { NativeTaskPreparation, type NativeTaskPreparationAuthority } from './task-preparation'
import { confirmDatabaseDelivery } from './database-delivery'
import * as acp from '../../services/acp'
import { BUILTINS } from '../../services/acp/setup'
import { PI_VERSION } from '../../services/pi/protocol'
import { observeWorkflowAcp } from '../../services/workflow-runtime/acp-events'
import { prepareExecutionAgentRules } from '../../services/agent-rules'
import { captureSelectedFile, verifyHandoffSource } from '../../services/crux/task-outputs/handoff-source'
import { readTaskSessionIntent } from '../../services/workcopy-use/task-session-intent'
import type { WorkcopyUseRegistry } from '../../services/workcopy-use/registry'
import { resolveWorkcopy, assertWorkcopyObservation } from '../../services/workcopy-use/identity'
import type { WorkspaceAdmission } from '../../services/workflow-admission'
import type { TaskExecutionTransport } from '../../services/team-platform/task-execution-transport'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const MAX_RECORD_BYTES = 4 * 1024 * 1024
const STOP_RECORD_HEADROOM_BYTES = 4 * 1024
const reportSchema = nativeTaskExecutionRequestSchema.options[1]
const candidateSchema = z.object({ outputId: z.string(), bodyDigest: z.string().length(64), byteLength: z.number().int().nonnegative(),
  artifactKind: executionArtifactKindSchema, capturedAt: z.number().int().nonnegative() }).strict()
const mutationSchema = z.object({ key: z.string(), command: teamExecutionCommandSchema, receipt: teamExecutionReceiptSchema.nullable() }).strict()
const recordSchema = z.object({ version: z.literal(1), request: nativeTaskStartSchema, root: z.string(),
  executionKey: z.string().length(64),
  grant: workspaceGrantSchema, nativeOwner: processOwnerSchema, result: nativeTaskExecutionResultSchema,
  admitted: z.boolean(), nativeEntered: z.boolean(), stopRequested: z.boolean(), stopCommandId: z.string().uuid().nullable(),
  commandIds: z.array(z.string().uuid()).max(128), lease: workcopyLeaseSchema.nullable(),
  nativeIntents: z.array(z.object({ commandId: z.string().uuid(), request: nativeTaskExecutionRequestSchema }).strict()).max(128),
  context: executionContextManifestSchema.nullable(),
  baselines: z.array(z.object({ outputId: z.string(), digest: z.string().length(64).nullable() }).strict()).max(16),
  candidates: z.array(candidateSchema).max(16), mutations: z.array(mutationSchema).max(64), report: reportSchema.nullable()
}).strict()
type Record = z.infer<typeof recordSchema>
type Report = z.infer<typeof reportSchema>
type Candidate = z.infer<typeof candidateSchema>
type Live = { admission?: WorkspaceAdmission; launch?: acp.PlatformAcpLaunch; start?: Promise<void>; capture?: Promise<void>; stop?: Promise<void>; unobserve?: () => void }
export interface NativeTaskExecutionPorts {
  directory: string
  workcopies: WorkcopyUseRegistry
  preparation: NativeTaskPreparation
  assertOwner(): void
  assertCurrent(grant: Record['grant']): void
}

/** A facade over existing native controllers, not an engine, scheduler or task-state owner. */
export class NativeTaskExecutions {
  private readonly directory: string
  private readonly records = new Map<string, Record>()
  private readonly live = new Map<string, Live>()
  private readonly exitedOrigins = new Set<string>()
  constructor(private readonly ports: NativeTaskExecutionPorts) {
    this.directory = join(realpathSync.native(ports.directory), 'native-task-executions')
    if (!existsSync(this.directory)) return
    this.storage()
    const entries = readdirSync(this.directory)
    if (entries.length > 2000) throw new DaemonError('E_BUSY', 'Retained native execution storage exceeds its limit')
    for (const id of entries) {
      z.string().uuid().parse(id)
      const record = recordSchema.parse(JSON.parse(readBounded(this.path(id), MAX_RECORD_BYTES)))
      if (record.request.dispatchId !== id) throw new DaemonError('E_DENIED', 'Retained native execution identity changed')
      if (!record.result.cleanupConfirmed) record.result.state = 'unknown'
      record.result.permissions = []
      this.records.set(id, record)
    }
  }
  private storage(): void {
    if (existsSync(this.directory) && (lstatSync(this.directory).isSymbolicLink() || realpathSync.native(this.directory) !== this.directory)) throw new DaemonError('E_DENIED', 'Native execution storage cannot be redirected')
  }
  private path(id: string): string {
    z.string().uuid().parse(id); this.storage()
    const directory = join(this.directory, id)
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || realpathSync.native(directory) !== directory)) throw new DaemonError('E_DENIED', 'Original native execution directory was redirected')
    const file = join(directory, 'record.json')
    if (existsSync(file)) {
      const entry = lstatSync(file)
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new DaemonError('E_DENIED', 'Original native execution metadata must be a single regular file')
    }
    return file
  }
  private outputPath(record: Record, outputId: string, create = false): string {
    this.path(record.request.dispatchId)
    const directory = join(this.directory, record.request.dispatchId, 'outputs')
    if (create && !existsSync(directory)) mkdirSync(directory)
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(directory) !== directory) throw new DaemonError('E_DENIED', 'Original native output directory cannot be redirected')
    const file = join(directory, hash(outputId) + '.txt')
    if (existsSync(file)) {
      const entry = lstatSync(file)
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new DaemonError('E_DENIED', 'Original native output must be a single regular file')
    }
    return file
  }
  private save(record: Record): void {
    this.ports.assertOwner()
    const parsed = recordSchema.parse(record), text = JSON.stringify(parsed)
    // Preserve bytes for the dedicated Stop ID/state and bounded pending-command
    // projection. Budget derived fields before a response hydrates them in memory.
    const projectedBytes = Buffer.byteLength(JSON.stringify({ ...parsed, result: { ...parsed.result, ...this.projection(parsed) } }))
    const limit = MAX_RECORD_BYTES - (record.stopCommandId ? 0 : STOP_RECORD_HEADROOM_BYTES)
    if (Math.max(Buffer.byteLength(text), projectedBytes) > limit) throw new DaemonError('E_BUSY', 'Native execution metadata exceeds its bound or reserved Stop headroom')
    writeAtomic(this.path(record.request.dispatchId), text)
  }
  private record(id: string): Record {
    const record = this.records.get(id)
    if (!record) throw new DaemonError('E_UNAVAILABLE', 'Original native dispatch is unavailable')
    return record
  }
  retainedGrant(id: string): Record['grant'] { this.ports.assertOwner(); return structuredClone(this.record(id).grant) }
  private binding(record: Record): NativeTaskBinding { return this.ports.preparation.retained(record.request.preparationId) }
  private assertOwned(record: Record): void {
    this.ports.assertOwner(); this.ports.assertCurrent(record.grant)
    if (!record.admitted || record.stopRequested || record.result.cleanupConfirmed || !record.lease) throw new DaemonError('E_CONFLICT', 'Original native execution no longer admits new writes')
    const live = this.live.get(record.request.dispatchId)
    if (!live?.admission?.isCurrent()) throw new DaemonError('E_UNKNOWN', 'Original native execution requires reconciliation', 'unknown')
    const actual = this.ports.workcopies.assertHeld(record.root, record.lease.token, record.lease.owner)
    assertWorkcopyObservation(actual, record.lease.identity)
  }
  private async assertUse(record: Record): Promise<void> {
    this.assertOwned(record)
    await this.ports.preparation.withExecution(this.binding(record), () => this.assertOwned(record), async () => {})
    this.assertOwned(record)
  }
  private async assertActor(record: Record, actor: Record['nativeOwner'], assertProduct: () => void): Promise<void> {
    const original = structuredClone(record.nativeOwner), current = structuredClone(actor)
    this.ports.assertOwner(); assertProduct()
    if (sameOwner(original, current)) return
    const executableKey = (value: string): string => {
      const path = realpathSync.native(value)
      return process.platform === 'win32' ? path.toLowerCase() : path
    }
    if (!record.admitted || current.userId !== original.userId) throw new DaemonError('E_DENIED', 'Original native dispatch cannot be recovered by this process')
    const executable = executableKey(original.executable)
    if (executableKey(current.executable) !== executable) throw new DaemonError('E_DENIED', 'Original native dispatch belongs to another application')
    const key = taskInputCanonical(original)
    if (!this.exitedOrigins.has(key)) {
      // A failed/unknown native query cannot establish exit. PID reuse is safe
      // only when the actual queried PID has a different process birth.
      const actual = await processIdentity(original.pid)
      this.ports.assertOwner(); assertProduct()
      if (!sameOwner(record.nativeOwner, original) || executableKey(original.executable) !== executable || executableKey(current.executable) !== executable) throw new DaemonError('E_CONFLICT', 'Original native recovery identity changed')
      if (actual && (actual.pid !== original.pid || actual.startedAt === original.startedAt)) throw new DaemonError('E_DENIED', 'Original native GUI is still live or its exit could not be verified')
      // Only this irreversible exit fact is cached; it grants no task, input,
      // device, configuration or workspace authority and changes no provenance.
      this.exitedOrigins.add(key)
    }
    this.ports.assertOwner(); assertProduct()
  }
  async assertAuthority(root: string, request: NativeTaskExecutionRequest, authority: NativeTaskPreparationAuthority): Promise<void> {
    this.ports.assertOwner(); authority.assertProduct()
    if (request.operation === 'start') {
      if (root !== authority.grant.root) throw new DaemonError('E_DENIED', 'Product start requires its original workspace grant')
      this.ports.preparation.assertAuthority(root, { operation: 'inspect', preparationId: request.preparationId }, authority)
    } else {
      const original = this.record(request.dispatchId)
      if (root !== '@profile' && root !== original.root) throw new DaemonError('E_DENIED', 'Original native dispatch belongs to another directory')
      await this.assertActor(original, authority.actor, authority.assertProduct.bind(authority))
    }
  }
  async assertReceipt(root: string, commandId: string, assertProduct: () => void, actor: Record['nativeOwner']): Promise<void> {
    const record = [...this.records.values()].find(record => (record.commandIds.includes(commandId) || record.stopCommandId === commandId) && (root === '@profile' || record.root === root))
    if (!record) throw new DaemonError('E_DENIED', 'Original product command has no retained native identity')
    await this.assertActor(record, actor, assertProduct)
  }
  async execute(root: string, raw: NativeTaskExecutionRequest, authority: NativeTaskPreparationAuthority, commandId?: string): Promise<NativeTaskExecutionResult> {
    const request = nativeTaskExecutionRequestSchema.parse(raw)
    await this.assertAuthority(root, request, authority)
    if (request.operation === 'start') {
      if (request.dispatchId !== commandId) throw new DaemonError('E_CONFLICT', 'Native dispatch ID must equal its original start command UUID')
      await this.start(root, request, authority)
    } else {
      const record = this.record(request.dispatchId)
      if (request.operation !== 'reconcile' && request.operation !== 'stop' && commandId) {
        if (record.stopCommandId === commandId) throw new DaemonError('E_CONFLICT', 'Original stop command cannot become another native intent')
        const original = record.nativeIntents.find(item => item.commandId === commandId)
        if (original && taskInputCanonical(original.request) !== taskInputCanonical(request)) throw new DaemonError('E_CONFLICT', 'Original native command intent changed')
        if (!original) {
          if (record.commandIds.length >= 128 || record.nativeIntents.length >= 128) throw new DaemonError('E_BUSY', 'Original native command retention is full; retained intents are preserved')
          const intent = { commandId, request: structuredClone(request) }
          this.save({ ...record, commandIds: [...record.commandIds, commandId], nativeIntents: [...record.nativeIntents, intent] })
          record.commandIds.push(commandId); record.nativeIntents.push(intent)
        }
      }
      if (request.operation === 'stop') {
        if (!commandId) throw new DaemonError('E_INVALID_ARG', 'Original native Stop requires its stable command UUID')
        const original = record.nativeIntents.find(item => item.commandId === commandId)
        if (original && taskInputCanonical(original.request) !== taskInputCanonical(request)) throw new DaemonError('E_CONFLICT', 'Original native command intent changed')
        if (!record.stopCommandId) { this.save({ ...record, stopCommandId: commandId }); record.stopCommandId = commandId }
        await this.stop(record)
      } else if (request.operation === 'reconcile') await this.reconcile(record)
      else if (request.operation === 'permission') {
        await this.assertUse(record)
        const launch = this.live.get(record.request.dispatchId)?.launch
        if (!launch) throw new DaemonError('E_UNKNOWN', 'Original native configuration owner is unavailable', 'unknown')
        launch.assertCurrent()
        const native = acp.platformAcpSession(record.root, record.result.native.sessionId, record.request.dispatchId)
        const pending = native?.pendingPermissions?.find(item => item.requestId === request.requestId
          && item.connectionGeneration === record.result.native.connectionGeneration && item.turnId === record.result.native.turnId)
        if (!pending || pending.options.filter(option => option.optionId === request.optionId).length !== 1) throw new DaemonError('E_CONFLICT', 'Original scoped native permission is no longer pending')
        const result = acp.respondAcpPermission(record.root, request.requestId, request.optionId, record.request.dispatchId)
        if (!result.ok) throw new DaemonError('E_CONFLICT', 'Original native permission was not accepted')
      } else await this.report(record, request)
    }
    return this.result(this.record(request.dispatchId))
  }
  private result(record: Record): NativeTaskExecutionResult {
    const native = acp.platformAcpSession(record.root, record.result.native.sessionId, record.request.dispatchId)
    if (native) {
      if (native.connectionGeneration !== record.result.native.connectionGeneration) throw new DaemonError('E_CONFLICT', 'Original native connection generation changed')
      record.result.native.backendSessionId = native.backendSessionId ?? null
      record.result.native.agentSessionId = native.agentSessionId ?? null
      record.result.native.modelId = native.currentModelId ?? null
      record.result.permissions = (native.pendingPermissions ?? []).filter(item => item.turnId === record.result.native.turnId && item.connectionGeneration === record.result.native.connectionGeneration)
        .map(item => ({ requestId: item.requestId, tool: item.toolCall?.title ?? null, expiresAt: item.expiresAt ?? null, options: item.options }))
    }
    Object.assign(record.result, this.projection(record))
    return nativeTaskExecutionResultSchema.parse(record.result)
  }
  private projection(record: Record): Pick<NativeTaskExecutionResult, 'outputs' | 'pendingCommands' | 'context'> {
    return { outputs: record.candidates.map(({ outputId, bodyDigest, byteLength }) => ({ outputId, bodyDigest, byteLength })),
      pendingCommands: record.mutations.filter(item => !item.receipt).map(item => item.command.commandId), context: record.context }
  }
  private promptFailure(record: Record, failure: IpcFail): DaemonError {
    const code = failure.code === 'E_UPSTREAM' || failure.code === 'E_UNAUTHORIZED' || failure.code === 'E_TIMEOUT'
      || failure.code === 'E_NO_PROJECT' || failure.code === 'E_NOT_FOUND' ? 'E_UNKNOWN' : failure.code
    const admitted = record.result.native.turnId !== null
    return new DaemonError(code, (`Original product prompt ${admitted ? 'write was not confirmed' : 'was not admitted'} (${failure.code}): ${failure.error}`).slice(0, 400), admitted ? 'unknown' : 'not-admitted')
  }
  private async start(root: string, request: NativeTaskStart, authority: NativeTaskPreparationAuthority): Promise<void> {
    if (this.records.has(request.dispatchId)) throw new DaemonError('E_UNKNOWN', 'Original launch cannot be repeated; reconcile it', 'unknown')
    if (this.records.size >= 2000) throw new DaemonError('E_BUSY', 'Native execution retention is full')
    const binding = this.ports.preparation.retained(request.preparationId), expected = binding.request.expected
    const executionKey = hash(taskInputCanonical([teamTaskIdentity(binding.request.task), binding.request.pin.epoch, expected.executionId, expected.generation, expected.nodeId, expected.attempt]))
    // Synchronous reservation precedes all configuration/source waits and spans
    // independent workcopies. A second UUID cannot duplicate one server attempt.
    if ([...this.records.values()].some(record => record.executionKey === executionKey && (!record.result.cleanupConfirmed || record.mutations.some(item => !item.receipt)))) throw new DaemonError('E_BUSY', 'Original server execution/node/attempt already has active or uncertain native work or shared writes')
    const record: Record = { version: 1, request: structuredClone(request), root, executionKey, grant: structuredClone(authority.grant), nativeOwner: structuredClone(authority.actor),
      result: { dispatchId: request.dispatchId, preparationId: request.preparationId, boundary: 'node-attempt', scope: { executionId: expected.executionId, generation: expected.generation,
        nodeId: expected.nodeId, attempt: expected.attempt, inputDigest: expected.inputDigest }, state: 'starting', native: { sessionId: `product-${request.dispatchId}`,
        connectionGeneration: null, backendSessionId: null, agentSessionId: null, agentId: request.engine.agentId, configurationDigest: null, adapterVersion: null, modelId: null,
        turnId: null, promptDigest: null, promptWritten: false, outcome: null }, outputs: [], manifest: null, checkpoint: null, context: null, cleanupConfirmed: false, pendingCommands: [], permissions: [] },
      admitted: false, nativeEntered: false, stopRequested: false, stopCommandId: null, commandIds: [request.dispatchId], nativeIntents: [{ commandId: request.dispatchId, request: structuredClone(request) }], lease: null, context: null,
      baselines: [], candidates: [], mutations: [], report: null }
    // Full original intent and UUID precede configuration discovery and native effects.
    this.records.set(request.dispatchId, record); this.save(record)
    const live: Live = {}; this.live.set(request.dispatchId, live)
    const original = { actor: structuredClone(authority.actor), grant: structuredClone(authority.grant), assertProduct: authority.assertProduct.bind(authority) }
    live.start = this.launch(record, original, live).catch(error => { record.result.state = record.stopRequested ? 'stop-requested' : 'unknown'; this.save(record); throw error })
    await live.start
  }
  private async launch(record: Record, authority: NativeTaskPreparationAuthority, live: Live): Promise<void> {
    const request = record.request
    const plan = await acp.preparePlatformAcpLaunch(record.root, request.engine)
    if (record.stopRequested) throw new DaemonError('E_CONFLICT', 'Original native start was stopped before admission')
    live.launch = plan; record.result.native.configurationDigest = plan.digest
    record.result.native.connectionGeneration = await acp.reservePlatformAcpSession(record.root, record.result.native.sessionId, request.engine.agentId)
    this.save(record)
    await this.ports.preparation.execute(record.root, { operation: 'verify', preparationId: request.preparationId }, authority, (binding, admission, releasePreparation) => {
      plan.assertCurrent()
      if (record.stopRequested || binding.request.origin !== 'product' || binding.execution.ownership !== 'product-managed') throw new DaemonError('E_CONFLICT', 'Original product launch is no longer admitted')
      const version = request.engine.agentId === 'pi' ? PI_VERSION : BUILTINS[request.engine.agentId].version
      record.result.native.adapterVersion = version
      if (binding.execution.executor.engine !== request.engine.agentId || binding.execution.executor.adapterVersion !== version) throw new DaemonError('E_CONFLICT', 'Actual engine/adapter does not match the fixed server executor')
      const node = binding.input.definition.nodes.find(node => node.id === binding.execution.nodeId)
      if (!node || node.kind !== 'agent') throw new DaemonError('E_UNAVAILABLE', 'Product start requires the declared current Agent node')
      const role = binding.input.definition.roles.find(role => role.id === node.roleId)
      const required = [...node.requiredCapabilities, ...role?.requiredCapabilities ?? []]
      if (required.some(capability => capability !== (request.engine.agentId === 'pi' ? 'sdkContext' : 'embeddedContext'))) throw new DaemonError('E_UNAVAILABLE', 'Required native capability has no verified adapter evidence')
      for (const output of request.outputs) {
        const declared = node.outputs.find(item => item.id === output.outputId)
        if (!declared || !executionArtifactKindSchema.safeParse(declared.kind).success || output.source.kind === 'assistant' && ['source-patch', 'selected-file'].includes(declared.kind)) throw new DaemonError('E_UNAVAILABLE', 'Selected output requires a supported declared native artifact kind')
      }
      const database = request.databaseDelivery
      if (database) {
        const implementation = node.outputs.find(output => output.id === database.implementationOutputId)
        const report = node.outputs.find(output => output.id === database.reportOutputId)
        if (implementation?.kind !== 'implement' || report?.kind !== 'check-report'
          || database.implementationOutputId === database.reportOutputId
          || request.outputs.some(output => [database.implementationOutputId, database.reportOutputId].includes(output.outputId))) throw new DaemonError('E_INVALID_ARG', 'Database delivery requires separate declared document/check-report outputs')
      }
      if (node.outputs.some(output => output.required && !request.outputs.some(selected => selected.outputId === output.id)
        && ![database?.implementationOutputId, database?.reportOutputId].includes(output.id))) throw new DaemonError('E_INVALID_ARG', 'Select every required declared output before starting')
      releasePreparation()
      const generation = record.result.native.connectionGeneration
      if (!generation) throw new DaemonError('E_CONFLICT', 'Original native generation is unavailable')
      record.lease = this.ports.workcopies.acquire(record.root, { kind: 'writer', expected: { id: binding.workcopy.id, revision: binding.workcopy.revision },
        owner: { kind: 'agent', id: record.result.native.sessionId, generation, taskKey: `session:${record.result.native.sessionId}`, label: 'Product task execution' } })
      record.admitted = true; live.admission = admission
      record.result.scope = { executionId: binding.execution.executionId, generation: binding.execution.generation,
        nodeId: binding.execution.nodeId, attempt: binding.execution.attempt, inputDigest: binding.input.digest }
      this.save(record)
      admission.retainNative(() => !record.result.cleanupConfirmed)
    })
    const binding = this.binding(record)
    const prepared = await this.ports.preparation.withExecution(binding, () => this.assertOwned(record), async (_transport, source) => prepareExecutionAgentRules({ executionSource: source, nodeId: binding.execution.nodeId }))
    record.context = prepared.manifest
    this.save(record)
    live.unobserve = observeWorkflowAcp({ scope: { projectRoot: record.root, sessionId: record.result.native.sessionId, connectionGeneration: record.result.native.connectionGeneration ?? undefined },
      event: event => this.event(record, event, live) })
    record.nativeEntered = true; this.save(record)
    const created = await acp.newPlatformAcpSession(record.root, plan, { metadata: { dispatchId: request.dispatchId, preparationId: request.preparationId,
      taskIdentity: teamTaskIdentity(binding.request.task), configurationDigest: plan.digest }, lease: this.lease(record),
      assertActive: () => { this.assertOwned(record); plan.assertCurrent() }, assertCurrent: () => this.assertUse(record) })
    if (!created.ok) throw new DaemonError('E_UNKNOWN', 'Original product native creation did not confirm readiness; inspect its retained owner', 'unknown')
    record.result.native.backendSessionId = created.session.backendSessionId ?? null; record.result.native.agentSessionId = created.session.agentSessionId ?? null
    record.result.native.modelId = created.session.currentModelId ?? null
    this.save(record)
    this.assertOwned(record); await prepared.assertCurrent()
    for (const selected of request.outputs) {
      let digest: string | null = null
      if (selected.source.kind === 'file') {
        try { digest = (await captureSelectedFile({ root: record.root, relativePath: selected.source.relativePath, assertOwned: () => this.assertOwned(record) })).bodyDigest }
        catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
      }
      record.baselines.push({ outputId: selected.outputId, digest })
    }
    this.save(record)
    const text = request.instruction + '\n\nDeclared outputs (engineering-relative files; assistant outputs use the final reply):\n'
      + JSON.stringify(request.outputs)
    record.result.native.promptDigest = hash(text); this.save(record)
    const prompt = await acp.promptAcpSession(record.root, record.result.native.sessionId, text,
      { expectedConnectionGeneration: record.result.native.connectionGeneration ?? undefined }, () => !record.stopRequested, 0,
      { materials: { text: '', files: [], sources: [], changed: [] }, executionContext: prepared,
        assertActive: () => { this.assertOwned(record); plan.assertCurrent() },
        onAdmitted: identity => { record.result.native.turnId = identity.turnId; record.result.state = 'running'; this.save(record) },
        onPromptWritten: identity => { if (identity.turnId !== record.result.native.turnId || identity.connectionGeneration !== record.result.native.connectionGeneration) throw new Error('Original prompt write identity changed'); record.result.native.promptWritten = true; this.save(record) } })
    if (!prompt.ok) throw this.promptFailure(record, prompt)
    if (!record.result.native.promptWritten) throw new DaemonError('E_UNKNOWN', 'Original product prompt write was not confirmed; it will not be replayed', 'unknown')
  }
  private lease(record: Record): WorkcopyLease { if (!record.lease) throw new DaemonError('E_DENIED', 'Original native writer lease is unavailable'); return record.lease }
  private event(record: Record, event: TimelineEvent, live: Live): void {
    if (event.turnId !== record.result.native.turnId || event.connectionGeneration !== record.result.native.connectionGeneration || event.kind !== 'turn-done') return
    const result = z.object({ status: z.enum(['completed', 'failed', 'cancelled']), stopReason: z.string().optional() }).passthrough().safeParse(event.payload?.result)
    if (!result.success) { record.result.state = 'unknown'; this.save(record); return }
    record.result.native.outcome = result.data.status
    this.save(record)
    if (record.stopRequested || !record.result.native.promptWritten || result.data.status !== 'completed' || result.data.stopReason !== 'end_turn' || event.payload?.hostPolicyOutcome) {
      if (!record.stopRequested) record.result.state = 'failed'
      this.save(record); return
    }
    live.capture = this.capture(record).catch(() => { if (!record.stopRequested) record.result.state = 'failed'; this.save(record) })
  }
  private async capture(record: Record): Promise<void> {
    await this.assertUse(record)
    await acp.flushAcpHistory()
    const page = await acp.getAcpHistoryEvents(record.root, record.result.native.sessionId, { limit: 500 })
    if (!page.ok || page.startsMidTurn || page.historyPersistence.state !== 'saved') throw new DaemonError('E_UNKNOWN', 'Original native turn history was not completely saved', 'unknown')
    const events = replayConversationTextEvents(page.events).filter(event => event.turnId === record.result.native.turnId
      && event.connectionGeneration === record.result.native.connectionGeneration && event.kind === 'message' && event.payload?.role !== 'user' && ['acp', 'pi'].includes(event.source))
    const final = events.filter(event => event.payload?.meta && typeof event.payload.meta === 'object' && 'phase' in event.payload.meta && event.payload.meta.phase === 'final_answer')
    const assistant = (final.length ? final : events).map(event => event.text).join('')
    const binding = this.binding(record)
    const candidates: Candidate[] = []
    for (const selected of record.request.outputs) {
      this.assertOwned(record)
      const captured = selected.source.kind === 'file'
        ? await captureSelectedFile({ root: record.root, relativePath: selected.source.relativePath, assertOwned: () => this.assertOwned(record) })
        : { text: assistant, bodyDigest: hash(assistant), byteLength: Buffer.byteLength(assistant, 'utf8') }
      if (!captured.text.trim() || captured.byteLength > 1024 * 1024 || selected.source.kind === 'file' && captured.bodyDigest === record.baselines.find(item => item.outputId === selected.outputId)?.digest) throw new DaemonError('E_CONFLICT', 'Selected output has no fresh successful native-turn bytes')
      const declared = binding.outputs.find(item => item.nodeId === binding.execution.nodeId && item.output.id === selected.outputId)
      const artifactKind = executionArtifactKindSchema.parse(declared?.output.kind)
      writeExclusiveAtomic(this.outputPath(record, selected.outputId, true), captured.text)
      candidates.push({ outputId: selected.outputId, bodyDigest: captured.bodyDigest, byteLength: captured.byteLength, artifactKind, capturedAt: Date.now() })
    }
    await this.assertUse(record)
    const facts = acp.listOwnedAcpSessionFacts().find(item => item.sessionId === record.result.native.sessionId)
    if (!facts || facts.backgroundWork || facts.unfinishedTools || facts.cleanupRequired || facts.turnActive || facts.settling) throw new DaemonError('E_UNKNOWN', 'Original native tools or turn settlement remain unfinished', 'unknown')
    record.candidates = candidates; record.result.state = 'idle'; this.save(record)
  }
  private async stop(record: Record): Promise<void> {
    if (!record.stopCommandId) {
      const stopCommandId = randomUUID()
      this.save({ ...record, stopCommandId }); record.stopCommandId = stopCommandId
    }
    if (record.result.cleanupConfirmed) return
    record.stopRequested = true; record.result.state = 'stop-requested'; this.save(record)
    const live = this.live.get(record.request.dispatchId)
    if (live?.stop) return live.stop
    const cleanup = (async () => {
      // Creation can return after Stop; join its exact alias, then canonical End.
      await live?.start?.catch(() => {})
      await live?.capture?.catch(() => {})
      if (record.result.cleanupConfirmed) return
      const native = acp.platformAcpSession(record.root, record.result.native.sessionId, record.request.dispatchId)
      const intent = readTaskSessionIntent(this.ports.directory, record.root, record.result.native.sessionId)
      if (native || record.nativeEntered || intent) {
        await acp.stopPlatformAcpSession(record.root, record.result.native.sessionId, record.request.dispatchId, record.request.engine.agentId === 'pi' ? 'pi' : 'acp')
      }
      if (acp.listOwnedAcpSessionFacts().some(item => item.sessionId === record.result.native.sessionId)) throw new DaemonError('E_UNKNOWN', 'Original native owner still retains work', 'unknown')
      if (record.lease) {
        const released = this.ports.workcopies.release({ token: record.lease.token, owner: record.lease.owner, outcome: 'cleanup-confirmed' })
        if (!released.released) throw new DaemonError('E_UNKNOWN', 'Original native lease cleanup was not confirmed', 'unknown')
      }
      record.result.cleanupConfirmed = true; record.result.state = 'stopped'; record.result.permissions = []
      this.save(record); live?.admission?.release(); live?.unobserve?.()
    })()
    if (live) live.stop = cleanup
    try { await cleanup }
    catch (error) { if (live) live.stop = undefined; record.result.state = 'unknown'; this.save(record); throw error }
  }
  private async reconcile(record: Record): Promise<void> {
    const live = this.live.get(record.request.dispatchId)
    if (!live && !record.result.cleanupConfirmed) {
      // Read original intent only. No load/create, POST or guessed process exit.
      const intent = readTaskSessionIntent(this.ports.directory, record.root, record.result.native.sessionId)
      if (!record.admitted && !record.nativeEntered && (!intent || intent.nativeBoundary === 'not-entered')) {
        record.result.state = 'unknown'
      }
    }
    if (record.mutations.some(item => !item.receipt)) await this.ports.preparation.withReceipts(this.binding(record), async transport => {
      for (const mutation of record.mutations) {
        if (!mutation.receipt) { mutation.receipt = await transport.reconcile(mutation.command); this.save(record) }
      }
    })
    this.save(record)
  }
  private async mutate(record: Record, key: string, transport: TaskExecutionTransport, create: () => TeamExecutionCommand): Promise<z.infer<typeof teamExecutionReceiptSchema>> {
    let mutation = record.mutations.find(item => item.key === key)
    if (mutation) {
      if (mutation.receipt) return mutation.receipt
      throw new DaemonError('E_UNKNOWN', 'Original shared mutation must be reconciled; it will not be resent automatically', 'unknown')
    }
    mutation = { key, command: teamExecutionCommandSchema.parse(create()), receipt: null }
    this.save({ ...record, mutations: [...record.mutations, mutation] })
    record.mutations.push(mutation)
    const result = await transport.command(mutation.command)
    mutation.receipt = result.result; this.save(record)
    return result.result
  }
  private async report(record: Record, request: Report): Promise<void> {
    const live = this.live.get(record.request.dispatchId)
    await live?.capture
    if (record.result.native.outcome !== 'completed' || !record.result.native.promptWritten || !record.candidates.length) throw new DaemonError('E_CONFLICT', 'Only retained fresh outputs of the original completed native turn may be selected')
    if (new Set(request.outputIds).size !== request.outputIds.length || request.outputIds.some(id => !record.candidates.some(item => item.outputId === id))) throw new DaemonError('E_INVALID_ARG', 'Selected output does not belong to the original native turn')
    if (record.report && taskInputCanonical(record.report) !== taskInputCanonical(request)) throw new DaemonError('E_CONFLICT', 'Original delivery intent cannot change')
    const binding = this.binding(record), expected = binding.request.expected, pin = binding.request.pin
    if (request.finalize && (binding.input.definition.nodes.length !== 1 || binding.input.definition.nodes[0].kind !== 'agent')) throw new DaemonError('E_UNAVAILABLE', 'Current-node dispatch cannot finalize unexecuted workflow nodes or gates')
    if (!record.report) {
      const report = structuredClone(request)
      this.save({ ...record, report }); record.report = report
    }
    const commandEnvelope = () => ({ contractVersion: 2 as const, commandId: randomUUID(), task: binding.request.task, expectedEpoch: pin.epoch,
      expectedActorId: pin.actorId, expectedDeviceId: pin.deviceId, expectedGeneration: expected.generation,
      expectedExecutionId: expected.executionId })
    const envelope = () => ({ ...commandEnvelope(), expectedNodeId: expected.nodeId, expectedAttempt: expected.attempt })
    // Report starts under current writer admission. Explicit finalization may later
    // close that native owner, but still rechecks the original server write fence.
    await this.assertUse(record)
    await this.ports.preparation.withExecution(binding, () => this.assertOwned(record), async (transport, _source, resource) => {
      if ((request.code.kind === 'git-commit' || request.code.kind === 'git-patch') && request.code.repositoryId !== resource.resource?.source.repositoryId) throw new DaemonError('E_CONFLICT', 'Selected code does not belong to the currently authorized repository resource')
      const entries: ExecutionDeliveryManifest['entries'] = []
      for (const id of request.outputIds) {
        const candidate = record.candidates.find(item => item.outputId === id)
        if (!candidate) throw new DaemonError('E_CONFLICT', 'Selected native output is unavailable')
        const text = readBounded(this.outputPath(record, id), 1024 * 1024)
        if (hash(text) !== candidate.bodyDigest || Buffer.byteLength(text, 'utf8') !== candidate.byteLength) throw new DaemonError('E_CONFLICT', 'Retained native output bytes changed')
        const receipt = await this.mutate(record, `artifact:${id}`, transport, () => ({ ...envelope(), kind: 'save-artifact', artifactId: randomUUID(), previousVersionId: null,
          artifactKind: candidate.artifactKind, title: id, text, expectedDigest: candidate.bodyDigest, disposition: 'confirmed' }))
        const mutation = record.mutations.find(item => item.key === `artifact:${id}`)?.command
        if (!receipt.version || receipt.disposition !== 'confirmed' || mutation?.kind !== 'save-artifact') throw new DaemonError('E_CONFLICT', 'Native output was not confirmed by the service')
        entries.push({ outputId: id, ref: { kind: 'confirmed-artifact', executionId: expected.executionId, artifactId: mutation.artifactId, versionId: receipt.version.versionId, bodyDigest: candidate.bodyDigest } })
      }
      const ref = (id: string): ExecutionArtifactRef => { const entry = entries.find(item => item.outputId === id); if (!entry || entry.ref.kind !== 'confirmed-artifact') throw new DaemonError('E_INVALID_ARG', 'Code selection must use a selected confirmed artifact'); return entry.ref }
      const code = request.code
      const source: ExecutionCodeSource = code.kind === 'selected-files' ? { kind: 'selected-files', files: code.outputIds.map(ref) }
        : code.kind === 'git-patch' ? { kind: 'git-patch', repositoryId: code.repositoryId, base: code.base, patch: ref(code.outputId) } : executionCodeSourceSchema.parse(code)
      const database = record.request.databaseDelivery
      if (database) {
        if (source.kind !== 'selected-files' && source.kind !== 'none') throw new DaemonError('E_UNAVAILABLE', 'Database delivery v1 requires selected SQL artifacts')
        const files = source.kind === 'none' ? [] : source.files.map(selected => {
          const entry = entries.find(item => item.ref.kind === 'confirmed-artifact' && item.ref.versionId === selected.versionId)
          const output = record.request.outputs.find(item => item.outputId === entry?.outputId)
          if (output?.source.kind !== 'file') throw new DaemonError('E_CONFLICT', 'Database SQL needs its original engineering-relative selection')
          return { path: output.source.relativePath, ref: selected }
        })
        const material = binding.resources.find(item => item.resource.selection.id === database.implementationSelectionId)
        if (!material || material.resource.selection.source.kind !== 'confirmed-document') throw new DaemonError('E_CONFLICT', 'Original implementation document selection is unavailable')
        const capture = await confirmDatabaseDelivery({ directory: join(realpathSync.native(this.ports.directory), 'native-task-preparations'),
          binding, transport, request: { operation: 'database-delivery', preparationId: binding.preparationId, commandId: database.commandId,
            artifactId: database.artifactId, rule: database.rule, implementationSelectionId: database.implementationSelectionId, ticket: database.ticket, files },
          assertPrepared: () => this.assertOwned(record) })
        entries.push({ outputId: database.implementationOutputId, ref: { kind: 'confirmed-document', documentId: material.resource.selection.source.documentId,
          versionId: material.resource.selection.source.versionId, bodyDigest: material.resource.bodyDigest } }, { outputId: database.reportOutputId, ref: capture.ref })
      }
      const sealed = await this.mutate(record, 'delivery', transport, () => ({ ...envelope(), kind: 'seal-delivery', previous: binding.execution.deliveries?.at(-1) ? this.version(binding.execution.deliveries.at(-1)) : null, entries }))
      if (!sealed.version) throw new DaemonError('E_UNKNOWN', 'Original delivery receipt has no fixed version', 'unknown')
      record.result.manifest = sealed.version; this.save(record)
      const requiredCode = Boolean(binding.resourceRevision) || binding.outputs.some(item => item.nodeId === expected.nodeId && item.output.required && ['source-patch', 'selected-file'].includes(item.output.kind))
      const targets: { [versionId: string]: string } = Object.create(null)
      for (const entry of entries) { const selected = record.request.outputs.find(item => item.outputId === entry.outputId); if (entry.ref.kind === 'confirmed-artifact' && selected?.source.kind === 'file') targets[entry.ref.versionId] = selected.source.relativePath }
      const observed = await verifyHandoffSource({ root: record.root, source, role: 'source', requiredCode, expectedWorkcopy: { id: binding.workcopy.id, revision: binding.workcopy.revision }, targetPaths: targets,
        assertOwned: () => this.assertOwned(record), readArtifact: async ref => { const value = await transport.artifact(ref); return { text: value.text, bodyDigest: value.artifact.bodyDigest } } })
      if (!observed.ready) throw new DaemonError('E_CONFLICT', 'Selected actual code is not ready for handoff')
      const checkpoint = await this.mutate(record, 'checkpoint', transport, () => ({ ...envelope(), kind: 'checkpoint', previous: binding.execution.checkpoints?.at(-1) ? this.version(binding.execution.checkpoints.at(-1)) : null,
        manifest: sealed.version ?? { versionId: '', digest: '' }, remainingWork: request.remainingWork, source,
        observation: source.kind === 'none' ? null : { verification: 'device-reported', observedAt: observed.observedAt, availability: 'available', sourceDigest: observed.sourceDigest } }))
      if (!checkpoint.version) throw new DaemonError('E_UNKNOWN', 'Original checkpoint receipt has no fixed version', 'unknown')
      record.result.checkpoint = checkpoint.version; this.save(record)
    })
    if (request.finalize) {
      await this.stop(record)
      await this.ports.preparation.withReceipts(binding, async transport => {
        const current = await transport.read(), active = current.active
        if (!active || active.executionId !== expected.executionId || active.generation !== expected.generation || active.nodeId !== expected.nodeId || active.attempt !== expected.attempt
          || active.authority !== 'active' || active.actorId !== pin.actorId || active.deviceId !== pin.deviceId || current.epoch !== pin.epoch) throw new DaemonError('E_CONFLICT', 'Original finalization writer changed after native cleanup')
        const delivery = record.mutations.find(item => item.key === 'delivery')?.command
        if (delivery?.kind !== 'seal-delivery' || !record.result.manifest || !record.result.checkpoint) throw new DaemonError('E_CONFLICT', 'Fixed delivery is unavailable')
        await this.mutate(record, 'finalize', transport, () => ({ ...commandEnvelope(), kind: 'finalize', finalization: { outcome: 'completed', evidenceRef: record.request.dispatchId,
          outputs: delivery.entries.map(item => item.ref), manifest: record.result.manifest ?? undefined, checkpoint: record.result.checkpoint ?? undefined } }))
      })
    }
  }
  private version(value: { versionId: string; digest: string } | undefined): { versionId: string; digest: string } | null { return value ? { versionId: value.versionId, digest: value.digest } : null }
  busy(): boolean { return [...this.records.values()].some(record => !record.result.cleanupConfirmed) }
  ownsWorkspace(root: string): boolean {
    let identity: ReturnType<typeof resolveWorkcopy> | undefined
    try { identity = resolveWorkcopy(root) } catch { /* Keep original lexical ownership if the directory is gone. */ }
    return [...this.records.values()].some(record => !record.result.cleanupConfirmed && (record.root === root || identity && record.lease?.identity.id === identity.id))
  }
  async shutdown(): Promise<void> { for (const record of this.records.values()) if (!record.result.cleanupConfirmed) await this.stop(record) }
}
