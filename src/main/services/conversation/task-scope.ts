import { join } from 'node:path'
import { z } from 'zod'
import { currentPostInput, fixedPostInput } from '../../../shared/crux'
import type { CruxWorkspaceContext } from '../../../shared/crux-remote'
import { taskProgressPinSchema } from '../../../shared/crux-task-progress-native'
import { conversationTaskLocatorSchema, conversationTaskScopeSchema, isOrdinaryConversationTask } from '../../../shared/conversation/task-scope'
import { nativeConversationTaskSchema, type NativeConversationTask } from '../../../shared/conversation/task-native'
import { clipUtf8 } from '../../../shared/material-budget'
import { DaemonError } from '../../daemon/errors'
import { writeExclusiveAtomic } from '../../daemon/files'
import { selectTaskCreationReferences } from '../creations/task-references'
import { selectTaskMaterialInputs } from '../crux/task-material-inputs'
import { NativeTaskProgressSender } from '../crux/task-progress-sender'
import { readCruxWorkSource, type CruxWorkWorkspaceView } from '../crux/task-workspace-source'
import { checkedDirectory, directoryIdentity, hash, ownedDirectory, pathKey, readRegular } from '../private-conversations/files'

export const conversationTaskDirectoryName = 'conversation-v2-task-workspaces'
const materialName = 'task-input.json'
const materialLimit = 260 * 1024
const selectionSchema = z.object({ connectionId: z.string().uuid() }).strict()

function selectionIdentity(profile: string, connectionId: string): string {
  const selection = readRegular(profile, 'crux-remote/selection.json', 4096)
  if (selectionSchema.parse(JSON.parse(selection.bytes.toString('utf8'))).connectionId !== connectionId) {
    throw new DaemonError('E_CONFLICT', '当前团队连接已切换。')
  }
  return hash(JSON.stringify([selection.fileIdentity, hash(selection.bytes)]))
}

export async function captureDesktopConversationTask(profile: string, raw: unknown, isCurrent: () => boolean) {
  const locator = conversationTaskLocatorSchema.parse(raw)
  const { cruxStableWorkspaceGeneration, cruxWorkspaceSnapshot, cruxWorkspaceStatus } = await import('../crux/connection-service')
  const { withDesktopTeamService } = await import('../team-desktop')
  const generation = cruxStableWorkspaceGeneration()
  const assertCurrent = (): void => {
    if (!isCurrent() || generation !== cruxStableWorkspaceGeneration()) throw new DaemonError('E_CONFLICT', '原团队页面已切换。')
  }
  assertCurrent()
  const before = await cruxWorkspaceStatus()
  const { snapshot, context } = await cruxWorkspaceSnapshot()
  assertCurrent()
  const task = snapshot.tasks.find(item => item.id === locator.taskId && item.createdAt === locator.taskCreatedAt)
  const { connectionId, actorId } = context
  if (context.state !== 'connected' || !connectionId || before.key !== locator.workspaceKey || context.key !== locator.workspaceKey ||
    before.actorId !== context.actorId || before.instanceId !== context.instanceId || before.epoch !== context.epoch ||
    !actorId || !task || task.assigneeIds[0] !== actorId || !isOrdinaryConversationTask(task) ||
    !snapshot.spaces.some(space => space.id === task.spaceId && !space.archived && space.memberIds.includes(actorId))) {
    throw new DaemonError('E_DENIED', '只有原空间中普通任务的当前处理人可以打开任务对话。')
  }
  const selection = selectionIdentity(profile, connectionId)
  const pin = await withDesktopTeamService(async service => {
    const connection = (await service.connections()).find(item => item.connectionId === connectionId)
    if (!connection || connection.state !== 'active' || connection.accessLocked || connection.ownerId !== context.actorId ||
      connection.projectId !== context.projectId || connection.origin !== context.origin) {
      throw new DaemonError('E_DENIED', '无法核实原团队账号与设备。')
    }
    const value = taskProgressPinSchema.parse({
      workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, handlerId: context.actorId,
      connectionId, origin: connection.origin, pairingId: connection.pairingId, ownerId: connection.ownerId,
      deviceId: connection.deviceId, projectId: connection.projectId, epoch: context.epoch, instanceId: context.instanceId,
    })
    assertCurrent()
    await service.authorizeTaskProgress(connectionId)
    return value
  })
  const assertSelected = (): void => {
    assertCurrent()
    if (selectionIdentity(profile, connectionId) !== selection) throw new DaemonError('E_CONFLICT', '原团队连接已变化。')
  }
  assertSelected()
  return { task: { locator, pin, selectionIdentity: selection } satisfies NativeConversationTask, assertCurrent: assertSelected }
}

function assertTaskSelection(profile: string, task: NativeConversationTask, guard: () => void): void {
  guard()
  if (selectionIdentity(profile, task.pin.connectionId) !== task.selectionIdentity) {
    throw new DaemonError('E_CONFLICT', '原团队连接已变更，请重新打开任务。')
  }
}

function checkedMaterial(root: string, expected: string): void {
  if (readRegular(root, materialName, materialLimit).bytes.toString('utf8') !== expected) {
    throw new DaemonError('E_CONFLICT', '本机固定任务材料已变化。')
  }
}

export async function resolveDaemonConversationTask(
  profile: string, raw: NativeConversationTask, ownerId: string, guard: () => void, retainedRoot?: string,
) {
  const task = nativeConversationTaskSchema.parse(raw)
  const { locator, pin } = task
  if (locator.workspaceKey !== pin.workspaceKey || locator.taskId !== pin.taskId || pin.handlerId !== pin.ownerId ||
    retainedRoot !== undefined && !locator.scopeKey) {
    throw new DaemonError('E_DENIED', '任务对话的原任务或作用域身份无效。')
  }
  const sender = new NativeTaskProgressSender(join(profile, 'team-platform'), pin)
  const assertSelected = (): void => assertTaskSelection(profile, task, guard)
  async function read() {
    assertSelected()
    const { context: { snapshot: packet, creations, inputs, codeResource }, assertCredential } = await sender.taskConversationContext()
    assertSelected()
    const original = packet.snapshot.tasks.find(item => item.id === locator.taskId && item.createdAt === locator.taskCreatedAt && item.spaceId === pin.spaceId)
    if (!original || !isOrdinaryConversationTask(original) || codeResource.selection?.resourceId) {
      throw new DaemonError('E_DENIED', '此任务需要通过原工程或托管流程处理。')
    }
    const context: CruxWorkspaceContext = {
      key: pin.workspaceKey, connectionId: pin.connectionId, projectId: pin.projectId, projectName: null,
      origin: pin.origin, actorId: packet.actor.id, state: 'connected', revision: packet.revision,
      authorizationRevision: packet.authorizationRevision, instanceId: packet.instanceId, epoch: packet.epoch,
      canManage: packet.canManage, pendingCount: 0,
    }
    const view: CruxWorkWorkspaceView = { context, snapshot: packet.snapshot }
    const query = { workspaceKey: locator.workspaceKey, taskId: locator.taskId }
    const source = await readCruxWorkSource({
      workspaceStatus: async () => { assertSelected(); return context },
      workspaceSnapshot: async () => view,
      creationReferences: async input => selectTaskCreationReferences(input, creations),
      teamInputs: async input => selectTaskMaterialInputs(input, inputs),
    }, query)
    assertCredential()
    assertSelected()
    const assigneeGeneration = original.assigneeGeneration
    if (assigneeGeneration === undefined) {
      throw new DaemonError('E_UNAVAILABLE', '团队服务暂未提供任务分配代次，请更新服务。')
    }
    const postSources = (fixedPostInput(original) ?? currentPostInput(original, packet.snapshot.comments)).sources
    const materialRevision = hash(JSON.stringify([source.revision, postSources]))
    const key = hash(JSON.stringify([ownerId, pin.instanceId, pin.epoch, pin.workspaceKey, pin.spaceId, pin.ownerId,
      locator.taskId, locator.taskCreatedAt, assigneeGeneration, materialRevision]))
    const status = packet.snapshot.taskStatuses.find(item => item.id === original.statusId && item.spaceId === original.spaceId)
    const canSend = Boolean(status && !source.closed && !original.completedAt && !original.triagePending)
    return { original, source, key, canSend, assigneeGeneration, authorizationRevision: packet.authorizationRevision,
      materialRevision, postSources, assertCredential }
  }

  try {
    const initial = await read()
    const directory = `${conversationTaskDirectoryName}/${initial.key}`
    const cwd = retainedRoot === undefined ? ownedDirectory(profile, directory) : checkedDirectory(join(profile, directory))
    const identity = directoryIdentity(cwd)
    const scopeKey = hash(JSON.stringify([initial.key, identity]))
    if (retainedRoot !== undefined && pathKey(checkedDirectory(retainedRoot)) !== pathKey(cwd) ||
      locator.scopeKey !== undefined && locator.scopeKey !== scopeKey) {
      throw new DaemonError('E_CONFLICT', '任务、材料版本或原工作目录已变化，请返回任务核对。')
    }
    const material = JSON.stringify({ taskId: locator.taskId, taskCreatedAt: locator.taskCreatedAt, spaceId: pin.spaceId,
      materialRevision: initial.materialRevision, material: initial.source.material, postSources: initial.postSources })
    if (Buffer.byteLength(material) > materialLimit) throw new DaemonError('E_INVALID_ARG', '固定任务材料超过本机保留上限。')
    let assertCredential = initial.assertCredential
    function assertSpawnCurrent(): void {
      assertSelected()
      assertCredential()
      if (directoryIdentity(cwd) !== identity) throw new DaemonError('E_CONFLICT', '任务对话的物理目录已变化。')
      checkedMaterial(cwd, material)
    }
    if (retainedRoot === undefined) {
      assertSelected()
      assertCredential()
      if (directoryIdentity(cwd) !== identity) throw new DaemonError('E_CONFLICT', '任务对话的物理目录已变化。')
      try { writeExclusiveAtomic(join(cwd, materialName), material) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    assertSpawnCurrent()
    const scope = conversationTaskScopeSchema.parse({
      locator: { ...locator, scopeKey }, scopeKey, spaceId: pin.spaceId, title: initial.original.title,
      workKind: 'general', actorId: pin.ownerId, actorName: initial.source.actorName, handlerId: pin.handlerId,
      materialRevision: initial.materialRevision, cwd, closed: !initial.canSend, canSend: initial.canSend,
      ...(!initial.canSend ? { reason: '任务当前处于不可发送状态。' } : {}),
      binding: {
        kind: 'task', mode: 'conversation', taskId: locator.taskId, taskCreatedAt: locator.taskCreatedAt, spaceId: pin.spaceId,
        handlerId: pin.handlerId, assigneeGeneration: initial.assigneeGeneration, materialRevision: initial.materialRevision,
        executionId: null, nodeId: null, codeRevision: null,
      },
    })
    async function refreshAuthority() {
      assertSpawnCurrent()
      const current = await read()
      if (current.key !== initial.key) {
        throw new DaemonError('E_DENIED', '任务当前处理人或固定材料已变化，请返回任务重新核对。')
      }
      assertCredential = current.assertCredential
      assertSpawnCurrent()
      return current
    }
    return {
      scope, ownerId, spaceId: scope.spaceId, cwd, binding: scope.binding, projectId: scopeKey, assertSpawnCurrent,
      taskContext: clipUtf8([initial.source.material.title, initial.source.material.description,
        ...initial.source.material.acceptanceCriteria].join('\n'), 6144),
      async assertReadable(): Promise<void> { await refreshAuthority() },
      async assertCurrent(): Promise<void> {
        const current = await refreshAuthority()
        if (!initial.canSend || !current.canSend || current.authorizationRevision !== initial.authorizationRevision) {
          throw new DaemonError('E_DENIED', '任务已关闭或原写入授权已变化，不能继续原操作。')
        }
      },
    }
  } catch (error) {
    if (error instanceof DaemonError) throw error
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT' || code === 'scope_changed') throw new DaemonError('E_CONFLICT', '原任务对话目录或授权已变化。')
    if (/DENIED|FORBIDDEN|NOT_FOUND|BINDING_CHANGED|ACCESS_LOCKED/.test(code)) throw new DaemonError('E_DENIED', '原团队任务的处理人或成员资格已变化。')
    throw new DaemonError('E_UNAVAILABLE', '暂时无法核实原团队任务的权限、固定材料或目录。')
  }
}
