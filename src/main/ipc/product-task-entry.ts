import { app, dialog, type BrowserWindow } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ipcInvoke } from '../../shared/ipc-channels'
import { createCruxTaskMaterialsService } from '../services/crux/task-materials'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import type { ProductTaskApi } from '../../shared/product-task-entry'
import type { TaskPlanningRuntimeCatalog } from '../../shared/conversation/task-planning-runtime'
import type { CruxTaskWorkspaceService } from '../services/crux/task-workspace'
import { ProductTaskEntryService, type ProductTaskSource, type ProductTaskEntryPorts } from '../services/product-task-entry'
import { cruxWorkspaceGeneration, cruxWorkspaceSnapshot, cruxWorkspaceStatus } from '../services/crux/connection-service'
import { cruxWorkProjectIdentity, inspectCruxWorkExecutionProject } from '../services/crux/work-project'
import { resolveWorkcopy } from '../services/workcopy-use/identity'
import { withDesktopTeamService } from '../services/team-desktop'
import { runtimeCall, readRuntimeCommandReceipt } from '../services/daemon-client/runtime'
import { hasTaskPlanningOwner, readTaskPlanningDirectoryChoice } from '../services/task-planning/service'
import { ownedDirectory } from '../services/private-conversations/files'
import { handle } from './registry'
import { writeExclusiveAtomic } from '../daemon/files'

const START_DIAGNOSTIC_RECORDS = 256
const START_DIAGNOSTIC_BYTES = 4096

/** Main-window facade; no native RPC, task pin, credential or private material path crosses preload. */
export function registerProductTaskEntryIpc(workspace: CruxTaskWorkspaceService, getMain: () => BrowserWindow | null, ports?: ProductTaskEntryPorts): ProductTaskEntryService {
  const invocations = new AsyncLocalStorage<() => boolean>()
  const sourceIdentity = (s: Awaited<ReturnType<typeof cruxWorkspaceStatus>>): string => JSON.stringify([s.key, s.state, s.connectionId, s.actorId, s.projectId, s.instanceId, s.epoch, s.authorizationRevision])
  const rowKey = (s: ProductTaskSource): string => createHash('sha256')
    .update(JSON.stringify([s.pin.origin, s.pin.actorId, s.pin.deviceId ?? null, s.pin.projectId])).digest('hex')
  const service = new ProductTaskEntryService(ports ?? {
    sourcePart: createCruxTaskMaterialsService(app.getPath('userData')).sourcePart,
    directory: app.getPath('userData'),
    planningActive: query => hasTaskPlanningOwner(app.getPath('userData'), query),
    readScope: async query => {
      const generation = cruxWorkspaceGeneration(), view = await cruxWorkspaceSnapshot(), c = view.context
      const task = view.snapshot.tasks.find(task => task.id === query.taskId && task.spaceId === query.spaceId && task.createdAt === query.taskCreatedAt)
      const space = view.snapshot.spaces.find(space => space.id === task?.spaceId)
      if (c.key !== query.workspaceKey || c.state !== 'connected' || !c.connectionId || !c.instanceId || !c.projectId || !c.actorId || !task || !space?.memberIds.includes(c.actorId)) throw Error('当前账号无法读取原任务成果。')
      const identity = sourceIdentity(c)
      const assertCurrent = (): void => {
        if (generation !== cruxWorkspaceGeneration() || !invocations.getStore()?.()) throw Error('原任务来源已变化，请重新打开。')
      }
      if (sourceIdentity(await cruxWorkspaceStatus()) !== identity) throw Error('原任务来源已变化。')
      assertCurrent()
      return { connectionId: c.connectionId, actorId: c.actorId, handlerId: task.workflow?.handlerId ?? task.assigneeIds[0] ?? null,
        task: { instanceId: c.instanceId, projectId: c.projectId, spaceId: task.spaceId, taskId: task.id, taskCreatedAt: task.createdAt }, assertCurrent }
    },
    access: async query => {
      const generation = cruxWorkspaceGeneration(), view = await cruxWorkspaceSnapshot(), c = view.context
      if (c.key !== query.workspaceKey || c.state !== 'connected' || !c.connectionId || !c.instanceId || !c.actorId) throw Error('请先连接原团队工作区。')
      const task = view.snapshot.tasks.find(t => t.id === query.taskId), space = task && view.snapshot.spaces.find(s => s.id === task.spaceId)
      if (!task || !space?.memberIds.includes(c.actorId)) throw Error('当前账号无法读取原任务。')
      const category = view.snapshot.taskStatuses.find(status => status.id === task.statusId && status.spaceId === task.spaceId)?.category
      if (task.workflow?.stage === 'done' || !task.workflow && ['done', 'cancelled'].includes(category ?? '')) {
        if (!c.projectId) throw Error('原团队项目不可用。')
        const assertCurrent = (): void => {
          if (generation !== cruxWorkspaceGeneration() || !invocations.getStore()?.()) throw Error('原任务来源已变化。')
        }
        if (sourceIdentity(await cruxWorkspaceStatus()) !== sourceIdentity(c)) throw Error('原任务来源已变化。')
        assertCurrent()
        return { legacy: false, blockers: [], closedTask: { connectionId: c.connectionId, actorId: c.actorId,
          task: { instanceId: c.instanceId, projectId: c.projectId, spaceId: task.spaceId, taskId: task.id, taskCreatedAt: task.createdAt }, assertCurrent } }
      }
      const progress = await withDesktopTeamService(team => team.cruxTaskProgress(c.connectionId as string, query.taskId, c.instanceId))
      if (generation !== cruxWorkspaceGeneration() || sourceIdentity(await cruxWorkspaceStatus()) !== sourceIdentity(c) || !invocations.getStore()?.()) throw Error('原任务来源已变化。')
      return { legacy: Boolean(progress.binding), blockers: (task.workflow?.handlerId ?? task.assigneeIds[0]) === c.actorId ? [] : [{ target: 'assignment', message: '请由任务当前处理人继续，或在任务中重新安排处理人。' }] }
    },
    current: s => cruxWorkspaceGeneration() === s.generation && Boolean(invocations.getStore()?.()),
    sameAuthority: async s => {
      const current = await cruxWorkspaceStatus()
      if (!invocations.getStore()?.() || current.key !== rowKey(s) || current.instanceId !== s.pin.instanceId || current.epoch !== s.pin.epoch
        || current.actorId !== s.pin.actorId || current.projectId !== s.pin.projectId) throw Error('原任务来源或授权已变化，请核对原执行。')
    },
    source: async query => {
      const generation = cruxWorkspaceGeneration(), before = await cruxWorkspaceStatus(), identity = sourceIdentity(before)
      if (before.key !== query.workspaceKey || before.state !== 'connected' || !before.connectionId || !before.instanceId || !before.actorId || !before.projectId || !before.epoch || !before.origin) throw Error('请连接原团队工作区后继续开发。')
      const connectionId = before.connectionId, instanceId = before.instanceId
      const result = await withDesktopTeamService(async team => {
        const connection = (await team.connections()).find(c => c.connectionId === connectionId)
        if (!connection || connection.state !== 'active' || connection.accessLocked || connection.ownerId !== before.actorId || connection.projectId !== before.projectId || connection.origin !== before.origin) throw Error('原团队账号或设备不可用。')
        const context = await team.taskDevelopmentContext(connectionId, query.taskId, instanceId)
        const account = await team.connectionContext(connectionId)
        return { pin: { workspaceKey: query.workspaceKey, instanceId, epoch: before.epoch as string, teamId: account.project.teamId,
          actorId: before.actorId as string, connectionId, pairingId: connection.pairingId, deviceId: connection.deviceId,
          origin: connection.origin, projectId: before.projectId as string }, context, generation } satisfies ProductTaskSource
      })
      if (generation !== cruxWorkspaceGeneration() || sourceIdentity(await cruxWorkspaceStatus()) !== identity || !invocations.getStore()?.()) throw Error('读取期间原任务来源已变化，请重新打开。')
      if (result.context.snapshot.actor.id !== before.actorId || result.context.snapshot.instanceId !== before.instanceId || result.context.snapshot.epoch !== before.epoch || result.context.snapshot.projectId !== before.projectId) throw Error('开发上下文与原任务来源不一致。')
      return result
    },
    legacy: async (query, s) => {
      const view = await workspace.development(query)
      if (!view.ok) throw Error(view.error)
      if (view.active || view.history.length) return true
      const progress = await withDesktopTeamService(team => team.cruxTaskProgress(s.pin.connectionId, query.taskId, s.pin.instanceId))
      return Boolean(progress.binding)
    },
    team: withDesktopTeamService,
    choose: async (s, retainedRoot) => {
      const window = getMain()
      if (!window || window.isDestroyed() || !invocations.getStore()?.()) return null
      if (retainedRoot !== undefined && (typeof retainedRoot !== 'string' || !retainedRoot.trim())) return null
      const resource = s.context.codeResource.resource
      let root: string | null = retainedRoot === undefined ? null : realpathSync.native(retainedRoot)
      let rememberedIdentity: string | undefined
      let inspected: Awaited<ReturnType<typeof inspectCruxWorkExecutionProject>> | undefined
      if (retainedRoot === undefined) {
        const choice = readTaskPlanningDirectoryChoice(app.getPath('userData'), {
          pin: s.pin, task: { instanceId: s.pin.instanceId, projectId: s.pin.projectId, spaceId: s.context.inputs.spaceId,
            taskId: s.context.inputs.taskId, taskCreatedAt: s.context.inputs.taskCreatedAt }, codeResource: s.context.codeResource
        })
        if (choice) {
          try {
            const candidate = await inspectCruxWorkExecutionProject(choice.root, resource ?? undefined)
            if (candidate.resourceMatched && cruxWorkProjectIdentity(choice.root) === choice.directoryIdentity) {
              root = choice.root; inspected = candidate; rememberedIdentity = choice.directoryIdentity
            }
          } catch { /* Unavailable directory/resource: use the existing picker below. */ }
          if (!invocations.getStore()?.()) return null
        }
        if (!root) root = await dialog.showOpenDialog(window, { title: '选择任务的本机开发环境', properties: ['openDirectory'] })
          .then(result => result.canceled || !result.filePaths[0] || !invocations.getStore()?.() ? null : realpathSync.native(result.filePaths[0]))
      }
      if (!root || !invocations.getStore()?.()) return null
      inspected ??= await inspectCruxWorkExecutionProject(root, resource ?? undefined)
      if (!inspected.resourceMatched) throw Error('所选目录与任务代码资源不匹配，请选择对应仓库。')
      const answer = await dialog.showMessageBox(window, { type: 'question', title: '确认本机开发环境', message: s.context.snapshot.snapshot.tasks.find(t => t.id === s.context.inputs.taskId)?.title ?? '本机开发环境',
        detail: [resource?.name, root, inspected.git?.branch ?? '分支未核实', '准备固定资料与本机绑定；会在工程内安装应用管理的本地规则包，启动由你另行确认。'].filter(Boolean).join('\n'), buttons: ['取消', '准备'], defaultId: 0, cancelId: 0, noLink: true })
      if (answer.response !== 1 || !invocations.getStore()?.()) return null
      if (rememberedIdentity && cruxWorkProjectIdentity(root) !== rememberedIdentity) throw Error('确认期间原规划工程目录已变化，请重新选择。')
      return root
    },
    inspect: async (selected, context) => {
      const root = realpathSync.native(selected), directoryIdentity = cruxWorkProjectIdentity(root)
      const inspected = await inspectCruxWorkExecutionProject(root, context.codeResource.resource ?? undefined)
      if (!inspected.resourceMatched || cruxWorkProjectIdentity(root) !== directoryIdentity) throw Error('目录或仓库来源与任务代码资源不匹配。')
      const workcopy = resolveWorkcopy(root)
      return { root, directoryIdentity, workcopy: { id: workcopy.id, revision: workcopy.revision } }
    },
    runtime: async (root, engine) => {
      const current = invocations.getStore()
      const selection = engine.conversation
      if (selection) {
        const catalog = await runtimeCall<TaskPlanningRuntimeCatalog, 'runtime.taskPlanningCatalog'>(
          ownedDirectory(app.getPath('userData'), 'conversation-v2-workspace'), 'runtime.taskPlanningCatalog',
          { purpose: 'execution', instanceId: selection.instanceId }, undefined, current)
        const descriptor = catalog.descriptor
        if (catalog.purpose !== 'execution' || !descriptor || descriptor.actions.chat.state === 'unsupported'
          || !catalog.drivers.some(driver => driver.instanceId === selection.instanceId && driver.driverKind === engine.agentId)
          || !descriptor.models.some(model => model.id === selection.model)
          || selection.options?.some(option => !descriptor.options.some(declared => declared.id === option.id && declared.turnSelectable
            && (!declared.modelId || declared.modelId === selection.model) && declared.choices.some(choice => choice.value === option.value)))) {
          throw Error('所选正式执行实例、模型或参数已不可用，请重新选择。')
        }
      }
      return runtimeCall(root, 'runtime.taskExecutionPlan', { engine }, undefined, current)
    },
    preparation: (root, request, commandId, current) => runtimeCall(root, 'runtime.taskPreparation', request, commandId, current),
    execution: (root, request, commandId, current) => runtimeCall(root, 'runtime.taskExecution', request, commandId, current),
    receipt: readRuntimeCommandReceipt
  })
  const register = (operation: keyof ProductTaskApi): void => {
    handle(ipcInvoke.productTask[operation], async (event, input: unknown) => {
      const startEntry = operation === 'start' ? z.object({ entryId: z.string().uuid() }).safeParse(input) : null
      const logStart = <T extends { ok: boolean; code?: string; error?: string }>(reply: T): T => {
        if (startEntry) {
          const entryId = startEntry.success ? startEntry.data.entryId : null
          const diagnostic = JSON.stringify({ at: new Date().toISOString(), entryId, ok: reply.ok,
            ...(!reply.ok ? { code: reply.code, error: reply.error?.replace(/[\r\n]+/g, ' ').slice(0, 400) } : {}) })
          try {
            const directory = join(realpathSync.native(app.getPath('userData')), 'product-task-start-diagnostics')
            if (!existsSync(directory)) mkdirSync(directory)
            if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync.native(directory) !== directory) throw Error('Redirected diagnostics directory')
            const entries = readdirSync(directory)
            const bytes = Buffer.byteLength(diagnostic, 'utf8')
            if (entries.length < START_DIAGNOSTIC_RECORDS && bytes <= START_DIAGNOSTIC_BYTES) {
              let retainedBytes = 0
              for (const name of entries) {
                const entry = lstatSync(join(directory, name))
                if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > START_DIAGNOSTIC_BYTES) throw Error('Invalid diagnostics entry')
                retainedBytes += entry.size
              }
              if (retainedBytes + bytes <= START_DIAGNOSTIC_RECORDS * START_DIAGNOSTIC_BYTES)
                writeExclusiveAtomic(join(directory, `${entryId ?? 'invalid'}-${randomUUID()}.json`), diagnostic)
            }
          } catch { /* Diagnostics cannot change the business reply or admission. */ }
          try { console.info('[productTask.start]', diagnostic) } catch { /* Native GUI stdout may be unavailable. */ }
        }
        return reply
      }
      const window = getMain(), frame = event.senderFrame
      if (!window || window.isDestroyed() || event.sender.isDestroyed() || window.webContents !== event.sender || !frame || frame !== event.sender.mainFrame) return logStart(ipcFail(IpcErrorCode.Denied, '任务执行仅允许原生主窗口访问。'))
      const generation = cruxWorkspaceGeneration()
      let navigated = false
      const onNavigate = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean): void => { if (mainFrame) navigated = true }
      const current = (): boolean => !navigated && !window.isDestroyed() && !event.sender.isDestroyed() && getMain() === window && event.sender.mainFrame === frame
      event.sender.on('did-start-navigation', onNavigate)
      try {
        const value = await invocations.run(() => current() && generation === cruxWorkspaceGeneration(), () => service[operation](input))
        return logStart(current() ? { ok: true, value } : ipcFail(IpcErrorCode.Conflict, '原窗口已变化，请核对原操作。'))
      } catch (error) {
        const nativeCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        const code = error instanceof z.ZodError ? IpcErrorCode.InvalidArg
          : Object.values(IpcErrorCode).find(value => value === nativeCode) ?? IpcErrorCode.Conflict
        return logStart(ipcFail(code, error instanceof z.ZodError ? '任务执行参数不完整或格式不正确。' : error instanceof Error ? error.message : '原执行结果尚未确认，请核对。'))
      }
      finally { if (!event.sender.isDestroyed()) event.sender.removeListener('did-start-navigation', onNavigate) }
    })
  }
  for (const operation of ['read', 'prepare', 'retryPrepare', 'start', 'stop', 'permission', 'reconcile', 'results', 'artifact', 'finish'] as const) register(operation)
  return service
}
