import { cruxWorkspaceSnapshot } from '../crux/connection-service'

/** Whiteboard v2 has no task adoption; unrelated tasks are not part of its authority proof. */
export async function whiteboardV2Workspace(): ReturnType<typeof cruxWorkspaceSnapshot> {
  const value = await cruxWorkspaceSnapshot()
  return { ...value, snapshot: { ...value.snapshot, tasks: [] } }
}
