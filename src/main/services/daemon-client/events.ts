import type { DaemonData, DaemonEvent, DaemonFailure, EventCursor, WorkspaceGrant } from '../../../shared/daemon'
import type { DaemonContext } from '../../daemon/context'
import { DaemonError, daemonFailure } from '../../daemon/errors'
import { daemonConnectionPool, observePooledWorkspace } from './pool'

export type DaemonObservation = { kind: 'snapshot'; data: DaemonData<'events.snapshot'> } | { kind: 'event'; data: DaemonEvent } | { kind: 'unavailable'; error: DaemonFailure }
/** Observer replay over bounded read pages. Reconnect never repeats a command or changes its grant. */
export function observeDaemonWorkspace(context: DaemonContext, workspace: WorkspaceGrant, observe: (value: DaemonObservation) => void): () => void {
  let cursor: EventCursor | undefined
  return observePooledWorkspace(daemonConnectionPool(context), async () => workspace, 'integration', async (client, grant, current) => {
    if (!cursor || cursor.epoch !== client.epoch) {
      const snapshot = await client.request('events.snapshot', {}, { workspace: grant })
      if (!current()) return false
      if (!snapshot.ok) throw new DaemonError(snapshot.code, snapshot.error, snapshot.outcome)
      if (snapshot.data.cursor.epoch !== client.epoch || JSON.stringify(snapshot.data.workspace) !== JSON.stringify(grant)) throw new DaemonError('E_CONFLICT', 'The replay snapshot does not match its authorized workspace/epoch.')
      observe({ kind: 'snapshot', data: snapshot.data })
      if (!current()) return false
      cursor = snapshot.data.cursor
    }
    if (!current()) return false
    const page = await client.request('events.replay', { after: cursor, limit: 100 }, { workspace: grant })
    if (!current()) return false
    if (!page.ok) throw new DaemonError(page.code, page.error, page.outcome)
    if (page.data.cursor.epoch !== client.epoch) throw new DaemonError('E_CONFLICT', 'The replay cursor belongs to another daemon epoch.')
    if (page.data.resetRequired) cursor = undefined
    else {
      for (const event of page.data.events) {
        if (!current()) return false
        observe({ kind: 'event', data: event })
      }
      cursor = page.data.cursor
    }
    return page.data.hasMore || page.data.resetRequired
  }, error => { observe({ kind: 'unavailable', error: daemonFailure(error) }) })
}
