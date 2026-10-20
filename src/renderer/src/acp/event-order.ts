import type { TimelineEvent } from '../../../shared/types'

/** Sequence orders saved facts; overlapping delivery lists anchor unsaved facts. */
export function orderTimelineEvents(byId: ReadonlyMap<string, TimelineEvent>, sources: readonly (readonly TimelineEvent[])[]): TimelineEvent[] {
  const saved = [...byId.values()].filter((event): event is TimelineEvent & { historySeq: number } => event.historySeq !== undefined).sort((a, b) => a.historySeq - b.historySeq)
  let ordered: TimelineEvent[] = [...saved]
  const inserted = new Set(saved.map((event) => event.id))
  for (const source of sources) {
    let pending: TimelineEvent[] = []
    const queued = new Set<string>()
    const flush = (at: number): void => {
      ordered = ordered.slice(0, at).concat(pending, ordered.slice(at))
      for (const event of pending) inserted.add(event.id)
      pending = []; queued.clear()
    }
    for (const event of source) {
      const stored = byId.get(event.id)
      if (!stored) continue
      if (inserted.has(event.id)) {
        if (pending.length) flush(ordered.findIndex((item) => item.id === event.id))
      } else if (!queued.has(event.id)) { pending.push(stored); queued.add(event.id) }
    }
    if (pending.length) flush(ordered.length)
  }
  for (const event of byId.values()) if (!inserted.has(event.id)) ordered.push(event)
  return ordered
}
