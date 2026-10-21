/** Electron composition; shared service identities/outbox stay in DesktopTeamService. */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DesktopTeamService } from './team-platform'
import { broadcastToWindows } from './bridge'
import { ipcEvent } from '../../shared/ipc-channels'
import type { TeamDesktopChange } from '../../shared/team-desktop-bridge'

let service: Promise<DesktopTeamService> | null = null
let closed = false
let admissionClosed = false
let timer: ReturnType<typeof setTimeout> | null = null
let tick: Promise<void> | null = null
let closing: Promise<void> | null = null
let offset = 0
const pending = new Set<Promise<unknown>>()
const schedules = new Map<string, { heartbeatAt: number; syncAt: number; retryAt: number; failures: number; cursor?: string }>()
const dataDirectory = (): string => join(app.getPath('userData'), 'team-platform')
const changed = (connectionId: string | null, reason: TeamDesktopChange['reason'] = 'updated'): void => {
  broadcastToWindows(ipcEvent.teamDesktopChanged, { connectionId, reason, occurredAt: Date.now() } satisfies TeamDesktopChange)
}
function schedule(): void {
  if (closed || admissionClosed || timer) return
  timer = setTimeout(() => { timer = null; tick = background().finally(() => { tick = null; schedule() }); void tick.catch(() => changed(null, 'background-error')) }, 2000)
  timer.unref()
}
async function instance(): Promise<DesktopTeamService> {
  if (closed || admissionClosed) throw Object.assign(new Error('团队同步正在退出，原操作已保留'), { code: 'SERVICE_CLOSED' })
  if (!service) {
    const created = DesktopTeamService.open({ dataDir: dataDirectory(), ...(!app.isPackaged && process.env.TRELLIS_TEAM_ALLOW_LOOPBACK_HTTP === '1' ? { allowLoopbackHttp: true } : {}) })
    service = created
    void created.then(schedule).catch(() => { if (service === created) service = null })
  }
  return service
}
/** Register before any async work, so quit cannot close beneath an admitted call. */
export async function withDesktopTeamService<T>(action: (value: DesktopTeamService) => Promise<T>): Promise<T> {
  if (closed || admissionClosed) throw Object.assign(new Error('团队同步正在退出'), { code: 'SERVICE_CLOSED' })
  const work = instance().then(action)
  pending.add(work)
  try { return await work } finally { pending.delete(work) }
}
export function notifyDesktopTeamChanged(connectionId: string | null = null): void { changed(connectionId) }
export function setDesktopTeamAdmissionClosed(value: boolean): void {
  admissionClosed = value
  if (value && timer) { clearTimeout(timer); timer = null }
  if (!value && service && !closed) schedule()
}
/** Only resume a store that exists; ordinary local use need not create team state. */
export function resumeDesktopTeamBackground(): void {
  if (existsSync(join(dataDirectory(), 'team-desktop.sqlite'))) void instance().then(schedule).catch(() => changed(null, 'background-error'))
}
async function background(): Promise<void> {
  if (closed || admissionClosed || !service) return
  const current = await service
  const connections = await current.connections()
  if (closed || admissionClosed || !connections.length) return
  const eligible = connections.filter((entry) => ['pending', 'active'].includes(entry.state) && !entry.accessLocked)
  const selected = Array.from({ length: Math.min(2, eligible.length) }, (_, index) => eligible[(offset + index) % eligible.length])
  offset = eligible.length ? (offset + selected.length) % eligible.length : 0
  await Promise.allSettled(selected.map(async (connection) => {
    if (closed || admissionClosed) return
    const state = schedules.get(connection.connectionId) ?? { heartbeatAt: 0, syncAt: 0, retryAt: 0, failures: 0 }
    schedules.set(connection.connectionId, state)
    const now = Date.now()
    if (now < state.retryAt) return
    try {
      if (connection.state === 'pending') {
        if (now >= connection.nextPollAt) { await current.pollPairing(connection.connectionId); changed(connection.connectionId) }
        return
      }
      if (now >= state.heartbeatAt) { state.heartbeatAt = now + 20000; await current.heartbeat(connection.connectionId); changed(connection.connectionId) }
      if (closed || admissionClosed) return
      if (now >= state.syncAt) {
        state.syncAt = now + 10000
        const sync = await current.syncEvents(connection.connectionId)
        if ((sync.snapshotRequired || sync.page.items.length > 0) && !closed && !admissionClosed) await current.refreshSharedSnapshot(connection.connectionId)
        changed(connection.connectionId)
      }
      if (closed || admissionClosed) return
      // Walk bounded local pages across ticks. Never reset an uncertain dispatch
      // or automatically request retryUnknown; only a never-dispatched queue runs.
      const page = await current.outbox(connection.connectionId, { limit: 100, ...(state.cursor ? { cursor: state.cursor } : {}) })
      state.cursor = page.hasMore ? page.nextCursor ?? undefined : undefined
      for (const row of page.items.filter((item) => item.state === 'queued').slice(0, 4)) {
        if (closed || admissionClosed) return
        await current.dispatch(row.commandId); changed(connection.connectionId)
      }
      state.failures = 0; state.retryAt = 0
    } catch {
      state.failures = Math.min(5, state.failures + 1)
      state.retryAt = Date.now() + Math.min(60000, 2000 * 2 ** state.failures)
      changed(connection.connectionId, 'background-error')
    }
  }))
}
export function closeDesktopTeamService(): Promise<void> {
  if (closing) return closing
  closed = true
  if (timer) { clearTimeout(timer); timer = null }
  const work = (async () => {
    if (tick) await tick.catch(() => {})
    await Promise.allSettled([...pending])
    if (service) await (await service).close()
  })()
  closing = work
  // Keep admissions fenced, but permit a deliberate quit retry to join the
  // original service cleanup after an uncertain/failed writer-close response.
  void work.catch(() => { if (closing === work) closing = null })
  return work
}
