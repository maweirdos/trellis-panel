/**
 * HiFox IPC：单一注册文件映射全部 `hifox:*` 通道到服务层。
 * 错误统一走 IpcFail（BadInput），业务校验消息原样带回渲染层。
 */
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import type { HifoxSnapshot } from '../../shared/hifox'
import {
  addComment, addRelation, archiveLabel, clearInbox, createLabel, createSpace, createTask, createTaskStatus, createTaskType,
  inviteMember, markInboxRead, removeMember, removeRelation, removeTask, removeTaskStatus, removeTaskType,
  resolveComment, restoreInbox, setSpaceMembers, snoozeInbox, updateMember, updateSpace, updateTask
} from '../services/hifox/core'
import { loadSnapshot, resetDemoSnapshot } from '../services/hifox/store'
import {
  completeIteration, createIteration, createProject, removeAutomation, removeView, runAutomation,
  saveAutomation, saveView, toggleAutomation, triage, triageQueue, updateIteration, updateProject
} from '../services/hifox/planning'
import { removeAgent, removeCrew, removeSkill, saveAgent, saveCrew, saveSkill } from '../services/hifox/agents'
import { handle } from './registry'

function fail(e: unknown): ReturnType<typeof ipcFail> {
  const message = e instanceof Error ? e.message : String(e)
  return ipcFail(IpcErrorCode.InvalidArg, message)
}

/** 服务层统一返回 HifoxSnapshot；这里包成 { ok, data } 信封，业务校验异常转为 InvalidArg */
function ok(fn: () => HifoxSnapshot): { ok: true; data: HifoxSnapshot } | ReturnType<typeof fail> {
  try {
    return { ok: true, data: fn() }
  } catch (e) {
    return fail(e)
  }
}

export function registerHifoxIpc(): void {
  handle(ipcInvoke.hifox.snapshot, () => ({ ok: true, data: loadSnapshot() }))
  handle(ipcInvoke.hifox.resetDemo, () => ({ ok: true, data: resetDemoSnapshot() }))
  handle(ipcInvoke.hifox.triageQueue, (_e, spaceId: string) => {
    try {
      return { ok: true, data: triageQueue(loadSnapshot(), spaceId) }
    } catch (e) {
      return fail(e)
    }
  })

  handle(ipcInvoke.hifox.createSpace, (_e, input) => ok(() => createSpace(input)))
  handle(ipcInvoke.hifox.updateSpace, (_e, input) => ok(() => updateSpace(input)))
  handle(ipcInvoke.hifox.inviteMember, (_e, input) => ok(() => inviteMember(input)))
  handle(ipcInvoke.hifox.updateMember, (_e, input) => ok(() => updateMember(input)))
  handle(ipcInvoke.hifox.removeMember, (_e, input) => ok(() => removeMember(input)))
  handle(ipcInvoke.hifox.setSpaceMembers, (_e, input) => ok(() => setSpaceMembers(input)))

  handle(ipcInvoke.hifox.createTaskType, (_e, input) => ok(() => createTaskType(input)))
  handle(ipcInvoke.hifox.removeTaskType, (_e, input) => ok(() => removeTaskType(input)))
  handle(ipcInvoke.hifox.createTaskStatus, (_e, input) => ok(() => createTaskStatus(input)))
  handle(ipcInvoke.hifox.removeTaskStatus, (_e, input) => ok(() => removeTaskStatus(input)))
  handle(ipcInvoke.hifox.createLabel, (_e, input) => ok(() => createLabel(input)))
  handle(ipcInvoke.hifox.archiveLabel, (_e, input) => ok(() => archiveLabel(input)))

  handle(ipcInvoke.hifox.createTask, (_e, input) => {
    try {
      const { snapshot, taskId } = createTask(input)
      return { ok: true, data: snapshot, taskId }
    } catch (e) {
      return fail(e)
    }
  })
  handle(ipcInvoke.hifox.updateTask, (_e, input) => ok(() => updateTask(input)))
  handle(ipcInvoke.hifox.removeTask, (_e, input) => ok(() => removeTask(input)))
  handle(ipcInvoke.hifox.addRelation, (_e, input) => ok(() => addRelation(input)))
  handle(ipcInvoke.hifox.removeRelation, (_e, input) => ok(() => removeRelation(input)))
  handle(ipcInvoke.hifox.addComment, (_e, input) => ok(() => addComment(input)))
  handle(ipcInvoke.hifox.resolveComment, (_e, input) => ok(() => resolveComment(input)))

  handle(ipcInvoke.hifox.createProject, (_e, input) => ok(() => createProject(input)))
  handle(ipcInvoke.hifox.updateProject, (_e, input) => ok(() => updateProject(input)))
  handle(ipcInvoke.hifox.createIteration, (_e, input) => ok(() => createIteration(input)))
  handle(ipcInvoke.hifox.updateIteration, (_e, input) => ok(() => updateIteration(input)))
  handle(ipcInvoke.hifox.completeIteration, (_e, input) => ok(() => completeIteration(input)))
  handle(ipcInvoke.hifox.saveView, (_e, input) => ok(() => saveView(input)))
  handle(ipcInvoke.hifox.removeView, (_e, input) => ok(() => removeView(input)))
  handle(ipcInvoke.hifox.triage, (_e, input) => ok(() => triage(input)))

  handle(ipcInvoke.hifox.saveAutomation, (_e, input) => ok(() => saveAutomation(input)))
  handle(ipcInvoke.hifox.toggleAutomation, (_e, input) => ok(() => toggleAutomation(input)))
  handle(ipcInvoke.hifox.removeAutomation, (_e, input) => ok(() => removeAutomation(input)))
  handle(ipcInvoke.hifox.runAutomation, (_e, input) => ok(() => runAutomation(input)))

  handle(ipcInvoke.hifox.markInboxRead, (_e, input) => ok(() => markInboxRead(input)))
  handle(ipcInvoke.hifox.snoozeInbox, (_e, input) => ok(() => snoozeInbox(input)))
  handle(ipcInvoke.hifox.clearInbox, (_e, input) => ok(() => clearInbox(input)))
  handle(ipcInvoke.hifox.restoreInbox, (_e, input) => ok(() => restoreInbox(input)))

  handle(ipcInvoke.hifox.saveAgent, (_e, input) => ok(() => saveAgent(input)))
  handle(ipcInvoke.hifox.removeAgent, (_e, input) => ok(() => removeAgent(input)))
  handle(ipcInvoke.hifox.saveSkill, (_e, input) => ok(() => saveSkill(input)))
  handle(ipcInvoke.hifox.removeSkill, (_e, input) => ok(() => removeSkill(input)))
  handle(ipcInvoke.hifox.saveCrew, (_e, input) => ok(() => saveCrew(input)))
  handle(ipcInvoke.hifox.removeCrew, (_e, input) => ok(() => removeCrew(input)))
}