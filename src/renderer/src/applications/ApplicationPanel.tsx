import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, Check, ChevronDown, Loader2, PackagePlus, Play, Plus, RefreshCw, Settings2, Square, Terminal, TriangleAlert } from 'lucide-react'
import { hasIpc } from '../api'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { Button, Dropdown, Modal, Tooltip } from '../my/ui'
import { ApplicationConfigDialog } from './ApplicationConfigDialog'
import { ApplicationList } from './ApplicationList'
import { closeApplicationEditor, openApplicationEditor, refreshApplications, removeApplication, runApplication, selectApplication, useApplications } from './useApplications'

function ApplicationActions({ onOpen }: { onOpen?: () => void }): JSX.Element {
  const state = useApplications()
  const enabled = hasIpc && Boolean(state.root)
  return <div className="flex shrink-0 items-center gap-1">
    <Tooltip label="刷新应用"><button type="button" className="my-icon-control" aria-label="刷新应用" disabled={!enabled || state.loading} onClick={() => void refreshApplications()}><RefreshCw size={14} className={state.loading ? 'animate-spin' : undefined} /></button></Tooltip>
    <Tooltip label="导入 npm 脚本"><button type="button" className="my-icon-control" aria-label="导入 npm 脚本" disabled={!enabled} onClick={(event) => { onOpen?.(); openApplicationEditor({ kind: 'new', npm: true }, state.generation, event.currentTarget) }}><PackagePlus size={15} /></button></Tooltip>
    <Tooltip label="添加应用"><button type="button" className="my-icon-control" aria-label="添加应用" disabled={!enabled} onClick={(event) => { onOpen?.(); openApplicationEditor({ kind: 'new' }, state.generation, event.currentTarget) }}><Plus size={15} /></button></Tooltip>
  </div>
}

function ApplicationDialogs(): JSX.Element | null {
  const state = useApplications()
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const editor = state.editor
  const request = useRef(0)
  useEffect(() => { request.current += 1; setError(null); setRemoving(false); return () => { request.current += 1 } }, [editor])
  if (!editor || !state.root) return null
  const close = (): void => { request.current += 1; setError(null); closeApplicationEditor() }
  if (editor.kind !== 'remove') return <ApplicationConfigDialog key={`${state.generation}:${editor.kind === 'edit' ? editor.definition.id : 'new'}`} root={state.root} definition={editor.kind === 'edit' ? editor.definition : undefined} npm={editor.kind === 'new' ? editor.npm : undefined} onClose={close} />
  return <Modal open onClose={close} ariaLabel="删除应用配置">
    <div className="p-5">
      <h2 className="text-my-lg font-semibold text-my-primary">删除应用配置</h2>
      <p className="mt-3 break-words text-my-sm text-my-secondary">删除“{editor.definition.name}”的本机启动配置？</p>
      {error && <p role="alert" className="my-application-message mt-3 text-my-danger-text">{error}</p>}
      <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={close}>取消</Button><Button variant="danger" disabled={removing} onClick={() => {
        setRemoving(true)
        const operation = ++request.current
        void removeApplication(editor.definition).then((failure) => { if (operation !== request.current) return; if (failure) setError(failure); else close() }).finally(() => { if (operation === request.current) setRemoving(false) })
      }}>{removing && <Loader2 size={14} className="animate-spin" />}删除</Button></div>
    </div>
  </Modal>
}

function CloseMenuForEditor({ active, close }: { active: boolean; close: () => void }): null {
  useEffect(() => { if (active) close() }, [active, close])
  return null
}

/** One stable header owner for selection, direct actions and configuration dialogs. */
export function ApplicationPanel(): JSX.Element {
  const state = useApplications()
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const lastDialog = useRef<{ open: boolean; generation: number; focus: HTMLElement | null }>({ open: false, generation: state.generation, focus: null })
  useLayoutEffect(() => {
    if (lastDialog.current.open && !state.editor && lastDialog.current.generation === state.generation) {
      const target = lastDialog.current.focus?.isConnected ? lastDialog.current.focus : trigger.current
      target?.focus({ preventScroll: true })
    }
    lastDialog.current = { open: Boolean(state.editor), generation: state.generation, focus: state.editorFocus }
  }, [state.editor, state.generation, state.editorFocus])
  const selected = state.apps.find((app) => app.definition.id === state.selectedId) ?? state.apps[0]
  const enabled = hasIpc && Boolean(state.root)
  const busy = selected ? state.busy[selected.definition.id] : null
  const live = state.apps.filter((app) => ['starting', 'running', 'stopping'].includes(app.processState)).length
  const pending = state.apps.filter((app) => app.approval === 'pending').length
  const projectName = useApp((current) => current.snapshot?.meta.name)
  const running = Boolean(selected?.canStop || selected?.processState === 'stopping')
  const runAction = running ? 'stop' : 'start'
  const runLabel = !selected ? '添加运行配置' : running ? `停止 ${selected.definition.name}` : `启动 ${selected.definition.name}`
  const runDisabled = !enabled || state.loading && state.apps.length === 0 || Boolean(busy) || Boolean(selected && !(running ? selected.canStop : selected.canStart))
  const label = `运行配置：${selected?.definition.name ?? '未选择'}${live ? ` · ${live} 个运行中` : ''}${pending ? ` · ${pending} 个待确认` : ''}`

  return <div className="my-run-toolbar no-drag" aria-label="应用运行控制">
    <Dropdown key={`popup-${state.generation}`} align="right" placement="bottom" layoutKey={`${state.generation}:${state.apps.length}`} trigger={({ open, toggle }) => <span className="my-application-trigger" data-open={open}><Tooltip label={label} side="bottom" align="right">
      <button ref={trigger} type="button" className="my-control my-button-ghost my-run-config-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        <Terminal size={15} strokeWidth={1.7} aria-hidden="true" /><span className="min-w-0 truncate text-my-sm">{selected?.definition.name ?? '运行配置'}</span>{pending > 0 && <TriangleAlert size={12} className="shrink-0 text-my-warning-text" aria-hidden="true" />}<ChevronDown size={12} className="shrink-0 text-my-tertiary" />
      </button>
    </Tooltip></span>}>
      {(close) => <div id={id} role="dialog" aria-label="项目应用" className="my-applications-popup">
        <CloseMenuForEditor active={Boolean(state.editor)} close={close} />
        <header className="flex shrink-0 items-center gap-2 px-3 py-2"><div className="min-w-0 flex-1"><h2 className="text-my-sm font-semibold text-my-primary">运行配置</h2>{projectName && <p className="truncate text-my-xs text-my-tertiary">{projectName}</p>}</div><ApplicationActions onOpen={close} /></header>
        <div className="my-run-config-options my-scrollbar" role="listbox" aria-label="选择运行配置" onKeyDown={(event) => {
          const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')]
          const current = options.indexOf(document.activeElement as HTMLButtonElement)
          const index = event.key === 'ArrowDown' ? (current + 1) % options.length : event.key === 'ArrowUp' ? (current - 1 + options.length) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1
          if (index >= 0 && options[index]) { event.preventDefault(); options[index].focus() }
        }}>
          {state.apps.map((app) => <button key={app.definition.id} type="button" role="option" aria-selected={selected?.definition.id === app.definition.id} aria-label={`选择配置 ${app.definition.name}`} className="my-menu-item" data-selected={selected?.definition.id === app.definition.id || undefined} onClick={() => { selectApplication(app.definition.id, state.generation); close() }}>
            <Terminal size={14} className="shrink-0 text-my-tertiary" /><span className="min-w-0 flex-1 truncate">{app.definition.name}</span><span className="text-my-xs text-my-tertiary">{app.processState === 'running' ? '运行中' : app.approval === 'pending' ? '待确认' : ''}</span>{selected?.definition.id === app.definition.id && <Check size={14} className="shrink-0 text-my-primary" />}
          </button>)}
          {!hasIpc ? <p className="my-application-empty">桌面端可管理本地应用</p> : !state.root ? <p className="my-application-empty">选择项目后添加运行配置</p> : state.loading && state.apps.length === 0 ? <p className="my-application-empty" role="status">正在读取配置…</p> : state.apps.length === 0 ? <p className="my-application-empty">还没有运行配置</p> : null}
          {state.error && <p role="alert" className="my-application-message text-my-danger-text">{state.error}</p>}
        </div>
        <div className="border-t border-my-line py-1"><button type="button" className="my-menu-item" disabled={!enabled} onClick={(event) => { close(); openApplicationEditor(selected ? { kind: 'edit', definition: selected.definition } : { kind: 'new' }, state.generation, event.currentTarget) }}><Settings2 size={14} />编辑配置…</button></div>
        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-my-line px-3 py-2"><span className="text-my-xs text-my-tertiary">当前项目</span><Button size="sm" variant="ghost" disabled={!state.root} onClick={() => { close(); useMy.getState().setToolView('run'); useApp.getState().setPage('devtools') }}>在运行页打开<ArrowUpRight size={12} /></Button></footer>
      </div>}
    </Dropdown>
    <Tooltip label={runLabel} side="bottom"><button type="button" className={running ? 'my-icon-control text-my-danger-text' : 'my-icon-control'} aria-label={runLabel} disabled={runDisabled} onClick={(event) => { if (selected) void runApplication(selected, runAction, state.generation); else openApplicationEditor({ kind: 'new' }, state.generation, event.currentTarget) }}>{busy ? <Loader2 size={15} className="animate-spin" /> : running ? <Square size={15} /> : <Play size={15} />}</button></Tooltip>
    <ApplicationDialogs key={`dialogs-${state.generation}`} />
  </div>
}

export function ApplicationRuntimeView(): JSX.Element {
  return <section aria-label="项目应用运行" className="flex h-full min-h-0 min-w-0 flex-col">
    <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><h2 className="text-my-md font-semibold text-my-primary">应用</h2><p className="mt-1 text-my-xs text-my-tertiary">项目启动配置与运行状态</p></div><ApplicationActions /></div>
    <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto"><ApplicationList /></div>
  </section>
}
