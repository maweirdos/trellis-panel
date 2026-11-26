import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import {
  ArrowLeft, Building2, Check, ChevronRight, Cloud, KeyRound, Laptop,
  LoaderCircle, LogIn, LogOut, Plus, ShieldCheck, UserPlus, Users, X
} from 'lucide-react'
import type { DesktopTeamAuthOptions } from '@shared/team-desktop-account'
import { teamLocalUsernameSchema } from '@shared/team-auth'
import { teamAuthFailure } from '@shared/team-auth-feedback'
import { deriveSpaceKeyFromName } from '@shared/crux-space-presets'
import { useApp } from '../../store'
import { Button } from '../../my/ui'
import { Field, inputClass } from '../ui'
import { useCrux } from '../store'
import { releaseCommandId, retainCommandId } from './command-identity'
import { DesktopAccountReplyError, desktopAccountAdapter, type DesktopAccountAdapter } from './desktop-account-adapter'
import { SpaceSetupWizard } from './SpaceSetupWizard'
import {
  createInitialDraft,
  emptyConnectedSnapshot,
  type AccountAuthMode,
  type AccountDraft,
  type AccountFlowStep,
  type DesktopAccountGroup,
  type DesktopAccountSession,
  type DesktopConnectedAccountSnapshot,
  type DesktopScopeInvitation,
  type DesktopWorkspaceChoice
} from './model'
import './organization-create.css'

export interface AccountFlowProps {
  open: boolean
  initialStep?: 'entry' | 'accounts' | 'auth' | 'organizations' | 'create-organization'
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

const organizationRoleLabels: Record<'owner' | 'admin' | 'member', string> = { owner: '所有者', admin: '组织管理员', member: '组织成员' }
const workspaceRoleLabels: Record<'product' | 'pm' | 'developer' | 'tester' | 'admin', string> = { product: '产品', pm: '项目管理', developer: '开发', tester: '测试', admin: '管理员' }
const providerLabels: Record<DesktopAccountGroup['provider'], string> = { local: '本地账号', gitlab: 'GitLab', oidc: '企业单点登录', unknown: '团队账号' }

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function normalizeInitialStep(step: AccountFlowProps['initialStep']): AccountFlowStep {
  if (step === 'auth') return 'auth'
  if (step === 'create-organization') return 'create-organization'
  return 'organizations'
}

export function AccountFlow({
  open,
  initialStep = 'organizations',
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
  const workspaceContext = useCrux((state) => state.workspaceContext)
  const workspaceSnapshot = useCrux((state) => state.snapshot)

  const [step, setStep] = useState<AccountFlowStep>(() => normalizeInitialStep(initialStep))
  const [authMode, setAuthMode] = useState<AccountAuthMode>('login')
  const [draft, setDraft] = useState<AccountDraft>(createInitialDraft)
  const [snapshot, setSnapshot] = useState<DesktopConnectedAccountSnapshot>(emptyConnectedSnapshot)
  const [session, setSession] = useState<DesktopAccountSession | null>(null)
  const [inspectedInvitation, setInspectedInvitation] = useState<DesktopScopeInvitation | null>(null)
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [authCheck, setAuthCheck] = useState<{ origin: string; options: DesktopTeamAuthOptions } | null>(null)
  const [authOptionsError, setAuthOptionsError] = useState<string | null>(null)
  const [authCheckAttempt, setAuthCheckAttempt] = useState(0)
  const [reauthAccountId, setReauthAccountId] = useState<string | null>(null)
  const [reauthUsername, setReauthUsername] = useState('')
  const [reauthPassword, setReauthPassword] = useState('')
  const [confirmLogoutId, setConfirmLogoutId] = useState<string | null>(null)
  const [setupSpaceId, setSetupSpaceId] = useState<string | null>(null)
  const [setupOrgName, setSetupOrgName] = useState<string | null>(null)

  const openRef = useRef(open)
  openRef.current = open
  const currentConnectionRef = useRef(currentConnectionId)
  currentConnectionRef.current = currentConnectionId
  const loadTicket = useRef(0)
  const authOptionsTicket = useRef(0)
  const operationLock = useRef(false)
  const autoRoutedRef = useRef(false)
  const originDetailsRef = useRef<HTMLDetailsElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const displayNameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmPasswordRef = useRef<HTMLInputElement>(null)
  const orgNameRef = useRef<HTMLInputElement>(null)
  const inviteInputRef = useRef<HTMLInputElement>(null)

  const authOptions = authCheck?.origin === draft.origin ? authCheck.options : null
  const working = Boolean(busyLabel) || hostBusy

  const activeAccount = useMemo(
    () => snapshot.accounts.find((item) => item.accountId === session?.accountId && item.state === 'active')
      ?? snapshot.accounts.find((item) => item.state === 'active')
      ?? null,
    [snapshot.accounts, session]
  )

  const refreshAccounts = useCallback(async (background = false): Promise<DesktopConnectedAccountSnapshot | null> => {
    const ticket = ++loadTicket.current
    if (!background) setLoadingAccounts(true)
    try {
      const loaded = await adapter.loadConnectedAccounts(currentConnectionRef.current)
      if (ticket !== loadTicket.current || !openRef.current) return null
      setSnapshot(loaded)
      if (loaded.suggestedOrigin) {
        setDraft((prev) => prev.origin === createInitialDraft().origin ? { ...prev, origin: loaded.suggestedOrigin! } : prev)
      }
      const primaryActive = loaded.accounts.find((item) => item.state === 'active')
      if (primaryActive) {
        setSession({
          accountId: primaryActive.accountId,
          displayName: primaryActive.displayName,
          provider: primaryActive.provider === 'unknown' ? 'local' : primaryActive.provider,
          origin: primaryActive.origin
        })
      } else {
        setSession(null)
      }
      // 首次打开时，如果没有任何已保存账号，直接落到干净登录页
      if (!autoRoutedRef.current) {
        autoRoutedRef.current = true
        if (loaded.accounts.length === 0 && step === 'organizations') {
          setStep('auth')
        }
      }
      return loaded
    } catch (cause) {
      if (ticket === loadTicket.current && openRef.current) setError(errorMessage(cause))
      return null
    } finally {
      if (ticket === loadTicket.current && openRef.current) setLoadingAccounts(false)
    }
  }, [adapter, step])

  useEffect(() => {
    if (!open) {
      loadTicket.current++
      operationLock.current = false
      autoRoutedRef.current = false
      setBusyLabel(null)
      setError(null)
      setStatus(null)
      setConfirmLogoutId(null)
      setReauthAccountId(null)
      setReauthPassword('')
      setInspectedInvitation(null)
      setSetupSpaceId(null)
      return
    }
    openRef.current = true
    autoRoutedRef.current = false
    setStep(normalizeInitialStep(initialStep))
    setError(null)
    setStatus(null)
    setDraft((prev) => ({ ...prev, password: '', confirmPassword: '' }))
    void refreshAccounts(false)
    return () => {
      openRef.current = false
      loadTicket.current++
    }
  }, [open, initialStep, refreshAccounts])

  useEffect(() => {
    if (!open) return
    return adapter.subscribe(() => { void refreshAccounts(true) })
  }, [open, adapter, refreshAccounts])

  useEffect(() => {
    if (!open || step !== 'auth') return
    const origin = draft.origin.trim()
    setAuthCheck(null)
    setAuthOptionsError(null)
    if (!origin) return
    const ticket = ++authOptionsTicket.current
    void adapter.authOptions(origin).then((options) => {
      if (ticket === authOptionsTicket.current && openRef.current) setAuthCheck({ origin: draft.origin, options })
    }).catch((cause) => {
      if (ticket === authOptionsTicket.current && openRef.current) {
        setAuthOptionsError(errorMessage(cause))
        if (originDetailsRef.current) originDetailsRef.current.open = true
      }
    })
    return () => { authOptionsTicket.current++ }
  }, [adapter, open, step, draft.origin, authCheckAttempt])

  const requestClose = useCallback((): void => {
    if (working || operationLock.current || useCrux.getState().busy) return
    onClose()
  }, [onClose, working])

  useLayoutEffect(() => {
    if (!requestCloseRef) return
    requestCloseRef.current = requestClose
    return () => {
      if (requestCloseRef.current === requestClose) requestCloseRef.current = null
    }
  }, [requestClose, requestCloseRef])

  const updateDraft = <K extends keyof AccountDraft>(field: K, value: AccountDraft[K]): void => {
    setDraft((prev) => ({ ...prev, [field]: value }))
    setError(null)
  }

  const focusAndFail = (message: string, ref?: RefObject<HTMLInputElement>): void => {
    setError(message)
    if (ref?.current) window.requestAnimationFrame(() => ref.current?.focus())
  }

  const runAction = async <T,>(label: string, work: () => Promise<T>): Promise<T | null> => {
    if (operationLock.current || hostBusy) return null
    operationLock.current = true
    setBusyLabel(label)
    setError(null)
    setStatus(null)
    try {
      return await work()
    } catch (cause) {
      if (openRef.current) {
        const mapped = cause instanceof DesktopAccountReplyError
          ? teamAuthFailure(cause.code, authMode === 'register' && step === 'auth', cause.outcomeUnknown)
          : null
        setError(mapped?.message ?? errorMessage(cause))
      }
      return null
    } finally {
      operationLock.current = false
      if (openRef.current) setBusyLabel(null)
    }
  }

  /** 无感完成设备绑定并切换进入指定组织；若默认空间未初始化则自动落入 2 步空间向导。 */
  const enterWorkspaceAtomically = async (targetSession: DesktopAccountSession, organizationId: string, workspaceId: string, organizationName: string, preferredSpaceId?: string): Promise<void> => {
    const { connectionId } = await adapter.ensureDeviceConnection({
      session: targetSession,
      organizationId,
      workspaceId,
      currentConnectionId: currentConnectionRef.current
    })
    const switched = await onSelectWorkspace(connectionId)
    if (!switched) throw new Error('未能切换到该组织，请先处理当前未完成操作后重试。')
    const latestCrux = useCrux.getState()
    const targetSpace = (preferredSpaceId ? latestCrux.snapshot?.spaces.find((item) => item.id === preferredSpaceId) : undefined)
      ?? latestCrux.snapshot?.spaces.find((item) => !item.archived)
    if (targetSpace && targetSpace.initialized === false && latestCrux.workspaceContext.canManage) {
      setSetupSpaceId(targetSpace.id)
      setSetupOrgName(organizationName)
      setStep('space-setup')
      return
    }
    if (targetSpace) {
      latestCrux.setCurrentSpace(targetSpace.id)
      latestCrux.setModule('board')
    }
    onClose()
    if (!returnToOnboarding) useApp.getState().setPage('crux')
  }

  const handleAuthSubmit = async (): Promise<void> => {
    if (!draft.origin.trim()) {
      if (originDetailsRef.current) originDetailsRef.current.open = true
      focusAndFail('请输入团队服务地址。')
      return
    }
    if (!draft.username.trim()) { focusAndFail('请输入用户名。', usernameRef); return }
    if (!teamLocalUsernameSchema.safeParse(draft.username).success) {
      focusAndFail('用户名需为 3～64 位英文字母、数字、点、下划线或短横线。', usernameRef)
      return
    }
    if (authMode === 'register' && !draft.displayName.trim()) { focusAndFail('请输入你的显示名称。', displayNameRef); return }
    if (!draft.password) { focusAndFail('请输入密码。', passwordRef); return }
    if (authMode === 'register' && draft.confirmPassword !== draft.password) { focusAndFail('两次输入的密码不一致。', confirmPasswordRef); return }
    if (!authOptions || authOptionsError) { focusAndFail('团队服务暂未连接，请先核对服务地址。'); return }

    await runAction(authMode === 'register' ? '正在注册账号…' : '正在登录…', async () => {
      const authed = await adapter.authenticateLocal({
        mode: authMode,
        origin: authOptions.origin,
        username: draft.username.trim(),
        ...(authMode === 'register' ? { displayName: draft.displayName.trim() } : {}),
        password: draft.password
      })
      setDraft((prev) => ({ ...prev, password: '', confirmPassword: '' }))
      const { session: activeSession, scope } = await adapter.openAccount(authed.accountId)
      setSession(activeSession)
      await refreshAccounts(true)
      const orgs = scope.organizations.filter((org) => org.workspaces.length > 0)
      if (orgs.length === 0) {
        setStep('create-organization')
        return
      }
      if (orgs.length === 1) {
        await enterWorkspaceAtomically(activeSession, orgs[0].organizationId, orgs[0].workspaces[0].workspaceId, orgs[0].name)
        return
      }
      setStep('organizations')
    })
  }

  const handleReauthSubmit = async (account: DesktopAccountGroup): Promise<void> => {
    if (!reauthUsername.trim() || !reauthPassword) {
      setError('请输入用户名和密码以恢复登录状态。')
      return
    }
    await runAction('正在重新验证登录…', async () => {
      const authed = await adapter.authenticateLocal({
        mode: 'login',
        origin: account.origin,
        username: reauthUsername.trim(),
        password: reauthPassword
      })
      setReauthAccountId(null)
      setReauthPassword('')
      const { session: activeSession, scope } = await adapter.openAccount(authed.accountId)
      setSession(activeSession)
      await refreshAccounts(true)
      if (scope.organizations.length === 1 && scope.organizations[0].workspaces.length > 0) {
        await enterWorkspaceAtomically(activeSession, scope.organizations[0].organizationId, scope.organizations[0].workspaces[0].workspaceId, scope.organizations[0].name)
        return
      }
      setStatus('登录状态已恢复。')
    })
  }

  const handleEnterWorkspaceRow = async (account: DesktopAccountGroup, workspace: DesktopWorkspaceChoice): Promise<void> => {
    if (workspace.current) {
      onClose()
      if (!returnToOnboarding) useApp.getState().setPage('crux')
      return
    }
    if (!workspace.workspaceId || !workspace.organizationId) {
      if (workspace.connectionId && workspace.state === 'active' && !workspace.accessLocked) {
        await runAction('正在切换组织…', async () => {
          const ok = await onSelectWorkspace(workspace.connectionId)
          if (!ok) throw new Error('未能切换到该组织，请重试。')
          onClose()
          if (!returnToOnboarding) useApp.getState().setPage('crux')
        })
      }
      return
    }
    const targetSession: DesktopAccountSession = {
      accountId: account.accountId,
      displayName: account.displayName,
      provider: account.provider === 'unknown' ? 'local' : account.provider,
      origin: account.origin
    }
    await runAction(`正在进入「${workspace.organizationName ?? workspace.workspaceName}」…`, async () => {
      await enterWorkspaceAtomically(targetSession, workspace.organizationId!, workspace.workspaceId!, workspace.organizationName ?? workspace.workspaceName)
    })
  }

  const handleCreateOrganization = async (): Promise<void> => {
    const active = session ?? (activeAccount ? {
      accountId: activeAccount.accountId,
      displayName: activeAccount.displayName,
      provider: activeAccount.provider === 'unknown' ? 'local' : activeAccount.provider,
      origin: activeAccount.origin
    } : null)
    if (!active) { setStep('auth'); return }
    const name = draft.organizationName.trim()
    const spaceKey = draft.organizationSpaceKey.trim().toUpperCase()
    if (!name) { focusAndFail('请输入组织名称。', orgNameRef); return }
    if (!/^[A-Z0-9]{2,7}$/.test(spaceKey)) { focusAndFail('默认空间前缀需为 2～7 位大写字母或数字。'); return }
    const commandKey = `org-create:${active.accountId}:${name}:${spaceKey}`
    const commandId = retainCommandId(commandKey)
    await runAction('正在创建组织并初始化工作环境…', async () => {
      const created = await adapter.createOrganization(active, commandId, name, spaceKey)
      releaseCommandId(commandKey, commandId)
      setDraft((prev) => ({ ...prev, organizationName: '', organizationSpaceKey: 'MAIN', spaceKeyEdited: false }))
      await refreshAccounts(true)
      await enterWorkspaceAtomically(active, created.organizationId, created.workspaceId, name, created.spaceId)
    })
  }

  const handleInspectInvitation = async (): Promise<void> => {
    if (!session) return
    const url = draft.invitationToken.trim()
    if (!url) { focusAndFail('请粘贴完整的邀请链接。', inviteInputRef); return }
    await runAction('正在核对邀请链接…', async () => {
      const info = await adapter.inspectInvitation(session, url)
      setInspectedInvitation(info)
    })
  }

  const handleAcceptInvitation = async (): Promise<void> => {
    if (!session || !inspectedInvitation) return
    const commandKey = `accept-invite:${session.accountId}:${inspectedInvitation.invitationId}`
    const commandId = retainCommandId(commandKey)
    await runAction('正在加入组织…', async () => {
      await adapter.acceptInvitation(session, commandId, inspectedInvitation)
      releaseCommandId(commandKey, commandId)
      const orgId = inspectedInvitation.organizationId
      const wsId = inspectedInvitation.workspaceId
      const orgName = inspectedInvitation.organizationName
      const spaceId = inspectedInvitation.space?.id
      setInspectedInvitation(null)
      updateDraft('invitationToken', '')
      await refreshAccounts(true)
      await enterWorkspaceAtomically(session, orgId, wsId, orgName, spaceId)
    })
  }

  const handleLogout = async (accountId: string): Promise<void> => {
    await runAction('正在退出登录…', async () => {
      await adapter.logoutAccount(accountId)
      setConfirmLogoutId(null)
      await onWorkspaceUpdated()
      const loaded = await refreshAccounts(true)
      if (!loaded || !loaded.accounts.some((item) => item.state === 'active')) {
        setStep('auth')
        setStatus('已退出登录并清理本机连接。')
      } else {
        setStatus('已退出该账号。')
      }
    })
  }

  const handleSwitchToLocal = async (): Promise<void> => {
    if (currentIsLocal) { onClose(); return }
    await runAction('正在切回本机个人模式…', async () => {
      const ok = await onSelectWorkspace(null)
      if (!ok) throw new Error('未能切换回本机模式，请先处理正在进行的操作。')
      onClose()
    })
  }

  const handlePendingCommand = async (commandId: string, discard: boolean): Promise<void> => {
    await runAction(discard ? '正在清理待核对操作…' : '正在核对原操作…', async () => {
      if (discard) await adapter.discardPending(commandId)
      else await adapter.retryPending(commandId)
      await onWorkspaceUpdated()
      await refreshAccounts(true)
    })
  }

  const setupSpace = workspaceSnapshot?.spaces.find((item) => item.id === setupSpaceId) ?? workspaceSnapshot?.spaces[0]

  return <section className="account-flow" aria-label="账号与组织">
    <header className="account-topbar">
      <div className="account-topbar-left">
        {(step === 'create-organization' || step === 'accept-invitation' || (step === 'auth' && snapshot.accounts.length > 0)) && (
          <Button variant="ghost" size="sm" disabled={working} onClick={() => { setError(null); setStep('organizations') }}>
            <ArrowLeft size={14} />返回
          </Button>
        )}
      </div>
      <div className="account-topbar-right">
        {activeAccount && step !== 'auth' && step !== 'space-setup' && (
          <Button variant="ghost" size="sm" disabled={working} onClick={() => void handleLogout(activeAccount.accountId)}>
            <LogOut size={14} />退出登录
          </Button>
        )}
        <button type="button" className="my-icon-control" aria-label="关闭" disabled={working} onClick={requestClose}>
          <X size={16} />
        </button>
      </div>
    </header>

    <div className="account-stage my-scrollbar">
      <div className={`account-stage-inner ${step === 'space-setup' ? 'is-wide' : ''}`}>
        {error && <div role="alert" className="account-inline-error">{error}</div>}
        {status && <div role="status" className="account-capability-note"><Check size={15} /><span>{status}</span></div>}

        {step === 'auth' && <>
          <div className="account-hero">
            <span className="account-hero-icon"><Users size={22} /></span>
            <h1>{authMode === 'login' ? '登录团队账号' : '注册团队账号'}</h1>
            <p>登录后可直接创建或切换组织，本机设备会自动完成安全绑定。</p>
          </div>
          <form className="account-card" onSubmit={(event) => { event.preventDefault(); void handleAuthSubmit() }}>
            <div className="account-segmented" role="group" aria-label="登录或注册">
              <button type="button" aria-pressed={authMode === 'login'} disabled={working} onClick={() => { setAuthMode('login'); setError(null) }}>
                <LogIn size={14} />登录
              </button>
              <button type="button" aria-pressed={authMode === 'register'} disabled={working || authOptions?.selfRegistration === false} onClick={() => { setAuthMode('register'); setError(null) }}>
                <UserPlus size={14} />注册
              </button>
            </div>

            <Field label="用户名">
              <input ref={usernameRef} className={inputClass} autoFocus autoComplete="username" value={draft.username} disabled={working} onChange={(event) => updateDraft('username', event.target.value)} placeholder="3~64 位字母或数字" />
            </Field>
            {authMode === 'register' && (
              <Field label="显示名称">
                <input ref={displayNameRef} className={inputClass} autoComplete="name" maxLength={200} value={draft.displayName} disabled={working} onChange={(event) => updateDraft('displayName', event.target.value)} placeholder="同事在空间中看到的姓名" />
              </Field>
            )}
            <Field label="密码">
              <input ref={passwordRef} className={inputClass} type="password" maxLength={256} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} value={draft.password} disabled={working} onChange={(event) => updateDraft('password', event.target.value)} />
            </Field>
            {authMode === 'register' && (
              <Field label="确认密码">
                <input ref={confirmPasswordRef} className={inputClass} type="password" autoComplete="new-password" value={draft.confirmPassword} disabled={working} onChange={(event) => updateDraft('confirmPassword', event.target.value)} />
              </Field>
            )}

            <Button type="submit" variant="primary" className="w-full justify-center" disabled={working || Boolean(authOptionsError)}>
              {working && <LoaderCircle size={14} className="account-spinner" aria-hidden="true" />}
              {busyLabel ?? (authMode === 'login' ? '登录并进入' : '注册并开始')}
            </Button>

            {authOptionsError && (
              <div className="account-inline-error" role="alert">
                <span>无法连接团队服务：{authOptionsError}</span>
                <Button size="sm" variant="ghost" disabled={working} onClick={() => setAuthCheckAttempt((n) => n + 1)}>重试</Button>
              </div>
            )}

            <details ref={originDetailsRef} className="account-service-settings">
              <summary><Cloud size={14} /><span>团队服务地址</span><code>{draft.origin || '未设置'}</code></summary>
              <div className="mt-2">
                <Field label="服务地址">
                  <input className={inputClass} value={draft.origin} disabled={working} onChange={(event) => updateDraft('origin', event.target.value)} inputMode="url" spellCheck={false} />
                </Field>
              </div>
            </details>
          </form>

          <div className="flex items-center justify-between text-my-xs text-my-tertiary">
            <button type="button" className="hover:text-my-primary" disabled={working} onClick={() => void handleSwitchToLocal()}>
              暂不登录，仅在本机使用
            </button>
            {snapshot.accounts.length > 0 && (
              <button type="button" className="hover:text-my-primary" disabled={working} onClick={() => setStep('organizations')}>
                返回已有账号 ({snapshot.accounts.length})
              </button>
            )}
          </div>
        </>}

        {step === 'organizations' && <>
          <div className="account-hero">
            <span className="account-hero-icon"><Building2 size={22} /></span>
            <h1>选择或管理组织</h1>
            <p>{activeAccount ? `${activeAccount.displayName} · 点击组织即可自动连接并进入空间` : '选择已有账号恢复登录，或切换到本机个人模式'}</p>
          </div>

          {loadingAccounts && snapshot.accounts.length === 0 && (
            <p role="status" className="account-quiet-status justify-center">
              <LoaderCircle size={15} className="account-spinner" />正在读取账号与组织…
            </p>
          )}

          {snapshot.accounts.map((account) => {
            const expired = account.state === 'reauthentication-required' || account.state === 'signed-out'
            const isReauthing = reauthAccountId === account.accountId
            return (
              <section key={account.accountId} className="account-card">
                <header className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="account-org-avatar">{account.displayName.trim().slice(0, 1) || '?'}</span>
                    <div className="account-org-meta">
                      <strong>{account.displayName}</strong>
                      <small>{providerLabels[account.provider]} · {account.origin}</small>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className={`account-badge ${account.state === 'active' ? 'is-active' : 'is-warn'}`}>
                      {account.state === 'active' ? '已登录' : account.state === 'reauthentication-required' ? '登录已过期' : account.state === 'signed-out' ? '已退出' : '仅设备连接'}
                    </span>
                    {account.state !== 'connection-only' && (
                      <Button size="sm" variant="ghost" disabled={working} onClick={() => setConfirmLogoutId(confirmLogoutId === account.accountId ? null : account.accountId)}>
                        退出
                      </Button>
                    )}
                  </div>
                </header>

                {confirmLogoutId === account.accountId && (
                  <div className="account-reauth-panel" role="group" aria-label="确认退出登录">
                    <p className="m-0 text-my-xs text-my-secondary">退出登录会同时清除该账号的本机登录态并断开关联的本机连接，已同步到服务端的组织数据不受影响。</p>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" disabled={working} onClick={() => setConfirmLogoutId(null)}>取消</Button>
                      <Button size="sm" variant="danger" disabled={working} onClick={() => void handleLogout(account.accountId)}>确认退出登录</Button>
                    </div>
                  </div>
                )}

                {expired && (
                  <div className="account-reauth-panel">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-my-xs text-my-secondary">登录凭证已过期或已退出，重新输入密码即可恢复组织列表。</span>
                      {!isReauthing && (
                        <Button size="sm" variant="primary" disabled={working} onClick={() => { setReauthAccountId(account.accountId); setReauthUsername(''); setReauthPassword(''); setError(null) }}>
                          <KeyRound size={13} />重新登录
                        </Button>
                      )}
                    </div>
                    {isReauthing && (
                      <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void handleReauthSubmit(account) }}>
                        <input className={inputClass} autoFocus placeholder="输入用户名" value={reauthUsername} disabled={working} onChange={(event) => setReauthUsername(event.target.value)} />
                        <input className={inputClass} type="password" placeholder="输入密码" value={reauthPassword} disabled={working} onChange={(event) => setReauthPassword(event.target.value)} />
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" disabled={working} onClick={() => setReauthAccountId(null)}>取消</Button>
                          <Button type="submit" size="sm" variant="primary" disabled={working}>验证并恢复</Button>
                        </div>
                      </form>
                    )}
                  </div>
                )}

                {account.scopeError && (
                  <div className="account-inline-error" role="status">{account.scopeError}</div>
                )}

                {account.state === 'active' && account.workspaces.length === 0 && !account.scopeError && (
                  <div className="flex flex-col gap-2 rounded-my-base border border-dashed border-my-line p-3 text-center">
                    <p className="m-0 text-my-xs text-my-secondary">这个账号还没有加入任何组织，立即创建一个或粘贴邀请链接加入。</p>
                    <div className="flex justify-center gap-2">
                      <Button size="sm" variant="primary" disabled={working} onClick={() => {
                        setSession({ accountId: account.accountId, displayName: account.displayName, provider: account.provider === 'unknown' ? 'local' : account.provider, origin: account.origin })
                        setStep('create-organization')
                      }}><Plus size={14} />创建组织</Button>
                      <Button size="sm" variant="outline" disabled={working} onClick={() => {
                        setSession({ accountId: account.accountId, displayName: account.displayName, provider: account.provider === 'unknown' ? 'local' : account.provider, origin: account.origin })
                        setStep('accept-invitation')
                      }}><UserPlus size={14} />接受邀请</Button>
                    </div>
                  </div>
                )}

                {account.workspaces.length > 0 && (
                  <div className="account-org-list">
                    {account.workspaces.map((workspace) => {
                      const label = workspace.organizationName ?? workspace.workspaceName
                      return (
                        <button
                          key={workspace.connectionId ?? workspace.workspaceId ?? label}
                          type="button"
                          className="account-org-row"
                          data-current={workspace.current || undefined}
                          disabled={working || (account.state !== 'active' && !workspace.current)}
                          onClick={() => void handleEnterWorkspaceRow(account, workspace)}
                        >
                          <span className="account-org-avatar">{label.trim().slice(0, 2).toUpperCase() || 'OR'}</span>
                          <span className="account-org-meta">
                            <strong>{label}</strong>
                            <small>{workspace.current ? '当前所在组织' : workspace.state === 'active' ? '本机已就绪 · 点击切换' : '点击自动连接并进入'}</small>
                          </span>
                          {workspace.current
                            ? <span className="account-badge is-active"><Check size={12} />当前</span>
                            : <ChevronRight size={16} className="shrink-0 text-my-icon-tertiary" />}
                        </button>
                      )
                    })}
                  </div>
                )}

                {account.state === 'active' && account.workspaces.length > 0 && (
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button size="sm" variant="ghost" disabled={working} onClick={() => {
                      setSession({ accountId: account.accountId, displayName: account.displayName, provider: account.provider === 'unknown' ? 'local' : account.provider, origin: account.origin })
                      setStep('accept-invitation')
                    }}>接受邀请</Button>
                    <Button size="sm" variant="outline" disabled={working} onClick={() => {
                      setSession({ accountId: account.accountId, displayName: account.displayName, provider: account.provider === 'unknown' ? 'local' : account.provider, origin: account.origin })
                      setStep('create-organization')
                    }}><Plus size={13} />创建新组织</Button>
                  </div>
                )}
              </section>
            )
          })}

          {snapshot.pendingCommands.length > 0 && (
            <details className="account-retained-operations">
              <summary>{snapshot.pendingCommands.length} 条历史待核对操作</summary>
              <p>这些操作属于原组织连接，可核对重试或直接清理。</p>
              {snapshot.pendingCommands.map((command) => (
                <div key={command.commandId}>
                  <span>{command.operation}<small>{command.outcomeUnknown ? '结果待确认' : '尚未同步'}</small></span>
                  <Button size="sm" variant="ghost" disabled={working} onClick={() => void handlePendingCommand(command.commandId, false)}>重试核对</Button>
                  {!command.outcomeUnknown && <Button size="sm" variant="ghost" disabled={working} onClick={() => void handlePendingCommand(command.commandId, true)}>放弃</Button>}
                </div>
              ))}
            </details>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button variant="ghost" size="sm" disabled={working} onClick={() => void handleSwitchToLocal()}>
              <Laptop size={14} />{currentIsLocal ? '继续使用本机个人模式' : '切回本机个人模式'}
            </Button>
            <Button variant="outline" size="sm" disabled={working} onClick={() => { setError(null); setStep('auth') }}>
              <LogIn size={14} />登录其他账号
            </Button>
          </div>
        </>}

        {step === 'create-organization' && <>
          <div className="account-hero">
            <span className="account-hero-icon"><Building2 size={22} /></span>
            <h1>创建组织</h1>
            <p>团队与 Agent 共同构建的地方，创建后将引导你初始化默认空间。</p>
          </div>
          <form className="account-card" onSubmit={(event) => { event.preventDefault(); void handleCreateOrganization() }}>
            <Field label="组织名称">
              <input
                ref={orgNameRef}
                className={inputClass}
                autoFocus
                disabled={working}
                placeholder="例如：Honsky 研发团队"
                value={draft.organizationName}
                onChange={(event) => {
                  const nextName = event.target.value
                  setDraft((prev) => ({
                    ...prev,
                    organizationName: nextName,
                    organizationSpaceKey: prev.spaceKeyEdited ? prev.organizationSpaceKey : deriveSpaceKeyFromName(nextName)
                  }))
                  setError(null)
                }}
              />
            </Field>
            <Field label="默认空间任务前缀" hint="用于自动生成任务编号（例如 HONS-1），2～7 位大写字母或数字。">
              <div className="account-prefix-input">
                <span>编号前缀</span>
                <input
                  className="font-mono"
                  maxLength={7}
                  disabled={working}
                  value={draft.organizationSpaceKey}
                  onChange={(event) => setDraft((prev) => ({ ...prev, organizationSpaceKey: event.target.value.toUpperCase(), spaceKeyEdited: true }))}
                  placeholder="MAIN"
                />
              </div>
            </Field>
            <Button type="submit" variant="primary" className="w-full justify-center" disabled={working || !draft.organizationName.trim()}>
              {working && <LoaderCircle size={14} className="account-spinner" aria-hidden="true" />}
              {busyLabel ?? '创建并初始化空间'}
            </Button>
          </form>
          <div className="text-center text-my-xs text-my-tertiary">
            已有团队邀请？<button type="button" className="ml-1 text-my-primary hover:underline" disabled={working} onClick={() => setStep('accept-invitation')}>使用邀请链接加入</button>
          </div>
        </>}

        {step === 'accept-invitation' && <>
          <div className="account-hero">
            <span className="account-hero-icon"><UserPlus size={22} /></span>
            <h1>接受组织邀请</h1>
            <p>粘贴管理员发给你的完整邀请链接，核对权限后即可直接进入。</p>
          </div>
          <div className="account-card">
            <Field label="邀请链接">
              <input
                ref={inviteInputRef}
                className={inputClass}
                autoFocus
                spellCheck={false}
                disabled={working}
                value={draft.invitationToken}
                onChange={(event) => { updateDraft('invitationToken', event.target.value); setInspectedInvitation(null) }}
                placeholder="粘贴完整邀请链接…"
              />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" disabled={working || !draft.invitationToken.trim()} onClick={() => void handleInspectInvitation()}>
                核对邀请
              </Button>
            </div>
            {inspectedInvitation && (
              <div className="account-invitation-inspection">
                <div>
                  <ShieldCheck size={16} />
                  <span>
                    <strong>{inspectedInvitation.organizationName}</strong>
                    <small>{inspectedInvitation.space ? `直达空间：${inspectedInvitation.space.name}` : '加入后可访问组织内公开空间'}</small>
                  </span>
                </div>
                <dl>
                  <div><dt>组织角色</dt><dd>{inspectedInvitation.organizationRoles.map((role) => organizationRoleLabels[role]).join('、')}</dd></div>
                  <div><dt>协作职责</dt><dd>{inspectedInvitation.workspaceRoles.map((role) => workspaceRoleLabels[role]).join('、')}</dd></div>
                  <div><dt>有效期至</dt><dd>{new Date(inspectedInvitation.expiresAt).toLocaleString('zh-CN')}</dd></div>
                </dl>
                <Button variant="primary" size="sm" disabled={working || inspectedInvitation.status !== 'pending'} onClick={() => void handleAcceptInvitation()}>
                  {inspectedInvitation.status === 'pending' ? '确认接受并进入组织' : '该邀请已不可用'}
                </Button>
              </div>
            )}
          </div>
        </>}

        {step === 'space-setup' && setupSpace && (
          <div className="account-card p-0 overflow-hidden">
            <SpaceSetupWizard
              mode="initialize"
              space={setupSpace}
              organizationName={setupOrgName ?? workspaceContext.projectName}
              onComplete={(spaceId) => {
                const crux = useCrux.getState()
                crux.setCurrentSpace(spaceId)
                crux.setModule('board')
                onClose()
                if (!returnToOnboarding) useApp.getState().setPage('crux')
              }}
            />
          </div>
        )}
      </div>
    </div>
  </section>
}
