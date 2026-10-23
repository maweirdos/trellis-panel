import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { IntegrationDirectoryEntry } from '../../../../../shared/integration-directory'
import { useInteractionGuard } from '../../../utils/interaction-scope'
import { Button } from '../../ui'
import { IntegrationProductIcon } from './IntegrationProductIcon'

/** Uses the shell's centered PageContent; it adds no second max-width or scroll owner. */
export function IntegrationProviderFrame({ entry, onBack, children }: { entry: IntegrationDirectoryEntry; onBack: () => void; children: ReactNode }): JSX.Element {
  const title = useRef<HTMLHeadingElement>(null)
  const canInteract = useInteractionGuard()
  useLayoutEffect(() => {
    if (!canInteract()) return
    title.current?.closest('.my-page-body')?.scrollTo({ top: 0 })
    title.current?.focus({ preventScroll: true })
  }, [entry.id, canInteract])
  return <div className="space-y-8" data-integration-detail={entry.id}>
    <Button size="sm" variant="ghost" onClick={onBack}><ChevronLeft size={15} />外部应用集成</Button>
    <div className="flex items-center gap-5 py-4"><div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-my-xl border border-my-line bg-my-layer-1"><IntegrationProductIcon provider={entry.providerId} large /></div><div className="min-w-0"><h2 ref={title} tabIndex={-1} className="text-my-xl font-semibold">{entry.name}</h2><p className="mt-2 text-my-sm leading-relaxed text-my-tertiary">{entry.description}</p></div></div>
    <div className="space-y-6">{children}</div>
  </div>
}
