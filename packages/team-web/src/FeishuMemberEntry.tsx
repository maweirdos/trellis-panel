import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Copy, Link2, X } from 'lucide-react'
import { z } from 'zod'
import { Button, Modal } from '../../../src/renderer/src/my/ui'
import { useCopyFeedback } from '../../../src/renderer/src/utils/use-copy-feedback'
import {
  feishuMemberBase, feishuMemberBindingsSchema, feishuMemberCodeReplySchema
} from '../../../src/shared/feishu-member'
import { ApiError, request } from './client'
import { useQuery } from './hooks'
import { time } from './ui'

interface SpaceBindingProps {
  projectId: string
  spaceId: string
  spaceName: string
  isCurrent: () => boolean
}

type Binding = z.infer<typeof feishuMemberBindingsSchema>[number]
type Code = z.infer<typeof feishuMemberCodeReplySchema>
const BINDING_REFRESH_MS = 4000

function failureMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback
  if (error.status === 404) return '当前团队服务尚未提供飞书账号绑定。'
  if (error.status === 401) return '登录已失效，请重新登录。'
  if (error.status === 403) return '当前账号无法管理这个空间的飞书绑定。'
  if (error.status === 429) return '操作太频繁，请稍后再试。'
  return error.message
}

export function FeishuMemberEntry(props: SpaceBindingProps): JSX.Element {
  const [open, setOpen] = useState(false)
  return <>
    <Button variant="ghost" size="sm" aria-haspopup="dialog" onClick={() => { if (props.isCurrent()) setOpen(true) }}>
      <Link2 size={14} aria-hidden="true" />飞书账号
    </Button>
    {open && <FeishuMemberDialog {...props} onClose={() => setOpen(false)} />}
  </>
}

function FeishuMemberDialog({ projectId, spaceId, spaceName, isCurrent, onClose }: SpaceBindingProps & { onClose: () => void }): JSX.Element {
  const lifetime = useRef<AbortController | null>(null)
  const operation = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState<'issue' | 'revoke' | null>(null)
  const [error, setError] = useState('')
  const [code, setCode] = useState<(Code & { priorBindings: readonly string[] }) | null>(null)
  const [expired, setExpired] = useState(false)
  const [revoke, setRevoke] = useState<Binding | null>(null)
  const base = feishuMemberBase(projectId)
  const bindings = useQuery(`${projectId}:${spaceId}`, async (signal) => {
    if (!isCurrent()) throw new Error('空间已切换，请重新打开飞书账号。')
    try {
      const query = new URLSearchParams({ spaceId })
      return await request(`${base}/bindings?${query}`, feishuMemberBindingsSchema, { signal, isCurrent, notifyDenied: false })
    } catch (error) {
      throw new Error(failureMessage(error, '无法读取飞书账号。'))
    }
  }, true, code ? BINDING_REFRESH_MS : 0)
  const usable = isCurrent() && bindings.value !== null && !bindings.error
  const updated = Boolean(code && bindings.value?.some((binding) => !code.priorBindings.includes(binding.bindingId)))
  const activeCode = usable && code && !updated && Date.now() < code.expiresAt ? code : null
  const command = activeCode ? `绑定 ${activeCode.code}` : ''
  const clipboard = useCopyFeedback(command)

  useLayoutEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => {
      lifetime.current = null
      controller.abort()
      operation.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!code) return
    if (updated) { setCode(null); return }
    const expire = (): void => { setExpired(true); setCode(null) }
    const timer = window.setTimeout(expire, Math.max(0, code.expiresAt - Date.now()))
    const handleVisible = (): void => { if (Date.now() >= code.expiresAt) expire() }
    document.addEventListener('visibilitychange', handleVisible)
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', handleVisible) }
  }, [code, updated])

  const run = async (kind: 'issue' | 'revoke', binding?: Binding): Promise<void> => {
    const owner = lifetime.current
    if (!owner || owner.signal.aborted || !usable || operation.current) return
    if (kind === 'revoke' && (!binding || !bindings.value?.some((item) => item.bindingId === binding.bindingId))) return
    const controller = new AbortController()
    operation.current = controller
    const owned = (): boolean => lifetime.current === owner && operation.current === controller && !owner.signal.aborted && !controller.signal.aborted && isCurrent()
    const options = { signal: controller.signal, isCurrent: owned, notifyDenied: false }
    setBusy(kind)
    setError('')
    try {
      if (kind === 'issue') {
        const priorBindings = bindings.value?.map((item) => item.bindingId) ?? []
        const next = await request(`${base}/codes`, feishuMemberCodeReplySchema, { ...options, body: { spaceId } })
        if (owned()) {
          setExpired(Date.now() >= next.expiresAt)
          setCode(Date.now() < next.expiresAt ? { ...next, priorBindings } : null)
        }
      } else if (binding) {
        await request(`${base}/bindings/${binding.bindingId}/revoke`, z.null(), { ...options, body: { spaceId } })
        if (owned()) { setRevoke(null); setCode(null); setExpired(false); bindings.refresh() }
      }
    } catch (error) {
      if (!owned()) return
      if (error instanceof ApiError && error.uncertain && kind === 'revoke') {
        bindings.refresh()
        setRevoke(null)
        setCode(null)
        setError('撤销结果待核实，请刷新绑定列表。')
      } else {
        setError(failureMessage(error, kind === 'issue' ? '无法生成绑定码。' : '无法撤销绑定。'))
      }
    } finally {
      if (owned()) setBusy(null)
      if (operation.current === controller) operation.current = null
    }
  }

  return <Modal open ariaLabel="飞书账号" onClose={onClose} placement="center">
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-my-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-my-lg font-semibold">飞书账号</h2>
          <p className="my-item-description mt-1 break-words">{spaceName}</p>
        </div>
        <Button variant="ghost" size="sm" aria-label="关闭飞书账号" onClick={onClose}><X size={16} aria-hidden="true" /></Button>
      </header>
      <div className="my-scrollbar min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        {bindings.loading && !bindings.value && <p role="status" className="my-item-description">正在读取飞书绑定…</p>}
        {bindings.error && <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="alert" className="min-w-0 flex-1 break-words text-my-sm text-my-danger-text">{bindings.error}</p>
          <Button size="sm" disabled={bindings.loading} onClick={bindings.refresh}>重试</Button>
        </div>}
        {bindings.value && !bindings.error && <>
          {bindings.value.length ? <ul aria-label="已绑定的飞书应用" className="divide-y divide-my-line">
            {bindings.value.map((entry) => <li key={entry.bindingId} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="my-item-title break-words">{entry.appId}</p>
                  <p className="my-item-description mt-1">已绑定 · {time(entry.linkedAt)}</p>
                </div>
                {revoke?.bindingId !== entry.bindingId && <Button size="sm" disabled={Boolean(busy) || !usable}
                  aria-label={`撤销 ${entry.appId} 的绑定`} onClick={() => { setError(''); setRevoke(entry) }}>撤销绑定</Button>}
              </div>
              {revoke?.bindingId === entry.bindingId && <>
                <p className="my-item-description">撤销后，此飞书账号将无法通过该应用操作这个空间。</p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button size="sm" disabled={Boolean(busy)} onClick={() => setRevoke(null)}>取消</Button>
                  <Button size="sm" variant="danger" disabled={Boolean(busy) || !usable} onClick={() => void run('revoke', entry)}>
                    {busy === 'revoke' ? '正在撤销…' : '确认撤销'}
                  </Button>
                </div>
              </>}
            </li>)}
          </ul> : <p role="status" className="my-item-description">尚未绑定飞书账号</p>}
          {activeCode ? <div className="space-y-3 rounded-my-md border border-my-line bg-my-panel p-3">
            <p className="my-item-description">私聊这个空间的飞书机器人，发送以下完整指令。</p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <code className="min-w-0 flex-1 break-all text-my-sm">{command}</code>
              <Button size="sm" disabled={clipboard.status === 'copying' || Boolean(busy)} onClick={() => {
                if (isCurrent() && Date.now() < activeCode.expiresAt) void clipboard.copy(command)
              }}><Copy size={14} aria-hidden="true" />{clipboard.status === 'copied' ? '已复制' : '复制指令'}</Button>
            </div>
            {clipboard.status === 'copied' && <span role="status" className="sr-only">绑定指令已复制</span>}
            {clipboard.status === 'error' && <p role="alert" className="my-item-description">无法自动复制，请选中指令手动复制。</p>}
            <p className="my-item-description">仅使用一次，有效期至 {new Date(activeCode.expiresAt).toLocaleTimeString()}。</p>
          </div> : expired ? <p role="status" className="my-item-description">绑定码已过期，可重新生成。</p> : null}
        </>}
        {error && <p role="alert" className="break-words text-my-sm text-my-danger-text">{error}</p>}
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-my-line px-5 py-3">
        <Button onClick={onClose}>关闭</Button>
        {activeCode ? <Button disabled={bindings.loading} onClick={bindings.refresh}>刷新状态</Button>
          : <Button variant="primary" disabled={!usable || Boolean(busy) || Boolean(revoke)} onClick={() => void run('issue')}>
            {busy === 'issue' ? '正在生成…' : '生成绑定码'}
          </Button>}
      </footer>
    </div>
  </Modal>
}
