import { z } from 'zod'
import { cruxWorkQuerySchema, cruxDevelopmentRefSchema } from './crux-work'
import { applicationIdSchema, applicationInstanceTargetSchema, type ApplicationEnvironmentCheck, type ApplicationFailure, type ApplicationInstanceTarget, type ApplicationRunSnapshot, type ApplicationSummary, type ApplicationTaskServiceUse } from './app-runtime'

export const applicationTaskContextExpectedSchema = cruxDevelopmentRefSchema
export const applicationTaskScopeSchema = z.object({ query: cruxWorkQuerySchema, expected: applicationTaskContextExpectedSchema }).strict()
export const applicationTaskPlanRequestSchema = applicationTaskScopeSchema
export const applicationTaskVerifyRequestSchema = applicationTaskScopeSchema.extend({ appId: applicationIdSchema, expectedRevision: z.string().min(1).max(100), expectedPlanId: z.string().uuid() }).strict()
export const applicationTaskStartRequestSchema = applicationTaskVerifyRequestSchema.extend({ expectedCheckId: z.string().uuid() }).strict()
export const applicationTaskReuseRequestSchema = applicationTaskStartRequestSchema.extend({ target: applicationInstanceTargetSchema }).strict()
export const applicationTaskDetachRequestSchema = applicationTaskScopeSchema.extend({ referenceId: z.string().uuid() }).strict()
export type ApplicationTaskScope = z.infer<typeof applicationTaskScopeSchema>
export type ApplicationTaskVerifyRequest = z.infer<typeof applicationTaskVerifyRequestSchema>
export type ApplicationTaskStartRequest = z.infer<typeof applicationTaskStartRequestSchema>
export type ApplicationTaskReuseRequest = z.infer<typeof applicationTaskReuseRequestSchema>
export type ApplicationTaskDetachRequest = z.infer<typeof applicationTaskDetachRequestSchema>
export type ApplicationTaskPlan = {
  id: string; app: ApplicationSummary; snapshot: ApplicationRunSnapshot; environment: ApplicationEnvironmentCheck
  canVerify: boolean; canStart: boolean; blockedReason?: string; reusable: ApplicationInstanceTarget[]
  git: { branch: string | null; head: string | null; dirty: boolean | null }
}
export type ApplicationTaskPlanResult = { ok: true; root: string; taskKey: string; contextRevision: string; plans: ApplicationTaskPlan[]; references: ApplicationTaskServiceUse[]; referencesPartial?: boolean } | ApplicationFailure
export type ApplicationTaskUseResult = { ok: true; reference: ApplicationTaskServiceUse; detached?: boolean; app?: ApplicationSummary } | ApplicationFailure
export interface ApplicationTaskRuntimeApi {
  appRuntimeTaskPlan(input: ApplicationTaskScope): Promise<ApplicationTaskPlanResult>
  appRuntimeTaskVerify(input: ApplicationTaskVerifyRequest): Promise<ApplicationTaskPlanResult>
  appRuntimeTaskStart(input: ApplicationTaskStartRequest): Promise<ApplicationTaskUseResult>
  appRuntimeTaskReuse(input: ApplicationTaskReuseRequest): Promise<ApplicationTaskUseResult>
  appRuntimeTaskDetach(input: ApplicationTaskDetachRequest): Promise<ApplicationTaskUseResult>
}
