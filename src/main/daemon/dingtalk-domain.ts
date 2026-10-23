import { DINGTALK_DAEMON, dingtalkRequests, dingtalkResults } from '../../shared/dingtalk-integration'
import { createDingTalkComposition, type DingTalkCompositionInput } from './dingtalk'
import type { ProviderDomain } from './provider-domain'

export function installDingTalkDomain(input: DingTalkCompositionInput & { domain: ProviderDomain }) {
  const dingtalk = createDingTalkComposition(input)
  input.domain.add(DINGTALK_DAEMON.snapshot, dingtalkRequests.snapshot, dingtalkResults.snapshot, (i, signal) => dingtalk.actions.snapshot(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.saveApp, dingtalkRequests.saveApp, dingtalkResults.saveApp, (i, signal) => dingtalk.actions.saveApp(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.verifyApp, dingtalkRequests.verifyApp, dingtalkResults.verifyApp, (i, signal) => dingtalk.actions.verifyApp(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.revokeApp, dingtalkRequests.revokeApp, dingtalkResults.revokeApp, (i, signal) => dingtalk.actions.revokeApp(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.authorizeAccount, dingtalkRequests.authorizeAccount, dingtalkResults.authorizeAccount, (i, signal) => dingtalk.actions.authorizeAccount(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.claimAccount, dingtalkRequests.claimAccount, dingtalkResults.claimAccount, (i, signal) => dingtalk.actions.claimAccount(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.unlinkAccount, dingtalkRequests.unlinkAccount, dingtalkResults.unlinkAccount, (i, signal) => dingtalk.actions.unlinkAccount(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.saveAssistant, dingtalkRequests.saveAssistant, dingtalkResults.saveAssistant, (i, signal) => dingtalk.actions.saveAssistant(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.setAssistant, dingtalkRequests.setAssistant, dingtalkResults.setAssistant, (i, signal) => dingtalk.actions.setAssistant(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.retryAssistant, dingtalkRequests.retryAssistant, dingtalkResults.retryAssistant, (i, signal) => dingtalk.actions.retryAssistant(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.setNotifications, dingtalkRequests.setNotifications, dingtalkResults.setNotifications, (i, signal) => dingtalk.actions.setNotifications(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.previewNotification, dingtalkRequests.previewNotification, dingtalkResults.previewNotification, (i, signal) => dingtalk.actions.previewNotification(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.sendNotification, dingtalkRequests.sendNotification, dingtalkResults.sendNotification, (i, signal) => dingtalk.actions.sendNotification(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.deliveries, dingtalkRequests.deliveries, dingtalkResults.deliveries, (i, signal) => dingtalk.actions.deliveries(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.reconcileDelivery, dingtalkRequests.reconcileDelivery, dingtalkResults.reconcileDelivery, (i, signal) => dingtalk.actions.reconcileDelivery(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.inbox, dingtalkRequests.inbox, dingtalkResults.inbox, (i, signal) => dingtalk.actions.inbox(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.execute, dingtalkRequests.execute, dingtalkResults.execute, (i, signal) => dingtalk.actions.execute(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.queryExecution, dingtalkRequests.queryExecution, dingtalkResults.queryExecution, (i, signal) => dingtalk.actions.queryExecution(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  input.domain.add(DINGTALK_DAEMON.cancelExecution, dingtalkRequests.cancelExecution, dingtalkResults.cancelExecution, (i, signal) => dingtalk.actions.cancelExecution(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  return dingtalk
}
