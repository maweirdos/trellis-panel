import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as Effect from 'effect/Effect'
import { DaemonError } from '../../../daemon/errors'
import { pathKey } from '../../task-conversations/lib/paths'
import { DriverDescriptorCache, bundledFallbackDescriptor } from '../providers/core/descriptor-cache'
import { resolveCodexCommand } from '../providers/codex/driver'
import { resolveClaudeSdkExecutablePath } from '../providers/claude/ClaudeAdapterV2'
import type { CodexWorktreeWriter } from '../providers/codex/process-owner'
import type {
  ConversationDriverDescriptor,
  ConversationDriverModel,
  ConversationDriverRegistration,
  ConversationDriverRegistry,
  ConversationDriverSession,
} from '../providers/registry'
import { awaitDeadline, runBounded } from './EffectWorker'

export interface DriverIdentity {
  readonly projectId: string
  readonly fingerprint: string
  readonly bindingFingerprint: string
  readonly ordinaryTask: boolean
  readonly ownerScope?: string
  readonly managedExecution?: true
  readonly worktreeWriter?: CodexWorktreeWriter & { readonly projectRoot: string }
}

export interface OwnedDriverSlot {
  readonly root: string
  readonly projectRoot?: string
  readonly driver: ConversationDriverSession
}

export interface LoadedThreadHandle {
  readonly driver: ConversationDriverSession
  readonly nativeThreadId: string
}

export interface DriverOpeningEntry extends DriverIdentity {
  readonly root: string
  readonly opening: Promise<ConversationDriverSession>
  background?: boolean
}

export interface ProviderSessionManagerPorts {
  readonly directory: string
  readonly driverRegistry: ConversationDriverRegistry
  readonly deadlines: { readonly open: number; readonly thread: number; readonly close: number }
  readonly shutdownSignal: AbortSignal
  isClosing(): boolean
  assertOwner(): void
  hasActiveTurnForDriver(driver: ConversationDriverSession): boolean
}

export const driverSlotKey = (instanceId: string, cwd: string, ownerScope?: string): string =>
  JSON.stringify(ownerScope === undefined ? [instanceId, pathKey(cwd)] : [instanceId, pathKey(cwd), ownerScope])

/**
 * 统一管理对话引擎进程池、后台预热、稳定账号/配置指纹、内存原生线程句柄及受控关闭。
 * 保持与具体业务命令解耦，便于后续演进 SessionTransitionPolicy 与多引擎模式切换。
 */
export class ProviderSessionManager {
  readonly processes = new Map<string, OwnedDriverSlot>()
  readonly ready = new Map<string, DriverIdentity & { driver: ConversationDriverSession }>()
  readonly driverOpenings = new Map<string, DriverOpeningEntry>()
  readonly driverFence = new AsyncLocalStorage<() => void>()
  readonly loadedThreads = new Map<string, LoadedThreadHandle>()
  readonly preparingDrivers = new Map<ConversationDriverSession, number>()
  readonly uncertainDrivers = new WeakSet<ConversationDriverSession>()
  readonly closingDrivers = new WeakMap<ConversationDriverSession, Promise<void>>()
  readonly verifiedDeletionCloses = new WeakMap<ConversationDriverSession, string>()
  private readonly descriptorCache: DriverDescriptorCache
  private readonly backgroundPrewarms = new Set<string>()

  constructor(private readonly ports: ProviderSessionManagerPorts) {
    this.descriptorCache = new DriverDescriptorCache(ports.directory)
  }

  configurationFingerprint(registration: ConversationDriverRegistration): string {
    return createHash('sha256').update(JSON.stringify([registration.driverKind, registration.configurationKey?.() ?? null])).digest('hex')
  }

  bindingFingerprint(registration: ConversationDriverRegistration): string {
    const key = registration.bindingKey ? registration.bindingKey() : registration.configurationKey?.()
    return `v2:${createHash('sha256').update(JSON.stringify([registration.driverKind, key ?? null])).digest('hex')}`
  }

  bindingFingerprintMatches(stored: string | null | undefined, expected: string): boolean {
    if (!stored || stored === expected) return true
    // 升级前写入数据库的旧版指纹无 v2: 前缀，受文件时间戳/OAuth token 刷新影响易失配；
    // 放行旧版绑定并在下次 markDispatched 时原子升级为稳定的 v2: 账号绑定指纹。
    return !stored.startsWith('v2:')
  }

  assertDriverFingerprint(instanceId: string, expected: string): void {
    const registration = this.ports.driverRegistry.get(instanceId)
    if (!registration || this.configurationFingerprint(registration) !== expected) {
      throw new DaemonError('E_CONFLICT', '对话引擎的原配置已变化。')
    }
  }

  assertBindingFingerprint(instanceId: string, expected: string): void {
    const registration = this.ports.driverRegistry.get(instanceId)
    if (!registration || !this.bindingFingerprintMatches(expected, this.bindingFingerprint(registration))) {
      throw new DaemonError('E_CONFLICT', '对话引擎的原配置已变化。')
    }
  }

  requireDriver(instanceId: string, ordinaryTask: boolean): ConversationDriverRegistration {
    const registration = this.ports.driverRegistry.require(instanceId)
    if (ordinaryTask && !registration.ordinaryTaskAccess) {
      throw new DaemonError('E_UNAVAILABLE', '此引擎未确认普通任务所需的只读或工具限制。')
    }
    return registration
  }

  pinPreparation(driver: ConversationDriverSession): () => void {
    this.preparingDrivers.set(driver, (this.preparingDrivers.get(driver) ?? 0) + 1)
    return () => {
      const remaining = (this.preparingDrivers.get(driver) ?? 1) - 1
      if (remaining) this.preparingDrivers.set(driver, remaining)
      else this.preparingDrivers.delete(driver)
    }
  }

  async ensureDriver(
    cwd: string,
    projectId: string,
    registration: ConversationDriverRegistration,
    assertCurrent: () => void,
    ordinaryTask = false,
    ownerScope?: string,
    managedExecution?: true,
    worktreeWriter?: DriverIdentity['worktreeWriter'],
    background = false,
  ): Promise<{ readonly driver: ConversationDriverSession; readonly unpin: () => void }> {
    this.ports.assertOwner()
    if (this.ports.isClosing()) {
      throw new DaemonError('E_UNAVAILABLE', 'Conversation admission is closed while the kernel shuts down.')
    }
    const key = driverSlotKey(registration.instanceId, cwd, ownerScope)
    const fingerprint = this.configurationFingerprint(registration)
    const bindingFingerprint = this.bindingFingerprint(registration)
    const assertConfiguration = (): void => {
      const current = this.ports.driverRegistry.get(registration.instanceId)
      if (!current || current.driverKind !== registration.driverKind
        || !this.bindingFingerprintMatches(bindingFingerprint, this.bindingFingerprint(current))) {
        throw new DaemonError('E_CONFLICT', '对话引擎的原配置已变化，请重新选择已授权的配置。')
      }
    }
    assertCurrent()
    assertConfiguration()
    const owned = this.processes.get(key)
    if (owned && (this.closingDrivers.has(owned.driver) || this.verifiedDeletionCloses.has(owned.driver))) {
      throw new DaemonError('E_BUSY', '原引擎的关闭尚未确认完成。')
    }
    const reserve = (driver: ConversationDriverSession) => ({ driver, unpin: this.pinPreparation(driver) })
    const matches = (identity: DriverIdentity): boolean =>
      identity.projectId === projectId && identity.fingerprint === fingerprint && identity.bindingFingerprint === bindingFingerprint
      && identity.ordinaryTask === ordinaryTask && identity.managedExecution === managedExecution
      && identity.worktreeWriter?.expected.id === worktreeWriter?.expected.id
    const ready = this.ready.get(key)
    if (ready && matches(ready) && ready.driver.isAvailable() && !this.uncertainDrivers.has(ready.driver)) {
      return reserve(ready.driver)
    }
    const existing = this.driverOpenings.get(key)
    if (existing) {
      if (!matches(existing)) {
        throw new DaemonError('E_BUSY', '原目录或配置的引擎启动尚未结束。')
      }
      if (!background && existing.background) existing.background = false
      const driver = await existing.opening
      assertCurrent()
      assertConfiguration()
      return reserve(driver)
    }
    const identity: DriverIdentity = { projectId, fingerprint, bindingFingerprint, ordinaryTask, ownerScope, managedExecution, worktreeWriter }
    const opening = Promise.resolve().then(() => this.runOpenDriver(key, cwd, identity, registration, assertConfiguration, assertCurrent))
    this.driverOpenings.set(key, { root: cwd, ...identity, opening, ...(background ? { background: true } : {}) })
    const driver = await opening
    assertCurrent()
    assertConfiguration()
    return reserve(driver)
  }

  private async runOpenDriver(
    key: string,
    cwd: string,
    identity: DriverIdentity,
    registration: ConversationDriverRegistration,
    assertConfiguration: () => void,
    assertCurrent: () => void,
  ): Promise<ConversationDriverSession> {
    let ownedByOpening: OwnedDriverSlot | undefined
    let openPhase: 'opening' | 'ready' | 'abandoned' = 'opening'
    try {
      const owned = this.processes.get(key)
      if (owned) {
        if (this.preparingDrivers.has(owned.driver) || this.ports.hasActiveTurnForDriver(owned.driver)) {
          throw new DaemonError('E_BUSY', '同目录的引擎仍由原运行持有。')
        }
        await this.closeOwned(key, owned)
      }
      if (this.ports.isClosing()) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission closed while the engine was starting.')
      assertConfiguration()
      assertCurrent()
      const driver = await runBounded(registration.open({
        instanceId: registration.instanceId,
        ownerScope: identity.ownerScope,
        managedExecution: identity.managedExecution,
        worktreeWriter: identity.worktreeWriter,
        directory: this.ports.directory,
        cwd,
        ...(identity.ordinaryTask && { ordinaryTask: true as const }),
        assertCanSpawn: () => {
          this.ports.assertOwner()
          if (this.ports.isClosing() || openPhase === 'abandoned') {
            throw new DaemonError('E_UNAVAILABLE', 'Conversation admission closed while the engine was starting.')
          }
          assertConfiguration()
          if (openPhase === 'opening') {
            assertCurrent()
            return
          }
          const fence = this.driverFence.getStore()
          if (!fence || this.ready.get(key)?.driver !== ownedByOpening?.driver) {
            throw new DaemonError('E_DENIED', '引擎启动操作缺少当前工程授权。')
          }
          fence()
        },
        onSpawn: spawned => {
          const slot: OwnedDriverSlot = { root: cwd, driver: spawned, projectRoot: identity.worktreeWriter?.projectRoot }
          ownedByOpening = slot
          if (this.processes.has(key)) throw new DaemonError('E_BUSY', '引擎目录仍由原进程持有。')
          this.processes.set(key, slot)
          if (this.ports.isClosing() || openPhase === 'abandoned') void this.closeOwned(key, slot).catch(() => {})
        },
      }), this.ports.deadlines.open, '启动会话引擎', this.ports.shutdownSignal)
      if (this.ports.isClosing()) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission closed while the engine was starting.')
      assertConfiguration()
      assertCurrent()
      if (ownedByOpening?.driver !== driver) throw new DaemonError('E_CONFLICT', '引擎握手和本机所有者不一致。')
      this.ready.set(key, { ...identity, driver })
      openPhase = 'ready'
      return driver
    } catch (error) {
      openPhase = 'abandoned'
      if (ownedByOpening) await this.closeOwned(key, ownedByOpening).catch(() => {})
      throw error
    } finally {
      this.driverOpenings.delete(key)
    }
  }

  closeOwned(
    key: string,
    owned: { root: string; driver: ConversationDriverSession },
    deletion?: { readonly commandId: string; verify(): void; record(): void },
  ): Promise<void> {
    let closing = this.closingDrivers.get(owned.driver)
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        deletion?.verify()
        if (!deletion || this.verifiedDeletionCloses.get(owned.driver) !== deletion.commandId) {
          await Effect.runPromise(owned.driver.close())
        }
        if (deletion) {
          this.verifiedDeletionCloses.set(owned.driver, deletion.commandId)
          deletion.record()
          this.verifiedDeletionCloses.delete(owned.driver)
        }
        if (this.processes.get(key) === owned) {
          this.processes.delete(key)
          this.ready.delete(key)
        }
        for (const [threadId, loaded] of this.loadedThreads) {
          if (loaded.driver === owned.driver) this.loadedThreads.delete(threadId)
        }
      }).finally(() => this.closingDrivers.delete(owned.driver))
      this.closingDrivers.set(owned.driver, closing)
    }
    return awaitDeadline(closing, this.ports.deadlines.close, '关闭原引擎进程')
  }

  async listModels(
    cwd: string,
    projectId: string,
    instanceId: string,
    assertCurrent: () => void,
    ordinaryTask = false,
  ): Promise<readonly ConversationDriverModel[]> {
    const registration = this.requireDriver(instanceId, ordinaryTask)
    const bindingFingerprint = this.bindingFingerprint(registration)
    const { driver, unpin } = await this.ensureDriver(cwd, projectId, registration, assertCurrent, ordinaryTask)
    try {
      assertCurrent()
      const models = await this.driverFence.run(assertCurrent, () => runBounded(driver.listModels(), this.ports.deadlines.thread, '读取模型'))
      assertCurrent()
      this.assertBindingFingerprint(instanceId, bindingFingerprint)
      return models
    } finally {
      unpin()
    }
  }

  async describeDriver(
    cwd: string,
    projectId: string,
    instanceId: string,
    assertCurrent: () => void,
    ordinaryTask = false,
    ownerScope?: string,
  ): Promise<ConversationDriverDescriptor> {
    assertCurrent()
    const registration = this.requireDriver(instanceId, ordinaryTask)
    const fingerprint = this.configurationFingerprint(registration)
    const bindingFingerprint = this.bindingFingerprint(registration)
    const cacheLookup = {
      instanceId, driverKind: registration.driverKind, cwd, ordinaryTask, ownerScope, configurationFingerprint: fingerprint,
    }
    const key = driverSlotKey(registration.instanceId, cwd, ownerScope)
    const liveReady = this.ready.get(key)
    const hasLiveReady = liveReady !== undefined
      && liveReady.projectId === projectId
      && liveReady.fingerprint === fingerprint
      && liveReady.bindingFingerprint === bindingFingerprint
      && liveReady.ordinaryTask === ordinaryTask
      && liveReady.driver.isAvailable()
      && !this.uncertainDrivers.has(liveReady.driver)

    if (!hasLiveReady) {
      const cached = this.descriptorCache.load(cacheLookup)
      if (cached) {
        if (!ordinaryTask && ownerScope === undefined) {
          this.descriptorCache.recordRecentSlot({ cwd, projectId, instanceId })
        }
        this.scheduleBackgroundDriverPrewarm(cwd, projectId, instanceId, registration, fingerprint, ordinaryTask, ownerScope)
        return cached
      }
      if (!ordinaryTask && ownerScope === undefined && await this.isDriverCliInstalled(registration.driverKind)) {
        const fallback = bundledFallbackDescriptor(registration.driverKind, registration.configurationKey?.() ?? fingerprint)
        if (fallback) {
          this.descriptorCache.recordRecentSlot({ cwd, projectId, instanceId })
          this.scheduleBackgroundDriverPrewarm(cwd, projectId, instanceId, registration, fingerprint, ordinaryTask, ownerScope)
          return fallback
        }
      }
    }

    const { driver, unpin } = await this.ensureDriver(cwd, projectId, registration, assertCurrent, ordinaryTask, ownerScope)
    try {
      assertCurrent()
      if (!driver.describe) throw new DaemonError('E_UNAVAILABLE', '当前对话驱动没有已验证的能力目录。')
      const describe = driver.describe.bind(driver)
      const result = await this.driverFence.run(assertCurrent, () => runBounded(describe(), this.ports.deadlines.thread, '读取引擎能力'))
      assertCurrent()
      this.assertBindingFingerprint(instanceId, bindingFingerprint)
      const latestRegistration = this.ports.driverRegistry.get(instanceId)
      if (latestRegistration && this.configurationFingerprint(latestRegistration) === fingerprint) {
        this.descriptorCache.save(cacheLookup, result)
      }
      if (!ordinaryTask && ownerScope === undefined) {
        this.descriptorCache.recordRecentSlot({ cwd, projectId, instanceId })
      }
      return result
    } finally {
      unpin()
    }
  }

  private scheduleBackgroundDriverPrewarm(
    cwd: string,
    projectId: string,
    instanceId: string,
    registration: ConversationDriverRegistration,
    fingerprint: string,
    ordinaryTask: boolean,
    ownerScope?: string,
  ): void {
    if (this.ports.isClosing()) return
    const key = driverSlotKey(registration.instanceId, cwd, ownerScope)
    if (this.backgroundPrewarms.has(key) || this.driverOpenings.has(key)) return
    this.backgroundPrewarms.add(key)
    const assertBackgroundCurrent = (): void => {
      this.ports.assertOwner()
      if (this.ports.isClosing()) throw new DaemonError('E_UNAVAILABLE', 'Conversation kernel is shutting down.')
      this.assertDriverFingerprint(instanceId, fingerprint)
    }
    setImmediate(() => {
      void (async () => {
        try {
          if (this.ports.isClosing()) return
          const { driver, unpin } = await this.ensureDriver(cwd, projectId, registration, assertBackgroundCurrent, ordinaryTask, ownerScope, undefined, undefined, true)
          try {
            if (this.ports.isClosing() || !driver.describe) return
            const describe = driver.describe.bind(driver)
            const result = await this.driverFence.run(assertBackgroundCurrent, () => runBounded(describe(), this.ports.deadlines.thread, '预热引擎能力'))
            assertBackgroundCurrent()
            this.descriptorCache.save(
              { instanceId, driverKind: registration.driverKind, cwd, ordinaryTask, ownerScope, configurationFingerprint: fingerprint },
              result,
            )
          } finally {
            unpin()
          }
        } catch {
          // 后台预热失败静默忽略；用户实际发消息或主动刷新时会走正常前台错误反馈。
        } finally {
          this.backgroundPrewarms.delete(key)
        }
      })()
    })
  }

  private async isDriverCliInstalled(driverKind: string): Promise<boolean> {
    try {
      if (driverKind === 'codex') {
        await resolveCodexCommand(process.env)
        return true
      }
      if (driverKind === 'claudeCode') {
        resolveClaudeSdkExecutablePath(process.env)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  prewarmRecentDrivers(defaults: ReadonlyArray<{ cwd: string; projectId: string; instanceId: string }> = []): void {
    if (this.ports.isClosing()) return
    const combined = [...this.descriptorCache.listRecentSlots(), ...defaults]
    const seen = new Set<string>()
    let scheduled = 0
    for (const slot of combined) {
      if (scheduled >= 2) break
      const slotKey = `${pathKey(slot.cwd)}\0${slot.instanceId}`
      if (seen.has(slotKey)) continue
      seen.add(slotKey)
      if (!existsSync(slot.cwd)) continue
      const registration = this.ports.driverRegistry.get(slot.instanceId)
      if (!registration) continue
      const fingerprint = this.configurationFingerprint(registration)
      this.scheduleBackgroundDriverPrewarm(slot.cwd, slot.projectId, slot.instanceId, registration, fingerprint, false)
      scheduled += 1
    }
  }

  foregroundOpeningCount(): number {
    let count = 0
    for (const opening of this.driverOpenings.values()) {
      if (!opening.background) count += 1
    }
    return count
  }

  ownsWorkspace(within: (path: string) => boolean): boolean {
    return [...this.driverOpenings.values()].some(entry => within(entry.root)
      || (entry.worktreeWriter !== undefined && within(entry.worktreeWriter.projectRoot)))
      || [...this.processes.values()].some(owned => within(owned.root)
        || (owned.projectRoot !== undefined && within(owned.projectRoot)))
  }

  closeAllOwned(): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([...this.processes.entries()].map(([key, owned]) => this.closeOwned(key, owned)))
  }

  openingPromises(): Promise<ConversationDriverSession>[] {
    return [...this.driverOpenings.values()].map(entry => entry.opening)
  }
}
