import { EventEmitter, once } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'
import type { OrchestrationV2DomainEvent, OrchestrationV2StoredEvent } from '../../../../shared/conversation/contracts'
import type { ConversationEventPage, ConversationHostEvent } from '../../../../shared/conversation/desktop'
import type { ConversationLifecycleEvent } from '../../../../shared/conversation/command-runtime'
import { ConversationCommandReceiptStore, ConversationEventStore } from '../persistence/event-store'

export class ConversationEventSink {
  private readonly eventStore: ConversationEventStore
  private readonly commandReceipts: ConversationCommandReceiptStore
  private readonly lifecycle = new EventEmitter()

  constructor(private readonly database: DatabaseSync) {
    this.eventStore = new ConversationEventStore(database)
    this.commandReceipts = new ConversationCommandReceiptStore(database)
  }

  readReceipt(commandId: string) {
    return this.commandReceipts.getByCommandId(commandId)
  }

  readEventPage(threadId: string, afterSequence: number, limit: number): ConversationEventPage {
    return this.eventStore.readPage(threadId, afterSequence, limit)
  }

  readLifecyclePage(threadId: string, afterSequence: number, limit: number) {
    return this.eventStore.readPage(threadId, afterSequence, limit, true)
  }

  latestSequence(threadId: string): number {
    return this.eventStore.latestSequence(threadId)
  }

  hasSequence(threadId: string, sequence: number): boolean {
    return this.eventStore.hasSequence(threadId, sequence)
  }

  replaySize(threadId: string, afterSequence: number, limit: number) {
    return this.eventStore.replaySize(threadId, afterSequence, limit)
  }

  async waitForLifecycle(threadIds: readonly string[], signal: AbortSignal): Promise<void> {
    const observation = new AbortController()
    const lifetime = AbortSignal.any([observation.signal, signal])
    try {
      await Promise.race(threadIds.map(threadId => once(this.lifecycle, `thread:${threadId}`, { signal: lifetime })))
    } finally {
      observation.abort()
    }
  }

  commit<Output>(
    input: { readonly commandId?: string; readonly events?: ReadonlyArray<OrchestrationV2DomainEvent>; readonly hostEvents?: ReadonlyArray<ConversationHostEvent | ConversationLifecycleEvent> },
    applyStoredEvents: (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) => Output,
  ): Output {
    this.database.exec('BEGIN IMMEDIATE')
    let result: Output
    try {
      const storedEvents = this.eventStore.append({ commandId: input.commandId, events: input.events ?? [] })
      if (input.hostEvents?.length) this.eventStore.appendHostEvents(input.hostEvents, input.commandId)
      result = applyStoredEvents(storedEvents)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    if (input.hostEvents?.length && this.lifecycle.eventNames().length) {
      for (const threadId of new Set(input.hostEvents.map(event => event.threadId))) {
        this.lifecycle.emit(`thread:${threadId}`)
      }
    }
    return result
  }

  commitCommand(input: {
    readonly commandId: string
    readonly threadId: string
    readonly commandType: string
    readonly acceptedAt: string
    readonly payloadDigest: string
    readonly events?: ReadonlyArray<OrchestrationV2DomainEvent>
    readonly hostEvents?: ReadonlyArray<ConversationLifecycleEvent>
  }, applyStoredEvents: () => void, enqueue: () => void): number {
    const { events, hostEvents, ...receipt } = input
    return this.commit({ commandId: receipt.commandId, events, hostEvents }, storedEvents => {
      const sequence = hostEvents?.length ? this.eventStore.latestSequence(input.threadId) : storedEvents.at(-1)?.sequence
      if (sequence === undefined) throw new Error(`Command ${input.commandId} produced no orchestration events.`)
      applyStoredEvents()
      enqueue()
      this.commandReceipts.insertAccepted({ ...receipt, resultSequence: sequence })
      return sequence
    })
  }
}
