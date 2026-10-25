import { useEffect, useState } from 'react'
import type { DaemonQuitApi, DaemonQuitState } from '../../../shared/daemon-quit'
import { api } from '../api'
import './quit.css'

export function DaemonQuitDialog(): JSX.Element {
  const bridge = (api as typeof api & { daemonQuit?: DaemonQuitApi })?.daemonQuit
  const [state, setState] = useState<DaemonQuitState | null>(null)
  const [keepRunning, setKeepRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    void bridge?.state().then(result => {
      if (!current) return
      if (result.ok) { setState(result.data); setKeepRunning(result.data.keepRunning); setError(result.data.error) }
      else setError(result.error)
    }).catch(cause => { if (current) setError(String(cause)) })
    return () => { current = false }
  }, [bridge])
  const decide = async (action: 'cancel' | 'exit'): Promise<void> => {
    if (!state || !bridge || busy) return
    setBusy(true)
    try {
      const result = await bridge.decide({ attemptId: state.attemptId, action, keepRunning })
      if (!result.ok) { setError(result.error); setBusy(false) }
    } catch (cause) { setError(String(cause)); setBusy(false) }
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); void decide('cancel') } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [state, keepRunning, busy])
  return <main className="daemon-quit" aria-labelledby="quit-title">
    <h1 id="quit-title">确定退出 Trellis Panel？</h1>
    <label className="daemon-quit-option">
      <input type="checkbox" checked={keepRunning} disabled={!state || busy} onChange={event => setKeepRunning(event.target.checked)} />
      <span>退出桌面后保留后台服务，Agent 与集成任务继续运行</span>
    </label>
    <p className="daemon-quit-warning">不勾选时，将停止后台服务及其拥有的所有 Agent 与集成任务。</p>
    {error && <p className="daemon-quit-error" role="alert">{error}</p>}
    <div className="daemon-quit-actions">
      <button autoFocus disabled={!state || busy} onClick={() => void decide('cancel')}>取消</button>
      <button className="daemon-quit-exit" disabled={!state || busy} onClick={() => void decide('exit')}>{busy ? '正在确认…' : keepRunning ? '退出并保留后台' : '停止后台并退出'}</button>
    </div>
  </main>
}
