import type { DaemonStatus } from '../../shared/daemon'
import { daemonManager, daemonIsAbsent } from './daemon-client/manager'
import { sameOwner } from '../daemon/native'
import { showDaemonQuitDialog } from './daemon-quit-dialog'
import { setRuntimeClientAdmissionClosed } from './daemon-client/runtime'
interface Ports { closeGuiAdmission(closed: boolean): void; stopGuiWork(): Promise<void>; detach(): Promise<void>; finalize(): void; quit(): void; reportError(error: unknown): void }
/** Serialized fresh-state decision. Cancel changes neither preference nor admission. */
export function createDaemonQuitGate(ports: Ports): { beforeQuit(event: { preventDefault(): void }): void; whenIdle(): Promise<void> } {
  let settled = false, pending: Promise<void> | null = null
  async function fresh(original: DaemonStatus): Promise<DaemonStatus> {
    const result = await daemonManager.status()
    if (!result.ok || result.data.epoch !== original.epoch || !sameOwner(result.data.owner, original.owner)) throw new Error('后台所有者在确认期间改变，请重新核对退出操作')
    return result.data
  }
  async function finish(): Promise<void> {
    let error: string | null = null
    for (;;) {
      const selected = await showDaemonQuitDialog(error)
      if (selected.decision.action === 'cancel') return
      try {
        const status = selected.status ? await fresh(selected.status) : null
        if (status && selected.decision.keepRunning && status.state !== 'running') throw new Error('后台正在停止，尚不能确认保留运行；请核对后台状态后重试')
        // Only an explicit Exit commits the preference. Retention needs an actually verified daemon.
        if (status) {
          const saved = await daemonManager.setPreferences({ ...status.preferences, keepRunning: selected.decision.keepRunning })
          if (!saved.ok) throw new Error(saved.error)
        }
        ports.closeGuiAdmission(true); setRuntimeClientAdmissionClosed(true)
        await ports.stopGuiWork()
        if (status && !selected.decision.keepRunning) {
          const stopped = await daemonManager.stop()
          if (!stopped.ok) throw new Error(stopped.error)
        } else if (!status && selected.decision.keepRunning) {
          if (!await daemonIsAbsent()) throw new Error('后台所有者仍在，但连接不可用；尚未确认保留状态，请恢复连接后重试')
        } else if (!status) {
          // An unverified connection failure cannot prove there is no original daemon owner.
          const stopped = await daemonManager.stop()
          if (!stopped.ok) throw new Error(stopped.error)
        }
        await ports.detach(); ports.finalize(); settled = true; ports.quit(); return
      } catch (cause) {
        ports.closeGuiAdmission(false); setRuntimeClientAdmissionClosed(false)
        error = cause instanceof Error ? cause.message : '停止结果尚未核实，请重试或取消后检查原任务'
      }
    }
  }
  return {
    beforeQuit(event) { if (settled) return; event.preventDefault(); if (!pending) pending = finish().catch(ports.reportError).finally(() => { pending = null }) },
    whenIdle: () => pending ?? Promise.resolve()
  }
}
