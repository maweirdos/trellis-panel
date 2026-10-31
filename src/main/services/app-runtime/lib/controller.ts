import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ApplicationConfig, ApplicationInstanceTarget, ApplicationInventoryInput, ApplicationInventoryResult, ApplicationInstanceSummary, ApplicationListResult, ApplicationLogsResult, ApplicationRestartProgress, ApplicationResult, ApplicationRuntimeEvent, ApplicationSummary, ApplicationSuccess } from '../../../../shared/app-runtime'
import { APP_RUNTIME_LIMITS, applicationConfigSchema, applicationIdSchema, applicationInstanceTargetSchema, applicationInventoryInputSchema, applicationRunIdSchema, applicationRunSnapshotSchema, applicationSaveSchema } from '../../../../shared/app-runtime'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { AppRuntimeError, runtimeFailure, runPolicySchema, type AppInstanceRestartOptions, type AppOperationOptions, type ProcessIdentity, type ProjectStore, type RunPolicy, type RuntimeEntry, type StoredApplication } from '../types'
import { canonicalDirectory, discoverProjects, listProjectRoots, projectFile, protect, readProject, writeProject } from './persistence'
import { planLaunch } from './launch'
import { captureRunSnapshot } from './snapshot'
import { checkPorts, diagnosePorts, probeOnce, validateReadiness } from './ports'
import { ownedTree, processSnapshot, sameProcess, spawnOwned, terminateOwned } from './process-tree'
import { boundedTail, outputRedactor } from './output'
import type { WorkcopyIdentity } from '../../../../shared/workcopy-use'
import { acquireWorkcopyUse, releaseWorkcopyUse, updateWorkcopyConsumerTasks, readWorkcopyConsumerLease, restrictWorkcopyConsumerTasks } from '../../workcopy-use/client'
import { resolveWorkcopy, assertWorkcopyObservation } from '../../workcopy-use'
import { ApplicationEnvironmentAuthority } from './environment-check'
import { applicationProcessContainer, prepareApplicationJob, recoverApplicationJob } from './contained-process'
import type { ApplicationTaskServiceUse, ApplicationReferenceDetachResult } from '../../../../shared/app-runtime'
import type { ApplicationLaunchInspection, ApplicationTaskLaunchGuard, ApplicationTaskReferenceOwner } from '../types'
import type { ApplicationWorkcopyUse } from '../types'
import { DaemonError } from '../../../daemon/errors'
import { gitWorkspace } from '../../git-workspace'

const ACTIVE_STATES = new Set(['starting', 'running', 'stopping', 'unknown', 'cleanup-required'])
interface ProjectEntries { store: ProjectStore; entries: Map<string, RuntimeEntry> }
interface RetainedOutput { root: string; appId: string; runId: string; output: string; outputBytes: number; cursor: number; outputTruncated: boolean }
export class ApplicationRuntime {
  private projects = new Map<string, Promise<ProjectEntries>>()
  private loaded = new Map<string, ProjectEntries>()
  private listeners = new Set<(event: ApplicationRuntimeEvent) => void>()
  private admissionClosed = false
  private observation?: { at: number; result: Promise<ProcessIdentity[]> }
  private retainedOutputs = new Map<string, RetainedOutput>()
  private instanceHandles = new Map<string, string>()
  private environments = new ApplicationEnvironmentAuthority()

  subscribe(listener: (event: ApplicationRuntimeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  closeAdmission(): void { this.admissionClosed = true }
  reopenAdmission(): void { this.admissionClosed = false }
  setAdmissionClosed(closed: boolean): void { this.admissionClosed = closed }
  ownedCount(): number { return [...this.loaded.values()].reduce((count, project) => count + [...project.entries.values()].filter((entry) => ACTIVE_STATES.has(entry.processState)).length, 0) }
  async hasOwnedApplications(): Promise<boolean> { await this.initialize(); return this.ownedCount() > 0 }
  async initialize(): Promise<void> { await Promise.all(listProjectRoots().map((root) => this.project(root))) }
  async knownProject(root: string): Promise<boolean> { try { return existsSync(projectFile(root)) && (await this.project(root)).store.root === canonicalDirectory(root) } catch { return false } }

  private async project(inputRoot: string): Promise<ProjectEntries> {
    if (typeof inputRoot !== 'string' || !inputRoot.trim()) throw new AppRuntimeError('需要明确的项目目录', IpcErrorCode.NoProject)
    const root = canonicalDirectory(inputRoot)
    let promise = this.projects.get(root)
    if (!promise) {
      promise = this.loadProject(root)
      this.projects.set(root, promise)
      void promise.catch(() => { if (this.projects.get(root) === promise) this.projects.delete(root) })
    }
    return promise
  }
  private async loadProject(root: string): Promise<ProjectEntries> {
    const store = readProject(root)
    const project: ProjectEntries = { store, entries: new Map() }
    let snapshot: ProcessIdentity[] | undefined
    for (const stored of store.applications) {
      const last = stored.lastRun
      // v1 forbade edits while active. Its cleanup policy is usable, but its launch
      // metadata was never recorded and must remain explicitly unknown.
      const runPolicy = last ? runPolicySchema.parse(last.policy ?? stored.config) : undefined
      const entry: RuntimeEntry = { stored, root, processState: last?.state ?? 'stopped', readiness: { state: 'unknown', checkedAt: null }, run: last ? { id: last.id, pid: last.pid, pidRole: last.pidRole, startedAt: last.startedAt, exitedAt: last.exitedAt, exitCode: last.exitCode, signal: last.signal, snapshot: last.snapshot } : null, runPolicy, ports: (runPolicy?.ports ?? stored.config.ports).map((port) => ({ ...port, state: 'unknown' })), identities: last?.identities ?? [], childClosed: true, rootExited: true, pendingApproval: false, output: '', outputBytes: 0, cursor: 0, outputTruncated: last !== undefined, queue: Promise.resolve(), stopping: false }
      entry.workcopy = last?.workcopy
      entry.container = last?.container
      if (last && ACTIVE_STATES.has(last.state) && !entry.workcopy) {
        const cwd = last.snapshot.status === 'known' ? last.snapshot.cwd : canonicalDirectory(resolve(root, stored.config.cwd))
        const lease = await acquireWorkcopyUse(cwd, { kind: 'consumer', owner: { kind: 'application', id: stored.config.id, generation: last.id, label: stored.config.name }, expected: resolveWorkcopy(cwd) })
        entry.workcopy = { root: cwd, lease }
        // Publish the original token before recovery performs process observations.
        stored.lastRun = { ...last, workcopy: entry.workcopy }
        writeProject({ ...store, schemaVersion: 2 })
      }
      if (last && ACTIVE_STATES.has(last.state)) {
        try {
          snapshot ??= await processSnapshot()
          const matches = last.identities.filter((identity) => snapshot?.some((row) => sameProcess(row, identity)))
          const ports = await checkPorts(runPolicy?.ports ?? stored.config.ports)
          entry.ports = ports
          if (matches.length > 0) { entry.identities = ownedTree(snapshot, last.pid ?? 0, matches); entry.processState = 'cleanup-required'; entry.lastError = '上次运行仍有已核验的应用进程，请先停止后再启动' }
          else if (!entry.workcopy && last.identities.length > 0 && ports.every((port) => port.state === 'available')) { entry.processState = 'exited'; if (entry.run) entry.run.exitedAt = Date.now(); entry.identities = []; entry.lastError = '上次运行已结束；异常退出期间的输出不可恢复' }
          else { entry.processState = 'unknown'; entry.lastError = '无法核验上次运行的完整归属，请核对进程与端口后重试停止' }
        } catch { entry.processState = 'unknown'; entry.lastError = '无法核验上次运行状态，请检查系统进程查询权限' }
      } else if ((runPolicy?.readiness ?? stored.config.readiness).kind === 'none') entry.readiness.state = 'not-configured'
      // A retained registration is not released by PID absence, elapsed time or view loading.
      if (entry.workcopy) {
        if (!last || entry.workcopy.lease.owner.generation !== last.id || entry.workcopy.lease.owner.id !== stored.config.id || entry.workcopy.lease.owner.kind !== 'application') throw new AppRuntimeError('原应用工作副本登记身份不一致，请核对原运行', IpcErrorCode.Conflict)
        entry.processState = 'cleanup-required'
        entry.lastError = '原工作副本仍有使用登记，请通过原实例核验并完成清理'
        await releaseWorkcopyUse(entry.workcopy.root, entry.workcopy.lease, 'unknown', 'GUI 连接已重新加载；原服务实际清理尚未确认。')
      }
      project.entries.set(stored.config.id, entry)
    }
    this.loaded.set(root, project)
    return project
  }
  private entry(project: ProjectEntries, id: string): RuntimeEntry {
    if (!applicationIdSchema.safeParse(id).success) throw new AppRuntimeError('应用标识无效', IpcErrorCode.InvalidArg)
    const entry = project.entries.get(id)
    if (!entry) throw new AppRuntimeError('应用不存在', IpcErrorCode.NotFound)
    return entry
  }
  private summary(entry: RuntimeEntry): ApplicationSummary {
    const active = ACTIVE_STATES.has(entry.processState)
    return { definition: { ...applicationConfigSchema.parse(entry.stored.config), revision: entry.stored.revision, updatedAt: entry.stored.updatedAt, overrideKeys: Object.keys(entry.stored.protectedOverrides) }, serviceUses: entry.stored.taskServiceUses.filter(use => use.runId === entry.run?.id).map(use => ({ ...use })), environmentCheck: entry.environmentCheck, runEnvironmentCheck: entry.runEnvironmentCheck, processState: entry.processState, readiness: { ...entry.readiness }, run: entry.run ? { ...entry.run, snapshot: applicationRunSnapshotSchema.parse(entry.run.snapshot) } : null, configChanged: entry.run ? entry.run.snapshot.status === 'known' ? entry.run.snapshot.configRevision !== entry.stored.revision : null : false, ports: entry.ports.map((port) => ({ ...port })), approval: entry.pendingApproval ? 'pending' : entry.stored.approvedFingerprint && entry.approvalCurrent === true ? 'approved' : 'required', ...(entry.lastError ? { lastError: entry.lastError } : {}), canStart: !active && !this.admissionClosed, canStop: active && entry.processState !== 'stopping', canRestart: !['unknown', 'cleanup-required', 'starting', 'stopping'].includes(entry.processState) && !this.admissionClosed }
  }
  private emit(entry: RuntimeEntry, kind: ApplicationRuntimeEvent['kind'], extra: Partial<ApplicationRuntimeEvent> = {}): void {
    const event: ApplicationRuntimeEvent = { kind, root: entry.root, appId: entry.stored.config.id, runId: entry.run?.id ?? null, app: this.summary(entry), ...extra }
    for (const listener of this.listeners) { try { listener(event) } catch { /* A UI observer cannot change process ownership. */ } }
  }
  private persist(project: ProjectEntries): void {
    const applications = [...project.entries.values()].map((entry) => {
      if (entry.run) entry.stored.lastRun = { ...entry.run, state: entry.processState, identities: entry.identities, policy: entry.runPolicy, workcopy: entry.workcopy, container: entry.container }
      return entry.stored
    })
    writeProject({ schemaVersion: 2, root: project.store.root, applications })
    project.store.applications = applications
  }
  private record(entry: RuntimeEntry, project: ProjectEntries): void {
    try { this.persist(project); entry.persistError = false }
    catch { entry.persistError = true; entry.lastError = '运行记录未保存，请检查本地数据目录权限并停止此运行'; this.emit(entry, 'state') }
  }
  private enqueue<T>(entry: RuntimeEntry, fn: () => Promise<T>): Promise<T> {
    const current = entry.queue.catch(() => undefined).then(fn)
    entry.queue = current.catch(() => undefined)
    return current
  }
  private checkAdmission(): void { if (this.admissionClosed) throw new AppRuntimeError('面板正在退出，暂不接受新的启动操作', IpcErrorCode.Denied, 'SHUTTING_DOWN') }
  private policy(entry: RuntimeEntry): RunPolicy { return entry.runPolicy ?? runPolicySchema.parse(entry.stored.config) }
  private observedPorts(entry: RuntimeEntry, ports: ApplicationSummary['ports']): ApplicationSummary['ports'] {
    return entry.container ? ports.map(port => port.state === 'external-conflict' ? { ...port, state: 'unknown', message: '端口在监听，进程尚未与原容器核对' } : port) : ports
  }
  private instanceKey(root: string, appId: string, runId: string): string { return JSON.stringify([root, appId, runId]) }
  private instanceTarget(entry: RuntimeEntry, runId: string): ApplicationInstanceTarget {
    const key = this.instanceKey(entry.root, entry.stored.config.id, runId)
    let handle = this.instanceHandles.get(key)
    if (!handle) { handle = randomUUID(); this.instanceHandles.set(key, handle) }
    return { handle, root: entry.root, appId: entry.stored.config.id, expectedRunId: runId }
  }

  private observeLaunch(entry: RuntimeEntry): { plan: ReturnType<typeof planLaunch>; workcopy: WorkcopyIdentity; inspection: ApplicationLaunchInspection } {
    const plan = planLaunch(entry.root, entry.stored)
    entry.approvalCurrent = entry.stored.approvedFingerprint === plan.fingerprint
    const workcopy = resolveWorkcopy(plan.cwd)
    const record = this.environments.observe(entry.root, entry.stored, plan, workcopy)
    entry.environmentCheck = { ...record.check, targets: record.check.targets.map(target => ({ ...target })) }
    entry.runEnvironmentCheck = record.check.status === 'verified' && entry.run && this.environments.matchesRun(entry.run.id, entry.stored, plan, workcopy) ? entry.environmentCheck : undefined
    const snapshot = captureRunSnapshot(entry.root, entry.stored, plan, record.planId, Date.now())
    if (snapshot.status === 'known') snapshot.environment = { ...snapshot.environment, status: record.check.status === 'verified' ? 'verified' : 'unverified', check: entry.environmentCheck }
    return { plan, workcopy, inspection: { planId: record.planId, app: this.summary(entry), snapshot, environment: entry.environmentCheck, canVerify: record.canVerify, workcopyId: workcopy.id } }
  }
  async inspectLaunch(root: string, id: string): Promise<ApplicationLaunchInspection> {
    return this.observeLaunch(this.entry(await this.project(root), id)).inspection
  }
  async verifyEnvironment(root: string, id: string, revision: string, planId: string, actor: string,
    confirm: (inspection: ApplicationLaunchInspection) => Promise<boolean>, assertCurrent: () => Promise<void>): Promise<ApplicationLaunchInspection> {
    const project = await this.project(root), entry = this.entry(project, id)
    return this.enqueue(entry, async () => {
      this.checkAdmission()
      await assertCurrent()
      if (entry.stored.revision !== revision) throw new AppRuntimeError('配置修订已变化，请重新查看启动计划', IpcErrorCode.Conflict, 'PLAN_CHANGED')
      const original = this.observeLaunch(entry)
      if (original.inspection.planId !== planId) throw new AppRuntimeError('启动环境已变化，请重新查看启动计划', IpcErrorCode.Conflict, 'PLAN_CHANGED')
      if (!original.inspection.canVerify) throw new AppRuntimeError(original.inspection.environment.reason ?? '环境无法核实', IpcErrorCode.Denied, 'ENVIRONMENT_UNVERIFIED')
      if (!await confirm(original.inspection)) throw new AppRuntimeError('已取消环境核对', IpcErrorCode.Denied)
      await assertCurrent()
      this.checkAdmission()
      const current = this.observeLaunch(entry)
      if (!this.environments.verify(entry.root, entry.stored, current.plan, current.workcopy, planId, actor)) throw new AppRuntimeError('核对期间目录、分支、配置或环境已变化，请重新核对', IpcErrorCode.Conflict, 'PLAN_CHANGED')
      const result = this.observeLaunch(entry).inspection
      this.emit(entry, 'state')
      return result
    })
  }
  private assertTaskGuard(entry: RuntimeEntry, guard: ApplicationTaskLaunchGuard): void {
    const { inspection } = this.observeLaunch(entry)
    if (inspection.workcopyId !== guard.workcopyId) throw new AppRuntimeError('实际启动目录属于其他工作副本，请修正 cwd', IpcErrorCode.Conflict, 'PLAN_CHANGED')
    if (inspection.planId !== guard.expectedPlanId) throw new AppRuntimeError('启动计划已变化，请重新核对环境', IpcErrorCode.Conflict, 'PLAN_CHANGED')
    if (inspection.environment.id !== guard.expectedCheckId || inspection.environment.status !== 'verified') throw new AppRuntimeError('环境尚未完成本机核对，不能从任务启动或复用', IpcErrorCode.Denied, 'ENVIRONMENT_UNVERIFIED')
  }
  private assertTaskImpact(entry: RuntimeEntry, expected?: string[]): void {
    const ids = entry.stored.taskServiceUses.filter(use => use.runId === entry.run?.id).map(use => use.id).sort()
    if (ids.length > 0 && JSON.stringify(ids) !== JSON.stringify(expected?.slice().sort())) throw new AppRuntimeError('此实例仍有任务引用，请核对受影响任务后再停止或重启', IpcErrorCode.Conflict, 'TASK_REFERENCES')
    if (expected && JSON.stringify(ids) !== JSON.stringify(expected.slice().sort())) throw new AppRuntimeError('核对期间服务引用已变化，请重新确认影响', IpcErrorCode.Conflict, 'TASK_REFERENCES')
  }
  private async appendTaskReference(entry: RuntimeEntry, project: ProjectEntries, owner: ApplicationTaskReferenceOwner, guard: ApplicationTaskLaunchGuard, disposition: 'created' | 'reused', assertCurrent: () => Promise<void>): Promise<ApplicationTaskServiceUse> {
    if (!entry.run || entry.run.snapshot.status !== 'known') throw new AppRuntimeError('运行快照未知，不能登记任务服务', IpcErrorCode.Conflict)
    const existing = entry.stored.taskServiceUses.find(use => use.taskKey === owner.taskKey && use.bindingId === owner.bindingId && use.attemptId === owner.attemptId && use.contextRevision === owner.contextRevision && use.runId === entry.run?.id)
    if (existing) return this.coordinateTaskReference(entry, project, existing, 'attach', assertCurrent)
    if (entry.stored.consumerMutation) throw new AppRuntimeError('原服务引用变更尚未确认，请先回原任务重试原操作', IpcErrorCode.Busy, 'TASK_REFERENCES')
    if (entry.stored.taskServiceUses.length >= 256) throw new AppRuntimeError('服务引用已达到上限，请先解绑不再使用的引用', IpcErrorCode.Conflict)
    const reference: ApplicationTaskServiceUse = { version: 1, id: randomUUID(), ...owner, root: entry.root, workcopyId: guard.workcopyId, appId: entry.stored.config.id,
      configRevision: entry.run.snapshot.configRevision, runId: entry.run.id, checkId: guard.expectedCheckId, disposition, createdAt: Date.now(), coordination: 'pending' }
    entry.stored.taskServiceUses.push(reference)
    try { this.persist(project) } catch (error) { entry.stored.taskServiceUses.pop(); throw error }
    return this.coordinateTaskReference(entry, project, reference, 'attach', assertCurrent)
  }
  /** Durable intent first, original private consumer CAS second, receipt last. */
  private async coordinateTaskReference(entry: RuntimeEntry, project: ProjectEntries, reference: ApplicationTaskServiceUse, action: 'attach' | 'detach', assertCurrent: () => Promise<void>): Promise<ApplicationTaskServiceUse> {
    if (entry.stored.consumerRemoval) throw new AppRuntimeError('原本机解绑尚未确认，请在本机运行中心重试原解绑', IpcErrorCode.Busy, 'TASK_REFERENCES')
    const workcopy = entry.workcopy
    const previousReferences = entry.stored.taskServiceUses
    const existing = entry.stored.consumerMutation
    if (existing && (existing.referenceId !== reference.id || existing.action !== action || existing.runId !== reference.runId)) throw new AppRuntimeError('原服务引用变更尚未确认，请先重试原变更；实例归属保持不变', IpcErrorCode.Busy, 'TASK_REFERENCES')
    if (reference.runId !== entry.run?.id || !workcopy || workcopy.lease.kind !== 'consumer') {
      if (existing) throw new AppRuntimeError('原引用租约与当前实例不一致，请核对原实例后清理', IpcErrorCode.Conflict, 'STALE_RUN')
      entry.stored.taskServiceUses = action === 'detach' ? previousReferences.filter(use => use.id !== reference.id)
        : previousReferences.map(use => use.id === reference.id ? { ...use, coordination: 'ready' as const } : use)
      try { this.persist(project) } catch (error) { entry.stored.taskServiceUses = previousReferences; throw error }
      this.emit(entry, 'state')
      return { ...reference, coordination: 'ready' }
    }
    if (workcopy.lease.owner.generation !== reference.runId) throw new AppRuntimeError('旧引用不能更新新实例的消费登记', IpcErrorCode.Conflict, 'STALE_RUN')
    if (!existing) {
      const currentKeys = workcopy.lease.consumerAccess?.taskKeys ?? (workcopy.lease.owner.taskKey ? [workcopy.lease.owner.taskKey] : [])
      const taskKeys = [...new Set(previousReferences.filter(use => use.runId === reference.runId && (action !== 'detach' || use.id !== reference.id)
        && (use.coordination === 'ready' || use.id === reference.id && action === 'attach' || currentKeys.includes(use.taskKey)))
        .map(use => use.taskKey))].sort()
      if (taskKeys.length > 128) throw new AppRuntimeError('此服务的任务使用范围已达上限，请先解绑不再使用的引用', IpcErrorCode.Conflict)
      entry.stored.consumerMutation = { version: 1, runId: reference.runId, referenceId: reference.id, action, original: structuredClone(workcopy), taskKeys }
      entry.stored.taskServiceUses = previousReferences.map(use => use.id === reference.id ? { ...use, coordination: action === 'attach' ? 'pending' : 'releasing' } : use)
      try { this.persist(project) } catch (error) { entry.stored.consumerMutation = undefined; entry.stored.taskServiceUses = previousReferences; throw error }
    }
    const intent = entry.stored.consumerMutation
    if (!intent) throw new AppRuntimeError('原服务引用意图未保存，请重新核对', IpcErrorCode.Io)
    const pendingReferences = entry.stored.taskServiceUses
    const pendingWorkcopy = entry.workcopy
    let committed = false
    try {
      await assertCurrent()
      if (action === 'attach') this.checkAdmission()
      this.checkRun(entry, intent.runId)
      if (entry.workcopy?.lease.token !== intent.original.lease.token) throw new AppRuntimeError('原消费租约已变化，未更新新的实例', IpcErrorCode.Conflict, 'STALE_RUN')
      // Retrying always reuses this exact old lease revision and complete desired set.
      const lease = await updateWorkcopyConsumerTasks(intent.original.root, intent.original.lease, intent.taskKeys)
      this.checkRun(entry, intent.runId)
      if (lease.token !== intent.original.lease.token || lease.owner.generation !== intent.runId) throw new AppRuntimeError('原服务任务授权回执不匹配', IpcErrorCode.Conflict)
      entry.workcopy = { root: intent.original.root, lease }
      entry.stored.taskServiceUses = action === 'detach' ? pendingReferences.filter(use => use.id !== reference.id)
        : pendingReferences.map(use => use.id === reference.id ? { ...use, coordination: 'ready' as const } : use)
      entry.stored.consumerMutation = undefined
      this.persist(project)
      entry.persistError = false
      if (entry.lastError === '运行记录未保存，请检查本地数据目录权限并停止此运行') entry.lastError = undefined
      committed = true
      this.emit(entry, 'state')
      await assertCurrent()
      return { ...reference, coordination: 'ready' }
    } catch (error) {
      if (committed) throw error
      // The daemon may have committed. Preserve the same CAS intent across retries/restart.
      entry.workcopy = pendingWorkcopy
      entry.stored.consumerMutation = intent
      entry.stored.taskServiceUses = pendingReferences.map(use => use.id === reference.id ? { ...use, coordination: action === 'detach' ? 'releasing' : 'unknown' } : use)
      this.record(entry, project)
      this.emit(entry, 'state')
      throw error
    }
  }
  async taskReferences(root: string, taskKey: string): Promise<ApplicationTaskServiceUse[]> {
    return [...(await this.project(root)).entries.values()].flatMap(entry => entry.stored.taskServiceUses.filter(use => use.taskKey === taskKey).map(use => ({ ...use })))
  }
  async retainedTaskReferences(taskKey: string): Promise<{ references: ApplicationTaskServiceUse[]; partial: boolean }> {
    const discovered = discoverProjects()
    const references: ApplicationTaskServiceUse[] = []
    let partial = discovered.unavailableProjects > 0
    for (const root of new Set([...discovered.roots, ...this.loaded.keys()])) {
      try { references.push(...await this.taskReferences(root, taskKey)) } catch { partial = true }
    }
    references.sort((a, b) => b.createdAt - a.createdAt)
    return { references: references.slice(0, 256), partial: partial || references.length > 256 }
  }
  async reusableTaskInstances(root: string, id: string, guard: ApplicationTaskLaunchGuard): Promise<ApplicationInstanceTarget[]> {
    const entry = this.entry(await this.project(root), id)
    this.assertTaskGuard(entry, guard)
    const { plan, workcopy } = this.observeLaunch(entry)
    return entry.processState === 'running' && entry.workcopy?.lease.kind === 'consumer' && entry.run?.snapshot.status === 'known'
      && this.environments.matchesRun(entry.run.id, entry.stored, plan, workcopy) ? [this.instanceTarget(entry, entry.run.id)] : []
  }
  async reuseTaskInstance(target: ApplicationInstanceTarget, owner: ApplicationTaskReferenceOwner, guard: ApplicationTaskLaunchGuard, assertCurrent: () => Promise<void>): Promise<ApplicationTaskServiceUse> {
    const managed = await this.managedTarget(target), project = await this.project(managed.root), entry = this.entry(project, managed.appId)
    return this.enqueue(entry, async () => {
      this.checkAdmission()
      await assertCurrent()
      this.checkRun(entry, managed.expectedRunId)
      this.assertTaskGuard(entry, guard)
      const candidates = await this.reusableTaskInstances(entry.root, entry.stored.config.id, guard)
      if (!candidates.some(candidate => candidate.expectedRunId === managed.expectedRunId)) throw new AppRuntimeError('原实例的配置、环境或工作副本无法证明兼容，请核对后重新启动', IpcErrorCode.Conflict, 'ENVIRONMENT_UNVERIFIED')
      await assertCurrent()
      this.checkAdmission()
      this.checkRun(entry, managed.expectedRunId)
      this.assertTaskGuard(entry, guard)
      return this.appendTaskReference(entry, project, owner, guard, 'reused', assertCurrent)
    })
  }
  async detachTaskReference(root: string, referenceId: string, owner: ApplicationTaskReferenceOwner, assertCurrent: () => Promise<void>): Promise<ApplicationTaskServiceUse> {
    const project = await this.project(root)
    const entry = [...project.entries.values()].find(entry => entry.stored.taskServiceUses.some(use => use.id === referenceId && use.taskKey === owner.taskKey))
    if (!entry) throw new AppRuntimeError('原任务服务引用不存在', IpcErrorCode.NotFound)
    return this.enqueue(entry, async () => {
      await assertCurrent()
      const reference = entry.stored.taskServiceUses.find(use => use.id === referenceId && use.taskKey === owner.taskKey)
      if (!reference) throw new AppRuntimeError('原任务服务引用已解绑，请重新读取', IpcErrorCode.Conflict)
      return this.coordinateTaskReference(entry, project, reference, 'detach', assertCurrent)
    })
  }

  async list(root: string): Promise<ApplicationListResult> {
    try { const project = await this.project(root); return { ok: true, root: project.store.root, apps: [...project.entries.values()].map((entry) => { this.refreshEnvironment(entry); return this.summary(entry) }) } }
    catch (error) { return runtimeFailure(error, root) }
  }
  private refreshEnvironment(entry: RuntimeEntry): void {
    try { this.observeLaunch(entry) }
    catch { entry.approvalCurrent = false; entry.runEnvironmentCheck = undefined; if (entry.environmentCheck) entry.environmentCheck = { ...entry.environmentCheck, status: 'unknown', reason: '当前启动输入无法读取，请重新核对' } }
  }
  async get(root: string, id: string): Promise<ApplicationResult> {
    try { const project = await this.project(root); return { ok: true, root: project.store.root, app: this.summary(this.entry(project, id)) } }
    catch (error) { return runtimeFailure(error, root, id) }
  }
  private checkRun(entry: RuntimeEntry, expectedRunId: string | undefined): void {
    if (expectedRunId === undefined) return // Legacy standalone-project operations.
    if (!applicationRunIdSchema.safeParse(expectedRunId).success) throw new AppRuntimeError('运行实例标识无效', IpcErrorCode.InvalidArg)
    if (entry.run?.id !== expectedRunId) throw new AppRuntimeError('原运行实例已被替换，请核对新实例后重试', IpcErrorCode.Conflict, 'STALE_RUN')
  }
  private async managedTarget(input: ApplicationInstanceTarget): Promise<ApplicationInstanceTarget> {
    const parsed = applicationInstanceTargetSchema.safeParse(input)
    if (!parsed.success) throw new AppRuntimeError('运行实例目标无效', IpcErrorCode.InvalidArg)
    const target = parsed.data
    if (this.instanceHandles.get(this.instanceKey(target.root, target.appId, target.expectedRunId)) !== target.handle) throw new AppRuntimeError('运行实例句柄无效或已过期，请重新读取运行清单', IpcErrorCode.Denied)
    if (canonicalDirectory(target.root) !== target.root) throw new AppRuntimeError('原工程目录身份已变化，请重新核对', IpcErrorCode.Conflict)
    // A live, owned entry remains controllable if its last persistence failed.
    // Only inventory can issue handles, never a caller-supplied root or PID.
    const entry = this.loaded.get(target.root)?.entries.get(target.appId)
    if (!entry?.run) throw new AppRuntimeError('应用没有受管运行记录', IpcErrorCode.NotFound)
    return target
  }
  async inspectInstance(input: ApplicationInstanceTarget): Promise<ApplicationResult> {
    try {
      const target = await this.managedTarget(input)
      const entry = this.entry(await this.project(target.root), target.appId)
      this.checkRun(entry, target.expectedRunId)
      return { ok: true, root: entry.root, app: this.summary(entry) }
    } catch (error) { return runtimeFailure(error) }
  }
  async inspectInstanceReference(input: ApplicationInstanceTarget, referenceId: string): Promise<{ ok: true; root: string; app: ApplicationSummary; reference: ApplicationTaskServiceUse; historical: boolean } | ReturnType<typeof runtimeFailure>> {
    try {
      const target = await this.managedTarget(input), entry = this.entry(await this.project(target.root), target.appId)
      const reference = entry.stored.taskServiceUses.find(use => use.id === referenceId && use.runId === target.expectedRunId && use.root === target.root && use.appId === target.appId)
      if (!reference) throw new AppRuntimeError('原实例的这项引用已解绑或不可用，请刷新核对', IpcErrorCode.NotFound)
      return { ok: true, root: entry.root, app: this.summary(entry), reference: { ...reference }, historical: entry.run?.id !== reference.runId }
    } catch (error) { return runtimeFailure(error) }
  }
  /** Local owner cleanup is a reduction capability, independent of Team execution rights. */
  async detachInstanceReference(input: ApplicationInstanceTarget, referenceId: string): Promise<ApplicationReferenceDetachResult> {
    try {
      const target = await this.managedTarget(input), project = await this.project(target.root), entry = this.entry(project, target.appId)
      return await this.enqueue(entry, async () => {
        const assertOriginal = async (): Promise<void> => {
          await this.managedTarget(target)
          if (!entry.stored.taskServiceUses.some(use => use.id === referenceId && use.runId === target.expectedRunId && use.root === target.root && use.appId === target.appId)) throw new AppRuntimeError('原引用已变化，请重新核对', IpcErrorCode.Conflict)
        }
        await assertOriginal()
        const reference = entry.stored.taskServiceUses.find(use => use.id === referenceId && use.runId === target.expectedRunId)
        if (!reference) throw new AppRuntimeError('原引用不存在', IpcErrorCode.NotFound)
        if (reference.runId !== entry.run?.id || !entry.workcopy || entry.workcopy.lease.kind !== 'consumer') {
          const before = entry.stored.taskServiceUses
          entry.stored.taskServiceUses = before.filter(use => use.id !== referenceId)
          try { this.persist(project) } catch (error) { entry.stored.taskServiceUses = before; throw error }
          this.emit(entry, 'state')
          return { ok: true as const, detached: true as const, reference: { ...reference }, app: this.summary(entry) }
        }
        await this.removeLocalConsumerReference(entry, project, reference, assertOriginal)
        return { ok: true as const, detached: true as const, reference: { ...reference }, app: this.summary(entry) }
      })
    } catch (error) { return runtimeFailure(error) }
  }
  private async removeLocalConsumerReference(entry: RuntimeEntry, project: ProjectEntries, reference: ApplicationTaskServiceUse, assertOriginal: () => Promise<void>): Promise<void> {
    const workcopy = entry.workcopy
    if (!workcopy || workcopy.lease.owner.generation !== reference.runId) throw new AppRuntimeError('原引用不属于此消费租约，未操作新实例', IpcErrorCode.Conflict, 'STALE_RUN')
    const retained = entry.stored.consumerRemoval
    if (retained && (retained.referenceId !== reference.id || retained.runId !== reference.runId)) throw new AppRuntimeError('另一项本机解绑尚未确认，请先重试原解绑', IpcErrorCode.Busy)
    if (!retained) {
      const before = entry.stored.taskServiceUses
      entry.stored.consumerRemoval = { version: 1, runId: reference.runId, referenceId: reference.id, phase: 'read', original: structuredClone(workcopy), taskKeys: [] }
      entry.stored.taskServiceUses = before.map(use => use.id === reference.id ? { ...use, coordination: 'releasing' } : use)
      try { this.persist(project) } catch (error) { entry.stored.consumerRemoval = undefined; entry.stored.taskServiceUses = before; throw error }
    }
    // A definite CAS conflict can be rebased after a private read; unknown replies
    // always retry the exact saved revision/subset first. No grant is replayed here.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const intent = entry.stored.consumerRemoval
      if (!intent) throw new AppRuntimeError('原本机解绑意图不可用', IpcErrorCode.Io)
      await assertOriginal()
      this.checkRun(entry, intent.runId)
      if (entry.workcopy?.lease.token !== intent.original.lease.token) throw new AppRuntimeError('原消费租约已更换，未操作新实例', IpcErrorCode.Conflict, 'STALE_RUN')
      if (intent.phase === 'read') {
        const observed: ApplicationWorkcopyUse['lease'] = await readWorkcopyConsumerLease(intent.original.root, intent.original.lease)
        await assertOriginal()
        const keepKey = entry.stored.taskServiceUses.some(use => use.id !== reference.id && use.runId === reference.runId && use.taskKey === reference.taskKey)
        const currentKeys: string[] = observed.consumerAccess?.taskKeys ?? (observed.owner.taskKey ? [observed.owner.taskKey] : [])
        const nextKeys: string[] = currentKeys.filter(key => keepKey || key !== reference.taskKey)
        intent.original = { root: intent.original.root, lease: observed }
        intent.taskKeys = [...new Set(nextKeys)].sort()
        intent.phase = 'submitted'
        this.persist(project)
      }
      let lease: ApplicationWorkcopyUse['lease']
      try { lease = await restrictWorkcopyConsumerTasks(intent.original.root, intent.original.lease, intent.taskKeys) }
      catch (error) {
        if (attempt === 0 && error instanceof DaemonError && (error.code === IpcErrorCode.Conflict || error.code === IpcErrorCode.Denied)) {
          const current = await readWorkcopyConsumerLease(intent.original.root, intent.original.lease)
          if ((current.consumerAccess?.revision ?? 0) !== (intent.original.lease.consumerAccess?.revision ?? 0)) {
            intent.phase = 'read'; this.persist(project); continue
          }
        }
        this.record(entry, project); this.emit(entry, 'state'); throw error
      }
      this.checkRun(entry, intent.runId)
      if (lease.token !== intent.original.lease.token || lease.owner.generation !== intent.runId) throw new AppRuntimeError('原本机解绑回执与实例不一致', IpcErrorCode.Conflict)
      const beforeReferences = entry.stored.taskServiceUses, beforeWorkcopy = entry.workcopy, oldMutation = entry.stored.consumerMutation
      entry.workcopy = { root: intent.original.root, lease }
      entry.stored.taskServiceUses = beforeReferences.filter(use => use.id !== reference.id).map(use => oldMutation?.referenceId === use.id
        ? { ...use, coordination: oldMutation.action === 'detach' ? 'releasing' as const : 'unknown' as const } : use)
      entry.stored.consumerMutation = undefined
      entry.stored.consumerRemoval = undefined
      try { this.persist(project) }
      catch (error) {
        entry.workcopy = beforeWorkcopy; entry.stored.taskServiceUses = beforeReferences; entry.stored.consumerMutation = oldMutation; entry.stored.consumerRemoval = intent
        this.record(entry, project); this.emit(entry, 'state'); throw error
      }
      entry.persistError = false
      if (entry.lastError === '运行记录未保存，请检查本地数据目录权限并停止此运行') entry.lastError = undefined
      this.emit(entry, 'state')
      return
    }
    throw new AppRuntimeError('本机解绑期间使用范围再次变化，请重试原解绑', IpcErrorCode.Conflict)
  }
  async inventory(input: ApplicationInventoryInput = {}): Promise<ApplicationInventoryResult> {
    try {
      const parsed = applicationInventoryInputSchema.safeParse(input)
      if (!parsed.success) throw new AppRuntimeError('运行清单参数无效', IpcErrorCode.InvalidArg)
      const { limit, cursor } = parsed.data
      let after = ''
      const key = (target: ApplicationInstanceTarget): string => JSON.stringify([target.root, target.appId, target.expectedRunId])
      if (cursor !== undefined) {
        try { after = key(applicationInstanceTargetSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))) }
        catch { throw new AppRuntimeError('运行清单游标无效', IpcErrorCode.InvalidArg) }
      }
      const discovered = discoverProjects()
      let unavailableProjects = discovered.unavailableProjects
      const instances: ApplicationInstanceSummary[] = []
      // Registry and already-owned runtimes supply roots, including failed persistence.
      for (const root of new Set([...discovered.roots, ...this.loaded.keys()])) {
        try {
          const project = await this.project(root)
          for (const entry of project.entries.values()) {
            if (!entry.run || !ACTIVE_STATES.has(entry.processState)) continue
            this.refreshEnvironment(entry)
            const summary = this.summary(entry)
            if (!summary.run) continue
            instances.push({ target: this.instanceTarget(entry, summary.run.id), run: summary.run, serviceUses: summary.serviceUses, environmentCheck: summary.environmentCheck, runEnvironmentCheck: summary.runEnvironmentCheck, processState: summary.processState, readiness: summary.readiness, ports: summary.ports, currentRevision: entry.stored.revision, configChanged: summary.configChanged, canStop: summary.canStop, canRestart: summary.canRestart, ...(summary.lastError ? { lastError: summary.lastError } : {}) })
          }
        } catch { unavailableProjects += 1 }
      }
      instances.sort((a, b) => key(a.target) < key(b.target) ? -1 : key(a.target) > key(b.target) ? 1 : 0)
      const remaining = instances.filter((item) => key(item.target) > after)
      const page = remaining.slice(0, limit)
      const last = page.at(-1)
      return { ok: true, instances: page, total: instances.length, nextCursor: remaining.length > limit && last ? Buffer.from(JSON.stringify(last.target)).toString('base64url') : null, partial: unavailableProjects > 0, unavailableProjects }
    } catch (error) { return runtimeFailure(error) }
  }
  async stopInstance(input: ApplicationInstanceTarget, expectedServiceUseIds?: string[], nativeCleanupConfirmed = false): Promise<ApplicationResult> {
    try { const target = await this.managedTarget(input); return this.stop(target.root, target.appId, target.expectedRunId, expectedServiceUseIds, nativeCleanupConfirmed) }
    catch (error) { return runtimeFailure(error) }
  }
  async logsInstance(input: ApplicationInstanceTarget, after?: number): Promise<ApplicationLogsResult> {
    try { const target = await this.managedTarget(input); return this.logs(target.root, target.appId, after, target.expectedRunId) }
    catch (error) { return runtimeFailure(error) }
  }
  async restartInstance(input: ApplicationInstanceTarget, options: AppInstanceRestartOptions): Promise<ApplicationResult> {
    try {
      const target = await this.managedTarget(input)
      if (!options || typeof options.expectedRevision !== 'string' || !options.expectedRevision || options.expectedRevision.length > 100) throw new AppRuntimeError('重启需要明确的配置修订', IpcErrorCode.InvalidArg)
      return this.restart(target.root, target.appId, { ...options, expectedRunId: target.expectedRunId })
    } catch (error) { return runtimeFailure(error) }
  }
  async save(root: string, input: unknown): Promise<ApplicationResult> {
    let id: string | undefined
    let attempted: RuntimeEntry | undefined
    try {
      const parsed = applicationSaveSchema.safeParse(input)
      if (!parsed.success) throw new AppRuntimeError('应用配置无效，请检查名称、启动命令、路径和数值范围', IpcErrorCode.InvalidArg)
      const { config, expectedRevision, overrides } = parsed.data
      id = config.id
      validateReadiness(config.readiness)
      const project = await this.project(root)
      let entry = project.entries.get(id)
      if (!entry) {
        if (expectedRevision) throw new AppRuntimeError('应用已不存在，请刷新', IpcErrorCode.Conflict)
        if (project.entries.size >= APP_RUNTIME_LIMITS.applications) throw new AppRuntimeError('应用数量超过限额', IpcErrorCode.InvalidArg)
        entry = { stored: { config, revision: '', updatedAt: 0, protectedOverrides: {}, overrideRevision: '', taskServiceUses: [] }, root: project.store.root, processState: 'stopped', readiness: { state: config.readiness.kind === 'none' ? 'not-configured' : 'unknown', checkedAt: null }, run: null, ports: [], identities: [], childClosed: true, rootExited: true, pendingApproval: false, output: '', outputBytes: 0, cursor: 0, outputTruncated: false, queue: Promise.resolve(), stopping: false }
        project.entries.set(id, entry)
      }
      const selected = entry
      attempted = selected
      return await this.enqueue(selected, async () => {
        const current = project.entries.get(config.id)
        if (current && current !== selected) throw new AppRuntimeError('应用配置正在被另一个请求创建，请刷新', IpcErrorCode.Conflict)
        if (!current && selected.stored.revision) throw new AppRuntimeError('应用已被删除，请刷新后重试', IpcErrorCode.Conflict)
        if (!current) project.entries.set(config.id, selected)
        if (selected.stored.revision && expectedRevision !== selected.stored.revision) throw new AppRuntimeError('应用配置已变更，请刷新后重试', IpcErrorCode.Conflict)
        const protectedOverrides = { ...selected.stored.protectedOverrides }
        let changedOverrides = false
        for (const patch of overrides) {
          const key = process.platform === 'win32' ? patch.key.toUpperCase() : patch.key
          if (patch.action === 'replace') {
            if (Buffer.byteLength(patch.value, 'utf8') > APP_RUNTIME_LIMITS.envValueBytes) throw new AppRuntimeError('环境覆盖值超过限额', IpcErrorCode.InvalidArg)
            protectedOverrides[key] = protect(patch.value); changedOverrides = true
          }
          else if (patch.action === 'clear') { delete protectedOverrides[key]; changedOverrides = true }
        }
        if (Object.keys(protectedOverrides).length > APP_RUNTIME_LIMITS.envKeys) throw new AppRuntimeError('环境覆盖变量数量超过限额', IpcErrorCode.InvalidArg)
        const { name: _oldName, ...oldExecution } = selected.stored.config
        const { name: _newName, ...newExecution } = config
        const changedExecution = JSON.stringify(oldExecution) !== JSON.stringify(newExecution) || changedOverrides
        const previous = selected.stored
        selected.stored = { ...previous, config, revision: randomUUID(), updatedAt: Date.now(), protectedOverrides, overrideRevision: changedOverrides ? randomUUID() : previous.overrideRevision, ...(changedExecution ? { approvedFingerprint: undefined, approvedAt: undefined } : {}) }
        selected.pendingApproval = false
        try { this.persist(project) } catch (error) { selected.stored = previous; if (!previous.revision) project.entries.delete(config.id); throw error }
        if (!selected.run) {
          selected.ports = config.ports.map((port) => ({ ...port, state: 'unknown' }))
          selected.readiness = { state: config.readiness.kind === 'none' ? 'not-configured' : 'unknown', checkedAt: null }
        }
        this.emit(selected, 'state')
        return { ok: true as const, root: project.store.root, app: this.summary(selected) }
      })
    } catch (error) {
      if (id) {
        const project = this.loaded.get(canonicalDirectory(root))
        const failed = project?.entries.get(id)
        if (failed && failed === attempted && !failed.stored.revision) project?.entries.delete(id)
      }
      return runtimeFailure(error, root, id)
    }
  }
  async remove(root: string, id: string, revision: string): Promise<ApplicationSuccess> {
    try {
      const project = await this.project(root)
      const entry = this.entry(project, id)
      return await this.enqueue(entry, async () => {
        if (project.entries.get(id) !== entry) throw new AppRuntimeError('应用已被删除或重新创建，请刷新', IpcErrorCode.Conflict)
        if (entry.stored.revision !== revision) throw new AppRuntimeError('应用配置已变更，请刷新', IpcErrorCode.Conflict)
        if (ACTIVE_STATES.has(entry.processState)) throw new AppRuntimeError('请先停止并核验应用退出', IpcErrorCode.Conflict)
        project.entries.delete(id)
        try { this.persist(project) } catch (error) { project.entries.set(id, entry); throw error }
        this.environments.forgetApplication(entry.root, id)
        this.emit(entry, 'state')
        return { ok: true as const, root: project.store.root }
      })
    } catch (error) { return runtimeFailure(error, root, id) }
  }
  async importNpm(root: string, dir: string, script: string, name?: string): Promise<ApplicationResult> {
    try {
      const cwd = canonicalDirectory(resolve(root, dir))
      const id = `npm-${createHash('sha256').update(`${cwd}\0${script}`).digest('hex').slice(0, 16)}`
      const existing = await this.get(root, id)
      if (existing.ok) return existing
      // Verify the declaration without executing a package manager.
      const packageFile = resolve(cwd, 'package.json')
      if (statSync(packageFile).size > 1024 * 1024) throw new AppRuntimeError('package.json 过大', IpcErrorCode.InvalidArg)
      const pkg: unknown = JSON.parse(readFileSync(packageFile, 'utf8'))
      if (typeof pkg !== 'object' || pkg === null || !('scripts' in pkg) || typeof pkg.scripts !== 'object' || pkg.scripts === null || typeof (pkg.scripts as Record<string, unknown>)[script] !== 'string') throw new AppRuntimeError('所选 npm 脚本不存在', IpcErrorCode.NotFound)
      return this.save(root, { config: { id, name: name || script, cwd, launch: { kind: 'npm-script', script } } })
    } catch (error) { return runtimeFailure(error, root) }
  }
  async start(root: string, id: string, options: AppOperationOptions = {}): Promise<ApplicationResult> { return this.execute(root, id, 'start', options) }
  async restart(root: string, id: string, options: AppOperationOptions = {}): Promise<ApplicationResult> { return this.execute(root, id, 'restart', options) }
  private async execute(root: string, id: string, action: 'start' | 'restart', options: AppOperationOptions): Promise<ApplicationResult> {
    let attempted: RuntimeEntry | undefined
    const restart: ApplicationRestartProgress | undefined = action === 'restart' ? { previousRunId: options.expectedRunId ?? null, previousStopped: false, phase: 'preflight', replacementRunId: null } : undefined
    try {
      this.checkAdmission()
      const project = await this.project(root)
      const entry = this.entry(project, id)
      attempted = entry
      const admittedRunId = entry.run?.id
      if (restart) restart.previousRunId = options.expectedRunId ?? admittedRunId ?? null
      return await this.enqueue(entry, async () => {
        if (project.entries.get(id) !== entry) throw new AppRuntimeError('应用已被删除或重新创建，请刷新', IpcErrorCode.Conflict)
        this.checkAdmission()
        await options.assertCurrent?.()
        this.checkRun(entry, options.expectedRunId)
        if (action === 'restart' && entry.run?.id !== admittedRunId) throw new AppRuntimeError('排队期间运行实例已变化，请重新核对', IpcErrorCode.Conflict, 'STALE_RUN')
        if (options.expectedRevision && options.expectedRevision !== entry.stored.revision) throw new AppRuntimeError('应用配置已变更，请刷新后重试', IpcErrorCode.Conflict)
        if (options.taskGuard) this.assertTaskGuard(entry, options.taskGuard)
        if (action === 'start' && entry.processState === 'running') {
          if (options.taskGuard) throw new AppRuntimeError('此应用已有实例，请明确选择兼容复用', IpcErrorCode.Conflict)
          return { ok: true as const, root: entry.root, app: this.summary(entry), disposition: 'reused' as const }
        }
        if (entry.processState === 'unknown' || entry.processState === 'cleanup-required') throw new AppRuntimeError('上次运行尚未完成清理，请先停止并核验', IpcErrorCode.Conflict, 'CLEANUP_REQUIRED')
        let plan = planLaunch(entry.root, entry.stored)
        const workcopy = resolveWorkcopy(plan.cwd)
        if (options.requireConfirmation || entry.stored.approvedFingerprint !== plan.fingerprint) {
          if (!entry.pendingApproval) { entry.pendingApproval = true; this.emit(entry, 'attention') }
          if (!options.confirm) throw new AppRuntimeError('请在应用面板中确认首次启动或变更后的命令', IpcErrorCode.Denied, 'APPROVAL_REQUIRED')
          const revision = entry.stored.revision
          const fingerprint = plan.fingerprint
          const inputFingerprint = plan.inputFingerprint
          let accepted = false
          try { accepted = await options.confirm({ root: entry.root, appId: id, revision, name: entry.stored.config.name, cwd: plan.cwd, command: plan.command, envFiles: [...plan.envFiles], overrideKeys: Object.keys(entry.stored.protectedOverrides), ports: entry.stored.config.ports, workcopyAccess: entry.stored.config.workcopyAccess, action }) }
          finally { entry.pendingApproval = false; this.emit(entry, 'state') }
          if (!accepted) { this.emit(entry, 'state'); throw new AppRuntimeError('已取消应用启动', IpcErrorCode.Denied) }
          this.checkAdmission()
          plan = planLaunch(entry.root, entry.stored)
          if (revision !== entry.stored.revision || inputFingerprint !== plan.inputFingerprint) throw new AppRuntimeError('启动配置或环境在确认期间已变化，请重新确认', IpcErrorCode.Conflict)
          entry.stored.approvedFingerprint = fingerprint
          entry.stored.approvedAt = Date.now()
          this.persist(project)
        }
        const reviewedInputs = plan.inputFingerprint
        if (restart) {
          this.assertTaskImpact(entry, options.expectedServiceUseIds)
          await options.assertCurrent?.()
          if (options.taskGuard) this.assertTaskGuard(entry, options.taskGuard)
          this.checkRun(entry, options.expectedRunId)
          restart.phase = 'stop'
          if (ACTIVE_STATES.has(entry.processState)) await this.stopEntry(entry, project)
          restart.previousStopped = entry.run !== null && !ACTIVE_STATES.has(entry.processState)
          restart.phase = 'revalidate'
        }
        this.checkAdmission()
        // Stop and human review can take time; env values and executable resolution are live inputs.
        plan = planLaunch(entry.root, entry.stored)
        if (plan.inputFingerprint !== reviewedInputs) throw new AppRuntimeError('启动目录、入口或环境在清理期间已变化，请重新核对', IpcErrorCode.Conflict)
        if (plan.fingerprint !== entry.stored.approvedFingerprint) throw new AppRuntimeError('启动内容已变化，请重新确认', IpcErrorCode.Denied, 'APPROVAL_REQUIRED')
        entry.approvalCurrent = true
        const ports = await diagnosePorts(entry.stored.config.ports)
        if (ports.some((port) => port.state !== 'available')) {
          if (!entry.run) { entry.ports = ports; entry.processState = 'failed' }
          entry.lastError = '声明端口被占用或不可用，请检查冲突后重试'
          this.emit(entry, 'state')
          throw new AppRuntimeError(entry.lastError, IpcErrorCode.Conflict, 'PORT_CONFLICT')
        }
        // The port check awaits system I/O too. Recheck the exact reviewed inputs
        // before creating a new generation, without changing the old run snapshot.
        plan = planLaunch(entry.root, entry.stored)
        if (plan.inputFingerprint !== reviewedInputs) throw new AppRuntimeError('启动内容在端口核验期间已变化，请重新核对', IpcErrorCode.Conflict)
        if (restart) restart.phase = 'start'
        if (options.isCurrent?.() === false) throw new AppRuntimeError('原启动上下文已变化，请重新核对后启动', IpcErrorCode.Conflict)
        await options.assertCurrent?.()
        if (options.taskGuard) this.assertTaskGuard(entry, options.taskGuard)
        await this.spawn(entry, project, plan, workcopy, options)
        if (options.taskGuard && options.taskOwner) {
          await options.assertCurrent?.()
          this.assertTaskGuard(entry, options.taskGuard)
          await this.appendTaskReference(entry, project, options.taskOwner, options.taskGuard, 'created', options.assertCurrent ?? (async () => undefined))
        }
        if (restart) { restart.phase = 'complete'; restart.replacementRunId = entry.run?.id ?? null }
        return { ok: true as const, root: entry.root, app: this.summary(entry), disposition: action === 'restart' ? 'restarted' as const : 'started' as const, ...(restart ? { restart } : {}) }
      })
    } catch (error) {
      if (restart && attempted?.run && attempted.run.id !== restart.previousRunId) restart.replacementRunId = attempted.run.id
      return { ...runtimeFailure(error, root, id), ...(attempted ? { app: this.summary(attempted) } : {}), ...(restart ? { restart } : {}) }
    }
  }

  private async spawn(entry: RuntimeEntry, project: ProjectEntries, plan: ReturnType<typeof planLaunch>, expected: WorkcopyIdentity, options: AppOperationOptions): Promise<void> {
    this.checkAdmission()
    const runId = randomUUID()
    const lease = await acquireWorkcopyUse(plan.cwd, { kind: entry.stored.config.workcopyAccess, owner: { kind: 'application', id: entry.stored.config.id, generation: runId, label: entry.stored.config.name, taskKey: options.taskKey }, expected })
    try {
      this.checkAdmission()
      if (options.isCurrent?.() === false) throw new AppRuntimeError('原启动上下文已变化，请重新核对', IpcErrorCode.Conflict)
      if (options.taskGuard) this.assertTaskGuard(entry, options.taskGuard)
      assertWorkcopyObservation(resolveWorkcopy(plan.cwd), expected)
      const current = planLaunch(entry.root, entry.stored)
      if (current.inputFingerprint !== plan.inputFingerprint) throw new AppRuntimeError('启动输入在工作副本准入期间已变化，请重新核对', IpcErrorCode.Conflict)
      const git = await gitWorkspace.status(plan.cwd)
      // No execution occurs during these local reads; reauthorize after their final await.
      await options.assertCurrent?.()
      this.checkAdmission()
      assertWorkcopyObservation(resolveWorkcopy(plan.cwd), expected)
      if (options.isCurrent?.() === false) throw new AppRuntimeError('原启动上下文已变化，请重新核对', IpcErrorCode.Conflict)
      const final = planLaunch(entry.root, entry.stored)
      if (final.inputFingerprint !== plan.inputFingerprint) throw new AppRuntimeError('启动输入在源码核验期间已变化，请重新核对', IpcErrorCode.Conflict)
      await this.spawnAdmitted(entry, project, plan, runId, { root: plan.cwd, lease }, git.ok ? !git.snapshot.clean : null, options)
    } catch (error) {
      // No child was created: the acquired generation has no remaining process work.
      if (entry.run?.id !== runId || !entry.child) {
        await releaseWorkcopyUse(plan.cwd, lease, 'cleanup-confirmed')
        if (entry.workcopy?.lease.token === lease.token) { entry.workcopy = undefined; this.record(entry, project) }
      }
      throw error
    }
  }
  private async spawnAdmitted(entry: RuntimeEntry, project: ProjectEntries, plan: ReturnType<typeof planLaunch>, runId: string, workcopy: NonNullable<RuntimeEntry['workcopy']>, dirty: boolean | null, options: AppOperationOptions): Promise<void> {
    const startedAt = Date.now()
    const snapshot = captureRunSnapshot(entry.root, entry.stored, plan, runId, startedAt)
    if (snapshot.status === 'known' && snapshot.workcopy) snapshot.workcopy.dirty = dirty
    const checked = this.environments.observe(entry.root, entry.stored, plan, resolveWorkcopy(plan.cwd)).check
    if (snapshot.status === 'known' && checked.status === 'verified') snapshot.environment = { ...snapshot.environment, status: 'verified', check: { ...checked, targets: checked.targets.map(target => ({ ...target })) } }
    this.environments.rememberRun(runId, entry.stored, plan, resolveWorkcopy(plan.cwd))
    entry.workcopy = workcopy
    entry.container = process.platform === 'win32' ? applicationProcessContainer(plan.cwd, workcopy.lease.owner) : undefined
    entry.jobOwner = undefined
    entry.cancelProbe?.abort()
    entry.outputFlush?.()
    this.retainOutput(entry)
    entry.processState = 'starting'
    entry.pendingApproval = false
    entry.lastError = undefined
    entry.output = ''; entry.outputBytes = 0; entry.cursor = 0; entry.outputTruncated = false
    entry.identities = []
    entry.child = undefined
    entry.childClosed = true
    entry.rootExited = true
    entry.launchExecutable = plan.executable
    entry.run = { id: runId, pid: null, pidRole: entry.container ? 'supervisor' : 'application', startedAt, exitedAt: null, exitCode: null, signal: null, snapshot }
    entry.runPolicy = runPolicySchema.parse(entry.stored.config)
    entry.ports = entry.runPolicy.ports.map((port) => ({ ...port, state: 'available' }))
    entry.readiness = { state: entry.runPolicy.readiness.kind === 'none' ? 'not-configured' : 'checking', checkedAt: null }
    try { this.persist(project) }
    catch (error) {
      entry.processState = 'failed'
      entry.run.exitedAt = Date.now()
      entry.lastError = '启动记录未能保存，应用未启动'
      this.emit(entry, 'state')
      throw error
    }
    let child: RuntimeEntry['child']
    const launch = { launchId: runId, purpose: 'agent' as const, scope: { kind: 'runtime-session' as const, sessionKey: entry.stored.config.id }, command: plan.executable, args: plan.args, cwd: plan.cwd }
    try {
      if (entry.container) entry.jobOwner = await prepareApplicationJob(entry.container)
      this.checkAdmission()
      await options.assertCurrent?.()
      if (options.isCurrent?.() === false) throw new AppRuntimeError('原启动上下文已变化，请重新核对', IpcErrorCode.Conflict)
      assertWorkcopyObservation(resolveWorkcopy(plan.cwd), workcopy.lease.identity)
      if (planLaunch(entry.root, entry.stored).inputFingerprint !== plan.inputFingerprint) throw new AppRuntimeError('启动内容在原生容器准备期间已变化，请重新核对', IpcErrorCode.Conflict)
      child = entry.jobOwner ? entry.jobOwner.spawn(launch, { cwd: plan.cwd, env: plan.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) : spawnOwned(plan.executable, plan.args, plan.cwd, plan.env)
    }
    catch (error) {
      entry.processState = 'failed'
      entry.run.exitedAt = Date.now()
      entry.lastError = error instanceof AppRuntimeError ? error.message : '无法启动应用程序'
      this.record(entry, project)
      this.emit(entry, 'state')
      throw error instanceof AppRuntimeError ? error : new AppRuntimeError(entry.lastError, IpcErrorCode.Io)
    }
    entry.child = child
    entry.launchExecutable = child.spawnfile || plan.executable
    entry.childClosed = false
    entry.rootExited = false
    entry.run.pid = child.pid ?? null
    let eventOutput = ''
    let eventOverflow = false
    let outputTimer: ReturnType<typeof setTimeout> | undefined
    const flushEvent = (): void => {
      if (outputTimer) clearTimeout(outputTimer)
      outputTimer = undefined
      if (eventOutput && entry.run?.id === runId) this.emit(entry, 'output', { output: eventOutput, cursor: entry.cursor, outputTruncated: entry.outputTruncated || eventOverflow })
      eventOutput = ''; eventOverflow = false
    }
    const append = (value: string): void => {
      if (entry.run?.id !== runId) return
      const bytes = Buffer.byteLength(value)
      const tail = boundedTail(entry.output + value)
      entry.output = tail.value
      entry.outputTruncated ||= tail.truncated
      entry.outputBytes = Buffer.byteLength(entry.output)
      entry.cursor += bytes
      const pending = boundedTail(eventOutput + value, 32 * 1024)
      eventOutput = pending.value
      eventOverflow ||= pending.truncated
      if (!outputTimer) { outputTimer = setTimeout(flushEvent, 100); outputTimer.unref() }
    }
    const stdout = outputRedactor(plan.secrets, append)
    const stderr = outputRedactor(plan.secrets, append)
    entry.outputFlush = () => { stdout.end(); stderr.end(); flushEvent() }
    child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk))
    child.once('error', () => {
      if (entry.run?.id !== runId) return
      entry.lastError = '启动程序失败，请检查可执行文件和权限'
      entry.processState = child.pid ? 'cleanup-required' : 'failed'
      if (!child.pid) { entry.childClosed = true; entry.rootExited = true; entry.run.exitedAt = Date.now() }
      this.emit(entry, 'state')
    })
    child.once('exit', () => { if (entry.run?.id === runId) entry.rootExited = true })
    child.once('close', (code, signal) => {
      if (entry.run?.id !== runId) return
      entry.childClosed = true
      entry.outputFlush?.()
      entry.run.exitedAt = Date.now(); entry.run.exitCode = code; entry.run.signal = signal
      entry.cancelProbe?.abort()
      if (!entry.stopping) void this.enqueue(entry, async () => {
        if (entry.run?.id !== runId) return
        if (entry.container) { await this.cleanContained(entry); entry.identities = []; entry.ports = await checkPorts(this.policy(entry).ports); entry.processState = code === 0 && !signal ? 'exited' : 'failed'; entry.lastError = entry.processState === 'failed' ? `应用已退出（${signal ?? code ?? '未知原因'}）` : undefined }
        else await this.refreshIdentities(entry)
        if (entry.identities.length > 0) { entry.processState = 'cleanup-required'; entry.lastError = '启动进程已退出，但仍有应用子进程需要停止' }
        else if (entry.processState !== 'cleanup-required' && entry.processState !== 'unknown') { entry.processState = code === 0 && !signal ? 'exited' : 'failed'; if (entry.processState === 'failed') entry.lastError ??= `应用已退出（${signal ?? code ?? '未知原因'}）` }
        entry.readiness = { state: this.policy(entry).readiness.kind === 'none' ? 'not-configured' : 'unknown', checkedAt: Date.now() }
        if (entry.monitor) clearInterval(entry.monitor)
        entry.monitor = undefined
        if (!ACTIVE_STATES.has(entry.processState)) await this.releaseUse(entry, project)
        this.record(entry, project); this.emit(entry, 'done')
      }).catch(() => { entry.processState = 'cleanup-required'; entry.lastError = '应用退出后的工作副本清理未确认'; this.record(entry, project); this.emit(entry, 'state') })
    })
    // Record the spawned PID before a potentially slow system identity query.
    this.record(entry, project)
    await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', () => reject(new AppRuntimeError('无法启动应用程序', IpcErrorCode.Io))) })
    if (entry.jobOwner) {
      try { await entry.jobOwner.spawned({ ...launch, pid: child.pid ?? 0, startedAt: new Date(startedAt).toISOString() }) }
      catch (error) { entry.processState = 'cleanup-required'; entry.lastError = '原生容器启动尚未确认，请核对原实例并清理'; this.record(entry, project); this.emit(entry, 'state'); throw error }
    }
    entry.processState = 'running'
    await this.refreshIdentities(entry)
    entry.ports = this.observedPorts(entry, await diagnosePorts(this.policy(entry).ports, entry.identities.map((identity) => identity.pid)))
    if (entry.persistError) throw new AppRuntimeError('运行记录未保存，请先停止应用', IpcErrorCode.Io)
    this.record(entry, project)
    this.emit(entry, 'state')
    let observing = false
    entry.monitor = setInterval(() => {
      if (observing || entry.run?.id !== runId || entry.stopping) return
      observing = true
      void this.refreshIdentities(entry, true).then(async (changed) => {
        if (entry.run?.id !== runId || entry.stopping) return
        if (changed) this.record(entry, project)
        const ports = this.observedPorts(entry, await diagnosePorts(this.policy(entry).ports, entry.identities.map((identity) => identity.pid)))
        if (entry.run?.id !== runId || entry.stopping) return
        let refreshedReadiness = false
        const probe = this.policy(entry).readiness
        const signal = entry.cancelProbe?.signal
        if (probe.kind !== 'none' && signal && !signal.aborted && entry.processState === 'running' && ['ready', 'unhealthy'].includes(entry.readiness.state)) {
          const ready = await probeOnce(probe, signal)
          if (entry.run?.id !== runId || entry.stopping || signal.aborted || entry.processState !== 'running') return
          entry.readiness = { state: ready ? 'ready' : 'unhealthy', checkedAt: Date.now(), ...(ready ? {} : { message: '就绪检查未通过，进程仍在运行' }) }
          refreshedReadiness = true
        }
        if (JSON.stringify(ports) !== JSON.stringify(entry.ports) || refreshedReadiness) { entry.ports = ports; this.emit(entry, 'state') }
      }).catch(() => { entry.lastError = '进程身份核验暂不可用'; this.emit(entry, 'state') }).finally(() => { observing = false })
    }, 3000)
    entry.monitor.unref()
    this.startReadiness(entry, runId)
  }
  private async refreshIdentities(entry: RuntimeEntry, cacheObservation = false, timeoutMs?: number): Promise<boolean> {
    const pid = entry.run?.pid
    const runId = entry.run?.id
    if (!pid) return false
    try {
      if (cacheObservation && (!this.observation || Date.now() - this.observation.at > 1000)) this.observation = { at: Date.now(), result: processSnapshot() }
      const snapshot = await (cacheObservation && this.observation ? this.observation.result : processSnapshot(timeoutMs))
      if (entry.run?.id !== runId || cacheObservation && (entry.stopping || entry.processState !== 'running')) return false
      let canSeedRoot = entry.child !== undefined && !entry.rootExited && entry.child.exitCode === null && entry.child.signalCode === null
      if (canSeedRoot && entry.identities.length === 0 && process.platform === 'win32') {
        const observed = snapshot.find((row) => row.pid === pid)
        let createdAt = Number.NaN
        try { if (observed) createdAt = Number((BigInt(observed.createdAt) - 621355968000000000n) / 10000n) } catch { /* Missing creation identity cannot seed ownership. */ }
        canSeedRoot = observed?.executable !== null && observed?.executable !== undefined && entry.launchExecutable !== undefined && canonicalDirectory(observed.executable) === canonicalDirectory(entry.launchExecutable) && createdAt >= (entry.run?.startedAt ?? Date.now()) - 100 && createdAt <= Date.now()
      }
      const current = entry.identities.length > 0 || canSeedRoot ? ownedTree(snapshot, pid, entry.identities) : []
      // A missing root after it exited may still have a direct foreground child visible by PPID.
      if (entry.child && (entry.rootExited || entry.childClosed) && current.length === 0 && snapshot.some((row) => row.parentPid === pid)) {
        entry.processState = 'cleanup-required'
        entry.lastError = '启动进程在身份核验前退出，无法确认其子进程归属'
      }
      const changed = JSON.stringify(entry.identities) !== JSON.stringify(current)
      entry.identities = current
      if (entry.lastError === '进程列表暂不可读取；原生容器仍受管，可安全停止原实例') entry.lastError = undefined
      return changed
    } catch {
      if (entry.run?.id !== runId || cacheObservation && (entry.stopping || entry.processState !== 'running')) return false
      if (entry.container && entry.jobOwner && entry.child && !entry.childClosed && !entry.rootExited) {
        entry.identities = []
        entry.ports = entry.ports.map(port => ({ ...port, state: 'unknown' }))
        entry.lastError = '进程列表暂不可读取；原生容器仍受管，可安全停止原实例'
        this.emit(entry, 'state')
        return false
      }
      entry.processState = 'cleanup-required'; entry.lastError = '无法核验应用进程身份；停止前将再次核验'; this.emit(entry, 'state'); return false
    }
  }
  private startReadiness(entry: RuntimeEntry, runId: string): void {
    const probe = this.policy(entry).readiness
    if (probe.kind === 'none') return
    const cancellation = new AbortController()
    entry.cancelProbe = cancellation
    void (async () => {
      const deadline = Date.now() + probe.timeoutMs
      let ready = false
      while (!cancellation.signal.aborted && Date.now() < deadline && entry.run?.id === runId && entry.processState === 'running') {
        ready = await probeOnce(probe, cancellation.signal)
        if (ready) break
        await new Promise((accept) => setTimeout(accept, 200))
      }
      if (cancellation.signal.aborted || entry.run?.id !== runId || entry.processState !== 'running') return
      entry.readiness = { state: ready ? 'ready' : 'unhealthy', checkedAt: Date.now(), ...(ready ? {} : { message: '就绪检查未通过，进程仍在运行' }) }
      if (ready) {
        const ports = this.observedPorts(entry, await diagnosePorts(this.policy(entry).ports, entry.identities.map((identity) => identity.pid)))
        if (cancellation.signal.aborted || entry.run?.id !== runId) return
        entry.ports = ports
      }
      this.emit(entry, 'state')
    })()
  }
  async stop(root: string, id: string, expectedRunId?: string, expectedServiceUseIds?: string[], nativeCleanupConfirmed = false): Promise<ApplicationResult> {
    let attempted: RuntimeEntry | undefined
    try {
      const project = await this.project(root)
      const entry = this.entry(project, id)
      attempted = entry
      const admittedRunId = entry.run?.id
      return await this.enqueue(entry, async () => {
        if (project.entries.get(id) !== entry) throw new AppRuntimeError('应用已被删除或重新创建，请刷新', IpcErrorCode.Conflict)
        this.checkRun(entry, expectedRunId)
        if (entry.run?.id !== admittedRunId) throw new AppRuntimeError('排队期间运行实例已变化，请重新核对', IpcErrorCode.Conflict, 'STALE_RUN')
        this.assertTaskImpact(entry, expectedServiceUseIds)
        await this.stopEntry(entry, project, nativeCleanupConfirmed)
        return { ok: true as const, root: entry.root, app: this.summary(entry) }
      })
    } catch (error) { return { ...runtimeFailure(error, root, id), ...(attempted ? { app: this.summary(attempted) } : {}) } }
  }
  private async cleanContained(entry: RuntimeEntry): Promise<void> {
    const container = entry.container
    if (!container || container.owner.generation !== entry.run?.id) throw new AppRuntimeError('原进程容器与运行代次不匹配', IpcErrorCode.Conflict, 'STALE_RUN')
    if (entry.jobOwner) await entry.jobOwner.cleanupAll()
    else if (!await recoverApplicationJob(container)) throw new AppRuntimeError('原运行没有可核验的容器见证，不能认作已清理', IpcErrorCode.Denied, 'CLEANUP_REQUIRED')
  }
  private async stopEntry(entry: RuntimeEntry, project: ProjectEntries, nativeCleanupConfirmed = false): Promise<void> {
    if (!ACTIVE_STATES.has(entry.processState) && !entry.workcopy) return
    entry.stopping = true
    entry.processState = 'stopping'
    entry.cancelProbe?.abort()
    if (entry.monitor) clearInterval(entry.monitor)
    entry.monitor = undefined
    this.emit(entry, 'state')
    const deadline = Date.now() + this.policy(entry).stopTimeoutMs
    const remaining = (): number => { const left = deadline - Date.now(); if (left <= 0) throw new AppRuntimeError('应用停止超时，请核验清理状态后重试', IpcErrorCode.Timeout, 'CLEANUP_REQUIRED'); return left }
    try {
      if (entry.container) {
        await this.cleanContained(entry)
        while (!entry.childClosed && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 30))
        if (!entry.childClosed) throw new AppRuntimeError('原容器句柄尚未关闭，请重试原清理', IpcErrorCode.Timeout, 'CLEANUP_REQUIRED')
        entry.ports = await checkPorts(this.policy(entry).ports)
      } else {
      if (entry.run && !entry.child && !nativeCleanupConfirmed) {
        const originalRoot = entry.identities.find(identity => identity.pid === entry.run?.pid)
        const observed = await processSnapshot(remaining())
        if (!originalRoot || !observed.some(identity => sameProcess(identity, originalRoot))) throw new AppRuntimeError('异常退出后无法确认原进程完整子树；请在系统核对清理后从运行中心恢复', IpcErrorCode.Denied, 'CLEANUP_REQUIRED')
      }
      if (entry.run && !entry.child && entry.identities.length === 0 && !nativeCleanupConfirmed) throw new AppRuntimeError('上次运行缺少可核验的完整进程身份；请从本机运行中心核对清理', IpcErrorCode.Denied, 'CLEANUP_REQUIRED')
      if (entry.run && !entry.child && entry.identities.length === 0 && nativeCleanupConfirmed) {
        const observed = await processSnapshot(remaining())
        if (entry.run.pid && observed.some(row => row.pid === entry.run?.pid || row.parentPid === entry.run?.pid)) throw new AppRuntimeError('原 PID 或其子进程仍存在，不能确认清理；未终止未知进程', IpcErrorCode.Conflict, 'CLEANUP_REQUIRED')
      }
      await this.refreshIdentities(entry, false, remaining())
      if (entry.identities.length === 0 && entry.run?.pid) {
        const snapshot = await processSnapshot(remaining())
        if (!entry.childClosed || snapshot.some((row) => row.pid === entry.run?.pid || row.parentPid === entry.run?.pid)) throw new AppRuntimeError('无法确认进程身份，未向未知进程发送终止信号', IpcErrorCode.Denied, 'CLEANUP_REQUIRED')
      }
      await terminateOwned(entry.identities, entry.run?.pid ?? null, remaining())
      while (!entry.childClosed && Date.now() < deadline) await new Promise((accept) => setTimeout(accept, 50))
      if (!entry.childClosed) throw new AppRuntimeError('进程句柄尚未关闭，不能重启', IpcErrorCode.Timeout, 'CLEANUP_REQUIRED')
      entry.ports = await checkPorts(this.policy(entry).ports, Math.min(1500, remaining()))
      remaining()
      if (entry.ports.some((port) => port.state !== 'available')) throw new AppRuntimeError('停止后端口仍不可用，请检查遗留进程或外部占用', IpcErrorCode.Conflict, 'CLEANUP_REQUIRED')
      }
      await this.releaseUse(entry, project)
      entry.identities = []
      entry.processState = 'stopped'
      entry.pendingApproval = false
      entry.lastError = undefined
      if (entry.run) entry.run.exitedAt ??= Date.now()
      entry.readiness = { state: this.policy(entry).readiness.kind === 'none' ? 'not-configured' : 'unknown', checkedAt: Date.now() }
      entry.outputFlush?.()
      this.persist(project)
      this.emit(entry, 'done')
    } catch (error) {
      entry.processState = 'cleanup-required'
      entry.lastError = error instanceof AppRuntimeError ? error.message : '应用清理未完成，请重试停止'
      this.record(entry, project)
      this.emit(entry, 'state')
      throw error
    } finally { entry.stopping = false }
  }
  private async releaseUse(entry: RuntimeEntry, project: ProjectEntries): Promise<void> {
    const use = entry.workcopy
    if (!use) return
    if (use.lease.owner.generation !== entry.run?.id) throw new AppRuntimeError('旧运行不能释放新实例的工作副本占用', IpcErrorCode.Conflict, 'STALE_RUN')
    await releaseWorkcopyUse(use.root, use.lease, 'cleanup-confirmed')
    if (entry.workcopy?.lease.token === use.lease.token) { entry.workcopy = undefined; entry.stored.consumerMutation = undefined; entry.stored.consumerRemoval = undefined; this.persist(project) }
  }
  private retainOutput(entry: RuntimeEntry): void {
    if (!entry.run) return
    const key = this.instanceKey(entry.root, entry.stored.config.id, entry.run.id)
    this.retainedOutputs.set(key, { root: entry.root, appId: entry.stored.config.id, runId: entry.run.id, output: entry.output, outputBytes: entry.outputBytes, cursor: entry.cursor, outputTruncated: entry.outputTruncated })
    const previous = [...this.retainedOutputs].filter(([, value]) => value.root === entry.root && value.appId === entry.stored.config.id)
    for (const [expired] of previous.slice(0, -APP_RUNTIME_LIMITS.retainedRuns)) {
      const output = this.retainedOutputs.get(expired)
      if (output) this.environments.forgetRun(output.runId)
      this.retainedOutputs.delete(expired)
      this.instanceHandles.delete(expired)
    }
  }
  async logs(root: string, id: string, after?: number, expectedRunId?: string): Promise<ApplicationLogsResult> {
    try {
      const project = await this.project(root)
      const entry = this.entry(project, id)
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new AppRuntimeError('输出游标无效', IpcErrorCode.InvalidArg)
      if (expectedRunId !== undefined && !applicationRunIdSchema.safeParse(expectedRunId).success) throw new AppRuntimeError('运行实例标识无效', IpcErrorCode.InvalidArg)
      const source = expectedRunId === undefined || expectedRunId === entry.run?.id ? entry : this.retainedOutputs.get(this.instanceKey(entry.root, id, expectedRunId))
      if (!source) throw new AppRuntimeError('原实例输出已不可用，请保留原实例信息核对', IpcErrorCode.NotFound, 'LOGS_UNAVAILABLE')
      const first = source.cursor - source.outputBytes
      const skip = after === undefined || after > source.cursor ? 0 : Math.max(0, after - first)
      return { ok: true, root: project.store.root, appId: id, runId: expectedRunId ?? entry.run?.id ?? null, output: Buffer.from(source.output).subarray(skip).toString('utf8').replace(/^\uFFFD+/, ''), outputTruncated: source.outputTruncated || (after !== undefined && (after < first || after > source.cursor)), cursor: source.cursor }
    } catch (error) { return runtimeFailure(error, root, id) }
  }
  async shutdown(): Promise<void> {
    this.closeAdmission()
    try {
      await this.initialize()
      const entries = [...this.loaded.values()].flatMap((project) => [...project.entries.values()].map((entry) => ({ project, entry })))
      const results = await Promise.allSettled(entries.map(({ entry, project }) => this.enqueue(entry, () => this.stopEntry(entry, project))))
      if (results.some((result) => result.status === 'rejected')) throw new AppRuntimeError('部分应用尚未完成清理，请在应用面板核验后重试退出', IpcErrorCode.Io, 'CLEANUP_REQUIRED')
    } catch (error) { throw error instanceof AppRuntimeError ? error : new AppRuntimeError('应用收尾未完成，请检查进程状态后重试', IpcErrorCode.Io, 'CLEANUP_REQUIRED') }
  }
}
