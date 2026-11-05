/** Read-only clean-room adapters; never rewrite legacy files or infer business success. */
import { z } from 'zod'
import { localTaskRefSchema, workflowIdSchema, workflowJsonSchema, type LocalTaskRef, type WorkflowJson } from './identity'
import { legacyFlowSchema, workflowDefinitionSchema, type WorkflowDefinition } from './definition'
import { executorBindingSchema, type ExecutorBinding } from './contracts'
import { definitionRefSchema, type DefinitionRef } from './identity'
import { portableWorkflowDefinitionSchema, type PortableWorkflowDefinition } from './portable-definition'

export const legacyTaskRecordSchema = z.object({ id: workflowIdSchema, status: z.string() }).catchall(workflowJsonSchema)
export type LegacyTaskSnapshot = { localTask: LocalTaskRef; trellisTaskId: string; localStatus: string; original: WorkflowJson }

export function snapshotLegacyTask(raw: unknown, verifiedLocalTask: LocalTaskRef): LegacyTaskSnapshot {
  const record = legacyTaskRecordSchema.parse(raw)
  return {
    localTask: localTaskRefSchema.parse(verifiedLocalTask),
    trellisTaskId: record.id,
    localStatus: record.status,
    original: workflowJsonSchema.parse(JSON.parse(JSON.stringify(record)))
  }
}

export type LegacyFlowAdaptation =
  | { ok: true; definition: WorkflowDefinition; original: WorkflowJson }
  | { ok: false; code: 'UNSUPPORTED_LEGACY_FLOW'; issues: string[]; original: WorkflowJson }

/** The supplied version/scope/executor are verified by the application boundary, never guessed. */
export function adaptLegacyFlow(raw: unknown, ref: DefinitionRef, executor: ExecutorBinding): LegacyFlowAdaptation {
  const original = workflowJsonSchema.parse(JSON.parse(JSON.stringify(workflowJsonSchema.parse(raw))))
  const parsed = legacyFlowSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'UNSUPPORTED_LEGACY_FLOW', issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`), original }
  const result = workflowDefinitionSchema.safeParse({ contractVersion: 1, ref: definitionRefSchema.parse(ref), flow: parsed.data, defaultExecutor: executorBindingSchema.parse(executor), nodeBindings: [], trellisPhases: {} })
  if (!result.success) return { ok: false, code: 'UNSUPPORTED_LEGACY_FLOW', issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`), original }
  return { ok: true, definition: result.data, original }
}

export type PortableLegacyFlowAdaptation =
  | { ok: true; definition: PortableWorkflowDefinition; original: WorkflowJson }
  | { ok: false; code: 'UNSUPPORTED_LEGACY_FLOW'; issues: string[]; original: WorkflowJson }

/** Explicit logical mapping; no local executor/profile/path is copied into the publication. */
export function adaptLegacyFlowToPortable(raw: unknown, mapping: {
  definitionId: string; revision: number; roles: PortableWorkflowDefinition['roles'];
  phases: Record<string, Extract<PortableWorkflowDefinition['nodes'][number], { kind: 'agent' }>['stage']>;
  nodeRoles: Record<string, string>; capabilities: Record<string, string[]>;
  outputs: Record<string, Extract<PortableWorkflowDefinition['nodes'][number], { kind: 'agent' }>['outputs']>
}): PortableLegacyFlowAdaptation {
  const original = workflowJsonSchema.parse(JSON.parse(JSON.stringify(workflowJsonSchema.parse(raw))))
  const parsed = legacyFlowSchema.safeParse(raw), issues: string[] = []
  const unsupported = (): PortableLegacyFlowAdaptation => ({ ok: false, code: 'UNSUPPORTED_LEGACY_FLOW', issues, original })
  if (!parsed.success) { issues.push(...parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)); return unsupported() }
  const flow = parsed.data
  const unknown = (value: object, allowed: string[], owner: string): void => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${owner}: unsupported field ${key}`)
  }
  unknown(flow, ['version', 'id', 'name', 'description', 'inputs', 'phases', 'hooks', 'createdAt', 'updatedAt'], 'flow')
  if (flow.inputs.length) issues.push('flow: parameterized inputs need an explicit resolver before portable conversion')
  if (flow.hooks) {
    unknown(flow.hooks, ['onComplete'], 'hooks')
    if (flow.hooks.onComplete) {
      unknown(flow.hooks.onComplete, ['notify', 'saveNote'], 'onComplete')
      if (flow.hooks.onComplete.notify || flow.hooks.onComplete.saveNote) issues.push('onComplete: effects need their owning adapter')
    }
  }
  const nodes: PortableWorkflowDefinition['nodes'] = []
  for (const phase of flow.phases) {
    unknown(phase, ['id', 'name', 'steps', 'trellisPhase'], `phase ${phase.id}`)
    const stage = mapping.phases[phase.id]
    if (!stage) { issues.push(`phase ${phase.id}: explicit stage mapping required`); continue }
    for (const step of phase.steps) {
      const common = { id: step.id, phaseId: phase.id, stage, name: step.name }
      if (step.kind === 'gate') {
        unknown(step, ['id', 'name', 'kind', 'check', 'onFail', 'gotoStepId', 'feedbackTo', 'maxRetries'], `gate ${step.id}`)
        unknown(step.check, ['stepId', 'contains', 'notContains', 'minLength'], `gate ${step.id} check`)
        const outputs = mapping.outputs[step.check.stepId]
        if (outputs?.length !== 1) { issues.push(`gate ${step.id}: map the checked step to one explicit output`); continue }
        const { stepId, ...check } = step.check
        nodes.push({ ...common, kind: 'gate', check: { nodeId: stepId, outputId: outputs[0].id, ...check }, onFail: step.onFail,
          ...(step.gotoStepId !== undefined ? { gotoNodeId: step.gotoStepId } : {}), ...(step.feedbackTo !== undefined ? { feedbackTo: step.feedbackTo } : {}), ...(step.maxRetries !== undefined ? { maxRetries: step.maxRetries } : {}) })
      } else {
        const outputs = mapping.outputs[step.id], requiredCapabilities = mapping.capabilities[step.id]
        if (!outputs || !requiredCapabilities || step.saveOutputAs !== undefined && !outputs.some(output => output.id === step.saveOutputAs)) { issues.push(`node ${step.id}: explicit capabilities and matching output policy required`); continue }
        if (step.kind === 'tool') {
          unknown(step, ['id', 'name', 'kind', 'tool', 'args', 'saveOutputAs'], `tool ${step.id}`)
          nodes.push({ ...common, kind: 'tool', tool: step.tool, args: step.args, requiredCapabilities, outputs })
        } else {
          unknown(step, ['id', 'name', 'kind', 'instruction', 'persona', 'tools', 'maxRounds', 'saveOutputAs'], `agent ${step.id}`)
          const roleId = mapping.nodeRoles[step.id]
          if (!roleId || step.maxRounds !== undefined || step.tools !== undefined) { issues.push(`agent ${step.id}: explicit role required; native maxRounds/tool restrictions need an enforcing adapter`); continue }
          nodes.push({ ...common, kind: 'agent', roleId, instruction: step.instruction, requiredCapabilities, outputs })
        }
      }
    }
  }
  if (issues.length) return unsupported()
  const result = portableWorkflowDefinitionSchema.safeParse({ contractVersion: 2, definitionId: mapping.definitionId, revision: mapping.revision, name: flow.name, roles: mapping.roles, nodes })
  if (!result.success) { issues.push(...result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)); return unsupported() }
  return { ok: true, definition: result.data, original }
}
