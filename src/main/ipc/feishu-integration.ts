import { FEISHU_IPC, feishuRequests, type FeishuInput, type FeishuMethod, type FeishuOutput } from '../../shared/feishu-integration'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { DaemonError } from '../daemon/errors'
import { handle } from './registry'

export function registerFeishuIntegrationIpc(
  invoke: <M extends FeishuMethod>(method: M, input: FeishuInput<M>) => Promise<FeishuOutput<M>>,
  isAllowed: (event: Electron.IpcMainInvokeEvent) => boolean
): void {
  const counts = new Map<number, number>()
  for (const method of Object.keys(FEISHU_IPC) as FeishuMethod[]) {
    handle(FEISHU_IPC[method], async (event, raw: unknown) => {
      if (!isAllowed(event)) return ipcFail(IpcErrorCode.Denied, '飞书集成仅允许桌面主窗口访问。')
      const input = feishuRequests[method].safeParse(raw)
      if (!input.success) return ipcFail(IpcErrorCode.InvalidArg, '飞书请求参数无效。')
      const sender = event.sender.id
      if ((counts.get(sender) ?? 0) >= 4) return ipcFail(IpcErrorCode.Busy, '飞书操作过多，请稍后再试。')
      counts.set(sender, (counts.get(sender) ?? 0) + 1)
      try {
        return { ok: true, data: await invoke(method, input.data) }
      } catch (error) {
        const code = error instanceof DaemonError ? Object.values(IpcErrorCode).find(value => value === error.code) : undefined
        return ipcFail(code ?? IpcErrorCode.Unknown, error instanceof DaemonError ? error.message : '飞书结果未确认，请检查原连接。')
      } finally {
        const count = (counts.get(sender) ?? 1) - 1
        if (count) counts.set(sender, count)
        else counts.delete(sender)
      }
    })
  }
}
