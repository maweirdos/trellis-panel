import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { Check, ExternalLink, LoaderCircle } from 'lucide-react'
import type { FeishuAttempt, FeishuResult } from '@shared/feishu-integration'
import { api as desktop } from '../../../../../api'
import { useInteractionSignal } from '../../../../../utils/interaction-scope'
import { Button } from '../../../../ui'
import { useIntegrationOwner } from '../../hooks'
import { FeishuDialog, FeishuError } from './presentation'
import type { FeishuRegistrationController, RegistrationTarget } from './registration'

type ReadAttempt = (id: string) => Promise<FeishuResult<FeishuAttempt>>
interface Session {
  attempt: FeishuAttempt | null
  detached: boolean
  cancelRequested: boolean
  cancelling: boolean
  reading: boolean
  sequence: number
}

const POLL_INTERVAL = 1000
const attemptLabels: Record<FeishuAttempt['status'], string> = {
  starting: '正在准备授权…',
  pending: '等待飞书授权',
  connected: '飞书已授权',
  failed: '授权失败',
  expired: '授权已过期',
  cancelled: '授权已取消',
  unknown: '授权结果待核实'
}

function waiting(attempt: FeishuAttempt): boolean {
  return attempt.status === 'starting' || attempt.status === 'pending'
}

function feishuAuthorizationUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const link = new URL(value)
    return link.protocol === 'https:' && !link.username && !link.password && !link.port &&
      (link.hostname === 'open.feishu.cn' || link.hostname === 'accounts.feishu.cn') ? link.href : null
  } catch {
    return null
  }
}

function AuthorizationCode({ url }: { url: string }): JSX.Element | null {
  const [image, setImage] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    void import('qrcode').then(({ toDataURL }) => toDataURL(url, { width: 400, margin: 4 })).then((value) => {
      if (live) setImage(value)
    }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [url])
  if (failed) return <p role="status" className="my-item-description">无法显示二维码，请打开授权链接。</p>
  return image ? <>
    <img src={image} alt="飞书授权二维码" width={208} height={208} className="mx-auto block h-auto max-w-full rounded-my-md" draggable={false} />
    <p className="my-item-description">用飞书扫码授权</p>
  </> : null
}

export function FeishuRegistrationDialog({ title, subtitle, controller, target, canStart, canRecover, open, onClose, onConnected, children }: {
  title: string
  subtitle?: string
  controller: FeishuRegistrationController
  target: RegistrationTarget | null
  canStart: boolean
  canRecover: boolean
  open: boolean
  onClose: () => void
  onConnected: () => void
  children: ReactNode
}): JSX.Element | null {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [now, setNow] = useState(Date.now)
  const [openIssue, setOpenIssue] = useState('')
  const connected = useRef('')
  const currentTarget = useRef(target)
  currentTarget.current = target
  const visibleOwner = useRef({ targetKey: target?.key, open })
  if (visibleOwner.current.targetKey !== target?.key || visibleOwner.current.open !== open) {
    visibleOwner.current = { targetKey: target?.key, open }
  }
  useEffect(() => {
    controller.select(currentTarget.current, canStart && open, canRecover, canStart)
  }, [controller, target?.key, canStart, canRecover, open])
  useEffect(() => { setOpenIssue('') }, [target?.key, open])
  const ownsState = state.targetKey === target?.key
  const attempt = ownsState ? state.attempt : null
  const starting = ownsState ? state.starting : Boolean(target && canStart && open)
  const pending = starting || Boolean(attempt && waiting(attempt))
  const unresolved = ownsState && (state.unknownStart || attempt?.status === 'unknown')
  const elapsed = Boolean(attempt?.expiresAt && Math.max(now, Date.now()) >= attempt.expiresAt)
  const url = pending && !elapsed && ownsState && !state.cancelling && !state.linkBlocked
    ? feishuAuthorizationUrl(attempt?.url ?? null) : null

  useEffect(() => {
    if (!open || !ownsState || !attempt || !waiting(attempt) || state.issue || state.reading || state.cancelling) return
    const timer = window.setTimeout(() => void controller.check(), POLL_INTERVAL)
    return () => window.clearTimeout(timer)
  }, [controller, open, ownsState, attempt, state.issue, state.reading, state.cancelling])
  useEffect(() => {
    if (!open || !attempt?.expiresAt || !waiting(attempt) || attempt.expiresAt <= now) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(POLL_INTERVAL, attempt.expiresAt - now))
    return () => window.clearTimeout(timer)
  }, [open, attempt, now])
  useEffect(() => {
    const identity = state.registered ? `${state.targetKey}:registered` : attempt?.status === 'connected' ? attempt.id : ''
    if (!ownsState || !identity || connected.current === identity) return
    connected.current = identity
    onConnected()
  }, [ownsState, attempt, state.registered, state.targetKey, onConnected])

  if (!open) return null
  const label = ownsState && state.cancelling ? '正在取消授权…' : starting ? attemptLabels.starting
    : ownsState && state.unknownStart ? '授权结果待核实'
    : ownsState && state.registered ? '飞书已授权'
    : elapsed && attempt && waiting(attempt) ? '授权已到期 · 等待飞书确认'
    : attempt ? attemptLabels[attempt.status] : ''
  const openAuthorization = (link: string): void => {
    const owner = visibleOwner.current
    setOpenIssue('')
    void desktop.openExternal(link).catch(() => {
      if (owner.open && visibleOwner.current === owner) setOpenIssue('无法打开系统浏览器，请重试。')
    })
  }
  const canRetry = ownsState && Boolean(target) && !pending && !unresolved && !state.registered &&
    attempt?.status !== 'connected' && (Boolean(attempt) || Boolean(state.issue))
  return <FeishuDialog title={title} subtitle={subtitle} onClose={onClose} footer={<>
    <Button onClick={onClose}>关闭</Button>
    {pending && <Button disabled={ownsState && state.cancelling} onClick={() => controller.cancel()}>取消授权</Button>}
    {url && <Button onClick={() => openAuthorization(url)}><ExternalLink size={14} aria-hidden="true" />打开授权链接</Button>}
    {ownsState && state.unknownStart && !pending && <Button variant="primary" disabled={!canRecover || state.reading || state.cancelling}
      onClick={() => controller.resume()}>恢复授权</Button>}
    {attempt && (unresolved || (pending && state.issue)) && <Button disabled={state.reading || state.cancelling}
      onClick={() => void controller.check()}>核对原授权</Button>}
    {attempt?.status === 'unknown' && <Button disabled={state.reading || state.cancelling}
      onClick={() => controller.cancel(true)}>已核对飞书开放平台</Button>}
    {canRetry && <Button variant="primary" disabled={!canStart || state.cancelling} onClick={() => controller.retry()}>重新授权</Button>}
  </>}>
    {children}
    {url && <div className="space-y-3 text-center"><AuthorizationCode key={url} url={url} /></div>}
    {label && <div role="status" className="flex items-center justify-center gap-2 text-my-sm text-my-secondary">
      {pending && !state.issue && <LoaderCircle size={15} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
      {(attempt?.status === 'connected' || (ownsState && state.registered)) && <Check size={15} aria-hidden="true" />}
      <span>{label}</span>
    </div>}
    {url && attempt?.expiresAt && <p className="my-item-description text-center">有效期至 {new Date(attempt.expiresAt).toLocaleTimeString()}</p>}
    {attempt?.detail && !pending && <p className="my-item-description break-words">{attempt.detail}</p>}
    {unresolved && !state.unknownStart && <p className="my-item-description">请核对飞书后台和 Crux 的连接记录后，再发起新的授权。</p>}
    <FeishuError title={openIssue ? '打开授权链接失败' : state.cancelling ? '取消授权失败' : '无法确认授权状态'}
      message={openIssue || (ownsState ? state.issue : '')} />
  </FeishuDialog>
}

export function FeishuAuthorizationDialog({ title, subtitle, ownerKey, canStart, onClose, onConnected, begin, read, cancel, discardUnconfirmed, children, qr = false }: {
  title: string
  subtitle?: string
  ownerKey: string
  canStart: boolean
  onClose: () => void
  onConnected: () => void
  begin: () => Promise<FeishuResult<FeishuAttempt>>
  read: ReadAttempt
  cancel: ReadAttempt
  discardUnconfirmed?: ReadAttempt
  children?: ReactNode
  qr?: boolean
}): JSX.Element {
  const owner = useIntegrationOwner(ownerKey)
  const signal = useInteractionSignal()
  const session = useRef<Session | null>(null)
  const [attempt, setAttempt] = useState<FeishuAttempt | null>(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [reading, setReading] = useState(false)
  const [unknownStart, setUnknownStart] = useState(false)
  const [issue, setIssue] = useState('')
  const [linkBlocked, setLinkBlocked] = useState(false)
  const [openIssue, setOpenIssue] = useState('')
  const [now, setNow] = useState(Date.now)
  const detach = (ticket: Session): void => {
    ticket.detached = true
    const original = ticket.attempt
    if (!original || !waiting(original) || ticket.cancelling) return
    ticket.cancelling = true
    void cancel(original.id).catch(() => undefined)
  }
  useLayoutEffect(() => {
    const detachCurrent = (): void => { if (session.current) detach(session.current) }
    signal?.addEventListener('abort', detachCurrent, { once: true })
    return () => {
      signal?.removeEventListener('abort', detachCurrent)
      detachCurrent()
    }
  }, [owner.current, signal, cancel])

  const current = (ticket: Session): boolean => !ticket.detached && session.current === ticket && owner.current()
  const publish = (ticket: Session, result: FeishuAttempt): void => {
    const previous = ticket.attempt
    ticket.attempt = result
    if (!current(ticket)) { detach(ticket); return }
    setNow(Date.now())
    setAttempt(result)
    setLinkBlocked(false)
    if (result.status === 'connected' && previous?.status !== 'connected') onConnected()
  }
  const cancelOriginal = async (ticket: Session, discard = false): Promise<void> => {
    const original = ticket.attempt
    if (!original || ticket.cancelling) return
    ticket.cancelling = true
    ticket.sequence++
    setCancelling(true)
    setIssue('')
    try {
      const result = await (discard && discardUnconfirmed ? discardUnconfirmed : cancel)(original.id)
      if (!current(ticket)) return
      if (result.ok && result.data.id === original.id) publish(ticket, result.data)
      else setIssue(result.ok ? '返回的授权与原会话不一致。' : result.error)
    } catch {
      if (current(ticket)) setIssue('暂时无法确认授权已取消。')
    } finally {
      ticket.cancelling = false
      if (current(ticket)) setCancelling(false)
    }
  }
  const checkOriginal = async (ticket: Session): Promise<void> => {
    const original = ticket.attempt
    if (!original || !current(ticket) || ticket.cancelling || ticket.reading) return
    ticket.reading = true
    const sequence = ticket.sequence
    setReading(true)
    setIssue('')
    try {
      const result = await read(original.id)
      if (!current(ticket) || ticket.sequence !== sequence) return
      if (result.ok && result.data.id === original.id) publish(ticket, result.data)
      else {
        if (result.ok || result.code === 'E_DENIED' || result.code === 'E_CONFLICT') setLinkBlocked(true)
        setIssue(result.ok ? '返回的授权与原会话不一致。' : result.error)
      }
    } catch {
      if (current(ticket) && ticket.sequence === sequence) setIssue('暂时无法读取原授权状态。')
    } finally {
      ticket.reading = false
      if (current(ticket)) setReading(false)
    }
  }
  useEffect(() => {
    const ticket = session.current
    if (!attempt || !ticket || !waiting(attempt) || issue || reading || cancelling) return
    const timer = window.setTimeout(() => void checkOriginal(ticket), POLL_INTERVAL)
    return () => window.clearTimeout(timer)
  }, [attempt, issue, reading, cancelling])
  useEffect(() => {
    if (!attempt?.expiresAt || !waiting(attempt) || attempt.expiresAt <= now) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(POLL_INTERVAL, attempt.expiresAt - now))
    return () => window.clearTimeout(timer)
  }, [attempt, now])

  const start = async (): Promise<void> => {
    const previous = session.current
    if (!canStart || !owner.current() || (previous && (!previous.attempt || waiting(previous.attempt) || previous.attempt.status === 'unknown'))) return
    const ticket = { attempt: null, detached: false, cancelRequested: false, cancelling: false, reading: false, sequence: 0 }
    session.current = ticket
    setAttempt(null)
    setIssue('')
    setOpenIssue('')
    setStarting(true)
    try {
      const result = await begin()
      if (result.ok) {
        publish(ticket, result.data)
        if (current(ticket) && ticket.cancelRequested && waiting(result.data)) await cancelOriginal(ticket)
      } else if (current(ticket)) {
        const uncertain = result.code === 'E_UNKNOWN' || result.code === 'E_TIMEOUT'
        setUnknownStart(uncertain)
        setIssue(result.error)
        if (!uncertain) session.current = null
      }
    } catch {
      if (current(ticket)) { setUnknownStart(true); setIssue('未确认授权请求是否已创建。') }
    } finally {
      if (current(ticket) || (session.current === null && owner.current())) {
        setStarting(false)
        if (!ticket.attempt) setCancelling(false)
      }
    }
  }
  const requestCancel = (): void => {
    const ticket = session.current
    if (!ticket || !current(ticket)) return
    ticket.cancelRequested = true
    setOpenIssue('')
    if (ticket.attempt) void cancelOriginal(ticket)
    else setCancelling(true)
  }

  const pending = starting || Boolean(attempt && waiting(attempt))
  const unresolved = unknownStart || attempt?.status === 'unknown'
  const elapsed = Boolean(attempt?.expiresAt && now >= attempt.expiresAt)
  const url = pending && !elapsed && !cancelling && !linkBlocked && !session.current?.cancelRequested
    ? feishuAuthorizationUrl(attempt?.url ?? null) : null
  const close = (): void => {
    if (pending) requestCancel()
    else if (!cancelling && !reading) onClose()
  }
  const label = cancelling ? '正在取消授权…' : starting ? attemptLabels.starting
    : unknownStart ? '授权结果待核实'
    : elapsed && attempt && waiting(attempt) ? '授权已到期 · 等待飞书确认'
    : attempt ? attemptLabels[attempt.status] : ''
  const showSetup = !pending && !unresolved && attempt?.status !== 'connected'
  const openAuthorization = (link: string): void => {
    if (!owner.current()) return
    setOpenIssue('')
    void desktop.openExternal(link).catch(() => {
      if (owner.current()) setOpenIssue('无法打开系统浏览器，请重试。')
    })
  }
  return <FeishuDialog title={title} subtitle={subtitle} onClose={close} footer={<>
    {pending ? <Button disabled={cancelling} onClick={requestCancel}>取消授权</Button> : <Button onClick={close}>{attempt || unresolved ? '关闭' : '取消'}</Button>}
    {url && <Button onClick={() => openAuthorization(url)}><ExternalLink size={14} aria-hidden="true" />打开授权链接</Button>}
    {attempt?.status === 'connected' && <Button variant="primary" onClick={onClose}>完成</Button>}
    {attempt && (unresolved || (pending && issue)) && <Button disabled={reading || cancelling} onClick={() => { if (session.current) void checkOriginal(session.current) }}>核对原授权</Button>}
    {attempt?.status === 'unknown' && discardUnconfirmed && <Button disabled={reading || cancelling} onClick={() => { if (session.current) void cancelOriginal(session.current, true) }}>已核对飞书开放平台</Button>}
    {showSetup && <Button variant="primary" disabled={!canStart} onClick={() => void start()}>{attempt ? '重新授权' : qr ? '获取授权二维码' : '发起授权'}</Button>}
  </>}>
    {showSetup && children}
    {qr && url && <div className="space-y-3 text-center"><AuthorizationCode key={url} url={url} /></div>}
    {label && <div role="status" className="flex items-center justify-center gap-2 text-my-sm text-my-secondary">
      {pending && !issue && <LoaderCircle size={15} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
      {attempt?.status === 'connected' && <Check size={15} aria-hidden="true" />}
      <span>{label}</span>
    </div>}
    {qr && url && attempt?.expiresAt && <p className="my-item-description text-center">有效期至 {new Date(attempt.expiresAt).toLocaleTimeString()}</p>}
    {attempt?.detail && !pending && <p className="my-item-description break-words">{attempt.detail}</p>}
    {unresolved && <p className="my-item-description">请核对飞书后台和 Crux 的连接记录后，再发起新的授权。</p>}
    <FeishuError title={openIssue ? '打开授权链接失败' : cancelling ? '取消授权失败' : '无法确认授权状态'} message={openIssue || issue} />
  </FeishuDialog>
}
