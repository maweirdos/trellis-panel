import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ApplicationConfig, ApplicationListResult, ApplicationLogsResult, ApplicationResult, ApplicationRuntimeEvent, ApplicationSummary, ApplicationSuccess } from '../../../../shared/app-runtime'
import { APP_RUNTIME_LIMITS, applicationConfigSchema, applicationIdSchema, applicationSaveSchema } from '../../../../shared/app-runtime'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { AppRuntimeError, runtimeFailure, type AppOperationOptions, type ProcessIdentity, type ProjectStore, type RuntimeEntry, type StoredApplication } from '../types'
import { canonicalDirectory, listProjectRoots, projectFile, protect, readProject, writeProject } from './persistence'
import { planLaunch } from './launch'
import { checkPorts, diagnosePorts, probeOnce, validateReadiness } from './ports'
import { ownedTree, processSnapshot, sameProcess, spawnOwned, terminateOwned } from './process-tree'
import { boundedTail, outputRedactor } from './output'

const ACTIVE_STATES = new Set(['starting', 'running', 'stopping', 'unknown', 'cleanup-required'])
interface ProjectEntries { store: ProjectStore; entries: Map<string, RuntimeEntry> }
export class ApplicationRuntime {
  private projects = new Map<string, Promise<ProjectEntries>>()
  private loaded = new Map<string, ProjectEntries>()
  private listeners = new Set<(event: ApplicationRuntimeEvent) => void>()
  private admissionClosed = false
  private observation?: { at: number; result: Promise<ProcessIdentity[]> }

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
      const entry: RuntimeEntry = { stored, root, processState: last?.state ?? 'stopped', readiness: { state: 'unknown', checkedAt: null }, run: last ? { id: last.id, pid: last.pid, startedAt: last.startedAt, exitedAt: last.exitedAt, exitCode: last.exitCode, signal: last.signal } : null, ports: stored.config.ports.map((port) => ({ ...port, state: 'unknown' })), identities: last?.identities ?? [], childClosed: true, rootExited: true, pendingApproval: false, output: '', outputBytes: 0, cursor: 0, outputTruncated: last !== undefined, queue: Promise.resolve(), stopping: false }
      if (last && ACTIVE_STATES.has(last.state)) {
        try {
          snapshot ??= await processSnapshot()
          const matches = last.identities.filter((identity) => snapshot?.some((row) => sameProcess(row, identity)))
          const ports = await checkPorts(stored.config.ports)
          entry.ports = ports
          if (matches.length > 0) { entry.identities = ownedTree(snapshot, last.pid ?? 0, matches); entry.processState = 'cleanup-required'; entry.lastError = '上次运行仍有已核验的应用进程，请先停止后再启动' }
          else if (last.identities.length > 0 && ports.every((port) => port.state === 'available')) { entry.processState = 'exited'; entry.run = { ...entry.run, id: last.id, pid: last.pid, startedAt: last.startedAt, exitedAt: Date.now(), exitCode: null, signal: null }; entry.identities = []; entry.lastError = '上次运行已结束；异常退出期间的输出不可恢复' }
          else { entry.processState = 'unknown'; entry.lastError = '无法核验上次运行的完整归属，请核对进程与端口后重试停止' }
        } catch { entry.processState = 'unknown'; entry.lastError = '无法核验上次运行状态，请检查系统进程查询权限' }
      } else if (stored.config.readiness.kind === 'none') entry.readiness.state = 'not-configured'
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
    return { definition: { ...applicationConfigSchema.parse(entry.stored.config), revision: entry.stored.revision, updatedAt: entry.stored.updatedAt, overrideKeys: Object.keys(entry.stored.protectedOverrides) }, processState: entry.processState, readiness: { ...entry.readiness }, run: entry.run ? { ...entry.run } : null, ports: entry.ports.map((port) => ({ ...port })), approval: entry.pendingApproval ? 'pending' : entry.stored.approvedFingerprint ? 'approved' : 'required', ...(entry.lastError ? { lastError: entry.lastError } : {}), canStart: !active && !this.admissionClosed, canStop: active && entry.processState !== 'stopping', canRestart: !['unknown', 'cleanup-required', 'starting', 'stopping'].includes(entry.processState) && !this.admissionClosed }
  }
  private emit(entry: RuntimeEntry, kind: ApplicationRuntimeEvent['kind'], extra: Partial<ApplicationRuntimeEvent> = {}): void {
    const event: ApplicationRuntimeEvent = { kind, root: entry.root, appId: entry.stored.config.id, runId: entry.run?.id ?? null, app: this.summary(entry), ...extra }
    for (const listener of this.listeners) { try { listener(event) } catch { /* A UI observer cannot change process ownership. */ } }
  }
  private persist(project: ProjectEntries): void {
    const applications = [...project.entries.values()].map((entry) => {
      if (entry.run) entry.stored.lastRun = { ...entry.run, state: entry.processState, identities: entry.identities }
      return entry.stored
    })
    writeProject({ schemaVersion: 1, root: project.store.root, applications })
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

  async list(root: string): Promise<ApplicationListResult> {
    try { const project = await this.project(root); return { ok: true, root: project.store.root, apps: [...project.entries.values()].map((entry) => this.summary(entry)) } }
    catch (error) { return runtimeFailure(error, root) }
  }
  async get(root: string, id: string): Promise<ApplicationResult> {
    try { const project = await this.project(root); return { ok: true, root: project.store.root, app: this.summary(this.entry(project, id)) } }
    catch (error) { return runtimeFailure(error, root, id) }
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
        entry = { stored: { config, revision: '', updatedAt: 0, protectedOverrides: {}, overrideRevision: '' }, root: project.store.root, processState: 'stopped', readiness: { state: config.readiness.kind === 'none' ? 'not-configured' : 'unknown', checkedAt: null }, run: null, ports: [], identities: [], childClosed: true, rootExited: true, pendingApproval: false, output: '', outputBytes: 0, cursor: 0, outputTruncated: false, queue: Promise.resolve(), stopping: false }
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
        if (ACTIVE_STATES.has(selected.processState)) throw new AppRuntimeError('请先停止应用，再修改配置', IpcErrorCode.Conflict)
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
        selected.ports = config.ports.map((port) => ({ ...port, state: 'unknown' }))
        selected.readiness = { state: config.readiness.kind === 'none' ? 'not-configured' : 'unknown', checkedAt: null }
        try { this.persist(project) } catch (error) { selected.stored = previous; if (!previous.revision) project.entries.delete(config.id); throw error }
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
    try {
      this.checkAdmission()
      const project = await this.project(root)
      const entry = this.entry(project, id)
      return await this.enqueue(entry, async () => {
        if (project.entries.get(id) !== entry) throw new AppRuntimeError('应用已被删除或重新创建，请刷新', IpcErrorCode.Conflict)
        this.checkAdmission()
        if (options.expectedRevision && options.expectedRevision !== entry.stored.revision) throw new AppRuntimeError('应用配置已变更，请刷新后重试', IpcErrorCode.Conflict)
        if (action === 'start' && entry.processState === 'running') return { ok: true as const, root: entry.root, app: this.summary(entry) }
        if (entry.processState === 'unknown' || entry.processState === 'cleanup-required') throw new AppRuntimeError('上次运行尚未完成清理，请先停止并核验', IpcErrorCode.Conflict, 'CLEANUP_REQUIRED')
        let plan = planLaunch(entry.root, entry.stored)
        if (entry.stored.approvedFingerprint !== plan.fingerprint) {
          if (!entry.pendingApproval) { entry.pendingApproval = true; this.emit(entry, 'attention') }
          if (!options.confirm) throw new AppRuntimeError('请在应用面板中确认首次启动或变更后的命令', IpcErrorCode.Denied, 'APPROVAL_REQUIRED')
          const revision = entry.stored.revision
          const fingerprint = plan.fingerprint
          const accepted = await options.confirm({ root: entry.root, appId: id, revision, name: entry.stored.config.name, cwd: plan.cwd, command: plan.command, envFiles: [...plan.envFiles], overrideKeys: Object.keys(entry.stored.protectedOverrides), ports: entry.stored.config.ports, action })
          entry.pendingApproval = false
          if (!accepted) { this.emit(entry, 'state'); throw new AppRuntimeError('已取消应用启动', IpcErrorCode.Denied) }
          this.checkAdmission()
          plan = planLaunch(entry.root, entry.stored)
          if (revision !== entry.stored.revision || fingerprint !== plan.fingerprint) throw new AppRuntimeError('启动配置在确认期间已变化，请重新确认', IpcErrorCode.Conflict)
          entry.stored.approvedFingerprint = fingerprint
          entry.stored.approvedAt = Date.now()
          this.persist(project)
        }
        if (action === 'restart' && ACTIVE_STATES.has(entry.processState)) await this.stopEntry(entry, project)
        this.checkAdmission()
        // Stop and human review can take time; env values and executable resolution are live inputs.
        plan = planLaunch(entry.root, entry.stored)
        if (plan.fingerprint !== entry.stored.approvedFingerprint) throw new AppRuntimeError('启动内容已变化，请重新确认', IpcErrorCode.Denied, 'APPROVAL_REQUIRED')
        entry.ports = await diagnosePorts(entry.stored.config.ports)
        if (entry.ports.some((port) => port.state !== 'available')) {
          entry.processState = 'failed'
          entry.lastError = '声明端口被占用或不可用，请检查冲突后重试'
          this.emit(entry, 'state')
          throw new AppRuntimeError(entry.lastError, IpcErrorCode.Conflict, 'PORT_CONFLICT')
        }
        await this.spawn(entry, project, plan)
        return { ok: true as const, root: entry.root, app: this.summary(entry) }
      })
    } catch (error) { return runtimeFailure(error, root, id) }
  }

  private async spawn(entry: RuntimeEntry, project: ProjectEntries, plan: ReturnType<typeof planLaunch>): Promise<void> {
    this.checkAdmission()
    entry.cancelProbe?.abort()
    entry.processState = 'starting'
    entry.pendingApproval = false
    entry.lastError = undefined
    entry.output = ''; entry.outputBytes = 0; entry.cursor = 0; entry.outputTruncated = false
    entry.identities = []
    entry.child = undefined
    entry.childClosed = true
    entry.rootExited = true
    entry.launchExecutable = plan.executable
    entry.run = { id: randomUUID(), pid: null, startedAt: Date.now(), exitedAt: null, exitCode: null, signal: null }
    entry.readiness = { state: entry.stored.config.readiness.kind === 'none' ? 'not-configured' : 'checking', checkedAt: null }
    try { this.persist(project) }
    catch (error) {
      entry.processState = 'failed'
      entry.run.exitedAt = Date.now()
      entry.lastError = '启动记录未能保存，应用未启动'
      this.emit(entry, 'state')
      throw error
    }
    const runId = entry.run.id
    let child: RuntimeEntry['child']
    try { child = spawnOwned(plan.executable, plan.args, plan.cwd, plan.env) }
    catch {
      entry.processState = 'failed'
      entry.run.exitedAt = Date.now()
      entry.lastError = '无法启动应用程序'
      this.record(entry, project)
      this.emit(entry, 'state')
      throw new AppRuntimeError(entry.lastError, IpcErrorCode.Io)
    }
    entry.child = child
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
        await this.refreshIdentities(entry)
        if (entry.identities.length > 0) { entry.processState = 'cleanup-required'; entry.lastError = '启动进程已退出，但仍有应用子进程需要停止' }
        else if (entry.processState !== 'cleanup-required' && entry.processState !== 'unknown') { entry.processState = code === 0 && !signal ? 'exited' : 'failed'; if (entry.processState === 'failed') entry.lastError ??= `应用已退出（${signal ?? code ?? '未知原因'}）` }
        entry.readiness = { state: entry.stored.config.readiness.kind === 'none' ? 'not-configured' : 'unknown', checkedAt: Date.now() }
        if (entry.monitor) clearInterval(entry.monitor)
        entry.monitor = undefined
        this.record(entry, project); this.emit(entry, 'done')
      })
    })
    // Record the spawned PID before a potentially slow system identity query.
    this.record(entry, project)
    await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', () => reject(new AppRuntimeError('无法启动应用程序', IpcErrorCode.Io))) })
    entry.processState = 'running'
    await this.refreshIdentities(entry)
    entry.ports = await diagnosePorts(entry.stored.config.ports, entry.identities.map((identity) => identity.pid))
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
        const ports = await diagnosePorts(entry.stored.config.ports, entry.identities.map((identity) => identity.pid))
        if (entry.run?.id !== runId || entry.stopping) return
        let refreshedReadiness = false
        const probe = entry.stored.config.readiness
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
      if (entry.child && (entry.rootExited || entry.childClosed) && entry.identities.length === 0 && snapshot.some((row) => row.parentPid === pid)) {
        entry.processState = 'cleanup-required'
        entry.lastError = '启动进程在身份核验前退出，无法确认其子进程归属'
      }
      const changed = JSON.stringify(entry.identities) !== JSON.stringify(current)
      entry.identities = current
      return changed
    } catch {
      if (entry.run?.id !== runId || cacheObservation && (entry.stopping || entry.processState !== 'running')) return false
      entry.processState = 'cleanup-required'; entry.lastError = '无法核验应用进程身份；停止前将再次核验'; this.emit(entry, 'state'); return false
    }
  }
  private startReadiness(entry: RuntimeEntry, runId: string): void {
    const probe = entry.stored.config.readiness
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
        const ports = await diagnosePorts(entry.stored.config.ports, entry.identities.map((identity) => identity.pid))
        if (cancellation.signal.aborted || entry.run?.id !== runId) return
        entry.ports = ports
      }
      this.emit(entry, 'state')
    })()
  }
  async stop(root: string, id: string): Promise<ApplicationResult> {
    try {
      const project = await this.project(root)
      const entry = this.entry(project, id)
      return await this.enqueue(entry, async () => {
        if (project.entries.get(id) !== entry) throw new AppRuntimeError('应用已被删除或重新创建，请刷新', IpcErrorCode.Conflict)
        await this.stopEntry(entry, project)
        return { ok: true as const, root: entry.root, app: this.summary(entry) }
      })
    } catch (error) { return runtimeFailure(error, root, id) }
  }
  private async stopEntry(entry: RuntimeEntry, project: ProjectEntries): Promise<void> {
    if (!ACTIVE_STATES.has(entry.processState)) return
    entry.stopping = true
    entry.processState = 'stopping'
    entry.cancelProbe?.abort()
    if (entry.monitor) clearInterval(entry.monitor)
    entry.monitor = undefined
    this.emit(entry, 'state')
    const deadline = Date.now() + entry.stored.config.stopTimeoutMs
    const remaining = (): number => { const left = deadline - Date.now(); if (left <= 0) throw new AppRuntimeError('应用停止超时，请核验清理状态后重试', IpcErrorCode.Timeout, 'CLEANUP_REQUIRED'); return left }
    try {
      if (entry.run && !entry.child && entry.identities.length === 0) throw new AppRuntimeError('上次运行缺少可核验的进程身份，不能确认已停止', IpcErrorCode.Denied, 'CLEANUP_REQUIRED')
      await this.refreshIdentities(entry, false, remaining())
      if (entry.identities.length === 0 && entry.run?.pid) {
        const snapshot = await processSnapshot(remaining())
        if (!entry.childClosed || snapshot.some((row) => row.pid === entry.run?.pid || row.parentPid === entry.run?.pid)) throw new AppRuntimeError('无法确认进程身份，未向未知进程发送终止信号', IpcErrorCode.Denied, 'CLEANUP_REQUIRED')
      }
      await terminateOwned(entry.identities, entry.run?.pid ?? null, remaining())
      while (!entry.childClosed && Date.now() < deadline) await new Promise((accept) => setTimeout(accept, 50))
      if (!entry.childClosed) throw new AppRuntimeError('进程句柄尚未关闭，不能重启', IpcErrorCode.Timeout, 'CLEANUP_REQUIRED')
      entry.ports = await checkPorts(entry.stored.config.ports, Math.min(1500, remaining()))
      remaining()
      if (entry.ports.some((port) => port.state !== 'available')) throw new AppRuntimeError('停止后端口仍不可用，请检查遗留进程或外部占用', IpcErrorCode.Conflict, 'CLEANUP_REQUIRED')
      entry.identities = []
      entry.processState = 'stopped'
      entry.pendingApproval = false
      entry.lastError = undefined
      if (entry.run) entry.run.exitedAt ??= Date.now()
      entry.readiness = { state: entry.stored.config.readiness.kind === 'none' ? 'not-configured' : 'unknown', checkedAt: Date.now() }
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
  async logs(root: string, id: string, after?: number): Promise<ApplicationLogsResult> {
    try {
      const project = await this.project(root)
      const entry = this.entry(project, id)
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new AppRuntimeError('输出游标无效', IpcErrorCode.InvalidArg)
      const first = entry.cursor - entry.outputBytes
      const skip = after === undefined || after > entry.cursor ? 0 : Math.max(0, after - first)
      return { ok: true, root: project.store.root, appId: id, runId: entry.run?.id ?? null, output: Buffer.from(entry.output).subarray(skip).toString('utf8').replace(/^\uFFFD+/, ''), outputTruncated: entry.outputTruncated || (after !== undefined && (after < first || after > entry.cursor)), cursor: entry.cursor }
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
