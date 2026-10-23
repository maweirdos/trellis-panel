import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { legacyDaemonInspectionSchema, legacyDaemonStopInputSchema, type LegacyDaemonInspection, type LegacyDaemonStopInput } from '../../../shared/bootstrap'
import type { DaemonResult, DaemonStatus } from '../../../shared/daemon'
import { createHistoricalControlContext, type HistoricalControlContext } from '../../daemon/context'
import { DaemonError, daemonFailure } from '../../daemon/errors'
import { readLease, verifiedLease } from '../../daemon/lease'
import { processIdentity, sameOwner } from '../../daemon/native'
import { DaemonClient } from './client'

const EXIT_WAIT_MS = 15_000
const EXIT_POLL_MS = 200
type StopResult = DaemonResult<{ stopped: true }>
type Capture = { context: HistoricalControlContext; inspection: LegacyDaemonInspection }
type StopAttempt = { capture: Capture; commandId: string; submitted: boolean; pending?: Promise<StopResult> }
let captured: Capture | undefined
let inspectionPending: Promise<DaemonResult<LegacyDaemonInspection>> | undefined
// One original attempt is retained across UI retries, including lost replies.
// Never discard an unresolved command in order to stop a replacement owner.
let attempt: StopAttempt | undefined

function sameCapture(input: LegacyDaemonStopInput, capture: Capture): boolean {
  return input.epoch === capture.inspection.epoch && sameOwner(input.owner, capture.inspection.owner)
}
function hasMigrationEvidence(context: HistoricalControlContext): boolean {
  const files = [join(context.userData, 'daemon-v1', 'settings-owner.json'), ...['native-cutover.protected', 'protected-settings.json', 'migration-original.protected.json'].map(file => join(context.directory, file))]
  // lstat includes a dangling link: damaged migration evidence cannot become
  // permission to stop merely because existsSync would follow a missing target.
  return files.some(file => {
    try { lstatSync(file); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  })
}
function projectInspection(context: HistoricalControlContext, status: DaemonStatus): LegacyDaemonInspection {
  const lease = context.historicalLease
  if (status.epoch !== lease.epoch || !sameOwner(status.owner, lease.owner)
    || JSON.stringify(status.identity) !== JSON.stringify(context.identity) || status.eventCursor.epoch !== lease.epoch) {
    throw new DaemonError('E_CONFLICT', 'Authenticated historical status does not match the captured profile, installation, owner and epoch.')
  }
  return legacyDaemonInspectionSchema.parse({
    epoch: status.epoch, owner: status.owner, activeJobs: status.activeJobs, unknownJobs: status.unknownJobs,
    runtimeAuthority: status.runtimeAuthority, settingsAuthority: status.settingsAuthority,
    canStop: status.state === 'running' && status.activeJobs === 0 && status.unknownJobs === 0
      && status.runtimeAuthority === 'legacy' && status.settingsAuthority === 'legacy'
      && status.capabilities.includes('foundation') && !status.capabilities.includes('runtime-control')
      && !status.capabilities.includes('native-protection') && !hasMigrationEvidence(context)
  })
}
async function assertOriginalOwner(context: HistoricalControlContext): Promise<void> {
  context.assertHistorical()
  const lease = await verifiedLease(context)
  context.assertHistorical()
  if (!lease || JSON.stringify(lease) !== JSON.stringify(context.historicalLease)) throw new DaemonError('E_CONFLICT', 'The original historical owner is no longer the verified live owner.')
}
async function readInspection(context: HistoricalControlContext, client: DaemonClient): Promise<LegacyDaemonInspection> {
  if (JSON.stringify(client.lease) !== JSON.stringify(context.historicalLease)) throw new DaemonError('E_CONFLICT', 'Historical control authenticated a different owner or epoch.')
  // Verify the OS generation before the final status round trip. Status is the
  // last awaited operation before stop; no slow identity subprocess sits
  // between the idle observation and its synchronous file/migration fences.
  await assertOriginalOwner(context)
  const status = await client.request('daemon.status', {})
  if (!status.ok) throw new DaemonError(status.code, status.error, status.outcome)
  context.assertHistorical()
  return projectInspection(context, status.data)
}

/** Explicit restricted-shell capability. No normal daemon context, pool,
 * bootstrap readiness, writer installation, startup or migration is invoked. */
export function inspectLegacyDaemon(): Promise<DaemonResult<LegacyDaemonInspection>> {
  if (inspectionPending) return inspectionPending
  const pending = (async (): Promise<DaemonResult<LegacyDaemonInspection>> => {
    let client: DaemonClient | undefined
    try {
      const context = await createHistoricalControlContext()
      client = await DaemonClient.connect(context)
      const inspection = await readInspection(context, client)
      captured = { context, inspection }
      return { ok: true, data: inspection }
    } catch (error) { return daemonFailure(error) }
    finally { client?.close() }
  })()
  inspectionPending = pending
  void pending.finally(() => { if (inspectionPending === pending) inspectionPending = undefined })
  return pending
}

/** Confirmation requires BOTH original process exit and owner-side lease
 * release. A stale/replacement lease is never deleted or interpreted as exit. */
async function confirmOriginalExit(original: StopAttempt): Promise<StopResult> {
  const context = original.capture.context, lease = context.historicalLease
  const deadline = Date.now() + EXIT_WAIT_MS
  while (true) {
    context.assertHistoricalFiles()
    const actual = await processIdentity(lease.owner.pid)
    context.assertHistoricalFiles()
    const current = readLease(context)
    if (current && JSON.stringify(current) !== JSON.stringify(lease)) throw new DaemonError('E_CONFLICT', 'Daemon ownership changed while confirming the original stop. The replacement owner was not controlled.', 'unknown')
    if ((!actual || !sameOwner(actual, lease.owner)) && !current) return { ok: true, data: { stopped: true } }
    if (Date.now() >= deadline) throw new DaemonError('E_UNKNOWN', 'Original daemon exit and lease release remain unconfirmed. Inspect the original stop command; no new command or owner was created.', 'unknown')
    await new Promise<void>(resolve => setTimeout(resolve, EXIT_POLL_MS))
  }
}
async function runStop(original: StopAttempt): Promise<StopResult> {
  let client: DaemonClient | undefined
  try {
    // A lost acknowledgement is never permission to submit stop again. An
    // explicit retry reconciles only the original process/lease under its UUID.
    if (original.submitted) return await confirmOriginalExit(original)
    const context = original.capture.context
    await assertOriginalOwner(context)
    client = await DaemonClient.connect(context)
    const fresh = await readInspection(context, client)
    if (!sameCapture(fresh, original.capture) || !fresh.canStop) throw new DaemonError('E_DENIED', 'Historical stop requires the same idle owner with zero active/unknown jobs and legacy runtime/settings authority. No stop was submitted.')
    context.assertHistorical()
    if (hasMigrationEvidence(context)) throw new DaemonError('E_CONFLICT', 'Migration evidence appeared before stop. Preserve the original controller; no stop was submitted.')
    original.submitted = true
    const result = await client.request('daemon.stop', { expectedOwner: context.historicalLease.owner }, { commandId: original.commandId })
    client.close(); client = undefined
    if (!result.ok && result.outcome === 'not-admitted') {
      // An authenticated explicit rejection allows a later user retry with the
      // same command UUID, after all fresh inspection gates run again.
      original.submitted = false
      return { ...result, commandId: original.commandId }
    }
    // Even a valid stopping reply is not a stopped result. Conversely, exact
    // exit plus lease release can reconcile an acknowledgement lost in transit.
    return await confirmOriginalExit(original)
  } catch (error) {
    if (original.submitted && !(error instanceof DaemonError && error.outcome === 'unknown')) {
      return daemonFailure(new DaemonError('E_UNKNOWN', 'The original stop was submitted but its exit/lease evidence is unavailable. Inspect the same command before retrying.', 'unknown'), original.commandId)
    }
    return daemonFailure(error, original.commandId)
  } finally { client?.close() }
}

/** Read-only recovery of an existing native attempt. This endpoint cannot
 * create an attempt, submit/retry stop or advance bootstrap/native readiness. */
export function reconcileLegacyDaemonStop(input: LegacyDaemonStopInput): Promise<StopResult> {
  const parsed = legacyDaemonStopInputSchema.safeParse(input)
  if (!parsed.success) return Promise.resolve(daemonFailure(new DaemonError('E_INVALID_ARG', 'Pass the exact epoch and owner of the original historical stop.')))
  const original = attempt
  if (!original) return Promise.resolve(daemonFailure(new DaemonError('E_CONFLICT', 'No retained native historical stop exists in this GUI process. No command was created or submitted.')))
  if (!sameCapture(parsed.data, original.capture)) return Promise.resolve(daemonFailure(new DaemonError('E_CONFLICT', 'Reconciliation must refer to the original historical stop owner and epoch.'), original.commandId))
  if (original.pending) return original.pending
  if (!original.submitted) return Promise.resolve(daemonFailure(new DaemonError('E_CONFLICT', 'The retained historical stop was not submitted. Reconciliation did not submit it.'), original.commandId))
  const pending = confirmOriginalExit(original).catch(error => daemonFailure(error instanceof DaemonError && error.outcome === 'unknown' ? error : new DaemonError('E_UNKNOWN', 'The original stop exit/lease evidence is unavailable. Reconcile this same command before retrying.', 'unknown'), original.commandId))
  original.pending = pending
  void pending.finally(() => { if (original.pending === pending) original.pending = undefined })
  return pending
}

/** Explicit confirmation only. Never starts, retries bootstrap, migrates,
 * replaces credentials/leases, kills a process or executes provider work. */
export function stopLegacyDaemon(input: LegacyDaemonStopInput): Promise<StopResult> {
  const parsed = legacyDaemonStopInputSchema.safeParse(input)
  if (!parsed.success) return Promise.resolve(daemonFailure(new DaemonError('E_INVALID_ARG', 'Pass the exact epoch and owner returned by historical inspection.')))
  const value = parsed.data
  if (attempt && !sameCapture(value, attempt.capture)) return Promise.resolve(daemonFailure(new DaemonError('E_CONFLICT', 'Reconcile the original historical stop before selecting another owner.'), attempt.commandId))
  if (!attempt) {
    if (!captured || !sameCapture(value, captured)) return Promise.resolve(daemonFailure(new DaemonError('E_CONFLICT', 'Inspect the historical daemon in this GUI before confirming its exact owner and epoch.')))
    if (!captured.inspection.canStop) return Promise.resolve(daemonFailure(new DaemonError('E_DENIED', 'The inspected historical owner is not eligible for safe stop. Preserve its original controller.')))
    attempt = { capture: captured, commandId: randomUUID(), submitted: false }
  }
  const original = attempt
  if (original.pending) return original.pending
  const pending = runStop(original)
  original.pending = pending
  void pending.finally(() => { if (original.pending === pending) original.pending = undefined })
  return pending
}
