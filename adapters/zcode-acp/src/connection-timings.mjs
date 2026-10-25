import { performance } from 'node:perf_hooks'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONNECTION_TIMINGS_FILE = 'zcode-adapter-connection-timings.json'
export const CONNECTION_STAGES = ['backend-process', 'storage-ready', 'account-sync', 'session-create-or-resume', 'subscribe']
const REASONS = new Set(['backend_reused', 'isolated', 'no_builtin_config', 'not_started', 'cancelled', 'backend_exited',
  'preparation_failed', 'spawn_failed', 'storage_timeout', 'request_failed', 'invalid_session', 'invalid_subscription',
  'account_sync_failed', 'account_sync_unacknowledged', 'account_scope_changed', 'account_disposed', 'account_unsupported',
  'account_not_current', 'account_profile_invalid', 'account_file_unavailable', 'credential_invalid', 'credential_missing',
  'credential_expired', 'account_endpoint_invalid', 'subscription_unavailable', 'not_entitled', 'builtin_changed',
  'builtin_schema_unsupported', 'account_unavailable', 'account_paths_invalid', 'account_session_invalid'])

/** Connection-local facts only: no native IDs, paths, error strings or protocol payloads. */
export function createConnectionTimings(operation, backendReused, directory) {
  const startedAt = performance.now()
  // Never leave a previous attempt's success available during a new attempt.
  if (directory) {
    try { unlinkSync(join(directory, CONNECTION_TIMINGS_FILE)) }
    catch (error) {
      if (error?.code !== 'ENOENT') console.error('[zcode-acp] Previous connection timing diagnostics could not be cleared')
    }
  }
  const stages = new Map()
  const active = new Map()
  let final
  const duration = start => Math.max(0, Math.round(performance.now() - start))
  const reasonField = reason => REASONS.has(reason) ? { reason } : {}
  const start = stage => {
    if (!final && CONNECTION_STAGES.includes(stage) && !stages.has(stage) && !active.has(stage)) active.set(stage, performance.now())
  }
  const end = (stage, status = 'completed', reason) => {
    const began = active.get(stage)
    if (final || began === undefined) return
    active.delete(stage)
    stages.set(stage, { stage, status, durationMs: duration(began), ...reasonField(reason) })
  }
  const skip = (stage, reason) => {
    if (!final && CONNECTION_STAGES.includes(stage) && !stages.has(stage) && !active.has(stage)) {
      stages.set(stage, { stage, status: 'skipped', ...reasonField(reason) })
    }
  }
  return {
    start, end, skip,
    async measure(stage, action, failureReason = 'request_failed') {
      start(stage)
      try { const result = await action(); end(stage); return result }
      catch (error) { end(stage, 'failed', error?.connectionTimingReason ?? failureReason); throw error }
    },
    finish(status, reason) {
      if (final) return final
      for (const stage of active.keys()) end(stage, 'failed', reason)
      for (const stage of CONNECTION_STAGES) skip(stage, 'not_started')
      final = { version: 1, operation, status, backendReused, totalDurationMs: duration(startedAt),
        stages: CONNECTION_STAGES.map(stage => stages.get(stage)) }
      if (directory) {
        try {
          mkdirSync(directory, { recursive: true })
          const target = join(directory, CONNECTION_TIMINGS_FILE)
          const temporary = `${target}.${process.pid}.tmp`
          writeFileSync(temporary, `${JSON.stringify(final)}\n`, { encoding: 'utf8', mode: 0o600 })
          renameSync(temporary, target)
        } catch { console.error('[zcode-acp] Connection timing diagnostics could not be saved') }
      }
      return final
    }
  }
}
