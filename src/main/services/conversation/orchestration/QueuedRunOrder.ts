interface QueueEntry {
  readonly ordinal: number
  readonly queuePosition?: number
  readonly requestedAt: string
  readonly isAutomaticCompletion: boolean
}

export function queuedRunsInDeliveryOrder<Run extends QueueEntry>(runs: readonly Run[]): readonly Run[] {
  const queued = runs.toSorted((left, right) =>
    (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) || left.ordinal - right.ordinal)
  const completions = queued.filter(run => run.isAutomaticCompletion)
  const messages = queued.filter(run => !run.isAutomaticCompletion)
  const ordered: Run[] = []
  let completionIndex = 0
  let messageIndex = 0
  for (;;) {
    const completion = completions[completionIndex]
    const message = messages[messageIndex]
    if (completion === undefined || message === undefined) {
      return [...ordered, ...completions.slice(completionIndex), ...messages.slice(messageIndex)]
    }
    if (Date.parse(completion.requestedAt) <= Date.parse(message.requestedAt)) {
      ordered.push(completion)
      completionIndex += 1
    } else {
      ordered.push(message)
      messageIndex += 1
    }
  }
}
