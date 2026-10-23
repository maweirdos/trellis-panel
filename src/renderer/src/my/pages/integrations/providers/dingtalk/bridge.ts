import { hasDingTalkApi, type DingTalkApi } from '@shared/dingtalk-integration'
export function dingTalkBridge(): DingTalkApi | null {
  const candidate = (window as unknown as { trellis?: { dingtalkWorkspace?: unknown } }).trellis?.dingtalkWorkspace
  return hasDingTalkApi(candidate) ? candidate : null
}
