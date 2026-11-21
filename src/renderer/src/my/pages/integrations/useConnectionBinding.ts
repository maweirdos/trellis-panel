import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { connectionFields, type IntegrationConnection, type IntegrationResult, type ProviderManifest, type SaveConnectionInput } from '../../../../../shared/integrations'
import { api } from '../../../api'
import { useInteractionSignal } from '../../../utils/interaction-scope'
import { useIntegrationOwner } from './hooks'

export type BindingPhase = 'idle' | 'saving' | 'verifying' | 'authorizing' | 'cancelling' | 'complete' | 'refreshing' | 'uncertain' | 'stale'
type BindingMode = 'save' | 'verify' | 'authorize'
interface BindingState { phase: BindingPhase; error: string; outcome?: 'saved' | 'bound'; candidates?: IntegrationConnection[] }
interface Attempt { mode: BindingMode; requestId?: string; input?: SaveConnectionInput; base?: IntegrationConnection; verificationStarted?: boolean }
type RefreshConnection = (value: IntegrationConnection) => Promise<void>

function sameConfiguration(left: IntegrationConnection, right: IntegrationConnection): boolean {
  return left.id === right.id && left.providerId === right.providerId && left.enabled === right.enabled && left.name === right.name
    && JSON.stringify(Object.entries(left.config).sort()) === JSON.stringify(Object.entries(right.config).sort())
}

/** Public configuration is only used to recognize a pending broadcast, never to infer identity. */
function matchesSave(provider: ProviderManifest, saved: IntegrationConnection, input: SaveConnectionInput): boolean {
  if (saved.providerId !== input.providerId || saved.name !== input.name.trim() || saved.enabled !== input.enabled) return false
  const keys = connectionFields(provider, input.config).filter((field) => !field.secret).map((field) => field.key)
  if (provider.authentication && !saved.legacy) keys.push('authMethod')
  if (provider.id === 'jira' && input.config.authMethod === 'oauth2') keys.push('redirectUri')
  return keys.every((key) => {
    let value = input.config[key]?.trim() ?? ''
    if (key === 'baseUrl') { try { value = new URL(value).href.replace(/\/+$/, '') } catch { return false } }
    if (key === 'redirectUri' && input.config[key] === undefined) return true
    return (saved.config[key] ?? '') === value
  })
}

function signature(input: SaveConnectionInput): string {
  return JSON.stringify({ ...input, id: undefined, revision: undefined })
}
function uncertainFailure(result: IntegrationResult<unknown>): boolean {
  return !result.ok && ['E_UNKNOWN', 'E_IO', 'E_TIMEOUT', 'E_UNAVAILABLE', 'E_RESET_REQUIRED'].includes(result.code)
}
function hasCredentials(provider: ProviderManifest, value: IntegrationConnection): boolean {
  return connectionFields(provider, value.config).every((field) => !field.secret || !field.required || value.hasSecrets.includes(field.key))
}

/** One stable owner for save, native verification, cancellation and recovery. */
export function useConnectionBinding({ provider, connection, connections, authorizationAvailable, followChanges = false }: {
  provider: ProviderManifest; connection?: IntegrationConnection; connections?: readonly IntegrationConnection[]; authorizationAvailable: boolean; followChanges?: boolean
}) {
  const initial = useRef(connection)
  const { current } = useIntegrationOwner(JSON.stringify(['connection-binding', provider.id, initial.current?.id]))
  const signal = useInteractionSignal()
  const [saved, setSaved] = useState(connection)
  const savedRef = useRef(connection)
  const [state, setState] = useState<BindingState>({ phase: 'idle', error: '' })
  const stateRef = useRef(state)
  const request = useRef<Attempt | null>(null)
  const unresolved = useRef<Attempt | null>(null)
  const lastInput = useRef<string | null>(null)
  const versions = useRef(new Map<number, IntegrationConnection>(connection ? [[connection.revision, connection]] : []))
  const seen = useRef(Boolean(connection))
  const stale = useRef(false)
  const setStatus = (next: BindingState): void => { stateRef.current = next; setState(next) }
  const owns = (attempt: Attempt): boolean => current() && !stale.current && request.current === attempt
  const commit = (value: IntegrationConnection): void => {
    savedRef.current = value; versions.current.set(value.revision, value); setSaved(value)
  }
  const abandon = useCallback((): void => {
    const attempt = request.current ?? unresolved.current
    request.current = null
    unresolved.current = null
    if (attempt?.requestId && typeof api.integrations?.cancelAuthorization === 'function') void api.integrations.cancelAuthorization(attempt.requestId).catch(() => undefined)
  }, [])
  useEffect(() => {
    const cancel = (): void => abandon()
    signal?.addEventListener('abort', cancel, { once: true })
    return () => { signal?.removeEventListener('abort', cancel); abandon() }
  }, [abandon, current, signal])
  useEffect(() => {
    if (!authorizationAvailable && (request.current?.requestId || unresolved.current?.requestId)) {
      abandon()
      if (current()) setStatus({ phase: 'idle', error: '浏览器授权已停止，请恢复连接后重试。' })
    }
  }, [authorizationAvailable, abandon, current])

  // Native broadcasts may precede invoke replies. Old published snapshots remain valid while a refresh catches up.
  useLayoutEffect(() => {
    const expected = savedRef.current
    if (!expected || stale.current || !current()) return
    const observed = connections ? connections.find((item) => item.id === expected.id) : connection?.id === expected.id ? connection : undefined
    if (!observed && (!connections || !seen.current)) return
    if (observed) seen.current = true
    const attempt = request.current ?? unresolved.current
    const known = observed && versions.current.get(observed.revision)
    if (observed && known && sameConfiguration(observed, known)) {
      if (followChanges && !attempt && observed.revision === expected.revision && observed.checkedAt
        && (!expected.checkedAt || observed.checkedAt > expected.checkedAt)) commit(observed)
      return
    }
    if (observed && attempt?.input && !attempt.verificationStarted && (expected.legacy ? observed.legacy : observed.revision === expected.revision + 1) && matchesSave(provider, observed, attempt.input)) {
      return
    }
    if (observed && attempt?.requestId && observed.revision === expected.revision + 1 && sameConfiguration(observed, expected) && observed.check === 'authenticated' && observed.hasSecrets.includes('oauthTokens')) {
      return
    }
    abandon()
    if (followChanges && observed) {
      versions.current.clear(); commit(observed); lastInput.current = null
      setStatus({ phase: 'idle', error: attempt ? '连接已变化，上次授权已停止。' : '' })
    } else {
      stale.current = true
      setStatus({ phase: 'stale', error: '连接已被修改、停用或移除，请关闭后重新打开。' })
    }
  }, [connections, connection, saved, state.phase, current, provider, abandon, followChanges])

  const refresh = async (onSaved: RefreshConnection): Promise<boolean> => {
    const value = savedRef.current
    if (!value || !current() || stale.current) return false
    const outcome = stateRef.current.outcome ?? 'saved'
    setStatus({ phase: 'refreshing', error: '', outcome })
    try {
      await onSaved(value)
      if (!current() || stale.current) return false
      setStatus({ phase: 'complete', error: '', outcome }); return true
    } catch {
      if (current() && !stale.current) setStatus({ phase: 'complete', outcome, error: outcome === 'bound' ? '身份已验证并保存，列表刷新失败。' : '配置已保存，列表刷新失败。' })
      return false
    }
  }

  const run = async (mode: BindingMode, input: SaveConnectionInput | undefined, onSaved: RefreshConnection): Promise<boolean> => {
    if (!current() || stale.current || request.current || unresolved.current || (stateRef.current.outcome && stateRef.current.error)) return false
    const attempt: Attempt = { mode, input, base: savedRef.current }
    request.current = attempt
    let step: BindingPhase = 'idle'
    try {
      let value = savedRef.current
      const submitted = input ? signature(input) : null
      if (input && (!value || lastInput.current !== submitted)) {
        step = 'saving'; setStatus({ phase: step, error: '' })
        const result = await api.integrations.saveConnection({ ...input, id: value?.id, revision: value?.revision })
        if (!owns(attempt)) return false
        if (!result.ok) {
          if (uncertainFailure(result)) { unresolved.current = attempt; setStatus({ phase: 'uncertain', error: '保存结果待核实，请读取连接后继续，避免重复创建。' }) }
          else if (result.code === 'E_CONFLICT' && !followChanges) { stale.current = true; setStatus({ phase: 'stale', error: result.error }) }
          else setStatus({ phase: 'idle', error: result.error })
          return false
        }
        if (result.data.providerId !== provider.id || !matchesSave(provider, result.data, input) || (value && (result.data.id !== value.id || (!value.legacy && result.data.revision !== value.revision + 1)))) {
          unresolved.current = attempt; setStatus({ phase: 'uncertain', error: '保存返回的连接不匹配，请读取连接后核实。' }); return false
        }
        value = result.data; commit(value); lastInput.current = submitted
      }
      if (!value || !owns(attempt)) return false
      attempt.base = value
      if (mode !== 'save' && value.enabled) {
        step = mode === 'authorize' ? 'authorizing' : 'verifying'
        if (mode === 'authorize' && !authorizationAvailable) { setStatus({ phase: 'idle', error: '浏览器授权暂不可用，请完整退出并重新打开应用。' }); return false }
        if (mode === 'authorize') attempt.requestId = crypto.randomUUID()
        attempt.verificationStarted = true
        setStatus({ phase: step, error: '' })
        const result = mode === 'authorize' && attempt.requestId
          ? await api.integrations.authorize({ connectionId: value.id, connectionRevision: value.revision, requestId: attempt.requestId })
          : await api.integrations.inspect({ connectionId: value.id, connectionRevision: value.revision })
        if (!owns(attempt)) return false
        if (!result.ok) {
          if (uncertainFailure(result)) { unresolved.current = attempt; setStatus({ phase: 'uncertain', error: '未能确认绑定结果，请先读取连接核实。' }) }
          else if (result.code === 'E_CONFLICT' && !followChanges) { stale.current = true; setStatus({ phase: 'stale', error: result.error }) }
          else setStatus({ phase: 'idle', error: result.error })
          return false
        }
        const verified = result.data
        if (!sameConfiguration(verified, value) || !verified.enabled || verified.check !== 'authenticated' || !hasCredentials(provider, verified)
          || (mode === 'authorize' ? verified.revision !== value.revision + 1 || !verified.hasSecrets.includes('oauthTokens') : verified.revision !== value.revision)) {
          setStatus({ phase: 'idle', error: verified.detail || '身份尚未验证，请检查凭据后重试。' }); return false
        }
        commit(verified)
      }
      setStatus({ phase: 'complete', error: '', outcome: mode === 'save' || !value.enabled ? 'saved' : 'bound' })
      return await refresh(onSaved)
    } catch {
      if (owns(attempt)) {
        unresolved.current = attempt
        setStatus({ phase: 'uncertain', error: step === 'saving' ? '保存结果待核实，请读取连接后继续，避免重复创建。' : '未能确认绑定结果，请先读取连接核实。' })
      }
      return false
    } finally { if (request.current === attempt) request.current = null }
  }

  const cancel = async (): Promise<void> => {
    const attempt = request.current
    if (!attempt?.requestId || !owns(attempt) || stateRef.current.phase === 'cancelling') return
    setStatus({ phase: 'cancelling', error: '' })
    try {
      const result = await api.integrations.cancelAuthorization(attempt.requestId)
      // The authorize response decides whether credentials committed before cancellation.
      if (owns(attempt) && !result.ok) setStatus({ phase: 'authorizing', error: result.error })
    } catch { if (owns(attempt)) setStatus({ phase: 'authorizing', error: '未能确认取消，请重试取消或等待授权结果。' }) }
  }

  const reconcile = async (onSaved: RefreshConnection): Promise<boolean> => {
    const uncertain = unresolved.current
    if (!uncertain || request.current || !current() || stale.current) return false
    request.current = uncertain; setStatus({ phase: 'refreshing', error: '' })
    try {
      if (uncertain.requestId) {
        const cancelled = await api.integrations.cancelAuthorization(uncertain.requestId)
        if (!owns(uncertain)) return false
        if (!cancelled.ok) { setStatus({ phase: 'uncertain', error: cancelled.error }); return false }
      }
      const result = await api.integrations.list()
      if (!owns(uncertain)) return false
      if (!result.ok) { setStatus({ phase: 'uncertain', error: result.error }); return false }
      const value = savedRef.current
      const observed = value && result.data.connections.find((item) => item.id === value.id)
      if (uncertain.verificationStarted && uncertain.base && observed && sameConfiguration(observed, uncertain.base)
        && observed.check === 'authenticated' && observed.enabled && hasCredentials(provider, observed)
        && (uncertain.requestId ? observed.revision === uncertain.base.revision + 1 && observed.hasSecrets.includes('oauthTokens') : observed.revision === uncertain.base.revision)) {
        commit(observed); unresolved.current = null
        setStatus({ phase: 'complete', outcome: 'bound', error: '' }); return await refresh(onSaved)
      }
      setStatus({ phase: 'uncertain', error: '请选择要继续的已保存连接；草稿将保留。', candidates: result.data.connections.filter((item) => item.providerId === provider.id && (!value || item.id === value.id)) })
      return false
    } catch { if (owns(uncertain)) setStatus({ phase: 'uncertain', error: '无法读取连接，请重试核实。' }); return false }
    finally { if (request.current === uncertain) request.current = null }
  }
  const resume = (value: IntegrationConnection): void => {
    if (!current() || stale.current || !stateRef.current.candidates?.some((item) => item.id === value.id && item.revision === value.revision)) return
    const attempt = unresolved.current
    const sameId = savedRef.current?.id === value.id
    if (!sameId) { versions.current.clear(); seen.current = false }
    const acceptedSave = attempt?.input && matchesSave(provider, value, attempt.input) && (attempt.verificationStarted || !attempt.base || (value.legacy ? value.revision !== attempt.base.revision : value.revision > attempt.base.revision))
    lastInput.current = acceptedSave && attempt?.input ? signature(attempt.input) : null
    commit(value); unresolved.current = null
    setStatus({ phase: 'idle', error: '' })
  }
  const busy = ['saving', 'verifying', 'authorizing', 'cancelling', 'refreshing'].includes(state.phase)
  return { state, saved, busy, current, run, cancel, abandon, refresh, reconcile, resume,
    clearError: () => { if (!busy && stateRef.current.phase === 'idle') setStatus({ phase: 'idle', error: '' }) } }
}
