export function composerSearchScore(value: string, query: string, fuzzy = false): number {
  const normalized = value.normalize('NFC').toLowerCase()
  if (!query || normalized === query) return 0
  if (normalized.startsWith(query)) return 2
  const included = normalized.indexOf(query)
  if (included > 0) return /[\s\-_/]/u.test(normalized[included - 1]) ? 4 : 6
  if (!fuzzy) return Infinity
  let cursor = 0
  for (const character of query) {
    const index = normalized.indexOf(character, cursor)
    if (index < 0) return Infinity
    cursor = index + character.length
  }
  return 100 + cursor - query.length
}

export function searchSlashCommandItems<Item extends {
  readonly type: 'model' | 'skill'
  readonly name: string
  readonly label: string
  readonly description?: string
}>(items: readonly Item[], query: string): Item[] {
  const normalized = query.trim().replace(/^\/+/u, '').normalize('NFC').toLowerCase()
  return items.map((item, order) => {
    if (item.type === 'skill' && normalized === 'skill') return { item, order, score: 0 }
    const search = item.type === 'skill' && normalized.startsWith('skill:') ? normalized.slice(6) : normalized
    const score = Math.min(
      composerSearchScore(item.name, search, true),
      composerSearchScore(item.label, search),
      20 + composerSearchScore(item.description ?? '', search),
    )
    return { item, order, score }
  }).filter(result => Number.isFinite(result.score))
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map(result => result.item)
}
