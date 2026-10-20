/** C1–C3：本机开发工具 IPC——只读 Git、工程脚本发现、有归属的运行管理。 */
import { isAbsolute, resolve } from 'path'
import { getProjectGeneration, getProjectRoot } from '../state'
import { gitReadonlyFileDiff, gitReadonlyStatus } from '../services/devtools-git'
import { devRunGet, devRunList, devRunStart, devRunStop, devRunStopAll, listPackageScripts } from '../services/dev-run'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { ipcInvoke } from '../../shared/ipc-channels'
import { handle } from './registry'
import type { WindowDeps } from './deps'
import { applicationConfirmation } from '../services/application-confirmation'

export function registerDevtoolsIpc(deps: WindowDeps): void {
  handle(ipcInvoke.devtools.gitStatus, () => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return gitReadonlyStatus(root)
  })

  handle(ipcInvoke.devtools.gitFileDiff, (_e, relPath: string, staged: boolean) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return gitReadonlyFileDiff(root, String(relPath ?? ''), staged === true)
  })

  handle(ipcInvoke.devtools.listScripts, (_e, dir: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    // 允许项目根之外的目录（多工程组合），但必须是绝对路径且真实存在
    const target = String(dir ?? '').trim()
    if (!isAbsolute(target)) return ipcFail(IpcErrorCode.InvalidArg, '需要绝对路径的工程目录')
    return { ...listPackageScripts(resolve(target)), dir: resolve(target) }
  })

  handle(ipcInvoke.devtools.devRunStart, (event, dir: string, script: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const target = String(dir ?? '').trim()
    if (!isAbsolute(target)) return ipcFail(IpcErrorCode.InvalidArg, '需要绝对路径的工程目录')
    return devRunStart(root, resolve(target), String(script ?? ''), {
      confirm: applicationConfirmation({ senderId: event.sender.id, generation: getProjectGeneration(), getMain: deps.getMain, getRoot: getProjectRoot, getGeneration: getProjectGeneration })
    })
  })

  handle(ipcInvoke.devtools.devRunStop, (_e, id: string) => {
    const root = getProjectRoot()
    return root ? devRunStop(root, String(id ?? '')) : noProject()
  })

  handle(ipcInvoke.devtools.devRunStopAll, () => {
    const root = getProjectRoot()
    return root ? devRunStopAll(root) : { ...noProject(), stopped: 0 }
  })

  handle(ipcInvoke.devtools.devRunList, async () => {
    const root = getProjectRoot()
    if (!root) return { ...noProject(), runs: [] }
    try { return { ok: true as const, runs: await devRunList(root) } }
    catch { return { ...ipcFail(IpcErrorCode.Io, '无法读取应用运行记录'), runs: [] } }
  })

  handle(ipcInvoke.devtools.devRunGet, async (_e, id: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    try {
      const run = await devRunGet(root, String(id ?? ''))
      if (!run) return ipcFail(IpcErrorCode.NotFound, '运行不存在或已被清理')
      return { ok: true as const, run }
    } catch {
      return ipcFail(IpcErrorCode.Io, '无法读取应用运行记录')
    }
  })
}
