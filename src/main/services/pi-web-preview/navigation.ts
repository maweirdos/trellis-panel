import type { WebContents } from 'electron'
import type { PiWebPreviewService } from './index'

const guarded = new WeakSet<WebContents>()

/** CSP resource directives do not prevent a frame from replacing its document. */
export function installPiWebPreviewNavigation(sender: WebContents, service: PiWebPreviewService): void {
  if (guarded.has(sender)) return
  guarded.add(sender)
  const bindings = new Map<number, string>()
  const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean; frame: Electron.WebFrameMain | null }>): void => {
    if (event.isMainFrame) return
    try {
      const frame = event.frame
      if (!frame || !frame.parent || frame.parent.parent) { event.preventDefault(); return }
      const live = new Set(sender.mainFrame.framesInSubtree.map(item => item.frameTreeNodeId))
      live.add(frame.frameTreeNodeId)
      for (const id of bindings.keys()) if (!live.has(id)) bindings.delete(id)
      const bound = bindings.get(frame.frameTreeNodeId)
      // Preserve the existing app-owned srcDoc preview, but never let a lease shed its response CSP.
      if (!bound && (event.url === 'about:srcdoc' || event.url === 'about:blank')) return
      const target = service.navigationLease(sender.id, event.url)
      if (!target || bound && target !== bound || !bound && bindings.size >= 64) { event.preventDefault(); return }
      bindings.set(frame.frameTreeNodeId, target)
    } catch { event.preventDefault() }
  }
  sender.on('will-frame-navigate', guard)
  // This also fences redirects while the frame still has an initial about:blank document.
  sender.on('will-redirect', guard)
  sender.once('destroyed', () => bindings.clear())
}
