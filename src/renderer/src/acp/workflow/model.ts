import { contextReceiptSchema, workflowScopeIdentity, type CompiledWorkflow, type ExecutionEvent, type MaterialVersion, type RunRef } from '../../../../shared/workflow'
import type { WorkflowApplicationSnapshot } from '../../../../shared/workflow-application'
import { projectRootKey } from '../../my/navigation'

export type WorkflowView = { collapsed: boolean; dock: 'composer' | 'corner'; selected: string | null; viewport: { x: number; y: number; zoom: number } }
export const defaultWorkflowView = (): WorkflowView => ({ collapsed: true, dock: 'composer', selected: null, viewport: { x: 16, y: 12, zoom: .8 } })
export const viewKey = (root: string, task: string): string => JSON.stringify([projectRootKey(root), task])
const storageKey = 'tpanel.workflow.views'
export function readWorkflowView(key: string): WorkflowView {
  try {
    const entry = JSON.parse(localStorage.getItem(storageKey) ?? '{}')[key]
    if (!entry || typeof entry !== 'object') return defaultWorkflowView()
    const viewport = entry.viewport
    return { collapsed: entry.collapsed !== false, dock: entry.dock === 'corner' ? 'corner' : 'composer', selected: typeof entry.selected === 'string' ? entry.selected : null,
      viewport: viewport && [viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) ? { x: viewport.x, y: viewport.y, zoom: Math.min(1.6, Math.max(.35, viewport.zoom)) } : defaultWorkflowView().viewport }
  } catch { return defaultWorkflowView() }
}
export function saveWorkflowView(key: string, view: WorkflowView): void {
  try {
    const entries = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    const bounded = Object.fromEntries(Object.entries(entries && typeof entries === 'object' ? entries : {}).filter(([id]) => id !== key).slice(-39))
    localStorage.setItem(storageKey, JSON.stringify({ ...bounded, [key]: view }))
  } catch { /* Reading/execution does not depend on available preference storage. */ }
}
export const stateLabel = (state: string): string => ({ planned: '尚未开始', queued: '已排队', dispatched: '已派发', running: '执行中', waiting: '等待处理', stopping: '停止中', stopped: '已停止', verified: '产物已核验', failed: '未通过', cancelled: '已取消', 'not-selected': '本次未选择执行', 'outcome-unknown': '结果待核对' })[state] ?? '状态未观察到'
export const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function mergeWorkflowEvents(previous: ExecutionEvent[], incoming: ExecutionEvent[], limit = 512): ExecutionEvent[] {
  const entries = new Map(previous.map((event) => [event.eventId, event]))
  for (const event of incoming) if (!entries.has(event.eventId)) entries.set(event.eventId, event)
  return [...entries.values()].slice(-limit)
}
export function belongsToNode(event: ExecutionEvent, nodeId: string, run?: RunRef | null): boolean {
  if (event.attribution.kind !== 'assigned' || (run && (event.attribution.run.runId !== run.runId || event.attribution.run.revision !== run.revision))) return false
  if (event.attribution.step?.nodeId === nodeId) return true
  // Actual coordinator gates have no fabricated native step/session. Their
  // explicit platform result carries the node identity in its payload instead.
  return event.source === 'platform' && event.attribution.step === null
    && ['workflow.gate-result', 'workflow.gate-aborted'].includes(event.type)
    && recordOf(event.payload).nodeId === nodeId
}
export type MaterialReceipt = { ref: string; material: MaterialVersion; stages: string[]; receiver: string; includedDigest: string | null; receivedAt: number }
export function materialReceipts(events: ExecutionEvent[], nodeId: string, run?: RunRef | null): MaterialReceipt[] {
  const entries = new Map<string, MaterialReceipt>()
  for (const event of events) {
    if (!belongsToNode(event, nodeId, run) || !event.type.startsWith('workflow.context-')) continue
    const parsed = contextReceiptSchema.safeParse(event.payload)
    if (!parsed.success || !/^wm-[0-9a-f]{64}$/.test(parsed.data.evidenceRef)) continue
    const payload = parsed.data; const material = payload.material
    if (event.attribution.kind !== 'assigned' || !event.attribution.step || workflowScopeIdentity(payload.scope) !== workflowScopeIdentity(event.attribution.scope)
      || payload.step.nodeId !== event.attribution.step.nodeId || payload.step.runId !== event.attribution.run.runId || payload.step.revision !== event.attribution.run.revision || payload.step.attempt !== event.attribution.step.attempt) continue
    const key = JSON.stringify([material.materialId, material.version])
    const old = entries.get(key)
    entries.set(key, { ref: payload.evidenceRef, material, stages: [...new Set([...(old?.stages ?? []), payload.stage])], receiver: payload.receiver, includedDigest: payload.includedDigest, receivedAt: event.receivedAt })
  }
  return [...entries.values()]
}
export function materialName(material: MaterialVersion): string {
  return material.source.kind === 'trellis-file' ? material.source.relativePath : material.source.kind === 'published' ? `发布版本 ${material.source.publicationId}` : `${material.source.instanceId} / ${material.source.objectId}`
}
export const receiptLabel = (stage: string): string => ({ prepared: '已准备', assembled: '已组装', 'emitted-to-host': '已输出至宿主', 'tool-read': '工具已读取', 'check-result': '有检查记录' })[stage] ?? stage
export function graphPositions(graph: CompiledWorkflow['graph']): Map<string, { x: number; y: number }> {
  return new Map(graph.nodes.map((node, index) => [node.nodeId, graph.layout.nodes[node.nodeId] ? { x: graph.layout.nodes[node.nodeId].x, y: graph.layout.nodes[node.nodeId].y } : { x: index * 224, y: 20 }]))
}
export function currentNode(snapshot: WorkflowApplicationSnapshot | null): string | null {
  const head = snapshot?.snapshot?.run.run
  return snapshot?.nodes.find((node) => ['queued', 'running', 'dispatched', 'waiting', 'stopping', 'outcome-unknown'].includes(node.state))?.nodeId
    ?? snapshot?.nodes.find((node) => head && node.run?.runId === head.runId && node.run.revision === head.revision && node.state !== 'planned')?.nodeId
    ?? snapshot?.nodes.filter((node) => node.state !== 'planned').at(-1)?.nodeId ?? snapshot?.graph?.nodes[0]?.nodeId ?? null
}

/** Dependency evidence must match both recorded stage revisions, not just reused node IDs. */
export function observedHandoff(events: ExecutionEvent[], snapshot: WorkflowApplicationSnapshot | null, edge: { from: string; to: string }): boolean {
  const from = snapshot?.nodes.find((node) => node.nodeId === edge.from)?.run
  const to = snapshot?.nodes.find((node) => node.nodeId === edge.to)?.run
  if (!snapshot || !from || !to) return false
  return events.some((event) => {
    if (event.type !== 'workflow.preset-boundary' || event.attribution.kind !== 'assigned'
      || workflowScopeIdentity(event.attribution.scope) !== workflowScopeIdentity(snapshot.scope)
      || event.attribution.run.runId !== from.runId || event.attribution.run.revision !== from.revision) return false
    const payload = recordOf(event.payload), next = recordOf(payload.next)
    return payload.nextNodeId === edge.to && next.runId === to.runId && next.revision === to.revision
  })
}
