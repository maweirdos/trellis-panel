import { app, dialog, type BrowserWindow } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import type { TaskPlanningApi } from '../../shared/task-planning'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { TaskPlanningService, type TaskPlanningPorts } from '../services/task-planning/service'
import { captureTaskPlanningSource } from '../services/task-planning/source'
import { cruxWorkspaceGeneration, cruxWorkspaceStatus } from '../services/crux/connection-service'
import { createCruxTaskMaterialsService } from '../services/crux/task-materials'
import { withDesktopTeamService } from '../services/team-desktop'
import type { PrivateConversations } from '../services/private-conversations/service'
import { handle } from './registry'

/** Desktop main owns every task, account, physical-root and fixed-material join. */
export function registerTaskPlanningIpc(conversations: PrivateConversations, getMain: () => BrowserWindow | null, overrides?: TaskPlanningPorts): TaskPlanningService {
  const invocations = new AsyncLocalStorage<() => void>()
  const assertCurrent = (): void => {
    const current = invocations.getStore()
    if (!current) throw Error('任务规划只能由原生主窗口发起。')
    current()
  }
  const identity = (value: Awaited<ReturnType<typeof cruxWorkspaceStatus>>): string =>
    JSON.stringify([value.key, value.state, value.connectionId, value.instanceId, value.epoch, value.actorId, value.projectId, value.origin, value.authorizationRevision])
  const dataDir = app.getPath('userData')
  const service = new TaskPlanningService(overrides ?? {
    directory: dataDir, conversations, materials: createCruxTaskMaterialsService(dataDir), assertCurrent,
    source: async (query, retainedRoot, selected = []) => {
      assertCurrent()
      const generation = cruxWorkspaceGeneration(), before = await cruxWorkspaceStatus(), sourceIdentity = identity(before)
      if (before.state !== 'connected' || before.key !== query.workspaceKey || !before.connectionId || !before.instanceId
        || !before.epoch || !before.projectId || !before.actorId || !before.origin) throw Error('请连接原任务所属的团队账号。')
      const connectionId = before.connectionId, instanceId = before.instanceId
      const current = (): void => { assertCurrent(); if (generation !== cruxWorkspaceGeneration()) throw Error('原任务来源已变化。') }
      const access = await withDesktopTeamService(async team => {
        const connection = (await team.connections()).find(item => item.connectionId === connectionId)
        if (!connection || connection.state !== 'active' || connection.accessLocked || connection.ownerId !== before.actorId
          || connection.projectId !== before.projectId || connection.origin !== before.origin) throw Error('原任务账号或设备不可用。')
        const context = await team.taskDevelopmentContext(connectionId, query.taskId, instanceId), account = await team.connectionContext(connectionId)
        current()
        return { pin: { workspaceKey: query.workspaceKey, connectionId, instanceId, epoch: context.snapshot.epoch, projectId: context.snapshot.projectId,
          teamId: account.project.teamId, actorId: context.snapshot.actor.id, pairingId: connection.pairingId, deviceId: connection.deviceId, origin: connection.origin },
        context, assertCurrent: current }
      })
      current()
      if (identity(await cruxWorkspaceStatus()) !== sourceIdentity) throw Error('读取任务资料期间原团队身份已变化。')
      let root = retainedRoot
      if (!root) {
        const window = getMain()
        if (!window || window.isDestroyed()) throw Error('原窗口不可用。')
        const selection = await dialog.showOpenDialog(window, { title: '选择任务规划工程', properties: ['openDirectory'] })
        current()
        if (selection.canceled || !selection.filePaths[0]) return null
        root = selection.filePaths[0]
      }
      const source = await captureTaskPlanningSource(dataDir, query, access, root, selected)
      current()
      if (identity(await cruxWorkspaceStatus()) !== sourceIdentity) throw Error('固定资料读取期间原团队身份已变化。')
      return source
    },
    selectFiles: async root => {
      assertCurrent()
      const window = getMain()
      if (!window || window.isDestroyed()) throw Error('原窗口不可用。')
      const result = await dialog.showOpenDialog(window, { title: '选取本次规划的工程规范与代码', defaultPath: root, properties: ['openFile', 'multiSelections'] })
      assertCurrent()
      if (result.canceled) return null
      return result.filePaths.map(file => {
        const path = relative(root, file)
        if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw Error('只能选取原工程内的固定资料。')
        return path.replaceAll('\\', '/')
      })
    }
  })
  for (const method of ['read', 'prepare', 'selectSources', 'generate', 'respond', 'reconcile', 'stop', 'saveDraft', 'recoverSave'] as const satisfies readonly (keyof TaskPlanningApi)[]) {
    handle(ipcInvoke.taskPlanning[method], async (event, input: unknown) => {
      const main = getMain(), frame = event.senderFrame
      if (!main || main.isDestroyed() || event.sender.isDestroyed() || main.webContents !== event.sender || !frame || frame !== event.sender.mainFrame) return ipcFail(IpcErrorCode.Denied, '任务规划仅允许原生主窗口操作。')
      const responseWorkspaceGeneration = method === 'respond' ? cruxWorkspaceGeneration() : undefined
      let navigated = false
      const onNavigate = (_event: Electron.Event, _url: string, inPlace: boolean, isMainFrame: boolean): void => { if (isMainFrame && !inPlace) navigated = true }
      const current = (): void => {
        if (navigated || main.isDestroyed() || event.sender.isDestroyed() || getMain() !== main || event.sender.mainFrame !== frame) throw Error('原窗口已变化，请回原任务核对原操作。')
        if (responseWorkspaceGeneration !== undefined && responseWorkspaceGeneration !== cruxWorkspaceGeneration()) throw Error('原团队账号或连接已变化，未继续确认。')
      }
      event.sender.on('did-start-navigation', onNavigate)
      try {
        const value = await invocations.run(current, () => service[method](input))
        current()
        return { ok: true, value }
      } catch (error) {
        return ipcFail(error instanceof z.ZodError ? IpcErrorCode.InvalidArg : IpcErrorCode.Conflict,
          error instanceof z.ZodError ? '任务规划参数不完整或格式不正确。' : error instanceof Error ? error.message : '原规划结果尚待核对。')
      } finally { if (!event.sender.isDestroyed()) event.sender.removeListener('did-start-navigation', onNavigate) }
    })
  }
  return service
}
