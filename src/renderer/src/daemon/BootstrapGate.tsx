import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { BootstrapApi, BootstrapSnapshot, DaemonTakeoverDiagnostics, LegacyDaemonInspection, LegacyDaemonStopInput, WorkcopyOwner, WorkcopyRecoveryResult } from '@shared/bootstrap'
import type { DaemonFailure } from '@shared/daemon'
import { api, hasIpc } from '../api'
import { BrandMark } from '../my/BrandMark'
import { StartupSplash } from './StartupSplash'
import { startStartupBrandHandoff } from './startup-brand-handoff'
import { StartupContext, type StartupContentSlot } from './StartupContext'
import { syncNativeUiFontSize, UI_PREFERENCES_KEY } from '../my/appearance'

const labels: Record<BootstrapSnapshot['phase'], string> = {
  'window-ready': '正在连接后台', connecting: '正在连接后台', preparing: '正在准备本机状态',
  ready: '正在打开工作区', error: '后台准备未完成', incompatible: '后台版本需要处理'
}

const blockerDomainLabels: Record<DaemonTakeoverDiagnostics['blockers'] extends (infer T)[] | undefined ? T extends { domain: infer D } ? D : never : never, string> = {
  runtime: 'Runtime', workflow: '工作流', application: '应用', 'work-copy': '工作副本', scheduler: '后台任务', stop: '停止清理'
}
const evidenceLabels = { 'job-witness': '受控 Job 见证', 'kernel-transition': '内核代次转换', 'cleanup-receipt': '清理回执' } as const

/** Read-only takeover facts. It deliberately has no recovery authority. */
function DaemonTakeoverPanel({ bridge, snapshot, revision, onError }: {
  bridge: BootstrapApi; snapshot: BootstrapSnapshot; revision: number; onError(error: { message: string; code?: string }): void
}): JSX.Element | null {
  const [status, setStatus] = useState<DaemonTakeoverDiagnostics | null>(snapshot.takeover ?? null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [recovering, setRecovering] = useState<string | null>(null)
  const mounted = useRef(true)
  const autoRefreshed = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (revision !== snapshot.revision || (!snapshot.takeover && status)) setStatus(snapshot.takeover ?? null)
  }, [revision, snapshot.revision, snapshot.takeover, status])
  const refresh = useCallback(async (): Promise<void> => {
    if (pending) return
    setPending(true); setFailed(false)
    try {
      const result = await bridge.takeoverStatus()
      if (!mounted.current) return
      if (result.ok) setStatus(result.data)
      else { setFailed(true); onError({ message: result.error, code: result.code }) }
    } catch (cause) {
      if (mounted.current) {
        setFailed(true)
        onError({ message: cause instanceof Error ? cause.message : String(cause) })
      }
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [bridge, onError, pending])
  const recover = useCallback(async (leaseId: string, owner: WorkcopyOwner, acceptedEvidence: keyof typeof evidenceLabels): Promise<void> => {
    if (!leaseId || !status || recovering || pending) return
    setRecovering(leaseId)
    try {
      const result = await bridge.workcopyRecovery({ leaseId, owner, acceptedEvidence })
      if (!mounted.current) return
      if (!result.ok) onError({ message: result.error, code: result.code })
    } catch (cause) {
      if (mounted.current) onError({ message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (mounted.current) setRecovering(null)
      void refresh()
    }
  }, [bridge, onError, pending, recovering, refresh, status])
  useEffect(() => {
    if (autoRefreshed.current || snapshot.takeover) return
    autoRefreshed.current = true
    void refresh()
  }, [refresh, snapshot.takeover])
  const running = status?.state === 'running'
  const activeWork = status ? status.activeJobs + status.unknownJobs > 0 || (status.blockers?.some(blocker => blocker.state === 'active') ?? false) : false
  const unknownWork = status ? status.unknownJobs > 0 || (status.blockers?.some(blocker => blocker.state === 'unknown') ?? false) : false
  return <section className="my-startup-takeover" aria-labelledby="startup-takeover-title">
    <div className="my-startup-takeover-heading">
      <h2 id="startup-takeover-title" className="my-item-title">后台接管状态</h2>
      <span className="my-startup-takeover-state">{running ? '运行中' : '停止中'}</span>
    </div>
    <p className="my-item-description">
      {status?.buildCompatibility === 'changed' ? '现有后台来自另一个构建；本面板仅显示状态，不会终止进程。' : '正在核对现有后台与当前构建。'}
      {activeWork ? '存在进行中的工作，已保留原后台。' : unknownWork ? '存在结果未知的工作，已保留原后台。' : '等待原后台释放后再重试连接。'}
    </p>
    <div className="my-startup-actions">
      <button disabled={pending} className="my-control my-button-neutral" onClick={() => void refresh()}>{pending ? '正在刷新…' : failed ? '重新检查状态' : '刷新状态'}</button>
    </div>
    <details className="my-startup-details">
      <summary>后台详情</summary>
      <div className="my-startup-diagnostics">
        {status && <dl>
          <dt>后台状态</dt><dd>{running ? 'running' : 'stopping'}</dd>
          <dt>构建兼容性</dt><dd>{status.buildCompatibility === 'current' ? 'current' : status.buildCompatibility === 'changed' ? 'changed' : 'unknown'}</dd>
          <dt>产品版本</dt><dd>{status.identities.productVersion}</dd>
          <dt>协议版本</dt><dd>{status.identities.protocolVersion}</dd>
          <dt>安装身份</dt><dd>{status.identities.installationId}</dd>
          {status.identities.ownerBuildSha256 && <><dt>原后台构建指纹</dt><dd>{status.identities.ownerBuildSha256}</dd></>}
          {status.identities.currentBuildSha256 && <><dt>当前构建指纹</dt><dd>{status.identities.currentBuildSha256}</dd></>}
          <dt>进行中的任务</dt><dd>{status.activeJobs}</dd>
          <dt>结果未确认的任务</dt><dd>{status.unknownJobs}</dd>
          {status.stopCommandId && <><dt>保留的停止 command ID</dt><dd>{status.stopCommandId}</dd></>}
        </dl>}
        {status?.blockers?.length ? <ul className="my-startup-blockers">
          {status.blockers.map((blocker, index) => {
            const leaseId = blocker.leaseId
            const owner: WorkcopyOwner | null = leaseId && blocker.domain === 'work-copy' && blocker.owner ? blocker.owner : null
            return <li key={`${blocker.domain}-${index}`}>
            <span className="my-item-title">{blocker.label}</span>
            <span className="my-item-description">
              {blockerDomainLabels[blocker.domain]} · {blocker.state === 'active' ? '进行中' : '结果未知'}
              {blocker.requiredEvidence.length ? ` · 需要证据：${blocker.requiredEvidence.map(evidence => evidenceLabels[evidence]).join(' / ')}` : ''}
            </span>
            {owner && leaseId && blocker.requiredEvidence.length ? <button
              disabled={recovering !== null || pending}
              className="my-control my-button-neutral"
              onClick={() => void recover(leaseId, owner, blocker.requiredEvidence[0])}
            >{recovering === leaseId ? '正在核对清理…' : `按${evidenceLabels[blocker.requiredEvidence[0]]}清理`}</button> : null}
          </li>
          })}
        </ul> : <p>当前没有额外的工作副本阻塞项。</p>}
      </div>
    </details>
  </section>
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
  const [inspectionTimedOut, setInspectionTimedOut] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const operation = useRef(false)
  const stopUncertain = useRef(false)
  // Automatic inspection is a one-shot convenience for a fresh bootstrap
  // shell. It must not be keyed to the bootstrap revision: a failed retry
  // publishes a new revision, and coupling the two creates
  // inspect -> retry -> revision -> inspect loops when no historical owner
  // exists (the common E_UNAVAILABLE/not-admitted case).
  const autoInspectAttempted = useRef(false)
  const originalStopInput = useRef<LegacyDaemonStopInput | null>(null)
  const mounted = useRef(true)
  const currentRevision = useRef(revision)
  const inspectionAttempt = useRef(0)
  const inspectionTimer = useRef<number | undefined>(undefined)
  currentRevision.current = revision
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (inspectionTimer.current !== undefined) window.clearTimeout(inspectionTimer.current)
    }
  }, [])
  const inspected = inspection?.revision === revision ? inspection.data : null

  const inspect = async (): Promise<void> => {
    if (operation.current || stopped || stopUncertain.current) return
    operation.current = true; setPending('inspect'); onBlocked(true)
    setInspection(null); setFailure(null); setMessage(null); setInspectionTimedOut(false)
    const capturedRevision = revision
    const capturedAttempt = ++inspectionAttempt.current
    // Native identity/DPAPI/pipe inspection has bounded subprocess and
    // request timers, but those layers can still take several seconds in a
    // locked Windows session. Release the renderer latch after 20s so a stuck
    // check never leaves the shell permanently showing "正在检查旧后台".
    inspectionTimer.current = window.setTimeout(() => {
      if (!mounted.current || !operation.current || inspectionAttempt.current !== capturedAttempt) return
      inspectionAttempt.current += 1 // Ignore the eventual late IPC reply.
      operation.current = false
      setPending(null)
      setInspectionTimedOut(true)
      setMessage('检查旧后台超过 20 秒，已停止等待。请退出桌面后重试；不会自动重试或替换原后台。')
      onBlocked(false)
    }, 20_000)
    try {
      const result = await bridge.legacyInspect()
      if (!mounted.current || currentRevision.current !== capturedRevision || inspectionAttempt.current !== capturedAttempt) return
      if (!result.ok && result.code === 'E_UNAVAILABLE' && /No verified historical daemon owner is running/.test(result.error)) {
        // A missing historical owner is not proof that the native migration
        // itself is complete. Retrying here can reproduce the same durable
        // migration failure and, when the bootstrap revision changes, trigger
        // another automatic inspection. Keep the shell interactive and leave
        // the final retry to the user after the original diagnostic is visible.
        setMessage('未发现仍在运行的旧后台。请查看诊断详情后手动重试连接。')
        return
      }
      if (result.ok) setInspection({ revision: capturedRevision, data: result.data })
      else setFailure(result)
    } catch {
      if (mounted.current && inspectionAttempt.current === capturedAttempt) setMessage('未能确认旧后台状态，请重新检查。')
    } finally {
      if (inspectionTimer.current !== undefined) {
        window.clearTimeout(inspectionTimer.current)
        inspectionTimer.current = undefined
      }
      // A timed-out attempt has already released the latch and invalidated its
      // result. The late native reply must not re-enable or overwrite a newer
      // user-visible state.
      if (inspectionAttempt.current === capturedAttempt) {
        operation.current = false
        if (mounted.current) setPending(null)
        onBlocked(stopUncertain.current)
      }
    }
  }
  useEffect(() => {
    if (autoInspectAttempted.current || stopped || uncertain) return
    autoInspectAttempted.current = true
    void inspect()
    // The revision fence inside inspect() owns stale-result protection. This
    // effect only removes the extra click from the initial startup path; it is
    // intentionally one-shot so a retry cannot create a feedback loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])
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
  const status = pending === 'inspect' ? '正在检查旧后台。'
    : pending === 'stop' ? '正在安全切换到新版后台。'
      : pending === 'reconcile' ? '正在核对原停止结果。'
        : uncertain ? '停止结果尚未确认，核对只查询原操作。'
          : stopped ? '旧后台已停止，正在连接新版。'
          : inspectionTimedOut ? '旧后台检查超时，已停止等待。'
            : failure || message ? '旧后台操作未完成，请查看详情后重试。'
              : inspected ? inspected.canStop ? '旧后台已空闲，切换将安全停止并连接新版。' : '暂时无法安全切换，请先在旧版应用中处理。'
                : '检查旧后台后可继续。'
  return <div className="my-startup-legacy" aria-busy={pending !== null}>
    <p className="my-startup-recovery-copy" role="status" aria-live="polite">{status}</p>
    <div className="my-startup-actions">
      <button disabled={pending !== null || stopped || uncertain} className="my-control my-button-neutral" onClick={() => void inspect()}>
        {pending === 'inspect' ? '正在检查…' : '检查旧后台'}
      </button>
      {inspected?.canStop && <button disabled={pending !== null || uncertain || stopped} className="my-control my-button-primary" onClick={() => void stop()}>{pending === 'stop' ? '正在安全切换…' : '安全切换到新版后台'}</button>}
      {!stopped && <button disabled={pending !== null} className="my-control my-button-ghost" onClick={() => void stop(true)}>{pending === 'reconcile' ? '正在核对…' : uncertain ? '核对原停止结果' : '核对上次切换结果'}</button>}
    </div>
    {inspected && <details className="my-startup-details">
      <summary>检查详情</summary>
      <div className="my-startup-diagnostics"><dl>
        <dt>旧后台进程 PID</dt><dd>{inspected.owner.pid}</dd>
        <dt>进行中的后台任务</dt><dd>{inspected.activeJobs}</dd>
        <dt>结果未确认的任务</dt><dd>{inspected.unknownJobs}</dd>
        <dt>运行控制</dt><dd>{inspected.runtimeAuthority === 'legacy' ? '旧控制器' : '后台'}</dd>
        <dt>设置归属</dt><dd>{{ legacy: '旧版', prepared: '已准备迁移', daemon: '后台' }[inspected.settingsAuthority]}</dd>
        <dt>后台 epoch</dt><dd>{inspected.epoch}</dd>
        <dt>进程启动标识</dt><dd>{inspected.owner.startedAt}</dd>
        <dt>可执行文件</dt><dd>{inspected.owner.executable}</dd>
      </dl></div>
    </details>}
    {(failure || message) && <details className="my-startup-details">
      <summary>操作详情</summary>
      <div className="my-startup-diagnostics">
        {failure && <><p>{failure.error}</p><dl>
          <dt>错误代码</dt><dd>{failure.code}</dd>
          <dt>操作结果</dt><dd>{failure.outcome}</dd>
          {failure.commandId && <><dt>原停止/检查 command ID</dt><dd>{failure.commandId}</dd></>}
        </dl></>}
        {message && <p>{message}</p>}
      </div>
    </details>}
  </div>
}

/** Independent of App/store/settings imports: React.lazy rejection is caught
 * above the lazy component. Reload creates a new lazy Promise/document. */
class BootstrapAppBoundary extends Component<{ children: ReactNode; recovery(error: unknown): ReactNode; onFailure(error: unknown): void }, { failed: boolean; error: unknown }> {
  state: { failed: boolean; error: unknown } = { failed: false, error: null }
  static getDerivedStateFromError(error: unknown): { failed: boolean; error: unknown } { return { failed: true, error } }
  componentDidCatch(error: unknown): void { this.props.onFailure(error) }
  render(): ReactNode { return this.state.failed ? this.props.recovery(this.state.error) : this.props.children }
}

/** Only the ordinary main renderer uses this gate. Auxiliary windows are
 * created by the ready desktop and retain their own bootstrap/quit contracts. */
export function BootstrapGate({ children, preloadApp }: { children: ReactNode; preloadApp?: () => void }): JSX.Element {
  const bridge = api?.bootstrap
  const [state, setState] = useState<BootstrapSnapshot | null>(null)
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
  const [legacyBlocked, setLegacyBlocked] = useState(false)
  const [appFailure, setAppFailure] = useState<{ error: unknown } | null>(null)
  const [handoff, setHandoff] = useState<'covered' | 'revealing' | 'revealed'>('covered')
  const theme = state?.ui.theme ?? (new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark')
  const appEligible = !!bridge && state?.phase === 'ready' && !state.failure && !error
  const revealEnabled = useRef(false)
  const handoffPhase = useRef(handoff)
  const revealAttempt = useRef(0)
  const handoffRoot = useRef<HTMLDivElement>(null)
  const handoffCleanup = useRef<(() => void) | undefined>(undefined)
  const contentSlots = useRef(new Set<StartupContentSlot>())
  const releaseFrames = useRef<{ first?: number; second?: number }>({})

  const cancelRelease = useCallback(() => {
    const frames = releaseFrames.current
    if (frames.first !== undefined) cancelAnimationFrame(frames.first)
    if (frames.second !== undefined) cancelAnimationFrame(frames.second)
    releaseFrames.current = {}
  }, [])
  const cancelHandoff = useCallback(() => {
    handoffCleanup.current?.()
    handoffCleanup.current = undefined
  }, [])
  const contentChanged = useCallback(() => {
    cancelRelease()
    const allCommitted = (): boolean => contentSlots.current.size > 0 && [...contentSlots.current].every(slot => slot.commits.size > 0)
    if (!revealEnabled.current || handoffPhase.current === 'revealed') return
    if (handoffPhase.current === 'revealing') {
      if (allCommitted()) return
      // Live focus/navigation can replace primary content during the first fade.
      // Revoke that attempt synchronously; ordinary revealed navigation is final.
      revealAttempt.current += 1
      cancelHandoff()
      handoffPhase.current = 'covered'
      setHandoff('covered')
    }
    if (!allCommitted()) return
    // A primary commit can be replaced in a parent layout effect (saved route,
    // task focus, error fallback). Only still-owned content may release the cover.
    releaseFrames.current.first = requestAnimationFrame(() => {
      releaseFrames.current.second = requestAnimationFrame(() => {
        releaseFrames.current = {}
        if (!revealEnabled.current || handoffPhase.current !== 'covered' || !allCommitted()) return
        revealAttempt.current += 1
        const next = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'revealed' : 'revealing'
        handoffPhase.current = next
        setHandoff(next)
      })
    })
  }, [cancelRelease, cancelHandoff])
  const registerContent = useCallback((slot: StartupContentSlot) => {
    contentSlots.current.add(slot)
    contentChanged()
    return () => { contentSlots.current.delete(slot); contentChanged() }
  }, [contentChanged])
  const presentation = useMemo(() => ({ initialTheme: theme, register: registerContent, changed: contentChanged }), [theme, registerContent, contentChanged])

  useLayoutEffect(() => {
    revealEnabled.current = appEligible && !appFailure
    if (!revealEnabled.current && handoffPhase.current !== 'revealed') {
      revealAttempt.current += 1
      cancelHandoff()
      handoffPhase.current = 'covered'
      setHandoff('covered')
    }
    contentChanged()
    return () => { revealEnabled.current = false; cancelRelease(); cancelHandoff() }
  }, [appEligible, appFailure, contentChanged, cancelRelease, cancelHandoff])

  useLayoutEffect(() => {
    if (handoff !== 'revealing' || handoffPhase.current !== 'revealing' || !revealEnabled.current) return
    const attempt = revealAttempt.current
    const finish = (): void => {
      if (attempt !== revealAttempt.current || handoffPhase.current !== 'revealing' || !revealEnabled.current) return
      if (!contentSlots.current.size || [...contentSlots.current].some(slot => slot.commits.size === 0)) { contentChanged(); return }
      handoffPhase.current = 'revealed'
      setHandoff('revealed')
    }
    const root = handoffRoot.current
    if (!root) { finish(); return }
    const cleanup = startStartupBrandHandoff(root, finish)
    handoffCleanup.current = cleanup
    return () => {
      cleanup()
      if (handoffCleanup.current === cleanup) handoffCleanup.current = undefined
    }
  }, [handoff, appEligible, appFailure, contentChanged])

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
      if (result.ok) accept(result.data); else setError({ message: result.error, code: result.code })
    }).catch(cause => { if (current) setError({ message: cause instanceof Error ? cause.stack || cause.message : String(cause) }) })
    return () => { current = false; off() }
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    syncNativeUiFontSize(bridge)
    const changed = (event: StorageEvent): void => {
      if (event.key === UI_PREFERENCES_KEY || event.key === null) syncNativeUiFontSize(bridge)
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    // Commit the actual shell, then allow a frame to paint before releasing
    // native preparation. ready-to-show alone may describe an empty document.
    let current = true
    let secondFrame: number | undefined
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        // 受限首屏已提交并开始连接后台时，并行预取 App 分包脚本以消除 ready 后的串行加载；
        // 仍严格延迟挂载直到 phase === 'ready'，加载异常保留给外层 BootstrapAppBoundary 捕获。
        preloadApp?.()
        void bridge.rendered().then(result => { if (current && !result.ok) setError({ message: result.error, code: result.code }) })
          .catch(cause => { if (current) setError({ message: cause instanceof Error ? cause.stack || cause.message : String(cause) }) })
      })
    })
    return () => { current = false; cancelAnimationFrame(firstFrame); if (secondFrame !== undefined) cancelAnimationFrame(secondFrame) }
  }, [bridge, preloadApp])

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
      if (kind === 'retry') {
        const result = await bridge.retry()
        if (!result.ok) setError({ message: result.error, code: result.code })
        else setState(previous => !previous || result.data.revision >= previous.revision ? result.data : previous)
      } else {
        const result = await bridge[kind]()
        if (!result.ok) setError({ message: result.error, code: result.code })
      }
    } catch (cause) { setError({ message: cause instanceof Error ? cause.stack || cause.message : String(cause) }) }
  }

  if (!hasIpc) return <Suspense fallback={null}>{children}</Suspense>
  const failure = state?.failure
  // Historical inspection is read-only and independently fenced by main.
  // Offer it for native E_UNAVAILABLE as well: an old owner may be live while
  // ordinary startup cannot attach its protected credential, and a generic
  // retry leaves the user trapped waiting for the old backend.
  const legacyUpgrade = !!bridge && (state?.phase === 'error' || state?.phase === 'incompatible') && failure?.stage === 'native' && ['E_VERSION', 'E_UNAVAILABLE'].includes(failure.code)
  const shell = (workspaceFailure?: { error: unknown }): JSX.Element => {
    const failed = !!(failure || error || !bridge || workspaceFailure || state?.phase === 'error' || state?.phase === 'incompatible')
    return <div data-my-theme={theme} className="my-root my-startup-window">
    <div className="my-startup-backdrop" aria-hidden="true" />
    <header className="drag-region my-startup-titlebar">
      <div className="no-drag my-startup-window-controls">
        <button disabled={!bridge} aria-label="最小化" onClick={() => void action('minimize')}><span aria-hidden="true">−</span></button>
        <button disabled={!bridge} aria-label="切换最大化" onClick={() => void action('maximize')}><span aria-hidden="true">□</span></button>
        <button disabled={!bridge} aria-label="退出桌面" onClick={() => void action('exit')}><span aria-hidden="true">×</span></button>
      </div>
    </header>
    <main className="my-startup-stage">
      {failed ? <section className="my-startup-recovery" aria-labelledby="startup-recovery-title">
        <div className="my-startup-recovery-heading" role="alert">
          <BrandMark size={32} />
          <h1 id="startup-recovery-title">{workspaceFailure ? '工作区未能打开' : !bridge ? '请重新打开应用' : legacyUpgrade ? '后台需要升级' : '启动未能完成'}</h1>
        </div>
        {!workspaceFailure && legacyUpgrade && bridge && state
          ? <LegacyDaemonUpgrade bridge={bridge} revision={state.revision} onBlocked={setLegacyBlocked} onStopped={() => action('retry')} />
          : <p className="my-startup-recovery-copy">{workspaceFailure || (error && !failure) ? '请重载桌面后重试。' : !bridge ? '退出后重新打开，以加载桌面组件。' : failure?.retryable ? '请重试连接，或退出后重新打开。' : '请退出桌面并重新打开。'}</p>}
        {!workspaceFailure && !legacyUpgrade && bridge && state && (state.takeover || ['E_BUSY', 'E_UNAVAILABLE', 'E_VERSION'].includes(failure?.code ?? '')) &&
          <DaemonTakeoverPanel bridge={bridge} snapshot={state} revision={state.revision} onError={setError} />}
        <div className="my-startup-actions">
          {!workspaceFailure && failure?.retryable && <button disabled={legacyBlocked} className="my-control my-button-primary" onClick={() => void action('retry')}>重试连接</button>}
          {((error && !failure) || !bridge || workspaceFailure) && <button className="my-control my-button-primary" onClick={() => window.location.reload()}>重载桌面</button>}
          {bridge && <button className="my-control my-button-neutral" onClick={() => void action('exit')}>退出桌面</button>}
        </div>
        {(failure || error || workspaceFailure || state?.ui.warning) && <details className="my-startup-details">
          <summary>诊断详情</summary>
          <div className="my-startup-diagnostics">
            {failure && <><p>{failure.message}</p><dl>
              <dt>错误代码</dt><dd>{failure.code}</dd>
              <dt>操作结果</dt><dd>{failure.outcome}</dd>
              <dt>启动阶段</dt><dd>{failure.stage}</dd>
              {failure.migration && <>
                <dt>原迁移 command ID</dt><dd>{failure.migration.commandId}</dd>
                <dt>原 release ID</dt><dd>{failure.migration.releaseId}</dd>
              </>}
            </dl></>}
            {error && <><p>{error.message}</p>{error.code && <dl><dt>错误代码</dt><dd>{error.code}</dd></dl>}</>}
            {workspaceFailure && <pre>{workspaceFailure.error instanceof Error ? workspaceFailure.error.stack || workspaceFailure.error.message : String(workspaceFailure.error)}</pre>}
            {state?.ui.warning && <p>{state.ui.warning}</p>}
          </div>
        </details>}
      </section>
        : <>
          <StartupSplash status={[labels[state?.phase ?? 'window-ready'], state?.ui.warning].filter(Boolean).join('。')} active={handoff === 'covered'} />
          {state?.ui.warning && <details className="my-startup-warning">
            <summary aria-label="查看外观设置提示" title="查看外观设置提示">
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
            </summary>
            <p>{state.ui.warning}</p>
          </details>}
        </>}
    </main>
  </div>
  }
  const covered = handoff !== 'revealed'
  return <StartupContext.Provider value={presentation}>
    <div ref={handoffRoot} className="my-startup-handoff" data-startup-handoff={handoff}>
      {appEligible && !appFailure && <div className="my-startup-app-entry" aria-hidden={covered || undefined} {...(covered ? { inert: '' } : {})}>
        <BootstrapAppBoundary recovery={cause => shell({ error: cause })} onFailure={cause => { setAppFailure(previous => previous ?? { error: cause }); void bridge?.detached().catch(() => undefined) }}>
          <Suspense fallback={null}>{children}</Suspense>
        </BootstrapAppBoundary>
      </div>}
      {(appFailure || !appEligible || handoff !== 'revealed') && <div className="my-startup-overlay" data-revealing={!appFailure && appEligible && handoff === 'revealing'}>
        {shell(appFailure ?? undefined)}
      </div>}
    </div>
  </StartupContext.Provider>
}
