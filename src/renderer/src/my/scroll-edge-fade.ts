/**
 * Observes `.my-fade-scroll` and `.my-fade-scroll-x` containers and marks only
 * the edges that actually have off-screen content scrolled past them, preventing
 * static edge masks from fading out the first/last visible items at rest.
 */

const SELECTOR = '.my-fade-scroll, .my-fade-scroll-x'
const THRESHOLD = 2

let installed = false

function syncAttr(el: HTMLElement, name: string, active: boolean): void {
  if (active) {
    if (el.getAttribute(name) !== 'true') el.setAttribute(name, 'true')
  } else if (el.hasAttribute(name)) {
    el.removeAttribute(name)
  }
}

function updateElement(el: HTMLElement): void {
  if (!el.isConnected) return
  const vertical = el.classList.contains('my-fade-scroll')
  const horizontal = el.classList.contains('my-fade-scroll-x')

  if (vertical) {
    const canScrollY = el.scrollHeight - el.clientHeight > THRESHOLD
    syncAttr(el, 'data-fade-top', canScrollY && el.scrollTop > THRESHOLD)
    syncAttr(el, 'data-fade-bottom', canScrollY && el.scrollTop + el.clientHeight < el.scrollHeight - THRESHOLD)
  } else {
    syncAttr(el, 'data-fade-top', false)
    syncAttr(el, 'data-fade-bottom', false)
  }

  if (horizontal) {
    const canScrollX = el.scrollWidth - el.clientWidth > THRESHOLD
    syncAttr(el, 'data-fade-left', canScrollX && el.scrollLeft > THRESHOLD)
    syncAttr(el, 'data-fade-right', canScrollX && el.scrollLeft + el.clientWidth < el.scrollWidth - THRESHOLD)
  } else {
    syncAttr(el, 'data-fade-left', false)
    syncAttr(el, 'data-fade-right', false)
  }
}

export function installScrollEdgeFades(): void {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return
  installed = true

  const observed = new WeakSet<HTMLElement>()
  const pendingScroll = new Set<HTMLElement>()
  let scrollFrame = 0
  let syncFrame = 0

  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target instanceof HTMLElement) updateElement(entry.target)
        }
      })
    : null

  const scan = (): void => {
    syncFrame = 0
    for (const node of document.querySelectorAll<HTMLElement>(SELECTOR)) {
      if (!observed.has(node)) {
        observed.add(node)
        resizeObserver?.observe(node)
      }
      updateElement(node)
    }
  }

  const scheduleScan = (): void => {
    if (syncFrame) return
    syncFrame = window.requestAnimationFrame(scan)
  }

  const flushScroll = (): void => {
    scrollFrame = 0
    for (const el of pendingScroll) updateElement(el)
    pendingScroll.clear()
  }

  document.addEventListener(
    'scroll',
    (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.matches(SELECTOR)) return
      pendingScroll.add(target)
      if (!scrollFrame) scrollFrame = window.requestAnimationFrame(flushScroll)
    },
    { capture: true, passive: true }
  )

  window.addEventListener('resize', scheduleScan, { passive: true })

  const start = (): void => {
    if (document.body) {
      if (typeof MutationObserver === 'function') {
        new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true })
      }
    }
    scheduleScan()
  }

  if (document.body) start()
  else window.addEventListener('DOMContentLoaded', start, { once: true })
}
