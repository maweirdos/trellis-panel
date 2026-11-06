import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowLeft } from 'lucide-react'
import { api } from '../api'
import { useHifox } from '../hifox/store'
import { PageBody, PageHeader, PageLayout } from '../my/layout/PageLayout'
import { Button } from '../my/ui'
import { WhiteboardWorkspace, type WhiteboardWorkspaceAdapter } from './WhiteboardWorkspace'

type WorkspaceState = ReturnType<typeof useHifox.getState>

function authority(state: WorkspaceState): string {
  const context = state.workspaceContext
  const members = state.snapshot?.members.map((member) => [member.id, member.role, member.projectRoles]) ?? null
  const spaces = state.snapshot?.spaces.map((space) => [space.id, space.name, space.ownerId, space.visibility, space.archived, space.memberIds]) ?? null
  return JSON.stringify([context.key, context.actorId, context.connectionId, context.projectId, context.origin,
    context.instanceId, context.epoch, context.authorizationRevision, context.state, members, spaces])
}

/** A synchronous store subscription fences replies even before React re-renders. */
export function WhiteboardEntry({ onBack }: { onBack: () => void }): JSX.Element {
  const context = useHifox((state) => state.workspaceContext)
  const snapshot = useHifox((state) => state.snapshot)
  const [generation, setGeneration] = useState(0)
  const fence = useRef({ value: 0, authority: authority(useHifox.getState()) })
  useLayoutEffect(() => useHifox.subscribe((state) => {
    const next = authority(state)
    if (next !== fence.current.authority) {
      fence.current = { value: fence.current.value + 1, authority: next }
      setGeneration(fence.current.value)
    }
  }), [])

  const identity = authority(useHifox.getState())
  const current = useCallback(() => fence.current.value === generation && fence.current.authority === identity && authority(useHifox.getState()) === identity, [generation, identity])
  const sourceId = JSON.stringify([context.key, context.connectionId, context.projectId, context.origin, context.instanceId, context.epoch])
  const actorId = context.actorId ?? ''
  const publicationKey = JSON.stringify(context.state === 'local' && actorId && snapshot
    ? snapshot.spaces.filter((space) => !space.archived && space.memberIds.includes(actorId)).map((space) => ({ id: space.id, name: space.name, ownerOnly: true as const })) : [])
  const adapter = useMemo<WhiteboardWorkspaceAdapter | undefined>(() => api?.whiteboardV2
    ? { api: api.whiteboardV2, localPublication: JSON.parse(publicationKey) as Array<{ id: string; name: string; ownerOnly: true }>, localOpinions: true }
    : undefined, [publicationKey])
  const owner = { workspaceKey: context.key, actorId, epoch: context.epoch ?? null, sourceId,
    authorizationRevision: context.authorizationRevision ?? null, generation, local: context.state === 'local',
    authorized: Boolean(context.state === 'local' && actorId && snapshot?.members.some((member) => member.id === actorId)) }

  return <PageLayout variant="full" className="creation-workspace">
    <PageHeader><Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft size={15} />返回产物</Button></PageHeader>
    <PageBody><WhiteboardWorkspace owner={owner} adapter={adapter} enabled isCurrent={current} /></PageBody>
  </PageLayout>
}
