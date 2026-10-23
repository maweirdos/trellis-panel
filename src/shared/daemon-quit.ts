import { z } from 'zod'
import type { DaemonResult } from './daemon'
export const daemonQuitDecisionSchema = z.object({ attemptId: z.string().uuid(), action: z.enum(['cancel', 'exit']), keepRunning: z.boolean() }).strict()
export type DaemonQuitDecision = z.infer<typeof daemonQuitDecisionSchema>
export interface DaemonQuitState { attemptId: string; keepRunning: boolean; daemonAvailable: boolean; activeJobs: number; error: string | null }
export interface DaemonQuitApi {
  state(): Promise<DaemonResult<DaemonQuitState>>
  decide(input: DaemonQuitDecision): Promise<DaemonResult<null>>
}
