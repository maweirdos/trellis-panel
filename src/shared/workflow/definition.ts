/** The existing Flow v1 shape remains the definition source; this wrapper pins it. */
import { z } from 'zod'
import {
  WORKFLOW_CONTRACT_VERSION, definitionRefSchema, workflowIdSchema,
  workflowJsonSchema, workflowScopeIdentity, workflowNodeIdentity,
  type DefinitionRef, type WorkflowJson
} from './identity'
import {
  agentRoleRevisionSchema, contextManifestSchema, executorBindingSchema,
  workflowCommandSchema, type ContextManifest, type ExecutorBinding, type WorkflowCommand
} from './contracts'
import { workflowDigestSchema } from './identity'
import type { FlowDef } from '../types'
export { portableWorkflowDefinitionSchema, portableWorkflowNodeSchema, portableOutputSchema, executionStageSchema, type PortableWorkflowDefinition } from './portable-definition'

const commonStep = { id: workflowIdSchema, name: z.string().min(1) }
const agentStepSchema = z.object({
  ...commonStep, kind: z.literal('agent'), persona: z.string().optional(), instruction: z.string(),
  tools: z.array(workflowIdSchema).optional(), maxRounds: z.number().int().positive().safe().optional(), saveOutputAs: workflowIdSchema.optional()
}).catchall(workflowJsonSchema)
const toolStepSchema = z.object({
  ...commonStep, kind: z.literal('tool'), tool: workflowIdSchema,
  args: z.record(z.string(), z.string()), saveOutputAs: workflowIdSchema.optional()
}).catchall(workflowJsonSchema)
const gateStepSchema = z.object({
  ...commonStep, kind: z.literal('gate'),
  check: z.object({ stepId: workflowIdSchema, contains: z.string().optional(), notContains: z.string().optional(), minLength: z.number().int().nonnegative().safe().optional() }).catchall(workflowJsonSchema),
  onFail: z.enum(['abort', 'continue', 'goto']), gotoStepId: workflowIdSchema.optional(),
  feedbackTo: workflowIdSchema.optional(), maxRetries: z.number().int().nonnegative().safe().optional()
}).catchall(workflowJsonSchema)
export const legacyFlowStepSchema = z.discriminatedUnion('kind', [agentStepSchema, toolStepSchema, gateStepSchema])

export const legacyFlowSchema = z.object({
  version: z.literal(1), id: workflowIdSchema, name: z.string().min(1), description: z.string(),
  inputs: z.array(z.object({ name: workflowIdSchema, label: z.string(), description: z.string().optional(), required: z.boolean().optional(), default: z.string().optional() }).catchall(workflowJsonSchema)),
  phases: z.array(z.object({ id: workflowIdSchema, name: z.string().min(1), steps: z.array(legacyFlowStepSchema).min(1) }).catchall(workflowJsonSchema)).min(1),
  hooks: z.object({ onStart: z.string().optional(), onPhase: z.record(workflowIdSchema, z.string()).optional(), onComplete: z.object({ notify: z.boolean().optional(), saveNote: z.boolean().optional() }).catchall(workflowJsonSchema).optional() }).catchall(workflowJsonSchema).optional(),
  createdAt: z.number().int().nonnegative().safe().optional(), updatedAt: z.number().int().nonnegative().safe().optional()
}).catchall(workflowJsonSchema)

export const nodeBindingSchema = z.object({
  stepId: workflowIdSchema,
  role: agentRoleRevisionSchema.nullable(),
  executor: executorBindingSchema.optional(),
  requiredCapabilities: z.array(workflowIdSchema)
}).strict()
export const workflowDefinitionSchema = z.object({
  contractVersion: z.literal(WORKFLOW_CONTRACT_VERSION),
  ref: definitionRefSchema,
  flow: legacyFlowSchema,
  defaultExecutor: executorBindingSchema,
  nodeBindings: z.array(nodeBindingSchema),
  trellisPhases: z.record(workflowIdSchema, z.enum(['plan', 'implement', 'check', 'finish', 'custom']))
}).strict().superRefine((value, context) => {
  const phaseIds = new Set<string>(); const stepIds = new Set<string>(); const positions = new Map<string, number>()
  let position = 0
  value.flow.phases.forEach((phase, phaseIndex) => {
    if (phaseIds.has(phase.id)) context.addIssue({ code: 'custom', path: ['flow', 'phases', phaseIndex], message: 'Duplicate phase identity' })
    phaseIds.add(phase.id)
    phase.steps.forEach((step, stepIndex) => {
      if (stepIds.has(step.id)) context.addIssue({ code: 'custom', path: ['flow', 'phases', phaseIndex, 'steps', stepIndex], message: 'Duplicate step identity' })
      stepIds.add(step.id); positions.set(step.id, position++)
    })
  })
  const bound = new Set<string>()
  value.nodeBindings.forEach((binding, index) => {
    if (!stepIds.has(binding.stepId) || bound.has(binding.stepId)) context.addIssue({ code: 'custom', path: ['nodeBindings', index], message: 'Unknown or duplicate node binding' })
    bound.add(binding.stepId)
    if (new Set(binding.requiredCapabilities).size !== binding.requiredCapabilities.length) context.addIssue({ code: 'custom', path: ['nodeBindings', index], message: 'Duplicate capability requirement' })
  })
  Object.keys(value.trellisPhases).forEach((id) => {
    if (!phaseIds.has(id)) context.addIssue({ code: 'custom', path: ['trellisPhases', id], message: 'Unknown Trellis phase mapping' })
  })
  const inputs = new Set<string>()
  value.flow.inputs.forEach((input, index) => {
    if (inputs.has(input.name)) context.addIssue({ code: 'custom', path: ['flow', 'inputs', index], message: 'Duplicate input name' })
    inputs.add(input.name)
  })
  value.flow.phases.forEach((phase, phaseIndex) => phase.steps.forEach((step, stepIndex) => {
    if (step.kind !== 'gate') return
    const ownPosition = positions.get(step.id); const checkPosition = positions.get(step.check.stepId)
    if (ownPosition === undefined || checkPosition === undefined || checkPosition >= ownPosition) context.addIssue({ code: 'custom', path: ['flow', 'phases', phaseIndex, 'steps', stepIndex, 'check'], message: 'Gate must check an earlier step' })
    if (step.onFail === 'goto') {
      const targetPosition = step.gotoStepId ? positions.get(step.gotoStepId) : undefined
      if (targetPosition === undefined || ownPosition === undefined || targetPosition >= ownPosition) context.addIssue({ code: 'custom', path: ['flow', 'phases', phaseIndex, 'steps', stepIndex, 'gotoStepId'], message: 'Retry must target an earlier step' })
    }
    if (step.feedbackTo && !stepIds.has(step.feedbackTo)) context.addIssue({ code: 'custom', path: ['flow', 'phases', phaseIndex, 'steps', stepIndex, 'feedbackTo'], message: 'Unknown feedback target' })
  }))
})
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>
export type WorkflowNodeBinding = z.infer<typeof nodeBindingSchema>
export type LegacyFlow = z.infer<typeof legacyFlowSchema>

export const workflowLayoutSchema = z.object({
  nodes: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite(), collapsed: z.boolean().optional() }).strict())
}).strict()
export type WorkflowLayout = z.infer<typeof workflowLayoutSchema>

export const workflowPlanNodeSchema = z.object({
  nodeId: z.string().min(1).max(4096), phaseId: workflowIdSchema, stepId: workflowIdSchema,
  trellisPhase: z.enum(['plan', 'implement', 'check', 'finish', 'custom']),
  step: legacyFlowStepSchema, executor: executorBindingSchema,
  executorSelection: z.enum(['inherited', 'override']), role: agentRoleRevisionSchema.nullable()
}).strict().superRefine((value, context) => {
  if (value.stepId !== value.step.id) context.addIssue({ code: 'custom', path: ['stepId'], message: 'Plan step identity differs from source definition' })
})
export type WorkflowPlanNode = z.infer<typeof workflowPlanNodeSchema>
export type WorkflowPlanEdge = { edgeId: string; from: string; to: string; kind: 'sequence' | 'retry' | 'feedback' | 'check'; maxRetries?: number }
export type CompiledWorkflow = {
  contractVersion: 1
  definition: DefinitionRef
  inputFingerprint: string
  reuseEligible: boolean
  plan: { nodes: WorkflowPlanNode[]; edges: WorkflowPlanEdge[]; inputs: LegacyFlow['inputs']; hooks: LegacyFlow['hooks'] }
  graph: { nodes: Array<{ nodeId: string; phaseId: string; label: string; kind: 'agent' | 'tool' | 'gate' }>; edges: WorkflowPlanEdge[]; layout: WorkflowLayout }
}
export type WorkflowDigestPort = (canonicalJson: string) => string | Promise<string>

export class WorkflowContractError extends Error {
  constructor(public readonly code: 'CAPABILITY_UNAVAILABLE' | 'IDENTITY_CONFLICT' | 'INVALID_LAYOUT' | 'COMMAND_PAYLOAD_CONFLICT', message: string) {
    super(message)
    this.name = 'WorkflowContractError'
  }
}

/** No Node/browser dependency; callers supply their platform's SHA-256 adapter. */
export function canonicalWorkflowJson(raw: unknown): string {
  const value = workflowJsonSchema.parse(raw)
  function canonical(item: WorkflowJson): string {
    if (Array.isArray(item)) return '[' + item.map(canonical).join(',') + ']'
    if (item !== null && typeof item === 'object') return '{' + Object.keys(item).sort().map((key) => JSON.stringify(key) + ':' + canonical(item[key])).join(',') + '}'
    return JSON.stringify(item)
  }
  return canonical(value)
}

function plainJson(value: unknown): WorkflowJson {
  return workflowJsonSchema.parse(JSON.parse(JSON.stringify(value)))
}

/** Verify intent bytes before a later durable coordinator performs admission/CAS. */
export async function verifyWorkflowCommand(raw: unknown, digest: WorkflowDigestPort): Promise<WorkflowCommand> {
  const command = workflowCommandSchema.parse(raw)
  const actual = workflowDigestSchema.parse(await digest(canonicalWorkflowJson(command.payload)))
  if (actual !== command.payloadDigest) throw new WorkflowContractError('COMMAND_PAYLOAD_CONFLICT', 'Command payload does not match its full digest')
  return command
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach((child: unknown) => freezeValue(child))
  }
  return value
}

/** Pure normalization/projection only. This function never schedules or executes a step. */
export async function compileWorkflowDefinition(raw: unknown, rawContext: unknown, digest: WorkflowDigestPort, rawLayout: unknown = { nodes: {} }): Promise<CompiledWorkflow> {
  const definition = workflowDefinitionSchema.parse(raw)
  const context: ContextManifest = contextManifestSchema.parse(rawContext)
  const layout = workflowLayoutSchema.parse(rawLayout)
  const nodes: WorkflowPlanNode[] = []
  const edges: WorkflowPlanEdge[] = []
  const bindings = new Map(definition.nodeBindings.map((binding) => [binding.stepId, binding]))
  const steps = new Map<string, string>()
  const executors = new Map<string, string>()
  const roles = new Map<string, string>()
  const assetDigests = new Map<string, string>()
  function rememberAsset(ref: z.infer<typeof agentRoleRevisionSchema>['ref']): void {
    const key = JSON.stringify([ref.assetId, ref.version]); const previous = assetDigests.get(key)
    if (previous !== undefined && previous !== ref.digest) throw new WorkflowContractError('IDENTITY_CONFLICT', 'Immutable asset version has conflicting digests')
    assetDigests.set(key, ref.digest)
  }
  function rememberExecutor(executor: ExecutorBinding): void {
    const identity = canonicalWorkflowJson(executor)
    const previous = executors.get(executor.bindingId)
    if (previous !== undefined && previous !== identity) throw new WorkflowContractError('IDENTITY_CONFLICT', 'Executor binding identity has conflicting versions or capabilities')
    executors.set(executor.bindingId, identity)
    rememberAsset(executor.configuration)
  }
  rememberAsset(context.outputContract)
  if (context.engineeringBaseline) rememberAsset(context.engineeringBaseline)
  rememberExecutor(definition.defaultExecutor)
  for (const phase of definition.flow.phases) {
    for (const step of phase.steps) {
      const binding = bindings.get(step.id)
      const executor = binding?.executor ?? definition.defaultExecutor
      rememberExecutor(executor)
      if (binding?.role) {
        const roleKey = JSON.stringify([binding.role.ref.assetId, binding.role.ref.version])
        const previousRole = roles.get(roleKey); const snapshot = canonicalWorkflowJson(binding.role)
        if (previousRole !== undefined && previousRole !== snapshot) throw new WorkflowContractError('IDENTITY_CONFLICT', 'Role identity/version has conflicting snapshots')
        roles.set(roleKey, snapshot)
        rememberAsset(binding.role.ref)
        binding.role.methods.forEach(rememberAsset)
      }
      for (const capability of binding?.requiredCapabilities ?? []) {
        if (executor.capabilities[capability]?.status !== 'supported') throw new WorkflowContractError('CAPABILITY_UNAVAILABLE', `Executor ${executor.bindingId} does not establish capability ${capability}`)
      }
      const nodeId = workflowNodeIdentity(definition.ref, phase.id, step.id)
      const previous = nodes.at(-1)
      if (previous) edges.push({ edgeId: JSON.stringify(['sequence', previous.nodeId, nodeId]), from: previous.nodeId, to: nodeId, kind: 'sequence' })
      nodes.push({ nodeId, phaseId: phase.id, stepId: step.id, trellisPhase: definition.trellisPhases[phase.id] ?? 'custom', step, executor, executorSelection: binding?.executor ? 'override' : 'inherited', role: binding?.role ?? null })
      steps.set(step.id, nodeId)
    }
  }
  for (const node of nodes) {
    if (node.step.kind !== 'gate') continue
    const gate = node.step
    const checked = steps.get(gate.check.stepId)
    if (checked) edges.push({ edgeId: JSON.stringify(['check', checked, node.nodeId]), from: checked, to: node.nodeId, kind: 'check' })
    if (gate.onFail === 'goto' && gate.gotoStepId) {
      const target = steps.get(gate.gotoStepId)
      if (target) edges.push({ edgeId: JSON.stringify(['retry', node.nodeId, target]), from: node.nodeId, to: target, kind: 'retry', maxRetries: gate.maxRetries ?? 1 })
    }
    const feedbackTo = gate.onFail === 'goto' ? gate.feedbackTo ?? gate.gotoStepId : undefined
    if (feedbackTo) {
      const target = steps.get(feedbackTo)
      if (target) edges.push({ edgeId: JSON.stringify(['feedback', node.nodeId, target]), from: node.nodeId, to: target, kind: 'feedback' })
    }
  }
  const knownNodes = new Set(nodes.map((node) => node.nodeId))
  if (Object.keys(layout.nodes).some((id) => !knownNodes.has(id))) throw new WorkflowContractError('INVALID_LAYOUT', 'Layout contains a node from another definition/revision')
  // Flow timestamps are persistence metadata. Inputs/hooks, role/engine snapshots and all
  // effective step configuration are included; only separate layout is excluded.
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...flow } = definition.flow
  const fingerprintPayload = plainJson({ contractVersion: WORKFLOW_CONTRACT_VERSION, definition: { ...definition, flow }, scopeIdentity: workflowScopeIdentity(context.scope), context, plan: { nodes, edges } })
  const inputFingerprint = workflowDigestSchema.parse(await digest(canonicalWorkflowJson(fingerprintPayload)))
  const result: CompiledWorkflow = {
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    definition: definition.ref,
    inputFingerprint,
    reuseEligible: context.complete && context.engineeringBaseline !== null && context.materials.every((entry) => entry.inclusion === 'full' || entry.inclusion === 'truncated'),
    plan: { nodes, edges, inputs: definition.flow.inputs, hooks: definition.flow.hooks },
    graph: { nodes: nodes.map((node) => ({ nodeId: node.nodeId, phaseId: node.phaseId, label: node.step.name, kind: node.step.kind })), edges: edges.map((edge) => ({ ...edge })), layout }
  }
  return freezeValue(result)
}

/** Compile-time compatibility check against the existing application's FlowDef. */
export function readLegacyFlow(raw: unknown): FlowDef {
  return legacyFlowSchema.parse(raw)
}
