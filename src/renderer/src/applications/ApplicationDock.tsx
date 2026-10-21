import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react'
import { ChevronDown, ChevronUp, RefreshCw, Square, Terminal, X } from 'lucide-react'
import { hasIpc } from '../api'
import { Tooltip } from '../my/ui'
import { ApplicationOutput, ProcessStatus, ReadinessStatus } from './ApplicationList'
import { closeApplicationOutput, runApplication, selectApplication, setApplicationDockHeight, showApplicationOutput, useApplications } from './useApplications'

/** The dock owns presentation only; no cleanup or tab-close path stops a process. */
export function ApplicationDock(): JSX.Element | null {
  const state = useApplications()
  const panelId = useId()
  const dock = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const focusAfterClose = useRef<{ generation: number; target: 'tab' | 'toggle' } | null>(null)
  const minProbe = useRef<HTMLSpanElement>(null)
  const maxProbe = useRef<HTMLSpanElement>(null)
  const defaultProbe = useRef<HTMLSpanElement>(null)
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const tabs = state.dockTabs.map((id) => state.apps.find((app) => app.definition.id === id)).filter((app) => app !== undefined)
  const active = tabs.find((app) => app.definition.id === state.selectedId) ?? tabs[0]
  const selected = state.apps.find((app) => app.definition.id === state.selectedId) ?? state.apps[0]
  const visible = hasIpc && Boolean(state.root) && state.apps.length > 0

  useLayoutEffect(() => {
    const pending = focusAfterClose.current
    if (!pending) return
    focusAfterClose.current = null
    if (pending.generation !== state.generation) return
    const tab = pending.target === 'tab' && state.dockOpen ? dock.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]') : null
    const target = tab || toggle.current
    target?.focus({ preventScroll: true })
  }, [state.generation, state.dockOpen, state.dockTabs])

  useLayoutEffect(() => {
    const element = dock.current
    const root = element?.closest<HTMLElement>('.my-root')
    if (!visible || !element || !root) return
    const update = (): void => root.style.setProperty('--my-run-dock-occupied-height', `${element.getBoundingClientRect().height}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--my-run-dock-occupied-height')
    }
  }, [visible, state.generation, state.dockOpen, state.dockHeight, tabs.length])

  const limits = (): { minimum: number; maximum: number; initial: number } => {
    const maximum = maxProbe.current?.getBoundingClientRect().height ?? 0
    return {
      minimum: Math.min(minProbe.current?.getBoundingClientRect().height ?? maximum, maximum),
      maximum,
      initial: defaultProbe.current?.getBoundingClientRect().height ?? maximum
    }
  }
  const resize = (height: number): void => {
    const { minimum, maximum } = limits()
    if (maximum > 0) setApplicationDockHeight(Math.min(maximum, Math.max(minimum, height)))
  }

  useEffect(() => {
    if (!state.dockOpen) return
    const clamp = (): void => {
      const { minimum, maximum, initial } = limits()
      if (maximum <= 0) return
      const desired = state.dockHeight ?? initial
      const height = Math.min(maximum, Math.max(minimum, desired))
      if (state.dockHeight !== height) setApplicationDockHeight(height)
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [state.dockOpen, state.dockHeight, state.generation])

  useEffect(() => {
    drag.current = null
    setResizing(false)
  }, [state.generation, state.dockOpen])

  if (!visible || !state.root) return null
  const expanded = state.dockOpen && active !== undefined
  const endResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return
    drag.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const { minimum, maximum } = limits()
    const current = dock.current?.getBoundingClientRect().height ?? 0
    const step = minProbe.current ? Number.parseFloat(getComputedStyle(minProbe.current).getPropertyValue('--my-space-16')) : 0
    if (event.key === 'ArrowUp') resize(current + step)
    else if (event.key === 'ArrowDown') resize(current - step)
    else if (event.key === 'Home') resize(minimum)
    else if (event.key === 'End') resize(maximum)
    else return
    event.preventDefault()
  }

  return <section ref={dock} aria-label="运行窗口" className={`my-run-dock ${expanded ? 'is-expanded' : 'is-collapsed'} ${resizing ? 'is-resizing' : ''}`} style={expanded && state.dockHeight !== null ? { height: state.dockHeight } : undefined}>
    <span ref={minProbe} className="my-run-dock-probe my-run-dock-probe-min" aria-hidden="true" />
    <span ref={maxProbe} className="my-run-dock-probe my-run-dock-probe-max" aria-hidden="true" />
    <span ref={defaultProbe} className="my-run-dock-probe my-run-dock-probe-default" aria-hidden="true" />
    {expanded && <div role="separator" aria-label="调整运行窗口高度" aria-orientation="horizontal" aria-valuemin={Math.round(limits().minimum)} aria-valuemax={Math.round(limits().maximum)} aria-valuenow={Math.round(state.dockHeight ?? 0)} aria-controls={panelId} tabIndex={0} className="my-run-dock-resize" onKeyDown={onResizeKey}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        drag.current = { pointer: event.pointerId, y: event.clientY, height: dock.current?.getBoundingClientRect().height ?? 0 }
        event.currentTarget.setPointerCapture(event.pointerId)
        setResizing(true)
        event.preventDefault()
      }}
      onPointerMove={(event) => { const current = drag.current; if (current?.pointer === event.pointerId) resize(current.height + current.y - event.clientY) }}
      onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={() => { drag.current = null; setResizing(false) }} />}
    <header className="my-run-dock-header">
      <button ref={toggle} type="button" className="my-control my-button-ghost shrink-0" aria-label={expanded ? '折叠运行窗口' : '展开运行窗口'} aria-expanded={expanded} aria-controls={panelId} onClick={() => expanded ? closeApplicationOutput() : selected && showApplicationOutput(selected.definition.id, state.generation)}><Terminal size={14} />运行{expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</button>
      <div className="my-run-dock-tabs my-scrollbar" role="tablist" aria-label="运行应用" onKeyDown={(event) => {
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        const current = options.indexOf(document.activeElement as HTMLButtonElement)
        const index = event.key === 'ArrowRight' ? (current + 1) % options.length : event.key === 'ArrowLeft' ? (current - 1 + options.length) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1
        if (index >= 0 && options[index]) { event.preventDefault(); options[index].focus(); options[index].click() }
      }}>
        {tabs.map((app) => <div className={`my-run-dock-tab ${active?.definition.id === app.definition.id ? 'is-active' : ''}`} key={app.definition.id}>
          <button type="button" role="tab" tabIndex={active?.definition.id === app.definition.id ? 0 : -1} aria-selected={active?.definition.id === app.definition.id} aria-controls={panelId} className="my-control my-button-ghost min-w-0" onClick={() => { selectApplication(app.definition.id, state.generation); showApplicationOutput(app.definition.id, state.generation) }} title={app.definition.name}><span className="truncate">{app.definition.name}</span></button>
          <Tooltip label={`关闭 ${app.definition.name} 输出`}><button type="button" aria-label={`关闭 ${app.definition.name} 输出`} className="my-icon-control" onClick={(event) => { if (document.activeElement === event.currentTarget) focusAfterClose.current = { generation: state.generation, target: 'tab' }; closeApplicationOutput(app.definition.id) }}><X size={12} /></button></Tooltip>
        </div>)}
      </div>
      {expanded && active && <div className="flex shrink-0 items-center gap-1">
        <Tooltip label={`重启 ${active.definition.name}`}><button type="button" className="my-icon-control" aria-label={`运行窗口重启 ${active.definition.name}`} disabled={!active.canRestart || Boolean(state.busy[active.definition.id])} onClick={() => void runApplication(active, 'restart', state.generation)}><RefreshCw size={14} /></button></Tooltip>
        <Tooltip label={`停止 ${active.definition.name}`}><button type="button" className="my-icon-control" aria-label={`运行窗口停止 ${active.definition.name}`} disabled={!active.canStop || Boolean(state.busy[active.definition.id])} onClick={() => void runApplication(active, 'stop', state.generation)}><Square size={14} /></button></Tooltip>
        <Tooltip label="关闭运行窗口"><button type="button" aria-label="关闭运行窗口" className="my-icon-control" onClick={(event) => { if (document.activeElement === event.currentTarget) focusAfterClose.current = { generation: state.generation, target: 'toggle' }; closeApplicationOutput() }}><X size={14} /></button></Tooltip>
      </div>}
    </header>
    {expanded && active && <div id={panelId} role="tabpanel" aria-label={`${active.definition.name} 运行输出`} className="my-run-dock-content">
      <div className="my-run-dock-status"><ProcessStatus app={active} /><ReadinessStatus readiness={active.readiness} />{active.approval === 'pending' && <span role="status" className="text-my-warning-text">等待你确认启动配置</span>}{state.busy[active.definition.id] && <span role="status">{state.busy[active.definition.id]}</span>}{active.run?.exitCode !== null && active.run?.exitCode !== undefined && <span>退出码 {active.run.exitCode}</span>}</div>
      {(state.errors[active.definition.id] || active.lastError) && <p role="alert" className="my-application-message text-my-danger-text">{state.errors[active.definition.id] || active.lastError}</p>}
      <ApplicationOutput key={`${state.generation}:${active.definition.id}:${active.run?.id ?? 'unstarted'}`} app={active} root={state.root} generation={state.generation} docked />
    </div>}
    {!expanded && <span className="sr-only">输出窗口已折叠，应用继续运行</span>}
  </section>
}
