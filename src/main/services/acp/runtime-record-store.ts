import type { AcpSessionRecord, AcpSessionStore } from 'acpx/runtime'
import { matchesRuntimeRecordLaunch, runtimeArgvIdentity } from './runtime-definitions'

/** Stage a path-only reconnect in memory until the native session acknowledges the same identity. */
export function runtimeRecordStore(input: {
  store: AcpSessionStore; argv: string[]; restoring: boolean
  allowHistorical(record: AcpSessionRecord): boolean
  transform(record: AcpSessionRecord | undefined): AcpSessionRecord | undefined
  redact(record: AcpSessionRecord): AcpSessionRecord
  onUpdated(record: AcpSessionRecord, staged: boolean): void
}): { store: AcpSessionStore; hasPendingCommit(): boolean; confirm(): Promise<void> } {
  let restoring = input.restoring
  let rebound = false
  let staged: AcpSessionRecord | undefined
  const store: AcpSessionStore = {
    async load(id) {
      let record = staged?.acpxRecordId === id ? structuredClone(staged) : await input.store.load(id)
      if (record && !matchesRuntimeRecordLaunch(record, input.argv)) {
        if (!restoring || !input.allowHistorical(record)) throw new Error('原 ACP 记录的启动参数与会话快照不一致；历史已保留，无法恢复')
        rebound = true
        record = { ...record, agentCommand: runtimeArgvIdentity(input.argv), agentArgv: [...input.argv] }
      }
      return input.transform(record)
    },
    async save(record) {
      const safe = input.redact(record)
      if (restoring && rebound) { staged = structuredClone(safe); input.onUpdated(staged, true); return }
      await input.store.save(safe)
      input.onUpdated(safe, false)
    }
  }
  return { store, hasPendingCommit: () => staged !== undefined, async confirm() {
    if (staged) { await input.store.save(staged); staged = undefined }
    restoring = false
  } }
}
