import { TeamJiraBusinessRouting } from './jira-business-routing'
import { createHash, randomUUID } from 'node:crypto'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { z } from 'zod'
import { canonicalWorkflowJson } from '../../../src/shared/workflow'
import { cruxRemoteSnapshotSchema } from '../../../src/shared/crux-remote'
import {
  jiraBusinessEffectQuerySchema,
  jiraBusinessEffectSchema,
  jiraBusinessEventCommandSchema,
  jiraBusinessIntakeCommandSchema,
  jiraBusinessMappingCommandSchema,
  jiraBusinessMappingQuerySchema,
  jiraBusinessTaskMappingSchema,
  type JiraBusinessEffect,
  type JiraBusinessEventCommand,
  type JiraBusinessIssue,
  type JiraBusinessMappingCommand,
  type JiraBusinessTaskMapping
} from '../../../src/shared/jira-business-hooks'
import { teamCommandIdSchema, teamIdSchema, type TeamCommandReply } from '../../../src/shared/team-platform'
import type { TeamTaskRef } from '../../../src/shared/team-task-execution'
import { TeamServiceError } from './errors'
import type { StoreActor, StorePrincipal } from './store-types'

type Row = Record<string, SQLOutputValue>
export interface JiraBusinessHooksHost {
  identity(): { instanceId: string; epoch: string }
  get(sql: string, ...params: SQLInputValue[]): Row | undefined
  all(sql: string, ...params: SQLInputValue[]): Row[]
  run(sql: string, ...params: SQLInputValue[]): void
  authenticate(actor: StoreActor): StorePrincipal
  project(principal: StorePrincipal, projectId: string): void
  task(principal: StorePrincipal, task: TeamTaskRef): void
  createIntakeTask(principal: StorePrincipal, input: z.infer<typeof jiraBusinessIntakeCommandSchema>): TeamTaskRef
  mutation: <T>(
    actor: StoreActor,
    commandId: string,
    kind: string,
    input: unknown,
    authorize: (principal: StorePrincipal) => void,
    apply: (principal: StorePrincipal) => T,
    authorizeReplay?: (principal: StorePrincipal, result: T) => void
  ) => TeamCommandReply<T>
  event(type: string, visibility: 'project', audienceId: string, projectId: string, payload: Record<string, unknown>): void
}

const digest = (value: unknown): string => createHash('sha256').update(canonicalWorkflowJson(value)).digest('hex')
const text = (row: Row, key: string): string => {
  const value = row[key]
  if (typeof value !== 'string') throw new TeamServiceError('CORRUPT_STORE', 'Jira business hook store text is invalid', 503)
  return value
}
const integer = (row: Row, key: string): number => {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TeamServiceError('CORRUPT_STORE', 'Jira business hook store number is invalid', 503)
  return value
}
const json = (row: Row, key: string): unknown => JSON.parse(text(row, key))

function sameTask(left: TeamTaskRef, right: TeamTaskRef): boolean {
  return left.instanceId === right.instanceId && left.projectId === right.projectId && left.spaceId === right.spaceId
    && left.taskId === right.taskId && left.taskCreatedAt === right.taskCreatedAt
}

export class TeamJiraBusinessHooks {
  readonly routing: TeamJiraBusinessRouting
  constructor(private readonly host: JiraBusinessHooksHost) { this.routing = new TeamJiraBusinessRouting(host) }

  private assertEpoch(expectedEpoch: string): void {
    if (expectedEpoch !== this.host.identity().epoch) throw new TeamServiceError('WORKSPACE_EPOCH_CHANGED', 'Jira business command belongs to an old service generation', 409)
  }

  private assertTask(principal: StorePrincipal, task: TeamTaskRef, projectId: string): void {
    if (task.projectId !== projectId || task.instanceId !== this.host.identity().instanceId) throw new TeamServiceError('JIRA_TASK_SCOPE_CONFLICT', 'Jira business effect targets a foreign platform task', 409)
    this.host.task(principal, task)
  }

  private mappingRows(instanceId: string, issueId: string): Row[] {
    return this.host.all('SELECT recordJson FROM jira_business_task_mappings WHERE instanceId=? AND issueId=? ORDER BY rowid', instanceId, issueId)
  }

  private mapping(row: Row): JiraBusinessTaskMapping {
    return jiraBusinessTaskMappingSchema.parse(json(row, 'recordJson'))
  }

  private effect(row: Row): JiraBusinessEffect {
    return jiraBusinessEffectSchema.parse(json(row, 'recordJson'))
  }

  private uniqueMapping(projectId: string, instanceId: string, issueId: string): JiraBusinessTaskMapping | null {
    const rows = this.mappingRows(instanceId, issueId)
    if (rows.length > 1) throw new TeamServiceError('JIRA_TASK_MAPPING_AMBIGUOUS', 'More than one platform task is mapped to this Jira issue', 409)
    const mapping = rows.length === 1 ? this.mapping(rows[0]) : null
    if (mapping && mapping.projectId !== projectId) throw new TeamServiceError('JIRA_TASK_MAPPING_AMBIGUOUS', 'This Jira issue already has a canonical task in another platform project', 409)
    return mapping
  }

  readMapping(actor: StoreActor, raw: unknown): JiraBusinessTaskMapping | null {
    const value = raw as Record<string, unknown>
    const input = jiraBusinessMappingQuerySchema.parse({ projectId: value.projectId, instanceId: value.instanceId, issueId: value.issueId })
    const principal = this.host.authenticate(actor)
    this.host.project(principal, input.projectId)
    const mapping = this.uniqueMapping(input.projectId, input.instanceId, input.issueId)
    if (mapping) this.assertTask(principal, mapping.task, input.projectId)
    return mapping
  }

  private insertMapping(projectId: string, issue: JiraBusinessIssue, task: TeamTaskRef): JiraBusinessTaskMapping {
    const now = Date.now()
    const mapping = jiraBusinessTaskMappingSchema.parse({
      mappingId: randomUUID(), projectId, issue, task, revision: 1, createdAt: now, updatedAt: now,
    })
    this.host.run('INSERT INTO jira_business_task_mappings(projectId,mappingId,instanceId,issueId,recordJson,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)',
      mapping.projectId, mapping.mappingId, mapping.issue.instanceId, mapping.issue.issueId, JSON.stringify(mapping), mapping.createdAt, mapping.updatedAt)
    this.host.event('jira.business-task-linked', 'project', projectId, projectId, {
      mappingId: mapping.mappingId, instanceId: issue.instanceId, issueId: issue.issueId, taskId: task.taskId, spaceId: task.spaceId,
    })
    return mapping
  }

  intake(actor: StoreActor, raw: unknown): TeamCommandReply<JiraBusinessTaskMapping> {
    const input = jiraBusinessIntakeCommandSchema.parse(raw)
    return this.host.mutation(
      actor, input.commandId, 'jiraBusinessIntakeCommand', input,
      principal => {
        this.assertEpoch(input.expectedEpoch)
        this.host.project(principal, input.projectId)
        if (principal.actor.kind !== 'device' || principal.projectId !== input.projectId) {
          throw new TeamServiceError('JIRA_TASK_FORBIDDEN', 'Jira intake requires the original project device', 403)
        }
      },
      principal => {
        const existing = this.uniqueMapping(input.projectId, input.issue.instanceId, input.issue.issueId)
        if (existing) {
          this.assertTask(principal, existing.task, input.projectId)
          if (existing.task.spaceId !== input.spaceId || existing.issue.remoteProjectId !== input.issue.remoteProjectId) {
            throw new TeamServiceError('JIRA_TASK_SCOPE_CONFLICT', 'Jira intake targets a different source project or task space', 409)
          }
          return existing
        }
        const prior = input.priorCreateCommandId && this.host.get(
          "SELECT resultJson FROM commands WHERE userId=? AND commandId=? AND kind='cruxCommand'",
          principal.person.userId, input.priorCreateCommandId,
        )
        let task: TeamTaskRef
        if (prior) {
          const stored = cruxRemoteSnapshotSchema.parse(json(prior, 'resultJson'))
          const original = stored.snapshot.tasks.find(item => item.id === stored.taskId && item.spaceId === input.spaceId)
          if (stored.projectId !== input.projectId || stored.instanceId !== this.host.identity().instanceId || stored.epoch !== input.expectedEpoch
            || !original || original.creatorId !== principal.person.userId || original.title !== input.title
            || (original.description ?? null) !== (input.description || null)) {
            throw new TeamServiceError('JIRA_TASK_SCOPE_CONFLICT', 'Retained Jira create receipt differs from the original intake', 409)
          }
          task = { instanceId: stored.instanceId, projectId: stored.projectId, spaceId: original.spaceId,
            taskId: original.id, taskCreatedAt: original.createdAt }
        } else task = this.host.createIntakeTask(principal, input)
        this.assertTask(principal, task, input.projectId)
        return this.insertMapping(input.projectId, input.issue, task)
      },
      (principal, mapping) => this.assertTask(principal, mapping.task, input.projectId),
    )
  }

  command(actor: StoreActor, raw: unknown): TeamCommandReply<JiraBusinessTaskMapping> {
    const input = jiraBusinessMappingCommandSchema.parse(raw)
    return this.host.mutation(
      actor,
      input.commandId,
      'jiraBusinessMappingCommand',
      input,
      principal => { this.assertEpoch(input.expectedEpoch); this.host.project(principal, input.projectId); this.assertTask(principal, input.task, input.projectId) },
      () => {
        const existing = this.uniqueMapping(input.projectId, input.issue.instanceId, input.issue.issueId)
        if (existing) {
          if (!sameTask(existing.task, input.task)) throw new TeamServiceError('JIRA_TASK_MAPPING_AMBIGUOUS', 'This Jira issue already has another canonical platform task', 409)
          if (input.expectedRevision !== 0 && input.expectedRevision !== existing.revision) throw new TeamServiceError('JIRA_TASK_MAPPING_CONFLICT', 'Jira task mapping changed; reload before retrying', 409)
          return existing
        }
        if (input.expectedRevision !== 0) throw new TeamServiceError('JIRA_TASK_MAPPING_CONFLICT', 'A new Jira task mapping must start at revision zero', 409)
        return this.insertMapping(input.projectId, input.issue, input.task)
      },
      (principal, result) => { this.assertEpoch(input.expectedEpoch); this.host.project(principal, result.projectId); this.assertTask(principal, result.task, result.projectId) }
    ) as TeamCommandReply<JiraBusinessTaskMapping>
  }

  readEffect(actor: StoreActor, raw: unknown): JiraBusinessEffect | null {
    const value = raw as Record<string, unknown>
    const input = jiraBusinessEffectQuerySchema.parse({ projectId: value.projectId, effectId: value.effectId })
    const principal = this.host.authenticate(actor)
    this.host.project(principal, input.projectId)
    const row = this.host.get('SELECT recordJson FROM jira_business_effects WHERE projectId=? AND effectId=?', input.projectId, input.effectId)
    if (!row) return null
    const effect = this.effect(row)
    this.assertTask(principal, effect.task, input.projectId)
    return effect
  }

  event(actor: StoreActor, raw: unknown): TeamCommandReply<JiraBusinessEffect> {
    const input = jiraBusinessEventCommandSchema.parse(raw)
    const semanticDigest = digest({ ...input, commandId: null })
    return this.host.mutation(
      actor,
      input.commandId,
      'jiraBusinessEventCommand',
      input,
      principal => { this.assertEpoch(input.expectedEpoch); this.host.project(principal, input.projectId); this.assertTask(principal, input.task, input.projectId) },
      () => {
        const mapping = this.uniqueMapping(input.projectId, input.issue.instanceId, input.issue.issueId)
        if (!mapping) throw new TeamServiceError('JIRA_TASK_MAPPING_REQUIRED', 'A canonical platform task mapping is required before recording a Jira business event', 409)
        if (!sameTask(mapping.task, input.task) || mapping.revision !== input.expectedMappingRevision) throw new TeamServiceError('JIRA_TASK_MAPPING_CONFLICT', 'Jira issue mapping changed before the business event was admitted', 409)
        const existing = this.host.get('SELECT requestDigest,recordJson FROM jira_business_effects WHERE projectId=? AND effectId=?', input.projectId, input.effectId)
        if (existing) {
          if (text(existing, 'requestDigest') !== semanticDigest) throw new TeamServiceError('JIRA_EFFECT_CONFLICT', 'Effect UUID already describes a different Jira business event', 409)
          const prior = this.effect(existing)
          this.assertTask(this.host.authenticate(actor), prior.task, prior.projectId)
          return prior
        }
        const effect = jiraBusinessEffectSchema.parse({
          contractVersion: 1,
          effectId: input.effectId,
          eventKind: input.eventKind,
          projectId: input.projectId,
          issue: input.issue,
          task: input.task,
          providerJobId: input.providerJobId,
          providerCommandId: input.providerCommandId,
          payloadDigest: input.payloadDigest,
          state: 'recorded',
          providerOutcome: 'unconfirmed',
          recordedAt: Date.now()
        })
        this.host.run('INSERT INTO jira_business_effects(projectId,effectId,requestDigest,recordJson,createdAt) VALUES(?,?,?,?,?)', input.projectId, input.effectId, semanticDigest, JSON.stringify(effect), effect.recordedAt)
        this.host.event('jira.business-effect-recorded', 'project', input.projectId, input.projectId, {
          effectId: effect.effectId, eventKind: effect.eventKind, instanceId: effect.issue.instanceId, issueId: effect.issue.issueId,
          taskId: effect.task.taskId, spaceId: effect.task.spaceId, providerJobId: effect.providerJobId, providerCommandId: effect.providerCommandId,
          state: effect.state, providerOutcome: effect.providerOutcome
        })
        return effect
      },
      (principal, result) => { this.assertEpoch(input.expectedEpoch); this.host.project(principal, result.projectId); this.assertTask(principal, result.task, result.projectId) }
    ) as TeamCommandReply<JiraBusinessEffect>
  }
}

