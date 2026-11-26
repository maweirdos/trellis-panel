/**
 * 桌面全量运行期依赖聚合入口：仅在主窗口首帧显示且后台权限核验就绪（composeDesktop）后按需加载，
 * 避免在 GUI 进程启动与首窗创建前同步 require 数十个重型外部 SDK。
 */
export { registerIpc } from './ipc'
export { abortAll } from './services/cli'
export { getSettings } from './services/store'
export { stopDiffWorker } from './services/documents'
export { stopObservationWorker } from './services/observability'
export { routeNotifyRail } from './services/daemon-client/acp'
export { detachRuntimeObservers, prewarmConversationWorkspace, setRuntimeClientAdmissionClosed } from './services/daemon-client/runtime'
export { configureDaemonQuitDialog } from './services/daemon-quit-dialog'
export { startInbox, stopInbox, parseDeepLink, handleDeepLink, broadcastToWindows } from './services/bridge'
export { httpApiStatus } from './services/httpapi'
export { accessServer } from './services/access/server'
export { applyChromiumProxy } from './services/proxy'
export { appRuntime } from './services/app-runtime'
export { createDaemonQuitGate } from './services/daemon-quit-gate'
export { createDaemonTray } from './services/daemon-tray'
export { closeCreationService } from './services/creations'
export { ownedDirectory } from './services/private-conversations/files'
export {
  setUiHooks,
  setMainWindow,
  sendSnapshot,
  toast,
  restartHttpApi,
  applyAutoStart,
  stopTimers,
  openProjectAt,
  findTask,
  pushFocusTask,
  getSnapshot,
  getProjectRoot
} from './state'
export { setWorkflowAdmissionClosed } from './services/workflow-desktop'
export { stopWorkflowSubscriptions } from './ipc/workflow'
export { closeTaskConversations } from './ipc/task-conversations'
export { resumeDesktopTeamBackground, setDesktopTeamAdmissionClosed, closeDesktopTeamService, withDesktopTeamService } from './services/team-desktop'
export { tickScheduledAutomations } from './services/crux/planning'
export { resumeCruxWorkspace, closeCruxWorkspace, configureCruxConnectionService } from './services/crux/connection-service'
export { ensureTeamGitlabConnection } from './services/integrations/team-gitlab'

let cachedAutoUpdater: (typeof import('electron-updater'))['autoUpdater'] | null | undefined

export function getAutoUpdater(): (typeof import('electron-updater'))['autoUpdater'] | null {
  if (cachedAutoUpdater !== undefined) return cachedAutoUpdater
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedAutoUpdater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater
  } catch {
    cachedAutoUpdater = null
  }
  return cachedAutoUpdater
}
