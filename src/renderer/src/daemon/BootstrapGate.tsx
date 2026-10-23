import { Component, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { BootstrapApi, BootstrapSnapshot, LegacyDaemonInspection, LegacyDaemonStopInput } from '@shared/bootstrap'
import type { DaemonFailure } from '@shared/daemon'
import { api, hasIpc } from '../api'

const labels: Record<BootstrapSnapshot['phase'], string> = {
  'window-ready': '正在连接后台', connecting: '正在连接后台', preparing: '正在准备本机状态',
  ready: '正在打开工作区', error: '后台准备未完成', incompatible: '后台版本需要处理'
}

/** An explicit bootstrap capability, independent of full desktop settings/store.
 * Keep the inspected owner frozen; native code rechecks it before dispatch. */
function LegacyDaemonUpgrade({ bridge, revision, onBlocked, onStopped }: {
  bridge: BootstrapApi; revision: number; onBlocked(blocked: boolean): void; onStopped(): Promise<void>
}): JSX.Element {
  const [inspection, setInspection] = useState<{ revision: number; data: LegacyDaemonInspection } | null>(null)
  const [pending, setPending] = useState<'inspect' | 'stop' | 'reconcile' | null>(null)
  const [failure, setFailure] = useState<DaemonFailure | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const operation = useRef(false)
  const stopUncertain = useRef(false)
  const originalStopInput = useRef<LegacyDaemonStopInput | null>(null)
  const mounted = useRef(true)
  const currentRevision = useRef(revision)
  currentRevision.current = revision
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const inspected = inspection?.revision === revision ? inspection.data : null

  const inspect = async (): Promise<void> => {
    if (operation.current || stopped || stopUncertain.current) return
    operation.current = true; setPending('inspect'); onBlocked(true)
    setInspection(null); setFailure(null); setMessage(null)
    const capturedRevision = revision
    try {
      const result = await bridge.legacyInspect()
      if (!mounted.current || currentRevision.current !== capturedRevision) return
      if (result.ok) setInspection({ revision: capturedRevision, data: result.data })
      else setFailure(result)
    } catch {
      if (mounted.current) setMessage('未能确认旧后台状态，请重新检查。')
    } finally {
      operation.current = false
      if (mounted.current) setPending(null)
      onBlocked(stopUncertain.current)
    }
  }
  const confirmStopped = async (capturedRevision: number): Promise<void> => {
    stopUncertain.current = false
    if (!mounted.current) return
    setUncertain(false); setFailure(null); setMessage(null)
    setStopped(true); setInspection(null)
    // Both the direct receipt and explicit reconciliation use the existing
    // readiness path only after the backend confirms the original owner exited.
    if (currentRevision.current === capturedRevision) await onStopped()
  }
  const stop = async (reconcile = false): Promise<void> => {
    if (operation.current || stopped) return
    if (!reconcile && (stopUncertain.current || !inspected?.canStop)) return
    const input = reconcile ? originalStopInput.current ?? undefined : inspected ? { epoch: inspected.epoch, owner: inspected.owner } : undefined
    // After a renderer reload only main retains the original target. Omission
    // asks main to observe that retained attempt; it cannot choose a new target.
    const request = reconcile ? () => bridge.legacyReconcile(input) : input ? () => bridge.legacyStop(input) : null
    if (!request) return
    if (!reconcile && input) originalStopInput.current = input
    // Synchronous latch covers two clicks before React commits disabled=true.
    operation.current = true; setPending(reconcile ? 'reconcile' : 'stop'); onBlocked(true)
    if (!reconcile) setFailure(null)
    setMessage(null)
    const capturedRevision = revision
    try {
      const result = await request()
      const noOriginal = !result.ok && reconcile && result.code === 'E_CONFLICT' && result.outcome === 'not-admitted' && !result.commandId
      if (!result.ok) {
        stopUncertain.current = result.outcome === 'unknown'
        if (noOriginal) originalStopInput.current = null
      }
      if (!mounted.current) return
      if (!result.ok) {
        setFailure(previous => noOriginal ? result : { ...result, commandId: previous?.commandId ?? result.commandId })
        setInspection(null)
        setUncertain(stopUncertain.current)
      } else if (result.data.stopped === true) {
        await confirmStopped(capturedRevision)
      } else {
        stopUncertain.current = true; setUncertain(true)
        setMessage('旧后台停止结果未获确认，请保留窗口并核对原操作。')
      }
    } catch {
      // Losing an observation reply alone does not prove any stop was admitted.
      stopUncertain.current = !reconcile || stopUncertain.current || !!originalStopInput.current
      if (mounted.current) {
        setUncertain(stopUncertain.current)
        setMessage(reconcile ? '尚未核对到原停止结果。可以再次核对，不会发送新的停止请求。' : '旧后台停止请求的回复未获确认。请保留窗口，核对原停止命令；不会再次发送停止请求。')
      }
    } finally {
      operation.current = false
      if (mounted.current) setPending(null)
      onBlocked(stopUncertain.current)
    }
  }
  return <div className="space-y-3 rounded border border-my-line p-4 text-sm" aria-busy={pending !== null}>
    <button disabled={pending !== null || stopped || uncertain} className="rounded border border-my-line px-4 py-2 hover:bg-my-layer-1-hover disabled:opacity-50" onClick={() => void inspect()}>
      {pending === 'inspect' ? '正在检查旧后台…' : '检查旧后台'}
    </button>
    {inspected && <div className="select-text space-y-2">
      <p>旧后台进程 PID：{inspected.owner.pid}</p>
      <p>进行中的后台任务：{inspected.activeJobs}；结果未确认的任务：{inspected.unknownJobs}</p>
      <p className="text-my-secondary">运行控制：{inspected.runtimeAuthority === 'legacy' ? '旧控制器' : '后台'}；设置归属：{{ legacy: '旧版', prepared: '已准备迁移', daemon: '后台' }[inspected.settingsAuthority]}</p>
      <details className="break-all text-xs text-my-secondary">
        <summary className="cursor-pointer">进程身份详情</summary>
        <dl className="space-y-1 pt-2"><dt>后台 epoch</dt><dd>{inspected.epoch}</dd><dt>进程启动标识</dt><dd>{inspected.owner.startedAt}</dd><dt>可执行文件</dt><dd>{inspected.owner.executable}</dd></dl>
      </details>
      {inspected.canStop ? <>
        <p>切换将请求安全停止上面的旧后台，再启动新版后台并准备本机状态。</p>
        <button disabled={pending !== null || uncertain || stopped} className="rounded border border-my-line px-4 py-2 hover:bg-my-layer-1-hover disabled:opacity-50" onClick={() => void stop()}>{pending === 'stop' ? '正在安全切换…' : '安全切换到新版后台'}</button>
      </> : <p>当前检查未确认可安全切换。请先通过旧版应用处理未完成任务或迁移状态，再检查旧后台。</p>}
    </div>}
    {stopped && <p>已确认旧后台停止，正在连接新版后台。准备失败时可重试连接。</p>}
    {failure && <div role="alert" className="select-text space-y-1 break-words">
      <p>{failure.error}</p><p className="text-my-secondary">{failure.code} · {failure.outcome}</p>
      {failure.commandId && <p className="break-all font-mono text-xs">原停止/检查 command ID：{failure.commandId}</p>}
    </div>}
    {message && <p role="alert">{message}</p>}
    {uncertain && <>
      <p>停止结果尚未确认，已保留原操作信息。核对只查询原停止结果，不会再次发送停止请求。</p>
    </>}
    {!stopped && <button disabled={pending !== null} className="text-xs text-my-secondary underline disabled:opacity-50" onClick={() => void stop(true)}>{pending === 'reconcile' ? '正在核对原停止结果…' : uncertain ? '核对原停止结果' : '核对上次切换结果'}</button>}
  </div>
}

/** Independent of App/store/settings imports: React.lazy rejection is caught
 * above the lazy component. Reload creates a new lazy Promise/document. */
class BootstrapAppBoundary extends Component<{ children: ReactNode; recovery: ReactNode; onFailure(): void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(): void { this.props.onFailure() }
  render(): ReactNode { return this.state.failed ? this.props.recovery : this.props.children }
}

/** Only the ordinary main renderer uses this gate. Auxiliary windows are
 * created by the ready desktop and retain their own bootstrap/quit contracts. */
export function BootstrapGate({ children }: { children: ReactNode }): JSX.Element {
  const bridge = api?.bootstrap
  const [state, setState] = useState<BootstrapSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [legacyBlocked, setLegacyBlocked] = useState(false)
  const theme = state?.ui.theme ?? (new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark')

  useEffect(() => {
    if (!bridge) return
    let current = true
    const accept = (next: BootstrapSnapshot): void => {
      if (!current) return
      setState(previous => !previous || next.revision >= previous.revision ? next : previous)
      setError(null)
    }
    // Subscribe first, then obtain a revisioned snapshot. An older get response
    // cannot overwrite ready/error delivered while that get was in flight.
    const off = bridge.onChanged(accept)
    void bridge.status().then(result => {
      if (!current) return
      if (result.ok) accept(result.data); else setError(result.error)
    }).catch(() => { if (current) setError('无法读取桌面启动状态，请重载桌面后重试。') })
    return () => { current = false; off() }
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    // Commit the actual shell, then allow a frame to paint before releasing
    // native preparation. ready-to-show alone may describe an empty document.
    let current = true
    let secondFrame: number | undefined
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        void bridge.rendered().then(result => { if (current && !result.ok) setError(result.error) })
          .catch(() => { if (current) setError('桌面显示状态未获确认，请重载后重试。') })
      })
    })
    return () => { current = false; cancelAnimationFrame(firstFrame); if (secondFrame !== undefined) cancelAnimationFrame(secondFrame) }
  }, [bridge])

  useEffect(() => {
    if (!bridge || typeof PerformanceObserver === 'undefined') return
    const report = (entry: PerformanceEntry): void => {
      if (entry.name === 'first-paint') void bridge.paint({ startTimeMs: entry.startTime }).catch(() => undefined)
    }
    const observer = new PerformanceObserver(list => list.getEntries().forEach(report))
    try { observer.observe({ type: 'paint', buffered: true }) } catch { /* No fabricated fallback paint timestamp. */ }
    return () => observer.disconnect()
  }, [bridge])

  useLayoutEffect(() => {
    if (state?.phase === 'ready') return
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
  }, [theme, state?.phase])

  const action = async (kind: 'retry' | 'exit' | 'minimize' | 'maximize'): Promise<void> => {
    if (!bridge) return
    try {
      const result = await bridge[kind]()
      if (!result.ok) setError(result.error)
      else if ('data' in result) setState(previous => !previous || result.data.revision >= previous.revision ? result.data : previous)
    } catch { setError('桌面操作未获确认，请检查后台状态后重试。') }
  }

  if (!hasIpc) return <Suspense fallback={null}>{children}</Suspense>
  const failure = state?.failure
  const legacyUpgrade = !!bridge && (state?.phase === 'error' || state?.phase === 'incompatible') && failure?.stage === 'native' && failure.code === 'E_VERSION'
  const shell = (appFailed = false): JSX.Element => <div data-my-theme={theme} className="my-root flex h-full flex-col bg-my-canvas text-my-primary">
    <header className="drag-region flex h-12 shrink-0 items-center border-b border-my-line pl-5">
      <span className="flex-1 text-sm">Trellis Panel</span>
      <div className="no-drag flex h-full">
        <button disabled={!bridge} className="w-12 hover:bg-my-layer-1-hover" aria-label="最小化" onClick={() => void action('minimize')}>−</button>
        <button disabled={!bridge} className="w-12 hover:bg-my-layer-1-hover" aria-label="切换最大化" onClick={() => void action('maximize')}>□</button>
        <button disabled={!bridge} className="w-12 hover:bg-my-layer-1-hover" aria-label="退出桌面" onClick={() => void action('exit')}>×</button>
      </div>
    </header>
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-10">
      <section className="w-full max-w-xl space-y-5" aria-live="polite" aria-busy={!failure && !error && !appFailed}>
        <h1 className="text-xl font-medium">{appFailed ? '工作区界面未能加载' : !bridge ? '桌面连接组件需要更新' : labels[state?.phase ?? 'window-ready']}</h1>
        <p className="text-sm text-my-secondary">{appFailed ? '请重载桌面界面，或退出桌面后重新打开。后台任务和原迁移记录会保留。' : failure
          ? failure.stage === 'desktop' ? '桌面功能初始化未完成。请退出并重新打开桌面，再核对本机状态。'
            : legacyUpgrade ? '当前后台与新版桌面不兼容，需要先检查旧后台。确认可安全停止后，可在这里切换到新版后台。'
              : '请检查原后台所有者、系统凭据保护或迁移记录，再重试连接。重试会继续核对原迁移。'
          : bridge ? '连接与本机状态准备完成后，将自动打开工作区。' : '请关闭窗口并重新打开应用，以加载匹配的桌面组件。'}</p>
        {state?.ui.warning && <p className="text-sm text-my-secondary">{state.ui.warning}</p>}
        {failure && <div className="select-text space-y-2 text-sm">
          {legacyUpgrade ? <details><summary className="cursor-pointer text-my-secondary">查看原始兼容性信息</summary><p className="break-words pt-2">{failure.message}</p></details> : <p>{failure.message}</p>}
          <p className="text-my-secondary">{failure.code} · {failure.outcome}</p>
          {failure.migration && <dl className="break-all font-mono text-xs">
            <dt>原迁移 command ID</dt><dd>{failure.migration.commandId}</dd>
            <dt>原 release ID</dt><dd>{failure.migration.releaseId}</dd>
          </dl>}
        </div>}
        {!appFailed && legacyUpgrade && bridge && state && <LegacyDaemonUpgrade bridge={bridge} revision={state.revision} onBlocked={setLegacyBlocked} onStopped={() => action('retry')} />}
        {error && <p role="alert" className="select-text text-sm">{error}</p>}
        {(failure || error || !bridge || appFailed) && <div className="flex gap-3">
          {!appFailed && failure?.retryable && <button disabled={legacyBlocked} className="rounded border border-my-line px-4 py-2 text-sm hover:bg-my-layer-1-hover disabled:opacity-50" onClick={() => void action('retry')}>重试连接</button>}
          {((error && !failure) || !bridge || appFailed) && <button className="rounded border border-my-line px-4 py-2 text-sm hover:bg-my-layer-1-hover" onClick={() => window.location.reload()}>重载桌面</button>}
          {bridge && <button className="rounded border border-my-line px-4 py-2 text-sm hover:bg-my-layer-1-hover" onClick={() => void action('exit')}>退出桌面</button>}
        </div>}
      </section>
    </main>
  </div>
  return state?.phase === 'ready' ? <BootstrapAppBoundary recovery={shell(true)} onFailure={() => { void bridge?.detached().catch(() => undefined) }}>
    <Suspense fallback={shell()}>{children}</Suspense>
  </BootstrapAppBoundary> : shell()
}
