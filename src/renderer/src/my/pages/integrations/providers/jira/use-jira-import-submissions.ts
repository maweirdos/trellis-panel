import { useCallback, useEffect, useRef, useState } from 'react'
import type { IntegrationJob, IntegrationSource } from '@shared/integration-work'
import type { JiraIntegrationApi, JiraPreview } from '@shared/jira-integration'
import { projectRootKey } from '../../../../navigation'
import { useAlive, useIntegrationOwner } from '../../hooks'

export type JiraImportScope = { expectedRoot: string; workspaceId: string }
export interface JiraImportSubmission {
  key: string
  scope: JiraImportScope
  source: IntegrationSource
  preview: JiraPreview
  commandId: string
  state: 'previewed' | 'pending' | 'unknown' | 'admitted'
  acceptPartial: boolean | null
  submittedAt: number | null
  detail: string
  job: IntegrationJob | null
}

function sourceKey(scope: JiraImportScope, source: IntegrationSource): string {
  return JSON.stringify([projectRootKey(scope.expectedRoot), scope.workspaceId, source.providerId, source.connectionId, source.connectionRevision, source.instanceId, source.bindingId, source.bindingRevision, source.remoteProjectId])
}
function matchesJob(entry: JiraImportSubmission, job: IntegrationJob): boolean {
  return job.commandId === entry.commandId && job.workspaceId === entry.scope.workspaceId && sourceKey(entry.scope, job.source) === entry.key && job.input.kind === 'import' && job.input.previewId === entry.preview.id && job.input.previewDigest === entry.preview.digest && job.input.format === entry.preview.format
}
export function jiraImportSettled(entry: JiraImportSubmission): boolean {
  return entry.state === 'admitted' && Boolean(entry.job && ['completed', 'partially-failed', 'cancelled', 'rollback-blocked'].includes(entry.job.state))
}

/** Workspace-owned facts, independent of the volatile preview/recovery modal. */
export function useJiraImportSubmissions(api: JiraIntegrationApi, ownerKey: string, sourceCurrent: (source: IntegrationSource) => boolean, scope: JiraImportScope | null) {
  const owner = useIntegrationOwner(ownerKey)
  const alive = useAlive()
  const latest = useRef({ current: owner.current, sourceCurrent, scope })
  latest.current = { current: owner.current, sourceCurrent, scope }
  const retained = useRef(new Map<string, JiraImportSubmission>())
  const [, redraw] = useState(0)
  const publish = useCallback((): void => { if (alive.current) redraw((revision) => revision + 1) }, [alive])
  // Invalidate admission, not original evidence. A late original reply may still
  // identify its own command; it cannot authorize work for a replacement source.
  useEffect(() => {
    let changed = false
    for (const [key, entry] of retained.current) if (entry.state === 'pending') {
      retained.current.set(key, { ...entry, state: 'unknown', detail: '界面来源已变化，需核实原提交结果。' }); changed = true
    }
    if (changed) publish()
  }, [ownerKey, owner.current, scope?.expectedRoot, scope?.workspaceId, publish])
  const usable = (requested: JiraImportScope, source: IntegrationSource): boolean => latest.current.current() && latest.current.scope?.workspaceId === requested.workspaceId && projectRootKey(latest.current.scope?.expectedRoot) === projectRootKey(requested.expectedRoot) && latest.current.sourceCurrent(source)
  const get = (scope: JiraImportScope, source: IntegrationSource): JiraImportSubmission | undefined => retained.current.get(sourceKey(scope, source))
  const prepare = (scope: JiraImportScope, source: IntegrationSource, preview: JiraPreview): boolean => {
    if (!usable(scope, source) || preview.workspaceId !== scope.workspaceId || sourceKey(scope, preview.source) !== sourceKey(scope, source)) return false
    const key = sourceKey(scope, source)
    const prior = retained.current.get(key)
    if (prior && prior.state !== 'previewed') return false
    retained.current.set(key, { key, scope, source, preview, commandId: crypto.randomUUID(), state: 'previewed', acceptPartial: null, submittedAt: null, detail: '', job: null })
    publish(); return true
  }
  const discard = (scope: JiraImportScope, source: IntegrationSource): boolean => {
    if (!usable(scope, source)) return false
    const key = sourceKey(scope, source)
    const prior = retained.current.get(key)
    if (prior && prior.state !== 'previewed' && !jiraImportSettled(prior)) return false
    retained.current.delete(key); publish(); return true
  }
  const submit = async (scope: JiraImportScope, source: IntegrationSource, acceptPartial: boolean): Promise<IntegrationJob | undefined> => {
    if (!usable(scope, source)) return undefined
    const prior = get(scope, source)
    if (!prior || prior.state !== 'previewed') return undefined
    const admittedOwner = latest.current.current
    const entry: JiraImportSubmission = { ...prior, state: 'pending', acceptPartial, submittedAt: Date.now(), detail: '' }
    // Publish the immutable command/preview/consent before invoking native code.
    retained.current.set(entry.key, entry); publish()
    try {
      const result = await api.startImport({ ...entry.scope, previewId: entry.preview.id, digest: entry.preview.digest, commandId: entry.commandId, acceptPartial })
      const current = retained.current.get(entry.key)
      if (!alive.current || current?.commandId !== entry.commandId) return undefined
      // Positive job evidence can arrive via history before a delayed reply.
      if (current.job) return current.job
      if (result.ok && matchesJob(entry, result.data)) {
        retained.current.set(entry.key, { ...entry, state: result.data.state === 'unknown' ? 'unknown' : 'admitted', job: result.data, detail: result.data.state === 'unknown' ? '原作业结果待核实，请在历史记录中核实原作业。' : '' })
        publish(); return result.data
      }
      const uncertain = result.ok || !admittedOwner() || !latest.current.sourceCurrent(entry.source) || ['E_UNKNOWN', 'E_UPSTREAM', 'E_TIMEOUT', 'E_IO'].includes(result.code)
      retained.current.set(entry.key, { ...entry, state: uncertain ? 'unknown' : 'previewed', detail: result.ok ? '返回的作业与原提交身份不匹配，需核实原提交。' : result.error })
      publish()
    } catch {
      const current = retained.current.get(entry.key)
      if (alive.current && current?.commandId === entry.commandId && !current.job) {
        retained.current.set(entry.key, { ...entry, state: 'unknown', detail: '未取得原提交的确定回复，请核实原作业。' }); publish()
      }
    }
    return undefined
  }
  const observeHistory = useCallback((scope: JiraImportScope, jobs: readonly IntegrationJob[]): void => {
    if (!latest.current.current()) return
    let changed = false
    for (const [key, entry] of retained.current) {
      if (projectRootKey(entry.scope.expectedRoot) !== projectRootKey(scope.expectedRoot) || entry.scope.workspaceId !== scope.workspaceId || entry.state === 'previewed') continue
      const job = jobs.find((job) => matchesJob(entry, job))
      if (!job || entry.job && job.revision <= entry.job.revision) continue
      retained.current.set(key, { ...entry, state: job.state === 'unknown' ? 'unknown' : 'admitted', job, detail: job.state === 'unknown' ? '原作业结果待核实，请在历史记录中核实原作业。' : '' }); changed = true
    }
    if (changed) publish()
  }, [publish])
  return { entries: [...retained.current.values()], get, prepare, discard, submit, observeHistory }
}
export type JiraImportSubmissions = ReturnType<typeof useJiraImportSubmissions>
