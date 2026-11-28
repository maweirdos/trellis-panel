import { useCallback, useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TeamContentApi, TeamContentConfigure } from '@shared/team-content-api'
import { teamContentConfigureInputSchema } from '@shared/team-content-api'
import { teamContentLimitsSchema, type TeamContentConfig, type TeamContentKind } from '@shared/team-content'
import { api } from '../../api'
import { Button, Checkbox, DisclosureGrid } from '../../my/ui'
import { PreferenceRow, PreferenceSection } from '../../pages/settings/PreferenceSection'

function TeamContentDisclosure({ label, className = '', triggerClassName = 'text-my-secondary hover:text-my-primary', children }: { label: string; className?: string; triggerClassName?: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  return <div className={className}>
    <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={`inline-flex cursor-pointer items-center gap-1.5 text-left transition-colors ${triggerClassName}`.trim()}>
      <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
      <span>{label}</span>
    </button>
    <DisclosureGrid open={open}>{children}</DisclosureGrid>
  </div>
}

export type TeamContentSettingsProps = { workspaceKey: string; teamId?: string; contentApi?: TeamContentApi; onChanged?: () => void }
type SafeInput = Omit<TeamContentConfigure, 'expectedEpoch' | 'apiKey'>
type Pending = { kind: 'configure'; input: SafeInput; needsKey: boolean } | { kind: 'probe'; commandId: string; expectedConfigRevision: number }
type Draft = Omit<SafeInput, 'commandId' | 'expectedRevision'>
const retained = new Map<string, Pending>()
const defaults: Draft = { provider: 'openai-compatible', endpoint: '', model: '', enabled: true, capabilities: ['requirements', 'summary', 'test-package'],
  limits: { teamConcurrency: 2, memberConcurrency: 1, teamDailyRequests: 100, memberDailyRequests: 20, teamDailyTokens: 1_000_000, memberDailyTokens: 200_000, inputTokenLimit: 8192, outputTokenLimit: 2048, timeoutMs: 30_000 } }
const capabilityNames: Record<TeamContentKind, string> = { requirements: '需求整理', summary: '任务摘要', 'test-package': '测试包' }
const limitNames: Record<keyof Draft['limits'], string> = { teamConcurrency: '团队并发', memberConcurrency: '每人并发', teamDailyRequests: '团队每日请求', memberDailyRequests: '每人每日请求',
  teamDailyTokens: '团队每日 Token', memberDailyTokens: '每人每日 Token', inputTokenLimit: '单次输入 Token', outputTokenLimit: '单次输出 Token', timeoutMs: '超时（毫秒）' }
const statusNames = { unconfigured: '尚未配置', disabled: '已停用', 'protection-unavailable': '凭据保护不可用', unverified: '待检测', ready: '可用', degraded: '检测异常' }

export function TeamContentSettings(props: TeamContentSettingsProps): JSX.Element {
  return <SettingsForm key={JSON.stringify([props.workspaceKey, props.teamId])} {...props} />
}

function SettingsForm({ workspaceKey, teamId, contentApi, onChanged }: TeamContentSettingsProps): JSX.Element {
  const service = contentApi ?? api?.teamContent, id = useId(), retainedKey = JSON.stringify([workspaceKey, teamId ?? null])
  const [config, setConfig] = useState<TeamContentConfig | null>(null)
  const [actualTeamId, setActualTeamId] = useState(teamId)
  const [loaded, setLoaded] = useState(false)
  const [canManage, setCanManage] = useState(false)
  const [busy, setBusy] = useState<'load' | 'configure' | 'probe' | null>('load')
  const [message, setMessage] = useState<{ text: string; error: boolean; code?: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(() => retained.get(retainedKey) ?? null)
  const [draft, setDraft] = useState<Draft>(() => {
    const saved = retained.get(retainedKey)
    if (saved?.kind === 'configure') { const { commandId: _command, expectedRevision: _revision, ...fields } = saved.input; return structuredClone(fields) }
    return structuredClone(defaults)
  })
  const [probeSince, setProbeSince] = useState<number | null>(null)
  const [probeUnconfirmed, setProbeUnconfirmed] = useState(false)
  const keyInput = useRef<HTMLInputElement>(null), live = useRef(false), lock = useRef(false), dirty = useRef(false)
  const generation = useRef(0)
  const onChangedRef = useRef(onChanged); onChangedRef.current = onChanged
  const pendingRef = useRef(pending); pendingRef.current = pending
  const retain = (value: Pending | null): void => {
    pendingRef.current = value
    if (value) retained.set(retainedKey, value); else retained.delete(retainedKey)
    if (live.current) setPending(value)
  }
  const load = useCallback(async (replaceDraft: boolean): Promise<void> => {
    const originalGeneration = generation.current
    if (!service) { if (live.current) { setMessage({ text: '当前工作区尚未连接内容服务。', error: true }); setBusy(null) }; return }
    let target = teamId
    if (!target) {
      const ready = await service.readiness({ workspaceKey })
      if (!live.current || generation.current !== originalGeneration) return
      if (!ready.ok) { setMessage({ text: ready.error, code: ready.code, error: true }); return }
      target = ready.data.teamId
      setCanManage(ready.data.canManage)
      if (!ready.data.canManage) { setMessage({ text: '需要团队管理员配置模型。', error: true }); return }
    }
    const result = await service.config({ workspaceKey, teamId: target })
    if (!live.current || generation.current !== originalGeneration) return
    if (!result.ok) { setCanManage(false); setMessage({ text: result.error, code: result.code, error: true }); return }
    setActualTeamId(target); setConfig(result.data); setLoaded(true); setCanManage(true)
    if (replaceDraft && !dirty.current && pendingRef.current?.kind !== 'configure') {
      const current = result.data
      setDraft(current ? { provider: current.provider, endpoint: current.endpoint, model: current.model, enabled: current.enabled,
        capabilities: [...current.capabilities], limits: { ...current.limits } } : structuredClone(defaults))
    }
  }, [service, workspaceKey, teamId])
  useEffect(() => {
    live.current = true; generation.current++
    const originalGeneration = generation.current
    void load(true).catch(() => { if (live.current && generation.current === originalGeneration) setMessage({ text: '配置未能读取，请重试。', error: true }) }).finally(() => { if (live.current && generation.current === originalGeneration) setBusy(null) })
    return () => { live.current = false; generation.current++; if (keyInput.current) keyInput.current.value = '' }
  }, [load])
  useEffect(() => {
    if (probeSince !== null && config?.health.checkedAt !== null && config?.health.checkedAt !== undefined && config.health.checkedAt >= probeSince) {
      setProbeSince(null); setProbeUnconfirmed(false)
    }
  }, [config?.health.checkedAt, probeSince])
  useEffect(() => {
    if (probeSince === null || !service || !actualTeamId) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, attempts = 0
    const poll = async (): Promise<void> => {
      if (stopped || !live.current) return
      try {
        const result = await service.config({ workspaceKey, teamId: actualTeamId })
        if (stopped || !live.current) return
        if (!result.ok) { setProbeUnconfirmed(true); setMessage({ text: result.error, code: result.code, error: true }); return }
        setConfig(result.data)
        if (result.data?.health.checkedAt !== null && result.data?.health.checkedAt !== undefined && result.data.health.checkedAt >= probeSince) {
          setProbeSince(null); onChangedRef.current?.(); return
        }
      } catch { if (!stopped && live.current) { setProbeUnconfirmed(true); setMessage({ text: '检测结果暂未确认，请刷新配置核对。', error: true }) }; return }
      if (++attempts < 45) timer = setTimeout(() => void poll(), 1500)
      else if (!stopped && live.current) { setProbeUnconfirmed(true); setMessage({ text: '检测结果尚未确认，请刷新配置核对。', error: true }) }
    }
    timer = setTimeout(() => void poll(), 1200)
    return () => { stopped = true; clearTimeout(timer) }
  }, [service, workspaceKey, actualTeamId, probeSince])
  const status: keyof typeof statusNames = !config ? 'unconfigured' : !config.enabled ? 'disabled' : !config.credentialProtectionAvailable ? 'protection-unavailable' : config.health.state
  const edit = (change: Partial<Draft>): void => { dirty.current = true; setDraft(value => ({ ...value, ...change })) }
  const newId = (): string | null => {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
    setMessage({ text: '保存和检测需要 HTTPS 或 localhost 安全入口。', error: true }); return null
  }
  const save = async (): Promise<void> => {
    if (!service || !actualTeamId || !loaded || !canManage || lock.current || pendingRef.current?.kind === 'probe') return
    const originalGeneration = generation.current, previous = pendingRef.current
    const commandId = previous?.kind === 'configure' ? previous.input.commandId : newId()
    if (!commandId) return
    const safe: SafeInput = previous?.kind === 'configure' ? previous.input : { ...structuredClone(draft), commandId, expectedRevision: config?.revision ?? 0 }
    const secret = keyInput.current?.value.trim() ?? ''
    if ((previous?.kind === 'configure' && previous.needsKey || !config?.hasCredential) && !secret) { setMessage({ text: '请输入模型 API Key。重试时使用原 Key。', error: true }); keyInput.current?.focus(); return }
    const input = { ...safe, ...(secret ? { apiKey: secret } : {}) }
    const parsed = teamContentConfigureInputSchema.safeParse({ workspaceKey, teamId: actualTeamId, input })
    if (!parsed.success) { setMessage({ text: '请核对服务地址、模型、能力和限额范围。', error: true }); return }
    lock.current = true; setBusy('configure'); setMessage(null)
    retain({ kind: 'configure', input: safe, needsKey: Boolean(secret) })
    if (keyInput.current) keyInput.current.value = ''
    try {
      const result = await service.configure(parsed.data)
      if (!result.ok) {
        if (!result.outcomeUnknown) retain(null)
        if (live.current && generation.current === originalGeneration) setMessage({ text: result.outcomeUnknown ? result.error + ' 请以原内容重试保存。' : result.error, code: result.code, error: true })
        return
      }
      retain(null); dirty.current = false
      if (live.current && generation.current === originalGeneration) { setConfig(result.data); await load(true); if (live.current && generation.current === originalGeneration) { setMessage({ text: '配置已保存，待检测。', error: false }); onChangedRef.current?.() } }
    } catch { if (live.current && generation.current === originalGeneration) setMessage({ text: '保存结果未确认，请保留原内容重试。', error: true }) }
    finally { delete parsed.data.input.apiKey; delete input.apiKey; lock.current = false; if (live.current && generation.current === originalGeneration) setBusy(null) }
  }
  const probe = async (): Promise<void> => {
    if (!service || !actualTeamId || !config || lock.current || pendingRef.current?.kind === 'configure') return
    const originalGeneration = generation.current, original = pendingRef.current, commandId = original?.kind === 'probe' ? original.commandId : newId()
    if (!commandId) return
    const intent: Extract<Pending, { kind: 'probe' }> = original?.kind === 'probe' ? original : { kind: 'probe', commandId, expectedConfigRevision: config.revision }
    retain(intent); lock.current = true; setBusy('probe'); setMessage(null)
    try {
      const result = await service.probe({ workspaceKey, teamId: actualTeamId, commandId, expectedConfigRevision: intent.expectedConfigRevision })
      if (!result.ok) {
        if (!result.outcomeUnknown) retain(null)
        if (live.current && generation.current === originalGeneration) setMessage({ text: result.outcomeUnknown ? result.error + ' 请核对原检测。' : result.error, code: result.code, error: true })
        return
      }
      retain(null)
      if (live.current && generation.current === originalGeneration) { setProbeUnconfirmed(false); setProbeSince(result.data.job.createdAt); await load(false) }
    } catch { if (live.current && generation.current === originalGeneration) setMessage({ text: '检测提交结果未确认，请核对原检测。', error: true }) }
    finally { lock.current = false; if (live.current && generation.current === originalGeneration) setBusy(null) }
  }
  const disabled = Boolean(busy) || !loaded || !canManage || Boolean(pending)
  return <PreferenceSection id={`${id}-team-content`} title="团队 AI 内容" action={<div className="flex items-center gap-2">
    <span className="text-my-xs text-my-secondary" role="status">{!loaded ? '尚未读取' : probeSince !== null ? probeUnconfirmed ? '检测待核对' : '检测中' : statusNames[status]}</span>
    <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => {
      if (lock.current) return
      lock.current = true; setBusy('load'); setMessage(null)
      void load(true).catch(() => { if (live.current) setMessage({ text: '配置未能读取，请重试。', error: true }) }).finally(() => { lock.current = false; if (live.current) setBusy(null) })
    }}>刷新</Button>
  </div>}>
    <PreferenceRow label="启用团队 AI">
      <Checkbox ariaLabel="启用团队 AI" checked={draft.enabled} disabled={disabled} onChange={enabled => edit({ enabled })} />
    </PreferenceRow>
    <PreferenceRow label="服务地址" htmlFor={`${id}-endpoint`} hint="完整的 HTTPS chat/completions 地址。">
      <input id={`${id}-endpoint`} type="url" className="my-input" maxLength={2048} placeholder="https://…/v1/chat/completions" value={draft.endpoint} disabled={disabled} onChange={event => edit({ endpoint: event.target.value })} />
    </PreferenceRow>
    <PreferenceRow label="模型" htmlFor={`${id}-model`}>
      <input id={`${id}-model`} className="my-input" maxLength={200} value={draft.model} disabled={disabled} onChange={event => edit({ model: event.target.value })} />
    </PreferenceRow>
    <PreferenceRow label="API Key" htmlFor={`${id}-key`} hint={pending?.kind === 'configure' && pending.needsKey ? '重试需重新输入原 Key。' : config?.hasCredential ? '留空保留已配置的 Key。' : '由团队服务保存。'}>
      <input ref={keyInput} id={`${id}-key`} type="password" className="my-input" autoComplete="new-password" maxLength={4096} spellCheck={false} disabled={Boolean(busy) || !loaded || !canManage || pending?.kind === 'probe'} />
    </PreferenceRow>
    <PreferenceRow label="内容能力">
      <div className="flex flex-wrap gap-3">{(Object.keys(capabilityNames) as TeamContentKind[]).map(kind => <label key={kind} className="my-item-title flex items-center gap-2">
        <Checkbox checked={draft.capabilities.includes(kind)} disabled={disabled} onChange={checked => edit({ capabilities: checked ? [...draft.capabilities, kind] : draft.capabilities.filter(value => value !== kind) })} />{capabilityNames[kind]}
      </label>)}</div>
    </PreferenceRow>
    <TeamContentDisclosure label="并发与用量限制" className="preference-disclosure" triggerClassName="text-my-sm text-my-secondary hover:text-my-primary">
      <div className="mt-3">
        {(Object.keys(limitNames) as (keyof Draft['limits'])[]).map(name => <PreferenceRow key={name} label={limitNames[name]} htmlFor={`${id}-${name}`}>
          <input id={`${id}-${name}`} type="number" className="my-input" min={teamContentLimitsSchema.shape[name].minValue ?? 0} max={teamContentLimitsSchema.shape[name].maxValue ?? undefined} step={1} value={Number.isNaN(draft.limits[name]) ? '' : draft.limits[name]} disabled={disabled} onChange={event => edit({ limits: { ...draft.limits, [name]: event.target.value === '' ? Number.NaN : Number(event.target.value) } })} />
        </PreferenceRow>)}
      </div>
    </TeamContentDisclosure>
    <div className="preference-actions flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" disabled={Boolean(busy) || !loaded || !canManage || pending?.kind === 'probe'} onClick={() => void save()}>{busy === 'configure' ? '保存中…' : pending?.kind === 'configure' ? '重试原保存' : '保存配置'}</Button>
      <Button size="sm" variant="outline" disabled={Boolean(busy) || !config?.enabled || !config.hasCredential || !config.credentialProtectionAvailable || dirty.current || pending?.kind === 'configure' || probeSince !== null} onClick={() => void probe()}>{busy === 'probe' ? '提交检测…' : pending?.kind === 'probe' ? '核对原检测' : '检测模型'}</Button>
      <span className="my-item-description">检测会发送一次模型请求。</span>
    </div>
    {message && <div className="px-4 pb-4">
      <p role={message.error ? 'alert' : 'status'} className={`text-my-sm break-words ${message.error ? 'text-my-danger-text' : 'text-my-secondary'}`}>{message.text}</p>
      {(message.code || pending) && <TeamContentDisclosure label="操作详情" className="mt-2 text-my-xs text-my-tertiary" triggerClassName="text-my-tertiary hover:text-my-primary"><p className="mt-1 break-all">{message.code}{pending ? ` · ${pending.kind === 'configure' ? pending.input.commandId : pending.commandId}` : ''}</p></TeamContentDisclosure>}
    </div>}
    {loaded && config?.health.code && <TeamContentDisclosure label="检测详情" className="px-4 pb-4 text-my-xs text-my-tertiary" triggerClassName="text-my-tertiary hover:text-my-primary"><p className="mt-1">{config.health.code}</p></TeamContentDisclosure>}
  </PreferenceSection>
}
