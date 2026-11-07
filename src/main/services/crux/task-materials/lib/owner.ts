import type { CruxMaterialScope } from '../../../../../shared/crux-task-materials'
import type { CruxWorkspaceContext } from '../../../../../shared/crux-remote'
import { DesktopTeamError } from '../../../team-platform/types'
import { taskMaterialTransportPinSchema } from '../../../team-platform/task-materials-transport'
import type { MaterialHost, MaterialOwner, MaterialTeamSession } from '../types'

const changed = (): never => { throw new DesktopTeamError('BINDING_CHANGED', '原材料工作区或身份已经改变，请回原来源核对。') }
const selectedFields = (context: CruxWorkspaceContext): unknown[] => [context.key, context.connectionId, context.actorId, context.projectId, context.origin, context.instanceId, context.epoch]
export function requireMaterialWorkspace(context: CruxWorkspaceContext, workspaceKey: string): void {
  if (context.state === 'local') throw new DesktopTeamError('MATERIALS_UNSUPPORTED', '团队任务材料仅支持已连接的共享工作区；本机任务可继续使用原有工作流程。')
  if (context.key !== workspaceKey) changed()
  if (context.state !== 'connected') throw new DesktopTeamError('MATERIAL_SOURCE_UNAVAILABLE', '原共享工作区尚未连接或已失去访问权限，请恢复后核对材料。')
}
export async function captureMaterialOwner(host: MaterialHost, session: MaterialTeamSession, input: CruxMaterialScope, context: CruxWorkspaceContext, generation: number): Promise<MaterialOwner> {
  const connection = (await session.connections()).find(item => item.connectionId === context.connectionId)
  if (!connection || connection.state !== 'active' || connection.accessLocked || connection.ownerId !== context.actorId || connection.projectId !== context.projectId || connection.origin !== context.origin) return changed()
  const pin = taskMaterialTransportPinSchema.parse({ workspaceKey: input.workspaceKey, taskId: input.taskId, spaceId: input.spaceId, taskCreatedAt: input.taskCreatedAt,
    connectionId: connection.connectionId, actorId: connection.ownerId, projectId: connection.projectId, deviceId: connection.deviceId,
    pairingId: connection.pairingId, origin: connection.origin, instanceId: context.instanceId, epoch: context.epoch })
  const owner = { pin, generation }
  await assertMaterialOwner(host, session, owner)
  return owner
}
export async function assertMaterialOwner(host: MaterialHost, session: MaterialTeamSession, owner: MaterialOwner): Promise<void> {
  const context = await host.workspaceStatus(), pin = owner.pin
  const connection = (await session.connections()).find(item => item.connectionId === pin.connectionId)
  if (host.workspaceGeneration() !== owner.generation || context.state !== 'connected'
    || JSON.stringify(selectedFields(context)) !== JSON.stringify([pin.workspaceKey, pin.connectionId, pin.actorId, pin.projectId, pin.origin, pin.instanceId, pin.epoch])
    || !connection || connection.state !== 'active' || connection.accessLocked || connection.deviceId !== pin.deviceId || connection.pairingId !== pin.pairingId
    || connection.origin !== pin.origin || connection.ownerId !== pin.actorId || connection.projectId !== pin.projectId) changed()
}
