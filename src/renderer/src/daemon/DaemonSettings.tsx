import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { hasDaemonApi, type DaemonApi, type DaemonPreferences, type DaemonStatus } from '../../../shared/daemon'
import { confirmDialog } from '../components/Dialogs'
import { useInteractionSignal } from '../utils/interaction-scope'

export function DaemonSettings(): JSX.Element {
  const candidate = (api as typeof api & { daemon?: DaemonApi })?.daemon
  const bridge = hasDaemonApi(candidate) ? candidate : null
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [draft, setDraft] = useState<DaemonPreferences | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState<Array<{ at: number; code: string }>>([])
  const mounted = useRef(false), signal = useInteractionSignal()
  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge) return
    const result = await bridge.status()
    if (!mounted.current) return
    if (result.ok) { setStatus(result.data); setDraft(result.data.preferences); setError(null) }
    else { setStatus(null); setError(result.error) }
  }, [bridge])
  useEffect(() => { mounted.current = true; void refresh().catch(reason => { if (mounted.current) setError(String(reason)) }); return () => { mounted.current = false } }, [refresh])
  const action = async (kind: 'start' | 'stop' | 'restart' | 'save' | 'logs' | 'reconcile'): Promise<void> => {
    if (!bridge || busy) return
    if ((kind === 'stop' || kind === 'restart') && !await confirmDialog({ title: kind === 'stop' ? '停止后台守护进程？' : '重启后台守护进程？', message: '将先停止此后台服务实际拥有的 Agent 任务。未核实的停止结果会保留并显示，远端未知结果仍需核对。', confirmText: '停止拥有的任务并继续', danger: true }, signal)) return
    if (signal?.aborted) return
    setBusy(true); setError(null)
    try {
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
      const result = kind === 'save' ? draft ? await bridge.setPreferences(draft) : null : await bridge[kind]()
      if (!mounted.current || !result) return
      if (!result.ok) setError(result.error)
      else if (kind === 'stop') { setStatus(null); setLogs([]) }
      else await refresh()
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <section className="rounded-my-lg border border-my-line bg-my-layer-2 px-5 py-4" aria-labelledby="daemon-settings-title">
    <h2 id="daemon-settings-title" className="mb-1 text-my-xs font-semibold text-my-secondary">后台守护进程</h2>
    <p className="mb-3 text-my-xs leading-5 text-my-tertiary">Agent 与集成任务由独立后台服务执行。退出时可选择保留；重新打开会连接原有会话。</p>
    {!bridge ? <p className="text-my-xs text-my-tertiary">当前桌面版本未提供后台管理接口。</p> : <>
      <p className="mb-3 text-my-xs text-my-secondary">{status ? `${status.state === 'running' ? '运行中' : '正在停止'} · ${status.runtimeAuthority === 'daemon' ? '后台拥有 Runtime' : 'Runtime 尚未迁移'} · ${status.activeJobs} 个活动任务 · ${status.unknownJobs} 个结果待核对` : '后台状态未确认'}</p>
      {draft && <div className="space-y-3 text-my-xs text-my-secondary">
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.keepRunning} disabled={busy} onChange={event => setDraft({ ...draft, keepRunning: event.target.checked })} />退出时默认保持后台运行</label>
        <label className="flex items-center gap-3">启动方式<select className="my-input" value={draft.startup} disabled={busy} onChange={event => setDraft({ ...draft, startup: event.target.value as DaemonPreferences['startup'] })}>
          <option value="client">打开桌面时启动</option><option value="login">登录系统时启动</option><option value="manual">仅手动启动</option>
        </select></label>
        <p className="text-my-tertiary">系统启动注册：{status?.startupRegistration === 'confirmed' ? '已核实' : status?.startupRegistration === 'unknown' ? '结果待核对' : '不可用'}。手动启动服务后仍可保留到桌面退出。</p>
        {status?.startupRegistration === 'unknown' && status.startupCommandId && <div className="space-y-2">
          <p className="break-all text-my-tertiary">原启动注册命令：{status.startupCommandId}</p>
          {typeof bridge.reconcileStartup === 'function'
            ? <button className="my-btn" disabled={busy} onClick={() => void action('reconcile')}>核对原启动注册</button>
            : <p className="text-my-tertiary">当前桌面未加载启动注册对账接口，请完整重启应用。</p>}
        </div>}
      </div>}
      <div className="mt-4 flex flex-wrap gap-2">
        {([['start', '启动'], ['stop', '停止'], ['restart', '重启'], ['save', '保存设置'], ['logs', '查看日志']] as const).map(([kind, label]) => <button key={kind} className="my-btn" disabled={busy || (kind === 'save' && !draft) || (['stop', 'restart', 'logs'].includes(kind) && !status)} onClick={() => void action(kind)}>{label}</button>)}
        <button className="my-btn" disabled={busy} onClick={() => void refresh().catch(cause => setError(String(cause)))}>刷新状态</button>
      </div>
      {error && <p className="mt-3 text-my-xs text-red-500" role="alert">{error}</p>}
      {!!logs.length && <ol className="mt-3 max-h-44 overflow-auto rounded border border-my-line p-3 font-mono text-my-xs text-my-tertiary">{logs.map((entry, index) => <li key={`${entry.at}:${index}`}>{new Date(entry.at).toLocaleTimeString()} {entry.code}</li>)}</ol>}
    </>}
  </section>
}
