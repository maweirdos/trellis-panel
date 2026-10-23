import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { WorkspaceGrant } from '../../../../shared/daemon'
import type { IntegrationJob } from '../../../../shared/integration-work'
import { JIRA_LIMITS, type JiraDiagnostic, type JiraFields, type JiraIssueRecord, type JiraMapping, type JiraPlan } from '../../../../shared/jira-integration'
import { JiraV2Error } from '../../jira'
import type { IntegrationWorkPort } from '../work-ports'
import { JiraWorkspaceRepository } from './repository'
import { JiraWorkspaceError, sameGrant, type JiraExecutionReceipt, type JiraLocalSnapshot, type JiraWorkspaceAuthority } from './types'
import type { JiraTaskPort } from './lib/local-tasks'
import { JiraRemote } from './lib/remote'
import { equal, fieldDecision, inboundFields, outboundFields } from './lib/mapping'
import { applyComment, applyCreate, applyTransition, applyUpdate, prepareCreate, prepareTransition, prepareUpdate } from './lib/writes'

type Dispatch = Parameters<IntegrationWorkPort['dispatch']>[0]
type Result = Awaited<ReturnType<IntegrationWorkPort['dispatch']>>
type Context = Dispatch & { remote: JiraRemote }
const cursorSchema = z.object({ afterId: z.string().regex(/^[1-9]\d{0,14}$/).nullable(), csvIndex: z.number().int().nonnegative().max(500), phase: z.enum(['issues', 'outbound']), outboundIndex: z.number().int().nonnegative().max(100) }).strict()
export class JiraWorkspaceWorker implements IntegrationWorkPort {
  constructor(readonly repository: JiraWorkspaceRepository, private readonly authority: JiraWorkspaceAuthority, readonly tasks: JiraTaskPort) {}
  supports(kind: IntegrationJob['input']['kind']): boolean { return kind === 'import' || kind === 'sync' }
  private evidence(job: IntegrationJob): string { return `jira-job:${job.id}` }
  diagnostic(workspaceId: string, code: JiraDiagnostic['code'], detail: string, issueId: string | null = null): void {
    this.repository.change((state) => { state.diagnostics.push({ workspaceId, value: { code, detail: detail.slice(0, 400), issueId, at: Date.now() } }); state.diagnostics = state.diagnostics.slice(-1000) })
  }
  private async guard(context: Context): Promise<void> {
    this.authority.assertGrant(context.workspace)
    if (!this.repository.read().sources.some((entry) => sameGrant(entry.workspace, context.workspace) && equal(entry.source, context.job.source))) throw new JiraWorkspaceError('E_CONFLICT', 'Original selected Jira source no longer matches the retained job.')
    const connection = await this.authority.resolve(context.workspace, context.job.source)
    if (connection.instanceId !== context.job.source.instanceId || connection.public.id !== context.job.source.connectionId || connection.public.revision !== context.job.source.connectionRevision) throw new JiraWorkspaceError('E_CONFLICT', 'Original Jira connection/source revision no longer authorizes this operation.')
    if (context.job.input.kind === 'sync' && !['active', 'degraded'].includes(this.plan(context.job, context.workspace).plan.state)) throw new JiraWorkspaceError('E_CONFLICT', 'Original Jira plan has closed admission of new effects.')
    this.authority.assertGrant(context.workspace)
    if (context.signal.aborted) throw new JiraWorkspaceError('E_CONFLICT', 'Cancellation closes admission of the next Jira effect.')
  }
  private async writer(context: Context): Promise<JiraRemote> {
    const account = this.repository.read().accounts.find((entry) => sameGrant(entry.workspace, context.workspace) && entry.account.connectionId === context.job.source.connectionId)
    if (!account) return context.remote
    if (account.instanceId !== context.job.source.instanceId || account.connectionRevision !== context.job.source.connectionRevision || account.account.state !== 'linked') throw new JiraWorkspaceError('E_CONFLICT', 'Personal Jira binding no longer matches the retained instance credential revision.')
    const personal = await this.authority.resolvePersonalConnection(context.workspace, { connectionId: account.personalConnectionId, connectionRevision: account.personalConnectionRevision })
    if (personal.public.revision !== account.personalConnectionRevision || new URL(personal.public.config.baseUrl).href.replace(/\/+$/, '') !== new URL(context.remote.cfg.baseUrl).href.replace(/\/+$/, '')) throw new JiraWorkspaceError('E_CONFLICT', 'Personal credential source changed before remote write.')
    // Source identity remains the original integration instance, independent of acting credentials.
    return new JiraRemote({ ...personal, instanceId: context.job.source.instanceId }, context.signal)
  }
  private plan(job: IntegrationJob, grant: WorkspaceGrant): JiraPlan {
    const input = job.input
    const entry = input.kind === 'sync' ? this.repository.read().plans.find((entry) => entry.value.plan.id === input.planId) : null
    if (!entry || !sameGrant(entry.workspace, grant) || input.kind !== 'sync' || entry.value.plan.revision !== input.planRevision || !equal(entry.value.plan.source, job.source)) throw new JiraWorkspaceError('E_CONFLICT', 'Original sync policy revision or workspace grant changed.')
    return entry.value
  }
  intent(context: Context, identity: string, effect: JiraExecutionReceipt['receipt']['effect'], issue: JiraIssueRecord | null, before: JiraLocalSnapshot | null, expectedRemote: Partial<JiraFields> | null = null, expectedLocal: Partial<JiraFields> | null = null): JiraExecutionReceipt {
    const entry: JiraExecutionReceipt = { receipt: { id: randomUUID(), jobId: context.job.id, identity, issueId: issue?.issueId ?? null, key: issue?.key ?? '', taskRef: before?.taskRef ?? null, operationId: before?.operationId ?? null, effect, state: 'intent', created: false, detail: 'Durable provider intent committed before effect.', at: Date.now() }, workspace: context.workspace, source: context.job.source, before, after: null, expectedRemote, expectedLocal, issue, ownedTree: null, rollbackCommandId: null, quarantine: null }
    return this.repository.change((state) => { state.receipts.push(entry); return entry })
  }
  settle(id: string, state: JiraExecutionReceipt['receipt']['state'], detail: string, patch: Partial<Pick<JiraExecutionReceipt, 'after' | 'expectedRemote' | 'issue' | 'ownedTree' | 'quarantine' | 'rollbackCommandId'>> = {}, created?: boolean): void {
    this.repository.change((repository) => {
      const entry = repository.receipts.find((entry) => entry.receipt.id === id)
      if (!entry) throw new JiraWorkspaceError('E_IO', 'Original provider receipt was lost.')
      Object.assign(entry, patch)
      entry.receipt = { ...entry.receipt, state, detail: detail.slice(0, 400), at: Date.now(), taskRef: patch.after?.taskRef ?? entry.receipt.taskRef, operationId: patch.after?.operationId ?? entry.receipt.operationId, issueId: patch.issue?.issueId ?? entry.receipt.issueId, key: patch.issue?.key ?? entry.receipt.key, created: created ?? entry.receipt.created }
    })
  }
  private async effect<T>(context: Context, receipt: JiraExecutionReceipt, operation: () => Promise<T>, confirm: (result: T) => void): Promise<T> {
    let started = false
    try { await this.guard(context); if (receipt.receipt.effect.startsWith('remote-')) await this.writer(context); started = true; const result = await operation(); confirm(result); return result }
    catch (error) {
      const uncertain = started && (error instanceof JiraV2Error ? error.uncertain : !(error instanceof JiraWorkspaceError) || ['E_UNKNOWN', 'E_IO'].includes(error.code))
      this.settle(receipt.receipt.id, uncertain ? 'unknown' : error instanceof JiraWorkspaceError && error.code === 'E_CONFLICT' ? 'conflict' : 'failed', uncertain ? 'Effect may have occurred; reconcile the retained original owner before continuing.' : error instanceof JiraWorkspaceError ? error.message : 'Jira rejected the operation. No automatic write retry was made.')
      if (uncertain) throw new JiraWorkspaceError('E_UNKNOWN', 'Jira effect requires evidence-based reconciliation.')
      throw error
    }
  }
  private base(plan: JiraPlan, issue: JiraIssueRecord, local: JiraLocalSnapshot, adopted?: Array<keyof JiraFields>): void {
    this.repository.change((state) => {
      const existing = state.baselines.find((entry) => entry.planId === plan.plan.id && entry.issueId === issue.issueId && entry.taskRef === local.taskRef)
      const value = { planId: plan.plan.id, instanceId: issue.instanceId, issueId: issue.issueId, key: issue.key, taskRef: local.taskRef, local: local.fields, remote: issue.fields, remoteUpdatedAt: issue.updatedAt, revision: (existing?.revision ?? 0) + 1 }
      if (existing && adopted) {
        value.local = { ...existing.local }; value.remote = { ...existing.remote }
        for (const field of adopted) { Object.assign(value.local, { [field]: local.fields[field] }); Object.assign(value.remote, { [field]: issue.fields[field] }) }
      }
      if (existing) Object.assign(existing, value); else state.baselines.push(value)
    })
  }
  private conflict(context: Context, plan: JiraPlan, local: JiraLocalSnapshot, issue: JiraIssueRecord, field: keyof JiraFields, base: unknown): void {
    this.repository.change((state) => {
      if (state.conflicts.some((item) => !item.value.resolved && item.value.planId === plan.plan.id && item.value.issueId === issue.issueId && item.value.taskRef === local.taskRef && item.value.field === field)) return
      state.conflicts.push({ workspaceId: context.workspace.workspaceId, value: { id: randomUUID(), planId: plan.plan.id, instanceId: issue.instanceId, issueId: issue.issueId, taskRef: local.taskRef, field, base, local: local.fields[field], remote: issue.fields[field], revision: 1, resolved: false, resolution: null, applied: false } })
    })
  }
  private async inbound(context: Context, issue: JiraIssueRecord, mapping: JiraMapping, plan: JiraPlan | null): Promise<void> {
    if (issue.instanceId !== context.job.source.instanceId || issue.projectId !== context.job.source.remoteProjectId) throw new JiraWorkspaceError('E_CONFLICT', 'Issue does not belong to the captured Jira instance/project.')
    const identity = `${issue.instanceId}#${issue.issueId}`
    const mapped = inboundFields(issue.fields, mapping)
    if (mapping.fields.includes('description') && issue.coverage.warnings.some((warning) => warning.startsWith('Description'))) throw new JiraWorkspaceError('E_CONFLICT', 'Description is partial or unsupported. Remove this field mapping or review the full source before applying it.')
    if (mapping.fields.includes('comments') && !issue.coverage.commentsComplete) throw new JiraWorkspaceError('E_CONFLICT', 'Comment coverage is partial; existing local comments will not be replaced with a truncated list.')
    let local = this.tasks.find(context.workspace, issue)
    if (!local) {
      if (plan && !plan.rules.inboundCreate) { const skipped = this.intent(context, identity, 'local-create', issue, null); this.settle(skipped.receipt.id, 'skipped', 'Inbound creation is disabled by this plan.'); return }
      const receipt = this.intent(context, identity, 'local-create', issue, null)
      const result = await this.effect(context, receipt, () => this.tasks.create(context.workspace, issue, mapping), (result) => this.settle(receipt.receipt.id, 'applied', result.created ? 'Created through the existing Jira intake.' : 'Existing task opened through numeric source deduplication.', { after: result.snapshot, issue, ownedTree: result.created ? result.snapshot.treeHash : null }, result.created))
      local = result.snapshot
      if (result.created) {
        const before = local; const changed = this.intent(context, identity, 'local-update', issue, before, null, mapped)
        const after = await this.effect(context, changed, async () => this.tasks.patch(context.workspace, before, mapped, issue), (after) => this.settle(changed.receipt.id, 'applied', 'Mapped fields and source evidence retained; authored PRD preserved.', { after }))
        // Creation ownership includes this job's own initial mapped metadata publication.
        this.settle(receipt.receipt.id, 'applied', 'Created and mapped by this exact import job.', { after, ownedTree: after.treeHash }, true)
        if (plan) this.base(plan, issue, after)
        return
      }
    }
    if (!plan) { const skipped = this.intent(context, identity, 'local-update', issue, local); this.settle(skipped.receipt.id, 'skipped', 'Preexisting local task preserved; one-time import does not overwrite prior work.'); return }
    const base = this.repository.read().baselines.find((entry) => entry.planId === plan.plan.id && entry.instanceId === issue.instanceId && entry.issueId === issue.issueId && entry.taskRef === local.taskRef)
    const inbound: Partial<JiraFields> = {}; const outbound: Partial<JiraFields> = {}; const adopted: Array<keyof JiraFields> = []; let hasConflict = false
    for (const field of mapping.fields) {
      const choice = this.repository.read().conflicts.find((entry) => entry.value.resolved && !entry.value.applied && entry.value.planId === plan.plan.id && entry.value.issueId === issue.issueId && entry.value.taskRef === local.taskRef && entry.value.field === field)?.value
      const chosen = choice && equal(choice.local, local.fields[field]) && equal(choice.remote, issue.fields[field]) ? choice.resolution === 'local' ? 'outbound' : 'inbound' : null
      const decision = chosen ?? (equal(local.fields[field], mapped[field]) ? 'unchanged' : !base ? 'conflict' : fieldDecision(field, local.fields, issue.fields, base))
      if (decision === 'conflict') { this.conflict(context, plan, local, issue, field, base ? { local: base.local[field], remote: base.remote[field] } : null); hasConflict = true; continue }
      if (decision === 'inbound' && plan.rules.inboundUpdate && !equal(local.fields[field], mapped[field])) Object.assign(inbound, { [field]: mapped[field] })
      if (decision === 'outbound' && plan.rules.outboundUpdate) Object.assign(outbound, { [field]: outboundFields(local.fields, mapping)[field] })
      if (decision === 'unchanged' || decision === 'outbound' && plan.rules.outboundUpdate || decision === 'inbound' && plan.rules.inboundUpdate) adopted.push(field)
    }
    if (hasConflict) throw new JiraWorkspaceError('E_CONFLICT', 'Mapped fields have concurrent edits or no adopted baseline. Choose the local or remote value in diagnostics.')
    if (Object.keys(outbound).length) {
      if (!plan.remoteWritesApproved || plan.plan.direction !== 'bidirectional') throw new JiraWorkspaceError('E_DENIED', 'Remote update is not explicitly authorized by this plan.')
      issue = await this.writeMapped(context, identity, local, issue, outbound, plan)
      local = this.tasks.read(context.workspace, local.taskRef)
    }
    const keyChanged = Boolean(base && base.key !== issue.key)
    if (Object.keys(inbound).length || keyChanged) {
      const before = local; const receipt = this.intent(context, identity, 'local-update', issue, before, null, inbound)
      local = await this.effect(context, receipt, async () => this.tasks.patch(context.workspace, before, inbound, issue), (after) => this.settle(receipt.receipt.id, 'applied', 'Only explicitly mapped inbound fields updated; PRD and lifecycle preserved.', { after }))
    }
    if (!Object.keys(inbound).length && !Object.keys(outbound).length && !keyChanged) { const receipt = this.intent(context, identity, 'local-update', issue, local); this.settle(receipt.receipt.id, 'skipped', 'No authorized mapped field changed.') }
    // Disabled direction must not advance its base past an unapplied edit.
    this.base(plan, issue, local, adopted)
    this.repository.change((state) => { for (const entry of state.conflicts) if (entry.value.planId === plan.plan.id && entry.value.issueId === issue.issueId && entry.value.taskRef === local.taskRef && entry.value.resolved && adopted.includes(entry.value.field)) entry.value.applied = true })
  }
  private async writeMapped(context: Context, identity: string, local: JiraLocalSnapshot, original: JiraIssueRecord, desired: Partial<JiraFields>, plan: JiraPlan): Promise<JiraIssueRecord> {
    const writer = await this.writer(context)
    let issue = original
    const edits = { ...desired }; delete edits.status; delete edits.comments
    if (Object.keys(edits).length) {
      const fields = await prepareUpdate(writer, issue.projectId, issue.issueId, edits)
      const current = await context.remote.issue(issue.issueId)
      if (!equal(current.fields, issue.fields) || this.tasks.read(context.workspace, local.taskRef).hash !== local.hash) throw new JiraWorkspaceError('E_CONFLICT', 'Local or Jira fields changed during write preparation.')
      const expected = { ...issue.fields, ...edits }; const receipt = this.intent(context, identity, 'remote-update', issue, local, edits)
      await this.effect(context, receipt, async () => {
        await applyUpdate(writer, issue.issueId, fields)
        const observed = await context.remote.issue(issue.issueId)
        if (Object.keys(edits).some((field) => !equal(observed.fields[field as keyof JiraFields], expected[field as keyof JiraFields]))) throw new JiraWorkspaceError('E_UNKNOWN', 'Jira did not confirm the mapped field values.')
        return observed
      }, (observed) => this.settle(receipt.receipt.id, 'applied', 'Jira field update re-read and confirmed.', { issue: observed }))
      issue = await context.remote.issue(issue.issueId)
    }
    if (desired.status && desired.status !== issue.fields.status) {
      const localStatus = local.fields.status; const transition = plan.mapping.transitions[localStatus]
      if (!transition) throw new JiraWorkspaceError('E_CONFLICT', 'No explicit transition is mapped for this local source status.')
      const name = await prepareTransition(writer, issue.projectId, issue.issueId, transition, desired.status)
      const receipt = this.intent(context, identity, 'remote-transition', issue, local, { status: desired.status })
      await this.effect(context, receipt, async () => { await applyTransition(writer, issue.issueId, transition, name); return context.remote.issue(issue.issueId) }, (observed) => this.settle(receipt.receipt.id, 'applied', 'Authorized Jira transition re-read and confirmed.', { issue: observed }))
      issue = await context.remote.issue(issue.issueId)
    }
    if (desired.comments) {
      if (!(await writer.permissions(issue.projectId, issue.issueId)).ADD_COMMENTS) throw new JiraWorkspaceError('E_DENIED', 'This issue does not grant comment permission.')
      const originals = local.fields.comments.filter((comment) => !comment.id.startsWith('local:'))
      if (desired.comments.some((comment) => comment.id.startsWith('local:') && !/^local:[a-f0-9-]{36}$/.test(comment.id))) throw new JiraWorkspaceError('E_INVALID_ARG', 'A pending local comment requires its own stable UUID identity; it was not sent or discarded.')
      if (originals.some((comment) => !issue.fields.comments.some((remote) => remote.id === comment.id && remote.body === comment.body))) throw new JiraWorkspaceError('E_CONFLICT', 'Comment edits/deletions are not supported; existing comments are preserved.')
      for (const comment of desired.comments.filter((comment) => /^local:[a-f0-9-]{36}$/.test(comment.id))) {
        const commentIdentity = `${identity}:comment:${comment.id}`
        const prior = this.repository.read().receipts.find((entry) => entry.receipt.identity === commentIdentity && entry.receipt.effect === 'remote-comment' && entry.source.instanceId === context.job.source.instanceId && ['applied', 'unknown', 'intent'].includes(entry.receipt.state))
        if (prior?.receipt.state === 'applied') continue
        if (prior) throw new JiraWorkspaceError('E_UNKNOWN', 'Original comment receipt is unresolved. It will not be resubmitted.')
        const receipt = this.intent(context, commentIdentity, 'remote-comment', issue, local, { comments: [comment] })
        await this.effect(context, receipt, () => applyComment(writer, issue.issueId, comment.body, receipt.receipt.id), () => this.settle(receipt.receipt.id, 'applied', 'Jira confirmed a new comment ID.'))
      }
      issue = await context.remote.issue(issue.issueId)
      const receipt = this.intent(context, identity, 'local-update', issue, local, null, { comments: issue.fields.comments })
      await this.effect(context, receipt, async () => this.tasks.patch(context.workspace, local, { comments: issue.fields.comments }, issue), (after) => this.settle(receipt.receipt.id, 'applied', 'Remote comment IDs retained to prevent echo. ', { after }))
    }
    return issue
  }
  private async outboundCreate(context: Context, taskRef: string, plan: JiraPlan): Promise<void> {
    const local = this.tasks.read(context.workspace, taskRef)
    if (local.sourceIssueId) return // Existing numeric sources are processed by the issue path.
    if (!plan.rules.outboundCreate || !plan.remoteWritesApproved || plan.plan.direction !== 'bidirectional') return
    const prior = this.repository.read().receipts.find((entry) => entry.receipt.effect === 'remote-create' && entry.receipt.taskRef === local.taskRef && entry.source.instanceId === context.job.source.instanceId && entry.source.remoteProjectId === context.job.source.remoteProjectId && ['intent', 'unknown', 'applied'].includes(entry.receipt.state))
    if (prior) {
      if (prior.receipt.state !== 'applied' || !prior.receipt.issueId || prior.before?.hash !== local.hash) throw new JiraWorkspaceError('E_UNKNOWN', 'An earlier Jira creation retains this local task. Reconcile that numeric identity instead of creating again.')
      const issue = await context.remote.issue(prior.receipt.issueId)
      const link = this.intent(context, `task:${local.taskRef}`, 'local-update', issue, local, null, {})
      const after = await this.effect(context, link, async () => this.tasks.patch(context.workspace, local, {}, issue), (after) => this.settle(link.receipt.id, 'applied', 'Original confirmed remote creation linked without another create request.', { after }))
      this.base(plan, issue, after); return
    }
    const createMapping = !local.fields.type && plan.createIssueTypeId ? { ...plan.mapping, fields: plan.mapping.fields.filter((field) => field !== 'type') } : plan.mapping
    const desired = outboundFields(local.fields, createMapping)
    if (!desired.type && plan.createIssueTypeId) desired.type = plan.createIssueTypeId
    const writer = await this.writer(context)
    const fields = await prepareCreate(writer, context.job.source.remoteProjectId, desired)
    const creationExpected = { ...desired }; delete creationExpected.status; delete creationExpected.comments
    const receipt = this.intent(context, `task:${local.taskRef}`, 'remote-create', null, local, creationExpected)
    let created = await this.effect(context, receipt, async () => {
      const id = await applyCreate(writer, context.job.source.remoteProjectId, fields)
      // Retain numeric identity before the read/link await; a lost acknowledgement never re-creates.
      this.repository.change((state) => { const stored = state.receipts.find((entry) => entry.receipt.id === receipt.receipt.id); if (stored) stored.receipt.issueId = id })
      return context.remote.issue(id)
    }, (issue) => this.settle(receipt.receipt.id, 'applied', 'Jira issue numeric identity confirmed.', { issue }))
    const link = this.intent(context, `task:${local.taskRef}`, 'local-update', created, local, null, {})
    let after = await this.effect(context, link, async () => this.tasks.patch(context.workspace, local, {}, created), (after) => this.settle(link.receipt.id, 'applied', 'New remote issue linked to the existing local task.', { after }))
    const followup: Partial<JiraFields> = {}
    if (desired.status && desired.status !== created.fields.status) followup.status = desired.status
    if (desired.comments?.some((comment) => comment.id.startsWith('local:'))) followup.comments = desired.comments
    if (Object.keys(followup).length) {
      if (!plan.rules.outboundUpdate) throw new JiraWorkspaceError('E_CONFLICT', 'Issue was created and linked with its server initial state. Applying the mapped initial transition/comments additionally requires explicit outbound updates.')
      created = await this.writeMapped(context, `task:${local.taskRef}`, after, created, followup, plan)
      after = this.tasks.read(context.workspace, local.taskRef)
    }
    this.base(plan, created, after)
  }
  async dispatch(input: Dispatch): Promise<Result> {
    const context: Context = { ...input, remote: new JiraRemote(input.connection, input.signal) }
    if (input.job.source.providerId !== 'jira' || input.job.workspaceId !== input.workspace.workspaceId) throw new JiraWorkspaceError('E_DENIED', 'Foreign provider/workspace dispatch is forbidden.')
    const plan = input.job.input.kind === 'sync' ? this.plan(input.job, input.workspace) : null
    const material = input.job.input.kind === 'import' ? this.repository.preview(input.job.input.previewId) : null
    if (material && (!sameGrant(material.workspace, input.workspace) || material.preview.digest !== (input.job.input.kind === 'import' ? input.job.input.previewDigest : '') || !equal(material.preview.source, input.job.source))) throw new JiraWorkspaceError('E_CONFLICT', 'Import preview belongs to another admitted owner/source.')
    const mapping = plan?.mapping ?? material?.preview.mapping
    if (!mapping) throw new JiraWorkspaceError('E_INVALID_ARG', 'No retained Jira mapping is available.')
    const cursor = cursorSchema.parse(input.job.cursor ? JSON.parse(input.job.cursor) : { afterId: null, csvIndex: 0, phase: 'issues', outboundIndex: 0 })
    let counts = { ...input.job.counts }; let unknown = false; let partial = counts.failed > 0
    if (counts.total === null && material?.preview.total !== null && material?.preview.total !== undefined) counts.total = material.preview.total
    const done = (state: Result['state']): Result => ({ state, counts, cursor: JSON.stringify(cursor), evidenceRef: this.evidence(input.job) })
    const checkpoint = (): void => { context.job = input.checkpoint(context.job.revision, { counts, cursor: JSON.stringify(cursor) }, this.evidence(input.job)) }
    const process = async (issue: JiraIssueRecord): Promise<void> => {
      try { await this.guard(context); await this.inbound(context, issue, mapping, plan) }
      catch (error) {
        if (input.signal.aborted || plan && this.plan(input.job, input.workspace).plan.state === 'paused') throw error
        if (error instanceof JiraWorkspaceError && error.code === 'E_UNKNOWN') { unknown = true; this.diagnostic(input.workspace.workspaceId, 'unknown', error.message, issue.issueId); return }
        counts.failed++; counts.processed++; partial = true
        const detail = error instanceof JiraWorkspaceError ? error.message : 'Jira item failed validation, permission, transport or persistence. Inspect the retained receipt.'
        this.diagnostic(input.workspace.workspaceId, error instanceof JiraWorkspaceError && error.code === 'E_CONFLICT' ? 'conflict' : 'permission', detail, issue.issueId)
        if (!this.repository.read().receipts.some((entry) => entry.receipt.jobId === input.job.id && entry.receipt.identity === `${issue.instanceId}#${issue.issueId}`)) { const receipt = this.intent(context, `${issue.instanceId}#${issue.issueId}`, 'local-update', issue, null); this.settle(receipt.receipt.id, 'failed', detail) }
        return
      }
      if (!unknown) counts.processed++
    }
    try {
      if (material?.preview.format === 'csv') {
        counts.total = material.items.length
        while (cursor.csvIndex < material.items.length) {
          if (input.signal.aborted) return done('cancelled')
          await process(material.items[cursor.csvIndex]); if (unknown) return done('unknown')
          cursor.csvIndex++; checkpoint()
        }
      } else if (cursor.phase === 'issues') {
        const filter = plan?.jql.trim() || 'id > 0'
        if (plan && /\bORDER\s+BY\b/i.test(filter)) throw new JiraWorkspaceError('E_INVALID_ARG', 'Sync JQL is a filter; numeric ordering is retained by the job.')
        const query = material?.preview.query ?? `project = ${input.job.source.remoteProjectId} AND (${filter}) ORDER BY id ASC`
        for (;;) {
          if (input.signal.aborted) return done('cancelled')
          if (plan && this.plan(input.job, input.workspace).plan.state === 'paused') return done('paused')
          const page = await context.remote.page(query, cursor.afterId)
          if (counts.total === null && cursor.afterId === null && page.total !== null) counts.total = page.total + (plan?.outboundTaskRefs.length ?? 0)
          if (!page.items.length) break
          for (const item of page.items) {
            if (input.signal.aborted) return done('cancelled')
            if (plan && this.plan(input.job, input.workspace).plan.state === 'paused') return done('paused')
            if (counts.total !== null && counts.processed >= counts.total - (plan?.outboundTaskRefs.length ?? 0)) { partial = true; this.diagnostic(input.workspace.workspaceId, 'partial', 'Query membership grew beyond its admitted total. The retained query/cursor remains visible; review a fresh scope before additional records.'); break }
            const issue = await context.remote.issue(item.issueId, plan?.includeHistory ?? material?.preview.includeHistory ?? false)
            await process(issue); if (unknown) return done('unknown')
            cursor.afterId = item.issueId; checkpoint()
          }
          if (partial && counts.total !== null && counts.processed >= counts.total - (plan?.outboundTaskRefs.length ?? 0)) break
          // No preview item cap applies here: the next page always retains last numeric identity.
          if (page.complete) break
        }
      }
      cursor.phase = 'outbound'
      if (plan) while (cursor.outboundIndex < plan.outboundTaskRefs.length) {
        if (input.signal.aborted) return done('cancelled')
        try { await this.outboundCreate(context, plan.outboundTaskRefs[cursor.outboundIndex], plan) }
        catch (error) { if (error instanceof JiraWorkspaceError && error.code === 'E_UNKNOWN') return done('unknown'); counts.failed++; partial = true; this.diagnostic(input.workspace.workspaceId, 'permission', error instanceof JiraWorkspaceError ? error.message : 'Outbound item failed; inspect retained receipts.') }
        counts.processed++; cursor.outboundIndex++; checkpoint()
      }
      if (material?.preview.total !== null && material?.preview.total !== undefined && counts.processed !== material.preview.total) { partial = true; this.diagnostic(input.workspace.workspaceId, 'partial', `Selected query originally reported ${material.preview.total}; the job visited ${counts.processed}. Live membership changed or coverage is partial.`) }
      if (counts.total === null) counts.total = counts.processed
      if (counts.total !== counts.processed) partial = true
      if (plan) this.repository.change((state) => {
        const entry = state.plans.find((entry) => entry.value.plan.id === plan.plan.id && entry.value.plan.revision === plan.plan.revision)
        if (!entry) throw new JiraWorkspaceError('E_CONFLICT', 'Original sync policy changed before settlement.')
        entry.value.lastSuccessAt = partial ? entry.value.lastSuccessAt : Date.now(); entry.value.failures = partial ? Math.min(20, entry.value.failures + 1) : 0
        const closed = ['paused', 'blocked'].includes(entry.value.plan.state)
        entry.value.nextPollAt = closed ? null : Date.now() + Math.min(60 * 60_000, JIRA_LIMITS.pollMs * 2 ** entry.value.failures)
        entry.value.detail = closed ? 'Admission remains paused/blocked. The last retained job has settled.' : partial ? 'Catch-up finished with item failures or conflicts.' : 'Full selected query catch-up completed.'
        if (partial && !closed && entry.value.plan.state !== 'degraded') { entry.value.plan.state = 'degraded'; entry.value.controlRevision++ }
      })
      return done(partial || counts.failed ? 'partially-failed' : 'completed')
    } catch (error) {
      unknown = this.repository.read().receipts.some((entry) => entry.receipt.jobId === input.job.id && ['intent', 'unknown'].includes(entry.receipt.state))
      this.diagnostic(input.workspace.workspaceId, unknown ? 'unknown' : 'transport', error instanceof JiraWorkspaceError ? error.message : 'Jira read failed. Retained numeric cursor and original owner remain available for explicit recovery.')
      if (input.signal.aborted && !unknown) return done('cancelled')
      return done(unknown ? 'unknown' : 'paused')
    }
  }
  async reconcile(input: Parameters<IntegrationWorkPort['reconcile']>[0]): Promise<{ resolved: boolean; evidenceRef: string | null }> {
    this.authority.assertGrant(input.workspace)
    const remote = new JiraRemote(await this.authority.resolve(input.workspace, input.job.source))
    for (const entry of this.repository.read().receipts.filter((entry) => entry.receipt.jobId === input.job.id && ['intent', 'unknown'].includes(entry.receipt.state))) {
      if (!sameGrant(entry.workspace, input.workspace) || !equal(entry.source, input.job.source)) throw new JiraWorkspaceError('E_CONFLICT', 'Original effect owner/source does not match reconciliation.')
      if (entry.receipt.effect === 'local-create' && entry.issue) {
        const local = this.tasks.find(input.workspace, entry.issue)
        if (local) this.settle(entry.receipt.id, 'applied', 'Existing numeric source task confirmed; crash-time creation ownership remains unproven, so rollback is disabled.', { after: local }, false)
      } else if (entry.receipt.effect === 'local-update' && entry.before) {
        const local = this.tasks.read(input.workspace, entry.before.taskRef)
        if (entry.after && local.hash === entry.after.hash) this.settle(entry.receipt.id, 'applied', 'Exact retained local publication confirmed.', { after: local })
        else if (entry.expectedLocal && entry.issue && local.sourceIssueId === entry.issue.issueId && local.sourceInstanceId === entry.issue.instanceId && Object.keys(entry.expectedLocal).every((field) => equal(local.fields[field as keyof JiraFields], entry.expectedLocal?.[field as keyof JiraFields]))) this.settle(entry.receipt.id, 'applied', 'Original numeric source and intended mapped local values confirmed. No crash-time artifact ownership is inferred.', { after: local })
        else if (local.hash === entry.before.hash) this.settle(entry.receipt.id, 'failed', 'Exact original local snapshot is unchanged; no successful publication is claimed.')
      } else if (entry.receipt.issueId) {
        const observed = await remote.issue(entry.receipt.issueId)
        let confirmed = false
        if (entry.receipt.effect === 'remote-comment') confirmed = observed.fields.comments.some((comment) => comment.body.endsWith(`[trellis-jira-receipt:${entry.receipt.id}]`))
        else if (entry.expectedRemote) confirmed = Object.keys(entry.expectedRemote).every((field) => equal(observed.fields[field as keyof JiraFields], entry.expectedRemote?.[field as keyof JiraFields]))
        if (confirmed) this.settle(entry.receipt.id, 'applied', 'Original numeric remote effect re-read and confirmed without another write.', { issue: observed })
      }
    }
    const entries = this.repository.read().receipts.filter((entry) => entry.receipt.jobId === input.job.id)
    const resolved = entries.every((entry) => !['intent', 'unknown'].includes(entry.receipt.state))
    return { resolved, evidenceRef: entries.length ? this.evidence(input.job) : null }
  }
}
