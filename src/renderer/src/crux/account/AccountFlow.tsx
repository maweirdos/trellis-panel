import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type JSX, type RefObject } from 'react'
import {
  ArrowLeft,
  Building2,
  Check,
  ChevronRight,
  CircleUser,
  Cloud,
  FolderKanban,
  Laptop,
  LoaderCircle,
  LogIn,
  RefreshCw,
  ShieldCheck,
  Unplug,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import { Button } from '../../my/ui'
import { Field, inputClass } from '../ui'
import { api } from '../../api'
import { useApp } from '../../store'
import { useCrux } from '../store'
import type { CruxInitialTaskType, CruxPendingCommand } from '@shared/crux'
import type { DesktopTeamAuthOptions } from '@shared/team-desktop-account'
import type { TeamRole } from '@shared/team-platform'
import {
  accountFlowReducer,
  createAccountFlowState,
  findScopeWorkspace,
  type AccountAuthProvider,
  type AccountDraft,
  type AccountFlowStep,
  type AccountOperation,
  type DesktopAccountGroup,
  type DesktopScopeSnapshot,
  type DesktopWorkspaceChoice,
  type OrganizationMembershipRole
} from './model'
import { desktopAccountAdapter, type DesktopAccountAdapter } from './desktop-account-adapter'
import { releaseCommandId, retainCommandId } from './command-identity'
import './organization-create.css'

const retiredPendingCodes = new Set(['EPOCH_CONFLICT', 'WORKSPACE_EPOCH_CHANGED'])
// Drafts remain in memory only and are bound to their account or connection.
const invitationDrafts = new Map<string, string>()
const initialTypes: CruxInitialTaskType[] = ['需求', 'Bug', '任务', '内容']
const spaceDrafts = new Map<string, { name: string; key: string; types: CruxInitialTaskType[] }>()
const uncertainSpaceOwners = new Map<string, 'createSpace' | 'joinSpace'>()
const pendingJoinTargets = new Map<string, string>()

const stepTitles: Record<AccountFlowStep, string> = {
  entry: '选择使用方式',
  accounts: '选择团队账号',
  auth: '登录团队账号',
  scope: '选择组织与工作区',
  'create-organization': '创建组织',
  'create-workspace': '创建工作区',
  'accept-invitation': '接受邀请',
  device: '连接当前电脑',
  space: '选择空间',
  'confirm-switch': '确认切换'
}

const providerLabels: Record<AccountAuthProvider | 'unknown', string> = {
  local: '本地账号',
  gitlab: 'GitLab',
  oidc: 'OIDC',
  unknown: '团队账号'
}

const organizationRoleLabels: Record<OrganizationMembershipRole, string> = { owner: '组织所有者', admin: '组织管理员', member: '组织成员' }
const workspaceRoleLabels: Record<TeamRole, string> = { product: '产品', pm: '项目管理', developer: '开发', tester: '测试', admin: '工作区管理' }

const operationLabels: Record<AccountOperation, string> = {
  load: '正在读取账号…',
  authenticate: '正在登录…',
  scope: '正在更新组织与工作区…',
  connect: '正在连接当前电脑…',
  switch: '正在切换工作区…',
  logout: '正在退出账号…',
  disconnect: '正在退出连接…',
  pending: '正在核对原操作…'
}

type FieldValidation = { field: keyof AccountDraft; message: string }

export interface AccountFlowProps {
  open: boolean
  initialStep?: 'entry' | 'accounts' | 'auth'
  returnToOnboarding?: boolean
  currentConnectionId: string | null
  currentIsLocal: boolean
  hostBusy: boolean
  requestCloseRef?: { current: (() => void) | null }
  onClose: () => void
  onSelectWorkspace: (connectionId: string | null) => Promise<boolean>
  onWorkspaceUpdated: () => Promise<void>
  adapter?: DesktopAccountAdapter
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function retainedCommand(holder: { current: { key: string; id: string } | null }, key: string): string {
  if (holder.current?.key === key) return holder.current.id
  const id = retainCommandId(key)
  holder.current = { key, id }
  return id
}

function releaseRetainedCommand(holder: { current: { key: string; id: string } | null }): void {
  const current = holder.current
  if (current) releaseCommandId(current.key, current.id)
  holder.current = null
}

function workspaceStateLabel(workspace: DesktopWorkspaceChoice): string {
  if (workspace.current) return '当前'
  if (workspace.state === 'unconnected') return '连接这台电脑'
  if (workspace.state === 'pending') return '等待确认'
  if (workspace.state === 'disconnected') return '已退出'
  if (workspace.state === 'revoked') return '权限已撤销'
  if (workspace.state === 'expired') return '连接已过期'
  if (workspace.accessLocked) return '需要重新连接'
  if (workspace.network === 'offline') return '离线缓存'
  return '可切换'
}

function accountStateLabel(state: DesktopAccountGroup['state']): string {
  if (state === 'signed-out') return '已退出账号'
  if (state === 'reauthentication-required') return '需要重新登录'
  if (state === 'connection-only') return '旧设备连接'
  return '已登录'
}

function AccountProgress({ step }: { step: AccountFlowStep }): JSX.Element | null {
  if (step === 'entry' || step === 'confirm-switch') return null
  const active = ['scope', 'create-organization', 'create-workspace', 'accept-invitation'].includes(step) ? 1 : step === 'device' || step === 'space' ? 2 : 0
  const labels = ['账号', '工作区', '电脑']
  return <ol className="account-flow-progress" aria-label={`团队连接进度：第 ${active + 1} 步，共 3 步`}>
    {labels.map((label, index) => <li key={label} data-state={index < active ? 'complete' : index === active ? 'current' : 'upcoming'}>
      <span aria-hidden="true">{index < active ? <Check size={12} /> : index + 1}</span>
      <strong>{label}</strong>
    </li>)}
  </ol>
}

export function AccountFlow({
  open,
  initialStep = 'entry',
  returnToOnboarding = false,
  currentConnectionId,
  currentIsLocal,
  hostBusy,
  requestCloseRef,
  onClose,
  onSelectWorkspace,
  onWorkspaceUpdated,
  adapter = desktopAccountAdapter
}: AccountFlowProps): JSX.Element {
  const [state, dispatch] = useReducer(accountFlowReducer, undefined, createAccountFlowState)
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [validation, setValidation] = useState<FieldValidation | null>(null)
  const [authOptions, setAuthOptions] = useState<DesktopTeamAuthOptions | null>(null)
  const [authOptionsError, setAuthOptionsError] = useState<string | null>(null)
  const [spacePending, setSpacePending] = useState<CruxPendingCommand[] | null>(null)
  const [spacePendingOwner, setSpacePendingOwner] = useState<string | null>(null)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [spaceOutcomeUnknown, setSpaceOutcomeUnknown] = useState(false)
  const workspaceContext = useCrux((value) => value.workspaceContext)
  const workspaceSnapshot = useCrux((value) => value.snapshot)
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [showCreateSpace, setShowCreateSpace] = useState(false)
  const [spaceTypes, setSpaceTypes] = useState<CruxInitialTaskType[]>(initialTypes)
  const [canChooseSpaceTypes, setCanChooseSpaceTypes] = useState<boolean | null>(null)
  const invitedSpace = useRef<{ workspaceId: string; spaceId: string } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const originRef = useRef<HTMLInputElement>(null)
  const displayNameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmPasswordRef = useRef<HTMLInputElement>(null)
  const organizationNameRef = useRef<HTMLInputElement>(null)
  const workspaceNameRef = useRef<HTMLInputElement>(null)
  const invitationLinkRef = useRef<HTMLInputElement>(null)
  const deviceNameRef = useRef<HTMLInputElement>(null)
  const openRef = useRef(open)
  const currentConnectionRef = useRef(currentConnectionId)
  currentConnectionRef.current = currentConnectionId
  const loadTicket = useRef(0)
  const pendingTicket = useRef(0)
  const operationTicket = useRef(0)
  const operationLock = useRef(false)
  const authOptionsTicket = useRef(0)
  const organizationCommand = useRef<{ key: string; id: string } | null>(null)
  const workspaceCommand = useRef<{ key: string; id: string } | null>(null)
  const invitationCommand = useRef<{ key: string; id: string } | null>(null)
  const connectCommand = useRef<{ key: string; id: string } | null>(null)
  openRef.current = open

  const refreshAccounts = useCallback(async (background = false): Promise<void> => {
    const ticket = ++loadTicket.current
    if (!background) setLoadingAccounts(true)
    setLoadError(null)
    try {
      const snapshot = await adapter.loadConnectedAccounts(currentConnectionRef.current)
      if (ticket !== loadTicket.current || !openRef.current) return
      dispatch({ type: 'loaded', snapshot })
    } catch (cause) {
      if (ticket === loadTicket.current && openRef.current) setLoadError(errorMessage(cause))
    } finally {
      if (ticket === loadTicket.current && openRef.current) setLoadingAccounts(false)
    }
  }, [adapter])

  const loadSpacePending = useCallback(async (ownerKey: string): Promise<void> => {
    if (!openRef.current) return
    const ticket = ++pendingTicket.current
    setSpacePending(null)
    setSpacePendingOwner(null)
    setPendingError(null)
    try {
      const result = await api.crux.workspacePending()
      if (!openRef.current || ticket !== pendingTicket.current || useCrux.getState().workspaceContext.key !== ownerKey) return
      if (!result.ok) throw new Error(result.error)
      setSpacePending(result.data)
      setSpacePendingOwner(ownerKey)
    } catch (cause) {
      if (openRef.current && ticket === pendingTicket.current && useCrux.getState().workspaceContext.key === ownerKey) setPendingError(errorMessage(cause))
    }
  }, [])

  useEffect(() => {
    if (!open || state.step !== 'space') return
    setShowCreateSpace(false)
    const current = useCrux.getState()
    setSpaceOutcomeUnknown(uncertainSpaceOwners.has(current.workspaceContext.key))
    const draft = spaceDrafts.get(current.workspaceContext.key)
    setSpaceTypes(draft?.types ?? initialTypes)
    dispatch({ type: 'set-draft', field: 'spaceName', value: draft?.name ?? '' })
    dispatch({ type: 'set-draft', field: 'spaceKey', value: draft?.key ?? '' })
    const target = invitedSpace.current
    setSelectedSpaceId(target && current.workspaceContext.projectId === target.workspaceId && current.snapshot?.spaces.some((space) => space.id === target.spaceId && !space.archived && current.workspaceContext.actorId && space.memberIds.includes(current.workspaceContext.actorId)) ? target.spaceId : null)
    void loadSpacePending(workspaceContext.key)
    return () => { pendingTicket.current++ }
  }, [open, state.step, workspaceContext.key, loadSpacePending])

  useEffect(() => {
    if (!open || state.step !== 'space') return
    let current = true
    const account = state.snapshot.accounts.find((item) => item.workspaces.some((workspace) => workspace.connectionId === workspaceContext.connectionId))
    const origin = account?.origin ?? (state.session?.origin && state.connectedConnectionId === workspaceContext.connectionId ? state.session.origin : '')
    setCanChooseSpaceTypes(null)
    if (origin) void adapter.authOptions(origin).then((options) => { if (current) setCanChooseSpaceTypes(options.supportsInitialTaskTypes) }).catch(() => { if (current) setCanChooseSpaceTypes(false) })
    else setCanChooseSpaceTypes(false)
    return () => { current = false }
  }, [open, state.step, state.snapshot.accounts, state.session, state.connectedConnectionId, workspaceContext.connectionId, adapter])

  useEffect(() => {
    if (!open) {
      loadTicket.current++
      operationTicket.current++
      operationLock.current = false
      dispatch({ type: 'closed' })
      return
    }
    openRef.current = true
    dispatch({ type: 'opened' })
    if (initialStep !== 'entry') dispatch({ type: 'go', step: initialStep })
    setValidation(null)
    setAuthOptions(null)
    setAuthOptionsError(null)
    organizationCommand.current = null
    workspaceCommand.current = null
    invitationCommand.current = null
    connectCommand.current = null
    return () => {
      openRef.current = false
      loadTicket.current++
      operationTicket.current++
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    return adapter.subscribe(() => { void refreshAccounts(true) })
  }, [open, adapter, refreshAccounts])

  useEffect(() => {
    if (!open) return
    void refreshAccounts(false)
    return () => { loadTicket.current++ }
  }, [open, currentConnectionId, refreshAccounts])

  useEffect(() => {
    if (!open || state.step !== 'auth') return
    if (!state.draft.origin.trim()) { setAuthOptions(null); setAuthOptionsError(null); return }
    const ticket = ++authOptionsTicket.current
    setAuthOptions(null)
    setAuthOptionsError(null)
    void adapter.authOptions(state.draft.origin).then((options) => {
      if (ticket === authOptionsTicket.current && openRef.current) setAuthOptions(options)
    }).catch((cause) => {
      if (ticket === authOptionsTicket.current && openRef.current) setAuthOptionsError(errorMessage(cause))
    })
    return () => { authOptionsTicket.current++ }
  }, [adapter, open, state.step, state.draft.origin])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [open, state.step])

  const runOwned = async <T,>(kind: AccountOperation, task: () => Promise<T>, commit?: (result: T) => void | Promise<void>, successStatus?: string): Promise<void> => {
    if (state.operation || hostBusy || operationLock.current) return
    operationLock.current = true
    const id = ++operationTicket.current
    dispatch({ type: 'operation-started', id, kind })
    try {
      const result = await task()
      if (id !== operationTicket.current || !openRef.current) return
      await commit?.(result)
      if (id === operationTicket.current && openRef.current) dispatch({ type: 'operation-succeeded', id, status: successStatus })
    } catch (cause) {
      if (id === operationTicket.current && openRef.current) dispatch({ type: 'operation-failed', id, error: errorMessage(cause) })
    } finally {
      if (id === operationTicket.current) operationLock.current = false
    }
  }

  const focusInvalid = (next: FieldValidation, ref: RefObject<HTMLInputElement>): void => {
    setValidation(next)
    window.requestAnimationFrame(() => ref.current?.focus({ preventScroll: false }))
  }

  const updateDraft = (field: keyof AccountDraft, value: string): void => {
    if (field === 'invitationToken' && state.session) invitationDrafts.set(state.session.accountId, value)
    if (field === 'spaceName' || field === 'spaceKey') {
      const owner = useCrux.getState().workspaceContext.key
      const draft = spaceDrafts.get(owner) ?? { name: '', key: '', types: spaceTypes }
      spaceDrafts.set(owner, { ...draft, [field === 'spaceName' ? 'name' : 'key']: value })
    }
    dispatch({ type: 'set-draft', field, value })
    if (validation?.field === field) setValidation(null)
  }

  const requestLocal = (): void => {
    if (currentIsLocal) { requestClose(); return }
    dispatch({ type: 'request-switch', target: { kind: 'local' }, from: 'entry' })
  }

  const openSavedAccount = (accountId: string, workspace?: DesktopWorkspaceChoice): void => {
    void runOwned('authenticate', () => adapter.openAccount(accountId), ({ session, scope }) => {
      dispatch({ type: 'authenticated', session, scope })
      dispatch({ type: 'set-draft', field: 'invitationToken', value: invitationDrafts.get(session.accountId) ?? '' })
      if (workspace?.workspaceId && workspace.organizationId) {
        dispatch({ type: 'select-scope', organizationId: workspace.organizationId, workspaceId: workspace.workspaceId })
        dispatch({ type: 'go', step: 'device' })
      }
    })
  }

  const requestWorkspace = (accountId: string, workspace: DesktopWorkspaceChoice): void => {
    if (workspace.current) { dispatch({ type: 'go', step: 'space' }); return }
    if (workspace.state === 'unconnected') { openSavedAccount(accountId, workspace); return }
    if (workspace.state !== 'active' || workspace.accessLocked || !workspace.connectionId) return
    dispatch({ type: 'request-switch', target: { kind: 'workspace', workspace }, from: 'accounts' })
  }

  const confirmSwitch = (): void => {
    const target = state.switchTarget
    if (!target) return
    const connectionId = target.kind === 'local' ? null : target.workspace.connectionId
    if (target.kind === 'workspace' && !connectionId) return
    void runOwned('switch', async () => {
      const changed = await onSelectWorkspace(connectionId)
      if (!changed) throw new Error('未完成切换。当前账号和原操作保持不变，请处理正在进行的工作后重试。')
    }, () => { if (target.kind === 'local') onClose(); else dispatch({ type: 'go', step: 'space' }) })
  }

  const validateAuthentication = (): boolean => {
    if (!state.draft.origin.trim()) { focusInvalid({ field: 'origin', message: '请输入团队服务地址。' }, originRef); return false }
    if (!state.draft.username.trim()) { focusInvalid({ field: 'username', message: '请输入用户名。' }, usernameRef); return false }
    if (state.authMode === 'register' && authOptions?.selfRegistration === false) { dispatch({ type: 'set-error', error: '此团队服务未开放自主注册。' }); return false }
    if (state.authMode === 'register' && !state.draft.displayName.trim()) { focusInvalid({ field: 'displayName', message: '请输入显示名称。' }, displayNameRef); return false }
    if (!state.draft.password) { focusInvalid({ field: 'password', message: '请输入密码。' }, passwordRef); return false }
    if (state.authMode === 'register' && state.draft.password.length < 10) { focusInvalid({ field: 'password', message: '密码至少需要 10 个字符。' }, passwordRef); return false }
    if (state.authMode === 'register' && state.draft.confirmPassword !== state.draft.password) { focusInvalid({ field: 'confirmPassword', message: '两次输入的密码不一致。' }, confirmPasswordRef); return false }
    return true
  }

  const authenticateLocal = (): void => {
    if (!validateAuthentication()) return
    if (!adapter.capabilities.localCredentials) {
      dispatch({ type: 'set-error', error: '当前共享类型尚未提供桌面内本地账号登录与注册 API；已保留输入，待原生能力接入后可直接提交。' })
      return
    }
    void runOwned('authenticate', () => adapter.authenticateLocal({
      mode: state.authMode,
      origin: state.draft.origin.trim(),
      username: state.draft.username.trim(),
      ...(state.authMode === 'register' ? { displayName: state.draft.displayName.trim() } : {}),
      password: state.draft.password
    }), ({ session, scope }) => {
      dispatch({ type: 'authenticated', session, scope })
      dispatch({ type: 'set-draft', field: 'invitationToken', value: invitationDrafts.get(session.accountId) ?? '' })
    })
  }

  const mutateScope = (task: () => Promise<DesktopScopeSnapshot>, onCommitted?: (scope: DesktopScopeSnapshot) => void, successStatus?: string): void => {
    void runOwned('scope', task, (scope) => {
      dispatch({ type: 'scope-updated', scope })
      onCommitted?.(scope)
    }, successStatus)
  }

  const createOrganization = (): void => {
    const session = state.session
    if (!session) return
    if (!state.draft.organizationName.trim()) { focusInvalid({ field: 'organizationName', message: '请输入组织名称。' }, organizationNameRef); return }
    const name = state.draft.organizationName.trim()
    const commandId = retainedCommand(organizationCommand, `organization:${session.accountId}:${name}`)
    void runOwned('scope', () => adapter.createOrganization(session, commandId, name), ({ scope, organizationId }) => {
      releaseRetainedCommand(organizationCommand)
      dispatch({ type: 'scope-updated', scope })
      dispatch({ type: 'select-scope', organizationId, workspaceId: '' })
      dispatch({ type: 'go', step: 'create-workspace' })
    }, '组织已创建，继续创建工作区。')
  }

  const createWorkspace = (): void => {
    const session = state.session
    if (!session || !state.selectedOrganizationId) return
    if (!state.draft.workspaceName.trim()) { focusInvalid({ field: 'workspaceName', message: '请输入工作区名称。' }, workspaceNameRef); return }
    const name = state.draft.workspaceName.trim()
    const commandId = retainedCommand(workspaceCommand, `workspace:${session.accountId}:${state.selectedOrganizationId}:${name}`)
    const organizationId = state.selectedOrganizationId
    void runOwned('scope', () => adapter.createWorkspace(session, commandId, organizationId, name), ({ scope, workspaceId }) => {
      releaseRetainedCommand(workspaceCommand)
      dispatch({ type: 'scope-updated', scope })
      dispatch({ type: 'select-scope', organizationId, workspaceId })
      dispatch({ type: 'go', step: 'scope' })
    }, '工作区已创建，继续连接电脑。')
  }

  const inspectInvitation = (): void => {
    const session = state.session
    if (!session) return
    const url = state.draft.invitationToken.trim()
    if (!url) { focusInvalid({ field: 'invitationToken', message: '请粘贴完整邀请链接。' }, invitationLinkRef); return }
    void runOwned('scope', () => adapter.inspectInvitation(session, url), (invitation) => dispatch({ type: 'invitation-inspected', invitation }))
  }

  const acceptInvitation = (): void => {
    const session = state.session
    const invitation = state.inspectedInvitation
    if (!session || !invitation) return
    const commandId = retainedCommand(invitationCommand, `accept-invitation:${session.accountId}:${invitation.invitationId}:${invitation.url}`)
    mutateScope(() => adapter.acceptInvitation(session, commandId, invitation), (scope) => {
      releaseRetainedCommand(invitationCommand)
      invitationDrafts.delete(session.accountId)
      dispatch({ type: 'invitation-cleared' })
      dispatch({ type: 'set-draft', field: 'invitationToken', value: '' })
      const target = scope.organizations.find((organization) => organization.organizationId === invitation.organizationId)?.workspaces.find((workspace) => workspace.workspaceId === invitation.workspaceId)
      invitedSpace.current = invitation.space ? { workspaceId: invitation.workspaceId, spaceId: invitation.space.id } : null
      dispatch({ type: 'select-scope', organizationId: invitation.organizationId, workspaceId: target ? invitation.workspaceId : '' })
      dispatch({ type: 'go', step: 'scope' })
    }, '邀请已接受，请确认工作区后连接电脑。')
  }

  const continueToDevice = (): void => {
    if (!findScopeWorkspace(state.scope, state.selectedWorkspaceId)) {
      dispatch({ type: 'set-error', error: '请选择要连接的工作区。' })
      return
    }
    dispatch({ type: 'go', step: 'device' })
  }

  const connectDevice = (): void => {
    const session = state.session
    const selected = findScopeWorkspace(state.scope, state.selectedWorkspaceId)
    if (!session || !selected) return
    if (!state.draft.deviceName.trim()) { focusInvalid({ field: 'deviceName', message: '请输入这台电脑的名称。' }, deviceNameRef); return }
    if (state.connectedConnectionId) {
      void runOwned('switch', async () => {
        if (!await onSelectWorkspace(state.connectedConnectionId)) throw new Error('电脑已连接，但尚未切换到该工作区。原工作区操作仍保留，请重试切换。')
        if (useCrux.getState().workspaceContext.connectionId !== state.connectedConnectionId) throw new Error('工作区连接已变化，请重新核对。')
      }, () => { releaseRetainedCommand(connectCommand); dispatch({ type: 'go', step: 'space' }) })
      return
    }
    const commandId = retainedCommand(connectCommand, `connect:${session.accountId}:${selected.workspace.workspaceId}:${state.draft.deviceName.trim()}`)
    void runOwned('connect', async () => {
      const accounts = await adapter.loadConnectedAccounts(currentConnectionRef.current)
      const account = accounts.accounts.find((item) => item.accountId === session.accountId)
      if (!account || account.state !== 'active' || account.scopeError) throw new Error(account?.scopeError ?? '原账号不可用，请重新登录后核对工作区。')
      const existing = account.workspaces.find((workspace) => workspace.workspaceId === selected.workspace.workspaceId && workspace.organizationId === selected.organization.organizationId && workspace.state === 'active' && !workspace.accessLocked && workspace.connectionId)
      if (existing?.connectionId) return { connectionId: existing.connectionId }
      return adapter.connectDevice({
        session,
        commandId,
        organizationId: selected.organization.organizationId,
        workspaceId: selected.workspace.workspaceId,
        deviceName: state.draft.deviceName.trim()
      })
    }, async ({ connectionId }) => {
      dispatch({ type: 'device-connected', connectionId })
      if (!await onSelectWorkspace(connectionId)) throw new Error('电脑已连接，但尚未切换到该工作区。原工作区操作仍保留，请重试切换。')
      if (useCrux.getState().workspaceContext.connectionId !== connectionId) throw new Error('工作区连接已变化，请重新核对。')
      releaseRetainedCommand(connectCommand)
      dispatch({ type: 'go', step: 'space' })
    })
  }

  const enterSpace = (spaceId: string): void => {
    const current = useCrux.getState()
    const space = current.snapshot?.spaces.find((item) => item.id === spaceId && !item.archived && current.workspaceContext.actorId && item.memberIds.includes(current.workspaceContext.actorId))
    if (current.workspaceContext.key !== workspaceContext.key || current.workspaceContext.state !== 'connected' || !space) {
      dispatch({ type: 'set-error', error: '空间或连接已变化，请重新核对。' })
      return
    }
    current.setCurrentSpace(space.id)
    current.setModule('overview')
    onClose()
    if (!returnToOnboarding) useApp.getState().setPage('crux')
  }

  const createSpace = (): void => {
    const owner = useCrux.getState().workspaceContext
    const name = state.draft.spaceName.trim()
    const key = state.draft.spaceKey.trim().toUpperCase()
    if (owner.key !== workspaceContext.key || spacePendingOwner !== owner.key || owner.state !== 'connected' || !owner.connectionId || !owner.actorId || !owner.canManage || !useCrux.getState().snapshot || spaceOutcomeUnknown || !spacePending || spacePending.length) return
    if (!name || !/^[A-Z0-9]{2,7}$/.test(key) || spaceTypes.length === 0 || (spaceTypes.length !== initialTypes.length && canChooseSpaceTypes !== true)) {
      dispatch({ type: 'set-error', error: '请输入空间名称和 2～7 位英文字母或数字组成的任务前缀。' })
      return
    }
    void runOwned('scope', async () => {
      const result = await useCrux.getState().run('创建空间', () => {
        const current = useCrux.getState().workspaceContext
        if (current.key !== owner.key || current.state !== 'connected' || current.actorId !== owner.actorId || !current.canManage) throw new Error('工作区连接或权限已变化，请返回原工作区核对。')
        return api.crux.createSpace({ name, key, ...(spaceTypes.length === initialTypes.length ? {} : { initialTaskTypes: spaceTypes }) })
      })
      await loadSpacePending(owner.key)
      if (!result || (!result.ok && result.outcomeUnknown)) {
        uncertainSpaceOwners.set(owner.key, 'createSpace')
        if (useCrux.getState().workspaceContext.key === owner.key && openRef.current) setSpaceOutcomeUnknown(true)
      }
      if (!result) throw new Error('创建结果尚未确认，请先核对原操作。')
      if (!result.ok) throw new Error(result.error)
      if (useCrux.getState().workspaceContext.key !== owner.key) throw new Error('工作区已变化，请返回原工作区核对结果。')
      const created = result.data.spaces.find((item) => item.key === key && item.name === name)
      if (!created) throw new Error('创建结果中未找到空间，请核对工作区后重试。')
      return created.id
    }, (id) => { spaceDrafts.delete(owner.key); dispatch({ type: 'set-draft', field: 'spaceName', value: '' }); dispatch({ type: 'set-draft', field: 'spaceKey', value: '' }); setSpaceTypes(initialTypes); setShowCreateSpace(false); setSelectedSpaceId(id) }, '空间已创建，选择进入工作台。')
  }

  const joinSpace = (spaceId: string): void => {
    const current = useCrux.getState()
    const owner = current.workspaceContext
    const candidate = current.snapshot?.spaces.find((item) => item.id === spaceId && !item.archived && item.visibility !== 'private' && owner.actorId && !item.memberIds.includes(owner.actorId))
    if (owner.key !== workspaceContext.key || spacePendingOwner !== owner.key || owner.state !== 'connected' || !candidate || spaceOutcomeUnknown || !spacePending || spacePending.length) return
    void runOwned('scope', async () => {
      pendingJoinTargets.set(owner.key, spaceId)
      const result = await useCrux.getState().run('加入空间', () => {
        const context = useCrux.getState().workspaceContext
        if (context.key !== owner.key || context.state !== 'connected' || context.actorId !== owner.actorId) throw new Error('工作区连接或成员身份已变化，请重新核对。')
        return api.crux.joinSpace({ spaceId })
      })
      await loadSpacePending(owner.key)
      if (!result || (!result.ok && result.outcomeUnknown)) {
        uncertainSpaceOwners.set(owner.key, 'joinSpace')
        if (useCrux.getState().workspaceContext.key === owner.key && openRef.current) setSpaceOutcomeUnknown(true)
      }
      if (!result) throw new Error('加入结果尚未确认，请先核对原操作。')
      if (!result.ok) throw new Error(result.error)
      const context = useCrux.getState().workspaceContext
      const joined = result.data.spaces.find((item) => item.id === spaceId && !item.archived && context.actorId && item.memberIds.includes(context.actorId))
      if (context.key !== owner.key || context.actorId !== owner.actorId || !joined) throw new Error('尚未确认空间成员身份，请重新核对。')
      pendingJoinTargets.delete(owner.key)
      return joined.id
    }, (id) => setSelectedSpaceId(id), '已加入空间，选择进入工作台。')
  }

  const retrySpacePending = (commandId: string): void => {
    const owner = useCrux.getState().workspaceContext
    if (owner.key !== workspaceContext.key || spacePendingOwner !== owner.key || owner.state !== 'connected') return
    void runOwned('pending', async () => {
      const result = await useCrux.getState().run('核对原操作', () => {
        if (useCrux.getState().workspaceContext.key !== owner.key) throw new Error('工作区已变化，请返回原工作区。')
        return api.crux.retryWorkspaceCommand({ commandId })
      })
      await loadSpacePending(owner.key)
      if (!result) throw new Error('原操作结果尚未确认，请重试核对。')
      if (!result.ok) throw new Error(result.error)
      const targetId = pendingJoinTargets.get(owner.key)
      const current = useCrux.getState().workspaceContext
      if (targetId && current.key === owner.key && current.actorId === owner.actorId && spacePending?.some((item) => item.commandId === commandId && item.operation === 'joinSpace')) {
        const joined = result.data.spaces.find((item) => item.id === targetId && !item.archived && current.actorId && item.memberIds.includes(current.actorId))
        if (joined) { setSelectedSpaceId(joined.id); pendingJoinTargets.delete(owner.key) }
      }
      if (spacePending?.some((item) => item.commandId === commandId && item.operation === uncertainSpaceOwners.get(owner.key)) && useCrux.getState().workspaceContext.key === owner.key) { uncertainSpaceOwners.delete(owner.key); setSpaceOutcomeUnknown(false) }
    }, undefined, '原操作已核对，请选择空间。')
  }

  const pollConnection = (connectionId: string): void => {
    void runOwned('pending', () => adapter.pollConnection(connectionId), () => refreshAccounts(true))
  }

  const disconnect = (): void => {
    const target = state.disconnectTarget
    const connectionId = target?.connectionId
    if (!target || !connectionId) return
    void runOwned('disconnect', async () => {
      if (target.current && !await onSelectWorkspace(null)) throw new Error('当前工作区未能安全退出；原连接与待处理操作均未删除。')
      await adapter.disconnect(connectionId)
      await onWorkspaceUpdated()
    }, async () => {
      dispatch({ type: 'request-disconnect', target: null })
      await refreshAccounts(true)
    })
  }

  const logoutAccount = (): void => {
    const account = state.logoutTarget
    if (!account) return
    void runOwned('logout', () => adapter.logoutAccount(account.accountId), async () => {
      invitationDrafts.delete(account.accountId)
      dispatch({ type: 'request-logout', target: null })
      await refreshAccounts(true)
    })
  }

  const handlePending = (commandId: string, discard: boolean): void => {
    void runOwned('pending', () => discard ? adapter.discardPending(commandId) : adapter.retryPending(commandId), async () => {
      await onWorkspaceUpdated()
      await refreshAccounts(true)
    })
  }

  const selectedScope = useMemo(() => findScopeWorkspace(state.scope, state.selectedWorkspaceId), [state.scope, state.selectedWorkspaceId])
  const working = Boolean(state.operation) || hostBusy
  const requestClose = (): void => {
    if (working || operationLock.current || useCrux.getState().busy) return
    onClose()
  }
  useLayoutEffect(() => {
    if (!requestCloseRef) return
    requestCloseRef.current = requestClose
    return () => {
      if (requestCloseRef.current === requestClose) requestCloseRef.current = null
    }
  })
  const feedbackError = state.error ?? loadError

  const entry = <div className="account-choice-grid">
    {workspaceContext.state === 'connected' && workspaceContext.connectionId && <button type="button" className="account-entry-choice" disabled={working} onClick={() => dispatch({ type: 'go', step: 'space' })}>
      <span className="account-entry-icon"><FolderKanban size={20} /></span><span><strong>继续选择空间</strong><small>{workspaceContext.projectName ?? '当前工作区'}</small></span><ChevronRight size={17} />
    </button>}
    <button type="button" className="account-entry-choice" aria-current={currentIsLocal ? 'true' : undefined} disabled={working} onClick={requestLocal}>
      <span className="account-entry-icon"><Laptop size={20} /></span>
      <span><strong>本机个人使用</strong><small>无需登录，数据保存在当前电脑</small></span>
      {currentIsLocal ? <span className="account-current-chip"><Check size={12} />当前</span> : <ChevronRight size={17} />}
    </button>
    <button type="button" className="account-entry-choice" aria-current={!currentIsLocal ? 'true' : undefined} disabled={working} onClick={() => dispatch({ type: 'go', step: state.snapshot.accounts.length ? 'accounts' : 'auth' })}>
      <span className="account-entry-icon"><Users size={20} /></span>
      <span><strong>登录团队账号</strong><small>进入组织与共享工作区</small></span>
      {state.snapshot.accounts.length > 0 && <span className="account-entry-count">{state.snapshot.accounts.length} 个账号</span>}
      <ChevronRight size={17} />
    </button>
    <details className="account-service-settings">
      <summary><Cloud size={14} /><span>服务地址</span><code>{state.draft.origin || '未设置'}</code></summary>
      <div>
        <Field label="团队服务地址" hint="可使用已有连接的地址，或输入团队提供的地址。">
          <input className={inputClass} value={state.draft.origin} disabled={working} onChange={(event) => updateDraft('origin', event.target.value)} inputMode="url" spellCheck={false} />
        </Field>
      </div>
    </details>
  </div>

  const accounts = <div className="account-groups">
    {loadingAccounts && state.snapshot.accounts.length === 0 && <p role="status" className="account-quiet-status"><LoaderCircle className="account-spinner" size={15} />正在读取已有账号…</p>}
    {!loadingAccounts && state.snapshot.accounts.length === 0 && <div className="account-empty"><CircleUser size={22} /><strong>还没有已连接账号</strong><span>登录后可在这里按账号查看工作区。</span></div>}
    {state.snapshot.accounts.map((account) => <section key={account.accountId} className="account-group">
      <header><span className="account-avatar">{account.displayName.trim().slice(0, 1) || '?'}</span><span><strong>{account.displayName}</strong><small>{providerLabels[account.provider]} · {accountStateLabel(account.state)} · {account.origin}</small></span>{account.state === 'active' && <div className="account-group-actions"><Button size="sm" variant="ghost" disabled={working} onClick={() => openSavedAccount(account.accountId)}>组织与工作区</Button><Button size="sm" variant="ghost" disabled={working} onClick={() => dispatch({ type: 'request-logout', target: account })}>退出账号</Button></div>}</header>
      {state.logoutTarget?.accountId === account.accountId && <div className="account-confirm-inline" role="group" aria-label="退出团队账号"><p>退出账号会清除这台电脑保存的账号会话，但不会断开已连接设备。设备连接需在对应工作区单独选择“断开电脑”。</p><div><Button size="sm" variant="ghost" disabled={working} onClick={() => dispatch({ type: 'request-logout', target: null })}>取消</Button><Button size="sm" variant="danger" disabled={working} onClick={logoutAccount}>确认退出账号</Button></div></div>}
      {account.scopeError && <div className="account-group-error" role="status">工作区读取失败：{account.scopeError}</div>}
      {!account.scopeError && account.workspaces.length === 0 && <div className="account-group-empty">此账号还没有工作区</div>}
      <div className="account-workspaces">
        {account.workspaces.map((workspace) => <div key={workspace.connectionId ?? workspace.workspaceId ?? workspace.workspaceName} className="account-workspace-wrap">
          <div className="account-workspace-row" data-current={workspace.current || undefined}>
            <button type="button" disabled={working || !['active', 'unconnected'].includes(workspace.state) || workspace.accessLocked} onClick={() => requestWorkspace(account.accountId, workspace)}>
              <FolderKanban size={16} />
              <span><strong>{workspace.workspaceName}</strong><small>{workspace.organizationName ?? (workspace.organizationId ? '已授权组织' : workspace.origin)}</small></span>
              <em>{workspaceStateLabel(workspace)}</em>
            </button>
            {workspace.state === 'pending' && workspace.connectionId && <Button size="sm" variant="ghost" disabled={working} onClick={() => { if (workspace.connectionId) pollConnection(workspace.connectionId) }}><RefreshCw size={13} />核对</Button>}
            {workspace.connectionId && workspace.state !== 'disconnected' && <Button size="sm" variant="ghost" aria-label={`断开 ${workspace.workspaceName} 的电脑连接`} disabled={working} onClick={() => dispatch({ type: 'request-disconnect', target: workspace })}><Unplug size={14} />断开电脑</Button>}
          </div>
          {workspace.state === 'pending' && workspace.userCode && <p className="account-pairing-code">原连接码 <code>{workspace.userCode}</code> 已保留</p>}
          {state.disconnectTarget?.connectionId === workspace.connectionId && <div className="account-confirm-inline" role="group" aria-label="断开当前电脑">
            <p>断开只移除这台电脑的设备连接，不会退出团队账号；原工作区待核对操作也不会转移或删除。</p>
            <div><Button size="sm" variant="ghost" disabled={working} onClick={() => dispatch({ type: 'request-disconnect', target: null })}>取消</Button><Button size="sm" variant="danger" disabled={working} onClick={disconnect}>确认断开电脑</Button></div>
          </div>}
        </div>)}
      </div>
    </section>)}
    {state.snapshot.pendingCommands.length > 0 && <details className="account-retained-operations">
      <summary>{state.snapshot.pendingCommands.length} 个原工作区操作待核对</summary>
      <p>切换账号或工作区不会迁移这些操作。</p>
      {state.snapshot.pendingCommands.map((command) => <div key={command.commandId}>
        <span>{command.operation}<small>{command.outcomeUnknown ? '结果待确认' : command.state === 'conflict' ? '需要处理冲突' : '尚未同步'}</small></span>
        <Button size="sm" variant="ghost" disabled={working} onClick={() => handlePending(command.commandId, false)}>{retiredPendingCodes.has(command.errorCode ?? '') ? '核对旧操作' : '核对并重试'}</Button>
        {!command.outcomeUnknown && ['queued', 'conflict'].includes(command.state) && <Button size="sm" variant="ghost" disabled={working} onClick={() => handlePending(command.commandId, true)}>放弃</Button>}
      </div>)}
    </details>}
  </div>

  const auth = <div className="account-auth">
    <div className="account-auth-tabs" role="group" aria-label="本地账号操作">
      <button type="button" aria-pressed={state.authMode === 'login'} onClick={() => dispatch({ type: 'set-auth-mode', mode: 'login' })}><LogIn size={15} />登录</button>
      <button type="button" aria-pressed={state.authMode === 'register'} disabled={authOptions?.selfRegistration === false} onClick={() => dispatch({ type: 'set-auth-mode', mode: 'register' })}><UserPlus size={15} />注册</button>
    </div>
    <form id="account-auth-form" onSubmit={(event) => { event.preventDefault(); authenticateLocal() }} onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }}>
      <Field label="团队服务地址"><input ref={originRef} className={inputClass} value={state.draft.origin} disabled={working} aria-invalid={validation?.field === 'origin' || undefined} onChange={(event) => updateDraft('origin', event.target.value)} inputMode="url" spellCheck={false} /></Field>
      {validation?.field === 'origin' && <p className="account-field-error">{validation.message}</p>}
      <Field label="用户名"><input ref={usernameRef} className={inputClass} autoComplete="username" value={state.draft.username} disabled={working} aria-invalid={validation?.field === 'username' || undefined} onChange={(event) => updateDraft('username', event.target.value)} /></Field>
      {validation?.field === 'username' && <p className="account-field-error">{validation.message}</p>}
      {state.authMode === 'register' && <><Field label="显示名称"><input ref={displayNameRef} className={inputClass} autoComplete="name" value={state.draft.displayName} disabled={working} aria-invalid={validation?.field === 'displayName' || undefined} onChange={(event) => updateDraft('displayName', event.target.value)} /></Field>{validation?.field === 'displayName' && <p className="account-field-error">{validation.message}</p>}</>}
      <Field label="密码"><input ref={passwordRef} className={inputClass} type="password" autoComplete={state.authMode === 'register' ? 'new-password' : 'current-password'} value={state.draft.password} disabled={working} aria-invalid={validation?.field === 'password' || undefined} onChange={(event) => updateDraft('password', event.target.value)} /></Field>
      {validation?.field === 'password' && <p className="account-field-error">{validation.message}</p>}
      {state.authMode === 'register' && <><Field label="确认密码"><input ref={confirmPasswordRef} className={inputClass} type="password" autoComplete="new-password" value={state.draft.confirmPassword} disabled={working} aria-invalid={validation?.field === 'confirmPassword' || undefined} onChange={(event) => updateDraft('confirmPassword', event.target.value)} /></Field>{validation?.field === 'confirmPassword' && <p className="account-field-error">{validation.message}</p>}</>}
      <button type="submit" className="sr-only" tabIndex={-1}>提交</button>
    </form>
    {authOptionsError && <div className="account-capability-note"><ShieldCheck size={16} /><span><strong>无法核对登录方式</strong><small>{authOptionsError}</small></span></div>}
    {authOptions?.selfRegistration === false && <div className="account-capability-note"><ShieldCheck size={16} /><span><strong>此服务只允许登录</strong><small>需要新账号时请联系组织管理员。</small></span></div>}
    {authOptions?.externalLogin && <div className="account-capability-note"><ShieldCheck size={16} /><span><strong>{authOptions.externalLogin.label} 暂不可用，请使用用户名登录</strong></span></div>}
  </div>

  const invitation = <div className="account-setup-page">
    <section className="account-invitation-link">
      <Field label="完整邀请链接"><input ref={invitationLinkRef} className={inputClass} value={state.draft.invitationToken} disabled={working} aria-invalid={validation?.field === 'invitationToken' || undefined} onChange={(event) => { updateDraft('invitationToken', event.target.value); invitationCommand.current = null; dispatch({ type: 'invitation-cleared' }) }} spellCheck={false} /></Field>
      {validation?.field === 'invitationToken' && <p className="account-field-error">{validation.message}</p>}
      <div className="account-invitation-actions"><Button size="sm" variant="outline" disabled={working || !state.draft.invitationToken.trim()} onClick={inspectInvitation}>核对邀请</Button></div>
      {state.inspectedInvitation && <div className="account-invitation-inspection">
        <div><Building2 size={16} /><span><strong>{state.inspectedInvitation.organizationName}</strong><small>{state.inspectedInvitation.workspaceName}{state.inspectedInvitation.space ? ` · 空间：${state.inspectedInvitation.space.name}` : ' · 不指定空间'}</small></span></div>
        <dl>
          <div><dt>组织职责</dt><dd>{state.inspectedInvitation.organizationRoles.map((role) => organizationRoleLabels[role]).join('、')}</dd></div>
          <div><dt>工作区职责</dt><dd>{state.inspectedInvitation.workspaceRoles.map((role) => workspaceRoleLabels[role]).join('、')}</dd></div>
          <div><dt>有效期</dt><dd>{new Date(state.inspectedInvitation.expiresAt).toLocaleString('zh-CN')}</dd></div>
        </dl>
        <Button size="sm" variant="primary" disabled={working || !adapter.capabilities.invitationAcceptance || state.inspectedInvitation.status !== 'pending'} onClick={acceptInvitation}>{state.inspectedInvitation.status === 'pending' ? '明确接受邀请' : state.inspectedInvitation.status === 'accepted' ? '邀请已接受' : state.inspectedInvitation.status === 'expired' ? '邀请已过期' : '邀请已撤销'}</Button>
      </div>}
    </section>
  </div>

  const createWorkspacePage = <form id="account-workspace-form" className="account-setup-page" onSubmit={(event) => { event.preventDefault(); createWorkspace() }} onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }}>
    <span className="account-setup-icon"><FolderKanban size={24} /></span>
    <h3>创建工作区</h3>
    <p>所属组织：{state.scope.organizations.find((item) => item.organizationId === state.selectedOrganizationId)?.name}</p>
    <Field label="工作区名称"><input ref={workspaceNameRef} className={inputClass} value={state.draft.workspaceName} disabled={working} aria-invalid={validation?.field === 'workspaceName' || undefined} onChange={(event) => updateDraft('workspaceName', event.target.value)} /></Field>
    {validation?.field === 'workspaceName' && <p className="account-field-error">{validation.message}</p>}
    <button type="submit" className="sr-only" tabIndex={-1}>创建工作区</button>
  </form>

  const scope = <div className="account-scope">
    {state.scope.organizations.length === 0 ? <div className="account-setup-page account-scope-start">
      <span className="account-setup-icon"><Building2 size={24} /></span>
      <h3>开始使用团队工作区</h3>
      <p>创建组织，或使用邀请链接加入已有组织。</p>
      <div className="account-setup-choices">
        {adapter.capabilities.organizationManagement && <button type="button" className="account-entry-choice" disabled={working} onClick={() => dispatch({ type: 'go', step: 'create-organization' })}><span className="account-entry-icon"><Building2 size={20} /></span><span><strong>创建组织</strong><small>为团队建立新的组织和工作区</small></span><ChevronRight size={17} /></button>}
        {adapter.capabilities.invitationAcceptance && <button type="button" className="account-entry-choice" disabled={working} onClick={() => dispatch({ type: 'go', step: 'accept-invitation' })}><span className="account-entry-icon"><UserPlus size={20} /></span><span><strong>接受邀请</strong><small>使用邀请链接加入团队</small></span><ChevronRight size={17} /></button>}
      </div>
    </div> : <>
    <div className="account-scope-heading"><h3>选择工作区</h3><div className="account-scope-actions">{adapter.capabilities.invitationAcceptance && <Button size="sm" variant="ghost" disabled={working} onClick={() => dispatch({ type: 'go', step: 'accept-invitation' })}>接受邀请</Button>}{adapter.capabilities.organizationManagement && <Button size="sm" variant="ghost" disabled={working} onClick={() => dispatch({ type: 'go', step: 'create-organization' })}>新建组织</Button>}</div></div>
    {state.scope.organizations.map((organization) => <section key={organization.organizationId} className="account-organization">
      <header><Building2 size={16} /><strong>{organization.name}</strong>{adapter.capabilities.organizationManagement && <Button size="sm" variant="ghost" disabled={working} onClick={() => { dispatch({ type: 'select-scope', organizationId: organization.organizationId, workspaceId: '' }); dispatch({ type: 'go', step: 'create-workspace' }) }}>新建工作区</Button>}</header>
      {organization.workspaces.length === 0 && <div className="account-group-empty">此组织还没有工作区</div>}
      <div>{organization.workspaces.map((workspace) => <button key={workspace.workspaceId} type="button" className="account-scope-choice" aria-pressed={state.selectedWorkspaceId === workspace.workspaceId} disabled={working} onClick={() => dispatch({ type: 'select-scope', organizationId: organization.organizationId, workspaceId: workspace.workspaceId })}><FolderKanban size={16} /><span>{workspace.name}</span>{state.selectedWorkspaceId === workspace.workspaceId && <Check size={15} />}</button>)}</div>
    </section>)}
    </>}
  </div>

  const device = <div className="account-device">
    <div className="account-device-target"><span><Building2 size={15} />{selectedScope?.organization.name}</span><ChevronRight size={14} /><span><FolderKanban size={15} />{selectedScope?.workspace.name}</span></div>
    <div className="account-device-visual"><Laptop size={26} /><span aria-hidden="true" /><Cloud size={24} /></div>
    <Field label="这台电脑的名称" hint="连接成功后仍可在设备设置中识别这台电脑。"><input ref={deviceNameRef} className={inputClass} value={state.draft.deviceName} disabled={working || Boolean(state.connectedConnectionId)} aria-invalid={validation?.field === 'deviceName' || undefined} onChange={(event) => updateDraft('deviceName', event.target.value)} /></Field>
    {validation?.field === 'deviceName' && <p className="account-field-error">{validation.message}</p>}
    {state.connectedConnectionId && <div className="account-capability-note"><Check size={16} /><span><strong>电脑连接已创建</strong><small>只需重试切换；不会重复注册设备。</small></span></div>}
  </div>

  const availableSpaces = workspaceSnapshot?.spaces.filter((space) => !space.archived && workspaceContext.actorId && space.memberIds.includes(workspaceContext.actorId)) ?? []
  const joinableSpaces = workspaceSnapshot?.spaces.filter((space) => !space.archived && space.visibility !== 'private' && workspaceContext.actorId && !space.memberIds.includes(workspaceContext.actorId)) ?? []
  const pendingForWorkspace = spacePendingOwner === workspaceContext.key ? spacePending : null
  const space = <div className="account-setup-page account-space-setup">
    <div className="space-setup-heading"><span className="account-setup-icon"><FolderKanban size={24} /></span>
    <h3>{availableSpaces.length || joinableSpaces.length ? '选择你的空间' : '初始化你的空间'}</h3>
    <p>{workspaceContext.projectName ?? '当前工作区'} · 空间用来组织任务与成员</p></div>
    {workspaceContext.state !== 'connected' && <div className="account-inline-error" role="alert">工作区未连通，请重新连接后继续。</div>}
    {workspaceContext.state === 'connected' && !workspaceSnapshot && <div className="account-inline-error" role="alert">无法读取工作区内容，请重新连接后继续。</div>}
    {workspaceContext.state === 'connected' && workspaceSnapshot && !workspaceContext.actorId && <div className="account-capability-note">当前成员身份尚未确认，请重新连接后核对。</div>}
    {workspaceContext.state === 'connected' && workspaceSnapshot && workspaceContext.actorId && !workspaceContext.canManage && availableSpaces.length === 0 && joinableSpaces.length === 0 && <div className="account-capability-note">当前账号没有可进入或可加入的空间，也没有创建权限，请联系工作区管理员。</div>}
    {availableSpaces.length > 0 && <div className="account-space-list">{availableSpaces.map((item) => <button key={item.id} type="button" className="account-scope-choice" aria-pressed={selectedSpaceId === item.id} disabled={working} onClick={() => setSelectedSpaceId(item.id)}><FolderKanban size={16} /><span>{item.name} · {item.key}</span>{selectedSpaceId === item.id && <Check size={15} />}</button>)}</div>}
    {joinableSpaces.length > 0 && <div className="account-joinable-spaces"><h4>可加入的公开空间</h4>{joinableSpaces.map((item) => <div key={item.id}><span>{item.name} · {item.key}</span><Button size="sm" variant="outline" disabled={working || workspaceContext.state !== 'connected' || spaceOutcomeUnknown || !pendingForWorkspace || pendingForWorkspace.length > 0} onClick={() => joinSpace(item.id)}>加入</Button></div>)}</div>}
    {pendingError && <div className="account-inline-error" role="alert"><span>无法核对待处理操作：{pendingError}</span><Button size="sm" variant="ghost" disabled={working} onClick={() => void loadSpacePending(workspaceContext.key)}>重试核对</Button></div>}
    {!pendingError && !pendingForWorkspace && <p role="status">正在核对工作区操作…</p>}
    {pendingForWorkspace && pendingForWorkspace.length > 0 && <div className="account-pending-space"><strong>工作区有待核对操作</strong>{pendingForWorkspace.map((command) => <div key={command.commandId}><span>{command.operation === 'createSpace' ? '创建空间' : command.operation === 'joinSpace' ? '加入空间' : command.operation} · {command.outcomeUnknown ? '结果待确认' : '尚未完成'}</span><Button size="sm" variant="outline" disabled={working || workspaceContext.state !== 'connected'} onClick={() => retrySpacePending(command.commandId)}>核对并重试原操作</Button></div>)}</div>}
    {spaceOutcomeUnknown && pendingForWorkspace?.length === 0 && <div className="account-inline-error" role="alert">空间操作结果尚未确认，且暂时没有可重试的原操作。请在原工作区核对结果。</div>}
    {workspaceContext.state === 'connected' && workspaceSnapshot && workspaceContext.actorId && workspaceContext.canManage && availableSpaces.length > 0 && !showCreateSpace && <Button variant="ghost" disabled={working} onClick={() => setShowCreateSpace(true)}>创建其他空间</Button>}
    {workspaceContext.state === 'connected' && workspaceSnapshot && workspaceContext.actorId && workspaceContext.canManage && (availableSpaces.length === 0 || showCreateSpace) && <form className="account-space-form" onSubmit={(event) => { event.preventDefault(); createSpace() }} onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }}>
      <h4>{availableSpaces.length ? '创建其他空间' : '设置空间'}</h4>
      <Field label="空间名称"><input className={inputClass} value={state.draft.spaceName} disabled={working || spaceOutcomeUnknown || !pendingForWorkspace || pendingForWorkspace.length > 0} onChange={(event) => updateDraft('spaceName', event.target.value)} /></Field>
      <Field label="任务前缀" hint="2～7 位字母或数字，例如 TEAM-1"><input className={inputClass} maxLength={7} value={state.draft.spaceKey} disabled={working || spaceOutcomeUnknown || !pendingForWorkspace || pendingForWorkspace.length > 0} onChange={(event) => updateDraft('spaceKey', event.target.value.toUpperCase())} /></Field>
      <fieldset className="space-setup-defaults"><legend>任务类型</legend><div>{initialTypes.map((type) => <label key={type}><input type="checkbox" checked={spaceTypes.includes(type)} disabled={working || spaceOutcomeUnknown || !pendingForWorkspace || pendingForWorkspace.length > 0 || canChooseSpaceTypes !== true} onChange={() => { const next = spaceTypes.includes(type) ? spaceTypes.filter((item) => item !== type) : initialTypes.filter((item) => item === type || spaceTypes.includes(item)); setSpaceTypes(next); const owner = useCrux.getState().workspaceContext.key; spaceDrafts.set(owner, { name: state.draft.spaceName, key: state.draft.spaceKey, types: next }) }} />{type}</label>)}</div><small>{canChooseSpaceTypes === null ? '正在核对团队服务能力…' : canChooseSpaceTypes ? '至少选择一种，创建后可在空间设置中调整。' : '当前团队服务暂不支持初始化时选择类型；可先使用默认类型，创建后再调整。'}</small></fieldset>
      {canChooseSpaceTypes === false && spaceTypes.length !== initialTypes.length && <Button variant="outline" disabled={working} onClick={() => { setSpaceTypes(initialTypes); spaceDrafts.set(workspaceContext.key, { name: state.draft.spaceName, key: state.draft.spaceKey, types: initialTypes }) }}>使用默认类型</Button>}
      <Button variant="primary" disabled={working || spaceOutcomeUnknown || !pendingForWorkspace || pendingForWorkspace.length > 0 || !state.draft.spaceName.trim() || !/^[A-Z0-9]{2,7}$/.test(state.draft.spaceKey) || spaceTypes.length === 0 || (spaceTypes.length !== initialTypes.length && canChooseSpaceTypes !== true)} onClick={createSpace}>创建空间</Button>
      <button type="submit" className="sr-only" tabIndex={-1} disabled={working}>创建空间</button>
    </form>}
  </div>

  const confirm = <div className="account-switch-confirm">
    <span className="account-entry-icon">{state.switchTarget?.kind === 'local' ? <Laptop size={22} /> : <FolderKanban size={22} />}</span>
    <h3>{state.switchTarget?.kind === 'local' ? '切换到本机个人使用？' : `切换到“${state.switchTarget?.workspace.workspaceName ?? ''}”？`}</h3>
    <p>当前未完成操作仍归原账号和工作区，不会迁移、重发或删除。切换成功前，当前工作区保持不变。</p>
    {state.snapshot.pendingCommands.length > 0 && <span className="account-retained-count">{state.snapshot.pendingCommands.length} 个原操作待核对</span>}
  </div>

  const content = state.step === 'entry' ? entry : state.step === 'accounts' ? accounts : state.step === 'auth' ? auth : state.step === 'scope' ? scope : state.step === 'create-workspace' ? createWorkspacePage : state.step === 'accept-invitation' ? invitation : state.step === 'device' ? device : state.step === 'space' ? space : confirm

  const primary = state.step === 'accounts'
    ? <Button variant="primary" disabled={working} onClick={() => dispatch({ type: 'go', step: 'auth' })}>登录其他账号</Button>
    : state.step === 'auth'
      ? <Button variant="primary" disabled={working || !adapter.capabilities.localCredentials || !authOptions || Boolean(authOptionsError) || state.authMode === 'register' && !authOptions.selfRegistration} onClick={authenticateLocal}>{state.authMode === 'login' ? '登录' : '注册并继续'}</Button>
      : state.step === 'scope'
        ? state.scope.organizations.length > 0 ? <Button variant="primary" disabled={working || !state.selectedWorkspaceId} onClick={continueToDevice}>连接电脑</Button> : null
        : state.step === 'create-workspace'
            ? <Button variant="primary" disabled={working || !state.selectedOrganizationId} onClick={createWorkspace}>创建工作区</Button>
        : state.step === 'space'
          ? <Button variant="primary" disabled={working || !selectedSpaceId || workspaceContext.state !== 'connected'} onClick={() => { if (selectedSpaceId) enterSpace(selectedSpaceId) }}>{returnToOnboarding ? '完成并返回引导' : '进入工作台'}</Button>
        : state.step === 'device'
          ? <Button variant="primary" disabled={working || !adapter.capabilities.deviceConnection && !state.connectedConnectionId} onClick={connectDevice}>{state.connectedConnectionId ? '切换到已连接工作区' : '连接当前电脑'}</Button>
          : state.step === 'confirm-switch'
            ? <Button variant="primary" disabled={working} onClick={confirmSwitch}>确认切换</Button>
            : null

  if (state.step === 'create-organization') return <div className="organization-create">
    <header className="organization-create-header">
      <button type="button" className="organization-create-back" disabled={working} onClick={() => dispatch({ type: 'back' })}><ArrowLeft size={16} />返回</button>
      <button type="button" className="account-header-button" aria-label="关闭账号与工作区" disabled={working} onClick={requestClose}><X size={17} /></button>
    </header>
    <main className="organization-create-content my-scrollbar">
      <div className="organization-create-inner">
        <span className="organization-create-icon" aria-hidden="true"><Building2 size={26} /></span>
        <h2 ref={headingRef} tabIndex={-1}>创建组织</h2>
        <p className="organization-create-description">为团队创建组织，接下来设置工作区。</p>
        {feedbackError && <div className="account-inline-error" role="alert"><span>{feedbackError}</span>{loadError && <Button size="sm" variant="ghost" disabled={working} onClick={() => void refreshAccounts(false)}>重试</Button>}</div>}
        {state.status && <div className="account-inline-status" role="status">{state.status}</div>}
        <form className="organization-create-form" onSubmit={(event) => { event.preventDefault(); createOrganization() }} onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }}>
          <Field label="组织名称"><input ref={organizationNameRef} className={inputClass} value={state.draft.organizationName} disabled={working} aria-invalid={validation?.field === 'organizationName' || undefined} aria-describedby={validation?.field === 'organizationName' ? 'organization-name-error' : undefined} onChange={(event) => updateDraft('organizationName', event.target.value)} /></Field>
          {validation?.field === 'organizationName' && <p id="organization-name-error" className="account-field-error">{validation.message}</p>}
          <Button variant="primary" disabled={working} onClick={createOrganization}>{state.operation?.kind === 'scope' ? <><LoaderCircle className="account-spinner" size={15} />创建中…</> : '创建组织'}</Button>
          <button type="submit" className="sr-only" tabIndex={-1} disabled={working}>创建组织</button>
        </form>
        <span className="organization-create-status" role="status" aria-live="polite">{state.operation ? operationLabels[state.operation.kind] : null}</span>
      </div>
    </main>
  </div>

  return <div className="account-flow">
    <header className="account-flow-header">
      {state.step !== 'entry' ? <button type="button" className="account-header-button" aria-label="返回上一步" disabled={working} onClick={() => dispatch({ type: 'back' })}><ArrowLeft size={17} /></button> : <span className="account-header-spacer" />}
      <div><h2 ref={headingRef} tabIndex={-1}>{stepTitles[state.step]}</h2>{state.step !== 'entry' && state.step !== 'confirm-switch' && <small>{state.draft.origin}</small>}</div>
      <button type="button" className="account-header-button" aria-label="关闭账号与工作区" disabled={working} onClick={requestClose}><X size={17} /></button>
    </header>
    <AccountProgress step={state.step} />
    <div className="account-flow-body my-scrollbar">
      <div className="account-flow-inner">
      {feedbackError && <div className="account-inline-error" role="alert"><span>{feedbackError}</span>{loadError && <Button size="sm" variant="ghost" onClick={() => void refreshAccounts(false)}>重试</Button>}</div>}
      {state.status && <div className="account-inline-status" role="status">{state.status}</div>}
      {content}
      {(state.step !== 'entry') && <footer className="account-flow-footer">
      <Button variant="ghost" disabled={working} onClick={() => dispatch({ type: 'back' })}>{state.step === 'confirm-switch' ? '取消' : '返回'}</Button>
      <span className="account-operation-status" role="status" aria-live="polite">{state.operation ? <><LoaderCircle className="account-spinner" size={14} />{operationLabels[state.operation.kind]}</> : null}</span>
      {primary}
      </footer>}
      </div>
    </div>
  </div>
}
