import { api, hasIpc } from '../../../api'
import type { IntegrationApi } from '../../../../../shared/integrations'

export type IntegrationBridgeState = 'ready' | 'browser-preview' | 'preload-outdated' | 'preload-unavailable'

/** An existing desktop bridge without a new feature is not a browser preview. */
export function integrationBridgeState(): IntegrationBridgeState {
  if (!hasIpc) return navigator.userAgent.includes('Electron/') ? 'preload-unavailable' : 'browser-preview'
  const integration = api?.integrations
  const required: readonly (keyof IntegrationApi)[] = ['list', 'saveConnection', 'inspect', 'saveBinding', 'removeBinding', 'removeConnection', 'repositories', 'pullRequests', 'links', 'attach', 'unlink', 'previewNotification', 'sendNotification', 'jiraContext', 'jiraSearch', 'jiraTransitions', 'jiraTransition', 'jiraComment', 'onChanged', 'cancelRead']
  return integration && required.every((method) => typeof integration[method] === 'function') ? 'ready' : 'preload-outdated'
}

export function integrationBridgeMessage(state: IntegrationBridgeState): string {
  if (state === 'preload-outdated') return '当前窗口仍在使用旧版桌面连接接口。请从系统托盘选择「退出」，再重新打开应用；仅刷新页面不能更新主进程。配置表单可先打开，未保存内容仅在当前窗口保留。'
  if (state === 'preload-unavailable') return '桌面连接服务未能加载。请从系统托盘选择「退出」并重新打开应用后再保存；当前表单内容尚未保存。'
  if (state === 'browser-preview') return '当前是浏览器预览，可查看配置表单。保存连接、检查身份和项目绑定需要在桌面应用中完成。'
  return ''
}

export function missingIntegrationHandler(error: unknown): boolean {
  return error instanceof Error && /No handler registered for ['"]?integration:/i.test(error.message)
}
