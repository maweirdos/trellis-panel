import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { listChannels, channelSend, channelAction, dispatchToChannel } from '../services/channels'
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

  /** 任务派发台：把一个 Trellis 任务 / 一句话需求派发给 AI worker（自动建频道 + 结构化指令） */
  handle(ipcInvoke.channel.dispatch, async (_e, input: { taskDir?: string; text?: string; channel?: string }) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const res = await dispatchToChannel(root, getSettings().cliCommand, {
      taskDir: input?.taskDir ? String(input.taskDir) : undefined,
      text: input?.text ? String(input.text) : undefined,
      channel: input?.channel ? String(input.channel) : undefined
    })
    if (!res.ok) return ipcFail(IpcErrorCode.Upstream, res.error ?? '派发失败')
    return { ok: true, channel: res.channel }
  })
}
