import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canReadCruxSpace } from '../../../src/shared/crux-domain/commands'
import { cruxSnapshotSchema } from '../../../src/shared/crux-schema'
import type { CruxTask } from '../../../src/shared/crux'
import { teamDigestSchema, teamIdSchema } from '../../../src/shared/team-platform'
import { teamTaskIdentity, teamTaskRefSchema, type TeamTaskRef, type TeamExecutionCommand } from '../../../src/shared/team-task-execution'
import type { TaskInputRead } from '../../../src/shared/team-task-inputs'
import { assertImportShareableText, importCandidateSchema, importManifestSchema, importNamespaceSchema, importReceiptSchema, importTaskMappingSchema, type ImportNamespace, type ImportManifest } from '../../../src/shared/team-import'
import { canonicalCutoverJson as canonical, cutoverCommandSchema, cutoverRecordSchema, cutoverReceiptSchema, cutoverReadQuerySchema, cutoverTaskQuerySchema, type CutoverCommand, type CutoverManifest, type CutoverRecord, type CutoverReceipt, type CutoverScope } from '../../../src/shared/team-cutover'
import type { CruxWorkspaceHost } from './crux-workspace'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError } from './errors'
import { taskProgressFence } from './task-progress'

type Host = Pick<CruxWorkspaceHost, 'identity' | 'get' | 'all' | 'run' | 'authenticate' | 'project' | 'mutation'> & {
  inputs(principal: StorePrincipal, task: TeamTaskRef): TaskInputRead
  body(digest: string): Buffer
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
function fail(code: string, message: string, status = 409): never { throw new TeamServiceError(code, message, status) }
function unavailable(): never { return fail('CUTOVER_UNAVAILABLE', 'Cutover is unavailable in the current scope', 404) }
function stored<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw) }
  catch { return fail('CORRUPT_STORE', 'Stored cutover evidence is invalid', 503) }
}
const pathKey = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
const behavior = new Set(['hook', 'script', 'root-instruction', 'agent', 'skill', 'command', 'workflow', 'configuration'])
const implementationKinds: Record<string, readonly string[]> = {
  'platform-root-v1': ['root-instruction'], 'platform-skill-v1': ['agent', 'skill', 'command'],
  'platform-hook-v1': ['hook'], 'platform-python-v1': ['script'],
  'platform-configuration-v1': ['configuration'], 'platform-workflow-v1': ['workflow']
}

/** Proves retained manifest coverage, not physical source enumeration or native process state. */
export class TeamCutovers {
  constructor(private readonly host: Host) {}

  private namespace(p: StorePrincipal, scope: CutoverScope, writing = false): ImportNamespace {
    this.host.project(p, scope.projectId)
    if (scope.instanceId !== this.host.identity().instanceId) fail('WORKSPACE_IDENTITY_CHANGED', 'Original service instance changed')
    const row = this.host.get('SELECT recordJson FROM import_namespaces WHERE namespaceId=? AND projectId=?', scope.namespaceId, scope.projectId)
    if (!row) unavailable()
    const source = stored(importNamespaceSchema, row.recordJson)
    const spaceRow = this.host.get("SELECT s.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.spaces') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=?", scope.projectId, source.spaceId)
    if (!spaceRow) unavailable()
    const space = stored(cruxSnapshotSchema.shape.spaces.element, spaceRow.body)
    if (space.createdAt !== source.spaceCreatedAt || !canReadCruxSpace(space, p.person.userId)) unavailable()
    if (writing && (space.archived || !space.memberIds.includes(p.person.userId))) fail('CUTOVER_FORBIDDEN', 'Cutover requires current active space membership', 403)
    return source
  }
  private task(p: StorePrincipal, scope: CutoverScope, source: ImportNamespace, ref: TeamTaskRef): CruxTask {
    if (ref.instanceId !== scope.instanceId || ref.projectId !== scope.projectId || ref.spaceId !== source.spaceId) unavailable()
    const row = this.host.get("SELECT t.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.id')=?", scope.projectId, ref.taskId)
    if (!row) unavailable()
    const task = stored(cruxSnapshotSchema.shape.tasks.element, row.body)
    if (task.createdAt !== ref.taskCreatedAt || task.spaceId !== source.spaceId) unavailable()
    return task
  }
  private operation(id: string): CutoverRecord | null {
    const row = this.host.get('SELECT recordJson FROM team_cutover_operations WHERE operationId=?', id)
    return row ? stored(cutoverRecordSchema, row.recordJson) : null
  }
  private head(scope: CutoverScope): CutoverRecord | null {
    const row = this.host.get('SELECT operationId,revision FROM team_cutover_heads WHERE namespaceId=? AND workcopyDigest=?', scope.namespaceId, scope.workcopyDigest)
    if (!row) return null
    const record = this.operation(String(row.operationId))
    if (!record || record.revision !== row.revision || !equal(record.scope, scope)) fail('CORRUPT_STORE', 'Cutover head differs from its operation', 503)
    return record
  }
  private principal(p: StorePrincipal, command: CutoverCommand): void {
    if (command.expectedEpoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Original service epoch changed')
    if (p.actor.kind !== 'device' || p.deviceId !== command.expectedDeviceId || p.person.userId !== command.expectedActorId) fail('CUTOVER_OWNER_CONFLICT', 'Original cutover actor and device are required', 403)
    this.namespace(p, command)
  }
  private authorizeRecord(p: StorePrincipal, record: CutoverRecord, original = false): ImportNamespace {
    const source = this.namespace(p, record.scope)
    if (record.epoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Original service epoch changed')
    if (original && (record.actorId !== p.person.userId || record.deviceId !== p.deviceId || p.actor.kind !== 'device')) fail('CUTOVER_OWNER_CONFLICT', 'Original cutover actor and device are required', 403)
    for (const item of record.manifest.tasks) this.task(p, record.scope, source, item.task)
    return source
  }
  private inputs(p: StorePrincipal, item: CutoverManifest['tasks'][number]): void {
    const input = this.host.inputs(p, item.task), current = input.current
    if (input.admission.status !== 'ready' || !current || !equal(item.inputBundle, { bundleId: current.bundleId, revision: current.revision, digest: current.digest })) fail('CUTOVER_INPUT_CONFLICT', 'Current adopted task inputs differ from the fixed cutover manifest')
  }
  private noWriter(task: CruxTask, ref: TeamTaskRef): void {
    if (this.host.get("SELECT executionId FROM team_task_executions WHERE projectId=? AND taskId=? AND authority='active'", ref.projectId, ref.taskId)) fail('CUTOVER_WRITER_CONFLICT', 'An existing v2 writer must settle before cutover')
    const progress = this.host.get('SELECT epoch,fence,bindingJson FROM crux_task_progress WHERE projectId=? AND taskId=?', ref.projectId, ref.taskId)
    if (progress?.bindingJson && progress.epoch === this.host.identity().epoch && progress.fence === taskProgressFence(this.host, ref.projectId, task).fence) fail('CUTOVER_WRITER_CONFLICT', 'An existing v1 reporting binding must settle before cutover')
  }
  private importReceipt(importId: string, key: string, namespaceId: string) {
    const row = this.host.get('SELECT recordJson FROM import_item_receipts WHERE importId=? AND itemKey=?', importId, key)
    if (!row) fail('CUTOVER_IMPORT_INCOMPLETE', 'Every manifested import item requires its original committed receipt')
    const receipt = stored(importReceiptSchema, row.recordJson)
    const original = this.host.get('SELECT kind,resultJson FROM commands WHERE userId=? AND commandId=?', receipt.actorId, receipt.commandId)
    if (receipt.importId !== importId || receipt.namespaceId !== namespaceId || receipt.itemKey !== key || !original || original.kind !== 'importCommand' || !equal(stored(importReceiptSchema, original.resultJson), receipt) || receipt.conflicts.length) fail('CUTOVER_IMPORT_CONFLICT', 'Original import item receipt is missing, conflicting or unresolved')
    return receipt
  }
  private source(p: StorePrincipal, scope: CutoverScope, manifest: CutoverManifest): void {
    const namespace = this.namespace(p, scope, true)
    const row = this.host.get('SELECT manifestDigest,manifestJson FROM import_batches WHERE importId=? AND namespaceId=?', manifest.importId, scope.namespaceId)
    if (!row) fail('CUTOVER_IMPORT_INCOMPLETE', 'The original T02 import batch is required')
    const source = stored(importManifestSchema, row.manifestJson)
    if (row.manifestDigest !== manifest.importManifestDigest || hash(canonical(source)) !== manifest.importManifestDigest) fail('CUTOVER_MANIFEST_CONFLICT', 'Original import manifest digest differs')
    if (source.truncated) fail('CUTOVER_IMPORT_INCOMPLETE', 'Truncated import inventory cannot activate writers')
    if (source.tasks.length !== manifest.tasks.length) fail('CUTOVER_MAPPING_CONFLICT', 'Cutover must cover every task in the original import manifest')
    for (const local of source.tasks) {
      const item = manifest.tasks.find(t => t.sourceTaskKey === local.sourceTaskKey)
      const mappingRow = this.host.get('SELECT recordJson FROM import_task_mappings WHERE namespaceId=? AND sourceTaskKey=?', scope.namespaceId, local.sourceTaskKey)
      if (!item || !mappingRow) fail('CUTOVER_MAPPING_CONFLICT', 'Original source task mapping is incomplete')
      const mapping = stored(importTaskMappingSchema, mappingRow.recordJson)
      const receipt = this.importReceipt(manifest.importId, 'task:' + hash(local.sourceTaskKey), scope.namespaceId)
      if (mapping.namespaceId !== scope.namespaceId || mapping.sourceTaskKey !== local.sourceTaskKey || mapping.originalId !== local.originalId || !mapping.locations.includes(local.location) || !equal(mapping.task, item.task)
        || !receipt.mapping || receipt.mapping.sourceTaskKey !== local.sourceTaskKey || receipt.mapping.originalId !== local.originalId || !receipt.mapping.locations.includes(local.location) || !equal(receipt.mapping.task, item.task)) fail('CUTOVER_MAPPING_CONFLICT', 'Cutover task differs from its original source mapping and receipt')
      this.task(p, scope, namespace, item.task)
      this.inputs(p, item)
    }
    const conversions = new Map(manifest.conversions.map(c => [c.itemKey, c]))
    const files = new Map(manifest.files.map(f => [pathKey(f.targetPath), f]))
    for (const file of manifest.files) {
      // Source aliases compare with Windows semantics; installation paths use forward slashes.
      if (file.targetPath.includes('\\')) fail('CUTOVER_CONVERSION_CONFLICT', 'Cutover paths must use portable forward slashes')
    }
    for (const asset of source.assets) {
      const receipt = this.importReceipt(manifest.importId, asset.itemKey, scope.namespaceId)
      const candidate = receipt.candidate
      if (!candidate) fail('CUTOVER_IMPORT_INCOMPLETE', 'Selected source asset has no retained candidate receipt')
      const candidateRow = this.host.get('SELECT bodyDigest,recordJson FROM import_candidates WHERE candidateId=?', candidate.candidateId)
      const expectedTask = asset.sourceTaskKey ? manifest.tasks.find(t => t.sourceTaskKey === asset.sourceTaskKey)?.task : null
      if (!candidateRow || !equal(stored(importCandidateSchema, candidateRow.recordJson), candidate) || candidate.namespaceId !== scope.namespaceId || candidate.itemKey !== asset.itemKey || !equal(candidate.asset, asset) || !equal(candidate.task, expectedTask) || candidate.conflicts.length || candidateRow.bodyDigest !== asset.bodyDigest) fail('CUTOVER_IMPORT_CONFLICT', 'Selected source candidate differs from the original manifest or mapping')
      const bytes = this.host.body(asset.bodyDigest)
      if (hash(bytes) !== asset.bodyDigest || bytes.length !== asset.bodyByteLength) fail('CORRUPT_STORE', 'Retained import candidate bytes differ', 503)
      const conversion = conversions.get(asset.itemKey)
      if (behavior.has(asset.kind) && !conversion) fail('CUTOVER_CONVERSION_REQUIRED', 'Every selected behavior asset needs explicit supported conversion coverage')
      if (!conversion) continue
      const target = files.get(pathKey(conversion.targetPath))
      if (conversion.sourceDigest !== asset.sourceDigest || !target || !behavior.has(asset.kind)) fail('CUTOVER_CONVERSION_CONFLICT', 'Conversion does not bind the original selected behavior asset')
      const samePath = pathKey(asset.relativePath) === pathKey(target.targetPath)
      const original = files.get(pathKey(asset.relativePath))
      if (!original || original.beforeDigest !== asset.sourceDigest) fail('CUTOVER_CONVERSION_CONFLICT', 'Original dispatch path requires its exact source before digest')
      if (conversion.implementation === 'removed-dispatch-v1') {
        if (!samePath || target.afterDigest !== null) fail('CUTOVER_CONVERSION_CONFLICT', 'Removal conversion requires explicit absence at its original dispatch path')
      } else if (conversion.implementation === 'retained-nondispatch-v1') {
        // A retained document is inert only inside the native imported-source quarantine.
        if (samePath || !/^\.trellis\/imported-source\/[^\s]+\.(?:md|txt|json)$/i.test(target.targetPath) || target.afterDigest !== asset.sourceDigest || original.afterDigest !== null) fail('CUTOVER_CONVERSION_CONFLICT', 'Retained behavior requires an inert source copy and explicit removal of the old dispatch path')
      } else {
        if (!implementationKinds[conversion.implementation]?.includes(asset.kind) || target.afterDigest === null || (samePath ? target.afterDigest === asset.sourceDigest : original.afterDigest !== null)) fail('CUTOVER_CONVERSION_CONFLICT', 'Behavior requires the recognized native replacement and removal of obsolete dispatch')
      }
    }
    if (manifest.conversions.some(c => !source.assets.some(a => a.itemKey === c.itemKey))) fail('CUTOVER_CONVERSION_CONFLICT', 'Conversion references an unselected source asset')
    this.blockers(source, manifest)
  }
  private blockers(source: ImportManifest, manifest: CutoverManifest): void {
    for (const blocker of source.blockers) {
      // This old T02 limitation is superseded by this protocol's fixed native install receipt.
      if (blocker.code === 'ACTIVATION_NOT_IMPLEMENTED') continue
      const relativePath = blocker.relativePath
      const assets = relativePath === null ? [] : source.assets.filter(a => pathKey(a.relativePath) === pathKey(relativePath))
      if (blocker.code === 'BEHAVIOR_CONVERSION_REQUIRED' && assets.length === 1 && manifest.conversions.some(c => c.itemKey === assets[0].itemKey && c.sourceDigest === assets[0].sourceDigest)) continue
      if (blocker.code === 'DOCUMENT_PURPOSE_REQUIRED' && assets.length === 1 && assets[0].purpose !== 'unresolved') continue
      fail('CUTOVER_IMPORT_BLOCKED', 'Original import contains an unresolved source blocker: ' + blocker.code)
    }
  }

  private scope(command: CutoverCommand): CutoverScope {
    return { instanceId: command.instanceId, projectId: command.projectId, namespaceId: command.namespaceId, workcopyDigest: command.workcopyDigest }
  }
  private retained(commandId: string): { command: CutoverCommand; receipt: CutoverReceipt } | null {
    const row = this.host.get('SELECT bodyJson,receiptJson FROM team_cutover_commands WHERE commandId=?', commandId)
    if (!row) return null
    const command = stored(cutoverCommandSchema, row.bodyJson), receipt = stored(cutoverReceiptSchema, row.receiptJson)
    if (command.commandId !== commandId || receipt.commandId !== commandId || receipt.operationId !== command.operationId || !equal(receipt.scope, this.scope(command)) || receipt.requestDigest !== hash(canonical(command)) || receipt.actorId !== command.expectedActorId || receipt.deviceId !== command.expectedDeviceId || receipt.epoch !== command.expectedEpoch || receipt.action !== command.action) fail('CORRUPT_STORE', 'Cutover command and retained receipt differ', 503)
    const original = this.host.get('SELECT kind,requestHash,resultJson FROM commands WHERE userId=? AND commandId=?', receipt.actorId, commandId)
    if (!original || original.kind !== 'cutoverCommand' || original.requestHash !== hash(canonical({ kind: 'cutoverCommand', input: command })) || !equal(stored(cutoverReceiptSchema, original.resultJson), receipt)) fail('CORRUPT_STORE', 'Original cutover mutation receipt is missing or changed', 503)
    return { command, receipt }
  }
  authorizeReceipt(p: StorePrincipal, raw: unknown): CutoverReceipt {
    const receipt = stored(cutoverReceiptSchema, raw), fixed = this.retained(receipt.commandId)
    if (!fixed || !equal(fixed.receipt, receipt)) fail('CORRUPT_STORE', 'Original cutover receipt differs', 503)
    this.principal(p, fixed.command)
    const record = this.operation(receipt.operationId)
    if (!record || !equal(record.scope, receipt.scope) || record.manifestDigest !== receipt.manifestDigest || record.actorId !== receipt.actorId || record.deviceId !== receipt.deviceId || record.epoch !== receipt.epoch) fail('CUTOVER_SCOPE_CONFLICT', 'Receipt does not belong to the original cutover operation')
    this.authorizeRecord(p, record, true)
    return receipt
  }
  private installation(record: CutoverRecord, command: Extract<CutoverCommand, { action: 'installed' }>): void {
    const expected = record.manifest.files.map(f => ({ targetPath: f.targetPath, afterDigest: f.afterDigest })).sort((a, b) => a.targetPath.localeCompare(b.targetPath))
    const actual = [...command.installation.files].sort((a, b) => a.targetPath.localeCompare(b.targetPath))
    if (command.installation.manifestDigest !== record.manifestDigest || command.installation.connectorDigest !== record.manifest.nativeConnector.digest || !equal(actual, expected)) fail('CUTOVER_INSTALLATION_CONFLICT', 'Installation must acknowledge the exact fixed manifest, connector and complete file set')
  }
  command(actor: StoreActor, raw: unknown) {
    const command = cutoverCommandSchema.parse(raw), scope = this.scope(command)
    try { assertImportShareableText(canonical(command)) } catch { fail('CUTOVER_PRIVATE_CONTENT', 'Cutover records require portable reviewed metadata without private paths or credentials', 422) }
    return this.host.mutation(actor, command.commandId, 'cutoverCommand', command, p => this.principal(p, command), p => {
      this.namespace(p, scope, true)
      if (this.host.get('SELECT commandId FROM team_cutover_commands WHERE commandId=?', command.commandId)) fail('COMMAND_CONFLICT', 'Command UUID already belongs to another original cutover request')
      const head = this.head(scope)
      if ((head?.revision ?? 0) !== command.expectedRevision) fail('CUTOVER_REVISION_CONFLICT', 'Original cutover revision changed; reconcile the original command before a later intent')
      if (command.expectedRevision >= Number.MAX_SAFE_INTEGER) fail('CAPACITY_EXCEEDED', 'Cutover revision exhausted', 503)
      const revision = command.expectedRevision + 1, timestamp = Date.now()
      let record: CutoverRecord
      if (command.action === 'stage') {
        if (this.operation(command.operationId)) fail('CUTOVER_OPERATION_CONFLICT', 'Operation UUID already belongs to an immutable cutover intent')
        if (head && !['suspended', 'rolled-back'].includes(head.state)) fail('CUTOVER_STATE_CONFLICT', 'Current workcopy operation must settle before a fresh intent')
        if (hash(canonical(command.manifest)) !== command.manifestDigest) fail('CUTOVER_MANIFEST_CONFLICT', 'Cutover manifest differs from its fixed digest')
        const count = this.host.get('SELECT COUNT(*) AS n FROM team_cutover_operations WHERE namespaceId=?', scope.namespaceId)
        if (typeof count?.n !== 'number' || count.n >= 2000) fail('CAPACITY_EXCEEDED', 'Cutover operation bound reached', 413)
        this.source(p, scope, command.manifest)
        const source = this.namespace(p, scope)
        for (const item of command.manifest.tasks) {
          this.noWriter(this.task(p, scope, source, item.task), item.task)
          const fence = this.fence(item.task)
          if (fence && (fence.scope.namespaceId !== scope.namespaceId || fence.scope.workcopyDigest !== scope.workcopyDigest)) fail('CUTOVER_TASK_CONFLICT', 'Task already belongs to another workcopy cutover fence')
        }
        record = { contractVersion: 1, scope, epoch: command.expectedEpoch, operationId: command.operationId, revision, state: 'staged', manifestDigest: command.manifestDigest, manifest: command.manifest,
          actorId: p.person.userId, deviceId: command.expectedDeviceId, stageCommandId: command.commandId, lastCommandId: command.commandId, installedCommandId: null, createdAt: timestamp, updatedAt: timestamp }
        this.host.run('INSERT INTO team_cutover_operations(operationId,namespaceId,workcopyDigest,recordJson) VALUES(?,?,?,?)', record.operationId, scope.namespaceId, scope.workcopyDigest, JSON.stringify(record))
        for (const item of record.manifest.tasks) this.host.run('INSERT INTO team_cutover_task_fences(projectId,taskId,spaceId,taskCreatedAt,operationId) VALUES(?,?,?,?,?) ON CONFLICT(projectId,taskId,spaceId,taskCreatedAt) DO UPDATE SET operationId=excluded.operationId', item.task.projectId, item.task.taskId, item.task.spaceId, item.task.taskCreatedAt, record.operationId)
      } else {
        if (!head || head.operationId !== command.operationId || !equal(head.scope, scope)) fail('CUTOVER_OPERATION_CONFLICT', 'Command does not address the original current cutover operation')
        this.authorizeRecord(p, head, true)
        record = { ...head, revision, lastCommandId: command.commandId, updatedAt: timestamp }
        if (command.action === 'installed') {
          if (head.state !== 'staged') fail('CUTOVER_STATE_CONFLICT', 'Only a staged operation accepts its fixed installation receipt')
          this.installation(head, command)
          record.state = 'installed'; record.installedCommandId = command.commandId
        } else if (command.action === 'activate') {
          if (head.state !== 'installed' || !head.installedCommandId) fail('CUTOVER_STATE_CONFLICT', 'Activation requires the original committed installed milestone')
          const installed = this.retained(head.installedCommandId)
          if (!installed || installed.command.action !== 'installed' || installed.command.operationId !== head.operationId || installed.receipt.state !== 'installed' || installed.receipt.revision !== head.revision || installed.receipt.manifestDigest !== head.manifestDigest) fail('CUTOVER_INSTALLATION_CONFLICT', 'Original installation command must reconcile before activation')
          this.installation(head, installed.command)
          this.source(p, scope, head.manifest)
          const source = this.namespace(p, scope)
          for (const item of head.manifest.tasks) this.noWriter(this.task(p, scope, source, item.task), item.task)
          record.state = 'active'
        } else if (command.action === 'suspend') {
          if (!['staged', 'installed', 'active'].includes(head.state)) fail('CUTOVER_STATE_CONFLICT', 'Terminal operation requires a new operation UUID')
          record.state = 'suspended'
        } else {
          if (head.state === 'rolled-back') fail('CUTOVER_STATE_CONFLICT', 'Terminal operation requires a new operation UUID')
          record.state = 'rolled-back'
        }
        this.host.run('UPDATE team_cutover_operations SET recordJson=? WHERE operationId=?', JSON.stringify(record), record.operationId)
      }
      this.host.run('INSERT INTO team_cutover_heads(namespaceId,workcopyDigest,operationId,revision) VALUES(?,?,?,?) ON CONFLICT(namespaceId,workcopyDigest) DO UPDATE SET operationId=excluded.operationId,revision=excluded.revision', scope.namespaceId, scope.workcopyDigest, record.operationId, revision)
      const receipt: CutoverReceipt = { contractVersion: 1, commandId: command.commandId, operationId: record.operationId, scope, epoch: record.epoch, actorId: record.actorId, deviceId: record.deviceId, action: command.action, requestDigest: hash(canonical(command)), manifestDigest: record.manifestDigest, revision, state: record.state, committedAt: timestamp }
      this.host.run('INSERT INTO team_cutover_commands(commandId,operationId,bodyJson,receiptJson) VALUES(?,?,?,?)', command.commandId, record.operationId, canonical(command), JSON.stringify(receipt))
      return receipt
    }, (p, receipt) => { this.authorizeReceipt(p, receipt) })
  }
  reconcile(actor: StoreActor, raw: unknown) {
    const command = cutoverCommandSchema.parse(raw), p = this.host.authenticate(actor)
    this.principal(p, command)
    const row = this.host.get('SELECT kind,requestHash,resultJson FROM commands WHERE userId=? AND commandId=?', p.person.userId, command.commandId)
    if (!row) {
      if (this.host.get('SELECT commandId FROM team_cutover_commands WHERE commandId=?', command.commandId)) fail('COMMAND_CONFLICT', 'Command belongs to another original cutover owner')
      return null
    }
    if (row.kind !== 'cutoverCommand' || row.requestHash !== hash(canonical({ kind: 'cutoverCommand', input: command }))) fail('COMMAND_CONFLICT', 'Command UUID already describes another immutable request')
    return { status: 'duplicate' as const, commandId: command.commandId, result: this.authorizeReceipt(p, row.resultJson) }
  }
  read(p: StorePrincipal, raw: Record<string, unknown>): CutoverRecord | null {
    const projectId = teamIdSchema.parse(raw.projectId), workcopyDigest = teamDigestSchema.parse(raw.workcopyDigest), query = cutoverReadQuerySchema.parse(raw.query)
    const scope = { instanceId: query.instanceId, projectId, namespaceId: query.namespaceId, workcopyDigest }
    this.namespace(p, scope)
    const record = query.operationId ? this.operation(query.operationId) : this.head(scope)
    if (record && !equal(record.scope, scope)) unavailable()
    if (record) this.authorizeRecord(p, record)
    return record
  }
  private fence(task: TeamTaskRef): CutoverRecord | null {
    const row = this.host.get('SELECT operationId FROM team_cutover_task_fences WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=?', task.projectId, task.taskId, task.spaceId, task.taskCreatedAt)
    if (!row) return null
    const record = this.operation(String(row.operationId))
    if (!record || !record.manifest.tasks.some(t => teamTaskIdentity(t.task) === teamTaskIdentity(task))) fail('CORRUPT_STORE', 'Cutover task fence has no original manifest mapping', 503)
    return record
  }
  taskRead(p: StorePrincipal, raw: Record<string, unknown>): CutoverRecord | null {
    const query = cutoverTaskQuerySchema.parse(raw.query), task = teamTaskRefSchema.parse({ instanceId: query.instanceId, projectId: raw.projectId, taskId: raw.taskId, spaceId: query.spaceId, taskCreatedAt: query.taskCreatedAt })
    this.host.project(p, task.projectId)
    if (task.instanceId !== this.host.identity().instanceId) fail('WORKSPACE_IDENTITY_CHANGED', 'Original service instance changed')
    const record = this.fence(task)
    if (record) { this.authorizeRecord(p, record); return record }
    // Unfenced tasks still require current space access and exact incarnation.
    const row = this.host.get('SELECT snapshotJson FROM crux_workspaces WHERE projectId=?', task.projectId)
    if (!row) unavailable()
    const snapshot = stored(cruxSnapshotSchema, row.snapshotJson), space = snapshot.spaces.find(s => s.id === task.spaceId)
    if (!space || !canReadCruxSpace(space, p.person.userId) || !snapshot.tasks.some(t => t.id === task.taskId && t.spaceId === task.spaceId && t.createdAt === task.taskCreatedAt)) unavailable()
    return null
  }
  assertClaim(p: StorePrincipal, command: Extract<TeamExecutionCommand, { kind: 'claim' }>): void {
    const record = this.fence(command.task)
    if (!record) {
      if (command.cutoverAdmission) fail('CUTOVER_ADMISSION_CONFLICT', 'Claim proof does not belong to a current task cutover')
      return
    }
    // Execution context has already checked the current handler and claiming device. Migrator ownership applies to milestones only.
    this.authorizeRecord(p, record)
    const head = this.head(record.scope), proof = command.cutoverAdmission
    if (!head || head.operationId !== record.operationId || head.state !== 'active' || p.actor.kind !== 'device' || !p.deviceId || !proof || proof.operationId !== record.operationId || proof.manifestDigest !== record.manifestDigest) fail('CUTOVER_ADMISSION_CONFLICT', 'New claims require the exact current active cutover proof')
    // The manifest pins the initial T03 adoption through activation. Later approved T03 adoption
    // is pinned by this claim's immutable inputBundle and the execution service's checkInputs.
    // Connector proof never grants authority to reuse a stale adopted bundle.
  }
  assertBind(projectId: string, taskId: string): void {
    const row = this.host.get("SELECT t.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.id')=?", projectId, taskId)
    if (!row) return
    const task = stored(cruxSnapshotSchema.shape.tasks.element, row.body)
    if (this.fence({ instanceId: this.host.identity().instanceId, projectId, taskId, spaceId: task.spaceId, taskCreatedAt: task.createdAt })) fail('CUTOVER_ADMISSION_CONFLICT', 'New v1 bindings cannot prove native cutover admission')
  }
}
