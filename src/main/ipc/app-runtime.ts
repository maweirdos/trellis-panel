import { z } from 'zod'
import { dialog } from 'electron'
import { applicationIdSchema, applicationSaveSchema, applicationRunIdSchema, applicationInstanceTargetSchema, applicationInventoryInputSchema, type ApplicationLaunchPreview } from '../../shared/app-runtime'
import { IpcErrorCode, ipcFail, noProject, type IpcFail } from '../../shared/ipc-errors'
import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import { getProjectGeneration, getProjectRoot } from '../state'
import { appRuntime } from '../services/app-runtime'
import { canonicalDirectory } from '../services/acp/metadata'
import { applicationConfirmation } from '../services/application-confirmation'
import { applicationTaskPlanRequestSchema, applicationTaskVerifyRequestSchema, applicationTaskStartRequestSchema, applicationTaskReuseRequestSchema, applicationTaskDetachRequestSchema } from '../../shared/app-task-runtime'
import type { TaskApplicationService } from '../services/app-runtime/task-services'
import type { WindowDeps } from './deps'
import { handle } from './registry'

const revisionSchema = z.string().min(1).max(100)
const localPathSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\0'))
let subscribed = false

async function inCurrentProject<T>(expectedRoot: unknown, operation: (root: string) => Promise<T>): Promise<T | IpcFail> {
  const root = getProjectRoot()
  if (!root) return noProject()
  const parsed = localPathSchema.safeParse(expectedRoot)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '缺少有效的项目范围，请刷新后重试')
  if (canonicalDirectory(parsed.data) !== canonicalDirectory(root)) {
    return ipcFail(IpcErrorCode.Conflict, '项目已经切换，请在当前项目中重试')
  }
  try {
    return await operation(root)
  } catch {
    return ipcFail(IpcErrorCode.Io, '应用操作未完成，请检查配置与运行状态')
  }
}

export function registerAppRuntimeIpc(deps: WindowDeps, taskService?: TaskApplicationService): void {
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean => {
    const window = deps.getMain()
    return Boolean(window && !window.isDestroyed() && !event.sender.isDestroyed() && window.webContents === event.sender && event.senderFrame === event.sender.mainFrame)
  }
  const register = (channel: string, listener: Parameters<typeof handle>[1]): void => {
    handle(channel, async (event, ...args) => {
      if (!trusted(event)) return ipcFail(IpcErrorCode.Denied, '本机运行仅允许主窗口访问')
      try { return await listener(event, ...args) }
      catch { return ipcFail(IpcErrorCode.Io, '操作结果未能确认，请核对原实例状态') }
    })
  }
  // Pin native decisions to the submitting window/document, independently of browsing roots.
  const nativeDecision = async (event: Electron.IpcMainInvokeEvent, options: Electron.MessageBoxOptions): Promise<boolean> => {
    const window = deps.getMain()
    const frame = event.senderFrame
    if (!window || !trusted(event)) return false
    let navigated = false
    const onNavigate = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean): void => { if (mainFrame) navigated = true }
    event.sender.on('did-start-navigation', onNavigate)
    try {
      const result = await dialog.showMessageBox(window, options)
      return result.response === 1 && !navigated && deps.getMain() === window && trusted(event) && event.senderFrame === frame
    } finally { if (!event.sender.isDestroyed()) event.sender.removeListener('did-start-navigation', onNavigate) }
  }
  if (!subscribed) {
    appRuntime.subscribe((event) => {
      const channel = event.kind === 'output' ? ipcEvent.appRuntimeOutput : event.kind === 'done' ? ipcEvent.appRuntimeDone : ipcEvent.appRuntimeChanged
      const window = deps.getMain()
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, event)
    })
    subscribed = true
  }

  register(ipcInvoke.appRuntime.list, (_event, expectedRoot: unknown) => inCurrentProject(expectedRoot, (root) => appRuntime.list(root)))
  register(ipcInvoke.appRuntime.save, (_event, expectedRoot: unknown, input: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const parsed = applicationSaveSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '应用配置无效，请检查必填项与字段长度')
    return appRuntime.save(root, parsed.data)
  }))
  register(ipcInvoke.appRuntime.remove, (_event, expectedRoot: unknown, id: unknown, revision: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const appId = applicationIdSchema.safeParse(id)
    const expected = revisionSchema.safeParse(revision)
    if (!appId.success || !expected.success) return ipcFail(IpcErrorCode.InvalidArg, '应用标识或配置版本无效')
    return appRuntime.remove(root, appId.data, expected.data)
  }))
  register(ipcInvoke.appRuntime.importNpm, (_event, expectedRoot: unknown, dir: unknown, script: unknown, name: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const parsed = z.object({ dir: localPathSchema, script: z.string().min(1).max(256), name: z.string().trim().min(1).max(120).optional() }).safeParse({ dir, script, name })
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '脚本配置无效')
    return appRuntime.importNpm(root, parsed.data.dir, parsed.data.script, parsed.data.name)
  }))
  for (const action of ['start', 'restart'] as const) {
    register(ipcInvoke.appRuntime[action], (event, expectedRoot: unknown, id: unknown, revision: unknown, expectedRunId: unknown) => inCurrentProject(expectedRoot, async (root) => {
      const appId = applicationIdSchema.safeParse(id)
      const expected = revisionSchema.optional().safeParse(revision)
      const run = (action === 'restart' ? applicationRunIdSchema : applicationRunIdSchema.optional()).safeParse(expectedRunId)
      if (!appId.success || !expected.success || !run.success) return ipcFail(IpcErrorCode.InvalidArg, '应用标识、配置版本或原实例无效')
      const generation = getProjectGeneration()
      const original = await appRuntime.get(root, appId.data)
      if (!original.ok) return original
      const serviceUses = original.app.serviceUses ?? []
      if (action === 'restart' && serviceUses.length > 0 && !await nativeDecision(event, {
        type: 'question', title: '重启任务使用中的服务', message: `重启 ${original.app.definition.name}？`,
        detail: [`原实例：${run.data}`, `影响任务：${serviceUses.map(use => use.taskLabel).join('、')}`, '原引用继续保留原实例身份；新实例需由任务明确重新引用。'].join('\n'),
        buttons: ['取消', '继续核对重启'], defaultId: 0, cancelId: 0, noLink: true
      })) return ipcFail(IpcErrorCode.Denied, '已取消重启')
      return appRuntime[action](root, appId.data, {
        expectedRevision: expected.data,
        expectedRunId: run.data,
        expectedServiceUseIds: serviceUses.map(use => use.id),
        isCurrent: () => trusted(event) && getProjectGeneration() === generation && getProjectRoot() !== null && canonicalDirectory(getProjectRoot() ?? '') === canonicalDirectory(root),
        confirm: applicationConfirmation({ senderId: event.sender.id, generation: getProjectGeneration(), getMain: deps.getMain, getRoot: getProjectRoot, getGeneration: getProjectGeneration })
      })
    }))
  }
  register(ipcInvoke.appRuntime.stop, (event, expectedRoot: unknown, id: unknown, expectedRunId: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const parsed = applicationIdSchema.safeParse(id)
    const run = applicationRunIdSchema.safeParse(expectedRunId)
    if (!parsed.success || !run.success) return ipcFail(IpcErrorCode.InvalidArg, '应用标识或原实例无效')
    const original = await appRuntime.get(root, parsed.data)
    if (!original.ok) return original
    if (original.app.run?.id !== run.data) return ipcFail(IpcErrorCode.Conflict, '原实例已变化，请重新核对')
    const uses = original.app.serviceUses ?? []
    if (uses.length > 0 && !await nativeDecision(event, {
      type: 'question', title: '停止任务使用中的服务', message: `停止 ${original.app.definition.name}？`, detail: `影响任务：${uses.map(use => use.taskLabel).join('、')}\n原实例：${run.data}`,
      buttons: ['取消', '停止此实例'], defaultId: 0, cancelId: 0, noLink: true
    })) return ipcFail(IpcErrorCode.Denied, '已取消停止')
    return appRuntime.stop(root, parsed.data, run.data, uses.map(use => use.id))
  }))
  register(ipcInvoke.appRuntime.logs, (_event, expectedRoot: unknown, id: unknown, after: unknown, expectedRunId: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const parsed = z.object({ id: applicationIdSchema, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), expectedRunId: applicationRunIdSchema }).safeParse({ id, after, expectedRunId })
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '应用标识或输出游标无效')
    return appRuntime.logs(root, parsed.data.id, parsed.data.after, parsed.data.expectedRunId)
  }))
  register(ipcInvoke.appRuntime.inventory, (_event, input: unknown) => {
    const parsed = applicationInventoryInputSchema.safeParse(input ?? {})
    return parsed.success ? appRuntime.inventory(parsed.data) : ipcFail(IpcErrorCode.InvalidArg, '运行清单参数无效')
  })
  register(ipcInvoke.appRuntime.logsInstance, (_event, input: unknown, after: unknown) => {
    const parsed = z.object({ target: applicationInstanceTargetSchema, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).safeParse({ target: input, after })
    return parsed.success ? appRuntime.logsInstance(parsed.data.target, parsed.data.after) : ipcFail(IpcErrorCode.InvalidArg, '实例或输出游标无效')
  })
  register(ipcInvoke.appRuntime.detachInstanceReference, async (event, input: unknown, referenceId: unknown) => {
    const parsed = z.object({ target: applicationInstanceTargetSchema, referenceId: z.string().uuid() }).strict().safeParse({ target: input, referenceId })
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '原实例或引用标识无效')
    const original = await appRuntime.inspectInstanceReference(parsed.data.target, parsed.data.referenceId)
    if (!original.ok) return original
    const reference = original.reference
    const accepted = await nativeDecision(event, {
      type: 'question', title: '解除原实例的任务引用', message: `解除 ${reference.taskLabel} 的这项服务引用？`,
      detail: [`原副本：${reference.root}`, `应用：${reference.appId}`, `原实例：${reference.runId}`, `配置修订：${reference.configRevision}`, `引用：${reference.id}`,
        original.historical ? '原实例已被替换；只移除此历史引用，不操作当前新实例。' : '服务仍由本机运行中心管理，其他任务引用保留。若此任务仍有在途写入，请先完成原执行后重试解绑。',
        '此操作只撤销既有引用及其消费权限，不新增任务授权。'].join('\n'),
      buttons: ['取消', '解除此引用'], defaultId: 0, cancelId: 0, noLink: true
    })
    if (!accepted) return ipcFail(IpcErrorCode.Denied, '已取消解绑')
    return appRuntime.detachInstanceReference(parsed.data.target, parsed.data.referenceId)
  })
  register(ipcInvoke.appRuntime.stopInstance, async (event, input: unknown) => {
    const parsed = applicationInstanceTargetSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '运行实例目标无效')
    const original = await appRuntime.inspectInstance(parsed.data)
    if (!original.ok) return original
    const snapshot = original.app.run?.snapshot
    const accepted = await nativeDecision(event, {
      type: 'question', title: '停止本机实例', message: `停止 ${snapshot?.status === 'known' ? snapshot.name : parsed.data.appId}？`,
      detail: [`副本：${original.root}`, `实例：${parsed.data.expectedRunId}`, original.app.serviceUses?.length ? `影响任务：${original.app.serviceUses.map(use => use.taskLabel).join('、')}` : '独立运行；未登记团队任务引用'].join('\n'),
      buttons: ['取消', '停止此实例'], defaultId: 0, cancelId: 0, noLink: true
    })
    if (!accepted) return { ...ipcFail(IpcErrorCode.Denied, '已取消停止'), root: original.root, appId: parsed.data.appId, app: original.app }
    const uses = original.app.serviceUses?.map(use => use.id) ?? []
    const result = await appRuntime.stopInstance(parsed.data, uses)
    if (result.ok || result.reason !== 'CLEANUP_REQUIRED') return result
    const current = await appRuntime.inspectInstance(parsed.data)
    if (!current.ok) return current
    const cleared = await nativeDecision(event, {
      type: 'warning', title: '核对异常退出后的原服务', message: '已在操作系统中核对并清理原服务？',
      detail: [`副本：${current.root}`, `原实例：${parsed.data.expectedRunId}`, `${current.app.run?.pidRole === 'supervisor' ? '原托管 PID' : '原 PID'}：${current.app.run?.pid ?? '未知'}`,
        current.app.serviceUses?.length ? `影响任务：${current.app.serviceUses.map(use => use.taskLabel).join('、')}` : '独立运行',
        '仅在你已通过系统工具核对并清理原服务及其子进程后确认。平台将再次检查原 PID 与声明端口；不能核实则继续保留未知占用。'].join('\n'),
      buttons: ['保留待核对', '已在系统核对清理'], defaultId: 0, cancelId: 0, noLink: true
    })
    return cleared ? appRuntime.stopInstance(parsed.data, current.app.serviceUses?.map(use => use.id) ?? [], true) : result
  })
  register(ipcInvoke.appRuntime.restartInstance, async (event, input: unknown, revision: unknown) => {
    const parsed = applicationInstanceTargetSchema.safeParse(input)
    const expected = revisionSchema.safeParse(revision)
    if (!parsed.success || !expected.success) return ipcFail(IpcErrorCode.InvalidArg, '运行实例或配置版本无效')
    const target = parsed.data
    const original = await appRuntime.inspectInstance(target)
    if (!original.ok) return original
    const uses = original.app.serviceUses ?? []
    return appRuntime.restartInstance(target, {
      expectedRevision: expected.data, requireConfirmation: true,
      expectedServiceUseIds: uses.map(use => use.id),
      confirm: (preview: ApplicationLaunchPreview) => {
        if (preview.root !== target.root || preview.appId !== target.appId || preview.revision !== expected.data) return Promise.resolve(false)
        return nativeDecision(event, {
          type: 'question', title: '重启本机实例', message: `重启 ${preview.name}？`,
          detail: [`原副本：${target.root}`, `原实例：${target.expectedRunId}`, `新配置修订：${preview.revision}`, `目录：${preview.cwd}`, `命令：${preview.command}`, `副本使用：${preview.workcopyAccess === 'consumer' ? '只读消费源码' : '可能写入源码或配置'}`, '环境：重新按当前输入核验', uses.length ? `影响任务：${uses.map(use => use.taskLabel).join('、')}；新实例需明确重新引用` : '独立运行；未登记团队任务引用', preview.envFiles.length ? `环境文件：${preview.envFiles.join('、')}` : '', preview.overrideKeys.length ? `环境覆盖：${preview.overrideKeys.join('、')}` : '', preview.ports.length ? `端口：${preview.ports.map((port) => `${port.host}:${port.port}`).join('、')}` : ''].filter(Boolean).join('\n'),
          buttons: ['取消', '核对并重启'], defaultId: 0, cancelId: 0, noLink: true
        })
      }
    })
  })
  register(ipcInvoke.appRuntime.taskPlan, (_event, input: unknown) => {
    const parsed = applicationTaskPlanRequestSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '任务开发上下文无效，请重新进入原任务')
    return taskService ? taskService.plan(parsed.data) : ipcFail(IpcErrorCode.Unavailable, '任务运行服务尚未接入')
  })
  register(ipcInvoke.appRuntime.taskVerify, (event, input: unknown) => {
    const parsed = applicationTaskVerifyRequestSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '原任务启动计划无效')
    if (!taskService) return ipcFail(IpcErrorCode.Unavailable, '任务运行服务尚未接入')
    return taskService.verifyEnvironment(parsed.data, inspection => {
      const snapshot = inspection.snapshot
      return nativeDecision(event, {
        type: 'question', title: '人工核对启动环境', message: `已核对 ${inspection.app.definition.name} 的实际环境？`,
        detail: [`任务：${parsed.data.query.taskId}`, `副本：${snapshot.status === 'known' ? snapshot.root : '未知'}`, `副本使用：${snapshot.status === 'known' ? snapshot.workcopy?.access ?? '未知' : '未知'}`, `实际 cwd：${snapshot.status === 'known' ? snapshot.cwd : '未知'}`,
          `配置修订：${inspection.app.definition.revision}`, `环境：${inspection.environment.selection}`,
          `脱敏目标：${inspection.environment.targets.map(target => `${target.key}=${target.endpoint ?? '未知'}`).join('；') || '已明确声明无外部依赖'}`,
          `环境文件（依次加载）：${snapshot.status === 'known' ? snapshot.environment.envFiles.join(' → ') || '无' : '未知'}`,
          '核对方式：本机人工确认；未使用自动环境适配器。环境、分支或配置变化后须重新核对。'].join('\n'),
        buttons: ['取消', '已核对环境'], defaultId: 0, cancelId: 0, noLink: true
      })
    })
  })
  register(ipcInvoke.appRuntime.taskStart, (event, input: unknown) => {
    const parsed = applicationTaskStartRequestSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '原任务启动核对无效')
    if (!taskService) return ipcFail(IpcErrorCode.Unavailable, '任务运行服务尚未接入')
    return taskService.start(parsed.data, preview => nativeDecision(event, {
      type: 'question', title: '启动任务服务', message: `启动 ${preview.name}？`,
      detail: [`任务：${parsed.data.query.taskId}`, `原副本：${preview.root}`, `实际 cwd：${preview.cwd}`, `配置修订：${preview.revision}`, `命令：${preview.command}`, `副本使用：${preview.workcopyAccess === 'consumer' ? '只读消费源码' : '可能写入源码或配置'}`, `端口：${preview.ports.map(port => `${port.host}:${port.port}`).join('、') || '未声明'}`].join('\n'),
      buttons: ['取消', '启动并引用'], defaultId: 0, cancelId: 0, noLink: true
    }))
  })
  register(ipcInvoke.appRuntime.taskReuse, (_event, input: unknown) => {
    const parsed = applicationTaskReuseRequestSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '原任务或复用实例无效')
    return taskService ? taskService.reuse(parsed.data) : ipcFail(IpcErrorCode.Unavailable, '任务运行服务尚未接入')
  })
  register(ipcInvoke.appRuntime.taskDetach, (_event, input: unknown) => {
    const parsed = applicationTaskDetachRequestSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '原任务服务引用无效')
    return taskService ? taskService.detach(parsed.data) : ipcFail(IpcErrorCode.Unavailable, '任务运行服务尚未接入')
  })
}
