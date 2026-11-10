import { z } from 'zod'

export const daemonActivitySchema = z.object({
  state: z.enum(['idle', 'interruptible', 'uncertain']),
  sessions: z.array(z.object({
    title: z.string().min(1).max(200),
    state: z.enum(['idle', 'interruptible', 'uncertain'])
  }).strict()).max(100),
  otherWork: z.number().int().nonnegative()
}).strict()
export type DaemonActivity = z.infer<typeof daemonActivitySchema>
export const LIFECYCLE_RUNTIME_CONTROLS: readonly string[] = [
  'runtime.status', 'runtime.command', 'runtime.cancel', 'runtime.end',
  'runtime.privateCancel', 'runtime.privateEnd', 'runtime.handoffCancel',
  'runtime.workflow.stop', 'runtime.workflow.cancelRevision'
]
export const LIFECYCLE_SESSION_ADMISSIONS: readonly string[] = [
  'runtime.privateSend', 'runtime.prompt', 'runtime.new', 'runtime.resume',
  'runtime.handoffCreate', 'runtime.recover', 'runtime.privateRecoverModel'
]
export const daemonLifecycleStopSchema = z.object({
  version: z.literal(1), attemptId: z.string().uuid(), nonce: z.string().uuid(),
  interrupt: z.boolean()
}).strict()
