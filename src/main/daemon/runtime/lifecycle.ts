import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import type { RuntimeCommands } from './commands'
import type { RuntimeEvents } from './events'
import { projectDaemonActivity, sessionActivity } from './activity'
import type { DaemonActivity } from '../../../shared/daemon/lifecycle'
import { DaemonError } from '../errors'
import type { RuntimeAdmissionPort } from './admission'

export interface RuntimeLifecyclePorts {
  acp: RuntimeLifecycleAcpPort
  commands: RuntimeCommands
  events: RuntimeEvents
  taskProgress: { busy(): boolean; close(): Promise<void> | void }
  taskExecutions: { busy(): boolean; shutdown(): Promise<void> | void; ownsWorkspace(root: string): boolean }
  workcopies: RuntimeWorkcopyLifecyclePort
  materialTimers: Map<string, ReturnType<typeof setTimeout>>
  watchers: Map<string, import('chokidar').FSWatcher>
  conversationProjections: { close(): void }
  /** The new conversation kernel owns Codex child processes and must release them on quit. */
  conversation: { shutdown(): Promise<void>; activityCount(): number; ownsWorkspace(within: (path: string) => boolean): boolean }
  stopKnowledgeReads(): void
  processRecoveryReady: Promise<void>
  disposeEvents(): void
  workflow: RuntimeWorkflowLifecyclePort
  setWorkflowAdmissionClosed(closed: boolean): void
  canonicalDirectory(root: string): string
  workcopyFacts(root: string): unknown[]
}

export interface RuntimeLifecycleAcpPort {
  listOwnedAcpSessionFacts(): Array<Parameters<typeof sessionActivity>[0]>
  closeAcpAdmission(): void
  cancelAcpSession(root: string, sessionId: string): Promise<unknown>
  shutdownAcp(): Promise<void>
}

export interface RuntimeWorkcopyLifecyclePort {
  facts(root?: unknown): unknown[]
  agentLeases(): Array<{ token: string; state: string; owner: { label: string; generation: string }; identity: { id: string }; acquiredAt: number }>
}

export interface RuntimeWorkflowLifecyclePort {
  countOwned(root?: string): Promise<number>
  hasAny(): Promise<boolean>
  shutdownAll(): Promise<void>
}

export interface RuntimeLifecycleState {
  closed(): boolean
  released(): boolean
  stopping(): Promise<void> | undefined
  setStopping(stopping: Promise<void> | undefined): void
  setClosed(): void
  setReleased(): void
  operations(): number
  setOperations(value: number): void
  sessionAdmissions(): number
  setSessionAdmissions(value: number): void
}

export interface RuntimeStatus {
  authority: 'legacy' | 'daemon'
  admission: 'open' | 'closed'
  sessions: number
  workflows: number
  operations: number
  released: boolean
  reason?: string
}

export interface RuntimeBlocker {
  domain: 'runtime' | 'workflow' | 'application' | 'work-copy'
  state: 'active' | 'unknown'
  label: string
  rootId?: string
  ownerGeneration?: string
  acquiredAt?: number
  leaseId?: string
  owner?: unknown
}

export class LifecycleService {
  constructor(
    private readonly ports: RuntimeLifecyclePorts,
    private readonly state: RuntimeLifecycleState,
    private readonly authority: Pick<RuntimeAdmissionPort, 'assertOwner' | 'assertAuthority'>,
  ) {}

  activity(): DaemonActivity {
    const snapshot = projectDaemonActivity(this.ports.acp.listOwnedAcpSessionFacts(), this.state.operations() + this.ports.commands.count() + this.ports.conversation.activityCount())
    return this.state.sessionAdmissions() && snapshot.state === 'idle' ? { ...snapshot, state: 'interruptible' } : snapshot
  }

  async status(): Promise<RuntimeStatus> {
    await this.ports.processRecoveryReady
    this.authority.assertOwner()
    let authority: 'legacy' | 'daemon' = 'daemon'
    let reason: string | undefined
    try {
      this.authority.assertAuthority()
    } catch {
      authority = 'legacy'
      reason = 'Runtime/settings authority preparation has not completed.'
    }
    return {
      authority,
      admission: this.state.closed() || authority !== 'daemon' ? 'closed' : 'open',
      sessions: this.ports.acp.listOwnedAcpSessionFacts().length,
      workflows: await this.ports.workflow.countOwned(),
      operations: this.ports.commands.count() + this.ports.conversation.activityCount(),
      released: this.state.released(),
      ...(reason ? { reason } : {}),
    }
  }

  async blockers(): Promise<RuntimeBlocker[]> {
    const owned = this.ports.acp.listOwnedAcpSessionFacts()
      .filter(session => sessionActivity(session) !== 'idle')
      .map(session => ({
        domain: 'runtime' as const,
        state: sessionActivity(session) === 'uncertain' ? 'unknown' as const : 'active' as const,
        label: session.title?.trim().slice(0, 200) || '未命名会话',
        ownerGeneration: session.connectionGeneration ?? undefined,
      }))
    const workflows = await this.ports.workflow.countOwned()
    return [
      ...owned,
      ...workflows > 0 ? [{ domain: 'workflow' as const, state: 'active' as const, label: `Owned workflows (${workflows})` }] : [],
      ...this.state.operations() > 0 ? [{ domain: 'application' as const, state: 'active' as const, label: `Runtime operations (${this.state.operations()})` }] : [],
      ...this.ports.commands.count() > 0 ? [{ domain: 'application' as const, state: 'unknown' as const, label: 'Pending runtime command receipts' }] : [],
      ...this.ports.conversation.activityCount() > 0 ? [{ domain: 'runtime' as const, state: 'active' as const, label: '原生会话运行中' }] : [],
      ...this.ports.taskProgress.busy() ? [{ domain: 'application' as const, state: 'active' as const, label: 'Task progress work' }] : [],
      ...this.ports.taskExecutions.busy() ? [{ domain: 'application' as const, state: 'active' as const, label: 'Native task execution' }] : [],
      ...this.ports.workcopies.agentLeases().map(({ token, ...use }) => ({
        domain: 'work-copy' as const,
        state: use.state === 'unknown' ? 'unknown' as const : 'active' as const,
        label: use.owner.label,
        rootId: use.identity.id,
        ownerGeneration: use.owner.generation,
        acquiredAt: use.acquiredAt,
        leaseId: createHash('sha256').update(token).digest('hex'),
        owner: structuredClone(use.owner),
      })),
    ].map(({ state, ...fact }) => ({ ...fact, state }))
  }

  assertSessionsIdle(): void {
    this.authority.assertOwner()
    if (this.activity().state !== 'idle') {
      throw new DaemonError('E_BUSY', '会话已开始执行或状态不明，需要确认中断后重启。')
    }
  }

  async assertIdle(): Promise<void> {
    this.authority.assertOwner()
    this.authority.assertAuthority()
    if (this.state.closed() || this.state.released() || this.state.stopping()) {
      throw new DaemonError('E_BUSY', 'Native runtime admission is already closed or release remains in progress.')
    }
    const workflows = await this.ports.workflow.countOwned()
    this.authority.assertOwner()
    this.authority.assertAuthority()
    const sessions = this.ports.acp.listOwnedAcpSessionFacts()
    if (
      this.state.closed() || this.state.released() || this.state.stopping() || this.state.operations() || this.ports.commands.count()
      || workflows || this.ports.taskProgress.busy() || this.ports.taskExecutions.busy() || this.ports.conversation.activityCount() || this.ports.workcopies.facts().length
      || sessions.some(session => sessionActivity(session) !== 'idle')
    ) {
      throw new DaemonError('E_BUSY', 'Original native sessions, preparation, workflow or unfinished operations still own background work.')
    }
  }

  closeAdmission(): void {
    this.state.setClosed()
    this.ports.setWorkflowAdmissionClosed(true)
    this.ports.acp.closeAcpAdmission()
  }

  shutdown(): Promise<void> {
    const existing = this.state.stopping()
    if (existing) return existing
    this.closeAdmission()
    this.ports.stopKnowledgeReads()
    const stopping = (async () => {
      // Stop the conversation kernel first: closing its app-servers releases pending turn waits.
      const results = await Promise.allSettled([
        this.ports.conversation.shutdown(),
        this.ports.taskExecutions.shutdown(),
        this.ports.workflow.shutdownAll(),
        (async () => {
          await Promise.allSettled(this.ports.acp.listOwnedAcpSessionFacts()
            .filter(session => session.turnActive || session.accepting || session.pendingPermission)
            .map(session => this.ports.acp.cancelAcpSession(session.projectRoot, session.sessionId)))
          await this.ports.acp.shutdownAcp()
        })(),
        this.ports.taskProgress.close(),
        this.ports.commands.drain(),
      ])
      this.ports.conversationProjections.close()
      for (const timer of this.ports.materialTimers.values()) clearTimeout(timer)
      this.ports.materialTimers.clear()
      await Promise.all([...this.ports.watchers.values()].map(watcher => watcher.close()))
      this.ports.watchers.clear()
      if (results.some(result => result.status === 'rejected')) {
        throw new DaemonError('E_UNKNOWN', '部分执行清理未确认；所有清理领域均已尝试。', 'unknown')
      }
      if (this.ports.acp.listOwnedAcpSessionFacts().length || await this.ports.workflow.hasAny() || this.ports.workcopies.facts().length) {
        throw new DaemonError('E_UNKNOWN', '原 Runtime 或本机应用仍有工作副本登记；实际清理未确认，后台所有权已保留。', 'unknown')
      }
    })().catch(error => {
      this.state.setStopping(undefined)
      throw error
    })
    this.state.setStopping(stopping)
    return stopping
  }

  // A pending cross-project session may select this physical cwd after awaits.
  // Conservatively hold destructive grant changes until all pending effects settle.
  async ownsWorkspace(root: string): Promise<boolean> {
    const target = this.ports.canonicalDirectory(root)
    const directory = this.ports.canonicalDirectory
    const within = (path: string): boolean => {
      const delta = relative(target, directory(path))
      return delta === '' || !isAbsolute(delta) && delta !== '..' && !delta.startsWith('../') && !delta.startsWith('..\\')
    }
    return this.ports.taskExecutions.ownsWorkspace(root)
      || this.ports.conversation.ownsWorkspace(within)
      || this.ports.commands.count() > 0
      || this.ports.workcopyFacts(root).length > 0
      || this.ports.acp.listOwnedAcpSessionFacts().some(session => within(session.projectRoot) || session.cwd !== null && within(session.cwd))
      || await this.ports.workflow.countOwned() > 0
  }

  async release(): Promise<void> {
    await this.shutdown()
    this.authority.assertOwner()
    if ((await this.status()).sessions || (await this.status()).workflows) {
      throw new DaemonError('E_UNKNOWN', 'Runtime release has not been verified.', 'unknown')
    }
    this.state.setReleased()
    this.ports.disposeEvents()
  }
}
