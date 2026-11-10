import { z } from 'zod'
import type { IpcFail } from './ipc-errors'

export const daemonLifecycleConfirmationSchema = z.object({
  attemptId: z.string().min(1).max(128),
  reason: z.enum(['development', 'build-change', 'upgrade', 'restart']),
  sessions: z.array(z.object({ title: z.string() }).strict()),
  uncertain: z.boolean()
}).strict()

export type DaemonLifecycleConfirmation = z.infer<typeof daemonLifecycleConfirmationSchema>
export const daemonLifecycleDecisionSchema = z.object({
  attemptId: z.string().min(1).max(128),
  action: z.enum(['cancel', 'confirm', 'retry', 'close'])
}).strict()
export type DaemonLifecycleDecision = z.infer<typeof daemonLifecycleDecisionSchema>

export interface DaemonLifecycleAppearance {
  readonly theme: 'light' | 'dark' | 'system'
  readonly fontSize?: 'small' | 'standard' | 'large'
}

export interface DaemonLifecycleDialogState extends DaemonLifecycleConfirmation {
  phase: 'confirmation' | 'stopping' | 'terminating' | 'verifying' | 'failed'
  /** The main process sends at most five names; the total retains the actual scope. */
  sessionCount: number
  failure?: string
  commandId?: string
}

export interface DaemonLifecycleDialogApi {
  readonly appearance: DaemonLifecycleAppearance
  state(): Promise<{ ok: true; data: DaemonLifecycleDialogState } | IpcFail>
  decide(input: DaemonLifecycleDecision): Promise<{ ok: true } | IpcFail>
}
