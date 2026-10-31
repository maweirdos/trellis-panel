import { useRef, useState, type JSX } from 'react'
import type { HifoxMember, HifoxSnapshot, HifoxTask } from '@shared/hifox'
import { isHifoxTriageManager } from '@shared/hifox-domain/workflow'
import { api } from '../../api'
import { Button } from '../../my/ui'
import { useHifox } from '../store'
import { taskActorId, useTaskSource } from '../pages/task-detail/use-task-source'
import { useTaskDraft, useTaskDraftField } from '../pages/task-detail/task-drafts'
import { Field, inputClass, textareaClass } from '../ui'

const PROJECT_ROLE_LABEL = { product: '产品', pm: '项目经理', developer: '开发', tester: '测试', admin: '管理员' }
export function spaceMemberResponsibilities(member: HifoxMember): string {
  return member.projectRoles?.length ? member.projectRoles.map(role => PROJECT_ROLE_LABEL[role]).join('、') : member.title || '未设置职责'
}

/** Add existing workspace colleagues without leaving or replacing the handoff draft. */
export function WorkflowSpaceMembers({ snapshot, task, requiredRole, creating = false, returnLabel = '返回交接', onAdded, onClose }: { snapshot: HifoxSnapshot; task: HifoxTask; requiredRole?: 'testOwnerId' | 'acceptanceOwnerId'; creating?: boolean; returnLabel?: string; onAdded?(memberIds: string[]): void; onClose(): void }): JSX.Element {
  const context = useHifox((state) => state.workspaceContext)
  const busy = useHifox((state) => state.busy)
  const source = useTaskSource(creating ? { spaceId: task.spaceId, creating: true } : { spaceId: task.spaceId, taskId: task.id })
  const draft = useTaskDraft(snapshot, context, { kind: 'workflow', spaceId: task.spaceId, task, creationContext: ['add-space-members'] })
  const [adding, setAdding] = useTaskDraftField<string[]>(draft, 'adding', [])
  const [roleOwner, setRoleOwner] = useTaskDraftField(draft, `role:${requiredRole}`, requiredRole ? task.workflow?.deliveryState?.roles[requiredRole] ?? '' : '')
  const [reason, setReason] = useTaskDraftField(draft, 'role-reason', '')
  const [error, setError] = useState('')
  const flight = useRef(false)
  const space = snapshot.spaces.find((item) => item.id === task.spaceId)
  const people = snapshot.members.filter((member) => !space?.memberIds.includes(member.id))
  const actor = taskActorId(snapshot, context)
  const canManageMembers = Boolean(actor && space && !space.archived && (context.canManage || space.ownerId === actor))
  const canConfigureRole = Boolean(actor && isHifoxTriageManager(snapshot, task.spaceId, actor))
  const matchesTask = (): boolean => {
    const current = useHifox.getState()
    return (!creating || current.createTaskOpen) && Boolean(current.snapshot?.tasks.some(item => item.id === task.id && item.createdAt === task.createdAt && item.spaceId === task.spaceId))
  }
  async function saveRole(): Promise<void> {
    const state = task.workflow?.deliveryState
    if (!requiredRole || !state || !source.canWrite() || !matchesTask() || !canConfigureRole || busy || flight.current || !reason.trim() || !space?.memberIds.includes(roleOwner)) return
    flight.current = true; setError('')
    const acknowledge = draft.acknowledge([`role:${requiredRole}`, 'role-reason'])
    try {
      const result = await useHifox.getState().run('指定任务交付负责人', async () => {
        if (!source.canWrite() || !matchesTask()) return { ok: false as const, error: '原任务来源已变化，请重新打开。' }
        const response = await api.hifox.recordTaskDelivery({ taskId: task.id, operation: 'roles', expectedUpdatedAt: task.updatedAt, expectedDeliveryRevision: state.revision, roles: { ...state.roles, [requiredRole]: roleOwner }, reason: reason.trim() })
        if (response.ok) acknowledge()
        return response
      })
      if (!source.owns() || !matchesTask()) return
      if (result?.ok) onClose()
      else setError(result && !result.ok ? result.error : '职责调整尚未确认，请核对后重试。')
    } finally { flight.current = false }
  }
  async function save(): Promise<void> {
    if (!source.canWrite() || !matchesTask() || !canManageMembers || busy || flight.current || !adding.length) return
    flight.current = true; setError('')
    const acknowledge = draft.acknowledge(['adding'])
    let added: string[] = []
    try {
      const result = await useHifox.getState().run('添加空间成员', async () => {
        const current = useHifox.getState(), currentSpace = current.snapshot?.spaces.find((item) => item.id === task.spaceId)
        const currentActor = current.snapshot && taskActorId(current.snapshot, current.workspaceContext)
        if (!source.canWrite() || !matchesTask() || !currentActor || !currentSpace || currentSpace.archived || !(current.workspaceContext.canManage || currentSpace.ownerId === currentActor)) return { ok: false as const, error: '当前无法管理原空间成员，请重新核对。' }
        if (adding.some(id => !current.snapshot?.members.some(member => member.id === id))) return { ok: false as const, error: '待添加同事的工作区授权已改变，请重新选择。' }
        const response = await api.hifox.setSpaceMembers({ spaceId: task.spaceId, memberIds: [...new Set([...currentSpace.memberIds, ...adding])] })
        if (response.ok) {
          const joined = response.data.spaces.find(item => item.id === task.spaceId)
          added = adding.filter(id => !currentSpace.memberIds.includes(id) && joined?.memberIds.includes(id) && response.data.members.some(member => member.id === id))
          acknowledge()
        }
        return response
      })
      if (!source.owns() || !matchesTask()) return
      if (result?.ok) { onAdded?.(added); onClose() }
      else setError(result && !result.ok ? result.error : '成员变更尚未确认，请核对后重试。')
    } finally { flight.current = false }
  }
  return <section className="space-y-3 rounded-my-md border border-my-line bg-my-layer-1 p-3" aria-label={creating ? '评审同事配置' : '交接空间成员配置'}><h4 className="text-my-sm font-medium">{space?.name} · 空间成员</h4>
    <p className="text-my-xs text-my-secondary">{canManageMembers ? creating ? '选择已有工作区同事加入此空间，保存后继续原需求评审。' : '选择已有工作区同事加入此空间，保存后继续原交接。' : '空间成员需由工作区管理员或空间负责人添加。'}</p>
    <ul className="space-y-2 text-my-xs text-my-secondary">{snapshot.members.filter((member) => space?.memberIds.includes(member.id)).map((member) => <li key={member.id}>{member.name} · {spaceMemberResponsibilities(member)}</li>)}</ul>
    {canManageMembers && <fieldset className="space-y-2" disabled={busy || !source.available || !matchesTask()}><legend className="mb-2 text-my-xs text-my-tertiary">可添加的工作区同事</legend>{people.map((member) => <label key={member.id} className="flex items-start gap-2 text-my-xs"><input type="checkbox" checked={adding.includes(member.id)} onChange={(event) => setAdding((previous) => event.target.checked ? [...previous, member.id] : previous.filter((id) => id !== member.id))} /><span>{member.name} · {spaceMemberResponsibilities(member)}</span></label>)}{!people.length && <p className="text-my-xs text-my-tertiary">工作区同事均已加入此空间，可按本次职责明确指定接收人。</p>}</fieldset>}
    {requiredRole && task.workflow?.deliveryState && <fieldset className="space-y-3 border-t border-my-line pt-3" disabled={busy || !canConfigureRole}><legend className="text-my-xs font-medium">任务指定的{requiredRole === 'testOwnerId' ? '测试' : '验收'}负责人</legend><Field label="负责同事"><select className={inputClass} value={roleOwner} onChange={(event) => setRoleOwner(event.target.value)}><option value="">请选择空间成员</option>{roleOwner && !space?.memberIds.includes(roleOwner) && <option value={roleOwner} disabled>原指定人已不在空间，请重新指定</option>}{snapshot.members.filter((member) => space?.memberIds.includes(member.id)).map((member) => <option key={member.id} value={member.id}>{member.name}{member.title ? ` · ${member.title}` : ''}</option>)}</select></Field><Field label="职责调整原因"><textarea className={textareaClass} rows={2} maxLength={4000} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>{!canConfigureRole && <p className="text-my-xs text-my-tertiary">仅本空间管理员可指定任务交付负责人。</p>}<Button size="sm" disabled={!space?.memberIds.includes(roleOwner) || !reason.trim()} onClick={() => void saveRole()}>保存任务负责人并返回</Button></fieldset>}
    {error && <p role="alert" className="collab-inline-error">{error}</p>}
    <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{returnLabel}</Button>{canManageMembers && <Button size="sm" variant="primary" disabled={busy || !source.available || !matchesTask() || !adding.length} onClick={() => void save()}>加入空间并返回</Button>}</div>
  </section>
}
