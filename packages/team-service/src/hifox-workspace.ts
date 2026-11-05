import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { z } from 'zod'
import type { HifoxInboxItem, HifoxMember, HifoxSnapshot, HifoxTask, HifoxTransitionTaskInput } from '../../../src/shared/hifox'
import { hifoxSnapshotSchema } from '../../../src/shared/hifox-schema'
import { executeHifoxDomain, canReadHifoxSpace, HifoxSpaceAccessError, hifoxMutationNames, hifoxMutationInputSchemas, type HifoxMutationName } from '../../../src/shared/hifox-domain/commands'
import { buildInitialSnapshot } from '../../../src/shared/hifox-domain/seed'
import { HifoxError as CoreError } from '../../../src/shared/hifox-domain/core'
import { HifoxError as PlanningError, tickScheduledAutomations } from '../../../src/shared/hifox-domain/planning'
import { withHifoxDomainSnapshot } from '../../../src/shared/hifox-domain/store'
import { HifoxError as AgentError } from '../../../src/shared/hifox-domain/agents'
import { hifoxRemoteCommandSchema, hifoxRemoteSnapshotSchema, type HifoxRemoteSnapshot } from '../../../src/shared/hifox-remote'
import { teamIdSchema, teamRoleSchema, TEAM_MAX_RESPONSE_BYTES, type TeamCommandReply } from '../../../src/shared/team-platform'
import { teamTaskMaterialMetadataSchema, teamTaskMaterialSubmissionSchema, teamTaskMaterialVersionSchema, type TeamTaskMaterialKind } from '../../../src/shared/team-task-materials'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError, requireValue } from './errors'

type Row = Record<string, SQLOutputValue>
type Workspace = { revision: number; snapshot: HifoxSnapshot }
/** All persistence and transactions stay on the existing SQLite writer. */
export interface HifoxWorkspaceHost {
  identity(): { instanceId: string; epoch: string; authorizationRevision: number }
  transaction<T>(action: () => T): T
  invalidateProgress(projectId: string, before: HifoxSnapshot, after: HifoxSnapshot): void
  validateTaskTransitionInputs(principal: StorePrincipal, projectId: string, beforeTask: HifoxTask, afterTask: HifoxTask, transition: HifoxTransitionTaskInput): void
  get(sql: string, ...params: SQLInputValue[]): Row | undefined
  all(sql: string, ...params: SQLInputValue[]): Row[]
  run(sql: string, ...params: SQLInputValue[]): unknown
  authenticate(actor: StoreActor): StorePrincipal
  project(principal: StorePrincipal, projectId: string): void
  mutation<T>(actor: StoreActor, commandId: string, kind: string, input: unknown, authorize: (principal: StorePrincipal) => void, apply: (principal: StorePrincipal) => T, replay?: (principal: StorePrincipal, result: T) => void): TeamCommandReply<T>
}

const privateInbox = new Set<HifoxMutationName>(['markInboxRead', 'clearInbox', 'snoozeInbox', 'restoreInbox'])
const ordinaryMutations = new Set<HifoxMutationName>([
  'joinSpace', 'setSpaceMembers',
  'createTask', 'updateTask', 'transitionTask', 'recordVersionDelivery', 'removeTask', 'addRelation', 'removeRelation', 'addComment', 'resolveComment',
  'createProject', 'updateProject', 'createIteration', 'updateIteration', 'completeIteration', 'saveView', 'removeView', 'triage', ...privateInbox
])
const membershipMutations = new Set<HifoxMutationName>(['inviteMember', 'removeMember', 'updateMember'])
const MAX_MEMBERS = 500
const MAX_MATERIAL_DECISION_REMINDERS = 200
const MATERIAL_REVIEW_PREFIX = 'task-material-review:'
const MATERIAL_KIND_LABELS: Record<TeamTaskMaterialKind, string> = { prd: '需求说明', design: '设计说明', implement: '实施计划', 'delivery-note': '交付说明' }
const spaceMembersInputSchema = hifoxMutationInputSchemas.setSpaceMembers.extend({ memberIds: hifoxMutationInputSchemas.setSpaceMembers.shape.memberIds.max(MAX_MEMBERS) })
// Leave room for the HTTP/command-reply envelope around the snapshot.
const MAX_SNAPSHOT_BYTES = TEAM_MAX_RESPONSE_BYTES - 16 * 1024
const string = (row: Row, key: string): string => {
  const value = row[key]
  if (typeof value !== 'string') throw new TeamServiceError('CORRUPT_STORE', 'Invalid workspace text', 503)
  return value
}
const integer = (row: Row, key: string): number => {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TeamServiceError('CORRUPT_STORE', 'Invalid workspace number', 503)
  return value
}
const deny = (): never => { throw new TeamServiceError('OPERATION_FORBIDDEN', 'Current project membership does not permit this workspace operation', 403) }
const repositoryReference = (value: string): void => {
  let url: URL
  try { url = new URL(value) }
  catch { throw new TeamServiceError('INVALID_INPUT', 'Repository references must use a remote URL without credentials or a local filesystem path') }
  if (!['http:', 'https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) {
    throw new TeamServiceError('INVALID_INPUT', 'Repository references must use a remote URL without credentials or a local filesystem path')
  }
}

export class TeamHifoxWorkspace {
  constructor(private readonly host: HifoxWorkspaceHost) {}

  /** Called only by the owned material writer inside its existing transaction. */
  materialsChanged(projectId: string): void {
    const row = requireValue(this.host.get('SELECT revision FROM hifox_workspaces WHERE projectId=?', projectId), 'CORRUPT_STORE', 'Material workspace is unavailable', 503)
    const revision = integer(row, 'revision')
    if (revision >= Number.MAX_SAFE_INTEGER) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Workspace revision bound exceeded', 503)
    this.host.run('UPDATE hifox_workspaces SET revision=?,updatedAt=? WHERE projectId=?', revision + 1, Date.now(), projectId)
  }

  /** The service's owned timer runs persisted rules, independent of connected desktops. */
  tick(): number {
    let updated = 0
    for (const row of this.host.all('SELECT projectId FROM hifox_workspaces ORDER BY projectId')) {
      const projectId = string(row, 'projectId')
      this.host.transaction(() => {
        const workspace = this.load(projectId)
        const eligible = new Set(workspace.snapshot.members.filter((member) => member.role !== 'member').map((member) => member.id))
        const before = JSON.stringify(workspace.snapshot)
        for (const rule of workspace.snapshot.automations) {
          const space = workspace.snapshot.spaces.find((entry) => entry.id === rule.spaceId)
          if (rule.enabled && (!rule.creatorId || !eligible.has(rule.creatorId) || !space || space.archived || !canReadHifoxSpace(space, rule.creatorId))) rule.enabled = false
        }
        const ticked = withHifoxDomainSnapshot(workspace.snapshot, () => tickScheduledAutomations()).snapshot
        if (JSON.stringify(ticked) === before) return
        if (Buffer.byteLength(JSON.stringify(ticked)) > MAX_SNAPSHOT_BYTES - 4096) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Scheduled workspace update exceeds its response bound', 413)
        if (workspace.revision >= Number.MAX_SAFE_INTEGER) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Workspace revision bound exceeded', 503)
        this.host.invalidateProgress(projectId, workspace.snapshot, ticked)
        this.host.run('UPDATE hifox_workspaces SET revision=?,snapshotJson=?,updatedAt=? WHERE projectId=?', workspace.revision + 1, JSON.stringify(ticked), Date.now(), projectId)
        updated++
      })
    }
    return updated
  }

  private members(projectId: string): HifoxMember[] {
    const rows = this.host.all('SELECT p.userId,p.displayName,p.createdAt,pm.rolesJson FROM project_members pm JOIN people p ON p.userId=pm.userId JOIN projects pr ON pr.projectId=pm.projectId JOIN team_members tm ON tm.teamId=pr.teamId AND tm.userId=pm.userId WHERE pm.projectId=? AND pm.active=1 AND tm.active=1 AND p.active=1 ORDER BY p.createdAt,p.userId LIMIT ?', projectId, MAX_MEMBERS + 1)
    if (rows.length > MAX_MEMBERS) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Project workspace member bound exceeded', 413)
    return rows.map((row) => {
      const roles = z.array(teamRoleSchema).min(1).max(5).parse(JSON.parse(string(row, 'rolesJson')))
      const userId = string(row, 'userId')
      return { id: userId, name: string(row, 'displayName'), role: roles.includes('admin') ? 'owner' : roles.includes('pm') ? 'admin' : 'member', projectRoles: roles, avatarHue: [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360, joinedAt: new Date(integer(row, 'createdAt')).toISOString() }
    })
  }

  /** Also used when authorizing a historical command receipt. */
  authorize(principal: StorePrincipal, projectId: string, operation?: HifoxMutationName): void {
    const current = this.host.authenticate(principal.actor)
    this.host.project(current, teamIdSchema.parse(projectId))
    const member = requireValue(this.members(projectId).find((entry) => entry.id === current.person.userId), 'FORBIDDEN', 'Current project membership is unavailable', 403)
    if (operation && membershipMutations.has(operation)) throw new TeamServiceError('MANAGEMENT_REQUIRED', 'Manage authenticated invitations, account profiles and project roles through the team membership API', 403)
    if (operation && !ordinaryMutations.has(operation) && member.role === 'member') deny()
  }

  private authorizeSpaceMembers(snapshot: HifoxSnapshot, actorId: string, spaceId: string): void {
    const actor = snapshot.members.find((member) => member.id === actorId)
    const space = snapshot.spaces.find((entry) => entry.id === spaceId)
    if (!actor || !space || !canReadHifoxSpace(space, actorId) || (actor.role === 'member' && space.ownerId !== actorId)) deny()
  }

  private spaceMembersInput(snapshot: HifoxSnapshot, raw: unknown): z.infer<typeof spaceMembersInputSchema> {
    const input = spaceMembersInputSchema.parse(raw)
    const active = new Set(snapshot.members.map((member) => member.id))
    if (input.memberIds.some((id) => !active.has(id))) throw new TeamServiceError('INVALID_INPUT', '只能添加当前工作区已授权的有效账号；请先在团队与成员中核对工作区授权')
    const ownerId = snapshot.spaces.find((space) => space.id === input.spaceId)?.ownerId
    // Retain the active owner without restoring a revoked account's space grant.
    return { ...input, memberIds: [...new Set([...input.memberIds, ...(ownerId && active.has(ownerId) ? [ownerId] : [])])] }
  }

  private load(projectId: string): Workspace {
    const row = this.host.get('SELECT revision,snapshotJson FROM hifox_workspaces WHERE projectId=?', projectId)
    let snapshot: HifoxSnapshot
    try { snapshot = row ? hifoxSnapshotSchema.parse(JSON.parse(string(row, 'snapshotJson'))) : buildInitialSnapshot() }
    catch { throw new TeamServiceError('CORRUPT_STORE', 'Stored project workspace cannot be read', 503) }
    snapshot.members = this.members(projectId)
    const active = new Set(snapshot.members.map((member) => member.id))
    // Local roster entries can never add a remote member or keep a revoked space grant.
    for (const space of snapshot.spaces) space.memberIds = space.memberIds.filter((id) => active.has(id))
    return { revision: row ? integer(row, 'revision') : 0, snapshot }
  }

  private materialInbox(projectId: string, userId: string, snapshot: HifoxSnapshot, authority: HifoxSnapshot): HifoxInboxItem[] {
    const taskIds = JSON.stringify(snapshot.tasks.map((task) => task.id))
    const fields = 'SELECT d.recordJson,s.metadataJson,v.metadataJson AS versionJson FROM task_material_documents d JOIN task_material_submissions s ON s.documentId=d.documentId JOIN task_material_versions v ON v.documentId=d.documentId AND v.versionId=s.versionId WHERE d.projectId=? AND d.taskId IN (SELECT value FROM json_each(?))'
    const pending = this.host.all(`${fields} AND json_extract(s.metadataJson,'$.status')='pending' AND json_extract(d.recordJson,'$.latestSubmission.submissionId')=s.submissionId AND EXISTS(SELECT 1 FROM json_each(d.recordJson,'$.approverIds') a WHERE a.value=?) ORDER BY json_extract(s.metadataJson,'$.submittedAt') DESC`, projectId, taskIds, userId)
    // Settled reminders are a recent inbox view; complete decisions remain in submission history.
    const settled = this.host.all(`${fields} AND json_extract(s.metadataJson,'$.status') IN ('approved','rejected') AND (json_extract(s.metadataJson,'$.submittedBy')=? OR json_extract(d.recordJson,'$.ownerId')=?) ORDER BY json_extract(s.metadataJson,'$.decidedAt') DESC LIMIT ?`, projectId, taskIds, userId, userId, MAX_MATERIAL_DECISION_REMINDERS)
    const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]))
    const currentTasks = new Map(authority.tasks.map((task) => [task.id, task]))
    const spaces = new Map(authority.spaces.map((space) => [space.id, space]))
    const items: HifoxInboxItem[] = []
    for (const row of [...pending, ...settled]) {
      const doc = teamTaskMaterialMetadataSchema.parse(JSON.parse(string(row, 'recordJson')))
      const submission = teamTaskMaterialSubmissionSchema.parse(JSON.parse(string(row, 'metadataJson')))
      const version = teamTaskMaterialVersionSchema.parse(JSON.parse(string(row, 'versionJson')))
      const task = tasks.get(doc.taskId), current = currentTasks.get(doc.taskId), space = spaces.get(doc.spaceId)
      if (!task || !current || !space || task.createdAt !== doc.taskCreatedAt || current.createdAt !== doc.taskCreatedAt || task.spaceId !== doc.spaceId || current.spaceId !== doc.spaceId || !canReadHifoxSpace(space, userId)) continue
      if (doc.projectId !== projectId || submission.documentId !== doc.documentId || version.documentId !== doc.documentId || version.versionId !== submission.versionId || version.bodyDigest !== submission.bodyDigest) throw new TeamServiceError('CORRUPT_STORE', 'Review inbox fixed version is inconsistent', 503)
      const label = MATERIAL_KIND_LABELS[doc.kind]
      if (submission.status === 'pending') {
        // A project role or public-space read grant never makes someone an approver.
        if (space.archived || !space.memberIds.includes(userId) || !doc.approverIds.includes(userId) || doc.latestSubmission?.submissionId !== submission.submissionId || doc.latestSubmission.status !== 'pending') continue
        items.push({ id: `${MATERIAL_REVIEW_PREFIX}${submission.submissionId}`, section: 'important', kind: 'status', taskId: task.id, spaceId: space.id,
          title: `${task.id} · 请评审${label} v${version.number}`, body: `请在任务工作区阅读本次固定${label}并批准或退回；后续草稿不会替换此评审版本。`, at: new Date(submission.submittedAt).toISOString(), read: false, recipientIds: [userId] })
      } else {
        if (submission.submittedBy !== userId && doc.ownerId !== userId) continue
        const reviewer = authority.members.find((member) => member.id === submission.decidedBy)?.name ?? '原评审人'
        items.push({ id: `${MATERIAL_REVIEW_PREFIX}${submission.submissionId}:decision`, section: 'important', kind: 'status', taskId: task.id, spaceId: space.id,
          title: `${task.id} · ${label} v${version.number}${submission.status === 'approved' ? ' 已批准' : ' 已退回'}`, body: `${reviewer}${submission.status === 'approved' ? ' 已批准本次固定版本。' : ` 退回了本次固定版本：${submission.reason ?? ''}`}`,
          at: new Date(submission.decidedAt ?? submission.submittedAt).toISOString(), read: false, recipientIds: [userId] })
      }
    }
    return items
  }

  private personal(projectId: string, userId: string, snapshot: HifoxSnapshot, authority: HifoxSnapshot = snapshot): HifoxSnapshot {
    snapshot = this.scoped(snapshot, userId, authority)
    // Old receipts cannot revive a resolved/revoked review or supply its recipients.
    const visible = [...snapshot.inbox.filter((item) => !item.id.startsWith(MATERIAL_REVIEW_PREFIX) && item.recipientIds?.includes(userId)), ...this.materialInbox(projectId, userId, snapshot, authority)]
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || left.id.localeCompare(right.id))
    const preferences = this.host.all('SELECT inboxId,read,cleared,snoozedUntil FROM hifox_inbox_preferences WHERE projectId=? AND userId=? AND inboxId IN (SELECT value FROM json_each(?))', projectId, userId, JSON.stringify(visible.map((item) => item.id)))
    const byId = new Map(preferences.map((row) => [string(row, 'inboxId'), row]))
    return { ...snapshot, inbox: visible.map((item) => {
      const row = byId.get(item.id)
      return { ...item, read: row ? integer(row, 'read') === 1 : false, cleared: row ? integer(row, 'cleared') === 1 : false, snoozedUntil: row && row.snoozedUntil !== null ? string(row, 'snoozedUntil') : undefined }
    }) }
  }

  /** Project roles permit private metadata management, never access to private content or rosters. */
  private scoped(source: HifoxSnapshot, userId: string, authority: HifoxSnapshot = source): HifoxSnapshot {
    const snapshot = structuredClone(source)
    const manager = authority.members.some((member) => member.id === userId && member.role !== 'member')
    const readable = new Set(authority.spaces.filter((space) => canReadHifoxSpace(space, userId)).map((space) => space.id))
    const discoverable = new Set(authority.spaces.filter((space) => readable.has(space.id) || manager).map((space) => space.id))
    snapshot.members = structuredClone(authority.members)
    snapshot.spaces = snapshot.spaces.filter((space) => discoverable.has(space.id)).map((space) => {
      const current = authority.spaces.find((entry) => entry.id === space.id)
      return readable.has(space.id) ? { ...space, memberIds: current?.memberIds ?? [], ownerId: current?.ownerId }
        : { id: space.id, name: space.name, key: space.key, description: space.description, visibility: current?.visibility, archived: current?.archived, memberIds: [], multiAssignee: space.multiAssignee, taskSeq: 0, createdAt: space.createdAt }
    })
    snapshot.taskTypes = snapshot.taskTypes.filter((entry) => readable.has(entry.spaceId))
    snapshot.taskStatuses = snapshot.taskStatuses.filter((entry) => readable.has(entry.spaceId))
    snapshot.taskLabels = snapshot.taskLabels.filter((entry) => !entry.spaceId || readable.has(entry.spaceId))
    snapshot.tasks = snapshot.tasks.filter((entry) => readable.has(entry.spaceId))
    snapshot.projects = snapshot.projects.filter((entry) => readable.has(entry.spaceId))
    snapshot.iterations = snapshot.iterations.filter((entry) => readable.has(entry.spaceId))
    snapshot.views = snapshot.views.filter((entry) => readable.has(entry.spaceId))
    snapshot.automations = snapshot.automations.filter((entry) => readable.has(entry.spaceId))
    snapshot.agents = snapshot.agents.filter((entry) => readable.has(entry.spaceId))
    snapshot.skills = snapshot.skills.filter((entry) => !entry.spaceId || readable.has(entry.spaceId))
    const people = new Set(authority.members.map((member) => member.id))
    const currentSpaces = new Map(authority.spaces.map((space) => [space.id, space]))
    const visibleAgents = new Map(snapshot.agents.map((agent) => [agent.id, agent]))
    const currentMember = (spaceId: string, memberId: string): boolean => people.has(memberId) && currentSpaces.get(spaceId)?.memberIds.includes(memberId) === true
    snapshot.crews = snapshot.crews.filter((crew) => readable.has(crew.spaceId)
      && (crew.captain.kind === 'member' ? currentMember(crew.spaceId, crew.captain.id) : visibleAgents.get(crew.captain.id)?.spaceId === crew.spaceId))
    const ids = (entries: Array<{ id: string }>): Set<string> => new Set(entries.map((entry) => entry.id))
    const taskIds = ids(snapshot.tasks), typeIds = ids(snapshot.taskTypes), statusIds = ids(snapshot.taskStatuses), labelIds = ids(snapshot.taskLabels)
    const projectIds = ids(snapshot.projects), iterationIds = ids(snapshot.iterations), agentIds = ids(snapshot.agents), crewIds = ids(snapshot.crews), skillIds = ids(snapshot.skills)
    const visibleIterations = new Map(snapshot.iterations.map((iteration) => [iteration.id, iteration]))
    snapshot.versionDeliveries = (snapshot.versionDeliveries ?? []).filter((delivery) => readable.has(delivery.spaceId)
      && delivery.sourceIterationId !== delivery.targetIterationId
      && visibleIterations.get(delivery.sourceIterationId)?.spaceId === delivery.spaceId
      && visibleIterations.get(delivery.targetIterationId)?.spaceId === delivery.spaceId)
    const present = (values: string[], allowed: Set<string>): string[] => values.filter((id) => allowed.has(id))
    const optional = (value: string | undefined, allowed: Set<string>): string | undefined => value && allowed.has(value) ? value : undefined
    snapshot.tasks = snapshot.tasks.map((task) => ({ ...task, typeId: optional(task.typeId, typeIds), parentTaskId: optional(task.parentTaskId, taskIds),
      labelIds: present(task.labelIds, labelIds), projectId: optional(task.projectId, projectIds), iterationIds: present(task.iterationIds, iterationIds),
      relations: task.relations.filter((relation) => taskIds.has(relation.taskId)), executor: task.executor && (task.executor.kind === 'agent' ? agentIds : crewIds).has(task.executor.id) ? task.executor : undefined }))
    snapshot.comments = snapshot.comments.filter((comment) => taskIds.has(comment.taskId))
    const commentIds = ids(snapshot.comments)
    for (const comment of snapshot.comments) comment.parentId = optional(comment.parentId, commentIds)
    const hiddenTaskIds = source.tasks.filter((task) => !taskIds.has(task.id)).map((task) => task.id)
    snapshot.activities = snapshot.activities.filter((activity) => taskIds.has(activity.taskId)
      && !(activity.kind === 'relation' && hiddenTaskIds.some((id) => activity.text.includes(id))))
    snapshot.triageDecisions = snapshot.triageDecisions.filter((decision) => taskIds.has(decision.taskId))
    // Legacy taskless reminders have no provable scope; do not expose their bodies remotely.
    snapshot.inbox = snapshot.inbox.filter((item) => (!item.taskId || taskIds.has(item.taskId)) && (item.spaceId ? readable.has(item.spaceId) : Boolean(item.taskId)))
    for (const type of snapshot.taskTypes) if (type.statusIds) type.statusIds = present(type.statusIds, statusIds)
    for (const iteration of snapshot.iterations) {
      iteration.taskIds = present(iteration.taskIds, taskIds)
      if (iteration.predecessorId && visibleIterations.get(iteration.predecessorId)?.spaceId !== iteration.spaceId) iteration.predecessorId = undefined
    }
    for (const view of snapshot.views) view.filter = { ...view.filter,
      statusIds: view.filter.statusIds && present(view.filter.statusIds, statusIds), typeIds: view.filter.typeIds && present(view.filter.typeIds, typeIds),
      labelIds: view.filter.labelIds && present(view.filter.labelIds, labelIds), projectId: optional(view.filter.projectId, projectIds), iterationId: optional(view.filter.iterationId, iterationIds) }
    for (const agent of snapshot.agents) { agent.skillIds = present(agent.skillIds, skillIds); agent.exclusiveCrewId = optional(agent.exclusiveCrewId, crewIds) }
    for (const crew of snapshot.crews) {
      crew.members = crew.members.filter((member) => member.kind === 'member' ? currentMember(crew.spaceId, member.id) : visibleAgents.get(member.id)?.spaceId === crew.spaceId)
      if (crew.ownerId && !currentMember(crew.spaceId, crew.ownerId)) crew.ownerId = undefined
    }
    for (const rule of snapshot.automations) {
      rule.projectId = optional(rule.projectId, projectIds)
      if (rule.trigger.kind === 'task_status') rule.trigger.value = optional(rule.trigger.value, statusIds)
      if ((rule.target.kind === 'agent' && !agentIds.has(rule.target.id ?? '')) || (rule.target.kind === 'crew' && !crewIds.has(rule.target.id ?? ''))) rule.target = { kind: 'none' }
    }
    return snapshot
  }

  /** Receipt bodies remain historical but are intersected with the caller's current space grants. */
  projectReceipt(principal: StorePrincipal, raw: unknown): HifoxRemoteSnapshot {
    const result: HifoxRemoteSnapshot = hifoxRemoteSnapshotSchema.parse(raw)
    this.authorize(principal, result.projectId)
    const current = this.load(result.projectId)
    const actor = requireValue(current.snapshot.members.find((member) => member.id === principal.person.userId), 'FORBIDDEN', 'Current project membership is unavailable', 403)
    result.snapshot = this.personal(result.projectId, actor.id, result.snapshot, current.snapshot)
    result.actor = actor
    result.canManage = actor.role !== 'member'
    result.authorizationRevision = this.host.identity().authorizationRevision
    if (result.taskId && !result.snapshot.tasks.some((task) => task.id === result.taskId)) delete result.taskId
    return result
  }

  private view(principal: StorePrincipal, projectId: string, workspace: Workspace, taskId?: string): HifoxRemoteSnapshot {
    const actor = requireValue(workspace.snapshot.members.find((member) => member.id === principal.person.userId), 'FORBIDDEN', 'Current project membership is unavailable', 403)
    const value = hifoxRemoteSnapshotSchema.parse({ projectId, ...this.host.identity(), revision: workspace.revision, actor, canManage: actor.role !== 'member', snapshot: this.personal(projectId, actor.id, workspace.snapshot), serverTime: Date.now(), ...(taskId ? { taskId } : {}) })
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_SNAPSHOT_BYTES) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Project workspace exceeds its response bound', 413)
    return value
  }

  read(principal: StorePrincipal, raw: Record<string, unknown>): HifoxRemoteSnapshot {
    const projectId = teamIdSchema.parse(raw.projectId)
    this.authorize(principal, projectId)
    return this.view(principal, projectId, this.load(projectId))
  }

  /** Authorization is checked on every wait tick; no snapshot parse, clone or roster projection. */
  head(actor: StoreActor, raw: Record<string, unknown>): { instanceId: string; epoch: string; authorizationRevision: number; revision: number } {
    const projectId = teamIdSchema.parse(raw.projectId)
    const principal = this.host.authenticate(actor)
    this.host.project(principal, projectId)
    const row = this.host.get('SELECT revision FROM hifox_workspaces WHERE projectId=?', projectId)
    return { ...this.host.identity(), revision: row ? integer(row, 'revision') : 0 }
  }

  /** Called only inside execution admission's existing writer transaction. */
  executionTransition(principal: StorePrincipal, projectId: string, expectedRevision: number, transition: HifoxTransitionTaskInput): void {
    this.authorize(principal, projectId, 'transitionTask')
    this.applyBusinessCommand(principal, projectId, { commandId: '', expectedEpoch: this.host.identity().epoch, expectedRevision, operation: 'transitionTask', input: transition })
  }

  private applyBusinessCommand(principal: StorePrincipal, projectId: string, input: z.infer<typeof hifoxRemoteCommandSchema>): HifoxRemoteSnapshot {
    const workspace = this.load(projectId)
    if (workspace.revision !== input.expectedRevision) throw new TeamServiceError('REVISION_CONFLICT', 'Workspace revision changed; reload the authorized snapshot before creating a new command', 409)
    if (workspace.revision >= Number.MAX_SAFE_INTEGER) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Workspace revision bound exceeded', 503)
    const source = privateInbox.has(input.operation) ? this.personal(projectId, principal.person.userId, workspace.snapshot) : workspace.snapshot
    if (input.operation === 'saveAgent') {
      const agent = hifoxMutationInputSchemas.saveAgent.parse(input.input)
      for (const repository of agent.repositories ?? []) if (repository.url) repositoryReference(repository.url)
    }
    let executed: ReturnType<typeof executeHifoxDomain>
    try { executed = executeHifoxDomain(source, input.operation, input.operation === 'setSpaceMembers' ? this.spaceMembersInput(source, input.input) : input.input, principal.person.userId) }
    catch (error) {
      if (error instanceof z.ZodError || error instanceof TeamServiceError) throw error
      if (error instanceof HifoxSpaceAccessError) throw new TeamServiceError('SPACE_ACCESS_DENIED', error.message, 403)
      if (error instanceof CoreError || error instanceof PlanningError || error instanceof AgentError) throw new TeamServiceError('INVALID_INPUT', error.message)
      throw error
    }
    if (input.operation === 'transitionTask') {
      const transition = hifoxMutationInputSchemas.transitionTask.parse(input.input)
      const beforeTask = source.tasks.find(task => task.id === transition.taskId), afterTask = executed.snapshot.tasks.find(task => task.id === transition.taskId)
      if (!beforeTask || !afterTask) throw new TeamServiceError('TASK_INPUT_SCOPE_CONFLICT', 'Original transition task is unavailable', 409)
      this.host.validateTaskTransitionInputs(principal, projectId, beforeTask, afterTask, transition)
    }
    if (privateInbox.has(input.operation)) {
      for (const item of executed.snapshot.inbox) {
        this.host.run('INSERT INTO hifox_inbox_preferences(projectId,userId,inboxId,read,cleared,snoozedUntil) VALUES(?,?,?,?,?,?) ON CONFLICT(projectId,userId,inboxId) DO UPDATE SET read=excluded.read,cleared=excluded.cleared,snoozedUntil=excluded.snoozedUntil', projectId, principal.person.userId, item.id, item.read ? 1 : 0, item.cleared ? 1 : 0, item.snoozedUntil ?? null)
      }
    } else {
      this.host.invalidateProgress(projectId, workspace.snapshot, executed.snapshot)
      workspace.snapshot = executed.snapshot
    }
    workspace.revision++
    const result = this.view(principal, projectId, workspace, executed.taskId)
    this.host.run('INSERT INTO hifox_workspaces(projectId,revision,snapshotJson,updatedAt) VALUES(?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET revision=excluded.revision,snapshotJson=excluded.snapshotJson,updatedAt=excluded.updatedAt', projectId, workspace.revision, JSON.stringify(workspace.snapshot), Date.now())
    return result
  }

  command(actor: StoreActor, raw: Record<string, unknown>): TeamCommandReply<HifoxRemoteSnapshot> {
    const projectId = teamIdSchema.parse(raw.projectId)
    const input = hifoxRemoteCommandSchema.parse(raw.body)
    if (!hifoxMutationNames.includes(input.operation)) throw new TeamServiceError('INVALID_INPUT', 'Unsupported workspace operation')
    const reply = this.host.mutation(actor, input.commandId, 'hifoxCommand', { projectId, ...input },
      (principal) => {
        this.authorize(principal, projectId, input.operation)
        if (input.expectedEpoch !== this.host.identity().epoch) throw new TeamServiceError('WORKSPACE_EPOCH_CHANGED', 'Workspace generation changed; reload the authorized snapshot and reconcile the original command before creating a new intent', 409)
        if (input.operation === 'setSpaceMembers') this.authorizeSpaceMembers(this.load(projectId).snapshot, principal.person.userId, spaceMembersInputSchema.parse(input.input).spaceId)
      },
      (principal) => this.applyBusinessCommand(principal, projectId, input),
      (principal, result) => { this.authorize(principal, result.projectId) })
    return { ...reply, result: this.projectReceipt(this.host.authenticate(actor), reply.result) }
  }
}
