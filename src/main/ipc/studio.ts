import { ipcInvoke } from '../../shared/ipc-channels'
import { errorText } from '../../shared/errors'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import {
  scanStudio,
  studioReadText,
  studioWriteText,
  studioDelete,
  setConfigKeys,
  setDeveloperFile,
  createWorkflow,
  createExtension,
  syncExtensionToPlatforms
} from '../services/studio'
import { getProjectRoot, sendSnapshot } from '../state'
import { handle } from './registry'

export function registerStudioIpc(): void {
  handle(ipcInvoke.studio.scan, () => {
    const root = getProjectRoot()
    if (!root) return noProject()
    try {
      return { ok: true, scan: scanStudio(root) }
    } catch (e) {
      return ipcFail(IpcErrorCode.Io, errorText(e, '扫描失败'))
    }
  })

  handle(ipcInvoke.studio.read, (_e, absPath: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return studioReadText(root, absPath)
  })

  handle(ipcInvoke.studio.write, (_e, absPath: string, content: string, expectedMtime?: number) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return studioWriteText(root, absPath, content, expectedMtime)
  })

  handle(ipcInvoke.studio.delete, (_e, absPath: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return studioDelete(root, absPath)
  })

  handle(ipcInvoke.studio.setConfig, (_e, patch: Record<string, unknown>) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    try {
      setConfigKeys(root, patch ?? {})
      return { ok: true }
    } catch (e) {
      return ipcFail(IpcErrorCode.Io, errorText(e, '写入 config.yaml 失败'))
    }
  })

  handle(ipcInvoke.studio.setDeveloper, (_e, content: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    try {
      setDeveloperFile(root, String(content ?? ''))
      return { ok: true }
    } catch (e) {
      return ipcFail(IpcErrorCode.Io, errorText(e, '写入 .developer 失败'))
    }
  })

  handle(ipcInvoke.studio.createWorkflow, (_e, id: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return createWorkflow(root, String(id ?? ''))
  })

  handle(ipcInvoke.studio.createExtension, (_e, kind: string, platform: string, name: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    if (!['command', 'agent', 'skill'].includes(kind)) return ipcFail(IpcErrorCode.InvalidArg, '未知扩展类型')
    return createExtension(root, kind as 'command' | 'agent' | 'skill', platform, String(name ?? ''))
  })

  handle(ipcInvoke.studio.syncExtension, (_e, sourcePath: string, targets: string[]) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const list = Array.isArray(targets) ? targets.map(String) : []
    if (list.length === 0) return ipcFail(IpcErrorCode.InvalidArg, '未选择目标平台')
    const res = syncExtensionToPlatforms(root, String(sourcePath), list)
    if (res.written.length > 0) sendSnapshot()
    return { ok: true, ...res }
  })
}
