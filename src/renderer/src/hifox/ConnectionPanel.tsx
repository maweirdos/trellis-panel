import { useEffect, useState } from 'react'
import { Globe, Link2, RefreshCw } from 'lucide-react'
import type { DesktopTeamConnection } from '@shared/team-desktop'
import type { HifoxPendingCommand } from '@shared/hifox'
import { api, hasIpc } from '../api'
import { Button, Modal } from '../my/ui'
import { useHifox } from './store'
import { Field, inputClass } from './ui'

const retiredCodes = new Set(['EPOCH_CONFLICT', 'WORKSPACE_EPOCH_CHANGED'])

export function ConnectionPanel({ trigger = 'compact' }: { trigger?: 'compact' | 'connect' } = {}): JSX.Element {
  const { workspaceContext: context, selectWorkspace, busy, bootstrap } = useHifox()
  const [open, setOpen] = useState(false)
  const [connections, setConnections] = useState<DesktopTeamConnection[]>([])
  const [origin, setOrigin] = useState('')
  const [deviceName, setDeviceName] = useState('我的工作电脑')
  const [pending, setPending] = useState<HifoxPendingCommand[]>([])
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const refresh = async (): Promise<void> => {
    if (!api.teamDesktop) { setError('当前应用版本尚不支持团队连接，请重新启动完整应用。'); return }
    try {
      const result = await api.teamDesktop.connections()
      if (!result.ok) throw new Error(result.error)
      setConnections(result.value)
      const queue = await api.hifox.workspacePending()
      if (queue.ok) setPending(queue.data)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => {
    if (!open) return
    void refresh()
    const off = api.teamDesktop?.onChanged?.(() => { void refresh() })
    return () => { off?.() }
  }, [open])
  const action = async (work: () => Promise<unknown>): Promise<void> => {
    if (working || busy) return
    setWorking(true); setError('')
    try { await work(); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setWorking(false) }
  }
  const pair = async (): Promise<void> => {
    const result = await api.teamDesktop.beginPairing({ origin: origin.trim(), deviceName: deviceName.trim(), capabilityClaims: [] })
    if (!result.ok) throw new Error(result.error)
    setOrigin('')
  }
  const label = context.state === 'local' ? '本机工作区' : context.state === 'connected' ? context.projectName ?? '团队工作区' : context.state === 'offline' ? '团队工作区 · 离线缓存' : '团队工作区 · 访问失效'
  return <>
    <button type="button" disabled={!hasIpc} onClick={() => setOpen(true)} className="flex min-h-8 w-full items-center gap-2 rounded-my-md py-1 text-left text-my-xs text-my-secondary hover:text-my-primary disabled:cursor-not-allowed disabled:opacity-50" aria-label={trigger === 'connect' ? '连接团队服务' : '选择本机或共享协作空间'}><Globe size={15} /><span className="min-w-0 flex-1 truncate">{trigger === 'connect' ? '连接团队服务' : label}</span>{context.pendingCount > 0 && <span>{context.pendingCount} 待核对</span>}</button>
    <Modal open={open} onClose={() => setOpen(false)} width={640} ariaLabel="团队协作连接"><div className="my-scrollbar flex max-h-[var(--my-modal-max-height)] flex-col gap-4 overflow-y-auto p-5">
      <header className="flex items-center gap-2"><h2 className="flex-1 text-my-md font-semibold text-my-primary">团队协作连接</h2><Button variant="ghost" size="sm" disabled={working} onClick={() => void refresh()}><RefreshCw size={14} />刷新</Button></header>
      <p className="text-my-xs leading-relaxed text-my-secondary">本机工作区独立保存。连接团队服务并登录后，可与获邀同事共享任务、版本、小队和 Agent；已有本机数据不会自动上传。</p>
      {error && <p role="alert" className="rounded-my-md border border-my-line bg-my-layer-1 p-3 text-my-sm text-my-danger-text">{error}</p>}
      <button type="button" disabled={working || busy} aria-pressed={context.state === 'local'} className="rounded-my-md border border-my-line p-3 text-left text-my-sm text-my-primary hover:bg-my-layer-1" onClick={() => void action(async () => { if (await selectWorkspace(null)) setOpen(false) })}>本机工作区<span className="mt-1 block text-my-xs text-my-tertiary">查看和编辑当前电脑上的独立数据</span></button>
      <section className="space-y-2"><h3 className="text-my-xs font-medium text-my-tertiary">已有团队连接</h3>
        {connections.length === 0 && <p className="text-my-xs text-my-tertiary">尚未连接团队服务。</p>}
        {connections.map((connection) => <div key={connection.connectionId} className="rounded-my-md border border-my-line p-3"><div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 truncate text-my-sm text-my-primary">{connection.deviceName}</span><span className="text-my-xs text-my-tertiary">{connection.state === 'active' ? '已登录' : connection.state === 'pending' ? '等待确认' : '需要重新登录'}</span>
          {connection.state === 'active' && !connection.accessLocked ? <Button size="sm" disabled={working || busy} onClick={() => void action(async () => { if (await selectWorkspace(connection.connectionId)) setOpen(false) })}>进入团队工作区</Button> : connection.state === 'pending' ? <><Button size="sm" disabled={working} onClick={() => void action(async () => { const result = await api.teamDesktop.openPairing(connection.connectionId); if (!result.ok) throw new Error(result.error) })}>继续登录</Button><Button size="sm" disabled={working} onClick={() => void action(async () => { const result = await api.teamDesktop.pollPairing(connection.connectionId); if (!result.ok) throw new Error(result.error) })}>核对状态</Button></> : null}
        </div><p className="mt-1 break-all text-my-2xs text-my-tertiary">{connection.origin}</p>{connection.state === 'pending' && connection.userCode && <p className="mt-2 text-my-sm text-my-secondary">配对码 <code>{connection.userCode}</code> · 请在浏览器中核对账号与团队工作区。</p>}</div>)}
      </section>
      {pending.some((command) => retiredCodes.has(command.errorCode ?? '')) && <p className="rounded-my-md border border-my-line bg-my-layer-1 p-3 text-my-xs leading-relaxed text-my-secondary">旧服务代次的原操作已保留，不能写入恢复后的工作区。核对历史后，可在下方建立新的设备连接继续工作。</p>}
      {pending.length > 0 && <section className="space-y-2"><h3 className="text-my-xs font-medium text-my-tertiary">原空间待处理操作</h3>{pending.map((command) => <div key={command.commandId} className="space-y-2 rounded-my-md border border-my-line p-3"><p className="text-my-sm text-my-secondary">{command.operation} · {command.state === 'conflict' ? '与团队最新修改冲突' : command.outcomeUnknown ? '提交结果待确认' : '尚未完成同步'}</p><code className="break-all text-my-2xs text-my-tertiary">{command.commandId}</code><div className="flex flex-wrap gap-2"><Button size="sm" disabled={working} onClick={() => void action(async () => { const result = await api.hifox.retryWorkspaceCommand({ commandId: command.commandId }); if (!result.ok) throw new Error(result.error); await bootstrap() })}>{retiredCodes.has(command.errorCode ?? '') ? '核对旧代原操作' : '核对并重试原操作'}</Button>{!command.outcomeUnknown && ['queued', 'conflict'].includes(command.state) && <Button size="sm" variant="ghost" disabled={working} onClick={() => void action(async () => { const result = await api.hifox.discardWorkspaceCommand({ commandId: command.commandId }); if (!result.ok) throw new Error(result.error); await bootstrap() })}>放弃此待处理操作</Button>}</div></div>)}</section>}
      <section className="space-y-3 border-t border-my-line pt-3"><h3 className="text-my-sm font-medium text-my-primary">连接新的团队服务</h3><Field label="团队服务地址"><input className={inputClass} value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="团队服务的完整地址" /></Field><Field label="这台电脑的名称"><input className={inputClass} value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></Field><Button variant="primary" disabled={working || busy || !origin.trim() || !deviceName.trim()} onClick={() => void action(pair)}><Link2 size={14} />连接并在浏览器登录</Button></section>
      <div className="flex justify-end"><Button variant="ghost" onClick={() => setOpen(false)}>关闭</Button></div>
    </div></Modal>
  </>
}
