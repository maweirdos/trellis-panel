/** Typed team bridge; machine credentials/trusted source adapters are never IPC options. */
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import { ipcInvoke } from '../../shared/ipc-channels'
import { desktopWorkflowPublicationSchema, type TeamDesktopReply } from '../../shared/team-desktop-bridge'
import type { DesktopTeamApi } from '../../shared/team-desktop'
import { getProjectRoot, getProjectGeneration } from '../state'
import { resolveTeamPublicationSource } from '../services/team-publication-source'
import { withDesktopTeamService, notifyDesktopTeamChanged } from '../services/team-desktop'
import { handle } from './registry'

async function reply<T>(work: () => Promise<T>): Promise<TeamDesktopReply<T>> {
  try { return { ok: true, value: await work() } }
  catch (error) {
    const known = error && typeof error === 'object' ? error as { code?: unknown; outcomeUnknown?: unknown; message?: unknown } : {}
    return { ok: false, code: error instanceof z.ZodError ? 'INVALID_INPUT' : typeof known.code === 'string' ? known.code.slice(0, 200) : 'SERVICE_UNAVAILABLE',
      error: (error instanceof z.ZodError ? '团队操作参数无效' : typeof known.message === 'string' ? known.message : '团队服务暂不可用，原操作身份已保留').replace(/td_[A-Za-z0-9_-]{43}/g, '[credential]').slice(0, 2000), outcomeUnknown: known.outcomeUnknown === true }
  }
}
export function registerTeamDesktopIpc(): void {
  const call = <T>(action: (service: DesktopTeamApi) => Promise<T>, mutation = false) => reply(async () => {
    try { return await withDesktopTeamService(action) }
    finally { if (mutation) notifyDesktopTeamChanged() }
  })
  handle(ipcInvoke.teamDesktop.connections, () => call((service) => service.connections()))
  handle(ipcInvoke.teamDesktop.connectionContext, (_event, id) => call((service) => service.connectionContext(id)))
  handle(ipcInvoke.teamDesktop.beginPairing, (_event, input) => call((service) => service.beginPairing(input), true))
  handle(ipcInvoke.teamDesktop.openPairing, (_event, id) => call((service) => service.openPairing(id), true))
  handle(ipcInvoke.teamDesktop.pollPairing, (_event, id) => call((service) => service.pollPairing(id), true))
  handle(ipcInvoke.teamDesktop.disconnect, (_event, id) => call((service) => service.disconnect(id), true))
  handle(ipcInvoke.teamDesktop.heartbeat, (_event, id) => call((service) => service.heartbeat(id), true))
  handle(ipcInvoke.teamDesktop.queueAuthoredPublication, (_event, input) => call((service) => service.queueAuthoredPublication(input), true))
  handle(ipcInvoke.teamDesktop.queueFeedback, (_event, input) => call((service) => service.queueFeedback(input), true))
  handle(ipcInvoke.teamDesktop.outbox, (_event, id, options) => call((service) => service.outbox(id, options)))
  handle(ipcInvoke.teamDesktop.cancelQueued, (_event, id) => call((service) => service.cancelQueued(id), true))
  handle(ipcInvoke.teamDesktop.dispatch, (_event, id, options) => call((service) => service.dispatch(id, options), true))
  handle(ipcInvoke.teamDesktop.reconcile, (_event, id) => call((service) => service.reconcile(id), true))
  handle(ipcInvoke.teamDesktop.readDocument, (_event, input) => call((service) => service.readDocument(input)))
  handle(ipcInvoke.teamDesktop.listMaterials, (_event, input) => call((service) => service.listMaterials(input)))
  handle(ipcInvoke.teamDesktop.listVersions, (_event, input) => call((service) => service.listVersions(input)))
  handle(ipcInvoke.teamDesktop.listFeedback, (_event, input) => call((service) => service.listFeedback(input)))
  handle(ipcInvoke.teamDesktop.syncEvents, (_event, id) => call((service) => service.syncEvents(id)))
  handle(ipcInvoke.teamDesktop.refreshSharedSnapshot, (_event, id) => call((service) => service.refreshSharedSnapshot(id)))
  handle(ipcInvoke.teamDesktop.cachedSnapshot, (_event, id) => call((service) => service.cachedSnapshot(id)))
  handle(ipcInvoke.teamDesktop.queueWorkflowMaterial, (_event, expectedRoot: unknown, raw: unknown) => reply(async () => {
    const root = getProjectRoot(), generation = getProjectGeneration()
    const changed = (message: string) => Object.assign(new Error(message), { code: 'SCOPE_CHANGED' })
    if (!root || typeof expectedRoot !== 'string' || !expectedRoot || expectedRoot.length > 8192) throw changed('来源项目已改变，请重新选择固定版本')
    const input = desktopWorkflowPublicationSchema.parse(raw)
    let canonical: string, expected: string
    try { [canonical, expected] = await Promise.all([realpath(root), realpath(expectedRoot)]) }
    catch { throw changed('来源项目的实际目录无法核实，未接纳发布') }
    const same = process.platform === 'win32' ? canonical.toLowerCase() === expected.toLowerCase() : canonical === expected
    if (!same || getProjectRoot() !== root || getProjectGeneration() !== generation) throw changed('来源项目已改变，请重新选择固定版本')
    const stored = await resolveTeamPublicationSource(canonical, input.source)
    if (stored.material.source.kind !== 'trellis-file') throw Object.assign(new Error('此固定来源尚未连接团队发布适配器'), { code: 'SOURCE_UNSUPPORTED' })
    if (getProjectRoot() !== root || getProjectGeneration() !== generation) throw Object.assign(new Error('来源项目在读取期间已改变，未接纳发布'), { code: 'SCOPE_CHANGED' })
    const { source: _source, ...publication } = input
    const result = await withDesktopTeamService((service) => service.queueMaterialPublication(publication, {
      repositoryId: stored.owner.repositoryId, workspaceId: stored.owner.workspaceId, taskRef: stored.owner.taskRef,
      relativePath: stored.material.source.kind === 'trellis-file' ? stored.material.source.relativePath : '', version: stored.material.version,
      kind: stored.material.kind, text: stored.text, bodyDigest: stored.bodyDigest
    }))
    notifyDesktopTeamChanged(input.connectionId)
    if (getProjectRoot() !== root || getProjectGeneration() !== generation) throw Object.assign(new Error('发布意图可能已保存，请回原项目核对该命令；切换项目不代表撤销'), { code: 'SCOPE_CHANGED', outcomeUnknown: true })
    return result
  }))
}
