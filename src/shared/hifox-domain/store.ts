import type { HifoxSnapshot } from '../hifox'
import { hifoxSnapshotSchema } from '../hifox-schema'

export interface HifoxDomainStore {
  loadSnapshot(): HifoxSnapshot
  mutate<T>(action: (draft: HifoxSnapshot) => T): { result: T; snapshot: HifoxSnapshot }
}

let repository: HifoxDomainStore | undefined

export function configureHifoxDomainStore(store: HifoxDomainStore): void { repository = store }

function current(): HifoxDomainStore {
  if (!repository) throw new Error('Collaboration domain requires an owned store context')
  return repository
}

export function loadSnapshot(): HifoxSnapshot { return current().loadSnapshot() }
export function mutate<T>(action: (draft: HifoxSnapshot) => T): { result: T; snapshot: HifoxSnapshot } { return current().mutate(action) }
export function nextId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}` }
export function nowIso(): string { return new Date().toISOString() }

/** A synchronous server transaction shares the same domain rules as local storage. */
export function withHifoxDomainSnapshot<T>(snapshot: HifoxSnapshot, action: () => T): { snapshot: HifoxSnapshot; result: T } {
  hifoxSnapshotSchema.parse(snapshot)
  const previous = repository
  let owned = structuredClone(snapshot)
  let writing = false
  repository = {
    loadSnapshot: () => structuredClone(owned),
    mutate: <R>(write: (draft: HifoxSnapshot) => R) => {
      if (writing) throw new Error('Collaboration domain cannot nest write transactions')
      const draft = structuredClone(owned)
      writing = true
      try {
        const result = write(draft)
        if (result instanceof Promise) throw new Error('Collaboration write transactions must be synchronous')
        hifoxSnapshotSchema.parse(draft)
        owned = structuredClone(draft)
        return { result, snapshot: structuredClone(draft) }
      } finally { writing = false }
    }
  }
  try {
    const result = action()
    if (result instanceof Promise) throw new Error('Collaboration domain scopes must be synchronous')
    return { snapshot: structuredClone(owned), result }
  } finally { repository = previous }
}
