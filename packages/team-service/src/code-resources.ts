import type { z } from 'zod'
import { z as schema } from 'zod'
import type { HifoxSpace, HifoxTask } from '../../../src/shared/hifox'
import { hifoxSnapshotSchema } from '../../../src/shared/hifox-schema'
import { canReadHifoxSpace } from '../../../src/shared/hifox-domain/commands'
import { teamIdSchema } from '../../../src/shared/team-platform'
import {
  teamCodeResourceSchema, teamCodeResourceCommandSchema, teamCodeResourceListInputSchema, teamCodeResourceListSchema,
  teamSpaceResourceLinkSchema, teamTaskResourceSelectionSchema, teamTaskCodeResourceDtoSchema,
  teamCodeResourceReceiptSchema, teamCodeResourceScopeIdSchema,
  type TeamCodeResource, type TeamCodeResourceCommand, type TeamCodeResourceCommandReply, type TeamCodeResourceList,
  type TeamCodeResourceReceipt, type TeamSpaceResourceLink, type TeamTaskResourceSelection, type TeamTaskCodeResourceDto
} from '../../../src/shared/team-code-resources'
import type { CreationsHost } from './creations'
import type { HifoxWorkspaceHost } from './hifox-workspace'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError } from './errors'
import { invalidateTaskResourceProgress, taskProgressFence } from './task-progress'

type Host = Omit<CreationsHost, 'identity'> & Pick<HifoxWorkspaceHost, 'identity'> & { invalidateExecution(projectId: string, taskId: string): void }
type Context = { principal: StorePrincipal; projectId: string; canManage: boolean; canManageTasks: boolean; spaces: HifoxSpace[]; workspaceRevision: number }
const MAX_RESOURCES = 1000
function fail(code: string, message: string, status = 409): never { throw new TeamServiceError(code, message, status) }
function unavailable(): never { return fail('CODE_RESOURCE_UNAVAILABLE', 'Resource scope is unavailable', 404) }
function stored<T>(validator: z.ZodType<T>, value: unknown): T {
  try { return validator.parse(typeof value === 'string' ? JSON.parse(value) : value) }
  catch { return fail('CORRUPT_STORE', 'Stored code resource or authority is invalid', 503) }
}
function next(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) fail('CAPACITY_EXCEEDED', 'Resource revision exhausted', 503)
  return revision + 1
}
function cas(actual: number, expected: number): void {
  if (actual !== expected) fail('CODE_RESOURCE_REVISION_CONFLICT', 'Resource association changed; reload before choosing again')
}

export class TeamCodeResources {
  constructor(private readonly host: Host) {}

  private invalidateTaskProgress(projectId: string, taskId: string): void {
    invalidateTaskResourceProgress(this.host, projectId, taskId)
    this.host.invalidateExecution(projectId, taskId)
  }

  private context(principal: StorePrincipal, projectId: string): Context {
    this.host.project(principal, projectId)
    const member = this.host.get('SELECT pm.rolesJson,tm.rolesJson AS teamRolesJson FROM project_members pm JOIN projects p ON p.projectId=pm.projectId JOIN team_members tm ON tm.teamId=p.teamId AND tm.userId=pm.userId WHERE pm.projectId=? AND pm.userId=? AND pm.active=1 AND tm.active=1', projectId, principal.person.userId)
    if (!member) fail('FORBIDDEN', 'Current project membership is unavailable', 403)
    const roles = stored(schema.array(schema.string()).max(10), member.rolesJson)
    const teamRoles = stored(schema.array(schema.string()).max(10), member.teamRolesJson)
    const canManage = roles.includes('admin') || teamRoles.some((role) => role === 'owner' || role === 'admin') || principal.person.isPlatformAdmin
    const workspace = this.host.get('SELECT revision FROM hifox_workspaces WHERE projectId=?', projectId)
    const rows = this.host.all("SELECT s.value AS body FROM hifox_workspaces w,json_each(w.snapshotJson,'$.spaces') s WHERE w.projectId=? LIMIT 501", projectId)
    if (rows.length > 500) fail('CAPACITY_EXCEEDED', 'Workspace space count exceeds the resource authorization bound', 413)
    return { principal, projectId, canManage, canManageTasks: canManage || roles.includes('pm'),
      workspaceRevision: workspace ? stored(schema.number().int().nonnegative().safe(), workspace.revision) : 0,
      spaces: rows.map((row) => stored(hifoxSnapshotSchema.shape.spaces.element, row.body)) }
  }

  private space(ctx: Context, spaceId: string, writing = false): HifoxSpace {
    const space = ctx.spaces.find((entry) => entry.id === spaceId)
    if (!space || !canReadHifoxSpace(space, ctx.principal.person.userId)) unavailable()
    if (writing && space.archived) fail('CODE_RESOURCE_INACTIVE', 'Archived spaces cannot change resource associations')
    return space
  }

  private task(ctx: Context, taskId: string): HifoxTask {
    const row = this.host.get("SELECT t.value AS body FROM hifox_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.id')=? LIMIT 1", ctx.projectId, taskId)
    if (!row) unavailable()
    const task = stored(hifoxSnapshotSchema.shape.tasks.element, row.body)
    this.space(ctx, task.spaceId)
    return task
  }

  private canSelect(ctx: Context, task: HifoxTask): boolean {
    const space = this.space(ctx, task.spaceId)
    if (space.archived || task.completedAt || task.triagePending || task.workflow?.stage === 'done') return false
    const status = this.host.get("SELECT json_extract(s.value,'$.category') AS category FROM hifox_workspaces w,json_each(w.snapshotJson,'$.taskStatuses') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=? AND json_extract(s.value,'$.spaceId')=? LIMIT 1", ctx.projectId, task.statusId, task.spaceId)
    if (!status || status.category === 'done' || status.category === 'cancelled') return false
    const userId = ctx.principal.person.userId
    const handler = task.workflow ? task.workflow.handlerId : task.assigneeIds.length === 1 ? task.assigneeIds[0] : undefined
    return space.memberIds.includes(userId) && (handler === userId || ctx.canManageTasks || space.ownerId === userId)
  }

  private resource(projectId: string, resourceId: string): TeamCodeResource | null {
    const row = this.host.get('SELECT recordJson FROM team_code_resources WHERE projectId=? AND resourceId=?', projectId, resourceId)
    return row ? stored(teamCodeResourceSchema, row.recordJson) : null
  }

  private links(projectId: string, spaceId: string): TeamSpaceResourceLink {
    const row = this.host.get('SELECT revision,defaultResourceId FROM team_space_resources WHERE projectId=? AND spaceId=?', projectId, spaceId)
    const links = this.host.all('SELECT resourceId FROM team_space_resource_links WHERE projectId=? AND spaceId=? ORDER BY resourceId LIMIT 65', projectId, spaceId)
    return stored(teamSpaceResourceLinkSchema, { spaceId, revision: row?.revision ?? 0, defaultResourceId: row?.defaultResourceId ?? null, resourceIds: links.map((entry) => entry.resourceId) })
  }

  private selection(ctx: Context, task: HifoxTask): TeamTaskResourceSelection | null {
    const row = this.host.get('SELECT recordJson FROM team_task_code_resources WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=?', ctx.projectId, task.id, task.spaceId, task.createdAt)
    return row ? stored(teamTaskResourceSelectionSchema, row.recordJson) : null
  }

  private invalidateResourceProgress(projectId: string, resourceId: string, spaceId?: string): void {
    const rows = this.host.all("SELECT taskId FROM team_task_code_resources WHERE projectId=? AND json_extract(recordJson,'$.resourceId')=?" + (spaceId ? ' AND spaceId=?' : ''), projectId, resourceId, ...(spaceId ? [spaceId] : []))
    for (const row of rows) {
      if (typeof row.taskId !== 'string') fail('CORRUPT_STORE', 'Stored task resource identity is invalid', 503)
      this.invalidateTaskProgress(projectId, row.taskId)
    }
  }

  list(principal: StorePrincipal, raw: Record<string, unknown>): TeamCodeResourceList {
    const projectId = teamIdSchema.parse(raw.projectId), query = teamCodeResourceListInputSchema.parse(raw.query ?? {})
    const ctx = this.context(principal, projectId)
    if (query.spaceId) this.space(ctx, query.spaceId)
    const spaces = query.spaceId ? [query.spaceId] : ctx.spaces.filter((space) => canReadHifoxSpace(space, principal.person.userId)).map((space) => space.id)
    const heads = this.host.get('SELECT COALESCE(SUM(revision),0) AS revision FROM team_code_resources WHERE projectId=?', projectId)
    const linkHeads = this.host.get('SELECT COALESCE(SUM(revision),0) AS revision FROM team_space_resources WHERE projectId=?', projectId)
    const scope = JSON.stringify(['code-resources', projectId, query.spaceId ?? null, ctx.workspaceRevision, heads?.revision, linkHeads?.revision])
    const after = this.host.after(principal, scope, query.cursor)
    const rows = this.host.all('SELECT resourceId,recordJson FROM team_code_resources r WHERE projectId=? AND resourceId>? AND (?=1 OR EXISTS(SELECT 1 FROM team_space_resource_links l WHERE l.projectId=r.projectId AND l.resourceId=r.resourceId AND l.spaceId IN(SELECT value FROM json_each(?)))) ORDER BY resourceId LIMIT 501', projectId, after, ctx.canManage && !query.spaceId ? 1 : 0, JSON.stringify(spaces))
    const page = this.host.page(principal, scope, rows, 'resourceId', query.limit, () => true, (row) => stored(teamCodeResourceSchema, row.recordJson))
    return teamCodeResourceListSchema.parse({ ...page, ...this.host.identity(), projectId, canManage: ctx.canManage,
      spaceResources: query.spaceId ? this.links(projectId, query.spaceId) : null, serverTime: Date.now() })
  }

  readTask(principal: StorePrincipal, raw: Record<string, unknown>): TeamTaskCodeResourceDto {
    const projectId = teamIdSchema.parse(raw.projectId), taskId = teamCodeResourceScopeIdSchema.parse(raw.taskId)
    const ctx = this.context(principal, projectId), task = this.task(ctx, taskId)
    const selection = this.selection(ctx, task), links = this.links(projectId, task.spaceId)
    const linked = selection?.resourceId && links.resourceIds.includes(selection.resourceId)
    const resource = linked && selection?.resourceId ? this.resource(projectId, selection.resourceId) : null
    const candidate = links.defaultResourceId && links.resourceIds.includes(links.defaultResourceId) ? this.resource(projectId, links.defaultResourceId) : null
    return teamTaskCodeResourceDtoSchema.parse({ ...this.host.identity(), projectId, taskId, taskCreatedAt: task.createdAt,
      taskUpdatedAt: task.updatedAt, spaceId: task.spaceId, revision: selection?.revision ?? 0, canSelect: this.canSelect(ctx, task),
      spaceRevision: links.revision, selection, resource, defaultResource: candidate?.disabled ? null : candidate,
      availability: !selection?.resourceId ? 'unconfigured' : !resource ? 'unlinked' : resource.disabled ? 'disabled' : 'available', serverTime: Date.now() })
  }

  private authorize(ctx: Context, input: TeamCodeResourceCommand): void {
    if (input.expectedEpoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Reload resources after service recovery; retain the original command identity')
    if (input.kind === 'selectTaskResource') {
      if (!this.canSelect(ctx, this.task(ctx, input.taskId))) fail('CODE_RESOURCE_FORBIDDEN', 'Only the current handler or an authorized space manager can select the task resource', 403)
    } else {
      if (!ctx.canManage) fail('CODE_RESOURCE_FORBIDDEN', 'Only a current project administrator can configure code resources', 403)
      if (input.kind === 'setSpaceResources') this.space(ctx, input.spaceId, true)
    }
  }

  authorizeReceipt(principal: StorePrincipal, raw: unknown): void {
    const receipt = stored(teamCodeResourceReceiptSchema, raw), ctx = this.context(principal, receipt.projectId)
    if (receipt.epoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Receipt belongs to a previous service epoch')
    if (receipt.deviceId !== principal.deviceId) fail('CODE_RESOURCE_FORBIDDEN', 'Receipt belongs to another device or browser identity', 403)
    if (receipt.kind === 'selectTaskResource') {
      const task = this.task(ctx, receipt.targetId)
      if (task.createdAt !== receipt.taskCreatedAt || task.spaceId !== receipt.spaceId) unavailable()
      if (!this.canSelect(ctx, task)) fail('CODE_RESOURCE_FORBIDDEN', 'Current task authority does not permit this receipt', 403)
    } else {
      if (!ctx.canManage) fail('CODE_RESOURCE_FORBIDDEN', 'Current administrator authority is required', 403)
      if (receipt.kind === 'setSpaceResources') this.space(ctx, receipt.targetId)
    }
  }

  command(actor: StoreActor, raw: Record<string, unknown>): TeamCodeResourceCommandReply {
    const projectId = teamIdSchema.parse(raw.projectId), input = teamCodeResourceCommandSchema.parse(raw.body)
    const principal = this.host.authenticate(actor)
    return this.host.mutation(actor, input.commandId, 'codeResourceCommand', { projectId, deviceId: principal.deviceId, input },
      (current) => this.authorize(this.context(current, projectId), input),
      (current) => this.apply(this.context(current, projectId), input),
      (current, receipt) => this.authorizeReceipt(current, receipt))
  }

  private apply(ctx: Context, input: TeamCodeResourceCommand): TeamCodeResourceReceipt {
    const committedAt = Date.now(), projectId = ctx.projectId
    let targetId: string, revision: number, taskCreatedAt: string | null = null, spaceId: string | null = null
    if (input.kind === 'create' || input.kind === 'update') {
      targetId = input.resourceId
      const previous = this.resource(projectId, targetId)
      if (input.kind === 'update' && !previous) unavailable()
      cas(previous?.revision ?? 0, input.expectedRevision)
      if (input.kind === 'create') {
        const count = this.host.get('SELECT COUNT(*) AS count FROM team_code_resources WHERE projectId=?', projectId)
        if (Number(count?.count ?? 0) >= MAX_RESOURCES) fail('CAPACITY_EXCEEDED', 'Project resource capacity reached', 413)
      }
      revision = next(previous?.revision ?? 0)
      const resource = teamCodeResourceSchema.parse({ resourceId: targetId, projectId, name: input.name, purpose: input.purpose, moduleDescription: input.moduleDescription,
        source: input.kind === 'create' ? input.source : previous?.source, disabled: input.kind === 'update' ? input.disabled : false,
        revision, createdAt: previous?.createdAt ?? committedAt, updatedAt: committedAt })
      this.host.run('INSERT INTO team_code_resources(projectId,resourceId,revision,recordJson) VALUES(?,?,?,?) ON CONFLICT(projectId,resourceId) DO UPDATE SET revision=excluded.revision,recordJson=excluded.recordJson', projectId, targetId, revision, JSON.stringify(resource))
      if (resource.disabled && !previous?.disabled) this.invalidateResourceProgress(projectId, targetId)
    } else if (input.kind === 'setSpaceResources') {
      targetId = input.spaceId; spaceId = input.spaceId
      const links = this.links(projectId, targetId)
      cas(links.revision, input.expectedRevision)
      for (const resourceId of input.resourceIds) {
        const resource = this.resource(projectId, resourceId)
        if (!resource) unavailable()
        if (resource.disabled && (!links.resourceIds.includes(resourceId) || input.defaultResourceId === resourceId)) fail('CODE_RESOURCE_INACTIVE', 'Disabled resources cannot be newly linked or selected as default')
      }
      revision = next(links.revision)
      this.host.run('INSERT INTO team_space_resources(projectId,spaceId,revision,defaultResourceId) VALUES(?,?,?,?) ON CONFLICT(projectId,spaceId) DO UPDATE SET revision=excluded.revision,defaultResourceId=excluded.defaultResourceId', projectId, targetId, revision, input.defaultResourceId)
      this.host.run('DELETE FROM team_space_resource_links WHERE projectId=? AND spaceId=?', projectId, targetId)
      for (const resourceId of input.resourceIds) this.host.run('INSERT INTO team_space_resource_links(projectId,spaceId,resourceId) VALUES(?,?,?)', projectId, targetId, resourceId)
      for (const resourceId of links.resourceIds) {
        if (!input.resourceIds.includes(resourceId)) this.invalidateResourceProgress(projectId, resourceId, targetId)
      }
    } else {
      targetId = input.taskId
      const task = this.task(ctx, targetId), links = this.links(projectId, task.spaceId), previous = this.selection(ctx, task)
      if (task.createdAt !== input.expectedTaskCreatedAt || task.spaceId !== input.expectedSpaceId || task.updatedAt !== input.expectedTaskUpdatedAt) fail('CODE_RESOURCE_TASK_CONFLICT', 'Task identity or state changed; reload before selecting its resource')
      cas(previous?.revision ?? 0, input.expectedRevision)
      cas(links.revision, input.expectedSpaceRevision)
      if (input.resourceId) {
        if (!links.resourceIds.includes(input.resourceId)) unavailable()
        const resource = this.resource(projectId, input.resourceId)
        if (!resource) unavailable()
        if (resource.disabled) fail('CODE_RESOURCE_INACTIVE', 'Resource is disabled')
        cas(resource.revision, input.expectedResourceRevision ?? 0)
      }
      const changed = (previous?.resourceId ?? null) !== input.resourceId
      if (changed) {
        const progress = this.host.get('SELECT epoch,fence,bindingJson FROM hifox_task_progress WHERE projectId=? AND taskId=?', projectId, targetId)
        if (progress?.bindingJson != null && progress.epoch === this.host.identity().epoch && progress.fence === taskProgressFence(this.host, projectId, task).fence) {
          fail('RESOURCE_IN_USE', 'Release the current progress binding and verify native execution is safely handled before changing the task resource')
        }
      }
      taskCreatedAt = task.createdAt; spaceId = task.spaceId
      revision = previous && !changed ? previous.revision : next(previous?.revision ?? 0)
      if (!previous || changed) {
        const selection = teamTaskResourceSelectionSchema.parse({ taskId: targetId, spaceId: task.spaceId, taskCreatedAt,
          resourceId: input.resourceId, revision, selectedBy: ctx.principal.person.userId, updatedAt: committedAt })
        this.host.run('INSERT INTO team_task_code_resources(projectId,taskId,spaceId,taskCreatedAt,recordJson) VALUES(?,?,?,?,?) ON CONFLICT(projectId,taskId) DO UPDATE SET spaceId=excluded.spaceId,taskCreatedAt=excluded.taskCreatedAt,recordJson=excluded.recordJson', projectId, targetId, task.spaceId, taskCreatedAt, JSON.stringify(selection))
        if (changed) this.invalidateTaskProgress(projectId, targetId)
      }
    }
    return { projectId, epoch: this.host.identity().epoch, kind: input.kind, targetId, taskCreatedAt, spaceId, deviceId: ctx.principal.deviceId, revision, committedAt }
  }
}
