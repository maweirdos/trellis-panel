import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { listChannels, channelSend, channelAction } from '../services/channels'
import { getSettings } from '../services/store'
import { getProjectRoot } from '../state'
import { handle } from './registry'

export function registerChannelsIpc(): void {
  handle(ipcInvoke.channel.list, () => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return listChannels(root)
  })

  handle(ipcInvoke.channel.send, async (_e, name: string, text: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const res = await channelSend(root, getSettings().cliCommand, name, text)
    if (!res.ok) return ipcFail(IpcErrorCode.Upstream, res.error ?? '发送失败')
    return res
  })

  handle(ipcInvoke.channel.action, async (_e, args: string[]) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const safe = (Array.isArray(args) ? args : []).map((a) => String(a))
    const res = await channelAction(root, getSettings().cliCommand, safe)
    if (!res.ok) return ipcFail(IpcErrorCode.Upstream, res.error ?? '执行失败')
    return res
  })
}
