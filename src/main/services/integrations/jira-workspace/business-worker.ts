import { randomUUID } from 'node:crypto'
import type { WorkspaceGrant, DaemonRequest } from '../../../../shared/daemon'
import { cruxTaskActionSchema } from '../../../../shared/crux-schema'
import type { IntegrationJob } from '../../../../shared/integration-work'
import type { DaemonRepository } from '../../../daemon/repository'
import type { IntegrationScheduler } from '../../../daemon/scheduler'
import type { NativeTeamBusinessSender } from '../../crux/task-progress-sender'
import type { IntegrationWorkPort } from '../work-ports'
import { stableUuid } from './business-hooks'
import { JiraWorkspaceRepository, digest } from './repository'
import { sameGrant, JiraWorkspaceError, type JiraWorkspaceAuthority } from './types'
import { JiraRemote } from './lib/remote'
import { prepareTransition, applyTransition } from './lib/writes'

type Entry = ReturnType<JiraWorkspaceRepository['read']>['businessDispatches'][number]
class IneligibleBusinessAction extends Error {}
/** The common daemon ledger owns jobs; retained Jira evidence fences uncertain provider writes. */
export class JiraBusinessWorker implements IntegrationWorkPort {
  constructor(private readonly repository: JiraWorkspaceRepository, private readonly authority: JiraWorkspaceAuthority, private readonly ledger: DaemonRepository, private readonly scheduler: IntegrationScheduler, private readonly sender: () => NativeTeamBusinessSender, private readonly profileId: string) {}
  supports(kind: IntegrationJob['input']['kind']): boolean { return kind === 'notification' }
  private entry(job: IntegrationJob): Entry {
    const entry = this.repository.read().businessDispatches.find(item => item.jobId === job.id)
    const admission = this.ledger.admission(job.id)
    if (!entry || !admission || job.input.kind !== 'notification' || job.input.previewId !== entry.dispatch.effectId || job.input.previewDigest !== entry.dispatch.payloadDigest || job.commandId !== entry.dispatch.providerCommandId || digest(job.source) !== digest(entry.dispatch.route.route.source) || !sameGrant(entry.workspace, admission)) throw new JiraWorkspaceError('E_CONFLICT', 'Original canonical Jira business dispatch/job identity changed.')
    return entry
  }
  private change(effectId: string, update: Partial<Pick<Entry, 'jobId' | 'state' | 'evidenceRef'>>): Entry {
    return this.repository.change(state => { const item = state.businessDispatches.find(e => e.dispatch.effectId === effectId); if (!item) throw new JiraWorkspaceError('E_IO', 'Original Jira dispatch evidence is missing.'); Object.assign(item, update); return item })
  }
  private diagnostic(workspaceId: string, uncertain: boolean): void {
    const detail = uncertain ? 'Original business transition is unknown. Provider writes remain fenced; restore original device/source access and observe the same issue/job.' : 'Business consumption is paused. Restore the original team device, workspace grant and Jira plan/credential; polling resumes the same event/job.'
    this.repository.change(state => {
      const previous = state.diagnostics.filter(item => item.workspaceId === workspaceId).at(-1)
      if (previous?.value.detail === detail && Date.now() - previous.value.at < 60_000) return
      state.diagnostics.push({ workspaceId, value: { code: uncertain ? 'unknown' : 'paused', detail, issueId: null, at: Date.now() } })
      state.diagnostics = state.diagnostics.slice(-1000)
    })
  }
  private async report(entry: Entry, state: 'admitted' | 'unknown' | 'applied' | 'blocked'): Promise<void> {
    if (!entry.jobId) throw new JiraWorkspaceError('E_CONFLICT', 'Jira dispatch has no original admitted job.')
    const d = entry.dispatch
    await this.sender().reportJiraDispatch({ contractVersion: 1, commandId: stableUuid(d.effectId + ':receipt:' + state + ':' + entry.jobId), expectedEpoch: d.epoch, projectId: d.projectId, effectId: d.effectId, payloadDigest: d.payloadDigest, providerCommandId: d.providerCommandId, providerJobId: entry.jobId, state, evidenceRef: entry.evidenceRef })
  }
  private async guard(entry: Entry, signal?: AbortSignal, observe = false): Promise<JiraRemote> {
    this.authority.assertGrant(entry.workspace)
    const d = entry.dispatch, state = this.repository.read()
    const plan = state.plans.find(item => sameGrant(item.workspace, entry.workspace) && item.value.plan.id === d.route.route.planId && item.value.plan.revision === d.route.route.planRevision)?.value
    if (!observe && (!plan || !['active', 'degraded'].includes(plan.plan.state) || !plan.remoteWritesApproved || !plan.rules.outboundUpdate || plan.plan.direction !== 'bidirectional' || plan.platformSpaceId !== d.task.spaceId || digest(plan.plan.source) !== digest(d.route.route.source) || !state.sources.some(item => sameGrant(item.workspace, entry.workspace) && digest(item.source) === digest(d.route.route.source)))) throw new JiraWorkspaceError('E_CONFLICT', 'Original Jira plan/source no longer authorizes this business action.')
    let connection = await this.authority.resolve(entry.workspace, d.route.route.source)
    this.authority.assertGrant(entry.workspace)
    if (!connection.public.enabled || connection.public.id !== d.route.route.source.connectionId || connection.public.revision !== d.route.route.source.connectionRevision || connection.instanceId !== d.issue.instanceId) throw new JiraWorkspaceError('E_CONFLICT', 'Original protected Jira credential was revoked or replaced.')
    const current = await this.sender().readJiraDispatch(d.projectId, d.effectId)
    this.authority.assertGrant(entry.workspace)
    if (current.dispatch.payloadDigest !== d.payloadDigest || current.dispatch.providerCommandId !== d.providerCommandId || current.dispatch.providerJobId !== entry.jobId) throw new JiraWorkspaceError('E_CONFLICT', 'Original Jira business event/job identity changed.')
    if (!observe && (!current.eligible || current.dispatch.state === 'blocked')) throw new IneligibleBusinessAction('Canonical business action has been superseded or its route/mapping was replaced.')
    const account = state.accounts.find(item => sameGrant(item.workspace, entry.workspace) && item.account.connectionId === d.route.route.source.connectionId)
    if (account) {
      if (account.instanceId !== d.issue.instanceId || account.connectionRevision !== connection.public.revision || account.account.state !== 'linked') throw new JiraWorkspaceError('E_CONFLICT', 'Original personal Jira binding was revoked or replaced.')
      const personal = await this.authority.resolvePersonalConnection(entry.workspace, { connectionId: account.personalConnectionId, connectionRevision: account.personalConnectionRevision })
      if (!personal.public.enabled || personal.public.revision !== account.personalConnectionRevision || new URL(personal.public.config.baseUrl).href.replace(/\/+$/, '') !== new URL(connection.public.config.baseUrl).href.replace(/\/+$/, '')) throw new JiraWorkspaceError('E_CONFLICT', 'Original personal Jira credential changed.')
      connection = { ...personal, instanceId: d.issue.instanceId }
    }
    this.authority.assertGrant(entry.workspace)
    if (signal?.aborted) throw new JiraWorkspaceError('E_CONFLICT', 'Cancelled Jira job cannot admit another provider transition.')
    return new JiraRemote(connection, signal)
  }
  async pollDue(run: (grant: WorkspaceGrant, action: () => Promise<unknown>) => Promise<unknown>): Promise<void> {
    for (const original of this.repository.read().plans) {
      const spaceId = original.value.platformSpaceId
      if (!spaceId) continue
      try { await run(original.workspace, async () => {
        const native = this.sender(), snapshot = await native.snapshot(), plan = original.value
        const statuses = Object.entries(plan.mapping.statuses).filter(([remoteStatusId, statusId]) => /^[1-9]\d{0,14}$/.test(remoteStatusId) && !!plan.mapping.transitions[statusId]).map(([remoteStatusId, statusId]) => ({ remoteStatusId, statusId, transitionId: plan.mapping.transitions[statusId] }))
        if (new Set(statuses.map(s => s.statusId)).size !== statuses.length) throw new JiraWorkspaceError('E_CONFLICT', 'Several Jira statuses map to one platform target; explicit canonical routing is ambiguous.')
        const route = { routeId: stableUuid(snapshot.instanceId + ':' + snapshot.projectId + ':' + this.profileId + ':' + original.workspace.workspaceId + ':' + plan.plan.id), projectId: snapshot.projectId, spaceId, source: plan.plan.source, target: plan.plan.target, planId: plan.plan.id, planRevision: plan.plan.revision, active: ['active', 'degraded'].includes(plan.plan.state) && plan.remoteWritesApproved && plan.rules.outboundUpdate && plan.plan.direction === 'bidirectional', actions: cruxTaskActionSchema.options.filter(action => action !== 'reassign'), statuses }
        if (route.target.profileId !== this.profileId || route.target.workspaceId !== original.workspace.workspaceId) throw new JiraWorkspaceError('E_CONFLICT', 'Jira business route belongs to another protected native owner.')
        await native.configureJiraRoute({ contractVersion: 1, commandId: stableUuid(digest({ route, controlRevision: plan.controlRevision, epoch: snapshot.epoch })), expectedEpoch: snapshot.epoch, route })
        const pending = await native.pendingJiraDispatches(snapshot.projectId, route.routeId)
        // An applied receipt can commit while its reply is lost; the server then
        // omits it from pending, but the original ledger job still needs settlement.
        for (const retained of this.repository.read().businessDispatches) {
          if (retained.dispatch.route.route.routeId !== route.routeId || !sameGrant(retained.workspace, original.workspace) || !retained.jobId || this.ledger.job(retained.jobId, original.workspace.workspaceId)?.state !== 'unknown' || pending.some(item => item.dispatch.effectId === retained.dispatch.effectId)) continue
          pending.push(await native.readJiraDispatch(snapshot.projectId, retained.dispatch.effectId))
        }
        for (const { dispatch, eligible } of pending) {
          try {
            let entry = this.repository.read().businessDispatches.find(item => item.dispatch.effectId === dispatch.effectId)
            if (!entry) entry = this.repository.change(state => { const item: Entry = { dispatch, workspace: original.workspace, jobId: null, state: 'ready', evidenceRef: null }; state.businessDispatches.push(item); return item })
            if (entry.dispatch.payloadDigest !== dispatch.payloadDigest || !sameGrant(entry.workspace, original.workspace)) throw new JiraWorkspaceError('E_CONFLICT', 'Original Jira dispatch was replaced.')
            if (!entry.jobId) {
              const input = { kind: 'notification' as const, previewId: dispatch.effectId, previewDigest: dispatch.payloadDigest }, source = dispatch.route.route.source
              const request: DaemonRequest = { type: 'request', version: 1, requestId: randomUUID(), expectedEpoch: this.ledger.epoch, workspace: original.workspace, method: 'jobs.enqueue', payload: { source, input }, commandId: dispatch.providerCommandId }
              const prior = this.ledger.receipt(dispatch.providerCommandId, original.workspace.workspaceId)
              let job = prior?.jobId ? this.ledger.job(prior.jobId, original.workspace.workspaceId) : null
              if (!job) { await this.scheduler.authorize(original.workspace, source, input); this.authority.assertGrant(original.workspace); job = this.ledger.enqueue(request, { source, input }, original.workspace) }
              entry = this.change(dispatch.effectId, { jobId: job.id })
            }
            if (!entry.jobId) throw new JiraWorkspaceError('E_CONFLICT', 'Original Jira job admission is missing.')
            const job = this.ledger.job(entry.jobId, entry.workspace.workspaceId)
            if (!job) throw new JiraWorkspaceError('E_CONFLICT', 'Original Jira ledger job is missing.')
            if (entry.state === 'ready' && !eligible) entry = this.change(dispatch.effectId, { state: 'blocked', evidenceRef: 'jira-business:' + dispatch.effectId })
            if (entry.state === 'ready') {
              await this.report(entry, 'admitted')
              if (job.state === 'paused') { await this.guard(entry); this.ledger.transition(job.id, job.revision, job.ownerEpoch, 'queued', entry.evidenceRef) }
            } else if (job.state === 'unknown' || entry.state === 'applied' || entry.state === 'blocked') {
              const result = await this.reconcile({ job, workspace: entry.workspace, connection: await this.authority.resolve(entry.workspace, job.source) })
              const latest = this.ledger.job(job.id, job.workspaceId)
              if (result.resolved && latest?.state === 'unknown') this.ledger.transition(job.id, latest.revision, latest.ownerEpoch, entry.state === 'blocked' ? 'partially-failed' : 'completed', result.evidenceRef, { cursor: latest.cursor, counts: { processed: Math.max(1, latest.counts.processed), failed: entry.state === 'blocked' ? Math.max(1, latest.counts.failed) : latest.counts.failed, total: latest.counts.total ?? 1 } })
              else if (result.resolved && entry.state === 'blocked' && latest && ['queued', 'paused'].includes(latest.state)) this.ledger.transition(job.id, latest.revision, latest.ownerEpoch, 'cancelled', result.evidenceRef)
            }
          } catch { this.diagnostic(original.workspace.workspaceId, dispatch.state === 'unknown') }
        }
      }) } catch { this.diagnostic(original.workspace.workspaceId, false) }
    }
  }
  async dispatch(input: Parameters<IntegrationWorkPort['dispatch']>[0]): ReturnType<IntegrationWorkPort['dispatch']> {
    let entry = this.entry(input.job)
    const counts = { processed: Math.max(1, input.job.counts.processed), failed: input.job.counts.failed, total: input.job.counts.total ?? 1 }, evidenceRef = 'jira-business:' + entry.dispatch.effectId
    try {
      if (entry.state === 'blocked') { await this.report(entry, 'blocked'); return { state: 'partially-failed', evidenceRef, cursor: null, counts: { ...counts, failed: 1 } } }
      if (entry.state === 'applied') { await this.report(entry, 'applied'); return { state: 'completed', evidenceRef, cursor: null, counts } }
      const observe = entry.state === 'intent' || entry.state === 'unknown'
      if (!observe) await this.report(entry, 'admitted')
      let remote = await this.guard(entry, input.signal, observe)
      let issue = await remote.issue(entry.dispatch.issue.issueId)
      if (issue.instanceId !== entry.dispatch.issue.instanceId || issue.projectId !== entry.dispatch.issue.remoteProjectId || issue.issueId !== entry.dispatch.issue.issueId) throw new JiraWorkspaceError('E_CONFLICT', 'Provider returned another canonical Jira issue.')
      if (observe) {
        if (issue.fields.status !== entry.dispatch.target.remoteStatusId) { entry = this.change(entry.dispatch.effectId, { state: 'unknown', evidenceRef }); await this.report(entry, 'unknown'); return { state: 'unknown', evidenceRef, cursor: null, counts: input.job.counts } }
      } else if (issue.fields.status !== entry.dispatch.target.remoteStatusId) {
        const targetName = await prepareTransition(remote, issue.projectId, issue.issueId, entry.dispatch.target.transitionId, entry.dispatch.target.remoteStatusId)
        remote = await this.guard(entry, input.signal)
        entry = this.change(entry.dispatch.effectId, { state: 'intent', evidenceRef })
        await applyTransition(remote, issue.issueId, entry.dispatch.target.transitionId, targetName)
        issue = await remote.issue(issue.issueId)
        if (issue.fields.status !== entry.dispatch.target.remoteStatusId) throw new JiraWorkspaceError('E_UNKNOWN', 'Original Jira transition has no confirmed target status.')
      }
      entry = this.change(entry.dispatch.effectId, { state: 'applied', evidenceRef })
      await this.report(entry, 'applied')
      return { state: 'completed', evidenceRef, cursor: null, counts }
    } catch (error) {
      const uncertain = entry.state === 'intent' || entry.state === 'unknown' || entry.state === 'applied'
      if (error instanceof IneligibleBusinessAction && !uncertain) {
        entry = this.change(entry.dispatch.effectId, { state: 'blocked', evidenceRef })
        try { await this.report(entry, 'blocked') } catch { this.diagnostic(entry.workspace.workspaceId, false) }
        return { state: 'partially-failed', evidenceRef, cursor: null, counts: { ...counts, failed: 1 } }
      }
      if (uncertain && entry.state !== 'applied') {
        entry = this.change(entry.dispatch.effectId, { state: 'unknown', evidenceRef })
        try { await this.report(entry, 'unknown') } catch { /* Same-identity evidence remains durable locally. */ }
      }
      this.diagnostic(entry.workspace.workspaceId, uncertain)
      return { state: uncertain ? 'unknown' : 'paused', evidenceRef: uncertain ? evidenceRef : null, cursor: null, counts: input.job.counts }
    }
  }
  async reconcile(input: Parameters<IntegrationWorkPort['reconcile']>[0]): ReturnType<IntegrationWorkPort['reconcile']> {
    let entry = this.entry(input.job)
    if (entry.state === 'blocked') { await this.report(entry, 'blocked'); return { resolved: true, evidenceRef: entry.evidenceRef } }
    if (entry.state !== 'applied') {
      if (entry.state !== 'intent' && entry.state !== 'unknown') return { resolved: false, evidenceRef: null }
      const remote = await this.guard(entry, undefined, true), issue = await remote.issue(entry.dispatch.issue.issueId)
      if (issue.instanceId !== entry.dispatch.issue.instanceId || issue.projectId !== entry.dispatch.issue.remoteProjectId || issue.issueId !== entry.dispatch.issue.issueId || issue.fields.status !== entry.dispatch.target.remoteStatusId) return { resolved: false, evidenceRef: null }
      entry = this.change(entry.dispatch.effectId, { state: 'applied', evidenceRef: 'jira-business:' + entry.dispatch.effectId })
    }
    await this.report(entry, 'applied')
    return { resolved: true, evidenceRef: entry.evidenceRef }
  }
}
