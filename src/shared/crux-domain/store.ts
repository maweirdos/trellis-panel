import type { CruxSnapshot } from '../crux'
import { cruxSnapshotSchema } from '../crux-schema'

export interface CruxDomainStore {
  loadSnapshot(): CruxSnapshot
  mutate<T>(action: (draft: CruxSnapshot) => T): { result: T; snapshot: CruxSnapshot }
}

let repository: CruxDomainStore | undefined

export function configureCruxDomainStore(store: CruxDomainStore): void { repository = store }

function current(): CruxDomainStore {
  if (!repository) throw new Error('Collaboration domain requires an owned store context')
  return repository
}

export function loadSnapshot(): CruxSnapshot { return current().loadSnapshot() }
export function mutate<T>(action: (draft: CruxSnapshot) => T): { result: T; snapshot: CruxSnapshot } { return current().mutate(action) }
export function nextId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}` }
export function nowIso(): string { return new Date().toISOString() }

/** A synchronous server transaction shares the same domain rules as local storage. */
export function withCruxDomainSnapshot<T>(snapshot: CruxSnapshot, action: () => T): { snapshot: CruxSnapshot; result: T } {
  cruxSnapshotSchema.parse(snapshot)
  const previous = repository
  let owned = structuredClone(snapshot)
  let writing = false
  repository = {
    loadSnapshot: () => structuredClone(owned),
    mutate: <R>(write: (draft: CruxSnapshot) => R) => {
      if (writing) throw new Error('Collaboration domain cannot nest write transactions')
      const draft = structuredClone(owned)
      writing = true
      try {
        const result = write(draft)
        if (result instanceof Promise) throw new Error('Collaboration write transactions must be synchronous')
        cruxSnapshotSchema.parse(draft)
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
