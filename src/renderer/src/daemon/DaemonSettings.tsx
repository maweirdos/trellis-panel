import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../api'
import { hasDaemonApi, type DaemonApi, type DaemonPreferences, type DaemonStatus } from '../../../shared/daemon'
import { confirmDialog } from '../components/Dialogs'
import { useInteractionSignal } from '../utils/interaction-scope'
import { Button, Switch } from '../my/ui'
import { PreferenceRow, PreferenceSection } from '../pages/settings/PreferenceSection'

export function DaemonSettings(): JSX.Element {
  const instanceId = useId()
  const sectionId = `daemon-settings-${instanceId}`
  const startupId = `${sectionId}-startup`
  const candidate = (api as typeof api & { daemon?: DaemonApi })?.daemon
  const bridge = hasDaemonApi(candidate) ? candidate : null
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [confirmedStopped, setConfirmedStopped] = useState(false)
  const [draft, setDraft] = useState<DaemonPreferences | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState<Array<{ at: number; code: string }>>([])
  const actionPending = useRef(false)
  const mounted = useRef(false), signal = useInteractionSignal()
  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge) return
    const result = await bridge.status()
    if (!mounted.current) return
    setConfirmedStopped(false)
    if (result.ok) { setStatus(result.data); setDraft(result.data.preferences); setError(null) }
    else { setStatus(null); setError(result.error) }
  }, [bridge])
  useEffect(() => { mounted.current = true; void refresh().catch(reason => { if (mounted.current) setError(String(reason)) }); return () => { mounted.current = false } }, [refresh])
  const action = async (kind: 'start' | 'stop' | 'restart' | 'save' | 'logs' | 'reconcile' | 'quit'): Promise<void> => {
    if (actionPending.current || (kind === 'quit' ? typeof api?.appQuit !== 'function' : !bridge)) return
    actionPending.current = true
    setBusy(true); setError(null)
    try {
      if (!mounted.current || signal?.aborted) return
      if (kind === 'quit') {
        const result = await api.appQuit?.()
        if (mounted.current && result && !result.ok) setError(result.error)
        return
      }
      if (!bridge) return
      if ((kind === 'stop' || kind === 'restart') && !await confirmDialog({ title: kind === 'stop' ? '停止后台守护进程？' : '重启后台守护进程？', message: '将停止此后台服务实际拥有的所有 Agent 与集成任务，包括正在运行的任务。未核实的停止结果需核对原命令。', confirmText: '停止所有后台任务并继续', danger: true }, signal)) return
      if (!mounted.current || signal?.aborted) return
      if (kind === 'reconcile') {
        const originalCommandId = status?.startupCommandId
        if (!originalCommandId || typeof bridge.reconcileStartup !== 'function') { setError('当前桌面未提供原启动命令对账接口，请完整重启应用后刷新状态。'); return }
        const result = await bridge.reconcileStartup(originalCommandId)
        if (!mounted.current) return
        if (result.ok) await refresh(); else setError(result.error)
        return
      }
      if (kind === 'logs') {
        const result = await bridge.logs({ limit: 50 })
        if (!mounted.current) return
        if (result.ok) setLogs(result.data.entries); else setError(result.error)
        return
      }
      if (kind === 'start' || kind === 'restart') setConfirmedStopped(false)
      const result = kind === 'save' ? draft ? await bridge.setPreferences(draft) : null : await bridge[kind]()
      if (!mounted.current || !result) return
      if (!result.ok) setError(`${result.error}${result.commandId ? `（原命令：${result.commandId}）` : ''}`)
      else if (kind === 'stop') { setStatus(null); setConfirmedStopped(true); setLogs([]) }
      else await refresh()
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { actionPending.current = false; if (mounted.current) setBusy(false) }
  }
  return <PreferenceSection id={sectionId} title="后台运行">
    {!bridge ? <p className="py-3 text-my-sm text-my-tertiary">当前桌面版本未提供后台管理接口。</p> : <>
      <PreferenceRow label="后台服务">
        <span role="status" className="text-my-secondary">{status ? status.state === 'running' ? '运行中' : '正在停止' : confirmedStopped ? '已停止' : '状态未确认'}</span>
        <Button size="sm" variant="outline" disabled={busy || !!status} aria-label="启动后台服务" onClick={() => void action('start')}>启动</Button>
        <Button size="sm" variant="ghost" disabled={busy || !status} aria-label="停止后台服务" onClick={() => void action('stop')}>停止</Button>
        <Button size="sm" variant="ghost" disabled={busy || !status} aria-label="重启后台服务" onClick={() => void action('restart')}>重启</Button>
        <Button size="sm" variant="ghost" disabled={busy} aria-label="刷新后台状态" onClick={() => void refresh().catch(cause => setError(String(cause)))}>刷新</Button>
      </PreferenceRow>
      {status && <PreferenceRow label="后台任务">
        <span className="text-my-secondary">{status.activeJobs} 个运行中</span>
        {status.unknownJobs > 0 && <span className="text-my-warning-text">{status.unknownJobs} 个结果待核对</span>}
        {status.runtimeAuthority !== 'daemon' && <span className="text-my-warning-text">Runtime 尚未迁移</span>}
      </PreferenceRow>}
      {draft && <>
        <PreferenceRow label="退出后继续运行">
          <Switch label="退出后继续运行" checked={draft.keepRunning} disabled={busy} onChange={keepRunning => setDraft({ ...draft, keepRunning })} />
        </PreferenceRow>
        <PreferenceRow label="启动方式" htmlFor={startupId}>
          <select id={startupId} className="my-input" value={draft.startup} disabled={busy} onChange={event => setDraft({ ...draft, startup: event.target.value as DaemonPreferences['startup'] })}>
            <option value="client">打开桌面时启动</option><option value="login">登录系统时启动</option><option value="manual">仅手动启动</option>
          </select>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void action('save')}>{busy ? '处理中…' : '保存后台设置'}</Button>
        </PreferenceRow>
        {(draft.startup === 'login' || status?.startupRegistration === 'unknown') && <PreferenceRow label="系统启动注册">
          <span className={status?.startupRegistration === 'unknown' ? 'text-my-warning-text' : 'text-my-secondary'}>{status?.startupRegistration === 'confirmed' ? '已核实' : status?.startupRegistration === 'unknown' ? '结果待核对' : '不可用'}</span>
          {status?.startupRegistration === 'unknown' && status.startupCommandId && <>
            {typeof bridge.reconcileStartup === 'function'
              ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void action('reconcile')}>核对原启动注册</Button>
              : <span className="text-my-xs text-my-tertiary">请完整重启应用以加载核对接口。</span>}
            <details className="w-full text-my-xs text-my-tertiary"><summary className="cursor-pointer">原命令</summary><p className="mt-2 break-all">{status.startupCommandId}</p></details>
          </>}
        </PreferenceRow>}
      </>}
      <PreferenceRow label="运行日志">
        <Button size="sm" variant="outline" disabled={busy || !status} onClick={() => void action('logs')}>查看日志</Button>
      </PreferenceRow>
      {!!logs.length && <ol aria-label="后台运行日志" className="my-scrollbar max-h-44 overflow-auto rounded-my-md border border-my-line p-3 font-mono text-my-xs text-my-tertiary">{logs.map((entry, index) => <li key={`${entry.at}:${index}`}>{new Date(entry.at).toLocaleTimeString()} {entry.code}</li>)}</ol>}
    </>}
    {error && <p className="py-3 text-my-sm text-my-danger-text" role="alert">{error}</p>}
    <PreferenceRow label="应用">
      <Button size="sm" variant="ghost" disabled={busy || typeof api?.appQuit !== 'function'} onClick={() => void action('quit')}>退出应用</Button>
    </PreferenceRow>
  </PreferenceSection>
}
