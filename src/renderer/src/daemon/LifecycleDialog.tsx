import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import type { DaemonLifecycleDecision, DaemonLifecycleDialogApi, DaemonLifecycleDialogState } from '@shared/daemon-lifecycle-dialog'
import { Button } from '../my/ui'
import { BrandMark } from '../my/BrandMark'
import { normalizeUiFontSize } from '../my/appearance'
import './quit.css'
import './lifecycle.css'

declare global {
  interface Window {
    daemonLifecycleDialog?: DaemonLifecycleDialogApi
  }
}

export function DaemonLifecycleDialog(): JSX.Element {
  const bridge = window.daemonLifecycleDialog
  const [state, setState] = useState<DaemonLifecycleDialogState | null>(null)
  const [failure, setFailure] = useState(false)
  const [busy, setBusy] = useState(false)
  const submitted = useRef(false)
  const panel = useRef<HTMLElement>(null)
  const fontSize = normalizeUiFontSize(bridge?.appearance.fontSize)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const theme = bridge?.appearance.theme ?? 'system'
  const effectiveTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark')
    document.documentElement.style.colorScheme = effectiveTheme
  }, [effectiveTheme])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setSystemDark(media.matches)
    media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update) }
  }, [])

  useEffect(() => {
    let current = true
    let reading = false
    const deadline = window.setTimeout(() => { if (current) setFailure(true) }, 8_000)
    const refresh = (): void => {
      if (!bridge) { setFailure(true); return }
      if (reading) return
      reading = true
      void bridge.state().then(result => {
        if (!current) return
        window.clearTimeout(deadline)
        if (result.ok) setState(previous => JSON.stringify(previous) === JSON.stringify(result.data) ? previous : result.data)
        else setFailure(true)
      }).catch(() => { if (current) setFailure(true) }).finally(() => { reading = false })
    }
    refresh()
    // State-only polling survives same-window reloads without adding a generic
    // event/RPC bridge or replaying a confirmation decision.
    const timer = window.setInterval(refresh, 400)
    return () => { current = false; window.clearTimeout(deadline); window.clearInterval(timer) }
  }, [bridge])

  useLayoutEffect(() => {
    submitted.current = false
    setBusy(false)
    const cancel = panel.current?.querySelector<HTMLButtonElement>('[data-lifecycle-cancel]')
    if (cancel) cancel.focus()
    else panel.current?.focus()
    if (failure) panel.current?.querySelector('section')?.scrollTo({ top: 0 })
  }, [state?.phase, failure])

  const decide = useCallback(async (action: DaemonLifecycleDecision['action']): Promise<void> => {
    if (['cancel', 'close'].includes(action) && failure) { window.close(); return }
    if (submitted.current) return
    if (!state || !bridge) {
      if (action === 'cancel') window.close()
      return
    }
    submitted.current = true
    setBusy(true)
    const deadline = window.setTimeout(() => {
      setFailure(true)
      setBusy(false)
    }, 8_000)
    try {
      const result = await bridge.decide({ attemptId: state.attemptId, action })
      if (!result.ok) {
        setFailure(true)
        submitted.current = false
        setBusy(false)
      }
    } catch {
      // Never automatically retry a possibly accepted interruption.
      setFailure(true)
      submitted.current = false
      setBusy(false)
    } finally {
      window.clearTimeout(deadline)
    }
  }, [bridge, state, failure])

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (state?.phase === 'failed') void decide('close')
        else if (!state || state.phase === 'confirmation') void decide('cancel')
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary') ?? [])
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [decide, state?.phase])

  const update = state?.reason === 'upgrade'
  const phase = state?.phase ?? 'confirmation'
  const running = ['stopping', 'terminating', 'verifying'].includes(phase)
  const exitFailed = phase === 'failed'
  const title = exitFailed ? '退出未完成' : running ? update ? '正在准备更新…' : '正在重启…'
    : update ? '停止会话并更新？' : '停止会话并重启？'
  const closeAction = exitFailed ? 'close' : 'cancel'
  const stage = { confirmation: '等待确认', stopping: '正在结束会话与后台工作', terminating: '正在完成进程清理', verifying: '正在核对退出结果', failed: '退出核验未完成' }[phase]
  return (
    <div className="my-root daemon-quit-window daemon-lifecycle-window" data-my-theme={effectiveTheme} data-my-font-size={fontSize}>
      <main ref={panel} tabIndex={-1} className="daemon-quit-panel daemon-lifecycle-panel" role={running ? 'dialog' : 'alertdialog'} aria-modal="true" aria-labelledby="lifecycle-title" aria-describedby="lifecycle-description">
        <header className="daemon-quit-header">
          <div className="daemon-quit-heading">
            <span className="daemon-quit-brand-icon" aria-hidden="true"><BrandMark className="daemon-quit-brand-svg" /></span>
            <h1 id="lifecycle-title" className="daemon-quit-title">{title}</h1>
          </div>
          {!running && <button type="button" className="daemon-quit-close no-drag" aria-label={exitFailed ? '关闭' : '取消'} title={exitFailed ? '关闭 (Esc)' : '取消 (Esc)'} disabled={busy} onClick={() => void decide(closeAction)}>
            <X size={14} />
          </button>}
        </header>
        <section className="daemon-lifecycle-body my-scrollbar">
          {failure && <p className="daemon-lifecycle-error" role="alert">确认窗口已失效，请关闭后重试。</p>}
          <p id="lifecycle-description" className="daemon-lifecycle-description">
            {exitFailed ? '尚未确认退出完成。可重试核验原请求。' : running ? '已保存的对话会保留。' : state?.uncertain ? '可能中断当前回复，已保存的对话会保留。' : '当前回复将中断，已保存的对话会保留。'}
          </p>
          {running && <p className="daemon-lifecycle-progress" role="status"><LoaderCircle className="daemon-lifecycle-spinner" size={16} aria-hidden="true" />{stage}</p>}
          {phase === 'confirmation' && state?.uncertain && <p className="my-item-description daemon-lifecycle-uncertain">暂时无法确认所有会话的运行状态。</p>}
          {phase === 'confirmation' && !!state?.sessions.length && (
            <ul className="daemon-lifecycle-sessions" aria-label="受影响的会话">
              {state.sessions.map((session, index) => (
                <li key={index} className="my-item-title" title={session.title}>{session.title || '未命名会话'}</li>
              ))}
            </ul>
          )}
          {phase === 'confirmation' && state && state.sessionCount > state.sessions.length && <p className="my-item-description">另有 {state.sessionCount - state.sessions.length} 个会话</p>}
          {exitFailed && <details className="daemon-lifecycle-details no-drag">
            <summary>查看详情</summary>
            <p>{state?.failure}</p>
            <dl><dt>原退出命令</dt><dd>{state?.commandId}</dd></dl>
          </details>}
          {!state && !failure && <p className="my-item-description" role="status">正在读取会话…</p>}
        </section>
        {!running && <footer className="daemon-quit-footer daemon-lifecycle-footer no-drag">
          <Button data-lifecycle-cancel variant="neutral" disabled={busy} onClick={() => void decide(closeAction)}>{exitFailed ? '关闭' : '取消'}</Button>
          <Button variant="primary" disabled={!state || busy || failure} onClick={() => void decide(exitFailed ? 'retry' : 'confirm')}>
            {busy ? '正在提交…' : exitFailed ? '重试退出' : update ? '停止并更新' : '停止并重启'}
          </Button>
        </footer>}
      </main>
    </div>
  )
}
