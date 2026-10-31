import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { ApplicationEnvironmentCheck } from '../../../../shared/app-runtime'
import type { WorkcopyIdentity } from '../../../../shared/workcopy-use'
import type { StoredApplication } from '../types'
import type { LaunchPlan } from './launch'

type CheckRecord = { planId: string; fingerprint: string; check: ApplicationEnvironmentCheck; canVerify: boolean }

/** Session-private comparisons cannot be used to guess credentials from disk or IPC. */
export class ApplicationEnvironmentAuthority {
  private key = randomBytes(32)
  private records = new Map<string, CheckRecord>()
  private runs = new Map<string, string>()

  fingerprint(stored: StoredApplication, plan: LaunchPlan, workcopy: WorkcopyIdentity): string {
    return createHmac('sha256', this.key).update(JSON.stringify([stored.revision, plan.inputFingerprint, workcopy.id, workcopy.revision])).digest('hex')
  }
  observe(root: string, stored: StoredApplication, plan: LaunchPlan, workcopy: WorkcopyIdentity): CheckRecord {
    const key = JSON.stringify([root, stored.config.id])
    const fingerprint = this.fingerprint(stored, plan, workcopy)
    const previous = this.records.get(key)
    if (previous?.fingerprint === fingerprint) return previous
    const configuration = stored.config.environment
    const targets = configuration.targetKeys.map(key => ({ key, endpoint: this.endpoint(key, plan.env) }))
    const canVerify = configuration.selection !== 'unknown' && configuration.dependencies !== 'unknown'
      && (configuration.dependencies === 'none' ? targets.length === 0 : targets.length > 0 && targets.every(target => target.endpoint !== null))
    const reason = canVerify ? '尚未进行本机环境核对' : configuration.selection === 'unknown' ? '请明确选择环境'
      : configuration.dependencies === 'unknown' ? '依赖环境尚未声明'
        : '依赖目标无法安全核实；请使用可解析的 URL 环境变量，或核对无外部依赖的声明'
    const record: CheckRecord = {
      planId: randomUUID(), fingerprint, canVerify,
      check: { version: 1, id: randomUUID(), status: previous ? 'changed' : 'unknown', method: null, checkedBy: null, checkedAt: null,
        configRevision: stored.revision, workcopyId: workcopy.id, selection: configuration.selection, targets, reason }
    }
    this.records.set(key, record)
    return record
  }
  verify(root: string, stored: StoredApplication, plan: LaunchPlan, workcopy: WorkcopyIdentity, planId: string, actor: string): ApplicationEnvironmentCheck | null {
    const record = this.observe(root, stored, plan, workcopy)
    if (record.planId !== planId || !record.canVerify) return null
    record.check = { ...record.check, id: randomUUID(), status: 'verified', method: 'manual', checkedBy: actor, checkedAt: Date.now(), reason: undefined }
    return record.check
  }
  rememberRun(runId: string, stored: StoredApplication, plan: LaunchPlan, workcopy: WorkcopyIdentity): void { this.runs.set(runId, this.fingerprint(stored, plan, workcopy)) }
  matchesRun(runId: string, stored: StoredApplication, plan: LaunchPlan, workcopy: WorkcopyIdentity): boolean { return this.runs.get(runId) === this.fingerprint(stored, plan, workcopy) }
  forgetRun(runId: string): void { this.runs.delete(runId) }
  forgetApplication(root: string, appId: string): void { this.records.delete(JSON.stringify([root, appId])) }

  private endpoint(key: string, env: NodeJS.ProcessEnv): string | null {
    if (/(?:secret|token|password|passwd|credential|api[_-]?key|private[_-]?key)/i.test(key)) return null
    const value = Object.entries(env).find(([name]) => process.platform === 'win32' ? name.toUpperCase() === key.toUpperCase() : name === key)?.[1]
    if (!value || value.length > 32768) return null
    try {
      const url = new URL(value)
      if (!['http:', 'https:', 'postgres:', 'postgresql:', 'mysql:', 'redis:', 'rediss:', 'mongodb:', 'amqp:', 'amqps:', 'tcp:'].includes(url.protocol) || !url.hostname || url.hostname.length > 253) return null
      // Paths, usernames, passwords, search and fragments can all contain secrets.
      return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`
    } catch { return null }
  }
}
