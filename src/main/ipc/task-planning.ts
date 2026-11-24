import { app, dialog, type BrowserWindow } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import type { TaskPlanningApi } from '../../shared/task-planning'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { TaskPlanningService, type TaskPlanningPorts } from '../services/task-planning/service'
import { captureTaskPlanningSource } from '../services/task-planning/source'
import { assertPlanningCleanupAccess, assertPlanningReadAccess, planningTeamSelection, readPlanningIntent, type PlanningIntent } from '../services/task-planning/runtime-authority'
import { cruxStableWorkspaceGeneration, cruxWorkspaceStatus } from '../services/crux/connection-service'
import { createCruxTaskMaterialsService } from '../services/crux/task-materials'
import { taskPlanningRuntimeBodies, type TaskPlanningRuntimeCatalog, type TaskPlanningRuntimeObservation } from '../../shared/conversation/task-planning-runtime'
import { ownedDirectory } from '../services/private-conversations/files'
import { runtimeCall } from '../services/daemon-client/runtime'
import { withDesktopTeamService } from '../services/team-desktop'
import type { PrivateConversations } from '../services/private-conversations/service'
import { handle } from './registry'
import { captureAppWindowDocument } from '../services/window-navigation'
import { workTaskActionChannel } from '../../shared/conversation/work-task-action'
import { WorkConversationTaskActions } from '../services/conversation/work-task-action'

/** Desktop main owns every task, account, physical-root and fixed-material join. */
export function registerTaskPlanningIpc(_conversations: PrivateConversations, getMain: () => BrowserWindow | null, overrides?: TaskPlanningPorts): TaskPlanningService {
  const invocations = new AsyncLocalStorage<() => void>()
  const assertCurrent = (): void => {
    const current = invocations.getStore()
    if (!current) throw Error('任务规划只能由原生主窗口发起。')
    current()
  }
  function guard(): boolean {
    try { assertCurrent(); return true } catch { return false }
  }
  const identity = (value: Awaited<ReturnType<typeof cruxWorkspaceStatus>>): string =>
    JSON.stringify([value.key, value.state, value.connectionId, value.instanceId, value.epoch, value.actorId, value.projectId, value.origin, value.authorizationRevision])
  const dataDir = app.getPath('userData')
  const assertOriginalAccount = async (record: PlanningIntent): Promise<void> => {
    assertCurrent()
    const current = await cruxWorkspaceStatus(), pin = record.source.pin
    assertCurrent()
    if (current.state !== 'connected' || current.key !== pin.workspaceKey || current.connectionId !== pin.connectionId
      || current.actorId !== pin.actorId || current.projectId !== pin.projectId || current.instanceId !== pin.instanceId
      || current.epoch !== pin.epoch || current.origin !== pin.origin) {
      throw Error('请用原任务的团队账号核对规划。')
    }
  }
  const workTask = new WorkConversationTaskActions(dataDir)
  handle(workTaskActionChannel, async (event, input: unknown) => {
    const main = getMain()
    const document = main && captureAppWindowDocument(main, event)
    if (!main || !document) return ipcFail(IpcErrorCode.Denied, '任务关联仅允许原生主窗口操作。')
    const guard = () => getMain() === main && document() && app.getPath('userData') === dataDir
    try {
      const value = await workTask.execute(input, guard)
      if (!guard()) return ipcFail(IpcErrorCode.Conflict, '原 Work 页面已变化，请回原对话核对。')
      return { ok: true as const, value }
    } catch (error) {
      return ipcFail(error instanceof z.ZodError ? IpcErrorCode.InvalidArg : IpcErrorCode.Conflict,
        error instanceof z.ZodError ? '任务关联参数无效。' : error instanceof Error ? error.message : '原任务关联结果尚待核对。')
    }
  })
  const service = new TaskPlanningService(overrides ?? {
    profile: dataDir, materials: createCruxTaskMaterialsService(dataDir), assertCurrent,
    assertAccount: async (record, confirmTaskRead) => {
      await assertOriginalAccount(record)
      if (planningTeamSelection(dataDir, record.source.pin.connectionId) !== record.teamSelection) {
        throw Error('请用原任务的团队账号核对规划。')
      }
      if (confirmTaskRead) await assertPlanningReadAccess(dataDir, record, assertCurrent)
    },
    assertCleanupAccount: async record => {
      await assertOriginalAccount(record)
      await assertPlanningCleanupAccess(dataDir, record, assertCurrent)
    },
    launch: input => runtimeCall<TaskPlanningRuntimeObservation, 'runtime.taskPlanningLaunch'>(
      readPlanningIntent(dataDir, input.planningId).record.source.root, 'runtime.taskPlanningLaunch', input, input.commandId, guard),
    observe: input => runtimeCall<TaskPlanningRuntimeObservation, 'runtime.taskPlanningObserve'>(
      readPlanningIntent(dataDir, input.planningId).record.source.root, 'runtime.taskPlanningObserve', input, undefined, guard),
    stop: input => runtimeCall<TaskPlanningRuntimeObservation, 'runtime.taskPlanningStop'>(
      readPlanningIntent(dataDir, input.planningId).record.source.root, 'runtime.taskPlanningStop', input, input.stopCommandId, guard),
    source: async (query, retainedRoot, selected = []) => {
      assertCurrent()
      const generation = cruxStableWorkspaceGeneration(), before = await cruxWorkspaceStatus(), sourceIdentity = identity(before)
      if (before.state !== 'connected' || before.key !== query.workspaceKey || !before.connectionId || !before.instanceId
        || !before.epoch || !before.projectId || !before.actorId || !before.origin) throw Error('请连接原任务所属的团队账号。')
      const connectionId = before.connectionId, instanceId = before.instanceId
      const selection = planningTeamSelection(dataDir, connectionId)
      const current = (): void => {
        assertCurrent()
        if (generation !== cruxStableWorkspaceGeneration() || planningTeamSelection(dataDir, connectionId) !== selection) throw Error('原任务来源已变化。')
      }
      const access = await withDesktopTeamService(async team => {
        const connection = (await team.connections()).find(item => item.connectionId === connectionId)
        if (!connection || connection.state !== 'active' || connection.accessLocked || connection.ownerId !== before.actorId
          || connection.projectId !== before.projectId || connection.origin !== before.origin) throw Error('原任务账号或设备不可用。')
        const context = await team.taskDevelopmentContext(connectionId, query.taskId, instanceId), account = await team.connectionContext(connectionId)
        current()
        if (context.snapshot.epoch !== before.epoch || context.snapshot.authorizationRevision !== before.authorizationRevision) throw Error('原团队授权已变化。')
        await team.authorizeTaskProgress(connectionId)
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
      const assignmentGeneration = access.context.snapshot.snapshot.tasks.find(task =>
        task.id === query.taskId && task.createdAt === query.taskCreatedAt && task.spaceId === query.spaceId)?.assigneeGeneration
      if (assignmentGeneration === undefined) throw Error('团队服务未提供原任务分配代次。')
      return { source, teamSelection: selection, assignmentGeneration, authorizationRevision: access.context.snapshot.authorizationRevision }
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
  const catalog = async (raw: unknown): Promise<TaskPlanningRuntimeCatalog> => {
    const input = taskPlanningRuntimeBodies['runtime.taskPlanningCatalog'].parse(raw)
    return runtimeCall<TaskPlanningRuntimeCatalog, 'runtime.taskPlanningCatalog'>(
      ownedDirectory(dataDir, 'conversation-v2-workspace'), 'runtime.taskPlanningCatalog', input, undefined, guard)
  }
  const methods = { catalog, read: service.read.bind(service), prepare: service.prepare.bind(service), selectSources: service.selectSources.bind(service),
    generate: service.generate.bind(service), respond: service.respond.bind(service), reconcile: service.reconcile.bind(service),
    stop: service.stop.bind(service), saveDraft: service.saveDraft.bind(service), recoverSave: service.recoverSave.bind(service) }
  for (const method of Object.keys(methods) as Array<keyof TaskPlanningApi>) {
    handle(ipcInvoke.taskPlanning[method], async (event, input: unknown) => {
      const main = getMain()
      const document = main && captureAppWindowDocument(main, event)
      if (!main || !document) return ipcFail(IpcErrorCode.Denied, '任务规划仅允许原生主窗口操作。')
      const workspaceGeneration = cruxStableWorkspaceGeneration()
      const current = (): void => {
        if (getMain() !== main || !document() || app.getPath('userData') !== dataDir || workspaceGeneration !== cruxStableWorkspaceGeneration()) {
          throw Error('原窗口或团队账号已变化，请回原任务核对。')
        }
      }
      try {
        const value = await invocations.run(current, async () => { current(); return methods[method](input) })
        current()
        return { ok: true, value }
      } catch (error) {
        return ipcFail(error instanceof z.ZodError ? IpcErrorCode.InvalidArg : IpcErrorCode.Conflict,
          error instanceof z.ZodError ? '任务规划参数不完整或格式不正确。' : error instanceof Error ? error.message : '原规划结果尚待核对。')
      }
    })
  }
  return service
}
