import { canonicalWorkflowJson, type CompiledWorkflow } from '../../../shared/workflow'
import type { WorkflowRevisionImpact } from '../../../shared/workflow-revisions'
import type { WorkflowApplicationSnapshot } from '../../../shared/workflow-application'
import type { ApplicationNodePolicy } from './types'

/** Compare source semantics, not version-derived graph IDs or layout positions. */
export function revisionImpact(before: CompiledWorkflow, after: CompiledWorkflow, known: WorkflowApplicationSnapshot['nodes'], activeNodeId: string, startStepId: string, beforePolicies: Record<string, ApplicationNodePolicy>, afterPolicies: Record<string, ApplicationNodePolicy>): WorkflowRevisionImpact {
  const left = new Map(before.plan.nodes.map((node) => [node.stepId, node]))
  const right = new Map(after.plan.nodes.map((node) => [node.stepId, node]))
  const semantics = (node: CompiledWorkflow['plan']['nodes'][number], policies: Record<string, ApplicationNodePolicy>): string => {
    const policy = policies[node.stepId]
    return canonicalWorkflowJson({ phase: node.phaseId, step: node.step, executor: node.executor, role: node.role, trellisPhase: node.trellisPhase,
      policy: policy ? { agentId: policy.agentId, profileId: policy.profileId ?? null, contract: policy.output.contract, files: policy.output.files, maxRepairTurns: policy.output.maxRepairTurns } : null })
  }
  const start = after.plan.nodes.findIndex((node) => node.stepId === startStepId)
  const nodes: WorkflowRevisionImpact['nodes'] = [...new Set([...left.keys(), ...right.keys()])].map((stepId) => {
    const a = left.get(stepId); const b = right.get(stepId)
    const change = !a ? 'added' : !b ? 'removed' : semantics(a, beforePolicies) === semantics(b, afterPolicies) ? 'unchanged' : 'changed'
    // Unchanged definition semantics do not prove safe result reuse. Chosen
    // successor work still runs; earlier source nodes are explicitly excluded.
    const affected = !b || after.plan.nodes.indexOf(b) >= start
    return { stepId, before: a?.nodeId ?? null, after: b?.nodeId ?? null, change, affected }
  })
  const edgeKey = (graph: CompiledWorkflow, edge: CompiledWorkflow['plan']['edges'][number]): string => {
    const source = graph.plan.nodes.find((node) => node.nodeId === edge.from)?.stepId
    const target = graph.plan.nodes.find((node) => node.nodeId === edge.to)?.stepId
    return canonicalWorkflowJson([source ?? null, target ?? null, edge.kind])
  }
  const leftEdges = new Map(before.plan.edges.map((edge) => [edgeKey(before, edge), edge]))
  const rightEdges = new Map(after.plan.edges.map((edge) => [edgeKey(after, edge), edge]))
  return {
    nodes, edges: [...new Set([...leftEdges.keys(), ...rightEdges.keys()])].map((key) => ({ before: leftEdges.get(key)?.edgeId ?? null, after: rightEdges.get(key)?.edgeId ?? null, change: !leftEdges.has(key) ? 'added' : !rightEdges.has(key) ? 'removed' : leftEdges.get(key)?.maxRetries !== rightEdges.get(key)?.maxRetries ? 'changed' : 'unchanged' })),
    affectedNodeIds: nodes.filter((node) => node.affected).flatMap((node) => [node.before, node.after].filter((id): id is string => id !== null)),
    preservedNodeIds: nodes.filter((node) => !node.affected && node.before).map((node) => node.before as string),
    materials: known.filter((node) => node.run && node.state === 'verified').flatMap((node) => node.outputRefs.map((ref) => ({ ref, nodeId: node.nodeId, run: node.run as NonNullable<typeof node.run>, state: node.state, reuse: 'input-only' as const }))),
    pendingBoundaryOutput: known.find((node) => node.nodeId === activeNodeId)?.state === 'verified' ? null : activeNodeId || null, automaticExecutionReuse: false
  }
}
