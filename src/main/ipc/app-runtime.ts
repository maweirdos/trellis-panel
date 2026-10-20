import { z } from 'zod'
import { applicationIdSchema, applicationSaveSchema } from '../../shared/app-runtime'
import { IpcErrorCode, ipcFail, noProject, type IpcFail } from '../../shared/ipc-errors'
import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import { getProjectGeneration, getProjectRoot } from '../state'
import { appRuntime } from '../services/app-runtime'
import { canonicalDirectory } from '../services/acp/metadata'
import { broadcastToWindows } from '../services/bridge'
import { applicationConfirmation } from '../services/application-confirmation'
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

export function registerAppRuntimeIpc(deps: WindowDeps): void {
  if (!subscribed) {
    appRuntime.subscribe((event) => {
      const channel = event.kind === 'output' ? ipcEvent.appRuntimeOutput : event.kind === 'done' ? ipcEvent.appRuntimeDone : ipcEvent.appRuntimeChanged
      broadcastToWindows(channel, event)
    })
    subscribed = true
  }

  handle(ipcInvoke.appRuntime.list, (_event, expectedRoot: unknown) => inCurrentProject(expectedRoot, (root) => appRuntime.list(root)))
  handle(ipcInvoke.appRuntime.save, (_event, expectedRoot: unknown, input: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const parsed = applicationSaveSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '应用配置无效，请检查必填项与字段长度')
    return appRuntime.save(root, parsed.data)
  }))
  handle(ipcInvoke.appRuntime.remove, (_event, expectedRoot: unknown, id: unknown, revision: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const appId = applicationIdSchema.safeParse(id)
    const expected = revisionSchema.safeParse(revision)
    if (!appId.success || !expected.success) return ipcFail(IpcErrorCode.InvalidArg, '应用标识或配置版本无效')
    return appRuntime.remove(root, appId.data, expected.data)
  }))
  handle(ipcInvoke.appRuntime.importNpm, (_event, expectedRoot: unknown, dir: unknown, script: unknown, name: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const parsed = z.object({ dir: localPathSchema, script: z.string().min(1).max(256), name: z.string().trim().min(1).max(120).optional() }).safeParse({ dir, script, name })
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '脚本配置无效')
    return appRuntime.importNpm(root, parsed.data.dir, parsed.data.script, parsed.data.name)
  }))
  for (const action of ['start', 'restart'] as const) {
    handle(ipcInvoke.appRuntime[action], (event, expectedRoot: unknown, id: unknown, revision: unknown) => inCurrentProject(expectedRoot, async (root) => {
      const appId = applicationIdSchema.safeParse(id)
      const expected = revisionSchema.optional().safeParse(revision)
      if (!appId.success || !expected.success) return ipcFail(IpcErrorCode.InvalidArg, '应用标识或配置版本无效')
      return appRuntime[action](root, appId.data, {
        expectedRevision: expected.data,
        confirm: applicationConfirmation({ senderId: event.sender.id, generation: getProjectGeneration(), getMain: deps.getMain, getRoot: getProjectRoot, getGeneration: getProjectGeneration })
      })
    }))
  }
  handle(ipcInvoke.appRuntime.stop, (_event, expectedRoot: unknown, id: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const parsed = applicationIdSchema.safeParse(id)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '应用标识无效')
    return appRuntime.stop(root, parsed.data)
  }))
  handle(ipcInvoke.appRuntime.logs, (_event, expectedRoot: unknown, id: unknown, after: unknown) => inCurrentProject(expectedRoot, async (root) => {
    const parsed = z.object({ id: applicationIdSchema, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).safeParse({ id, after })
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '应用标识或输出游标无效')
    return appRuntime.logs(root, parsed.data.id, parsed.data.after)
  }))
}
