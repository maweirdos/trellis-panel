import { randomUUID as cryptoId } from 'node:crypto'
import type { HifoxWorkLocal, HifoxWorkQuery } from '../../../shared/hifox-work'
import { applicationTaskScopeSchema, applicationTaskVerifyRequestSchema, applicationTaskStartRequestSchema, applicationTaskReuseRequestSchema, applicationTaskDetachRequestSchema,
  type ApplicationTaskScope, type ApplicationTaskPlanResult, type ApplicationTaskPlan, type ApplicationTaskUseResult, type ApplicationTaskVerifyRequest, type ApplicationTaskStartRequest, type ApplicationTaskReuseRequest, type ApplicationTaskDetachRequest } from '../../../shared/app-task-runtime'
import type { ApplicationLaunchPreview } from '../../../shared/app-runtime'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { gitWorkspace } from '../git-workspace'
import { resolveWorkcopy } from '../workcopy-use'
import { taskDevelopmentKey } from '../hifox/task-development-identity'
import { HifoxWorkError } from '../hifox/task-workspace-source'
import { canonicalDirectory } from './lib/persistence'
import { ApplicationRuntime } from './lib/controller'
import { AppRuntimeError, runtimeFailure, type ApplicationTaskReferenceOwner, type ApplicationTaskLaunchGuard, type ApplicationLaunchInspection } from './types'

export type ResolvedApplicationTaskContext = {
  local: HifoxWorkLocal
  spaceId: string; ownerId: string; resourceId: string | null
  authority?: string; selectionGeneration?: number; taskKey?: string
}
export type ApplicationTaskContextResolver = (query: HifoxWorkQuery, expected: ApplicationTaskScope['expected']) => Promise<ResolvedApplicationTaskContext>
type NativeContext = { resolved: ResolvedApplicationTaskContext; root: string; workcopyId: string; owner: ApplicationTaskReferenceOwner; assertCurrent: () => Promise<void> }
export type TaskApplicationService = ReturnType<typeof createTaskApplicationService>

/** Every operation starts from the original native binding, independently of the browsing project. */
export function createTaskApplicationService({ runtime, resolveTaskContext }: { runtime: ApplicationRuntime; resolveTaskContext: ApplicationTaskContextResolver }): {
  plan(input: ApplicationTaskScope): Promise<ApplicationTaskPlanResult>
  verifyEnvironment(input: ApplicationTaskVerifyRequest, confirm: (inspection: ApplicationLaunchInspection) => Promise<boolean>): Promise<ApplicationTaskPlanResult>
  start(input: ApplicationTaskStartRequest, confirm: (preview: ApplicationLaunchPreview) => Promise<boolean>): Promise<ApplicationTaskUseResult>
  reuse(input: ApplicationTaskReuseRequest): Promise<ApplicationTaskUseResult>
  detach(input: ApplicationTaskDetachRequest): Promise<ApplicationTaskUseResult>
} {
  const resolve = async (input: ApplicationTaskScope): Promise<ResolvedApplicationTaskContext> => {
    try { return await resolveTaskContext(input.query, input.expected) }
    catch (error) { if (error instanceof HifoxWorkError) throw new AppRuntimeError(error.message, error.code, error.code === IpcErrorCode.Conflict ? 'PLAN_CHANGED' : undefined); throw error }
  }
  const context = async (input: ApplicationTaskScope): Promise<NativeContext> => {
    const resolved = await resolve(input)
    const development = resolved.local.development
    if (!development || development.contextId !== input.expected.contextId || development.generation !== input.expected.generation || resolved.local.archived) throw new AppRuntimeError('原开发上下文已失效，请回原任务重新核对', IpcErrorCode.Conflict)
    const root = canonicalDirectory(resolved.local.projectRoot), workcopy = resolveWorkcopy(root)
    if (!resolved.taskKey && input.query.workspaceKey !== 'local') throw new AppRuntimeError('团队任务缺少可信的服务世代身份，请回原任务核对', IpcErrorCode.Conflict)
    const taskKey = resolved.taskKey ?? taskDevelopmentKey({ workspaceKey: input.query.workspaceKey, actorId: resolved.ownerId, spaceId: resolved.spaceId, taskId: input.query.taskId, taskCreatedAt: development.taskCreatedAt })
    const owner: ApplicationTaskReferenceOwner = { taskKey, taskLabel: `${input.query.taskId} (${input.query.workspaceKey} / ${resolved.spaceId})`.slice(0, 500), bindingId: development.contextId,
      attemptId: `${development.contextId}:${development.generation}`, contextRevision: `${development.generation}:${development.inputVersion}` }
    const fence = (value: ResolvedApplicationTaskContext): string => JSON.stringify([value.ownerId, value.spaceId, value.resourceId, value.authority, value.selectionGeneration, value.taskKey, canonicalDirectory(value.local.projectRoot), value.local.taskId, value.local.resourceBinding, value.local.development])
    const original = fence(resolved)
    const assertCurrent = async (): Promise<void> => {
      const current = await resolve(input)
      if (fence(current) !== original || current.local.archived) throw new AppRuntimeError('任务权限、材料或执行绑定已变化，请回原任务核对', IpcErrorCode.Conflict)
      const actual = resolveWorkcopy(root)
      if (actual.id !== workcopy.id || actual.revision !== workcopy.revision) throw new AppRuntimeError('工作副本、分支或 HEAD 已变化，请回原任务核对', IpcErrorCode.Conflict)
    }
    return { resolved, root, workcopyId: workcopy.id, owner, assertCurrent }
  }
  const guard = (ctx: NativeContext, input: ApplicationTaskStartRequest): ApplicationTaskLaunchGuard => ({ expectedPlanId: input.expectedPlanId, expectedCheckId: input.expectedCheckId, workcopyId: ctx.workcopyId })
  const inspect = async (ctx: NativeContext): Promise<ApplicationTaskPlanResult> => {
    const listed = await runtime.list(ctx.root)
    if (!listed.ok) return listed
    const git = await gitWorkspace.status(ctx.root)
    const gitFacts = git.ok ? { branch: git.snapshot.branch, head: git.snapshot.head, dirty: !git.snapshot.clean } : { branch: null, head: null, dirty: null }
    const plans: ApplicationTaskPlan[] = []
    for (const app of listed.apps) {
      try {
        const inspection = await runtime.inspectLaunch(ctx.root, app.definition.id)
        const sameCopy = inspection.workcopyId === ctx.workcopyId
        const verified = inspection.environment.status === 'verified'
        const reusable = sameCopy && verified ? await runtime.reusableTaskInstances(ctx.root, app.definition.id, { expectedPlanId: inspection.planId, expectedCheckId: inspection.environment.id, workcopyId: ctx.workcopyId }) : []
        const snapshot = inspection.snapshot
        if (snapshot.status === 'known' && snapshot.workcopy) snapshot.workcopy.dirty = gitFacts.dirty
        plans.push({ id: inspection.planId, app: inspection.app, snapshot, environment: inspection.environment, canVerify: sameCopy && inspection.canVerify,
          canStart: sameCopy && verified && inspection.app.canStart, reusable, git: gitFacts,
          ...(!sameCopy ? { blockedReason: '实际 cwd 属于其他工作副本，请在本人副本中修正配置' }
            : !verified ? { blockedReason: inspection.environment.reason ?? '环境待核实' } : {}) })
      } catch (error) {
        plans.push({ id: '', app, snapshot: { status: 'unknown', reason: 'legacy-record' }, environment: {
          version: 1, id: cryptoId(), status: 'unknown', method: null, checkedBy: null, checkedAt: null, configRevision: app.definition.revision,
          workcopyId: ctx.workcopyId, selection: app.definition.environment.selection, targets: [], reason: '实际启动输入无法读取' },
          canVerify: false, canStart: false, reusable: [], git: gitFacts, blockedReason: error instanceof AppRuntimeError ? error.message : '启动目录或环境无法核验，请检查本机配置' })
      }
    }
    const retained = await runtime.retainedTaskReferences(ctx.owner.taskKey)
    await ctx.assertCurrent()
    return { ok: true, root: ctx.root, taskKey: ctx.owner.taskKey, contextRevision: ctx.owner.contextRevision, plans, references: retained.references, referencesPartial: retained.partial }
  }
  const selected = async (ctx: NativeContext, input: ApplicationTaskVerifyRequest): Promise<void> => {
    const current = await runtime.inspectLaunch(ctx.root, input.appId)
    if (current.app.definition.revision !== input.expectedRevision || current.planId !== input.expectedPlanId) throw new AppRuntimeError('原配置或启动计划已变化，请重新读取', IpcErrorCode.Conflict, 'PLAN_CHANGED')
    if (current.workcopyId !== ctx.workcopyId) throw new AppRuntimeError('实际 cwd 属于其他工作副本，请修正配置', IpcErrorCode.Conflict, 'PLAN_CHANGED')
  }
  return {
    async plan(input) { try { return await inspect(await context(applicationTaskScopeSchema.parse(input))) } catch (error) { return runtimeFailure(error) } },
    async verifyEnvironment(input, confirm) {
      try {
        const parsed = applicationTaskVerifyRequestSchema.parse(input), ctx = await context(parsed)
        await selected(ctx, parsed)
        await runtime.verifyEnvironment(ctx.root, parsed.appId, parsed.expectedRevision, parsed.expectedPlanId, ctx.resolved.ownerId, confirm, ctx.assertCurrent)
        return await inspect(ctx)
      } catch (error) { return runtimeFailure(error) }
    },
    async start(input, confirm) {
      try {
        const parsed = applicationTaskStartRequestSchema.parse(input), ctx = await context(parsed)
        await selected(ctx, parsed)
        const result = await runtime.start(ctx.root, parsed.appId, { expectedRevision: parsed.expectedRevision, requireConfirmation: true, confirm,
          assertCurrent: ctx.assertCurrent, taskKey: ctx.owner.taskKey, taskOwner: ctx.owner, taskGuard: guard(ctx, parsed) })
        if (!result.ok) return result
        const reference = result.app.serviceUses?.find(use => use.taskKey === ctx.owner.taskKey && use.runId === result.app.run?.id && use.contextRevision === ctx.owner.contextRevision)
        if (!reference) throw new AppRuntimeError('实例已启动，但原任务引用尚未确认；请查看本机运行并核对', IpcErrorCode.Io)
        return { ok: true, reference, app: result.app }
      } catch (error) { return runtimeFailure(error) }
    },
    async reuse(input) {
      try {
        const parsed = applicationTaskReuseRequestSchema.parse(input), ctx = await context(parsed)
        await selected(ctx, parsed)
        if (parsed.target.root !== ctx.root || parsed.target.appId !== parsed.appId) throw new AppRuntimeError('原实例不属于当前任务的固定副本与应用', IpcErrorCode.Denied)
        return { ok: true, reference: await runtime.reuseTaskInstance(parsed.target, ctx.owner, guard(ctx, parsed), ctx.assertCurrent) }
      } catch (error) { return runtimeFailure(error) }
    },
    async detach(input) {
      try {
        const parsed = applicationTaskDetachRequestSchema.parse(input), ctx = await context(parsed)
        const retained = await runtime.retainedTaskReferences(ctx.owner.taskKey)
        const original = retained.references.find(reference => reference.id === parsed.referenceId)
        if (!original) throw new AppRuntimeError('原任务服务引用不可用，请重新读取本机记录', IpcErrorCode.NotFound)
        return { ok: true, detached: true, reference: await runtime.detachTaskReference(original.root, parsed.referenceId, ctx.owner, ctx.assertCurrent) }
      } catch (error) { return runtimeFailure(error) }
    }
  }
}
