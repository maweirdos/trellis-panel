export const CODEX_PACKAGE_FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0'
export const CODEX_PACKAGE_PROBE_POSITIVE_TTL_MS = 60_000
export const CODEX_PACKAGE_PROBE_NEGATIVE_TTL_MS = 10_000
export type VerifiedCodexPackage = Readonly<{ packageFamilyName: typeof CODEX_PACKAGE_FAMILY }>
type PackageProbeCache = { read(): Promise<VerifiedCodexPackage | null>; invalidate(): void }

/** One fixed package, one pending read, and no timers or project/process inventory. */
export function createCodexPackageProbeCache(
  load: () => Promise<VerifiedCodexPackage | null>,
  now: () => number = () => performance.now()
): PackageProbeCache {
  let cached: { value: VerifiedCodexPackage | null; expiresAt: number } | undefined
  let pending: Promise<VerifiedCodexPackage | null> | undefined
  let generation = 0
  return {
    read(): Promise<VerifiedCodexPackage | null> {
      if (pending) return pending
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value)
      const startedGeneration = generation
      const read = Promise.resolve().then(load).catch(() => null).then(raw => {
        // Invalidating a pending read discards its old result without spawning a second helper.
        if (startedGeneration !== generation) return null
        const value = raw?.packageFamilyName === CODEX_PACKAGE_FAMILY ? Object.freeze({ packageFamilyName: CODEX_PACKAGE_FAMILY }) : null
        cached = { value, expiresAt: now() + (value ? CODEX_PACKAGE_PROBE_POSITIVE_TTL_MS : CODEX_PACKAGE_PROBE_NEGATIVE_TTL_MS) }
        return value
      })
      const current = read.finally(() => { if (pending === current) pending = undefined })
      pending = current
      return current
    },
    invalidate(): void { generation += 1; cached = undefined }
  }
}
