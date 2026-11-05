import { z } from 'zod'
import { workflowIdSchema } from './identity'

const ids = z.array(workflowIdSchema).max(32).refine(items => new Set(items).size === items.length, 'Duplicate identity')
export const executionStageSchema = z.enum(['plan', 'implement', 'check', 'finish', 'custom'])
export const portableOutputSchema = z.object({ id: workflowIdSchema, kind: z.enum(['prd', 'design', 'implement', 'delivery-note', 'implementation-report', 'check-report', 'general', 'source-patch', 'selected-file', 'creation-html']), required: z.boolean() }).strict()
const common = { id: workflowIdSchema, phaseId: workflowIdSchema, stage: executionStageSchema, name: z.string().min(1).max(300) }
export const portableWorkflowNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('agent'), roleId: workflowIdSchema, instruction: z.string().max(128 * 1024), requiredCapabilities: ids, outputs: z.array(portableOutputSchema).max(16) }).strict(),
  z.object({ ...common, kind: z.literal('tool'), tool: workflowIdSchema, args: z.record(workflowIdSchema, z.string().max(8192)), requiredCapabilities: ids, outputs: z.array(portableOutputSchema).max(16) }).strict(),
  z.object({ ...common, kind: z.literal('gate'), check: z.object({ nodeId: workflowIdSchema, outputId: workflowIdSchema, contains: z.string().max(8192).optional(), notContains: z.string().max(8192).optional(), minLength: z.number().int().nonnegative().safe().optional() }).strict(), onFail: z.enum(['abort', 'continue', 'goto']), gotoNodeId: workflowIdSchema.optional(), feedbackTo: workflowIdSchema.optional(), maxRetries: z.number().int().nonnegative().safe().optional() }).strict()
])
/** Version 2 is additive; the persisted local Flow/version-1 contract is unchanged. */
export const portableWorkflowDefinitionSchema = z.object({
  contractVersion: z.literal(2), definitionId: workflowIdSchema, revision: z.number().int().positive().safe(), name: z.string().min(1).max(300),
  roles: z.array(z.object({ id: workflowIdSchema, instructions: z.string().max(128 * 1024), requiredCapabilities: ids }).strict()).min(1).max(32),
  nodes: z.array(portableWorkflowNodeSchema).min(1).max(64)
}).strict().superRefine((value, ctx) => {
  const roles = new Set(value.roles.map(role => role.id)), nodes = new Set<string>()
  if (roles.size !== value.roles.length) ctx.addIssue({ code: 'custom', message: 'Duplicate logical role' })
  const completed = new Map<string, Set<string>>()
  for (const [index, node] of value.nodes.entries()) {
    if (nodes.has(node.id)) ctx.addIssue({ code: 'custom', path: ['nodes', index], message: 'Duplicate node' })
    nodes.add(node.id)
    if (node.kind !== 'gate') {
      if (node.kind === 'agent' && !roles.has(node.roleId)) ctx.addIssue({ code: 'custom', path: ['nodes', index], message: 'Unknown logical role' })
      const outputs = new Set(node.outputs.map(output => output.id))
      if (outputs.size !== node.outputs.length) ctx.addIssue({ code: 'custom', path: ['nodes', index], message: 'Duplicate output' })
      completed.set(node.id, outputs)
    } else {
      if (!completed.get(node.check.nodeId)?.has(node.check.outputId)) ctx.addIssue({ code: 'custom', path: ['nodes', index], message: 'Gate must check a declared earlier output' })
      if (node.onFail === 'goto' && (!node.gotoNodeId || node.gotoNodeId === node.id || !nodes.has(node.gotoNodeId))) ctx.addIssue({ code: 'custom', path: ['nodes', index], message: 'Retry must target an earlier node' })
      if (node.feedbackTo && !value.nodes.some(item => item.id === node.feedbackTo)) ctx.addIssue({ code: 'custom', path: ['nodes', index], message: 'Unknown feedback node' })
    }
  }
})
export type PortableWorkflowDefinition = z.infer<typeof portableWorkflowDefinitionSchema>
