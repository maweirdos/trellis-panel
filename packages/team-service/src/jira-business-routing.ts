import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CruxTask, CruxTransitionTaskInput } from '../../../src/shared/crux'
import { canonicalWorkflowJson } from '../../../src/shared/workflow'
import { teamCommandIdSchema, teamIdSchema } from '../../../src/shared/team-platform'
import { jiraBusinessDispatchSchema, jiraBusinessRouteCommandSchema, jiraBusinessRouteSchema, jiraBusinessDispatchReceiptSchema, jiraBusinessTaskMappingSchema, type JiraBusinessDispatch, type JiraBusinessRoute } from '../../../src/shared/jira-business-hooks'
import type { JiraBusinessHooksHost } from './jira-business-hooks'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError } from './errors'

const digest = (value: unknown): string => createHash('sha256').update(canonicalWorkflowJson(value)).digest('hex')
const uuid = (value: unknown): string => { const bytes = createHash('sha256').update(canonicalWorkflowJson(value)).digest(); bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128; const h = bytes.toString('hex'); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32) }
const fail = (code: string, message: string): never => { throw new TeamServiceError(code, message, 409) }
const decode = (value: unknown): unknown => { if (typeof value !== 'string') throw new TeamServiceError('CORRUPT_STORE', 'Jira routing record is invalid', 503); return JSON.parse(value) }
export class TeamJiraBusinessRouting {
  constructor(private readonly host: JiraBusinessHooksHost) {}
  private device(principal: StorePrincipal, projectId: string): void {
    this.host.project(principal, projectId)
    if (principal.actor.kind !== 'device' || !principal.deviceId || principal.projectId !== projectId) throw new TeamServiceError('JIRA_NATIVE_WORKER_REQUIRED', 'Jira routing requires the original authenticated desktop device', 403)
  }
  private epoch(epoch: string): void { if (epoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Jira dispatch belongs to an old service generation') }
  private owns(principal: StorePrincipal, route: JiraBusinessRoute): void {
    this.device(principal, route.route.projectId); this.epoch(route.expectedEpoch)
    if (principal.deviceId !== route.deviceId || principal.person.userId !== route.ownerId) throw new TeamServiceError('JIRA_WORKER_FORBIDDEN', 'Jira dispatch belongs to another credential-owning desktop device', 403)
  }
  configure(actor: StoreActor, raw: unknown) {
    const input = jiraBusinessRouteCommandSchema.parse(raw)
    return this.host.mutation(actor, input.commandId, 'jiraBusinessRouteCommand', input,
      p => { this.device(p, input.route.projectId); this.epoch(input.expectedEpoch) }, p => {
        const row = this.host.get('SELECT recordJson FROM jira_business_routes WHERE projectId=? AND routeId=?', input.route.projectId, input.route.routeId)
        const prior = row ? jiraBusinessRouteSchema.parse(decode(row.recordJson)) : null
        if (prior) this.owns(p, prior)
        const workspace = this.host.get('SELECT snapshotJson FROM crux_workspaces WHERE projectId=?', input.route.projectId)
        if (!workspace) throw new TeamServiceError('WORKSPACE_NOT_FOUND', 'Configured platform workspace is unavailable', 404)
        const snapshot = decode(workspace.snapshotJson) as { spaces: Array<{ id: string; memberIds: string[]; archived?: boolean }> }
        if (!snapshot.spaces.some(space => space.id === input.route.spaceId && !space.archived && space.memberIds.includes(p.person.userId))) throw new TeamServiceError('JIRA_TASK_FORBIDDEN', 'Jira worker cannot access the configured platform Space', 403)
        const route = jiraBusinessRouteSchema.parse({ ...input, deviceId: p.deviceId, ownerId: p.person.userId, revision: (prior?.revision ?? 0) + 1 })
        this.host.run('INSERT INTO jira_business_routes(projectId,routeId,recordJson) VALUES(?,?,?) ON CONFLICT(projectId,routeId) DO UPDATE SET recordJson=excluded.recordJson', input.route.projectId, input.route.routeId, JSON.stringify(route))
        return route
      }, (p, result) => this.owns(p, result))
  }
  /** Runs only after a real business transition, in the same writer transaction. */
  committed(principal: StorePrincipal, projectId: string, commandId: string, transition: CruxTransitionTaskInput, before: CruxTask, after: CruxTask, workspaceRevision: number): void {
    if (!teamCommandIdSchema.safeParse(commandId).success || !before.workflow || !after.workflow || before.workflow.stage === after.workflow.stage || before.id !== after.id || before.createdAt !== after.createdAt || before.spaceId !== after.spaceId) return
    const rows = this.host.all(`SELECT recordJson FROM jira_business_task_mappings WHERE projectId=? AND json_extract(recordJson,'$.task.taskId')=? AND json_extract(recordJson,'$.task.spaceId')=? AND json_extract(recordJson,'$.task.taskCreatedAt')=?`, projectId, after.id, after.spaceId, after.createdAt)
    for (const row of rows) {
      const mapping = jiraBusinessTaskMappingSchema.parse(decode(row.recordJson))
      this.host.task(principal, mapping.task)
      if (this.host.all('SELECT mappingId FROM jira_business_task_mappings WHERE instanceId=? AND issueId=?', mapping.issue.instanceId, mapping.issue.issueId).length !== 1) fail('JIRA_TASK_MAPPING_AMBIGUOUS', 'This Jira issue has more than one canonical task across platform projects')
      const routes = this.host.all('SELECT recordJson FROM jira_business_routes WHERE projectId=?', projectId).map(r => jiraBusinessRouteSchema.parse(decode(r.recordJson))).filter(r => r.expectedEpoch === this.host.identity().epoch && r.route.active && r.route.spaceId === after.spaceId && r.route.source.instanceId === mapping.issue.instanceId && r.route.source.remoteProjectId === mapping.issue.remoteProjectId && r.route.actions.includes(transition.action) && r.route.statuses.some(s => s.statusId === after.statusId))
      if (routes.length > 1) fail('JIRA_WORKER_AMBIGUOUS', 'More than one configured Jira worker owns this canonical task business action')
      if (!routes.length) continue
      const route = routes[0]
      const target = route.route.statuses.find(s => s.statusId === after.statusId)
      if (!target) throw new TeamServiceError('JIRA_ROUTE_TARGET_MISSING', 'Configured Jira business target is unavailable', 409)
      const eventId = uuid({ projectId, commandId, mappingId: mapping.mappingId }), effectId = uuid({ eventId, kind: 'jira-transition' })
      const payload = { contractVersion: 1 as const, eventId, effectId, projectId, epoch: this.host.identity().epoch, businessCommandId: commandId, workspaceRevision, action: transition.action, fromStage: before.workflow.stage, toStage: after.workflow.stage, statusId: after.statusId, issue: mapping.issue, task: mapping.task, mappingRevision: mapping.revision, route, target: { remoteStatusId: target.remoteStatusId, transitionId: target.transitionId }, providerCommandId: uuid({ effectId, kind: 'provider-job' }) }
      const dispatch = jiraBusinessDispatchSchema.parse({ ...payload, payloadDigest: digest(payload), providerJobId: null, state: 'pending', evidenceRef: null, recordedAt: Date.now() })
      this.host.run('INSERT INTO jira_business_dispatches(projectId,effectId,routeId,recordJson,createdAt) VALUES(?,?,?,?,?)', projectId, effectId, route.route.routeId, JSON.stringify(dispatch), dispatch.recordedAt)
      this.host.event('jira.business-action-committed', 'project', projectId, projectId, { eventId, effectId, businessCommandId: commandId, taskId: after.id, action: transition.action })
    }
  }
  private load(projectId: string, effectId: string): JiraBusinessDispatch {
    const row = this.host.get('SELECT recordJson FROM jira_business_dispatches WHERE projectId=? AND effectId=?', projectId, effectId)
    if (!row) throw new TeamServiceError('JIRA_EFFECT_NOT_FOUND', 'Original Jira business dispatch is unavailable', 404)
    return jiraBusinessDispatchSchema.parse(decode(row.recordJson))
  }
  private eligible(principal: StorePrincipal, dispatch: JiraBusinessDispatch): boolean {
    this.owns(principal, dispatch.route); this.host.task(principal, dispatch.task)
    const routeRow = this.host.get('SELECT recordJson FROM jira_business_routes WHERE projectId=? AND routeId=?', dispatch.projectId, dispatch.route.route.routeId)
    if (!routeRow || canonicalWorkflowJson(decode(routeRow.recordJson)) !== canonicalWorkflowJson(dispatch.route)) return false
    const rows = this.host.all('SELECT recordJson FROM jira_business_task_mappings WHERE instanceId=? AND issueId=?', dispatch.issue.instanceId, dispatch.issue.issueId)
    if (rows.length !== 1) return false
    const mapping = jiraBusinessTaskMappingSchema.parse(decode(rows[0].recordJson))
    if (mapping.revision !== dispatch.mappingRevision || canonicalWorkflowJson(mapping.task) !== canonicalWorkflowJson(dispatch.task) || canonicalWorkflowJson(mapping.issue) !== canonicalWorkflowJson(dispatch.issue)) return false
    const snapshot = decode(this.host.get('SELECT snapshotJson FROM crux_workspaces WHERE projectId=?', dispatch.projectId)?.snapshotJson) as { tasks: CruxTask[] }
    const task = snapshot.tasks.find(t => t.id === dispatch.task.taskId)
    // Later status cycles must not make an old unconsumed action eligible again.
    const newer = this.host.get(`SELECT effectId FROM jira_business_dispatches WHERE projectId=? AND json_extract(recordJson,'$.task.taskId')=? AND json_extract(recordJson,'$.task.taskCreatedAt')=? AND json_extract(recordJson,'$.workspaceRevision')>? LIMIT 1`, dispatch.projectId, dispatch.task.taskId, dispatch.task.taskCreatedAt, dispatch.workspaceRevision)
    return !newer && dispatch.route.route.active && task?.statusId === dispatch.statusId && task.workflow?.stage === dispatch.toStage
  }
  read(actor: StoreActor, raw: Record<string, unknown>) {
    const projectId = teamIdSchema.parse(raw.projectId), effectId = teamCommandIdSchema.parse(raw.effectId)
    const p = this.host.authenticate(actor), dispatch = this.load(projectId, effectId)
    return { dispatch, eligible: this.eligible(p, dispatch) }
  }
  pending(actor: StoreActor, raw: Record<string, unknown>) {
    const projectId = teamIdSchema.parse(raw.projectId), routeId = teamCommandIdSchema.parse(raw.routeId), p = this.host.authenticate(actor)
    this.device(p, projectId)
    const routeRow = this.host.get('SELECT recordJson FROM jira_business_routes WHERE projectId=? AND routeId=?', projectId, routeId)
    if (!routeRow) return []
    this.owns(p, jiraBusinessRouteSchema.parse(decode(routeRow.recordJson)))
    const pending: Array<{ dispatch: JiraBusinessDispatch; eligible: boolean }> = []
    for (let offset = 0; pending.length < 50; offset += 50) {
      const rows = this.host.all(`SELECT recordJson FROM jira_business_dispatches WHERE projectId=? AND routeId=? AND json_extract(recordJson,'$.state') IN ('pending','admitted','unknown') ORDER BY createdAt,rowid LIMIT 50 OFFSET ?`, projectId, routeId, offset)
      for (const row of rows) {
        const dispatch = jiraBusinessDispatchSchema.parse(decode(row.recordJson))
        try {
          pending.push({ dispatch, eligible: this.eligible(p, dispatch) })
        } catch (error) {
          // Only a stale incarnation with current project/Space access is isolated.
          if (!(error instanceof TeamServiceError) || error.code !== 'JIRA_TASK_STALE') throw error
        }
        if (pending.length === 50) break
      }
      if (rows.length < 50) break
    }
    return pending
  }
  receipt(actor: StoreActor, raw: unknown) {
    const input = jiraBusinessDispatchReceiptSchema.parse(raw)
    return this.host.mutation(actor, input.commandId, 'jiraBusinessDispatchReceipt', input,
      p => { this.device(p, input.projectId); this.epoch(input.expectedEpoch); this.owns(p, this.load(input.projectId, input.effectId).route) }, p => {
        const dispatch = this.load(input.projectId, input.effectId)
        this.host.task(p, dispatch.task)
        if (dispatch.payloadDigest !== input.payloadDigest || dispatch.providerCommandId !== input.providerCommandId || dispatch.providerJobId && dispatch.providerJobId !== input.providerJobId) fail('JIRA_EFFECT_CONFLICT', 'Worker receipt does not match the original effect/job/command identity')
        if (dispatch.state === 'applied' || dispatch.state === 'blocked') {
          if (dispatch.state !== input.state || dispatch.evidenceRef !== input.evidenceRef) fail('JIRA_EFFECT_CONFLICT', 'A terminal Jira receipt cannot be overwritten')
          return dispatch
        }
        if (dispatch.state === 'unknown' && input.state === 'admitted') fail('JIRA_EFFECT_UNKNOWN', 'Unknown provider effects require observation before settlement')
        const updated = jiraBusinessDispatchSchema.parse({ ...dispatch, providerJobId: input.providerJobId, state: input.state, evidenceRef: input.evidenceRef })
        this.host.run('UPDATE jira_business_dispatches SET recordJson=? WHERE projectId=? AND effectId=?', JSON.stringify(updated), input.projectId, input.effectId)
        return updated
      }, (p, result) => { this.owns(p, result.route); this.host.task(p, result.task) })
  }
}
