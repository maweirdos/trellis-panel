import { z } from 'zod'
import { teamDigestSchema, teamIdSchema } from './team-platform'
import { teamTaskRefSchema } from './team-task-execution'
import { executionContextManifestSchema } from './team-execution-input'
import { workflowIdSchema } from './workflow/identity'

export const editorWorkflowProviderSchema = z.enum(['claude', 'codex'])
export const editorWorkflowRoleSchema = z.enum(['implement', 'check', 'research', 'finish'])
const nativeSessionId = z.string().min(1).max(512).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), 'Expected an exact native session identity')
const revision = z.number().int().nonnegative().safe()
export const editorWorkflowNodeMappingSchema = z.object({
  implement: workflowIdSchema.optional(), check: workflowIdSchema.optional(),
  research: workflowIdSchema.optional(), finish: workflowIdSchema.optional()
}).strict()
const selection = {
  connectionId: teamIdSchema, provider: editorWorkflowProviderSchema, nativeSessionId,
  task: teamTaskRefSchema, executionId: teamIdSchema, generation: z.number().int().positive().safe(),
  inputDigest: teamDigestSchema, rootNodeId: workflowIdSchema, roleNodeIds: editorWorkflowNodeMappingSchema
}
/** Local read selection only; execution and directory authority stay with their existing owners. */
export const editorWorkflowSessionBindSchema = z.object({ ...selection, expectedRevision: revision }).strict()
export const editorWorkflowSessionBindingSchema = z.object({ ...selection, bindingId: teamIdSchema, revision: revision.min(1) }).strict()
export const editorWorkflowHookContextSchema = z.object({
  provider: editorWorkflowProviderSchema, nativeSessionId,
  event: z.enum(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart']), role: editorWorkflowRoleSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.provider === 'claude' && value.event === 'SubagentStart' || value.provider === 'codex' && value.event === 'SessionStart') {
    context.addIssue({ code: 'custom', message: 'Unsupported provider Hook event' })
  }
  if ((value.event === 'SubagentStart' || value.event === 'PreToolUse') && !value.role) context.addIssue({ code: 'custom', message: 'SubagentStart and PreToolUse require an explicit mapped role and the parent native session identity' })
})
export const editorWorkflowUnavailableReasonSchema = z.enum([
  'not-bound', 'binding-conflict', 'binding-capacity', 'binding-changed', 'authority-changed',
  'execution-changed', 'role-unavailable', 'context-unavailable', 'invalid-request'
])
export const EDITOR_WORKFLOW_ERROR_CODES = {
  'not-bound': 'SESSION_UNBOUND', 'binding-conflict': 'SESSION_BINDING_CONFLICT', 'binding-capacity': 'SESSION_BINDING_CAPACITY',
  'binding-changed': 'SESSION_BINDING_CHANGED', 'authority-changed': 'SESSION_AUTHORITY_CHANGED',
  'execution-changed': 'SESSION_EXECUTION_CHANGED', 'role-unavailable': 'SESSION_ROLE_UNAVAILABLE',
  'context-unavailable': 'SESSION_CONTEXT_UNAVAILABLE', 'invalid-request': 'SESSION_INVALID_REQUEST'
} as const
export const editorWorkflowUnavailableSchema = z.object({ status: z.literal('unavailable'), reason: editorWorkflowUnavailableReasonSchema,
  code: z.enum(Object.values(EDITOR_WORKFLOW_ERROR_CODES)), message: z.string().min(1).max(1000) }).strict()
export const editorWorkflowHookReadySchema = editorWorkflowSessionBindingSchema.extend({
  status: z.literal('ready'), nodeId: workflowIdSchema, additionalContext: z.string().max(8192), contextManifest: executionContextManifestSchema
}).strict()
export type EditorWorkflowSessionBind = z.infer<typeof editorWorkflowSessionBindSchema>
export type EditorWorkflowSessionBinding = z.infer<typeof editorWorkflowSessionBindingSchema>
export type EditorWorkflowHookContext = z.infer<typeof editorWorkflowHookContextSchema>
export type EditorWorkflowUnavailableReason = z.infer<typeof editorWorkflowUnavailableReasonSchema>
