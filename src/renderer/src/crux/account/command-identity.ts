const retainedCommands = new Map<string, string>()
const MAX_RETAINED_COMMANDS = 100

/** Retains one mutation identity across panel close/reopen within this renderer session. */
export function retainCommandId(key: string): string {
  const existing = retainedCommands.get(key)
  if (existing) return existing
  const commandId = crypto.randomUUID()
  retainedCommands.set(key, commandId)
  if (retainedCommands.size > MAX_RETAINED_COMMANDS) {
    const oldest = retainedCommands.keys().next().value
    if (typeof oldest === 'string') retainedCommands.delete(oldest)
  }
  return commandId
}

export function releaseCommandId(key: string, commandId: string): void {
  if (retainedCommands.get(key) === commandId) retainedCommands.delete(key)
}
