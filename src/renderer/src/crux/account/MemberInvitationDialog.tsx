import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, Copy, Link2, LoaderCircle, X } from 'lucide-react'
import type { TeamRole } from '@shared/team-platform'
import { Button, Checkbox, Modal, Tooltip } from '../../my/ui'
import { useCopyFeedback } from '../../utils/use-copy-feedback'
import { Field, inputClass, Select } from '../ui'
import { DesktopAccountReplyError, desktopAccountAdapter, type DesktopAccountAdapter } from './desktop-account-adapter'
import { releaseCommandId, retainCommandId } from './command-identity'
import type { DesktopMemberInvitationInput, DesktopMemberInvitationResult, OrganizationMembershipRole } from './model'
import './member-invitation.css'

const workspaceRoleLabels: Record<TeamRole, string> = { product: '产品', pm: '项目管理', developer: '开发', tester: '测试', admin: '工作区管理' }
const organizationRoleLabels: Record<Exclude<OrganizationMembershipRole, 'owner'>, string> = { member: '组织成员', admin: '组织管理员' }

interface InvitationOwner {
  accountId: string
  organizationId: string
  organizationName: string
  workspaceId: string
  workspaceName: string
}

export interface MemberInvitationDialogProps {
  open: boolean
  currentConnectionId: string | null
  currentSpace?: { id: string; name: string }
  onClose: () => void
  adapter?: DesktopAccountAdapter
}

export function MemberInvitationDialog({ open, currentConnectionId, currentSpace, onClose, adapter = desktopAccountAdapter }: MemberInvitationDialogProps): JSX.Element {
  const [owner, setOwner] = useState<InvitationOwner | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcomeUnknown, setOutcomeUnknown] = useState(false)
  const [username, setUsername] = useState('')
  const [organizationRole, setOrganizationRole] = useState<Exclude<OrganizationMembershipRole, 'owner'>>('member')
  const [workspaceRoles, setWorkspaceRoles] = useState<TeamRole[]>(['developer'])
  const [includeSpace, setIncludeSpace] = useState(Boolean(currentSpace))
  const [result, setResult] = useState<DesktopMemberInvitationResult | null>(null)
  const requestTicket = useRef(0)
  const scope = useRef<string | null>(null)
  const command = useRef<{ key: string; id: string } | null>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const copy = useCopyFeedback(result?.url ?? 'member-invitation')

  useEffect(() => {
    if (!open) { requestTicket.current++; return }
    const ticket = ++requestTicket.current
    setLoading(true)
    setSubmitting(false)
    const nextScope = JSON.stringify([currentConnectionId, currentSpace?.id ?? null])
    setError(scope.current === nextScope && outcomeUnknown ? '暂时无法确认是否创建成功。请重试同一邀请，以便核对结果。' : null)
    setOwner(null)
    setResult(null)
    if (scope.current !== nextScope) {
      scope.current = nextScope
      setOutcomeUnknown(false)
      setIncludeSpace(Boolean(currentSpace))
    }
    command.current = null
    void adapter.loadConnectedAccounts(currentConnectionId).then((snapshot) => {
      if (ticket !== requestTicket.current) return
      for (const account of snapshot.accounts) {
        const workspace = account.workspaces.find((item) => item.connectionId === currentConnectionId && item.current)
        if (workspace?.organizationId && workspace.workspaceId && account.state === 'active') {
          setOwner({
            accountId: account.accountId,
            organizationId: workspace.organizationId,
            organizationName: workspace.organizationName ?? '当前组织',
            workspaceId: workspace.workspaceId,
            workspaceName: workspace.workspaceName
          })
          return
        }
      }
      setError('当前连接没有可用于邀请的桌面账号、组织或工作区身份。')
    }).catch((cause) => {
      if (ticket === requestTicket.current) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (ticket === requestTicket.current) setLoading(false)
    })
    return () => { requestTicket.current++ }
  }, [adapter, currentConnectionId, currentSpace?.id, open])

  const toggleRole = (role: TeamRole): void => {
    setResult(null)
    setOutcomeUnknown(false)
    setWorkspaceRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role])
  }

  const submit = async (): Promise<void> => {
    if (submitting || !owner || result) return
    const normalizedUsername = username.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalizedUsername)) {
      setError('本地用户名需为 3–64 位小写字母、数字、点、下划线或连字符。')
      usernameRef.current?.focus()
      return
    }
    if (workspaceRoles.length === 0) { setError('至少选择一项工作区职责。'); return }
    if (!adapter.capabilities.memberInvitation) {
      setError('当前无法创建邀请，请重新打开应用后重试。')
      return
    }
    const input: DesktopMemberInvitationInput = {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      username: normalizedUsername,
      organizationRoles: [organizationRole],
      workspaceRoles,
      ...(includeSpace && currentSpace ? { spaceId: currentSpace.id } : {})
    }
    const key = JSON.stringify(input)
    if (command.current?.key !== key) command.current = { key, id: retainCommandId(`member-invitation:${key}`) }
    const commandId = command.current.id
    const ticket = ++requestTicket.current
    setSubmitting(true)
    setError(null)
    try {
      const created = await adapter.createMemberInvitation({ ...input, commandId })
      if (ticket !== requestTicket.current) return
      setResult(created)
      setOutcomeUnknown(false)
      releaseCommandId(`member-invitation:${key}`, commandId)
      command.current = null
    } catch (cause) {
      if (ticket === requestTicket.current) {
        if (cause instanceof DesktopAccountReplyError && cause.outcomeUnknown) {
          setOutcomeUnknown(true)
          setError('暂时无法确认是否创建成功。请重试同一邀请，以便核对结果。')
        } else setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (ticket === requestTicket.current) setSubmitting(false)
    }
  }

  return <Modal open={open} onClose={() => { if (!submitting) onClose() }} width={600} ariaLabel="邀请成员" placement="center">
    <form className="member-invite" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <header className="member-invite-header">
        <div><h2>邀请成员</h2><p>{owner ? `${owner.organizationName} · ${owner.workspaceName}` : loading ? '正在核对工作区…' : '工作区身份不可用'}</p></div>
        <Button variant="ghost" size="sm" disabled={submitting} onClick={onClose} aria-label="关闭邀请窗口"><X size={16} /></Button>
      </header>
      <div className="member-invite-body my-scrollbar">
        {loading && <p className="account-quiet-status" role="status"><LoaderCircle className="account-spinner" size={15} />正在读取邀请范围…</p>}
        {error && <div className="account-inline-error" role="alert"><span>{error}</span></div>}
        {!loading && owner && <>
          {result ? <div className="member-invite-result" role="status"><Check size={20} /><div><strong>邀请链接已创建</strong><p>请将链接发送给 {username.trim().toLowerCase()}。对方使用该账号登录后可接受邀请。</p><p>有效期至 {new Date(result.expiresAt).toLocaleString('zh-CN')}</p><div className="member-invite-copy"><input className={inputClass} readOnly value={result.url} aria-label="邀请链接" /><Button variant="primary" size="sm" disabled={copy.status === 'copying'} onClick={() => void copy.copy(result.url)}><Copy size={13} />{copy.status === 'copied' ? '已复制' : copy.status === 'error' ? '复制失败，请手动复制' : '复制链接'}</Button></div></div></div> : <>
            <div className="member-invite-method"><span><Link2 size={16} /></span><div><strong>邀请链接</strong><p>为指定账号创建专属链接，发送给对方后加入。</p></div></div>
            <Field label="成员账号" hint="输入对方在此团队服务使用的本地用户名。"><input ref={usernameRef} className={inputClass} autoFocus value={username} disabled={submitting || outcomeUnknown} onChange={(event) => { setUsername(event.target.value); setError(null) }} placeholder="输入用户名" autoComplete="off" spellCheck={false} /></Field>
            <div className="member-invite-section"><Field label="组织角色"><Select value={organizationRole} disabled={submitting || outcomeUnknown} onChange={(value) => setOrganizationRole(value as Exclude<OrganizationMembershipRole, 'owner'>)} options={(['member', 'admin'] as const).map((role) => ({ value: role, label: organizationRoleLabels[role] }))} /></Field></div>
            <fieldset><legend>工作区职责</legend><p className="member-invite-hint">可多选，至少选择一项。</p><div className="member-invite-roles">{(['product', 'pm', 'developer', 'tester', 'admin'] as const).map((role) => <label key={role} className="flex cursor-pointer items-center gap-2"><Checkbox disabled={submitting || outcomeUnknown} checked={workspaceRoles.includes(role)} ariaLabel={workspaceRoleLabels[role]} onChange={() => toggleRole(role)} /><span>{workspaceRoleLabels[role]}</span></label>)}</div></fieldset>
            {currentSpace && <Field label="加入空间（可选）" hint="接受邀请后成为该空间成员；邀请人需要有管理该空间的权限。"><Select value={includeSpace ? 'current' : 'none'} disabled={submitting || outcomeUnknown} onChange={(value) => setIncludeSpace(value === 'current')} options={[{ value: 'current', label: currentSpace.name }, { value: 'none', label: '暂不加入空间' }]} /></Field>}
            {!adapter.capabilities.memberInvitation && <p role="status" className="member-invite-muted">当前版本无法创建邀请，请重新打开应用后重试。</p>}
          </>}
        </>}
      </div>
      <footer className="member-invite-footer"><Button variant="ghost" disabled={submitting} onClick={onClose}>{result ? '完成' : '取消'}</Button>{!result && (() => {
        const disabledReason = !owner ? '工作区身份不可用' : !username.trim() ? '请先输入成员用户名' : workspaceRoles.length === 0 ? '请至少选择一项工作区职责' : !adapter.capabilities.memberInvitation ? '当前版本不支持创建邀请' : null
        const btn = <Button variant="primary" disabled={loading || submitting || Boolean(disabledReason)} onClick={() => void submit()}>{submitting ? '正在创建…' : outcomeUnknown ? '核对并重试' : '创建邀请链接'}</Button>
        return disabledReason ? <Tooltip label={disabledReason}>{btn}</Tooltip> : btn
      })()}</footer>
    </form>
  </Modal>
}
