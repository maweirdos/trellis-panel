import type { createAcpRuntime, AcpRuntimeTurn, AcpRuntimeTurnInput } from 'acpx/runtime'

/** Existing application-controller surface; these are in-process operations, not an ACP transport. */
type ExistingRuntime = ReturnType<typeof createAcpRuntime>
export type ConversationRuntime = Omit<Pick<ExistingRuntime,
  'ensureSession' | 'findSession' | 'connectSession' | 'startTurn' | 'getCapabilities' | 'getStatus' |
  'setModel' | 'setMode' | 'setConfigOption' | 'shutdown'>, 'startTurn' | 'setConfigOption'> & {
    startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn
    setConfigOption(input: Parameters<ExistingRuntime['setConfigOption']>[0]): Promise<void | Awaited<ReturnType<ExistingRuntime['setConfigOption']>>>
  }
