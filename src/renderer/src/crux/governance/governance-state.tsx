import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { GovernanceCommand, GovernancePending, GovernanceReceipt, GovernanceRecoveryScope, TeamGovernanceApi } from '@shared/team-governance'
import type { TaskInputCommand, TaskInputReceipt } from '@shared/team-task-inputs'
import { Button } from '../../my/ui'

export function useGovernanceCommands(api: TeamGovernanceApi, scope: GovernanceRecoveryScope, confirmed: () => void): {
  busy: boolean; locked: boolean; pending: GovernancePending[]; error: string; notice: string;
  submit(command: GovernanceCommand | TaskInputCommand): Promise<GovernanceReceipt | TaskInputReceipt | null>;
  recover(commandId: string, retry: boolean): Promise<void>; refreshPending(): Promise<void>
} {
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<GovernancePending[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const generation = useRef(0), inFlight = useRef(false), onConfirmed = useRef(confirmed); onConfirmed.current = confirmed
  const key = JSON.stringify(scope)
  const refreshPending = useCallback(async (): Promise<void> => {
    const captured = generation.current
    const value = await api.pending(scope)
    if (captured !== generation.current) return
    if (value.ok) setPending(value.value)
    else setError(value.error)
  }, [api, key])
  useEffect(() => { generation.current++; void refreshPending(); return () => { generation.current++ } }, [refreshPending])
  const execute = async <T,>(work: () => Promise<T>, action: (value: T) => void): Promise<T | null> => {
    if (inFlight.current) return null
    const captured = generation.current
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const value = await work()
      if (captured !== generation.current) return null
      action(value)
      await refreshPending()
      return value
    } catch (cause) { if (captured === generation.current) setError(cause instanceof Error ? cause.message : '操作结果未能确认，请核对原操作。'); return null }
    finally { if (captured === generation.current) { inFlight.current = false; setBusy(false) } }
  }
  const submit = async (command: GovernanceCommand | TaskInputCommand): Promise<GovernanceReceipt | TaskInputReceipt | null> => {
    const work = async (): Promise<GovernanceReceipt | TaskInputReceipt> => {
      const reply = scope.lane === 'inputs'
        ? await api.adopt({ workspaceKey: scope.workspaceKey, spaceId: scope.spaceId, taskId: scope.taskId, taskCreatedAt: scope.taskCreatedAt, command: command as TaskInputCommand })
        : await api.command({ workspaceKey: scope.workspaceKey, spaceId: scope.spaceId, command: command as GovernanceCommand })
      if (!reply.ok) { await refreshPending(); throw new Error(reply.error + (reply.outcomeUnknown ? ' 请核对原操作。' : '')) }
      return reply.value.result
    }
    return execute(work, () => { setNotice('已由团队服务确认。'); onConfirmed.current() })
  }
  const recover = async (commandId: string, retry: boolean): Promise<void> => {
    await execute(async () => {
      const reply = retry ? await api.retry({ ...scope, commandId }) : await api.reconcile({ ...scope, commandId })
      if (!reply.ok) throw new Error(reply.error + (reply.outcomeUnknown ? ' 原结果仍待核对。' : ''))
      return reply.value
    }, value => { if (value) { setNotice('原操作已确认。'); onConfirmed.current() } else setNotice('尚未查到原回执；保留原操作，可明确重试。') })
  }
  return { busy, locked: busy || pending.some(row => row.state !== 'rejected'), pending, error, notice, submit, recover, refreshPending }
}

export function GovernanceRecovery({ commands }: { commands: ReturnType<typeof useGovernanceCommands> }): JSX.Element {
  return <div className="space-y-2">
    {commands.error && <p role="alert" className="text-my-xs text-my-danger-text">{commands.error}</p>}
    {commands.notice && <p role="status" className="text-my-xs text-my-secondary">{commands.notice}</p>}
    {commands.pending.length > 0 && <div className="space-y-2 rounded-my-md border border-my-line bg-my-layer-1 p-3" aria-label="原操作核对">
      <h4 className="text-my-xs font-medium text-my-primary">待核对操作</h4>
      {commands.pending.map(row => <div key={row.commandId} className="flex flex-wrap items-center gap-2 text-my-xs text-my-secondary">
        <span className="min-w-0 flex-1">{row.state === 'rejected' ? '操作被拒绝' : '结果待核对'}{row.error ? ` · ${row.error}` : ''}</span>
        <Button size="sm" disabled={commands.busy} onClick={() => void commands.recover(row.commandId, false)}>核对原回执</Button>
        {row.canRetry && <Button size="sm" disabled={commands.busy} onClick={() => void commands.recover(row.commandId, true)}>重试原操作</Button>}
        <details className="w-full"><summary className="cursor-pointer text-my-tertiary">操作编号</summary><code className="break-all">{row.commandId}</code></details>
      </div>)}
    </div>}
  </div>
}
