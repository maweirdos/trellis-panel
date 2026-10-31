import type { IpcFail } from './ipc-errors'

export type OnboardingOutcome = 'completed' | 'skipped'
export type OnboardingStatus = {
  profile: 'new' | 'existing' | 'unknown'
  state: 'not-started' | 'pending' | OnboardingOutcome | 'unavailable'
  shouldShow: boolean
}
export type OnboardingResult = { ok: true; data: OnboardingStatus } | IpcFail
export interface OnboardingApi {
  status(): Promise<OnboardingResult>
  complete(outcome: OnboardingOutcome): Promise<OnboardingResult>
}
