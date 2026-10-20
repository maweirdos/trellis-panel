import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, Loader2, PackagePlus, Plus, RefreshCw, Server, TriangleAlert } from 'lucide-react'
import { hasIpc } from '../api'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { Button, Dropdown, Modal, Tooltip } from '../my/ui'
import { ApplicationConfigDialog } from './ApplicationConfigDialog'
import { ApplicationList } from './ApplicationList'
import { closeApplicationEditor, openApplicationEditor, refreshApplications, removeApplication, useApplications } from './useApplications'

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

/** Stable ordinary-window owner: closing the popup never owns an application's lifetime. */
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
  const live = state.apps.filter((app) => ['starting', 'running', 'stopping'].includes(app.processState)).length
  const pending = state.apps.filter((app) => app.approval === 'pending').length
  const projectName = useApp((current) => current.snapshot?.meta.name)
  const label = `应用${live ? ` · ${live} 个运行中` : ''}${pending ? ` · ${pending} 个待确认` : ''}`
  return <>
    <Dropdown key={`popup-${state.generation}`} align="right" placement="bottom" className="no-drag shrink-0 mr-2" layoutKey={`${state.generation}:${state.apps.length}`} trigger={({ open, toggle }) => <span className="my-application-trigger" data-open={open}><Tooltip label={label} side="bottom" align="right">
      <button ref={trigger} type="button" className="my-control my-button-ghost gap-1.5" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        <Server size={16} strokeWidth={1.7} aria-hidden="true" /><span className="my-application-trigger-label text-my-sm">应用</span>{live > 0 && <span className="text-my-xs tabular-nums">{live}</span>}{pending > 0 && <TriangleAlert size={13} className="text-my-warning-text" aria-hidden="true" />}
      </button>
    </Tooltip></span>}>
      {(close) => <div id={id} role="dialog" aria-label="项目应用" className="my-applications-popup">
        <header className="flex shrink-0 items-center gap-2 px-3 py-2"><div className="min-w-0 flex-1"><h2 className="text-my-sm font-semibold text-my-primary">应用</h2>{projectName && <p className="truncate text-my-xs text-my-tertiary">{projectName}</p>}</div><ApplicationActions onOpen={close} /></header>
        <div className="my-application-popup-body my-scrollbar"><ApplicationList compact onOpenEditor={close} /></div>
        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-my-line px-3 py-2"><span className="text-my-xs text-my-tertiary">当前项目</span><Button size="sm" variant="ghost" disabled={!state.root} onClick={() => { close(); useMy.getState().setToolView('run'); useApp.getState().setPage('devtools') }}>在运行页打开<ArrowUpRight size={12} /></Button></footer>
      </div>}
    </Dropdown>
    <ApplicationDialogs key={`dialogs-${state.generation}`} />
  </>
}

export function ApplicationRuntimeView(): JSX.Element {
  return <section aria-label="项目应用运行" className="min-w-0">
    <div className="mb-4 flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><h2 className="text-my-md font-semibold text-my-primary">应用</h2><p className="mt-1 text-my-xs text-my-tertiary">项目启动配置与运行状态</p></div><ApplicationActions /></div>
    <ApplicationList />
  </section>
}
