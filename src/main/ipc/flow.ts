import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { deleteFlow, generateFlow, installTemplate, builtinTemplates, listFlows, readFlow, saveFlow } from '../services/flow'
import { abortRun, listRunRecords, startFlowRun } from '../services/flow-run'
import { getProjectRoot } from '../state'
import { errorMessage } from '../../shared/errors'
import type { FlowDef } from '../../shared/types'
import { handle } from './registry'

export function registerFlowIpc(): void {
  handle(ipcInvoke.flow.list, () => {
    const root = getProjectRoot()
    if (!root) return { ok: true, flows: [] }
    return { ok: true, flows: listFlows(root) }
  })

  handle(ipcInvoke.flow.read, (_e, id: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const def = readFlow(root, String(id ?? ''))
    if (!def) return ipcFail(IpcErrorCode.NotFound, '工作流不存在')
    return { ok: true, def }
  })

  handle(ipcInvoke.flow.save, (_e, def: FlowDef) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const res = saveFlow(root, def)
    if (!res.ok) return ipcFail(IpcErrorCode.InvalidArg, res.error ?? '保存失败')
    return { ok: true, path: res.path }
  })

  handle(ipcInvoke.flow.delete, (_e, id: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const res = deleteFlow(root, String(id ?? ''))
    if (!res.ok) return ipcFail(IpcErrorCode.InvalidArg, res.error ?? '删除失败')
    return { ok: true }
  })

  handle(ipcInvoke.flow.generate, async (_e, description: string) => {
    try {
      return await generateFlow(String(description ?? ''))
    } catch (e) {
      return { ok: false, error: errorMessage(e) ?? '生成失败' }
    }
  })

  handle(ipcInvoke.flow.templates, () => ({ ok: true, templates: builtinTemplates() }))

  handle(ipcInvoke.flow.installTemplate, (_e, def: FlowDef) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const res = installTemplate(root, def)
    if (!res.ok) return ipcFail(IpcErrorCode.Conflict, res.error ?? '安装失败')
    return { ok: true }
  })

  handle(ipcInvoke.flow.run, (_e, id: string, input: Record<string, string>) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const def = readFlow(root, String(id ?? ''))
    if (!def) return ipcFail(IpcErrorCode.NotFound, '工作流不存在')
    return startFlowRun(def, input ?? {})
  })

  handle(ipcInvoke.flow.abort, (_e, runId: string) => abortRun(String(runId ?? '')))

  handle(ipcInvoke.flow.runs, (_e, limit?: number) => ({ ok: true, runs: listRunRecords(Math.min(Math.max(limit ?? 20, 1), 100)) }))
}
