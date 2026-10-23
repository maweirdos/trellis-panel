import { BrandMark } from '../my/BrandMark'
import './startup.css'

/** The three windows reveal one canonical mark; they never redraw its path. */
export function StartupSplash({ status, entrance = true }: { status: string; entrance?: boolean }): JSX.Element {
  return <section className="my-startup-splash" data-entrance={entrance} aria-label="Trellis Panel">
    <div className="my-startup-visual" aria-busy="true">
      <div className="my-startup-mark" aria-hidden="true">
        <span className="my-startup-piece my-startup-piece-cap"><BrandMark size={96} /></span>
        <span className="my-startup-piece my-startup-piece-return"><BrandMark size={96} /></span>
        <span className="my-startup-piece my-startup-piece-stem"><BrandMark size={96} /></span>
      </div>
      <h1 className="my-startup-wordmark">Trellis Panel</h1>
      <div className="my-startup-activity" aria-hidden="true"><span /></div>
    </div>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</p>
  </section>
}
