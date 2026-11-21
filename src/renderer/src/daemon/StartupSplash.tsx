import { BrandMotion } from '../my/BrandMotion'
import { BrandWordmark } from '../my/BrandWordmark'
import './startup.css'

/** Observation remains visible until real workspace content can receive the mark. */
export function StartupSplash({ status, entrance = true, active = true }: { status: string; entrance?: boolean; active?: boolean }): JSX.Element {
  return <section className="my-startup-splash" data-entrance={entrance} aria-label="Crux">
    <div className="my-startup-visual" aria-busy="true">
      <div className="my-startup-mark" data-startup-brand-source aria-hidden="true">
        <BrandMotion state="observe" size={96} active={active} />
      </div>
      <h1 className="my-startup-wordmark" aria-label="Crux"><BrandWordmark width={112} /></h1>
    </div>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</p>
  </section>
}
