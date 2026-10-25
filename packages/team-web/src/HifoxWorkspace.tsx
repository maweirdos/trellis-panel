import { useLayoutEffect, useState, type JSX } from 'react'
import { HiFoxApp } from '../../../src/renderer/src/hifox/HiFoxApp'
import { useHifox } from '../../../src/renderer/src/hifox/store'
import { DialogHost } from '../../../src/renderer/src/components/Dialogs'
import { Toasts } from '../../../src/renderer/src/components/Toasts'
import { useApp } from '../../../src/renderer/src/store'
import { useMy } from '../../../src/renderer/src/my/store'
import type { HifoxPendingCommand } from '../../../src/shared/hifox'
import type { HifoxWorkspaceContext } from '../../../src/shared/hifox-remote'
import type { TeamProject, TeamSession } from './contracts'
import { isClientSession } from './client'
import { bindBrowserHifox, BrowserHifoxWorkspace } from './hifox-browser-api'
import './hifox-workspace.css'

export type HifoxWorkspaceProps = { project: TeamProject; session: TeamSession; theme: 'light' | 'dark'; authEpoch?: number }
const runSharedCommand = useHifox.getState().run

export function HifoxWorkspace({ project, session, theme, authEpoch = 0 }: HifoxWorkspaceProps): JSX.Element {
  const fontSize = useMy((state) => state.fontSize)
  const [lease, setLease] = useState<{ workspace: BrowserHifoxWorkspace; epoch: number; session: TeamSession } | null>(null)
  useLayoutEffect(() => {
    const workspace = new BrowserHifoxWorkspace({ project, session })
    const release = bindBrowserHifox(workspace)
    // The shared store queues calls. Pin each queued closure to its browser lease,
    // so a project/account switch cannot send it through the next active bridge.
    const run: typeof runSharedCommand = (label, call) => {
      if (!workspace.isCurrent()) return Promise.resolve(null)
      return runSharedCommand(label, () => {
        if (!workspace.isCurrent()) throw new Error('原工作区已关闭，未发送该操作')
        return call()
      })
    }
    useApp.setState({ toasts: [] })
    useHifox.setState({ snapshot: null, loadError: null, workspaceContext: workspace.context(), currentSpaceId: null, openTaskId: null, createTaskOpen: false, taskFilter: {}, activeViewId: null, busy: false, module: 'overview', run })
    setLease({ workspace, epoch: authEpoch, session })
    return () => {
      release()
      if (useHifox.getState().run === run) useHifox.setState({ run: runSharedCommand })
      useHifox.setState({ snapshot: null, loadError: null, openTaskId: null, createTaskOpen: false })
      useApp.setState({ toasts: [] })
    }
  }, [project.projectId, session.person.userId, session.csrfToken, authEpoch])
  const current = lease && lease.epoch === authEpoch && lease.session.person.userId === session.person.userId && lease.session.csrfToken === session.csrfToken && lease.workspace.context().projectId === project.projectId && isClientSession(session)
  return <section className="my-root hifox-host" data-my-theme={theme} data-my-font-size={fontSize} aria-label="项目协作">
    {current ? <><WorkspaceCommands workspace={lease.workspace} /><div className="hifox-host-body"><HiFoxApp host="web" /></div><DialogHost /><Toasts /></> : <p role="status">正在连接项目协作…</p>}
  </section>
}

function WorkspaceCommands({ workspace }: { workspace: BrowserHifoxWorkspace }): JSX.Element | null {
  const [context, setContext] = useState<HifoxWorkspaceContext>(() => workspace.context())
  const [pending, setPending] = useState<HifoxPendingCommand[]>([])
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  useLayoutEffect(() => {
    let live = true
    const sync = (value: HifoxWorkspaceContext): void => {
      if (!live) return
      setContext(value)
      void workspace.hifox.workspacePending().then((reply) => { if (live) setPending(reply.ok ? reply.data : []) })
    }
    const off = workspace.hifox.onWorkspaceChanged(sync); sync(workspace.context())
    return () => { live = false; off() }
  }, [workspace])
  const act = async (command: HifoxPendingCommand, discard: boolean): Promise<void> => {
    setBusy(true)
    const reply = discard ? await workspace.hifox.discardWorkspaceCommand({ commandId: command.commandId }) : await workspace.hifox.retryWorkspaceCommand({ commandId: command.commandId })
    setMessage(reply.ok ? discard ? command.state === 'retired' ? '原操作引用已归档，旧代次的执行结果没有被改写。请核对当前工作区后明确提交新操作。' : '原操作已放弃，表单内容保留；重新加载后可提交新的操作。' : '原操作已取得回执，正在核对当前工作区。' : reply.error)
    if (reply.ok) await useHifox.getState().bootstrap()
    setBusy(false)
  }
  if (context.state === 'connected' && !pending.length && !message) return null
  return <div className="hifox-host-status" aria-label="工作区同步状态" aria-live="polite">
    {context.state !== 'connected' && <p>{context.error ?? '正在连接团队服务…'}</p>}
    {pending.map((command) => <div key={command.commandId}>
      <p>{command.state === 'retired' ? `服务实例或工作区代次已改变，原操作不会重放。${command.outcomeUnknown ? '原代次的执行结果仍未确认。' : ''}归档只移除原操作引用，草稿不会被改写。` : command.errorCode === 'REVISION_CONFLICT' ? '工作区已有更新，原操作未覆盖新内容。编辑草稿仍保留。' : command.outcomeUnknown ? '写入结果尚未确认，请使用原内容核对。' : '操作正在提交…'}</p>
      <details><summary>原操作标识与摘要</summary><code>{command.commandId}</code>{'digest' in command && typeof command.digest === 'string' && <p><code>{command.digest}</code></p>}</details>
      {command.state !== 'retired' && <button type="button" disabled={busy || command.state === 'sending'} onClick={() => void act(command, false)}>{command.state === 'reference-only' ? '核对原操作回执' : '以原内容核对重试'}</button>}
      {(!command.outcomeUnknown || command.state === 'retired') && command.state !== 'sending' && <button type="button" disabled={busy} onClick={() => void act(command, true)}>{command.state === 'retired' ? '归档原操作引用，保留草稿' : '放弃原操作，保留编辑草稿'}</button>}
    </div>)}
    {message && <p>{message}<button type="button" onClick={() => setMessage('')}>收起提示</button></p>}
  </div>
}
