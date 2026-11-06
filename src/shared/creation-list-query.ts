import type { z } from 'zod'
import type { creationListInputSchema, CreationSummary } from './creations'

export type CreationListQuery = z.output<typeof creationListInputSchema>

/** New query semantics are opt-in so existing ID cursors remain valid. */
export function usesCreationSearch(query: CreationListQuery): boolean {
  return query.query !== undefined || query.kind !== undefined || query.sort !== undefined
}

/** Call only with summaries already projected for the current actor. */
export function filterCreationSummaries(items: CreationSummary[], query: CreationListQuery): CreationSummary[] {
  const needle = (query.query ?? '').toLowerCase()
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
  return items.filter((item) => (!query.kind || item.kind === query.kind) && item.title.toLowerCase().includes(needle))
    .sort((a, b) => (query.sort === 'name' ? compare(a.title.toLowerCase(), b.title.toLowerCase()) : b.updatedAt - a.updatedAt) || compare(a.creationId, b.creationId))
}

/** Only authorized metadata contributes to cursor invalidation. */
export function creationSearchScope(query: CreationListQuery, items: CreationSummary[]): string {
  return JSON.stringify([query.scope, query.spaceId ?? null, query.taskId ?? null, query.query ?? '', query.kind ?? null, query.sort ?? 'updated', query.limit,
    items.map((item) => [item.creationId, item.revision, item.title, item.kind, item.updatedAt])])
}
