import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { legacyFlowSchema, workflowDefinitionSchema, canonicalWorkflowJson, executorBindingSchema, type WorkflowDefinition } from '../../../shared/workflow'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { WorkflowApplicationError, type ApplicationNodePolicy, type ResolvedApplicationDefinition, type VerifiedApplicationExecutor } from './types'

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
