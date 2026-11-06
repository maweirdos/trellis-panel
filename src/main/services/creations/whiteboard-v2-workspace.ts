import { hifoxWorkspaceSnapshot } from '../hifox/connection-service'

/** Whiteboard v2 has no task adoption; unrelated tasks are not part of its authority proof. */
export async function whiteboardV2Workspace(): ReturnType<typeof hifoxWorkspaceSnapshot> {
  const value = await hifoxWorkspaceSnapshot()
  return { ...value, snapshot: { ...value.snapshot, tasks: [] } }
}
