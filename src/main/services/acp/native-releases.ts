/** Strict SemVer precedence; build metadata has no ordering significance. */
export function parseReleaseVersion(value: string | undefined): { major: number; core: number[]; prerelease: string[] } | undefined {
  const match = value?.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/)
  if (!match) return undefined
  const core = match.slice(1, 4).map(Number)
  const prerelease = match[4]?.split('.') ?? []
  if (core.some(part => !Number.isSafeInteger(part)) || prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined
  return { major: core[0], core, prerelease }
}

export function compareReleaseVersions(left: string | undefined, right: string | undefined): number | undefined {
  const a = parseReleaseVersion(left)
  const b = parseReleaseVersion(right)
  if (!a || !b) return undefined
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1
    if (numericX !== numericY) return numericX ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

export const OPENCODE_V2_PACKAGE = '@opencode/cli'
export const OPENCODE_V2_VERSION = '2.3.2'
export const OPENCODE_MIGRATION_GUIDE = 'https://opencode.ai/v2/docs/migrate-v1/'

/** An installed but unreadable/unsupported CLI must never select an installation package. */
export function openCodeRelease(version: string | undefined): { packageName: string; channel: 'v1' | 'v2'; major: number } | undefined {
  const major = parseReleaseVersion(version)?.major
  return major === 1 ? { packageName: 'opencode-ai', channel: 'v1', major }
    : major === 2 ? { packageName: OPENCODE_V2_PACKAGE, channel: 'v2', major } : undefined
}
