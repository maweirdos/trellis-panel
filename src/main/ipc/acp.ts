import { ipcInvoke } from '../../shared/ipc-channels'
import { app } from 'electron'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { getMainWindow, getProjectRoot } from '../state'
import {
  deleteAcpProfile,
  listAcpAgents,
  listAcpProfiles,
  pickAcpNode,
  pickAcpRuntimePath,
  saveAcpProfile,
  setupAcpRuntime,
  testAcpRuntimeConnection
} from '../services/daemon-client/acp'
import { handle } from './registry'
import { listAcpRegistryCatalog, searchAcpRegistryCatalog, providerCapabilityMatrix } from '../services/acp/provider-registry'
import { deleteLocalProvider, listLocalProviders, saveLocalProvider } from '../services/acp/local-providers'

export function registerAcpIpc(): void {
  const trustedProviderSender = (event: Electron.IpcMainInvokeEvent): boolean => !event.sender.isDestroyed()
    && getMainWindow()?.webContents.id === event.sender.id && event.senderFrame === event.sender.mainFrame
  handle(ipcInvoke.acp.agents, () => listAcpAgents())
  handle(ipcInvoke.acp.profiles, () => listAcpProfiles(getProjectRoot() ?? ''))
  handle(ipcInvoke.acp.profileSave, (_e, input) => saveAcpProfile(getProjectRoot() ?? '', input))
  handle(ipcInvoke.acp.profileDelete, (_e, id: string) => deleteAcpProfile(getProjectRoot() ?? '', id))
  handle(ipcInvoke.acp.runtimeRefresh, () => listAcpAgents(true))
  handle(ipcInvoke.acp.runtimeSetup, (_e, id: string) => setupAcpRuntime(id))
  handle(ipcInvoke.acp.runtimeNodePick, () => pickAcpNode())
  handle(ipcInvoke.acp.runtimeTest, (_e, id: string) => testAcpRuntimeConnection(id))
  handle(ipcInvoke.acp.runtimePathPick, (_e, id: string) => pickAcpRuntimePath(id))
  handle(ipcInvoke.acp.registryList, (event, refresh: unknown) => trustedProviderSender(event) ? listAcpRegistryCatalog(refresh === true) : ipcFail(IpcErrorCode.Denied, 'Provider 目录仅允许从应用主窗口访问'))
  handle(ipcInvoke.acp.registrySearch, (event, input: unknown) => trustedProviderSender(event) ? searchAcpRegistryCatalog(input) : ipcFail(IpcErrorCode.Denied, 'Provider 目录仅允许从应用主窗口访问'))
  handle(ipcInvoke.acp.localProviderList, event => trustedProviderSender(event) ? { ok: true as const, providers: listLocalProviders(app.getPath('userData')) } : ipcFail(IpcErrorCode.Denied, '本地 provider 仅允许从应用主窗口管理'))
  handle(ipcInvoke.acp.localProviderSave, (event, input: unknown) => trustedProviderSender(event) ? saveLocalProvider(app.getPath('userData'), input) : ipcFail(IpcErrorCode.Denied, '本地 provider 仅允许从应用主窗口管理'))
  handle(ipcInvoke.acp.localProviderDelete, (event, id: unknown) => {
    if (!trustedProviderSender(event)) return ipcFail(IpcErrorCode.Denied, '本地 provider 仅允许从应用主窗口管理')
    if (typeof id !== 'string' || !/^local-[a-z0-9][a-z0-9._-]*$/i.test(id)) return ipcFail(IpcErrorCode.InvalidArg, '本地 provider ID 无效')
    return deleteLocalProvider(app.getPath('userData'), id)
  })
  handle(ipcInvoke.acp.providerCapabilities, (event, id: unknown) => {
    if (!trustedProviderSender(event)) return ipcFail(IpcErrorCode.Denied, 'Provider 能力仅允许从应用主窗口读取')
    if (typeof id !== 'string' || !id.trim()) return ipcFail(IpcErrorCode.InvalidArg, 'Runtime ID 无效')
    return providerCapabilityMatrix(id)
  })
}
