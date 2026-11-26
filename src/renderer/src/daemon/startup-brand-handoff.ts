const TRAVEL_MS = 220
const DOCK_MS = 90
const FALLBACK_MS = 120

type Rect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
interface StyleValue { value: string; priority: string }

function restoreProperty(element: HTMLElement, name: string, previous: StyleValue): void {
  if (previous.value) element.style.setProperty(name, previous.value, previous.priority)
  else element.style.removeProperty(name)
}

function visibleRect(element: HTMLElement | null, allowHidden = false): DOMRect | null {
  if (!element?.isConnected) return null
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (!allowHidden && (style?.visibility === 'hidden' || style?.visibility === 'collapse')) return null
  const rect = element.getBoundingClientRect()
  const viewport = element.ownerDocument.documentElement
  if (rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.top < -1 ||
    rect.right > viewport.clientWidth + 1 || rect.bottom > viewport.clientHeight + 1) return null
  return rect
}

function moved(first: Rect, next: Rect): boolean {
  return ['left', 'top', 'width', 'height'].some(key => Math.abs(first[key as keyof Rect] - next[key as keyof Rect]) > .5)
}

/** Finite presentation only. Completion must still be checked against current readiness. */
export function startStartupBrandHandoff(root: HTMLElement, complete: () => void): () => void {
  const overlay = root.querySelector<HTMLElement>('.my-startup-overlay')
  const source = overlay?.querySelector<HTMLElement>('[data-startup-brand-source] .my-brand-motion') ?? null
  const sourceSlot = overlay?.querySelector<HTMLElement>('[data-startup-brand-source]') ?? null
  const target = root.querySelector<HTMLElement>('[data-startup-brand-target] .my-brand-mark')
  const sourceRect = visibleRect(source)
  const sourceSlotRect = visibleRect(sourceSlot)
  const targetRect = visibleRect(target)
  const document = root.ownerDocument
  const view = document.defaultView
  const animations: Animation[] = []
  const restorations: (() => void)[] = []
  const media = view?.matchMedia('(prefers-reduced-motion: reduce)')
  let observer: ResizeObserver | undefined
  let fallback: number | undefined
  let disposed = false
  let delivered = false

  const setStyle = (element: HTMLElement, name: string, value: string): void => {
    const previous = { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) }
    restorations.push(() => restoreProperty(element, name, previous))
    element.style.setProperty(name, value)
  }
  const animate = (element: HTMLElement, frames: Keyframe[], duration: number, delay = 0): Animation => {
    const animation = element.animate(frames, { duration, delay, easing: 'linear', fill: 'both' })
    animations.push(animation)
    return animation
  }
  const detach = (): void => {
    if (fallback !== undefined) view?.clearTimeout(fallback)
    fallback = undefined
    observer?.disconnect()
    view?.removeEventListener('resize', geometryChanged)
    view?.visualViewport?.removeEventListener('resize', geometryChanged)
    document.removeEventListener('visibilitychange', environmentChanged)
    media?.removeEventListener('change', environmentChanged)
  }
  const finish = (): void => {
    if (disposed || delivered) return
    delivered = true
    detach()
    complete()
  }
  const environmentChanged = (): void => {
    if (document.hidden || media?.matches) finish()
  }
  const geometryChanged = (): void => {
    const nextTarget = visibleRect(target, true)
    const nextSource = visibleRect(sourceSlot)
    if (!nextTarget || !nextSource || !targetRect || !sourceSlotRect || moved(targetRect, nextTarget) || moved(sourceSlotRect, nextSource)) finish()
  }
  const cancel = (): void => {
    if (disposed) return
    disposed = true
    detach()
    animations.forEach(animation => animation.cancel())
    restorations.reverse().forEach(restore => restore())
    delete root.dataset.startupMotion
  }

  if (!overlay || !view || document.hidden || media?.matches) {
    finish()
    return cancel
  }

  document.addEventListener('visibilitychange', environmentChanged)
  media?.addEventListener('change', environmentChanged)
  const overlayWasInert = overlay.hasAttribute('inert')
  overlay.setAttribute('inert', '')
  restorations.push(() => { if (!overlayWasInert) overlay.removeAttribute('inert') })

  const background = overlay.querySelector<HTMLElement>('.my-startup-backdrop')
  const furniture = [...overlay.querySelectorAll<HTMLElement>('.my-startup-titlebar, .my-startup-wordmark, .my-startup-warning')]
  const fade = (element: HTMLElement, duration: number): void => {
    animate(element, [{ opacity: view.getComputedStyle(element).opacity }, { opacity: 0 }], duration)
  }

  try {
    if (!source || !sourceRect || !target || !targetRect || typeof source.animate !== 'function') {
      root.dataset.startupMotion = 'fallback'
      const cover = animate(overlay, [{ opacity: 1 }, { opacity: 0 }], FALLBACK_MS)
      fallback = view.setTimeout(finish, FALLBACK_MS + 80)
      void cover.finished.then(finish, finish)
      return cancel
    }

    root.dataset.startupMotion = 'flight'
    setStyle(source, 'position', 'fixed')
    setStyle(source, 'left', `${sourceRect.left}px`)
    setStyle(source, 'top', `${sourceRect.top}px`)
    setStyle(source, 'transform-origin', '0 0')
    const targetVisibility = { value: target.style.getPropertyValue('visibility'), priority: target.style.getPropertyPriority('visibility') }
    setStyle(target, 'visibility', 'hidden')
    if (background) fade(background, TRAVEL_MS)
    furniture.forEach(element => fade(element, 160))

    const x = targetRect.left - sourceRect.left
    const y = targetRect.top - sourceRect.top
    const sx = targetRect.width / sourceRect.width
    const sy = targetRect.height / sourceRect.height
    const transform = (factor = 1, shift = 0): string => {
      const length = Math.hypot(x, y) || 1
      const dx = x + targetRect.width * (1 - factor) / 2 + x / length * shift
      const dy = y + targetRect.height * (1 - factor) / 2 + y / length * shift
      return `translate(${dx}px, ${dy}px) scale(${sx * factor}, ${sy * factor})`
    }
    const travel = animate(source, [{ transform: 'translate(0px, 0px) scale(1, 1)' }, { transform: transform() }], TRAVEL_MS)
    fallback = view.setTimeout(finish, TRAVEL_MS + DOCK_MS + 100)
    void travel.finished.then(() => {
      if (disposed || delivered) return
      root.dataset.startupMotion = 'dock'
      const overshoot = Math.min(1, targetRect.width * .05)
      const dock = animate(source, [
        { transform: transform(), offset: 0, easing: 'cubic-bezier(.22, 1, .36, 1)' },
        { transform: transform(1.04, overshoot), offset: .38, easing: 'ease-in-out' },
        { transform: transform(.99, -overshoot * .2), offset: .72, easing: 'ease-out' },
        { transform: transform(), offset: 1 }
      ], DOCK_MS)
      restoreProperty(target, 'visibility', targetVisibility)
      animate(target, [{ opacity: 0 }, { opacity: 1 }], 80, DOCK_MS - 80)
      animate(source, [{ opacity: 1 }, { opacity: 0 }], 80, DOCK_MS - 80)
      void dock.finished.then(finish, finish)
    }, finish)

    view.addEventListener('resize', geometryChanged)
    view.visualViewport?.addEventListener('resize', geometryChanged)
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(geometryChanged)
      observer.observe(target)
      if (sourceSlot) observer.observe(sourceSlot)
    }
  } catch {
    // Unsupported/interrupted presentation must never retain a ready workspace cover.
    finish()
  }
  return cancel
}
