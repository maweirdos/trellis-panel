interface MotionEntry { visible: boolean }
interface MotionRuntime {
  entries: Map<HTMLElement, MotionEntry>
  observer: IntersectionObserver | null
  media: MediaQueryList
  update: () => void
}

let runtime: MotionRuntime | null = null

function updateEntry(target: HTMLElement, entry: MotionEntry, media: MediaQueryList): void {
  target.dataset.motion = media.matches ? 'reduced' : !document.hidden && entry.visible ? 'running' : 'paused'
}

function getRuntime(): MotionRuntime {
  if (runtime) return runtime
  const entries = new Map<HTMLElement, MotionEntry>()
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  const update = (): void => entries.forEach((entry, target) => updateEntry(target, entry, media))
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(changes => {
    for (const change of changes) {
      const target = change.target as HTMLElement
      const entry = entries.get(target)
      if (!entry) continue
      entry.visible = change.isIntersecting && change.intersectionRect.width > 0 && change.intersectionRect.height > 0
      updateEntry(target, entry, media)
    }
  }, { threshold: 0 })
  document.addEventListener('visibilitychange', update)
  media.addEventListener('change', update)
  runtime = { entries, observer, media, update }
  return runtime
}

/** One observer and one pair of environment listeners serve all mounted animated marks. */
export function observeBrandMotion(target: HTMLElement): () => void {
  const owner = getRuntime()
  const entry = { visible: owner.observer === null }
  owner.entries.set(target, entry)
  updateEntry(target, entry, owner.media)
  owner.observer?.observe(target)
  return () => {
    owner.observer?.unobserve(target)
    owner.entries.delete(target)
    target.dataset.motion = 'paused'
    if (owner.entries.size !== 0) return
    owner.observer?.disconnect()
    document.removeEventListener('visibilitychange', owner.update)
    owner.media.removeEventListener('change', owner.update)
    if (runtime === owner) runtime = null
  }
}
