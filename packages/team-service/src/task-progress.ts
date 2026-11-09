import { createHash, randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { CruxSnapshot, CruxTask } from '../../../src/shared/crux'
import { cruxSnapshotSchema } from '../../../src/shared/crux-schema'
import { canReadCruxSpace } from '../../../src/shared/crux-domain/commands'
import { teamCommandIdSchema, teamIdSchema } from '../../../src/shared/team-platform'
import { teamCodeResourceSchema, teamTaskResourceSelectionSchema } from '../../../src/shared/team-code-resources'
import {
  teamTaskProgressBindingSchema, teamTaskProgressCommandSchema, teamTaskProgressDtoSchema,
  teamTaskProgressReceiptSchema, teamTaskProgressRecordSchema, teamTaskProgressResourceIdSchema,
  type TeamTaskProgressBinding, type TeamTaskProgressCommandReply, type TeamTaskProgressDto,
  type TeamTaskProgressReceipt, type TeamTaskProgressRecord
} from '../../../src/shared/team-task-progress'
import type { CruxWorkspaceHost } from './crux-workspace'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError } from './errors'

const RECEIPTS_PER_TASK = 32
type Host = Pick<CruxWorkspaceHost, 'identity' | 'transaction' | 'get' | 'all' | 'run' | 'authenticate' | 'project'> & { assertNoExecutionWriter(projectId: string, taskId: string): void; assertCutoverBind(projectId: string, taskId: string): void }
type Current = { generation: number; binding: TeamTaskProgressBinding | null; progress: TeamTaskProgressRecord | null; ownerKey: string | null }
type ResourceFence = { fence: string; resourceAvailable: boolean }
type Authority = ResourceFence & { principal: StorePrincipal; projectId: string; taskId: string; spaceId: string }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
// A one-way actor fence, never a stored bearer token, browser cookie or native path.
const ownerKey = (actor: StoreActor): string => hash(`task-progress:${actor.kind}:${actor.credentialHash}`)
function conflict(code: string, message: string): never { throw new TeamServiceError(code, message, 409) }
function unavailable(): never { throw new TeamServiceError('TASK_PROGRESS_UNAVAILABLE', 'Task progress is unavailable in the current space', 404) }
function stored<T>(schema: z.ZodType<T>, body: string): T {
  try { return schema.parse(JSON.parse(body)) }
  catch { throw new TeamServiceError('CORRUPT_STORE', 'Stored task progress authority or record is invalid', 503) }
}
const handlerOf = (task: CruxTask): string | undefined => task.workflow ? task.workflow.handlerId : task.assigneeIds.length === 1 ? task.assigneeIds[0] : undefined

/** Includes transitions that return to the same stage/handler and executor-only handoffs. */
const taskFence = (task: CruxTask): string => hash(JSON.stringify([
  task.spaceId, handlerOf(task), task.workflow?.stage, task.statusId, task.completedAt,
  task.triagePending, task.executor?.kind, task.executor?.id, task.workflow?.history.length,
  task.workflow?.history.at(-1)?.id, task.assigneeIds
]))
const nextGeneration = (generation: number): number => {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new TeamServiceError('CORRUPT_STORE', 'Task progress generation is invalid', 503)
  if (generation >= Number.MAX_SAFE_INTEGER) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Task progress generation exhausted', 503)
  return generation + 1
}

/** Defaults and resource descriptions are not part of an admitted execution's identity. */
export function taskProgressFence(host: Pick<Host, 'get'>, projectId: string, task: CruxTask): ResourceFence {
  const fence = taskFence(task)
  const row = host.get('SELECT recordJson FROM team_task_code_resources WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=?', projectId, task.id, task.spaceId, task.createdAt)
  const selection = row ? stored(teamTaskResourceSelectionSchema, String(row.recordJson)) : null
  // Preserve the pre-resource fence for existing non-code tasks.
  if (!selection?.resourceId) return { fence, resourceAvailable: true }
  const resourceRow = host.get('SELECT recordJson FROM team_code_resources WHERE projectId=? AND resourceId=?', projectId, selection.resourceId)
  const resource = resourceRow ? stored(teamCodeResourceSchema, String(resourceRow.recordJson)) : null
  const linked = Boolean(host.get('SELECT resourceId FROM team_space_resource_links WHERE projectId=? AND spaceId=? AND resourceId=?', projectId, task.spaceId, selection.resourceId))
  return {
    fence: hash(JSON.stringify([fence, task.createdAt, selection.revision, selection.resourceId, resource?.createdAt, resource?.source, resource?.disabled, linked])),
    resourceAvailable: Boolean(resource && !resource.disabled && linked)
  }
}

/** Call in the resource mutation transaction; retain command identities and historical receipts. */
export function invalidateTaskResourceProgress(host: Pick<Host, 'get' | 'run'>, projectId: string, taskId: string): void {
  const row = host.get('SELECT generation FROM crux_task_progress WHERE projectId=? AND taskId=?', projectId, taskId)
  if (!row) return
  if (typeof row.generation !== 'number') throw new TeamServiceError('CORRUPT_STORE', 'Task progress generation is invalid', 503)
  // This tombstone cannot match any hashed fence after disable/unlink is reversed.
  // Revoking reporting authority does not confirm that a native process stopped.
  host.run("UPDATE crux_task_progress SET generation=?,fence='',bindingJson=NULL,progressJson=NULL,ownerKey=NULL WHERE projectId=? AND taskId=?", nextGeneration(row.generation), projectId, taskId)
}

export class TeamTaskProgress {
  constructor(private readonly host: Host) {}

  private authorize(actor: StoreActor, raw: Record<string, unknown>, writing = false): Authority {
    const principal = this.host.authenticate(actor)
    const projectId = teamIdSchema.parse(raw.projectId), taskId = teamTaskProgressResourceIdSchema.parse(raw.taskId)
    this.host.project(principal, projectId)
    // Read only the selected task and space, without constructing a workspace projection.
    const taskRow = this.host.get("SELECT t.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.id')=?", projectId, taskId)
    if (!taskRow || typeof taskRow.body !== 'string') unavailable()
    const task = stored(cruxSnapshotSchema.shape.tasks.element, taskRow.body)
    const spaceRow = this.host.get("SELECT s.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.spaces') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=?", projectId, task.spaceId)
    if (!spaceRow || typeof spaceRow.body !== 'string') unavailable()
    const space = stored(cruxSnapshotSchema.shape.spaces.element, spaceRow.body)
    if (!canReadCruxSpace(space, principal.person.userId)) unavailable()
    const status = this.host.get("SELECT json_extract(s.value,'$.category') AS category FROM crux_workspaces w,json_each(w.snapshotJson,'$.taskStatuses') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=? AND json_extract(s.value,'$.spaceId')=?", projectId, task.statusId, task.spaceId)
    const handlerId = handlerOf(task)
    if (!status || ['done', 'cancelled'].includes(String(status.category)) || task.workflow?.stage === 'done' || task.completedAt || task.triagePending || !handlerId) {
      conflict('TASK_PROGRESS_INACTIVE', 'Task must be open with a current handler')
    }
    const handler = this.host.get('SELECT p.userId FROM people p JOIN project_members pm ON pm.userId=p.userId JOIN projects pr ON pr.projectId=pm.projectId JOIN team_members tm ON tm.teamId=pr.teamId AND tm.userId=p.userId WHERE p.userId=? AND pm.projectId=? AND p.active=1 AND pm.active=1 AND tm.active=1', handlerId, projectId)
    if (!handler || !space.memberIds.includes(handlerId)) conflict('TASK_PROGRESS_INACTIVE', 'Task handler is no longer an active space member')
    if (writing && (space.archived || handlerId !== principal.person.userId)) throw new TeamServiceError('TASK_PROGRESS_FORBIDDEN', 'Only the current handler can report progress in an active space', 403)
    return { principal, projectId, taskId, spaceId: task.spaceId, ...taskProgressFence(this.host, projectId, task) }
  }

  private current(authority: Authority): Current {
    const row = this.host.get('SELECT * FROM crux_task_progress WHERE projectId=? AND taskId=?', authority.projectId, authority.taskId)
    if (!row) return { generation: 0, binding: null, progress: null, ownerKey: null }
    if (typeof row.generation !== 'number' || !Number.isSafeInteger(row.generation) || row.generation < 0) throw new TeamServiceError('CORRUPT_STORE', 'Task progress generation is invalid', 503)
    if (row.epoch !== this.host.identity().epoch || row.fence !== authority.fence) return { generation: nextGeneration(row.generation), binding: null, progress: null, ownerKey: null }
    if ((row.bindingJson !== null && typeof row.bindingJson !== 'string') || (row.progressJson !== null && typeof row.progressJson !== 'string') || (row.ownerKey !== null && typeof row.ownerKey !== 'string')
      || (row.bindingJson === null) !== (row.progressJson === null) || (row.bindingJson === null) !== (row.ownerKey === null)) throw new TeamServiceError('CORRUPT_STORE', 'Stored task progress binding is invalid', 503)
    const binding = typeof row.bindingJson === 'string' ? stored(teamTaskProgressBindingSchema, row.bindingJson) : null
    if (binding && binding.generation !== row.generation) throw new TeamServiceError('CORRUPT_STORE', 'Stored task progress binding generation is invalid', 503)
    return {
      generation: row.generation,
      binding,
      progress: typeof row.progressJson === 'string' ? stored(teamTaskProgressRecordSchema, row.progressJson) : null,
      ownerKey: typeof row.ownerKey === 'string' ? row.ownerKey : null
    }
  }

  private view(authority: Authority, current: Current): TeamTaskProgressDto {
    return teamTaskProgressDtoSchema.parse({ ...this.host.identity(), projectId: authority.projectId, taskId: authority.taskId, spaceId: authority.spaceId,
      generation: current.generation, binding: current.binding, progress: current.progress, serverTime: Date.now() })
  }

  read(actor: StoreActor, raw: Record<string, unknown>): TeamTaskProgressDto {
    const authority = this.authorize(actor, raw)
    return this.view(authority, this.current(authority))
  }

  receipt(actor: StoreActor, raw: Record<string, unknown>): TeamTaskProgressReceipt | null {
    const authority = this.authorize(actor, raw)
    const commandId = teamCommandIdSchema.parse(raw.commandId)
    const row = this.host.get('SELECT ownerKey,receiptJson FROM crux_task_progress_receipts WHERE projectId=? AND taskId=? AND userId=? AND commandId=?', authority.projectId, authority.taskId, authority.principal.person.userId, commandId)
    if (!row) return null
    if (row.ownerKey !== ownerKey(actor)) throw new TeamServiceError('TASK_PROGRESS_FORBIDDEN', 'Command belongs to a different reporting session', 403)
    if (typeof row.receiptJson !== 'string') throw new TeamServiceError('CORRUPT_STORE', 'Task progress receipt is invalid', 503)
    const receipt = stored(teamTaskProgressReceiptSchema, row.receiptJson)
    if (receipt.epoch !== this.host.identity().epoch) conflict('WORKSPACE_EPOCH_CHANGED', 'Reload task progress after service recovery')
    return receipt
  }

  command(actor: StoreActor, raw: Record<string, unknown>): TeamTaskProgressCommandReply {
    const input = teamTaskProgressCommandSchema.parse(raw.body)
    return this.host.transaction(() => {
      const authority = this.authorize(actor, raw, true)
      const identity = this.host.identity(), actorKey = ownerKey(actor)
      if (this.host.get("SELECT commandId FROM commands WHERE userId=? AND commandId=? AND kind='taskExecutionCommand'", authority.principal.person.userId, input.commandId)) conflict('COMMAND_CONFLICT', 'Command UUID already belongs to a v2 execution operation')
      if (input.expectedEpoch !== identity.epoch) conflict('WORKSPACE_EPOCH_CHANGED', 'Reload task progress and reconcile the original command after service recovery')
      // Parsed objects have a fixed schema order: equivalent JSON key order hashes identically.
      const requestHash = hash(JSON.stringify({ projectId: authority.projectId, taskId: authority.taskId, input }))
      const previous = this.host.get('SELECT requestHash,ownerKey FROM crux_task_progress_commands WHERE userId=? AND commandId=?', authority.principal.person.userId, input.commandId)
      let current = this.current(authority)
      if (previous) {
        if (previous.requestHash !== requestHash) conflict('COMMAND_CONFLICT', 'Command identity already describes a different request')
        if (previous.ownerKey !== actorKey) throw new TeamServiceError('TASK_PROGRESS_FORBIDDEN', 'Command belongs to a different reporting session', 403)
        // Return present state; a replay can never resurrect an old summary or binding.
        return { status: 'duplicate', commandId: input.commandId, result: this.view(authority, current) }
      }
      if (input.kind === 'bind') {
        this.host.assertCutoverBind(authority.projectId, authority.taskId)
        this.host.assertNoExecutionWriter(authority.projectId, authority.taskId)
        if (!authority.resourceAvailable) conflict('TASK_PROGRESS_INACTIVE', 'Selected code resource must be enabled and linked to the current space')
        if (input.expectedGeneration !== current.generation || input.expectedBindingId !== (current.binding?.bindingId ?? null)) conflict('TASK_PROGRESS_BINDING_CONFLICT', 'Reporting binding changed; reload before an explicit takeover')
        if ((input.source.kind === 'desktop') !== (actor.kind === 'device')) throw new TeamServiceError('TASK_PROGRESS_FORBIDDEN', 'Reporting source does not match the authenticated transport', 403)
        const generation = nextGeneration(current.generation)
        current = { generation, binding: { bindingId: randomUUID(), generation, reporterId: authority.principal.person.userId, deviceId: authority.principal.deviceId, source: input.source },
          progress: { seq: 0, state: 'idle', step: null, blockingReason: null, updatedAt: Date.now() }, ownerKey: actorKey }
      } else {
        if (!current.binding || current.binding.bindingId !== input.bindingId || current.ownerKey !== actorKey) conflict('TASK_PROGRESS_BINDING_CONFLICT', 'Original reporting binding is no longer active')
        if (input.seq <= (current.progress?.seq ?? 0)) conflict('TASK_PROGRESS_SEQUENCE_CONFLICT', 'Reporting sequence must strictly increase')
        current = input.kind === 'release'
          ? { generation: nextGeneration(current.generation), binding: null, progress: null, ownerKey: null }
          : { ...current, progress: { seq: input.seq, state: input.state, step: input.step, blockingReason: input.blockingReason, updatedAt: Date.now() } }
      }
      this.host.run('INSERT INTO crux_task_progress(projectId,taskId,spaceId,epoch,generation,fence,bindingJson,progressJson,ownerKey) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(projectId,taskId) DO UPDATE SET spaceId=excluded.spaceId,epoch=excluded.epoch,generation=excluded.generation,fence=excluded.fence,bindingJson=excluded.bindingJson,progressJson=excluded.progressJson,ownerKey=excluded.ownerKey', authority.projectId, authority.taskId, authority.spaceId, identity.epoch, current.generation, authority.fence, current.binding ? JSON.stringify(current.binding) : null, current.progress ? JSON.stringify(current.progress) : null, current.ownerKey)
      const receipt: TeamTaskProgressReceipt = { commandId: input.commandId, kind: input.kind, epoch: identity.epoch, generation: current.generation,
        bindingId: current.binding?.bindingId ?? (input.kind === 'release' ? input.bindingId : null), seq: input.kind === 'bind' ? 0 : input.seq, committedAt: Date.now() }
      this.host.run('INSERT INTO crux_task_progress_commands(projectId,taskId,commandId,userId,ownerKey,requestHash) VALUES(?,?,?,?,?,?)', authority.projectId, authority.taskId, input.commandId, authority.principal.person.userId, actorKey, requestHash)
      this.host.run('INSERT INTO crux_task_progress_receipts(projectId,taskId,commandId,userId,ownerKey,requestHash,receiptJson,createdAt) VALUES(?,?,?,?,?,?,?,?)', authority.projectId, authority.taskId, input.commandId, authority.principal.person.userId, actorKey, requestHash, JSON.stringify(receipt), receipt.committedAt)
      // Evict receipt bodies only; command identities must still reject changed payloads.
      this.host.run('DELETE FROM crux_task_progress_receipts WHERE projectId=? AND taskId=? AND rowid NOT IN (SELECT rowid FROM crux_task_progress_receipts WHERE projectId=? AND taskId=? ORDER BY rowid DESC LIMIT ?)', authority.projectId, authority.taskId, authority.projectId, authority.taskId, RECEIPTS_PER_TASK)
      return { status: 'committed', commandId: input.commandId, result: this.view(authority, current) }
    })
  }

  /** Called inside the business command transaction, even on same-handler reassignments. */
  reconcileWorkspace(projectId: string, before: CruxSnapshot, after: CruxSnapshot): void {
    const rows = this.host.all('SELECT taskId,generation FROM crux_task_progress WHERE projectId=?', projectId)
    if (rows.length === 0) return
    const oldTasks = new Map(before.tasks.map((task) => [task.id, task]))
    const newTasks = new Map(after.tasks.map((task) => [task.id, task]))
    for (const row of rows) {
      if (typeof row.taskId !== 'string' || typeof row.generation !== 'number') throw new TeamServiceError('CORRUPT_STORE', 'Task progress identity is invalid', 503)
      const previous = oldTasks.get(row.taskId), next = newTasks.get(row.taskId)
      if (!next) { this.host.run('DELETE FROM crux_task_progress WHERE projectId=? AND taskId=?', projectId, row.taskId); continue }
      const nextFence = taskProgressFence(this.host, projectId, next).fence
      if (!previous || taskProgressFence(this.host, projectId, previous).fence !== nextFence) {
        this.host.run('UPDATE crux_task_progress SET generation=?,fence=?,spaceId=?,bindingJson=NULL,progressJson=NULL,ownerKey=NULL WHERE projectId=? AND taskId=?', nextGeneration(row.generation), nextFence, next.spaceId, projectId, row.taskId)
      }
    }
  }
}
