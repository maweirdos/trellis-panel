/** Read-only comparison key. It identifies a declared remote, never a repository access grant. */
export function codeRepositoryIdentity(raw: string): string | null {
  if (!raw || /[\s\u0000-\u001f\u007f]/.test(raw)) return null
  let value = raw
  if (!value.includes('://')) {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value)
    if (!scp || /^[A-Za-z]$/.test(scp[1])) return null
    value = `ssh://${scp[1]}/${scp[2]}`
  }
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.search || url.hash) return null
    const port = url.port && !((url.protocol === 'ssh:' && url.port === '22') || (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) ? `:${url.port}` : ''
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
    if (!path || path === '/' || /%(?:00|0a|0d|2f|5c)/i.test(path) || path.includes('\\')) return null
    return `${url.hostname.toLowerCase()}${port}${path}`
  } catch { return null }
}
