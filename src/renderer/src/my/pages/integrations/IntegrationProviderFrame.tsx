import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { IntegrationDirectoryEntry } from '../../../../../shared/integration-directory'
import { useInteractionGuard } from '../../../utils/interaction-scope'
import { Button } from '../../ui'
import { IntegrationProductIcon } from './IntegrationProductIcon'

/** Semantic provider column inside PageContent; the shell retains the only page scrollbar. */
export function IntegrationProviderFrame({ entry, onBack, children, flowActive = false }: { entry: IntegrationDirectoryEntry; onBack: () => void; children: ReactNode; flowActive?: boolean }): JSX.Element {
  const title = useRef<HTMLHeadingElement>(null)
  const canInteract = useInteractionGuard()
  useLayoutEffect(() => {
    if (!canInteract()) return
    title.current?.closest('.my-page-body')?.scrollTo({ top: 0 })
    title.current?.focus({ preventScroll: true })
  }, [entry.id, canInteract])
  return <div className="integration-provider-frame" data-integration-detail={entry.id} data-flow-active={flowActive || undefined}>
    {!flowActive && <Button size="sm" variant="ghost" onClick={onBack}><ChevronLeft size={15} />返回集成</Button>}
    {!flowActive && <div className="integration-product-hero"><div className="integration-product-tile"><IntegrationProductIcon provider={entry.providerId} large /></div><div className="min-w-0 flex-1"><h2 ref={title} tabIndex={-1} className="text-my-xl font-semibold">{entry.name}</h2><p className="mt-2 text-my-sm text-my-tertiary">{entry.description}</p></div></div>}
    <div className="integration-provider-sections">{children}</div>
  </div>
}
