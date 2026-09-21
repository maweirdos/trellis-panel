import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { getAnalytics } from '../services/activity'
import { generateWeeklyReport, generateStandup, saveReport } from '../services/report'
import { getSnapshot, getProjectRoot } from '../state'
import { handle } from './registry'

const EMPTY_REPORT = { markdown: '', suggestedFileName: '' }

export function registerReportIpc(): void {
  handle(ipcInvoke.analytics.get, () => {
    const snap = getSnapshot()
    if (!snap) return null
    return getAnalytics(snap)
  })

  handle(ipcInvoke.report.generate, (_e, scope: 'personal' | 'team') => {
    const snap = getSnapshot()
    if (!snap) return EMPTY_REPORT
    return generateWeeklyReport(snap, {
      scope,
      developer: snap.meta.developer,
      projectName: snap.meta.name
    })
  })

  handle(ipcInvoke.report.standup, () => {
    const snap = getSnapshot()
    if (!snap) return EMPTY_REPORT
    return generateStandup(snap)
  })

  handle(ipcInvoke.report.save, (_e, fileName: string, markdown: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const res = saveReport(root, fileName, markdown)
    if (!res.ok) return ipcFail(IpcErrorCode.Io, res.error ?? '保存报告失败')
    return res
  })
}
