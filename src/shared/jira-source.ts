/** Legacy keys alone cannot identify a Jira instance (TPD-025). */
export function jiraSourceMatch(storedInstance: string | null | undefined, storedUrl: string | null | undefined, instanceId: string, issueUrl: string): 'same' | 'other' | 'ambiguous' {
  if (storedInstance) return storedInstance === instanceId ? 'same' : 'other'
  if (!storedUrl) return 'ambiguous'
  try {
    const base = (url: string): string => { const parsed = new URL(url); const index = parsed.pathname.indexOf('/browse/'); if (index < 0) throw new Error('source'); return `${parsed.origin}${parsed.pathname.slice(0, index).replace(/\/+$/, '')}`.toLowerCase() }
    return base(storedUrl) === base(issueUrl) ? 'same' : 'other'
  } catch { return 'ambiguous' }
}
