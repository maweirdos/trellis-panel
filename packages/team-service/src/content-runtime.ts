import { z } from 'zod'
import { teamContentJobReplySchema, type TeamContentJobReply } from '../../../src/shared/team-content'
import type { TeamStore } from './store-client'
import type { StoreActor } from './store-types'
import { TeamServiceError } from './errors'
import { callContentProvider, contentProviderEnvelopeSchema } from './content-provider'

type Flight = { controller: AbortController; done: Promise<void> }
const preparedSchema = z.object({ reply: teamContentJobReplySchema, dispatchToken: z.string().uuid().nullable() }).strict()
/** Runs bounded provider HTTP in the service process, never in the database worker. */
export class TeamContentRuntime {
  private readonly flights = new Map<string, Flight>()
  private closing = false
  private sweeping = false
  private timer: ReturnType<typeof setInterval> | null = null
  private constructor(private readonly store: TeamStore, private readonly reportFailure: () => void) {}
  static async open(store: TeamStore, reportFailure: () => void): Promise<TeamContentRuntime> {
    const runtime = new TeamContentRuntime(store, reportFailure)
    await store.call('contentRecover', { restart: true })
    runtime.timer = setInterval(() => {
      if (runtime.sweeping || runtime.closing) return
      runtime.sweeping = true
      void store.call('contentRecover', { restart: false }).catch(reportFailure).finally(() => { runtime.sweeping = false })
    }, 5000)
    runtime.timer.unref()
    return runtime
  }
  async submit(actor: StoreActor, scope: Record<string, unknown>, body: unknown, probe = false): Promise<TeamContentJobReply> {
    if (this.closing) throw new TeamServiceError('CONTENT_SERVICE_CLOSING', 'Content service is draining; retain the original command', 503)
    const prepared = preparedSchema.parse(await this.store.call(probe ? 'contentProbe' : 'contentPrepare', { actor, ...scope, body }))
    if (prepared.dispatchToken) {
      const jobId = prepared.reply.job.jobId, dispatchToken = prepared.dispatchToken, controller = new AbortController()
      const done = this.run(jobId, dispatchToken, controller.signal).catch(this.reportFailure).finally(() => { this.flights.delete(jobId) })
      this.flights.set(jobId, { controller, done })
      if (this.closing) controller.abort()
    }
    return prepared.reply
  }
  private async run(jobId: string, dispatchToken: string, signal: AbortSignal): Promise<void> {
    const raw = await this.store.call('contentStart', { jobId, dispatchToken })
    if (raw === null) return
    const envelope = contentProviderEnvelopeSchema.parse(raw)
    const result = await callContentProvider(envelope, signal)
    await this.store.call('contentSettle', { jobId, dispatchToken, result })
  }
  cancel(jobId: string): void { this.flights.get(jobId)?.controller.abort() }
  async close(): Promise<void> {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    for (const flight of this.flights.values()) flight.controller.abort()
    await Promise.allSettled([...this.flights.values()].map((flight) => flight.done))
  }
}
