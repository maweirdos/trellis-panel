import type { z } from 'zod'
import { runtimeWireSchema } from '../../shared/daemon-runtime'
import { PROVIDER_MUTATING_METHODS, type ProviderDaemonMethod } from '../../shared/daemon-domains'
import type { DaemonRequest, ProcessOwner } from '../../shared/daemon'
import { isProviderReadMethod, providerReadEnvelopeSchema } from '../../shared/provider-cancellation'
import { ProviderCancellation } from './provider-cancellation'
import type { DaemonRuntime } from './runtime'
import { RuntimeCommands } from './runtime/commands'
import { DaemonError } from './errors'

/** Only explicitly registered feature functions can be invoked. No object paths,
 * reflection, arbitrary module lookup or shell command enters this registry. */
export class ProviderDomain {
  private readonly actions = new Map<string, (input: unknown, signal?: AbortSignal) => Promise<unknown>>()
  constructor(private readonly runtime: DaemonRuntime, private readonly commands: RuntimeCommands, private readonly cancellation: ProviderCancellation) {}
  add<I, O>(method: ProviderDaemonMethod, request: z.ZodType<I>, response: z.ZodType<O>, action: (input: I, signal?: AbortSignal) => Promise<O>): void {
    if (this.actions.has(method)) throw new Error(`Duplicate native provider method: ${method}`)
    this.actions.set(method, async (raw, signal) => response.parse(await action(request.parse(raw), signal)))
  }
  handles(method: string): boolean { return this.actions.has(method) }
  async dispatch(request: DaemonRequest, actor: ProcessOwner): Promise<unknown> {
    const action = this.actions.get(request.method)
    if (!action) throw new DaemonError('E_UNAVAILABLE', 'The provider method has no installed owner.')
    const root = request.workspace?.root ?? '@profile'
    const raw = this.runtime.unpack(root, runtimeWireSchema.parse(request.payload))
    const envelope = isProviderReadMethod(request.method) ? providerReadEnvelopeSchema.safeParse(raw) : null
    const input = envelope?.success ? envelope.data.input : raw
    const execute = async (signal?: AbortSignal) => {
      const invoke = async () => this.runtime.pack(root, await action(input, signal))
      if (PROVIDER_MUTATING_METHODS.includes(request.method as ProviderDaemonMethod)) {
        if (!request.commandId) throw new DaemonError('E_INVALID_ARG', 'Provider writes require their original command ID.')
        return this.commands.run(root, request.commandId, request.method, input, invoke)
      }
      return invoke()
    }
    if (envelope?.success && isProviderReadMethod(request.method)) return this.cancellation.run(actor, request.workspace, request.method, envelope.data.providerRead, execute)
    return execute()
  }
}
