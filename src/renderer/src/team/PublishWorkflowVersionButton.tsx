import { useEffect, useState, type JSX } from 'react'
import { Share2 } from 'lucide-react'
import type { TeamPublicationInput } from '../../../shared/team-platform'
import { api } from '../api'
import { Button } from '../my/ui'
import { PublicationDialog, type WorkflowPublicationSource } from './PublicationDialog'
import { useTeamOwner } from './use-team-owner'
import './team.css'

export type PublishWorkflowVersionButtonProps = { expectedRoot: string; source: WorkflowPublicationSource; title: string; kind?: TeamPublicationInput['kind'] }
export function PublishWorkflowVersionButton({ expectedRoot, source, title, kind }: PublishWorkflowVersionButtonProps): JSX.Element | null {
  const owner = useTeamOwner(expectedRoot)
  const [opened, setOpened] = useState<{ root: string; source: WorkflowPublicationSource; title: string; kind?: TeamPublicationInput['kind'] } | null>(null)
  useEffect(() => setOpened(null), [owner.lifetime])
  if (typeof api?.teamDesktop?.queueWorkflowMaterial !== 'function') return null
  return <><Button variant="ghost" size="sm" onClick={() => { if (owner.valid(owner.capture())) setOpened({ root: expectedRoot, source: structuredClone(source), title, kind }) }}><Share2 size={12} />发布此版本</Button><PublicationDialog open={opened?.root === expectedRoot} onClose={() => setOpened(null)} expectedRoot={opened?.root ?? expectedRoot} source={opened?.source} title={opened?.title} kind={opened?.kind} /></>
}
