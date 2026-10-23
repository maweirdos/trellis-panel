import { randomUUID } from 'node:crypto'
import type { DaemonRepository } from '../../../../daemon/repository'
import type { IntegrationScheduler } from '../../../../daemon/scheduler'
import type { DaemonRequest, WorkspaceGrant } from '../../../../../shared/daemon'
import type { IntegrationJob, IntegrationSource } from '../../../../../shared/integration-work'
import { jiraNumericIdSchema, JIRA_LIMITS, type JiraData, type JiraPlan, type JiraRequest } from '../../../../../shared/jira-integration'
import { jiraV2Myself, jiraV2Projects } from '../../../jira'
import { recordOf, rowsOf, textOf } from '../../transport'
import { JiraRemote } from '../lib/remote'
import { equal } from '../lib/mapping'
import { JiraWorkspaceRepository } from '../repository'
import { JiraWorkspaceWorker } from '../work'
import { JiraWorkspaceError, sameGrant, sameRoot, type JiraCallbackPort, type JiraWorkspaceAuthority } from '../types'
import { JiraPreviews } from './previews'

const busyStates = ['queued', 'dispatched', 'running', 'cancel-requested', 'unknown']
export class JiraWorkspaceService {
  readonly previews: JiraPreviews
  constructor(readonly repository: JiraWorkspaceRepository, readonly worker: JiraWorkspaceWorker, private readonly authority: JiraWorkspaceAuthority, private readonly ledger: DaemonRepository, private readonly scheduler: IntegrationScheduler, private readonly profileId: string, private readonly assertInstalled: () => void, private readonly callbacks?: JiraCallbackPort) { this.previews = new JiraPreviews(repository, authority) }
  async context(input: JiraRequest<'context'>): Promise<JiraData<'context'>> {
    this.assertInstalled()
    const grant = await this.authority.context(input.expectedRoot); this.authority.assertGrant(grant)
    if (!sameRoot(grant.root, input.expectedRoot)) throw new JiraWorkspaceError('E_CONFLICT', 'Expected Jira workspace root changed.')
    return { workspaceId: grant.workspaceId, target: { kind: 'local-daemon', profileId: this.profileId, workspaceId: grant.workspaceId }, sources: this.repository.read().sources.filter((entry) => sameGrant(entry.workspace, grant)).map((entry) => ({ source: entry.source, name: entry.name })) }
  }
  async projects(input: JiraRequest<'projects'>, signal?: AbortSignal): Promise<JiraData<'projects'>> {
    const grant = await this.capture(input); const remote = new JiraRemote(await this.authority.resolveBindingConnection(grant, input), signal)
    const result = rowsOf(await jiraV2Projects(remote.cfg, remote.options)).map((item) => ({ id: textOf(item.id), key: textOf(item.key), name: textOf(item.name) }))
    this.authority.assertGrant(grant); await this.authority.resolveBindingConnection(grant, input)
    return result
  }
  async selectProject(input: JiraRequest<'selectProject'>): Promise<JiraData<'selectProject'>> {
    const grant = await this.capture(input); const remote = new JiraRemote(await this.authority.resolveBindingConnection(grant, input))
    const myself = recordOf(await jiraV2Myself(remote.cfg, remote.options))
    if (myself.active !== true || !textOf(myself.name)) throw new JiraWorkspaceError('E_DENIED', 'Jira instance credentials did not verify an active authenticated account.')
    const project = (await this.projects({ ...input, requestId: randomUUID() })).find((project) => project.id === input.projectId)
    if (!project || !(await remote.permissions(project.id)).BROWSE_PROJECTS) throw new JiraWorkspaceError('E_DENIED', 'Selected Jira project is not visible to this connection.')
    const source: IntegrationSource = { providerId: 'jira', connectionId: input.connectionId, connectionRevision: input.connectionRevision, bindingId: input.bindingId, bindingRevision: input.bindingRevision, instanceId: remote.connection.instanceId, remoteProjectId: project.id }
    await this.authority.resolveBindingConnection(grant, input)
    return this.repository.change((state) => {
      const prior = state.sources.find((entry) => entry.workspace.workspaceId === grant.workspaceId && entry.source.bindingId === source.bindingId)
      if (prior && !equal(prior.source, source) && this.ledger.jobs(grant.workspaceId).some((job) => job.source.bindingId === source.bindingId && [...busyStates, 'paused'].includes(job.state))) throw new JiraWorkspaceError('E_CONFLICT', 'Reconcile retained source jobs before replacing their project selection.')
      const entry = { workspace: grant, source, name: `${project.key} · ${project.name}` }
      if (prior) state.sources[state.sources.indexOf(prior)] = entry; else state.sources.push(entry)
      if (prior && !equal(prior.source, source)) for (const plan of state.plans) if (plan.value.plan.source.bindingId === source.bindingId) { plan.value.plan.state = 'blocked'; plan.value.controlRevision++; plan.value.nextPollAt = null; plan.value.detail = 'Project/source selection changed. Review this plan against the newly verified source before enabling it.' }
      return source
    })
  }
  async capture(input: { expectedRoot: string; workspaceId?: string }): Promise<WorkspaceGrant> {
    this.assertInstalled()
    const grant = await this.authority.capture(input); this.authority.assertGrant(grant)
    if (input.workspaceId !== undefined && grant.workspaceId !== input.workspaceId || !sameRoot(grant.root, input.expectedRoot)) throw new JiraWorkspaceError('E_DENIED', 'Jira request does not own this workspace grant/root.')
    return grant
  }
  private request(grant: WorkspaceGrant, method: 'jobs.enqueue' | 'jobs.cancel', payload: unknown, commandId: string): DaemonRequest {
    this.authority.assertGrant(grant)
    return { type: 'request', version: 1, requestId: randomUUID(), expectedEpoch: this.ledger.epoch, workspace: grant, method, payload, commandId }
  }
  private async source(grant: WorkspaceGrant, source: IntegrationSource): Promise<JiraRemote> {
    if (source.providerId !== 'jira') throw new JiraWorkspaceError('E_INVALID_ARG', 'This operation only accepts a Jira source.')
    if (!this.repository.read().sources.some((entry) => sameGrant(entry.workspace, grant) && equal(entry.source, source))) throw new JiraWorkspaceError('E_CONFLICT', 'Select/verify this exact Jira project and binding revision before using it.')
    jiraNumericIdSchema.parse(source.remoteProjectId)
    const connection = await this.authority.resolve(grant, source)
    if (connection.instanceId !== source.instanceId || connection.public.revision !== source.connectionRevision || connection.public.id !== source.connectionId) throw new JiraWorkspaceError('E_CONFLICT', 'Captured source/connection revision changed.')
    this.authority.assertGrant(grant); return new JiraRemote(connection)
  }
  private plan(grant: WorkspaceGrant, id: string, revision: number): JiraPlan {
    const entry = this.repository.read().plans.find((entry) => entry.value.plan.id === id)
    if (!entry || !sameGrant(entry.workspace, grant) || entry.value.plan.revision !== revision) throw new JiraWorkspaceError('E_CONFLICT', 'Sync plan or its original workspace grant changed.')
    return entry.value
  }
  private job(grant: WorkspaceGrant, input: { jobId: string; revision: number; ownerEpoch: string }): IntegrationJob {
    const job = this.ledger.job(input.jobId, grant.workspaceId)
    if (!job || job.source.providerId !== 'jira' || job.revision !== input.revision || job.ownerEpoch !== input.ownerEpoch || !sameGrant(this.ledger.admission(job.id) ?? { ...grant, grantId: '' }, grant)) throw new JiraWorkspaceError('E_CONFLICT', 'Original job revision/owner or retained workspace grant changed.')
    return job
  }
  async snapshot(input: JiraRequest<'snapshot'>): Promise<JiraData<'snapshot'>> {
    const grant = await this.capture(input); const state = this.repository.read()
    const accounts = state.accounts.filter((entry) => sameGrant(entry.workspace, grant))
    const plans = state.plans.filter((entry) => sameGrant(entry.workspace, grant)).map((entry) => entry.value)
    const identities: JiraData<'snapshot'>['identities'] = accounts.map((entry) => ({ sourceConnectionId: entry.account.connectionId, personalConnectionId: entry.personalConnectionId, remoteUserId: entry.account.remoteUserId, username: entry.username, mode: 'personal-connection', detail: 'Separately verified protected personal connection; instance access credentials remain independent.' }))
    const publicAccounts: JiraData<'snapshot'>['accounts'] = []
    for (const entry of accounts) {
      try {
        const personal = await this.authority.resolvePersonalConnection(grant, { connectionId: entry.personalConnectionId, connectionRevision: entry.personalConnectionRevision })
        publicAccounts.push({ ...entry.account, state: personal.public.enabled && personal.public.revision === entry.personalConnectionRevision && state.sources.some((source) => sameGrant(source.workspace, grant) && source.source.connectionId === entry.account.connectionId && source.source.connectionRevision === entry.connectionRevision) ? entry.account.state : 'unverified' })
      } catch {
        publicAccounts.push({ ...entry.account, state: 'unavailable' })
        const identity = identities.find((identity) => identity.sourceConnectionId === entry.account.connectionId)
        if (identity) identity.detail = 'Stored personal identity is unavailable at its protected credential revision. Renew/rebind it; writes do not silently fall back to the instance account.'
      }
    }
    for (const source of new Map(state.sources.filter((entry) => sameGrant(entry.workspace, grant)).map((entry) => [entry.source.connectionId, entry.source])).values()) if (!accounts.some((entry) => entry.account.connectionId === source.connectionId)) {
      try {
        const remote = await this.source(grant, source)
        identities.push({ sourceConnectionId: source.connectionId, personalConnectionId: null, remoteUserId: null, username: remote.cfg.user, mode: 'instance-credential-fallback', detail: 'No personal account is linked. Writes use this configured instance credential username; authentication/issue permissions are rechecked when used.' })
      } catch { identities.push({ sourceConnectionId: source.connectionId, personalConnectionId: null, remoteUserId: null, username: '', mode: 'instance-credential-fallback', detail: 'The retained source/credential revision is unavailable. Re-select and verify the source; no replacement identity is inferred.' }) }
    }
    return { accounts: publicAccounts, identities, plans, conflicts: state.conflicts.filter((entry) => entry.workspaceId === grant.workspaceId && !entry.value.resolved).map((entry) => entry.value).slice(-100), diagnostics: state.diagnostics.filter((entry) => entry.workspaceId === grant.workspaceId).map((entry) => entry.value).slice(-100), scope: 'local-workspace', capability: 'jira-workspace-v1' }
  }
  async discover(input: JiraRequest<'discover'>, signal?: AbortSignal): Promise<JiraData<'discover'>> {
    const grant = await this.capture(input); const remote = await this.source(grant, input.source)
    const data = await new JiraRemote(remote.connection, signal).discover(input.source.remoteProjectId, input.memberQuery)
    await this.source(grant, input.source); return data
  }
  async bindAccount(input: JiraRequest<'bindAccount'>): Promise<JiraData<'bindAccount'>> {
    const grant = await this.capture(input); const source = await this.source(grant, input.source)
    if (this.ledger.jobs(grant.workspaceId).some((job) => job.source.connectionId === input.source.connectionId && [...busyStates, 'paused'].includes(job.state))) throw new JiraWorkspaceError('E_CONFLICT', 'Cancel/reconcile retained source jobs before changing the acting personal identity.')
    let verified: { remoteUserId: string; username: string; displayName: string; personalConnectionId: string; personalConnectionRevision: number } | null = null
    if (!input.unlink) {
      if (!input.personalConnection || input.personalConnection.connectionId === input.source.connectionId) throw new JiraWorkspaceError('E_INVALID_ARG', 'Select a separate protected Jira connection for your personal account.')
      const personal = await this.authority.resolvePersonalConnection(grant, input.personalConnection)
      if (personal.public.legacy) throw new JiraWorkspaceError('E_DENIED', 'Create a separate protected Jira connection for personal identity. Legacy plaintext compatibility is not a new personal credential store.')
      if (personal.public.providerId !== 'jira' || personal.public.revision !== input.personalConnection.connectionRevision || personal.public.id !== input.personalConnection.connectionId) throw new JiraWorkspaceError('E_CONFLICT', 'Personal Jira credential revision changed.')
      const account = new JiraRemote(personal)
      if (new URL(account.cfg.baseUrl).href.replace(/\/+$/, '') !== new URL(source.cfg.baseUrl).href.replace(/\/+$/, '')) throw new JiraWorkspaceError('E_DENIED', 'Personal Jira account must belong to the same configured Jira server/context path.')
      const myself = recordOf(await jiraV2Myself(account.cfg, account.options))
      if (myself.active !== true || !textOf(myself.name)) throw new JiraWorkspaceError('E_DENIED', 'Personal Jira credentials did not verify an active account.')
      verified = { remoteUserId: textOf(myself.key) || textOf(myself.name), username: textOf(myself.name), displayName: textOf(myself.displayName), personalConnectionId: personal.public.id, personalConnectionRevision: personal.public.revision }
      await this.authority.resolvePersonalConnection(grant, input.personalConnection)
    }
    await this.source(grant, input.source)
    return this.repository.change((state) => {
      const previous = state.accounts.find((entry) => entry.workspace.workspaceId === grant.workspaceId && entry.account.connectionId === input.source.connectionId)
      if ((previous?.account.revision ?? 0) !== input.expectedRevision) throw new JiraWorkspaceError('E_CONFLICT', 'Personal binding changed. Reload before saving.')
      if (input.unlink) { state.accounts = state.accounts.filter((entry) => entry !== previous); return null }
      if (!verified) throw new JiraWorkspaceError('E_DENIED', 'No verified personal account is available.')
      const account = { id: previous?.account.id ?? randomUUID(), providerId: 'jira' as const, connectionId: input.source.connectionId, revision: input.expectedRevision + 1, remoteUserId: verified.remoteUserId, displayName: `${verified.displayName || verified.username} (${verified.username})`, state: 'linked' as const }
      const entry = { workspace: grant, account, instanceId: input.source.instanceId, connectionRevision: input.source.connectionRevision, personalConnectionId: verified.personalConnectionId, personalConnectionRevision: verified.personalConnectionRevision, username: verified.username }
      if (previous) state.accounts[state.accounts.indexOf(previous)] = entry; else state.accounts.push(entry)
      return account
    })
  }
  async savePlan(input: JiraRequest<'savePlan'>): Promise<JiraData<'savePlan'>> {
    const grant = await this.capture(input); const value = input.value
    if (value.plan.target.workspaceId !== grant.workspaceId || value.plan.target.profileId !== this.profileId || !value.plan.id || value.plan.revision !== input.expectedRevision + 1) throw new JiraWorkspaceError('E_INVALID_ARG', 'Plan revision/target does not match this workspace/profile.')
    const remote = await this.source(grant, value.plan.source)
    const metadata = await remote.discover(value.plan.source.remoteProjectId, '')
    if (value.createIssueTypeId && !metadata.issueTypes.some((type) => type.id === value.createIssueTypeId)) throw new JiraWorkspaceError('E_DENIED', 'The explicit Jira creation type is not available in this project.')
    let writePermissions = metadata.permissions
    if (value.rules.outboundCreate || value.rules.outboundUpdate) {
      const account = this.repository.read().accounts.find((entry) => sameGrant(entry.workspace, grant) && entry.account.connectionId === value.plan.source.connectionId)
      if (account) {
        if (account.connectionRevision !== value.plan.source.connectionRevision || account.instanceId !== value.plan.source.instanceId) throw new JiraWorkspaceError('E_CONFLICT', 'Reverify personal identity against this instance revision before enabling writes.')
        const personal = await this.authority.resolvePersonalConnection(grant, { connectionId: account.personalConnectionId, connectionRevision: account.personalConnectionRevision })
        const actor = new JiraRemote({ ...personal, instanceId: value.plan.source.instanceId })
        if (new URL(actor.cfg.baseUrl).href.replace(/\/+$/, '') !== new URL(remote.cfg.baseUrl).href.replace(/\/+$/, '')) throw new JiraWorkspaceError('E_CONFLICT', 'Acting personal credential issuer changed.')
        writePermissions = await actor.permissions(value.plan.source.remoteProjectId)
      }
    }
    if (!metadata.permissions.BROWSE_PROJECTS || value.rules.outboundCreate && !writePermissions.CREATE_ISSUES || value.rules.outboundUpdate && !writePermissions.EDIT_ISSUES) throw new JiraWorkspaceError('E_DENIED', 'The instance read account or actual acting write account does not grant the configured project rules.')
    if (value.plan.transport === 'webhook') {
      if (!this.callbacks || !value.receiverId) throw new JiraWorkspaceError('E_UNAVAILABLE', 'A reachable verified Jira receiver must be installed before enabling webhook transport.')
      if (!(await this.callbacks.inspect(grant, { receiverId: value.receiverId, source: value.plan.source })).ready) throw new JiraWorkspaceError('E_UNAVAILABLE', 'Jira callback receiver is not ready; inspect/recover it or select scheduled polling.')
    }
    if (/\bORDER\s+BY\b/i.test(value.jql)) throw new JiraWorkspaceError('E_INVALID_ARG', 'Sync JQL accepts a filter; the retained job owns ordering.')
    for (const taskRef of value.outboundTaskRefs) this.worker.tasks.read(grant, taskRef)
    await this.source(grant, value.plan.source)
    return this.repository.change((state) => {
      const previous = state.plans.find((entry) => entry.value.plan.id === value.plan.id)
      if ((previous?.value.plan.revision ?? 0) !== input.expectedRevision || previous && !sameGrant(previous.workspace, grant)) throw new JiraWorkspaceError('E_CONFLICT', 'Plan revision or original owner changed.')
      if (this.ledger.jobs(grant.workspaceId).some((job) => job.input.kind === 'sync' && job.input.planId === value.plan.id && [...busyStates, 'paused'].includes(job.state))) throw new JiraWorkspaceError('E_CONFLICT', 'Cancel/reconcile the retained job before changing its sync policy.')
      if (previous && (!equal(previous.value.mapping, value.mapping) || !equal(previous.value.plan.source, value.plan.source))) state.baselines = state.baselines.filter((entry) => entry.planId !== value.plan.id)
      const next: JiraPlan = { ...value, controlRevision: (previous?.value.controlRevision ?? 0) + 1, since: previous?.value.since ?? Date.now(), scanAfterId: null, lastSuccessAt: previous?.value.lastSuccessAt ?? null, nextPollAt: value.plan.state === 'active' ? Date.now() : null, failures: 0, detail: value.plan.transport === 'webhook' ? 'Verified receiver selected; scheduled catch-up remains available.' : 'Local daemon scheduled polling; no real-time receiver is implied.' }
      if (previous) state.plans[state.plans.indexOf(previous)] = { workspace: grant, value: next }; else state.plans.push({ workspace: grant, value: next })
      return next
    })
  }
  async planState(input: JiraRequest<'planState'>): Promise<JiraData<'planState'>> {
    const grant = await this.capture(input); const plan = this.plan(grant, input.planId, input.revision)
    await this.source(grant, plan.plan.source)
    return this.repository.change((state) => {
      const entry = state.plans.find((entry) => entry.value.plan.id === plan.plan.id && entry.value.plan.revision === input.revision)
      if (!entry || entry.value.controlRevision !== input.controlRevision) throw new JiraWorkspaceError('E_CONFLICT', 'Plan control revision changed before pause/resume.')
      // State is a live admission gate; retained jobs continue to pin the same policy revision.
      entry.value.plan.state = input.state; entry.value.nextPollAt = input.state === 'active' ? Date.now() : null
      entry.value.controlRevision++
      entry.value.detail = input.state === 'paused' ? 'Paused: no new effects are admitted; an in-flight effect retains its receipt.' : 'Enabled: the next explicit/due catch-up uses this retained mapping.'
      return entry.value
    })
  }
  private async enqueue(grant: WorkspaceGrant, source: IntegrationSource, input: IntegrationJob['input'], commandId: string): Promise<IntegrationJob> {
    const request = this.request(grant, 'jobs.enqueue', { source, input }, commandId)
    // Existing command receipt is consulted before busy checks, preserving reconnect idempotency.
    const prior = this.ledger.receipt(commandId, grant.workspaceId)
    if (prior?.jobId) { const job = this.ledger.job(prior.jobId, grant.workspaceId); if (job && equal(job.input, input) && equal(job.source, source)) return job; throw new JiraWorkspaceError('E_CONFLICT', 'Command ID already describes another Jira intent.') }
    await this.scheduler.authorize(grant, source, input)
    this.authority.assertGrant(grant)
    if (!this.repository.read().sources.some((entry) => sameGrant(entry.workspace, grant) && equal(entry.source, source))) throw new JiraWorkspaceError('E_CONFLICT', 'Selected source changed during native job admission.')
    if (input.kind === 'sync') {
      if (!['active', 'degraded'].includes(this.plan(grant, input.planId, input.planRevision).plan.state)) throw new JiraWorkspaceError('E_CONFLICT', 'Plan closed admission before the job was committed.')
      if (this.ledger.jobs(grant.workspaceId).some((job) => job.input.kind === 'sync' && job.input.planId === input.planId && [...busyStates, 'paused'].includes(job.state))) throw new JiraWorkspaceError('E_BUSY', 'The plan already owns a retained active/paused/unknown job.')
    }
    return this.ledger.enqueue(request, { source, input }, grant)
  }
  async catchUp(input: JiraRequest<'catchUp'>): Promise<JiraData<'catchUp'>> {
    const grant = await this.capture(input); const plan = this.plan(grant, input.planId, input.revision)
    if (!['active', 'degraded'].includes(plan.plan.state)) throw new JiraWorkspaceError('E_DENIED', 'Enable the sync plan before catch-up.')
    if (this.ledger.jobs(grant.workspaceId).some((job) => job.input.kind === 'sync' && job.input.planId === plan.plan.id && busyStates.includes(job.state) && job.commandId !== input.commandId)) throw new JiraWorkspaceError('E_BUSY', 'This plan already has a retained active or unknown job.')
    await this.source(grant, plan.plan.source)
    return this.enqueue(grant, plan.plan.source, { kind: 'sync', planId: plan.plan.id, planRevision: plan.plan.revision }, input.commandId)
  }
  async previewApi(input: JiraRequest<'previewApi'>, signal?: AbortSignal): Promise<JiraData<'previewApi'>> { const grant = await this.capture(input); await this.source(grant, input.source); return this.previews.api(grant, input, signal) }
  async previewCsv(input: JiraRequest<'previewCsv'>, signal?: AbortSignal): Promise<JiraData<'previewCsv'>> { const grant = await this.capture(input); await this.source(grant, input.source); return this.previews.csv(grant, input, signal) }
  async startImport(input: JiraRequest<'startImport'>): Promise<JiraData<'startImport'>> {
    const grant = await this.capture(input); const material = this.repository.preview(input.previewId)
    if (!sameGrant(material.workspace, grant) || material.preview.digest !== input.digest) throw new JiraWorkspaceError('E_CONFLICT', 'Preview owner or exact content changed.')
    const prior = this.ledger.receipt(input.commandId, grant.workspaceId)
    if (!prior && material.preview.expiresAt < Date.now()) throw new JiraWorkspaceError('E_CONFLICT', 'Preview expired. Review a new preview before creating another job.')
    if (!material.preview.complete && !input.acceptPartial) throw new JiraWorkspaceError('E_INVALID_ARG', 'Acknowledge sampled preview coverage before importing the full query.')
    await this.source(grant, material.preview.source)
    return this.enqueue(grant, material.preview.source, { kind: 'import', previewId: material.preview.id, previewDigest: material.preview.digest, format: material.preview.format }, input.commandId)
  }
  async history(input: JiraRequest<'history'>): Promise<JiraData<'history'>> {
    const grant = await this.capture(input); const jobs = this.ledger.jobs(grant.workspaceId).filter((job) => job.source.providerId === 'jira').sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    const start = input.after ? jobs.findIndex((job) => job.id === input.after) + 1 : 0
    if (input.after && !start) throw new JiraWorkspaceError('E_CONFLICT', 'History cursor is no longer available in this workspace.')
    const items = jobs.slice(start, start + input.limit)
    const evidence = this.repository.read().receipts
    const rollbacks = items.map((job) => ({ jobId: job.id, removed: evidence.filter((entry) => entry.receipt.jobId === job.id && entry.receipt.state === 'rolled-back').length, blocked: evidence.filter((entry) => entry.receipt.jobId === job.id && entry.receipt.state === 'rollback-blocked').length })).filter((summary) => summary.removed || summary.blocked)
    return { items, rollbacks, next: start + items.length < jobs.length ? items.at(-1)?.id ?? null : null }
  }
  async jobDetail(input: JiraRequest<'jobDetail'>): Promise<JiraData<'jobDetail'>> {
    const grant = await this.capture(input); const job = this.ledger.job(input.jobId, grant.workspaceId)
    if (!job || job.source.providerId !== 'jira') throw new JiraWorkspaceError('E_DENIED', 'This Jira job is unavailable in the requested workspace.')
    const entries = this.repository.read().receipts.filter((entry) => entry.receipt.jobId === job.id && sameGrant(entry.workspace, grant)).map((entry) => entry.receipt)
    const start = input.after ? entries.findIndex((entry) => entry.id === input.after) + 1 : 0
    if (input.after && !start) throw new JiraWorkspaceError('E_CONFLICT', 'Item cursor belongs to another retained history page.')
    const items = entries.slice(start, start + input.limit)
    return { items, next: start + items.length < entries.length ? items.at(-1)?.id ?? null : null }
  }
  async cancel(input: JiraRequest<'cancel'>): Promise<JiraData<'cancel'>> {
    const grant = await this.capture(input); const job = this.job(grant, input)
    const result = this.ledger.cancel(this.request(grant, 'jobs.cancel', { id: job.id, revision: job.revision }, input.commandId), job.id, job.revision, grant)
    this.scheduler.cancel(job.id); return result
  }
  async resume(input: JiraRequest<'resume'>): Promise<JiraData<'resume'>> {
    const grant = await this.capture(input); const job = this.job(grant, input)
    if (job.state !== 'paused' || this.repository.read().receipts.some((entry) => entry.receipt.jobId === job.id && ['intent', 'unknown'].includes(entry.receipt.state))) throw new JiraWorkspaceError('E_CONFLICT', 'Only a paused job with fully settled effects can resume.')
    await this.source(grant, job.source)
    if (job.input.kind === 'sync' && this.plan(grant, job.input.planId, job.input.planRevision).plan.state === 'paused') throw new JiraWorkspaceError('E_DENIED', 'Enable the plan before resuming this job.')
    return this.ledger.transition(job.id, job.revision, job.ownerEpoch, 'queued', `jira-resume:${input.commandId}`)
  }
  async reconcile(input: JiraRequest<'reconcile'>): Promise<JiraData<'reconcile'>> {
    const grant = await this.capture(input); const job = this.job(grant, input)
    if (job.state !== 'unknown') throw new JiraWorkspaceError('E_CONFLICT', 'Only an unknown job needs effect reconciliation.')
    const result = await this.worker.reconcile({ job, workspace: grant, connection: (await this.source(grant, job.source)).connection })
    if (result.resolved) this.ledger.transition(job.id, job.revision, job.ownerEpoch, 'partially-failed', result.evidenceRef ?? `jira-reconciled:${job.id}`)
    return result
  }
  async rollback(input: JiraRequest<'rollback'>): Promise<JiraData<'rollback'>> {
    const grant = await this.capture(input); const job = this.job(grant, input)
    if (!['completed', 'partially-failed', 'cancelled', 'rollback-blocked'].includes(job.state) || job.input.kind !== 'import') throw new JiraWorkspaceError('E_DENIED', 'Only a settled import can roll back exact unchanged local creations.')
    const entries = this.repository.read().receipts.filter((entry) => entry.receipt.jobId === job.id && entry.receipt.effect === 'local-create')
    let removed = 0; let blocked = 0
    for (const entry of entries) {
      if (entry.receipt.state === 'rolled-back') { removed++; continue }
      if (!sameGrant(entry.workspace, grant) || !entry.receipt.created || !entry.after || !entry.ownedTree || entry.after.treeHash !== entry.ownedTree || ['intent', 'unknown'].includes(entry.receipt.state)) { blocked++; continue }
      if (entry.rollbackCommandId && entry.rollbackCommandId !== input.commandId) { blocked++; continue }
      this.worker.settle(entry.receipt.id, entry.receipt.state, 'Original rollback command retained before local artifact removal.', { rollbackCommandId: input.commandId })
      try {
        const quarantine = this.worker.tasks.rollback(grant, entry.after, job.id, entry.receipt.id)
        this.worker.settle(entry.receipt.id, 'rolled-back', 'Unchanged exact-job creation removed from active tasks; provenance retained in quarantine.', { quarantine }); removed++
      } catch (error) { this.worker.settle(entry.receipt.id, 'rollback-blocked', error instanceof JiraWorkspaceError ? error.message : 'Rollback did not confirm artifact removal. Inspect the original quarantine receipt.'); blocked++ }
    }
    if (blocked && job.state !== 'rollback-blocked') this.ledger.transition(job.id, job.revision, job.ownerEpoch, 'rollback-blocked', `jira-rollback:${input.commandId}`)
    this.worker.diagnostic(grant.workspaceId, blocked ? 'conflict' : 'partial', `Rollback removed ${removed} unchanged exact-job creations; ${blocked} creations were protected. Preexisting tasks and all remote issues were preserved.`)
    return { removed, blocked, evidenceRef: `jira-rollback:${input.commandId}` }
  }
  async resolveConflict(input: JiraRequest<'resolveConflict'>): Promise<JiraData<'resolveConflict'>> {
    const grant = await this.capture(input)
    const entry = this.repository.read().conflicts.find((entry) => entry.workspaceId === grant.workspaceId && entry.value.id === input.conflictId && entry.value.revision === input.revision && !entry.value.resolved)
    if (!entry) throw new JiraWorkspaceError('E_CONFLICT', 'Conflict revision is stale or already resolved.')
    const planEntry = this.repository.read().plans.find((item) => item.value.plan.id === entry.value.planId && sameGrant(item.workspace, grant))
    if (!planEntry) throw new JiraWorkspaceError('E_CONFLICT', 'Original conflict policy is unavailable.')
    const plan = planEntry.value; const issue = await (await this.source(grant, plan.plan.source)).issue(entry.value.issueId)
    const local = this.worker.tasks.read(grant, entry.value.taskRef); const field = entry.value.field
    if (!equal(local.fields[field], entry.value.local) || !equal(issue.fields[field], entry.value.remote)) throw new JiraWorkspaceError('E_CONFLICT', 'Local or remote value changed after this conflict was displayed.')
    if (input.choice === 'local' && (!plan.remoteWritesApproved || !plan.rules.outboundUpdate)) throw new JiraWorkspaceError('E_DENIED', 'Choosing local requires explicitly enabled remote updates.')
    // Resolution selects a base, not an immediate untracked write. The next durable catch-up performs the chosen direction.
    return this.repository.change((state) => {
      const conflict = state.conflicts.find((item) => item.value.id === entry.value.id && item.value.revision === input.revision && !item.value.resolved)
      if (!conflict) throw new JiraWorkspaceError('E_CONFLICT', 'Conflict changed during resolution.')
      conflict.value.resolution = input.choice; conflict.value.applied = false; conflict.value.resolved = true; conflict.value.revision++
      return conflict.value
    })
  }
  async localTasks(input: JiraRequest<'localTasks'>): Promise<JiraData<'localTasks'>> { return this.worker.tasks.list(await this.capture(input)).map((task) => ({ taskRef: task.taskRef, title: task.fields.title })) }
  async receiver(input: JiraRequest<'receiver'>): Promise<JiraData<'receiver'>> {
    const grant = await this.capture(input); const plan = this.plan(grant, input.planId, input.revision)
    if (!this.callbacks || !plan.receiverId) throw new JiraWorkspaceError('E_UNAVAILABLE', 'No native verified callback receiver is installed for this Jira plan.')
    await this.source(grant, plan.plan.source)
    if (input.recover) { const result = await this.callbacks.recover(grant, { receiverId: plan.receiverId, source: plan.plan.source, commandId: input.commandId }); this.worker.diagnostic(grant.workspaceId, 'transport', result.detail) }
    return this.callbacks.inspect(grant, { receiverId: plan.receiverId, source: plan.plan.source })
  }
  /** Called by the existing daemon host tick; no second timer or scheduler is created. */
  async pollDue(run: (grant: WorkspaceGrant, action: () => Promise<unknown>) => Promise<unknown>): Promise<void> {
    for (const entry of this.repository.read().plans.filter((entry) => ['active', 'degraded'].includes(entry.value.plan.state) && (entry.value.nextPollAt ?? Infinity) <= Date.now())) {
      const plan = entry.value
      if (this.ledger.jobs(entry.workspace.workspaceId).some((job) => job.input.kind === 'sync' && job.input.planId === plan.plan.id && ['queued', 'dispatched', 'running', 'paused', 'cancel-requested', 'unknown'].includes(job.state))) continue
      try { await run(entry.workspace, () => this.catchUp({ expectedRoot: entry.workspace.root, workspaceId: entry.workspace.workspaceId, planId: plan.plan.id, revision: plan.plan.revision, commandId: randomUUID() })) }
      catch { this.repository.change((state) => { const retained = state.plans.find((item) => item.value.plan.id === plan.plan.id); if (retained) { retained.value.failures = Math.min(20, retained.value.failures + 1); retained.value.nextPollAt = Date.now() + Math.min(60 * 60_000, JIRA_LIMITS.pollMs * 2 ** retained.value.failures); retained.value.detail = 'Scheduled admission failed. Verify the retained source/permission/daemon owner.' } }) }
    }
  }
  async admitCallback(input: { receiverId: string; headers: Readonly<Record<string, string>>; body: Uint8Array }): Promise<IntegrationJob> {
    if (!this.callbacks || input.body.byteLength > 256 * 1024) throw new JiraWorkspaceError('E_DENIED', 'Callback port is unavailable or payload exceeds the receiver bound.')
    const event = await this.callbacks.verify(input)
    jiraNumericIdSchema.parse(event.issueId)
    const entry = this.repository.read().plans.find((entry) => entry.value.receiverId === input.receiverId && entry.value.plan.transport === 'webhook' && equal(entry.value.plan.source, event.source))
    if (!entry || !event.eventId || event.eventId.length > 256 || !/^[a-f0-9-]{36}$/.test(event.commandId) || !Number.isSafeInteger(event.verifiedAt) || Math.abs(Date.now() - event.verifiedAt) > 5 * 60_000) throw new JiraWorkspaceError('E_DENIED', 'Callback does not match a verified active source/receiver.')
    // Receiver supplies the stable durable event command UUID; replay returns the same common-ledger job.
    return this.catchUp({ expectedRoot: entry.workspace.root, workspaceId: entry.workspace.workspaceId, planId: entry.value.plan.id, revision: entry.value.plan.revision, commandId: event.commandId })
  }
}
