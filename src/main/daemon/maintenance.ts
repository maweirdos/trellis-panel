import { app, dialog } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createLifecycleControlContext } from './context'
import { currentDaemonBuild } from './build-identity'
import { prepareGuiTermination } from './lifecycle-native'
import { DaemonError } from './errors'
import { LifecycleCancelled, reconcileReleasedLifecycle, runDaemonLifecycle } from '../services/daemon-client/lifecycle'
import { writeMaintenanceReceipt } from './maintenance-receipt'
import { capturedGuiLifecycleOwner, requestGuiLifecycleStop } from '../services/gui-lifecycle'
import type { ProcessOwner } from '../../shared/daemon'
import { configureDaemonLifecycleDialog, showDaemonLifecycleConfirmation, runDaemonLifecycleWithDialog, lifecycleDialogWasClosed } from '../services/daemon-lifecycle-dialog'
import { desktopUiPreferences } from '../services/bootstrap'
import { installWindowNavigation } from '../services/window-navigation'

/** Runs from the installer's extracted new package, before any old file changes.
 * Exit codes are a contract: 0 ready, 2 cancelled/interaction-required, 3 failed. */
export async function runDaemonMaintenance(): Promise<void> {
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const targets = process.argv.filter(arg => arg.startsWith('--trellis-target-install='))
  const silent = process.argv.includes('--trellis-maintenance-silent')
  const receipts = process.argv.filter(arg => arg.startsWith('--trellis-maintenance-receipt='))
  const reconciliations = process.argv.filter(arg => arg.startsWith('--trellis-maintenance-reconcile='))
  if (targets.length !== 1 || targets[0].length > 4200) throw new DaemonError('E_INVALID_ARG', '安装维护需要唯一的原安装目录。')
  if (receipts.length > 1 || reconciliations.length > 1 || receipts.length && reconciliations.length) throw new DaemonError('E_INVALID_ARG', '安装维护不能混合新的升级与原卸载器核验。')
  const receipt = receipts[0]?.slice('--trellis-maintenance-receipt='.length)
  const reconcileToken = reconciliations[0]?.slice('--trellis-maintenance-reconcile='.length)
  const reconciliation = reconcileToken?.match(/^([a-f0-9-]{36}):([a-f0-9]{64})$/)
  if (reconcileToken !== undefined && (!reconciliation || !z.string().uuid().safeParse(reconciliation[1]).success)) throw new DaemonError('E_INVALID_ARG', '原安装交接身份无效。')
  configureDaemonLifecycleDialog({
    getMain: () => null, getAppearance: desktopUiPreferences,
    load(window) {
      const url = pathToFileURL(join(__dirname, '../renderer/index.html'))
      url.searchParams.set('mode', 'daemon-lifecycle')
      url.searchParams.set('theme', desktopUiPreferences().theme)
      installWindowNavigation(window, url.href)
      void window.loadURL(url.href)
    }
  })
  while (true) {
    try {
      const context = await createLifecycleControlContext(targets[0].slice('--trellis-target-install='.length))
      if (reconciliation) {
        await reconcileReleasedLifecycle(context, { attemptId: reconciliation[1], targetBuild: reconciliation[2] }, () => prepareGuiTermination(context))
        app.exit(0); return
      }
      let guiOwner: ProcessOwner | null = null
      const result = await (silent ? runDaemonLifecycle : runDaemonLifecycleWithDialog)(context, {
        reason: 'upgrade', targetBuild: currentDaemonBuild().sha256,
        confirm: silent ? async () => { throw new LifecycleCancelled() } : showDaemonLifecycleConfirmation,
        prepareAdditional: () => { guiOwner = capturedGuiLifecycleOwner(context); return prepareGuiTermination(context) },
        stopAdditional: attempt => requestGuiLifecycleStop(context, attempt, guiOwner)
      })
      if (receipt !== undefined) writeMaintenanceReceipt(receipt, { attemptId: result.attemptId, targetBuild: result.targetBuild })
      app.exit(0); return
    } catch (error) {
      if (error instanceof LifecycleCancelled) { app.exit(2); return }
      if (lifecycleDialogWasClosed(error)) { app.exit(3); return }
      if (silent) { app.exit(3); return }
      const choice = await dialog.showMessageBox({
        type: 'error', title: '更新前退出未完成',
        message: '原程序文件尚未替换。',
        detail: error instanceof DaemonError ? error.message : '原后台或桌面退出范围未获核验。',
        buttons: ['取消更新', '重试退出'], defaultId: 0, cancelId: 0
      })
      if (choice.response !== 1) { app.exit(3); return }
    }
  }
}
