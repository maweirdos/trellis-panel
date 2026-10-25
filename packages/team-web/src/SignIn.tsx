import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { teamAuthOptionsSchema, teamLocalAuthReplySchema } from '../../../src/shared/team-auth'
import { type TeamSession } from './contracts'
import { ApiError, request } from './client'
import { useQuery } from './hooks'
import { ErrorLine, Notice } from './ui'

export function SignIn({ onSignedIn, onOidcLogin }: { onSignedIn: (session: TeamSession, returnTo: string) => void; onOidcLogin: () => void }) {
  const options = useQuery('auth-options', (signal) => request('/api/auth/options', teamAuthOptionsSchema, { signal, notifyDenied: false }))
  const [register, setRegister] = useState(false), [username, setUsername] = useState(''), [displayName, setDisplayName] = useState(''), [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submit = async (): Promise<void> => {
    if (!options.value || busy) return
    setBusy(true); setError('')
    try {
      const result = await request(`/auth/local/${register ? 'register' : 'login'}`, teamLocalAuthReplySchema, { body: { username, password, returnTo: location.pathname + location.search + location.hash, ...(register ? { displayName } : {}) }, csrfToken: options.value.csrfToken, notifyDenied: false })
      setPassword(''); onSignedIn(result.session, result.returnTo)
    } catch (reason) {
      setError(reason instanceof ApiError && reason.uncertain && register ? '注册结果尚未确认，请切换到登录，用同一用户名和密码核对。' : reason instanceof Error ? reason.message : '登录失败')
      if (reason instanceof ApiError && reason.status === 403) options.refresh()
    } finally { setBusy(false) }
  }
  return <><form aria-label={register ? '注册独立账号' : '登录独立账号'} onSubmit={(event) => { event.preventDefault(); void submit() }}>
    <fieldset disabled={busy || !options.value}><label>用户名<input aria-label="账号用户名" value={username} autoComplete="username" required minLength={3} maxLength={64} pattern={'[A-Za-z0-9][A-Za-z0-9._\\-]*'} onChange={(event) => setUsername(event.target.value)} /></label>
      {register && <label>显示名称<input aria-label="账号显示名称" value={displayName} autoComplete="nickname" required maxLength={200} onChange={(event) => setDisplayName(event.target.value)} /></label>}
      <label>密码<input aria-label="账号密码" type="password" value={password} autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 10 : 1} maxLength={256} onChange={(event) => setPassword(event.target.value)} /></label>
      {register && <small>用户名至少 3 位，不区分大小写；密码至少 10 位。</small>}
    </fieldset><ErrorLine>{error || options.error}</ErrorLine><button type="submit" className="primary" disabled={busy || !options.value}>{busy ? '正在核对…' : register ? '注册并登录' : '登录'}</button>
  </form>{options.value?.selfRegistration && <button type="button" disabled={busy} onClick={() => { setRegister(!register); setError(''); setPassword('') }}>{register ? '已有账号，去登录' : '创建独立账号'}</button>}
  {options.value?.oidcLogin && <button type="button" onClick={onOidcLogin}><ShieldCheck size={17} />{options.value.oidcLabel}</button>}
  {!options.value?.selfRegistration && options.value && <Notice>此服务未开放自助注册，请联系服务管理员开放注册或使用已有账号。</Notice>}
  {options.error && <button type="button" onClick={options.refresh}>重新读取登录方式</button>}</>
}
