import { readingSessionKey } from './reading-session'

/** A mounted reader owns its snapshots; another host may read the same file independently. */
export function readingOwnerKey(scope: { workspaceId: string; taskRef?: string }, path: string, ownerId: string): string {
  return `${readingSessionKey(scope, path)}::owner:${ownerId}`
}

export interface ReaderRequestTicket { generation: number; sequence: number; channel: string }

/** Reject late work after close, scope replacement, or a newer request in the same channel. */
export class ReaderRequestOwner {
  private generation = 0
  private sequence = 0
  private latest = new Map<string, number>()

  invalidate(): void {
    this.generation += 1
    this.latest.clear()
  }

  request(channel: string): ReaderRequestTicket {
    const sequence = ++this.sequence
    this.latest.set(channel, sequence)
    return { generation: this.generation, sequence, channel }
  }

  accepts(ticket: ReaderRequestTicket): boolean {
    return ticket.generation === this.generation && this.latest.get(ticket.channel) === ticket.sequence
  }
}
