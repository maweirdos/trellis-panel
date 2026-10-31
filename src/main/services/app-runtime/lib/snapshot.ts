import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { applicationRunSnapshotSchema, type ApplicationRunSnapshot } from '../../../../shared/app-runtime'
import type { StoredApplication } from '../types'
import type { LaunchPlan } from './launch'
import { resolveWorkcopy } from '../../workcopy-use'

/** Metadata never contains argv, a shell body, environment values or their hashes. */
export function captureRunSnapshot(root: string, stored: StoredApplication, plan: LaunchPlan, runId: string, startedAt: number): ApplicationRunSnapshot {
  const redact = (value: string): string => {
    let result = value
    for (const secret of [...plan.secrets].sort((a, b) => b.length - a.length)) if (secret) result = result.split(secret).join('[REDACTED]')
    return result
  }
  const launch = stored.config.launch
  let file: string | null = null
  let artifact: { path: string; size: number; modifiedAt: number } | null = null
  if (launch.kind === 'argv') {
    const jarIndex = launch.args.indexOf('-jar')
    const candidate = jarIndex >= 0 ? launch.args[jarIndex + 1] : launch.args.slice(0, 2).find((arg) => !arg.startsWith('-') && /\.(?:js|mjs|cjs|py|ps1|sh|cmd|bat)$/i.test(arg))
    if (candidate) {
      const path = resolve(plan.cwd, candidate)
      if (existsSync(path)) {
        const stat = statSync(path)
        if (stat.isFile()) {
          file = redact(path)
          if (jarIndex >= 0) artifact = { path: file, size: stat.size, modifiedAt: stat.mtimeMs }
        }
      }
    }
  }
  const readiness = stored.config.readiness
  const workcopy = resolveWorkcopy(plan.cwd)
  return applicationRunSnapshotSchema.parse({
    status: 'known', root, appId: stored.config.id, runId, configRevision: stored.revision,
    name: redact(stored.config.name), cwd: plan.cwd, startedAt,
    entry: { kind: launch.kind, executable: redact(plan.executable), file, npmScript: launch.kind === 'npm-script' ? redact(launch.script) : null, arguments: 'withheld', build: artifact ? 'existing-artifact' : 'unknown', artifact },
    environment: { status: 'unverified', inherited: true, envFiles: plan.envFiles.map(redact), overrideKeys: Object.keys(stored.protectedOverrides).map(redact) },
    workcopy: { id: workcopy.id, branch: workcopy.branch, head: workcopy.head, dirty: null, access: stored.config.workcopyAccess },
    ports: stored.config.ports,
    readiness: { kind: readiness.kind, target: readiness.kind === 'none' ? null : readiness.kind === 'tcp' ? `${readiness.host}:${readiness.port}` : new URL(readiness.url).origin },
    source: 'not-verified'
  })
}
