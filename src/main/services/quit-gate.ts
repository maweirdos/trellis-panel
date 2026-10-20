interface QuitEvent {
  preventDefault(): void
}

export interface QuitGateDependencies {
  hasApplications(): Promise<boolean>
  confirmApplications(): Promise<boolean>
  setAdmissionClosed(closed: boolean): void
  stopApplications(): Promise<void>
  stopSessions(): Promise<void>
  finalize(): void
  quit(): void
  reportError(error: unknown): void
}

/** Keep cancellation reversible and finish owned cleanup before Electron's second quit. */
export function createQuitGate(dependencies: QuitGateDependencies): {
  beforeQuit(event: QuitEvent): void
  whenIdle(): Promise<void>
} {
  let settled = false
  let pending: Promise<void> | null = null

  async function finish(): Promise<void> {
    try {
      if (await dependencies.hasApplications() && !await dependencies.confirmApplications()) return
      dependencies.setAdmissionClosed(true)
      await dependencies.stopApplications()
      await dependencies.stopSessions()
      dependencies.finalize()
      settled = true
      dependencies.quit()
    } catch (error: unknown) {
      dependencies.setAdmissionClosed(false)
      dependencies.reportError(error)
    }
  }

  return {
    beforeQuit(event): void {
      if (settled) return
      event.preventDefault()
      if (pending) return
      pending = finish().finally(() => { pending = null })
    },
    whenIdle(): Promise<void> {
      return pending ?? Promise.resolve()
    }
  }
}
