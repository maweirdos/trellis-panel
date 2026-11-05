import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { legacyFlowSchema, workflowDefinitionSchema, canonicalWorkflowJson, executorBindingSchema, capabilityFactSchema, type WorkflowDefinition } from '../../../shared/workflow'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { WorkflowApplicationError, type ApplicationNodePolicy, type ResolvedApplicationDefinition, type VerifiedApplicationExecutor } from './types'
import { z } from 'zod'
import { portableWorkflowDefinitionSchema, type PortableWorkflowDefinition } from '../../../shared/workflow/portable-definition'
import { executionInputViewSchema, executionInputDigestText, type ExecutionInputSource } from '../../../shared/team-execution-input'
import { taskInputCanonical } from '../../../shared/team-task-inputs'

export interface PortableDefinitionSource {
  read(): Promise<PortableWorkflowDefinition>
  assertCurrent(): void | Promise<void>
}
/** Device-local resolution input. None of these fields belongs in the published definition. */
export const portableExecutorConfigurationSchema = z.object({ runtime: z.enum(['pi', 'codex', 'claude']),
  agentId: z.string().min(1).max(256), profileId: z.string().min(1).max(256).optional(), modelId: z.string().min(1).max(512).nullable().optional(), binding: executorBindingSchema }).strict()
export type ResolvedPortableDefinition = { definition: PortableWorkflowDefinition;
  nodes: Record<string, { configuration: z.infer<typeof portableExecutorConfigurationSchema>; requiredCapabilities: string[] }>;
  assertCurrent(): Promise<void>; assertExecutionCurrent(): void }

function freezePortableValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    Object.values(value).forEach(child => freezePortableValue(child))
  }
  return value
}

/** Reads the exact adopted version rather than a local Flow or a current publication head. */
export function executionDefinitionSource(source: ExecutionInputSource): PortableDefinitionSource {
  let pinned: string | undefined
  const read = async (): Promise<PortableWorkflowDefinition> => {
    const view = executionInputViewSchema.parse(await source.read())
    if (view.purpose !== 'use' || createHash('sha256').update(executionInputDigestText(view.input)).digest('hex') !== view.input.digest) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'Fixed workflow source is not authorized execution input')
    if (pinned !== undefined && pinned !== view.input.digest) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'Execution input changed; resolve a new boundary explicitly')
    pinned = view.input.digest
    return portableWorkflowDefinitionSchema.parse(view.input.definition)
  }
  return { read, assertCurrent: async () => { await read() } }
}

/** Capability resolution only; this function never launches or schedules a node. */
export async function resolvePortableApplicationDefinition(input: { source: PortableDefinitionSource;
  roles: Record<string, z.input<typeof portableExecutorConfigurationSchema>>; toolCapabilities?: Record<string, z.infer<typeof executorBindingSchema>['capabilities']>;
  assertExecutionCurrent(): void }): Promise<ResolvedPortableDefinition> {
  const assertExecutionCurrent = input.assertExecutionCurrent
  const source = { read: input.source.read.bind(input.source), assertCurrent: input.source.assertCurrent.bind(input.source) }
  // Capture device-local choices before the first source wait; caller mutations
  // cannot retarget an in-flight resolution or its later authority checks.
  const roles = structuredClone(input.roles), toolCapabilities = structuredClone(input.toolCapabilities ?? {})
  const definition = portableWorkflowDefinitionSchema.parse(await source.read()), nodes: ResolvedPortableDefinition['nodes'] = Object.create(null)
  const requireCapabilities = (required: string[], facts: z.infer<typeof executorBindingSchema>['capabilities']): void => {
    for (const capability of required) {
      const fact = capabilityFactSchema.safeParse(facts[capability])
      if (!fact.success || fact.data.status !== 'supported') throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `Required adapter capability is unavailable: ${capability}`)
    }
  }
  for (const node of definition.nodes) {
    if (node.kind === 'gate') continue
    if (node.kind === 'tool') {
      requireCapabilities([`tool:${node.tool}`, ...node.requiredCapabilities], Object.hasOwn(toolCapabilities, node.id) ? toolCapabilities[node.id] : {})
      continue
    }
    const role = definition.roles.find(item => item.id === node.roleId), raw = Object.hasOwn(roles, node.roleId) ? roles[node.roleId] : undefined
    if (!role || !raw) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `No local configuration for logical role ${node.roleId}`)
    const configuration = portableExecutorConfigurationSchema.parse(raw)
    if (configuration.agentId !== configuration.runtime || configuration.binding.engineId !== configuration.agentId) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'Local runtime and verified executor identity differ')
    const requiredCapabilities = [...new Set([configuration.runtime === 'pi' ? 'sdkContext' : 'embeddedContext', ...role.requiredCapabilities, ...node.requiredCapabilities])]
    requireCapabilities(requiredCapabilities, configuration.binding.capabilities)
    nodes[node.id] = { configuration, requiredCapabilities }
  }
  const identity = taskInputCanonical(definition)
  await source.assertCurrent(); assertExecutionCurrent()
  return freezePortableValue({ definition, nodes, assertExecutionCurrent, assertCurrent: async () => {
    await source.assertCurrent()
    if (taskInputCanonical(portableWorkflowDefinitionSchema.parse(await source.read())) !== identity) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'Portable workflow changed after resolution')
    assertExecutionCurrent()
  } })
}

/** Reads the existing Flow source; output policies remain explicit main configuration. */
export async function readLocalApplicationDefinition(input: {
  projectRoot: string; flowId: string; executor: VerifiedApplicationExecutor;
  nodes: Record<string, Omit<ApplicationNodePolicy, 'agentId' | 'profileId'>>;
  assertExecutor?: () => void
}): Promise<ResolvedApplicationDefinition> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.flowId)) throw new WorkflowApplicationError('INVALID_INPUT', 'Flow identity is not a valid local file key')
  const relativePath = `.trellis/flows/${input.flowId}.flow.json`
  const read = async (): Promise<string> => {
    const path = resolveAuthorizedDocumentPath(input.projectRoot, relativePath)
    if (!path.ok || !path.exists) throw new WorkflowApplicationError('NOT_FOUND', 'The selected local Flow source is unavailable')
    const st = await fs.stat(path.canonicalPath)
    if (!st.isFile() || st.size > 512 * 1024) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'The local Flow source exceeds its document budget')
    const bytes = await fs.readFile(path.canonicalPath, 'utf8')
    if (Buffer.byteLength(bytes, 'utf8') > 512 * 1024) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'The local Flow source grew beyond its document budget')
    return bytes
  }
  const bytes = await read()
  const flow = legacyFlowSchema.parse(JSON.parse(bytes))
  if (flow.id !== input.flowId) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Flow file and declared identity disagree')
  const hash = (s: string): string => createHash('sha256').update(s).digest('hex')
  const sourceDigest = hash(bytes)
  const semanticDigest = hash(canonicalWorkflowJson(flow))
  const defaultExecutor = executorBindingSchema.parse(input.executor.binding)
  const definition: WorkflowDefinition = workflowDefinitionSchema.parse({
    contractVersion: 1, ref: { definitionId: `${flow.id}:${semanticDigest}`, revision: 1 },
    flow, defaultExecutor, nodeBindings: [], trellisPhases: Object.fromEntries(flow.phases.map((phase) => {
      const explicit = phase.trellisPhase
      return [phase.id, ['plan', 'implement', 'check', 'finish'].includes(String(explicit)) ? explicit : 'custom']
    }))
  })
  const nodes: ResolvedApplicationDefinition['nodes'] = {}
  for (const phase of definition.flow.phases) for (const step of phase.steps) {
    const policy = input.nodes[step.id]
    if (step.kind === 'agent' && !policy) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `Step ${step.id} has no main-verified output contract`)
    if (policy) nodes[step.id] = {
      ...policy, agentId: input.executor.agentId, ...(input.executor.profileId ? { profileId: input.executor.profileId } : {}),
      // Pin configuration values at resolution, just like the parsed definition.
      // Retaining nested caller objects can silently change accepted output paths
      // or contracts while a revision waits for its boundary. Validator functions
      // stay main-owned; actual executor drift is still checked independently.
      output: { ...policy.output, contract: { ...policy.output.contract }, files: policy.output.files.map((file) => ({ ...file })) },
      ...(policy.nativeTask ? { nativeTask: { ...policy.nativeTask } } : {})
    }
  }
  return { definition, nodes, assertExecutionCurrent: () => input.assertExecutor?.(), assertCurrent: async () => {
    if (hash(await read()) !== sourceDigest) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'Flow source changed after preview; create a new preview')
    await input.assertExecutor?.()
  } }
}
